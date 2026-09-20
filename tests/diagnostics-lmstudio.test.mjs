import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createLmStudioAdapter,consumeNativeStream} from '../src/diagnostics/lmstudio.mjs';
import {createDiagnostics} from '../src/diagnostics/service.mjs';
import {createGateway} from '../src/core/gateway.mjs';
import {createTask} from '../src/diagnostics/tasks.mjs';
import {DEFAULT_SETTINGS} from '../src/core/settings.mjs';
const provider_info={type:'plugin',plugin_id:'mcp/fixture_diagnostic'};
const start={type:'chat.start',model_instance_id:'fixture'};
const end=(output=[])=>({type:'chat.end',result:{model_instance_id:'fixture',output,stats:{input_tokens:10,total_output_tokens:5}}});
const sse=event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const hw=async()=>({ramBytes:os.totalmem(),logicalCpus:1,gpus:[]});
async function backend(t,handle){
 const server=createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;try{res.setHeader('content-type','text/event-stream');await handle(JSON.parse(text),res);}catch(e){res.destroy(e);}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));return `http://127.0.0.1:${server.address().port}/v1`;
}
function adapter(endpoint,extra={}){return createLmStudioAdapter({endpoint,apiToken:'fixture-token',modelProbe:async()=>({model:'fixture',context:8192,loadConfig:{context_length:8192,parallel:1}}),hardwareReader:hw,versionReader:async()=>'0.4.21',registerPlugin:async({gateway})=>({id:'mcp/fixture_diagnostic',close:async()=>{}}),...extra});}
async function setup(t,handle){const task=createTask('lookup','fixed'),gateway=await createGateway({...DEFAULT_SETTINGS,port:0,host:'127.0.0.1',upstreams:task.upstreams,log:()=>{}});t.after(()=>gateway.close());const a=adapter(await backend(t,handle));t.after(()=>a.close());const home=await mkdtemp(path.join(os.tmpdir(),'native-adapter-'));t.after(()=>rm(home,{recursive:true,force:true}));return {a,task,request:{home,gateway:gateway.endpoint,prompt:task.prompt,maxTurns:4,maxTrialSeconds:5}};}

test('native parser handles split UTF-8, CRLF and incomplete or oversized streams',async()=>{
 const raw=Buffer.from(sse({type:'message.delta',content:'café'}).replaceAll('\n','\r\n')),seen=[];
 await consumeNativeStream(Readable.from([...raw].map(x=>Buffer.from([x]))),e=>seen.push(e));assert.equal(seen[0].content,'café');
 await assert.rejects(consumeNativeStream(Readable.from([Buffer.from('data: {}')]),()=>{}),/Incomplete/);
 await assert.rejects(consumeNativeStream(Readable.from([raw]),()=>{},{maxBytes:1}),/limit/);
});

test('native MCP adapter executes actual Harbor tools and keeps internal presentation unknown',async t=>{
 let fixtureGateway;const {a,task,request}=await setup(t,async(body,res)=>{
  assert.equal(body.store,false);assert.equal(body.context_length,undefined);assert.equal(body.previous_response_id,undefined);assert.equal(body.integrations.length,1);assert.equal(body.integrations[0].type,'plugin');
  const client=new Client({name:'fixture-native-client',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(fixtureGateway)));
  const output=[];res.write(sse(start));
  try{for(const [name,args] of [['diag__read_record',{id:'record-fixed'}],['diag__write_result',{value:'value-fixed'}]]){
   res.write(sse({type:'prompt_processing.start'}));res.write(sse({type:'tool_call.start'}));res.write(sse({type:'tool_call.arguments',tool:name,arguments:args,provider_info}));
   const value=await client.callTool({name,arguments:args});const item={tool:name,arguments:args,output:JSON.stringify(value),provider_info};res.write(sse({type:'tool_call.success',...item}));output.push({type:'tool_call',...item});
  }}finally{await client.close();}
  res.write(sse({type:'reasoning.delta',content:'PRIVATE_REASONS'}));output.push({type:'reasoning',content:'PRIVATE_REASONS'},{type:'message',content:'{"status":"done","value":"value-fixed"}'});res.end(sse(end(output)));
 });
 fixtureGateway=request.gateway;const value=await a.run(request);assert.equal(value.status,'finished',value.error);assert.equal(value.cancellationUnconfirmed,false);assert(task.verify(value.result.finalResponse).completed);assert.equal(value.events.filter(e=>e.type==='tool-start').length,2);assert(value.events.filter(e=>e.type==='tool-start').every(e=>e.schemaValid));assert(!value.events.some(e=>e.type==='model-request'));assert(!JSON.stringify(value).includes('PRIVATE_REASONS'));assert(!JSON.stringify(value).includes('fixture-token'));
});

