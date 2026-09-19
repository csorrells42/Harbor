import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHub} from '../src/core/hub.mjs';

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
