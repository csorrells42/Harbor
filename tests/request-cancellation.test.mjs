import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {withAbortSignals} from '../src/core/request-cancellation.mjs';
test('completed and failed requests release source lifetimes without cancelling completed work',async()=>{
 const session=new AbortController(),request=new AbortController();let downstream,aborted=false;
 assert.equal(await withAbortSignals([session.signal,request.signal],signal=>{downstream=signal;signal.addEventListener('abort',()=>{aborted=true;});return 42;}),42);
 for(const signal of [session.signal,request.signal])assert.equal(getEventListeners(signal,'abort').length,0);
 session.abort();request.abort();assert.equal(aborted,false);assert.equal(downstream.aborted,false);
 const live=new AbortController();await assert.rejects(withAbortSignals([live.signal],()=>{throw Error('tool failed');}),/tool failed/);assert.equal(getEventListeners(live.signal,'abort').length,0);
});
test('either lifetime cancels an active request and releases all listeners',async()=>{
 for(const which of [0,1]){
  const controllers=[new AbortController(),new AbortController()],reason=Error('cancelled '+which);
  const pending=withAbortSignals(controllers.map(c=>c.signal),signal=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));
  controllers[which].abort(reason);await assert.rejects(pending,error=>error===reason);
  for(const c of controllers)assert.equal(getEventListeners(c.signal,'abort').length,0);
 }
});
test('already cancelled sources prevent dispatch and duplicate sources do not leave listeners',async()=>{
 const live=new AbortController(),cancelled=new AbortController();cancelled.abort(Error('already stopped'));let calls=0;
 await assert.rejects(withAbortSignals([live.signal,live.signal,cancelled.signal],()=>calls++),/already stopped/);assert.equal(calls,0);assert.equal(getEventListeners(live.signal,'abort').length,0);
});
