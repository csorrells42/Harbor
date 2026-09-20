import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHub} from '../src/core/hub.mjs';
import {Upstreams} from '../src/core/upstreams.mjs';
import {createMaintenance} from '../src/core/maintenance.mjs';

test('component updates stay blocked until maintenance finishes draining upstreams',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-maintenance-drain-'));
  assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));
  const originalStop=Upstreams.prototype.stop;let hub,manager,release,entered;
  const stopped=new Promise(resolve=>{entered=resolve;}),hold=new Promise(resolve=>{release=resolve;});
  try{
    await fs.mkdir(path.join(dir,'packages/fixture'),{recursive:true});await fs.writeFile(path.join(dir,'packages/fixture/version.txt'),'old');
    await fs.writeFile(path.join(dir,'maintenance.json'),JSON.stringify({version:1,components:[{id:'fixture',path:'packages/fixture',build:[{command:process.execPath,args:['-e',"require('fs').writeFileSync('version.txt','new')"]}],verify:[{command:process.execPath,args:['-e',"if(require('fs').readFileSync('version.txt','utf8')!=='new')process.exit(1)"]}]}]}));
    hub=await createHub({configPath:path.join(dir,'servers.json'),port:0});
    await hub.saveServer({id:'fixture',command:process.execPath,args:[path.resolve('tests/fixtures/server.mjs')]});await hub.startServer('fixture');
    manager=await createMaintenance({root:dir,isPaused:()=>hub.snapshot().maintenanceReady===true});
    Upstreams.prototype.stop=async function(id){if(id==='fixture'){entered();await hold;}return originalStop.call(this,id);};
    const entering=hub.enterMaintenance();await stopped;
    assert.equal(hub.snapshot().maintenance,true,'Public admission must pause before shutdown finishes');
    assert.equal(hub.snapshot().maintenanceReady,false,'Paused admission is not permission to modify the payload');
    assert.equal(hub.snapshot().maintenanceTransition,'entering');
    assert.throws(()=>manager.start('fixture',{rebuild:true}),/maintenance mode/);
    assert.equal(await fs.readFile(path.join(dir,'packages/fixture/version.txt'),'utf8'),'old');
    release();await entering;assert.equal(hub.snapshot().maintenanceReady,true);assert.equal(hub.snapshot().maintenanceTransition,null);
    manager.start('fixture',{rebuild:true});assert.equal((await manager.wait()).phase,'complete');assert.equal(await fs.readFile(path.join(dir,'packages/fixture/version.txt'),'utf8'),'new');
    const leaving=hub.leaveMaintenance();assert.equal(hub.snapshot().maintenanceReady,false,'A queued resume immediately closes update admission');await leaving;
    assert.equal(hub.snapshot().servers[0].status,'running');
  }finally{release?.();Upstreams.prototype.stop=originalStop;await manager?.close();await hub?.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('failed maintenance drain never authorizes updates and can retry without losing startup selections',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-maintenance-retry-'));
  assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));
  const originalStop=Upstreams.prototype.stop;let hub;
  try{
    hub=await createHub({configPath:path.join(dir,'servers.json'),port:0});
    await hub.saveServer({id:'fixture',command:process.execPath,args:[path.resolve('tests/fixtures/server.mjs')]});await hub.startServer('fixture');
    Upstreams.prototype.stop=async function(id){if(id==='fixture')throw Error('synthetic shutdown failure');return originalStop.call(this,id);};
    await assert.rejects(hub.enterMaintenance(),/synthetic shutdown failure/);
    assert.equal(hub.snapshot().maintenanceReady,false);assert.equal(hub.snapshot().maintenanceTransition,null);
    Upstreams.prototype.stop=originalStop;await hub.enterMaintenance();assert.equal(hub.snapshot().servers[0].status,'stopped');assert.equal(hub.snapshot().maintenanceReady,true);
    await hub.leaveMaintenance();assert.equal(hub.snapshot().servers[0].status,'running');
  }finally{Upstreams.prototype.stop=originalStop;await hub?.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('a resume queued during drain cannot briefly admit a component update when drain resolves',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-maintenance-queued-resume-'));
  assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));
  const originalStop=Upstreams.prototype.stop;let hub,manager,release,entered;
  const reached=new Promise(resolve=>{entered=resolve;}),hold=new Promise(resolve=>{release=resolve;});
  try{
    await fs.writeFile(path.join(dir,'maintenance.json'),JSON.stringify({version:1,components:[{id:'fixture',path:'packages/fixture'}]}));
    hub=await createHub({configPath:path.join(dir,'servers.json'),port:0});
    manager=await createMaintenance({root:dir,isPaused:()=>hub.snapshot().maintenanceReady===true});
    await hub.saveServer({id:'fixture',command:process.execPath,args:[path.resolve('tests/fixtures/server.mjs')]});await hub.startServer('fixture');
    Upstreams.prototype.stop=async function(id){if(id==='fixture'){entered();await hold;}return originalStop.call(this,id);};
    const draining=hub.enterMaintenance();await reached;
    const resuming=hub.leaveMaintenance();
    const atDrainCompletion=draining.then(()=>hub.snapshot().maintenanceReady);
    release();const admitted=await atDrainCompletion;await resuming;
    assert.equal(admitted,false,'An already-requested resume must keep update admission closed between queued operations');
    assert.equal(hub.snapshot().servers[0].status,'running');
    assert.equal(hub.snapshot().maintenance,false);
    assert.equal(hub.snapshot().maintenanceReady,false,'Finishing a queued resume must not restore update permission');
    assert.equal(hub.snapshot().maintenanceTransition,null);
    assert.throws(()=>manager.start('fixture',{rebuild:true}),/maintenance mode/);
    await hub.enterMaintenance();assert.equal(hub.snapshot().maintenanceReady,true);assert.equal(hub.snapshot().servers[0].status,'stopped');
    await hub.leaveMaintenance();assert.equal(hub.snapshot().maintenanceReady,false);assert.equal(hub.snapshot().servers[0].status,'running');
  }finally{release?.();Upstreams.prototype.stop=originalStop;await manager?.close();await hub?.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('removing a server during maintenance does not prevent remaining servers from resuming',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-maintenance-removal-'));
  let hub;
  try{
    hub=await createHub({configPath:path.join(dir,'servers.json'),port:0});
    for(const id of ['removed','retained']){
      await hub.saveServer({id,command:process.execPath,args:[path.resolve('tests/fixtures/server.mjs')],autoStart:true});
      await hub.startServer(id);
    }
    await hub.enterMaintenance();
    await hub.removeServer('removed');
    await hub.leaveMaintenance();
    assert.equal(hub.snapshot().maintenance,false);
    assert.deepEqual(hub.snapshot().servers.map(({id,status})=>({id,status})),[{id:'retained',status:'running'}]);
    assert.equal(hub.snapshot().tools.length,1);
    await hub.enterMaintenance();
    await hub.leaveMaintenance();
    assert.equal(hub.snapshot().servers[0].status,'running');
  }finally{await hub?.close();await fs.rm(dir,{recursive:true,force:true});}
});
