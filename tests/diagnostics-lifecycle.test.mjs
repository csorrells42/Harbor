import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createHermesAdapter} from '../src/diagnostics/hermes.mjs';
import {createDiagnostics} from '../src/diagnostics/service.mjs';

async function running(pid){
  try{process.kill(pid,0);if(process.platform==='linux'&&/\) Z /.test(await fs.readFile(`/proc/${pid}/stat`,'utf8')))return false;return true;}catch(error){if(['ESRCH','ENOENT'].includes(error.code))return false;throw error;}
}
async function until(check){const deadline=Date.now()+15000;while(!await check()){if(Date.now()>deadline)throw Error('Fixture lifecycle timed out');await new Promise(resolve=>setTimeout(resolve,25));}}
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-diagnostics-lifecycle-'));
  const worker=path.join(root,'worker.mjs');
  await fs.writeFile(worker,`import fs from 'node:fs/promises';import path from 'node:path';import {spawn} from 'node:child_process';
let text='';for await(const chunk of process.stdin)text+=chunk;const request=JSON.parse(text);
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
await fs.writeFile(path.join(request.source,request.op+'.json'),JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);`);
  const adapter=createHermesAdapter({source:root,spawnProcess:(_python,_args,options)=>spawn(process.execPath,[worker],options)});
  t.after(async()=>{await adapter.close();assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});});
  const pids=async op=>{const file=path.join(root,op+'.json');await until(()=>fs.access(file).then(()=>true,()=>false));return JSON.parse(await fs.readFile(file,'utf8'));};
  return {root,adapter,pids};
}

test('Hermes adapter close drains concurrent probes and trials and stops their real process trees',{timeout:25000},async t=>{
  const f=await fixture(t);
  const probe=f.adapter.probe().catch(error=>error.message);
  const trial=f.adapter.run({maxTrialSeconds:60});
  const records=await Promise.all([f.pids('probe'),f.pids('run')]);
  for(const record of records)assert(await running(record.parent));
  const first=f.adapter.close(),second=f.adapter.close();assert.equal(first,second);await first;
  assert.match(await probe,/cancelled/);assert.equal((await trial).status,'cancelled');
  for(const record of records)await until(async()=>!await running(record.parent)&&!await running(record.child));
  await assert.rejects(f.adapter.probe(),/closed/);await assert.rejects(f.adapter.run({maxTrialSeconds:1}),/closed/);
});

test('Diagnostics close cancels and drains an in-flight real probe before resolving',{timeout:25000},async t=>{
  const f=await fixture(t),service=await createDiagnostics({dataDir:path.join(f.root,'state'),adapter:f.adapter});
  t.after(()=>service.close());
  const probe=service.probe().catch(error=>error.message),record=await f.pids('probe');
  const first=service.close();assert.equal(first,service.close());await first;
  assert.match(await probe,/closed/);assert.equal(await running(record.parent),false);await until(async()=>!await running(record.child));
  await assert.rejects(service.probe(),/closed/);assert.equal(service.snapshot().inventory,null);
});

test('Diagnostics close releases the campaign lock during preflight and never starts a trial',{timeout:10000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-diagnostic-preflight-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let entered,ran=false,closeCalls=0;const ready=new Promise(resolve=>entered=resolve);
  const adapter={probe:({signal})=>{entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},run:async()=>{ran=true;},close:async()=>{closeCalls++;}};
  const service=await createDiagnostics({dataDir:root,adapter});
  const start=service.start({tasks:['lookup'],variants:[{id:'all',toolMode:'all'}],repetitions:1}).catch(error=>error.message);
  await ready;await service.close();assert.match(await start,/closed/);assert.equal(ran,false);assert.equal(closeCalls,1);
  await assert.rejects(fs.access(path.join(root,'campaign.lock')),{code:'ENOENT'});
  await assert.rejects(service.start({}),/closed/);
});
