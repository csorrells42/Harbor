import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequestScheduler} from '../src/core/request-scheduler.mjs';

test('scheduler bounds active work and permits other sessions past a busy session',async()=>{
  const scheduler=createRequestScheduler({maxActive:2,maxPerSession:1,maxQueued:3});
  let release;const started=[];
  const first=scheduler.run('a',()=>{started.push('a1');return new Promise(resolve=>release=resolve);});
  const second=scheduler.run('a',async()=>{started.push('a2');return 2;});
  const other=scheduler.run('b',async()=>{started.push('b');return 3;});
  assert.equal(await other,3);assert.deepEqual(started,['a1','b']);
  assert.equal(scheduler.snapshot().queued,1);release(1);assert.deepEqual(await Promise.all([first,second]),[1,2]);
  await scheduler.close();assert.equal(scheduler.snapshot().active,0);
});

test('queued cancellation, expiry and overload never dispatch a mutation',async()=>{
  const scheduler=createRequestScheduler({maxActive:1,maxPerSession:1,maxQueued:1,queueTimeoutMs:30});
  let release,mutations=0;
  const first=scheduler.run('busy',()=>new Promise(resolve=>release=resolve));
  const abort=new AbortController();
  const queued=scheduler.run('waiting',async()=>mutations++,{signal:abort.signal});const cancelled=assert.rejects(queued,/cancelled/);
  await assert.rejects(scheduler.run('overflow',async()=>mutations++),/full/);
  abort.abort();await cancelled;
  await assert.rejects(scheduler.run('expires',async()=>mutations++),/expired/);
  assert.equal(mutations,0);release();await first;await scheduler.close();
});

test('session disconnect rejects only its queued work and close drains active operations',async()=>{
  const scheduler=createRequestScheduler({maxActive:1,maxPerSession:1});
  let release;const first=scheduler.run('a',()=>new Promise(resolve=>release=resolve));
  const queued=scheduler.run('b',async()=>assert.fail('Disconnected work was dispatched'));
  const rejected=assert.rejects(queued,/session closed/);scheduler.cancelSession('b');await rejected;
  let closed=false;const closing=scheduler.close().then(()=>closed=true);
  await delay(5);assert.equal(closed,false);release();await first;await closing;
  await assert.rejects(scheduler.run('c',async()=>{}),/closed/);
});
