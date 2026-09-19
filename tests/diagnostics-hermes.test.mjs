import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,symlink,rm,access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHermesAdapter} from '../src/diagnostics/hermes.mjs';
import {createGateway} from '../src/core/gateway.mjs';
import {DEFAULT_SETTINGS} from '../src/core/settings.mjs';
import {createTask} from '../src/diagnostics/tasks.mjs';

// Real installed Hermes + real Harbor MCP, with an explicit deterministic model
// fixture. This proves adapter plumbing ONLY, never model quality.
test('installed Hermes executes real MCP tools in isolated state against a protocol fixture',{skip:!process.env.HARBOR_TEST_INSTALLED_HERMES,timeout:90000},async t=>{
  const installed=path.join(process.env.LOCALAPPDATA,'hermes/hermes-agent');await access(path.join(installed,'venv/Scripts/python.exe'));
  const dir=await mkdtemp(path.join(os.tmpdir(),'harbor-hermes-contract-'));
  const source=path.join(dir,'source');await mkdir(path.join(source,'runtimes/llamacpp'),{recursive:true});
  await symlink(installed,path.join(source,'hermes-agent'),'junction');
  t.after(async()=>{await rm(path.join(source,'hermes-agent'),{recursive:true,force:true});await rm(dir,{recursive:true,force:true});});
  let calls=0;
  const server=createServer(async(req,res)=>{
    if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'diagnostic-protocol-fixture'}]}));return;}
    let raw='';for await(const c of req)raw+=c;const request=JSON.parse(raw);
    if(!request.tools?.length){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'probe',choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));return;}
    calls++;
    const tool=calls===1?'diag__read_record':calls===2?'diag__write_result':null;
    const name=request.tools?.find(t=>t.function.name.endsWith(tool))?.function.name;
    const message=tool?{role:'assistant',content:null,tool_calls:[{id:`call_${calls}`,type:'function',function:{name,arguments:JSON.stringify(calls===1?{id:'record-testnonce'}:{value:'value-testnonce'})}}]}:{role:'assistant',content:'{"status":"done","value":"value-testnonce"}'};
    if(request.stream){res.setHeader('Content-Type','text/event-stream');const delta=tool?{role:'assistant',tool_calls:message.tool_calls.map((c,index)=>({...c,index}))}:message;res.end(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'diagnostic-protocol-fixture',choices:[{index:0,delta,finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'diagnostic-protocol-fixture',choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);}
    else {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'fixture',object:'chat.completion',model:'diagnostic-protocol-fixture',choices:[{index:0,message,finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  await writeFile(path.join(source,'config.yaml'),'model:\n  provider: llamacpp\n  default: diagnostic-protocol-fixture\n');
  await writeFile(path.join(source,'runtimes/llamacpp/server.json'),JSON.stringify({pid:process.pid,base_url:`http://127.0.0.1:${server.address().port}/v1`,api_key:'fixture-not-a-secret'}));
  const task=createTask('lookup','testnonce'),gateway=await createGateway({...DEFAULT_SETTINGS,host:'127.0.0.1',port:0,upstreams:task.upstreams,log:()=>{}});t.after(()=>gateway.close());
  const result=await createHermesAdapter({source}).run({home:path.join(dir,'trial-home'),gateway:gateway.endpoint,prompt:task.prompt,maxTurns:6,maxTrialSeconds:60});
  console.log('Hermes fixture result',JSON.stringify({status:result.status,error:result.error,ready:result.events.find(e=>e.type==='ready'),result:result.result}));
  assert.equal(result.status,'finished',JSON.stringify(result));assert(task.verify(result.result.finalResponse).completed,JSON.stringify(result));assert(calls>=3);
  const dispatched=result.events.filter(e=>e.type==='tool-start');assert.equal(dispatched.length,2);assert(dispatched.every(e=>e.schemaValid===true));
});
