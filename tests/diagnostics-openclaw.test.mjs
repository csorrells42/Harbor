import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createOpenClawAdapter,createModelRelay,isolatedOpenClawConfig,localEndpoint,verifyEmptyCatalog} from '../src/diagnostics/openclaw.mjs';
import {createGateway} from '../src/core/gateway.mjs';
import {createTask} from '../src/diagnostics/tasks.mjs';
import {DEFAULT_SETTINGS} from '../src/core/settings.mjs';

test('OpenClaw relay refuses model loading, switching and excess predictions',async t=>{
  let forwarded=0;const backend=createServer((req,res)=>{forwarded++;req.resume();res.end('{}');});
  await new Promise(r=>backend.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{backend.close(r);backend.closeAllConnections();}));
  const inference={endpoint:`http://127.0.0.1:${backend.address().port}/v1`,model:'fixture',context:8192};
  const relay=await createModelRelay({inference,maxTurns:1,verifyModel:async()=>inference});t.after(()=>relay.close());
  const post=(route,body)=>fetch(relay.endpoint.replace('/v1','')+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post('/api/v1/models/load',{})).status,403);
  assert.equal((await post('/v1/chat/completions',{model:'another-model'})).status,409);
  assert.equal((await post('/v1/chat/completions',{model:'fixture'})).status,200);
  assert.equal((await post('/v1/chat/completions',{model:'fixture'})).status,429);assert.equal(forwarded,1);
  for(const value of ['https://example.com/v1','http://localhost:1234/v1','http://x:y@127.0.0.1/v1','http://127.0.0.1/v1?token=x'])assert.throws(()=>localEndpoint(value));
});

test('OpenClaw isolated configuration does not inherit user channels or tools',()=>{
  const cfg=isolatedOpenClawConfig({home:'C:/trial',proxy:'http://127.0.0.1:123/v1',model:'fixture',context:8192,gateway:'http://127.0.0.1:321/mcp',observer:'C:/trial/observer',startedAt:0});
  assert.deepEqual(cfg.tools.allow,['bundle-mcp']);assert.deepEqual(cfg.agents.defaults.model.fallbacks,[]);assert.equal(cfg.channels,undefined);assert.equal(cfg.agents.defaults.skipBootstrap,true);assert.equal(cfg.agents.defaults.contextTokens,8192);
});

test('OpenClaw verifies an empty MCP catalog and refuses to hide an unexpected tool',async()=>{
  for(const empty of [true,false]){
    const task=createTask('lookup','catalog-check');
    const upstreams=empty?{...task.upstreams,tools:()=>[]}:task.upstreams;
    const gateway=await createGateway({...DEFAULT_SETTINGS,host:'127.0.0.1',port:0,upstreams,log:()=>{}});
    try{if(empty)await verifyEmptyCatalog(gateway.endpoint);else await assert.rejects(verifyEmptyCatalog(gateway.endpoint),/empty diagnostic catalog changed/);}finally{await gateway.close();}
  }
});

test('installed OpenClaw executes real Harbor tools and cancels a pending model request in isolated state',{skip:!process.env.HARBOR_TEST_INSTALLED_OPENCLAW,timeout:240000},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'harbor-openclaw-contract-'));t.after(()=>rm(root,{recursive:true,force:true}));
  let calls=0,holdRequest=false,requestEntered;const requests=[];
  const model='harbor-protocol-fixture';
  const server=createServer(async(req,res)=>{
    if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:model}]}));return;}
    let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);
    if(holdRequest){requestEntered();return;}
    calls++;requests.push(body);
    const suffix=calls===1?'diag__read_record':calls===2?'diag__write_result':null;
    const name=body.tools?.find(tool=>tool.function.name.endsWith(suffix))?.function.name;
    if(suffix&&!name){res.writeHead(400);res.end(JSON.stringify({error:{message:'Diagnostic tool missing'}}));return;}
    const tool=suffix?{id:`call_${calls}`,type:'function',function:{name,arguments:JSON.stringify(calls===1?{id:'record-testnonce'}:{value:'value-testnonce'})}}:null;
    const message=tool?{role:'assistant',content:null,tool_calls:[tool]}:{role:'assistant',content:'{"status":"done","value":"value-testnonce"}'};
    if(body.stream){res.setHeader('content-type','text/event-stream');res.end(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model,choices:[{index:0,delta:tool?{role:'assistant',tool_calls:[{...tool,index:0}]}:message,finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model,choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\ndata: [DONE]\n\n`);}
    else{res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'fixture',model,choices:[{index:0,message,finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  const endpoint=`http://127.0.0.1:${server.address().port}/v1`,inference={endpoint,model,context:8192,loadConfig:{context_length:8192,parallel:1}};
  const task=createTask('lookup','testnonce'),gateway=await createGateway({...DEFAULT_SETTINGS,host:'127.0.0.1',port:0,upstreams:task.upstreams,log:()=>{}});t.after(()=>gateway.close());
  const adapter=createOpenClawAdapter({endpoint,modelProbe:async()=>inference,hardwareReader:async()=>({ramBytes:os.totalmem(),gpus:[]}),diagnosticLog:text=>console.log('Isolated fixture CLI:',text)});t.after(()=>adapter.close());
  const result=await adapter.run({home:path.join(root,'trial'),gateway:gateway.endpoint,prompt:task.prompt,responseFormat:task.responseFormat,maxTurns:6,maxTrialSeconds:100});
  console.log(JSON.stringify({status:result.status,error:result.error,result:result.result,events:result.events.map(e=>({type:e.type,name:e.name,schemaValid:e.schemaValid})),calls}));
  if(result.error)console.log('Fixture home',root);
  assert.equal(result.status,'finished');assert.equal(result.error,null);assert.equal((await task.verify(result.result.finalResponse)).completed,true);
  assert.equal(calls,3);assert.equal(result.events.filter(e=>e.type==='tool-start').length,2);
  assert(result.events.filter(e=>e.type==='tool-start').every(e=>e.schemaValid===true));
  assert.deepEqual(result.events.filter(e=>e.type==='model-request').map(e=>e.definitions),requests.map(r=>r.tools));
  assert(result.events.filter(e=>e.type==='model-request').every(e=>!e.messages&&!e.headers));
  holdRequest=true;
  const entered=new Promise(resolve=>{requestEntered=resolve;});
  const pending=adapter.run({home:path.join(root,'cancel-trial'),gateway:gateway.endpoint,prompt:task.prompt,responseFormat:task.responseFormat,maxTurns:6,maxTrialSeconds:100});
  await Promise.race([entered,pending.then(()=>{throw new Error('Cancellation fixture did not reach inference');})]);
  const closed=adapter.close();const cancelled=await pending;await closed;
  assert.equal(cancelled.status,'cancelled');assert(cancelled.events.some(e=>e.type==='ready'));
  await assert.rejects(adapter.probe(),/closed/);
});
