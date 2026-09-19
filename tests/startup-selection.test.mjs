import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createHub} from '../src/core/hub.mjs';

test('startup selections persist across restarts, preserve other settings and do not revive unchecked servers after maintenance',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-startup-'));
  const configPath=path.join(root,'servers.json');let hub;
  const waitRunning=async id=>{for(let i=0;i<100;i++){if(hub.snapshot().servers.find(s=>s.id===id).status==='running')return;await delay(50);}assert.fail(`${id} failed to start`);};
  try{
    const configs=['enabled','disabled'].map(id=>({id,name:id,command:process.execPath,args:[path.resolve('tests/fixtures/server.mjs')],env:{CUSTOM:'unchanged'},autoStart:false,autoRestart:true}));
    await fs.writeFile(configPath,JSON.stringify({version:1,servers:configs}));
    hub=await createHub({configPath,port:0});await hub.startServer('disabled');
    const pid=hub.snapshot().servers.find(s=>s.id==='disabled').pid;
    await hub.setServerStartup('enabled',true);await hub.setServerStartup('disabled',false);
    assert.equal(hub.snapshot().servers.find(s=>s.id==='disabled').pid,pid,'saving a preference must not interrupt a running task');
    const saved=JSON.parse(await fs.readFile(configPath,'utf8')).servers;
    assert.equal(saved[0].autoStart,true);assert.deepEqual(saved[0].env,{CUSTOM:'unchanged'});
    assert.equal(saved[1].autoStart,false);assert.equal(saved[1].autoRestart,false);
    await hub.close();hub=await createHub({configPath,port:0});await waitRunning('enabled');
    assert.equal(hub.snapshot().servers.find(s=>s.id==='disabled').status,'stopped');
    await hub.enterMaintenance();await hub.setServerStartup('enabled',false);await hub.leaveMaintenance();
    assert.equal(hub.snapshot().servers.find(s=>s.id==='enabled').status,'stopped');
    await hub.close();hub=await createHub({configPath,port:0});
    assert(hub.snapshot().servers.every(s=>s.status==='stopped'&&!s.autoStart));
  }finally{await hub?.close();await fs.rm(root,{recursive:true,force:true});}
});
