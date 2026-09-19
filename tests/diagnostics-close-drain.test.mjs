import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createDiagnostics} from '../src/diagnostics/service.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function until(check){const end=Date.now()+10000;while(!check()){if(Date.now()>end)throw Error('Shutdown fixture did not reach the expected state');await new Promise(r=>setTimeout(r,10));}}

test('Diagnostics close drains pending cleanup before reporting active campaign persistence failure',{timeout:15000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-close-drain-'));
  const entered=deferred(),cleanupStarted=deferred(),releaseCleanup=deferred(),cleanupFinished=deferred();
  const inventory={harness:'Hermes',revision:'fixture',fingerprint:'fixture',model:'fixture-model',provider:'fixture',reasoning:'high',hardware:{logicalCpus:1,ramBytes:1024,gpus:null}};
  let cleanupDone=false,service,settled=false,outcome;
  const adapter={
    probe:async()=>inventory,
    async run(_request,{signal,onEvent}){
      onEvent({type:'ready',inventory,startupMs:0});entered.resolve();
      await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});
      return {status:'cancelled',events:[]};
    },
    async close(){cleanupStarted.resolve();await releaseCleanup.promise;cleanupDone=true;cleanupFinished.resolve();}
  };
  t.after(async()=>{
    releaseCleanup.resolve();await service?.close().catch(()=>{});await cleanupFinished.promise;
    assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));
    await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  service=await createDiagnostics({dataDir:dir,adapter});
  await service.start({tasks:['lookup'],variants:[{id:'all',toolMode:'all'}],repetitions:1});
  await entered.promise;
  const campaignDir=path.join(dir,service.snapshot().campaign.id);
  assert.equal(path.dirname(path.resolve(campaignDir)),path.resolve(dir));
  // Simulate losing the writable results directory after a trial has begun.
  // Both the trial write and the final campaign persistence now fail for real.
  await fs.rm(campaignDir,{recursive:true,force:true});
  const closing=service.close();
  const observed=closing.then(()=>{settled=true;outcome={status:'fulfilled'};},error=>{settled=true;outcome={status:'rejected',code:error.code,message:error.message};});
  await cleanupStarted.promise;
  await until(()=>!service.snapshot().running);
  await Promise.resolve();
  assert.equal(service.snapshot().campaign.status,'error');
  assert.equal(cleanupDone,false,'The controlled cleanup gate must still be held');
  assert.equal(settled,false,`close settled before cleanup drained: ${JSON.stringify(outcome)}`);
  releaseCleanup.resolve();await observed;await cleanupFinished.promise;
  assert.equal(cleanupDone,true);assert.equal(outcome.status,'rejected');assert.equal(outcome.code,'ENOENT');
  await assert.rejects(fs.access(path.join(dir,'campaign.lock')),{code:'ENOENT'});
});
