import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Upstreams} from '../src/core/upstreams.mjs';
import {validateConfig} from '../src/core/config.mjs';

test('live resource work and subscriptions retain an on-demand child; last release permits idle shutdown and timed-out reads preserve uncertainty',async t=>{
  let now=0;const config=validateConfig({id:'resource-idle',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/primitives-server.mjs',import.meta.url))],onDemand:true,idleMinutes:1});
  const manager=new Upstreams([config],()=>{},()=>{},{now:()=>now});t.after(()=>manager.close());
  await manager.start(config.id);const tool=manager.tools()[0];await manager.stop(config.id);await manager.set(config);await manager.invoke(tool,{});
  const pid=manager.get(config.id).transport.pid,read=manager.mcp.read(config.id,'fixture://slow');await delay(20);now+=60001;await manager.sweepIdle();assert.equal(manager.get(config.id).status,'running');await read;
  await manager.mcp.subscribe(config.id,'fixture://same','first',()=>{});await manager.mcp.subscribe(config.id,'fixture://same','second',()=>{});assert.deepEqual(manager.mcp.snapshot(),{subscriptions:1,owners:2,listeners:0});
  now+=60001;await manager.sweepIdle();assert.equal(manager.get(config.id).status,'running');await manager.mcp.release('first');now+=60001;await manager.sweepIdle();assert.equal(manager.get(config.id).status,'running');await manager.mcp.release('second');now+=60001;await manager.sweepIdle();assert.equal(manager.get(config.id).status,'stopped');assert.throws(()=>process.kill(pid,0));assert.equal(manager.mcp.snapshot().subscriptions,0);
  await manager.invoke(tool,{});await assert.rejects(manager.mcp.read(config.id,'fixture://slow',{timeout:20}),/timed out/i);now+=60001;await manager.sweepIdle();assert.equal(manager.get(config.id).status,'running');assert.equal(manager.snapshot()[0].idleUncertain,true);await manager.stop(config.id);assert.equal(manager.snapshot()[0].idleUncertain,false);
});

test('resource subscription limits reject before upstream dispatch and explicit owner cleanup frees the bounded capacity',async t=>{
  const config=validateConfig({id:'bounded',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/primitives-server.mjs',import.meta.url))]});const manager=new Upstreams([config],()=>{});t.after(()=>manager.close());await manager.start(config.id);
  for(let i=0;i<128;i++)await manager.mcp.subscribe(config.id,'fixture://'+i,'client',()=>{});
  await assert.rejects(manager.mcp.subscribe(config.id,'fixture://excess','client',()=>{}),/capacity/);
  const state=JSON.parse((await manager.invoke(manager.tools()[0],{})).content[0].text);assert.equal(state.subscribes,128);
  await manager.mcp.release('client');assert.deepEqual(manager.mcp.snapshot(),{subscriptions:0,owners:0,listeners:0});assert.equal(manager.snapshot()[0].sessionPins,0);await manager.mcp.subscribe(config.id,'fixture://new','client',()=>{});await manager.mcp.release('client');
});
