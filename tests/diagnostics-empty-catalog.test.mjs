import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHermesAdapter} from '../src/diagnostics/hermes.mjs';
import {createGateway} from '../src/core/gateway.mjs';
import {createTask} from '../src/diagnostics/tasks.mjs';
import {createCatalogVariant} from '../src/diagnostics/catalog-variants.mjs';

test('installed Hermes verifies an empty curated catalog without enabling unrelated tools',{
  skip:!process.env.HARBOR_TEST_INSTALLED_HERMES,timeout:90000
},async t=>{
  const installed=path.join(process.env.LOCALAPPDATA,'hermes/hermes-agent');await fs.access(path.join(installed,'venv/Scripts/python.exe'));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor empty catalog ')),source=path.join(root,'source');await fs.mkdir(path.join(source,'runtimes/llamacpp'),{recursive:true});await fs.symlink(installed,path.join(source,'hermes-agent'),'junction');
  const definitions=[],requests=[];
  const server=createServer(async(req,res)=>{
    if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'empty-catalog-fixture'}]}));return;}
    let raw='';for await(const chunk of req)raw+=chunk;const request=JSON.parse(raw),diagnostic=(request.messages??[]).some(message=>typeof message.content==='string'&&message.content.includes('Diagnostic task.'));
    if(diagnostic){definitions.push(request.tools??[]);requests.push(request);}
    const message={role:'assistant',content:diagnostic?'\u007b"status":"done","value":"empty-contract"}':'OK'};
    if(request.stream){res.setHeader('Content-Type','text/event-stream');res.end(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'empty-catalog-fixture',choices:[{index:0,delta:message,finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'empty-catalog-fixture',choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);}
    else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'fixture',choices:[{index:0,message,finish_reason:'stop'}]}));}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await fs.writeFile(path.join(source,'config.yaml'),'model:\n  provider: llamacpp\n  default: empty-catalog-fixture\n');await fs.writeFile(path.join(source,'runtimes/llamacpp/server.json'),JSON.stringify({pid:process.pid,base_url:`http://127.0.0.1:${server.address().port}/v1`,api_key:'synthetic-only'}));
  const task=createTask('no-tool','empty-contract'),variant=createCatalogVariant(task,{subset:'workflow'}),gateway=await createGateway({host:'127.0.0.1',port:0,toolMode:'all',upstreams:variant.upstreams,log:()=>{}}),adapter=createHermesAdapter({source});
  t.after(async()=>{await adapter.close();await gateway.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await fs.unlink(path.join(source,'hermes-agent'));assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const result=await adapter.run({home:path.join(root,'home'),gateway:gateway.endpoint,prompt:task.prompt,emptyCatalog:true,maxTurns:3,maxTrialSeconds:45});
  assert.equal(result.status,'finished',JSON.stringify(result));assert(task.verify(result.result?.finalResponse).completed,JSON.stringify(result));assert(requests.length>0);assert(definitions.every(tools=>tools.length===0));
  const ready=result.events.find(event=>event.type==='ready');assert.equal(ready.controls.emptyCatalogVerified,true);assert.equal(ready.advertisedTools.length,0);assert.equal(result.events.filter(event=>event.type==='tool-start').length,0);
  assert.deepEqual(result.events.filter(event=>event.type==='model-request').map(event=>event.definitions),definitions);
  const wrong=await createGateway({host:'127.0.0.1',port:0,toolMode:'all',upstreams:createTask('lookup','wrong').upstreams,log:()=>{}});try{const rejected=await adapter.run({home:path.join(root,'wrong-home'),gateway:wrong.endpoint,prompt:task.prompt,emptyCatalog:true,maxTurns:3,maxTrialSeconds:20});assert.equal(rejected.status,'infrastructure-error');assert(!rejected.events.some(event=>event.type==='ready'));}finally{await wrong.close();}
});
