import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {createToolDelivery} from '../src/core/tool-delivery.mjs';
import {createSemanticWorker} from '../src/core/semantic-worker.mjs';
import {DEFAULT_SETTINGS,validateSettings} from '../src/core/settings.mjs';
import {LOCAL_MODELS} from '../src/core/delivery-options.js';
const enabled=!!process.env.HARBOR_TOOL_RUNTIME_ROOT;
const catalog=[['pdf__merge','Combine several PDF documents into one file'],['word__write','Create Microsoft Word documents'],['browser__visit','Navigate to a website']].map(([name,description])=>({serverId:name.split('__')[0],name,description,inputSchema:{type:'object',properties:{files:{type:'array',items:{type:'string'}}}}}));

test('hybrid settings reject invalid combinations and limits',()=>{
  for(const patch of [{hybridModes:['bm25']},{hybridModes:['all','bm25']},{hybridModes:['bm25','bm25']},{hybridModes:['all','all']},{hybridModes:['code','unknown']},{searchLimit:0},{semanticMinScore:NaN},{portkeyApiUrl:'https://secret@example.com'}])assert.throws(()=>validateSettings({...DEFAULT_SETTINGS,...patch}));
});
test('all four bundled models find a paraphrased PDF action offline',{skip:!enabled,timeout:120000},async()=>{
  const worker=createSemanticWorker();try{for(const model of LOCAL_MODELS){
    const settings={...DEFAULT_SETTINGS,portkeyLocalModel:model,searchLimit:1,semanticMinScore:0};
    await worker.request({op:'prepare',mode:'portkey-local',settings});
    const result=await worker.request({op:'search',mode:'portkey-local',settings,tools:catalog,query:'join my portable document files together'});
    assert.equal(result.tools[0].name,'pdf__merge',JSON.stringify({model,result}));
  }}finally{await worker.close();}
});
test('hosted transports work against local mock, hybrid deduplicates and reports partial failure',{skip:!enabled,timeout:120000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor provider test ')),key=path.join(dir,'test-key.txt');await fs.writeFile(key,'mock-only');
  const requests=[];let fail=false;
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const data=JSON.parse(body);requests.push({path:req.url,auth:req.headers.authorization,...data});res.setHeader('content-type','application/json');if(fail){res.writeHead(401);res.end('{"error":"mock failure"}');return;}const texts=Array.isArray(data.input)?data.input:[data.input];res.end(JSON.stringify({object:'list',model:data.model,data:texts.map((text,index)=>({object:'embedding',index,embedding:data.encoding_format==='base64'?Buffer.from(new Float32Array([1,0,0]).buffer).toString('base64'):[1,0,0]})),usage:{prompt_tokens:1,total_tokens:1}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let current=[...catalog],called;
  const settings={...DEFAULT_SETTINGS,toolMode:'hybrid',hybridModes:['portkey-local','portkey-api','portkey-workers'],semanticMinScore:0,portkeyApiUrl:`http://127.0.0.1:${server.address().port}/v1`,portkeyApiDimensions:3,portkeyApiKeyFile:key,portkeyWorkersUrl:`http://127.0.0.1:${server.address().port}/v1`,portkeyWorkersDimensions:3,portkeyWorkersKeyFile:key};
  const delivery=createToolDelivery({endpoint:'http://127.0.0.1:1/mcp',log:()=>{},tools:()=>current,callRaw:async p=>{called=p;return {content:[{type:'text',text:'completed'}]};},settings});
  t.after(async()=>{await delivery.close();server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});});
  await delivery.prepare(settings);
  const search=async()=>{const r=await delivery.call({name:'search_tools',arguments:{query:'combine documents'}});assert(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
  const found=await search();assert.equal(found.tools.length,3);assert(found.tools.every(t=>t.matchedBy.length===3),JSON.stringify(found));assert.equal(found.warnings.length,0);
  assert(requests.some(r=>r.model.startsWith('@cf/')));assert(requests.some(r=>r.model==='text-embedding-3-small'));assert(requests.every(r=>r.auth==='Bearer mock-only'&&r.path==='/v1/embeddings'));
  await delivery.call({name:'call_tool',arguments:{name:found.tools[0].name,arguments:{files:['a.pdf','b.pdf']}}});assert.deepEqual(called.arguments.files,['a.pdf','b.pdf']);
  current=current.slice(1);fail=true;const partial=await search();assert.equal(partial.tools.length,2);assert.equal(partial.warnings.length,2);assert(!JSON.stringify(partial).includes('mock-only'));
});

