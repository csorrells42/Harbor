import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {Upstreams} from '../src/core/upstreams.mjs';
import {createProfileRuntime} from '../src/core/profile-runtime.mjs';

const fixture=id=>({id,name:id,transport:'stdio',runtime:'native',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/server.mjs',import.meta.url))],env:{},autoStart:false,autoRestart:false});
const profile=(isolation='shared')=>({id:'fixture',revision:3,serverIds:['one'],isolation,capabilities:['tools']});
async function call(runtime){
  const tool=runtime.upstreams.tools()[0];const server=runtime.upstreams.get(tool.serverId);
  return JSON.parse((await server.client.callTool({name:tool.originalName,arguments:{text:'fixture'}})).content[0].text);
}

test('shared profile filtering and ownership never stop the user process or another profile',async t=>{
  const shared=new Upstreams([fixture('one'),fixture('two')],()=>{});
  t.after(()=>shared.close());await shared.start('one');await shared.start('two');
  const first=await createProfileRuntime({profile:profile(),shared}),second=await createProfileRuntime({profile:profile(),shared});
  t.after(()=>Promise.all([first.close(),second.close()]));
  first.acquire('client-a');second.acquire('client-b');
  assert.equal(first.upstreams.tools().length,1);assert.throws(()=>first.upstreams.get('two'),/outside/);
  const before=await call(first);await first.release('client-a');const after=await call(second);
  assert.equal(before.pid,after.pid);assert.equal(after.count,before.count+1);
  assert.equal(shared.get('one').status,'running');assert.equal(shared.get('two').status,'running');
});

test('isolated client runtimes have different real PIDs and independent state; closing one leaves the others alive',async t=>{
  const shared=new Upstreams([fixture('one')],()=>{});t.after(()=>shared.close());await shared.start('one');
  const first=await createProfileRuntime({profile:profile('process'),shared}),second=await createProfileRuntime({profile:profile('process'),shared});
  t.after(()=>Promise.all([first.close(),second.close()]));
  first.acquire('a');second.acquire('b');assert.throws(()=>first.acquire('extra'),/exactly one/);
  const a=await call(first),b=await call(second);
  assert.notEqual(a.pid,b.pid);assert.notEqual(a.pid,shared.get('one').transport.pid);
  assert.equal(a.count,1);assert.equal(b.count,1);
  await first.release('a');assert.equal(first.snapshot().closed,true);
  const next=await call(second);assert.equal(next.pid,b.pid);assert.equal(next.count,2);
  assert.equal(shared.get('one').status,'running');
});

test('unsupported and pre-cancelled isolation never start an alternative shared process',async t=>{
  const shared=new Upstreams([{...fixture('one'),transport:'http',url:'http://127.0.0.1:1/mcp'}],()=>{});
  t.after(()=>shared.close());
  await assert.rejects(createProfileRuntime({profile:profile('process'),shared}),/native stdio/);
  const abort=new AbortController();abort.abort(new Error('cancelled fixture'));
  await assert.rejects(createProfileRuntime({profile:profile(),shared,signal:abort.signal}),/cancelled fixture/);
  assert.equal(shared.get('one').status,'stopped');
});

test('cancellation during isolated startup promptly reaps the owned attempt',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor profile cancellation '));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const pidFile=path.join(dir,'owned.pid');
  const config={...fixture('one'),env:{HARBOR_PROFILE_PID:pidFile},args:['-e',"require('node:fs').writeFileSync(process.env.HARBOR_PROFILE_PID,String(process.pid));setInterval(()=>{},1000)"]};
  const shared=new Upstreams([config],()=>{});t.after(()=>shared.close());
  const abort=new AbortController(),started=Date.now();
  const pending=createProfileRuntime({profile:profile('process'),shared,requestTimeoutMs:10000,signal:abort.signal});
  const rejected=assert.rejects(pending);let pid;
  for(let i=0;i<100&&!pid;i++){try{pid=Number(await fs.readFile(pidFile,'utf8'));}catch{}if(!pid)await delay(10);}
  assert(pid,'The disposable child must actually start');abort.abort(new Error('Cancelled test startup'));
  await rejected;
  // SDK stdio close permits two 2-second graceful stages before forced reaping.
  assert(Date.now()-started<6000,'Cancellation must finish within shutdown grace, not the 10-second initialization deadline');
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
  assert.equal(shared.get('one').status,'stopped');
});

test('one failed isolated child cancels slow sibling startups before the deadline',async t=>{
  const configs=[{...fixture('one'),command:'harbor-nonexistent-test-executable'}, {...fixture('two'),args:['-e','setInterval(()=>{},1000)']}];
  const shared=new Upstreams(configs,()=>{});t.after(()=>shared.close());const started=Date.now();
  await assert.rejects(createProfileRuntime({profile:{...profile('process'),serverIds:['one','two']},shared,requestTimeoutMs:10000}));
  assert(Date.now()-started<6000,'A failed sibling must cancel startup within the SDK shutdown grace');
  assert(shared.snapshot().every(server=>server.status==='stopped'));
});
