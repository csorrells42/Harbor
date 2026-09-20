import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createMaintenance} from '../src/core/maintenance.mjs';

test('rollback owns the maintenance busy state and shutdown waits for the directory switch',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-rollback-lifecycle-'));
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));
  const active=path.join(root,'packages/fixture'),record=path.join(root,'data/maintenance/rollback-fixture.json');
  const originalRead=fs.readFile;let manager,operation,release,entered;
  const reached=new Promise(resolve=>{entered=resolve;}),hold=new Promise(resolve=>{release=resolve;});
  try{
    await fs.mkdir(active,{recursive:true});await fs.writeFile(path.join(active,'version.txt'),'old');
    await fs.writeFile(path.join(root,'maintenance.json'),JSON.stringify({version:1,components:[{id:'fixture',path:'packages/fixture',build:[{command:process.execPath,args:['-e',"require('fs').writeFileSync('version.txt','new')"]}],verify:[{command:process.execPath,args:['-e',"if(require('fs').readFileSync('version.txt','utf8')!=='new')process.exit(1)"]}]}]}));
    manager=await createMaintenance({root,isPaused:()=>true});
    manager.start('fixture',{rebuild:true});assert.equal((await manager.wait()).phase,'complete');
    fs.readFile=async function(file,...args){if(path.resolve(String(file))===record){entered();await hold;}return originalRead.call(this,file,...args);};
    operation=manager.rollback('fixture');await reached;
    assert.equal(manager.snapshot().busy,true,'Resume must stay blocked throughout rollback, including its first filesystem read');
    assert.throws(()=>manager.start('fixture',{rebuild:true}),/already running/);
    await assert.rejects(manager.rollback('fixture'),/idle maintenance/);
    let closed=false;const closing=manager.close().then(()=>{closed=true;});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false,'Shutdown must await an in-flight rollback');
    release();await operation;await closing;
    assert.equal(manager.snapshot().busy,false);assert.equal(manager.snapshot().phase,'rolled-back');
    assert.equal(await fs.readFile(path.join(active,'version.txt'),'utf8'),'old');
  }finally{release?.();fs.readFile=originalRead;await operation?.catch(()=>{});await manager?.close();await fs.rm(root,{recursive:true,force:true});}
});

test('a failed restore releases its busy state, reports failure and leaves the active component intact',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-rollback-failure-'));
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));let manager;
  try{
    const active=path.join(root,'packages/fixture');await fs.mkdir(active,{recursive:true});await fs.writeFile(path.join(active,'version.txt'),'keep');
    await fs.writeFile(path.join(root,'maintenance.json'),JSON.stringify({version:1,components:[{id:'fixture',path:'packages/fixture'}]}));
    manager=await createMaintenance({root,isPaused:()=>true});
    await assert.rejects(manager.rollback('fixture'),/ENOENT/);
    const status=await manager.wait();assert.equal(status.busy,false);assert.equal(status.phase,'failed');assert.match(status.error,/ENOENT/);
    assert.equal(await fs.readFile(path.join(active,'version.txt'),'utf8'),'keep');
    await manager.close();
  }finally{await manager?.close();await fs.rm(root,{recursive:true,force:true});}
});
