import test from 'node:test';
import assert from 'node:assert/strict';
import {createProfileContexts} from '../src/core/profile-contexts.mjs';
import {Upstreams} from '../src/core/upstreams.mjs';
import {DEFAULT_SETTINGS} from '../src/core/settings.mjs';

test('cancelling one simultaneous initializer does not retire the other shared profile owner',async t=>{
  const shared=new Upstreams([],()=>{}),profile={id:'shared',name:'Shared',revision:1,serverIds:[],isolation:'shared',capabilities:['tools'],delivery:{toolMode:'all'}};
  const contexts=createProfileContexts({profiles:{get:()=>structuredClone(profile)},shared,endpoint:()=> 'http://127.0.0.1:37373/mcp',settings:()=>DEFAULT_SETTINGS,log:()=>{},changed:()=>{},callRaw:()=>{},closeInternal:async()=>{}});
  t.after(async()=>{await contexts.close();await shared.close();});
  const abort=new AbortController(),cancelled=contexts.acquire('shared','cancelled',{signal:abort.signal}),remaining=contexts.acquire('shared','remaining');
  abort.abort(new Error('Only this initializer cancelled'));await assert.rejects(cancelled,/Only this initializer/);
  const context=await remaining;assert.equal(context.runtime.snapshot().closed,false);assert.deepEqual([...context.owners],['remaining']);assert.equal(contexts.snapshot().length,1);
  await contexts.release(context,'remaining');assert.equal(contexts.snapshot().length,0);assert.equal(context.runtime.snapshot().closed,true);
});

test('credential retention covers context startup and awaited retirement, including failed initialization',async t=>{
  const shared=new Upstreams([],()=>{}),profile={id:'shared',revision:1,serverIds:[],isolation:'shared',capabilities:['tools'],delivery:{toolMode:'all',portkeyApiKeyFile:'fixture.key'}};
  let retained=0,finishClose,fail=false;
  const contexts=createProfileContexts({profiles:{get:()=>{if(fail)throw Error('profile removed');return structuredClone(profile);}},shared,
    endpoint:()=> 'http://127.0.0.1:37373/mcp',settings:()=>DEFAULT_SETTINGS,log:()=>{},changed:()=>{},callRaw:()=>{},
    retainCredentials:settings=>{assert.equal(settings.portkeyApiKeyFile,'fixture.key');retained++;return ()=>retained--;},
    closeInternal:()=>new Promise(resolve=>finishClose=resolve)});
  t.after(async()=>{finishClose?.();await contexts.close();await shared.close();});
  const starting=contexts.acquire('shared','first');assert.equal(retained,1,'retained before asynchronous runtime creation');
  const context=await starting,closing=contexts.release(context,'first');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(contexts.snapshot().length,0);assert.equal(retained,1,'retiring context still needs its key');finishClose();await closing;assert.equal(retained,0);
  const failed=contexts.acquire('shared','second');fail=true;await assert.rejects(failed,/removed/);assert.equal(retained,0,'failure releases initialization reference');
});
