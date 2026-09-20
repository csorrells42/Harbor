import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequestTraces,TRACE_DEFAULTS,traceOutcome} from '../src/core/request-traces.mjs';

test('metadata is default, ignores request contents, and keeps concurrent nesting separate',async()=>{
  const traces=await createRequestTraces();
  await Promise.all(['a','b'].map(sessionId=>traces.run({kind:'tools/call',sessionId,tool:'echo'},async()=>{
    await delay(sessionId==='a'?10:1);
    return traces.run({kind:'upstream',serverId:'fixture'},async()=>({text:'private-result'}),{payload:{secret:'private-input'}});
  },{payload:{text:'private-input'}})));
  const snapshot=traces.snapshot();
  assert(!JSON.stringify(snapshot).includes('private-'));
  const done=snapshot.events.filter(e=>e.status==='completed');
  assert.equal(done.length,4);
  for(const sessionId of ['a','b']){
    const parent=done.find(e=>e.sessionId===sessionId&&e.kind==='tools/call');
    const child=done.find(e=>e.sessionId===sessionId&&e.kind==='upstream');
    assert.equal(child.parentId,parent.id);assert.equal(child.requestId,parent.id);
    assert.equal(parent.association,'unknown');assert.equal(child.association,'observed-nesting');
    assert.equal(child.outcome,'success');assert(child.durationMs>=0);
  }
});

test('payload capture redacts known values and nested credentials, caps payloads and omits binary data',async()=>{
  const traces=await createRequestTraces({secrets:()=>['real-gateway-secret']});
  await traces.update({...TRACE_DEFAULTS,mode:'payload',payloadBytes:1024});
  await traces.run({kind:'tools/call'},async()=>({content:[{text:'Bearer abc123 real-gateway-secret'}],token:'hidden-token',data:'binary-secret'}),{payload:{password:'hidden-password',nested:{api_key:'hidden-api-key'},text:'real-gateway-secret',large:'x'.repeat(20000)}});
  const text=JSON.stringify(traces.snapshot());
  for(const value of ['real-gateway-secret','hidden-password','hidden-api-key','hidden-token','binary-secret','abc123'])assert(!text.includes(value));
  assert(text.includes('[redacted]'));assert(text.includes('[binary omitted]'));
  assert(!traces.redactText('{"password":"embedded-json-secret"}').includes('embedded-json-secret'));
  assert(text.length<10000);
});

test('retention, byte and event limits, clear during a call, and frozen export preview are enforced',async()=>{
  let time=Date.now();
  const traces=await createRequestTraces({now:()=>time});
  await traces.update({...TRACE_DEFAULTS,maxEvents:100,maxBytes:65536,retentionMinutes:1});
  for(let i=0;i<90;i++)await traces.run({kind:'tools/list'},async()=>({tools:[]}));
  assert.equal(traces.snapshot().total,100);assert.equal(traces.snapshot().evicted,80);
  const preview=traces.previewExport();
  await traces.run({kind:'tools/list'},async()=>({tools:[]}));
  assert.equal(traces.exportPreview(preview.token),preview.text);
  time+=60001;assert.equal(traces.snapshot().total,0);
  let finish;const running=traces.run({kind:'tools/call'},()=>new Promise(resolve=>finish=resolve));
  traces.clear();finish({done:true});await running;
  assert.equal(traces.snapshot().total,0);
  assert.throws(()=>traces.exportPreview(preview.token),/expired/);
  const current=traces.previewExport();time+=300001;assert.throws(()=>traces.exportPreview(current.token),/expired/);
});

test('off mode does not capture and persisted payload mode requires opting in after restart',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'harbor-traces-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const settingsPath=path.join(dir,'settings.json');
  const traces=await createRequestTraces({settingsPath});
  await traces.update({...TRACE_DEFAULTS,mode:'off'});
  assert.equal(await traces.run({kind:'tools/call'},async()=>42),42);assert.equal(traces.snapshot().total,0);
  await traces.update({...TRACE_DEFAULTS,mode:'payload'});
  assert.equal(JSON.parse(await readFile(settingsPath,'utf8')).mode,'payload');
  const reopened=await createRequestTraces({settingsPath});assert.equal(reopened.snapshot().settings.mode,'metadata');
});

test('failure categories preserve invalid arguments, upstream failure, search failure, timeout and cancellation',async()=>{
  const cases=[
    [{code:-32602},'tools/call','invalid-arguments'],
    [new Error('broken'),'upstream','upstream-failure'],
    [new Error('broken'),'discovery','search-failure'],
    [{code:-32001},'upstream','timeout'],
    [{name:'AbortError'},'upstream','cancelled']
  ];
  for(const [error,kind,expected] of cases)assert.equal(traceOutcome(error,undefined,kind),expected);
  const traces=await createRequestTraces();
  await assert.rejects(traces.run({kind:'upstream'},async()=>{throw Object.assign(new Error('secret failure text'),{code:-32001});}));
  const event=traces.snapshot().events.at(-1);assert.equal(event.outcome,'timeout');assert.match(event.mutationOutcome,/unknown/);
  assert(!JSON.stringify(event).includes('secret failure text'));
});

test('byte limit is enforced even with payload and discovery metadata',async()=>{
  const traces=await createRequestTraces();
  await traces.update({...TRACE_DEFAULTS,mode:'payload',maxBytes:65536,maxEvents:10000,payloadBytes:8192});
  for(let i=0;i<50;i++)await traces.run({kind:'discovery'},async()=>({text:'x'.repeat(5000)}),{payload:{text:'y'.repeat(5000)}});
  const snapshot=traces.snapshot();assert(snapshot.bytes<=65536);assert(snapshot.evicted>0);assert(snapshot.total<100);
});