for(const [name,stream,expected] of [
 ['truncated stream',[start],'infrastructure-error'],
 ['foreign tool',[start,{type:'tool_call.start',tool:'foreign',provider_info:{type:'plugin',plugin_id:'unrelated'}}],'infrastructure-error'],
 ['wrong model',[{...start,model_instance_id:'another'}],'infrastructure-error'],
 ['unexpected model load',[{type:'model_load.start'}],'model-drift'],
 ['too many turns',[start,...Array.from({length:5},()=>({type:'prompt_processing.start'}))],'iteration-limit'],
 ['stream/final call mismatch',[start,end([{type:'tool_call',tool:'diag__read_record',arguments:{},provider_info}])],'infrastructure-error'],
 ['API failure',[start,{type:'error',error:{type:'mcp_connection_error',message:'PRIVATE_DETAIL'}}],'infrastructure-error']
])test(`native adapter excludes ${name} and does not claim cancellation`,async t=>{
 const {a,request}=await setup(t,async(body,res)=>res.end(stream.map(sse).join('')));const value=await a.run(request);assert.equal(value.status,expected,value.error);assert(value.cancellationUnconfirmed);assert(!JSON.stringify(value).includes('PRIVATE_DETAIL'));
});

test('native malformed arguments are recorded without pretending successful validation',async t=>{
 const {a,request}=await setup(t,async(body,res)=>res.end([start,{type:'tool_call.start',tool:'diag__read_record',provider_info},{type:'tool_call.failure',metadata:{type:'invalid_arguments',tool_name:'diag__read_record',arguments:{id:12},provider_info}},end([{type:'invalid_tool_call',metadata:{type:'invalid_arguments',tool_name:'diag__read_record',provider_info}}])].map(sse).join('')));
 const value=await a.run(request);assert.equal(value.status,'finished',value.error);assert.equal(value.events.find(e=>e.type==='tool-start').schemaValid,false);
});

test('native unknown-name attempt without provider is a model failure, not infrastructure',async t=>{
 const metadata={type:'invalid_name',tool_name:'invented_tool'};
 const {a,request}=await setup(t,async(body,res)=>res.end([start,{type:'tool_call.start',tool:'invented_tool'},{type:'tool_call.failure',metadata},end([{type:'invalid_tool_call',metadata}])].map(sse).join('')));
 const value=await a.run(request);assert.equal(value.status,'finished',value.error);assert.equal(value.cancellationUnconfirmed,false);assert.equal(value.events.find(e=>e.type==='tool-start').schemaValid,false);
});

test('native missing provider never authorizes a successful tool result',async t=>{
 const {a,request}=await setup(t,async(body,res)=>res.end([start,{type:'tool_call.start',tool:'diag__read_record'},{type:'tool_call.success',tool:'diag__read_record',arguments:{id:'record-fixed'}}].map(sse).join('')));
 const value=await a.run(request);assert.equal(value.status,'infrastructure-error');assert.match(value.error,/outside this Harbor trial/);
});

test('native interleaved tool arguments and results retain individual attribution',async t=>{
 const one={tool:'diag__read_record',arguments:{id:'record-fixed'},provider_info},two={tool:'diag__write_result',arguments:{value:'value-fixed'},provider_info};
 const {a,request}=await setup(t,async(body,res)=>res.end([start,{type:'tool_call.start'},{type:'tool_call.start'},{type:'tool_call.arguments',...one},{type:'tool_call.arguments',...two},{type:'tool_call.success',...two},{type:'tool_call.success',...one},end([{type:'tool_call',...one},{type:'tool_call',...two}])].map(sse).join('')));
 const value=await a.run(request);assert.equal(value.status,'finished',value.error);assert.deepEqual(value.events.filter(e=>e.type==='tool-start').map(e=>e.name),[one.tool,two.tool]);assert.equal(value.events.filter(e=>e.type==='tool-end').length,2);
});

test('native final response with unresolved tool arguments is excluded',async t=>{
 const {a,request}=await setup(t,async(body,res)=>res.end([start,{type:'tool_call.arguments',tool:'diag__read_record',arguments:{id:'record-fixed'},provider_info},end([{type:'tool_call',tool:'diag__read_record',provider_info}])].map(sse).join('')));
 const value=await a.run(request);assert.equal(value.status,'infrastructure-error');assert.match(value.error,/unfinished tool calls/);
});

test('native cancellation and close drain local work; campaign stops before another request',async t=>{
 let entered;const entry=new Promise(r=>entered=r);let requests=0;
 const endpoint=await backend(t,async(body,res)=>{requests++;res.write(sse(start));entered();});
 const dir=await mkdtemp(path.join(os.tmpdir(),'harbor-native-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const a=adapter(endpoint),diagnostics=await createDiagnostics({dataDir:dir,adapters:{lmstudio:a}});t.after(()=>diagnostics.close());
 await diagnostics.start({harness:'lmstudio',tasks:['lookup','chain'],variants:[{id:'all',toolMode:'all'}],repetitions:1,maxTrialSeconds:10,maxCampaignSeconds:30});
 await entry;await diagnostics.cancel();const state=await diagnostics.wait();assert.equal(requests,1);assert.match(state.campaign.stopReason,/cancellation unconfirmed/);assert.equal(state.campaign.trials.length,1);assert.equal(state.campaign.trials[0].eligible,false);
 await a.close();await assert.rejects(a.probe(),/closed/);
});

test('native rejection reports capability recovery and does not create a scored result',async t=>{
 const {a,request}=await setup(t,async(body,res)=>{res.statusCode=400;res.end('secret error');});const value=await a.run(request);assert.equal(value.status,'infrastructure-error');assert.match(value.error,/Allow calling servers from mcp.json/);assert.equal(value.result,null);assert.equal(value.cancellationUnconfirmed,false);
});
