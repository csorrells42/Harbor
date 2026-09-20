import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,symlink,rm,access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHermesAdapter} from '../src/diagnostics/hermes.mjs';
import {createGateway} from '../src/core/gateway.mjs';
import {DEFAULT_SETTINGS} from '../src/core/settings.mjs';
import {createTask} from '../src/diagnostics/tasks.mjs';

// Real installed Hermes + real Harbor MCP, with an explicit deterministic model
// fixture. This proves adapter plumbing ONLY, never model quality.
for(const provider of ['llamacpp','lmstudio']) test(`installed Hermes executes real MCP tools in isolated state against a ${provider} protocol fixture`,{skip:!process.env.HARBOR_TEST_INSTALLED_HERMES,timeout:90000},async t=>{
  const installed=path.join(process.env.LOCALAPPDATA,'hermes/hermes-agent');await access(path.join(installed,'venv/Scripts/python.exe'));
  const dir=await mkdtemp(path.join(os.tmpdir(),'harbor-hermes-contract-'));
  const source=path.join(dir,'source');await mkdir(path.join(source,'runtimes/llamacpp'),{recursive:true});
  await symlink(installed,path.join(source,'hermes-agent'),'junction');
  t.after(async()=>{await rm(path.join(source,'hermes-agent'),{recursive:true,force:true});await rm(dir,{recursive:true,force:true});});
  let calls=0;const observedDefinitions=[],observedContracts=[],observedRequests=[];
  const server=createServer(async(req,res)=>{
    if(req.method==='GET'&&req.url==='/api/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({models:[{type:'llm',key:'fixture/configured-model-key',capabilities:{reasoning:{allowed_options:['off','on'],default:'on'}},loaded_instances:[{id:'diagnostic-protocol-fixture',config:{context_length:8192,parallel:1}}]}]}));return;}
    if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'diagnostic-protocol-fixture'}]}));return;}
    let raw='';for await(const c of req)raw+=c;const request=JSON.parse(raw);
    if(!request.tools?.length){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'probe',choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));return;}
    calls++;
    observedRequests.push(request);
    observedDefinitions.push(request.tools);
    observedContracts.push(request.messages.some(message=>message.role==='user'&&typeof message.content==='string'&&message.content.includes('Final response contract (harbor-final-json-1)')&&message.content.includes('no Markdown code fences')));
    const tool=calls===1?'diag__read_record':calls===2?'diag__write_result':null;
    const name=request.tools?.find(t=>t.function.name.endsWith(tool))?.function.name;
    const message=tool?{role:'assistant',content:null,tool_calls:[{id:`call_${calls}`,type:'function',function:{name,arguments:JSON.stringify(calls===1?{id:'record-testnonce'}:{value:'value-testnonce'})}}]}:{role:'assistant',content:'{"status":"done","value":"value-testnonce"}'};
    if(request.stream){res.setHeader('Content-Type','text/event-stream');const delta=tool?{role:'assistant',tool_calls:message.tool_calls.map((c,index)=>({...c,index}))}:message;res.end(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'diagnostic-protocol-fixture',choices:[{index:0,delta,finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'diagnostic-protocol-fixture',choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);}
    else {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'fixture',object:'chat.completion',model:'diagnostic-protocol-fixture',choices:[{index:0,message,finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  await writeFile(path.join(source,'config.yaml'),provider==='llamacpp'?'model:\n  provider: llamacpp\n  default: diagnostic-protocol-fixture\n':`model:\n  provider: lmstudio\n  default: fixture/configured-model-key\n  base_url: http://127.0.0.1:${server.address().port}/v1\n  context_length: 8192\nagent:\n  reasoning_effort: high\n`);
  await writeFile(path.join(source,'runtimes/llamacpp/server.json'),JSON.stringify({pid:process.pid,base_url:`http://127.0.0.1:${server.address().port}/v1`,api_key:'fixture-not-a-secret'}));
  const task=createTask('lookup','testnonce'),gateway=await createGateway({...DEFAULT_SETTINGS,host:'127.0.0.1',port:0,upstreams:task.upstreams,log:()=>{}});t.after(()=>gateway.close());
  let workerPath;
  if(provider==='lmstudio'){
    // Test-only process-name seam for this Node-owned HTTP protocol fixture.
    // Socket ownership, real installed Hermes and production worker stay real;
    // separate identity tests reject unknown owners without this seam.
    workerPath=path.join(dir,'fixture-worker.py');
    await writeFile(workerPath,`import psutil, runpy\n_original_name = psutil.Process.name\npsutil.Process.name = lambda self: 'LM Studio.exe' if self.pid == ${process.pid} else _original_name(self)\nrunpy.run_path(${JSON.stringify(fileURLToPath(new URL('../src/diagnostics/hermes_worker.py',import.meta.url)))}, run_name='__main__')\n`);
  }
  const result=await createHermesAdapter({source,...(workerPath?{workerPath}:{})}).run({home:path.join(dir,'trial-home'),gateway:gateway.endpoint,prompt:task.prompt,responseFormat:task.responseFormat,maxTurns:6,maxTrialSeconds:60});
  console.log('Hermes fixture result',JSON.stringify({status:result.status,error:result.error,ready:result.events.find(e=>e.type==='ready'),result:result.result}));
  assert.equal(result.status,'finished',JSON.stringify(result));assert(task.verify(result.result.finalResponse).completed,JSON.stringify(result));assert(calls>=3);
  assert(observedContracts.every(Boolean),'Every real model request retains the explicit final JSON contract');
  assert.equal(result.events.find(e=>e.type==='ready').controls.finalResponsePolicy,'harbor-final-json-1');
  const dispatched=result.events.filter(e=>e.type==='tool-start');assert.equal(dispatched.length,2);assert(dispatched.every(e=>e.schemaValid===true));
  const presentations=result.events.filter(e=>e.type==='model-request');assert.equal(presentations.length,observedDefinitions.length);assert(presentations.every(event=>event.exactDefinitions));
  assert(presentations.every(event=>event.exactParameters&&/^[a-f0-9]{64}$/.test(event.parameterFingerprint)));
  const startIdentity=result.events.find(event=>event.type==='ready').inventory,endIdentity=result.events.find(event=>event.type==='identity-end').inventory;assert.deepEqual(endIdentity.runtimeVersions,startIdentity.runtimeVersions);assert.equal(startIdentity.runtimeVersions.python.split('.').length,3);assert(startIdentity.runtimeVersions.mcp);assert.equal(startIdentity.modelServerIdentity.endpointOwned,true);assert.equal(startIdentity.modelServerIdentity.runtimeKind,provider==='lmstudio'?'LM Studio':'unverified');assert.equal(endIdentity.modelServerIdentity.startedAt,startIdentity.modelServerIdentity.startedAt);assert.equal(startIdentity.modelEvidence.weightsFingerprint,null);
  if(provider==='lmstudio'){
    assert.equal(startIdentity.model,'diagnostic-protocol-fixture');
    assert.deepEqual(startIdentity.modelEvidence.reasoningSelection,{requested:'high',requestEffort:null,declaredDefault:'on',policy:'configured-hermes-default-fallback'});
    assert(observedRequests.every(request=>!Object.hasOwn(request,'reasoning_effort')),'Installed Hermes must omit unsupported configured effort');
    assert(observedRequests.every(request=>request.temperature===0.2&&request.top_p===0.95&&request.seed===18431),'Sampling remains pinned across the real tool loop');
  }
  assert.deepEqual(presentations.map(event=>event.definitions),observedDefinitions,'Recorded definitions must equal the actual serialized model requests');
  assert(presentations.every(event=>!Object.hasOwn(event,'messages')&&!Object.hasOwn(event,'headers')));
});
