import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createHub} from '../src/core/hub.mjs';

async function setup(t,timeout=1000){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor trace gateway '));
  const hub=await createHub({configPath:path.join(dir,'servers.json'),port:0,toolTimeoutMs:timeout});
  const clients=[];
  t.after(async()=>{for(const client of clients)await client.close();await hub.close();await fs.rm(dir,{recursive:true,force:true});});
  await hub.saveServer({id:'fixture',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/server.mjs',import.meta.url))],env:{API_KEY:'fixture-known-secret'}});
  await hub.startServer('fixture');
  const connect=async name=>{
    const client=new Client({name,version:'1'});
    await client.connect(new StreamableHTTPClientTransport(new URL(hub.endpoint)));clients.push(client);return client;
  };
  return {hub,connect,tool:hub.snapshot().tools[0].name};
}
async function until(check){for(let i=0;i<100;i++){if(check())return;await delay(20);}assert.fail('Timed out waiting for captured completion');}

test('real concurrent clients retain distinct request/session IDs and nested upstream spans',async t=>{
  const {hub,connect,tool}=await setup(t);
  const a=await connect('trace-a'),b=await connect('trace-b');
  const replies=await Promise.all([a.callTool({name:tool,arguments:{text:'private-a',delay:40}}),b.callTool({name:tool,arguments:{text:'private-b'}})]);
  assert(JSON.stringify(replies[0]).includes('private-a'));assert(JSON.stringify(replies[1]).includes('private-b'));
  const snapshot=hub.traceSnapshot();
  assert(!JSON.stringify(snapshot).includes('private-a'));assert(!JSON.stringify(snapshot).includes('private-b'));
  const calls=snapshot.events.filter(e=>e.kind==='tools/call'&&e.status==='completed');
  assert.equal(calls.length,2);assert.equal(new Set(calls.map(e=>e.sessionId)).size,2);assert.equal(new Set(calls.map(e=>e.requestId)).size,2);
  for(const call of calls){
    const upstream=snapshot.events.find(e=>e.kind==='upstream'&&e.parentId===call.id&&e.status==='completed');
    assert(upstream);assert.equal(upstream.sessionId,call.sessionId);assert.equal(upstream.serverId,'fixture');
  }
});

test('gateway traces distinguish invalid tool, upstream failure, timeout and cancellation and do not retry',async t=>{
  const {hub,connect,tool}=await setup(t,120);const client=await connect('failures');
  await assert.rejects(client.callTool({name:'missing',arguments:{}}));
  assert.equal(hub.traceSnapshot().events.at(-1).outcome,'invalid-arguments');
  const rejected=await client.callTool({name:tool,arguments:{fail:true}});
  assert.equal(rejected.isError,true);assert.equal(hub.traceSnapshot().events.at(-1).outcome,'upstream-failure');
  await assert.rejects(client.callTool({name:tool,arguments:{delay:500}}));
  assert.equal(hub.traceSnapshot().events.at(-1).outcome,'timeout');
  const abort=new AbortController(),pending=client.callTool({name:tool,arguments:{delay:500}},undefined,{signal:abort.signal});
  const settled=assert.rejects(pending);await delay(30);abort.abort();await settled;
  await until(()=>hub.traceSnapshot().events.some(e=>e.outcome==='cancelled'));
  const completed=hub.traceSnapshot().events.filter(e=>e.kind==='upstream'&&e.status==='completed');
  assert.equal(completed.length,3,'Exactly one upstream dispatch per caller invocation');
  assert(completed.filter(e=>['timeout','cancelled'].includes(e.outcome)).every(e=>e.mutationOutcome.includes('unknown')));
});

test('native gateway payload capture redacts configured credentials and exports the previewed snapshot',async t=>{
  const {hub,connect,tool}=await setup(t);const client=await connect('payload');
  await hub.updateTraceSettings({...hub.traceSnapshot().settings,mode:'payload'});
  await client.callTool({name:tool,arguments:{text:'fixture-known-secret',password:'unregistered-password'}});
  const snapshot=hub.traceSnapshot();
  assert(!JSON.stringify(snapshot).includes('fixture-known-secret'));
  assert(!JSON.stringify(snapshot).includes('unregistered-password'));
  assert(snapshot.events.some(e=>e.payloadCaptured));
  const preview=hub.previewTraceExport();
  await client.listTools();
  assert.equal(hub.traceExport(preview.token),preview.text);
  hub.clearTraces();assert.equal(hub.traceSnapshot().total,0);assert.throws(()=>hub.traceExport(preview.token),/expired/);
});

test('real Hybrid traces retain per-method ranks and fused order without recording the query', {
  skip:!process.env.HARBOR_TOOL_RUNTIME_ROOT,timeout:90000
},async t=>{
  const installed=process.env.HARBOR_TOOL_RUNTIME_ROOT;
  const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor trace runtime '));
  for(const folder of ['runtimes','packages'])await fs.symlink(path.join(installed,folder),path.join(runtime,folder),process.platform==='win32'?'junction':'dir');
  await fs.cp(path.join(installed,'support'),path.join(runtime,'support'),{recursive:true});
  for(const folder of ['data/workspace','data/temp','data/home'])await fs.mkdir(path.join(runtime,folder),{recursive:true});
  process.env.HARBOR_TOOL_RUNTIME_ROOT=runtime;
  let testHub;
  t.after(async()=>{await testHub?.close();process.env.HARBOR_TOOL_RUNTIME_ROOT=installed;for(const folder of ['runtimes','packages'])await fs.unlink(path.join(runtime,folder));await fs.rm(runtime,{recursive:true,force:true});});
  const {hub,connect,tool}=await setup(t);testHub=hub;const client=await connect('hybrid-trace');
  await hub.updateSettings({...hub.getSettings(),toolMode:'hybrid',hybridModes:['bm25','regex'],searchLimit:5});
  hub.clearTraces();
  const result=await client.callTool({name:'search_tools',arguments:{query:'echo'}});
  assert(!result.isError,JSON.stringify(result));assert(JSON.stringify(result).includes(tool));
  const discovery=hub.traceSnapshot().events.find(event=>event.kind==='discovery'&&event.status==='completed');
  assert(discovery);assert.equal(discovery.outcome,'success');
  assert.deepEqual(discovery.discovery.methods,['bm25','regex']);
  const candidate=discovery.discovery.candidates.find(candidate=>candidate.name===tool);
  assert.equal(candidate.sourceRanks.bm25,1);assert.equal(candidate.sourceRanks.regex,1);assert(candidate.score>0);
  assert.equal(discovery.payloadCaptured,false);
  const request=hub.traceSnapshot().events.find(event=>event.kind==='tools/call');
  assert.deepEqual(request.delivery.hybridModes,['bm25','regex']);
});
