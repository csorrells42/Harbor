import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {Upstreams} from '../src/core/upstreams.mjs';
import {validateConfig} from '../src/core/config.mjs';

test('a timed-out upstream operation suspends automatic idle shutdown until explicit ownership reset',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor uncertain idle ')),file=path.join(dir,'fixture.json'),events=path.join(dir,'events.jsonl');
  await fs.writeFile(file,JSON.stringify({events,callDelay:3000}));let now=0;
  const config=validateConfig({id:'uncertain',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/dormant-server.mjs',import.meta.url)),file],onDemand:true,idleMinutes:1});
  const manager=new Upstreams([config],()=>{},()=>{},{now:()=>now});
  t.after(async()=>{await manager.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  await manager.start(config.id);const tool=manager.tools()[0];await manager.stop(config.id);await manager.set(config);
  await assert.rejects(manager.invoke(tool,{value:'uncertain side effect'},{timeout:25}),/timed out/i);
  const pid=manager.get(config.id).transport.pid;now+=60001;await manager.sweepIdle();
  assert.equal(manager.get(config.id).status,'running','Timeout is not proof that the upstream finished');process.kill(pid,0);
  assert.equal(manager.snapshot()[0].idleUncertain,true);assert.equal((await fs.readFile(events,'utf8')).trim().split('\n').map(JSON.parse).filter(event=>event.kind==='call').length,1);
  await manager.stop(config.id);assert.throws(()=>process.kill(pid,0));assert.equal(manager.snapshot()[0].idleUncertain,false);
});
