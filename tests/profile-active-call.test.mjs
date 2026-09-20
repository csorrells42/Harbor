import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createHub} from '../src/core/hub.mjs';

for(const isolation of ['shared','process'])test(`profile edit during an active ${isolation} call preserves its original revision and dispatches once`,{timeout:30000},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor active profile '));
  const clients=[];
  let hub,pending;
  const reply=result=>JSON.parse(result.content[0].text);
  try{
    hub=await createHub({configPath:path.join(directory,'servers.json'),port:0,toolTimeoutMs:25000});
    for(const id of ['before','after']){
      await hub.saveServer({id,name:id,command:process.execPath,args:[fileURLToPath(new URL('./fixtures/gated-profile-server.mjs',import.meta.url))],env:{HARBOR_FIXTURE_GATE_DIR:directory}});
      await hub.startServer(id);
    }
    const original=await hub.saveProfile({id:'editing',name:'Editing',serverIds:['before'],isolation,delivery:{toolMode:'all'}});
    const connect=async()=>{
      const client=new Client({name:'active profile test',version:'1'});
      const transport=new StreamableHTTPClientTransport(new URL(hub.endpoint+'/profiles/editing'));
      clients.push({client,transport});await client.connect(transport);return client;
    };
    const old=await connect(),oldName=(await old.listTools()).tools[0].name;
    let settled=false;
    pending=old.callTool({name:oldName,arguments:{text:'original request',wait:true}});
    pending.then(()=>{settled=true;},()=>{settled=true;});
    const deadline=Date.now()+8000;
    let entered;
    while(!entered){
      try{entered=JSON.parse(await fs.readFile(path.join(directory,'entered.json'),'utf8'));}
      catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
      if(Date.now()>deadline)assert.fail('Real upstream did not enter its controlled call');
      if(!entered)await delay(10);
    }
    assert.equal(settled,false);
    const updated=await hub.saveProfile({...original,serverIds:['after']},{expectedRevision:original.revision});
    assert.equal(settled,false,'Saving a revision must not cancel or complete the in-flight call');
    assert.equal(updated.revision,original.revision+1);
    const fresh=await connect(),newName=(await fresh.listTools()).tools[0].name;
    assert.notEqual(newName,oldName);
    const freshReply=reply(await fresh.callTool({name:newName,arguments:{text:'new revision'}}));
    assert.equal(freshReply.text,'new revision');assert.equal(freshReply.count,1);
    assert.notEqual(freshReply.pid,entered.pid);
    await assert.rejects(fresh.callTool({name:oldName,arguments:{text:'must not cross revisions'}}),/Unknown tool/);
    assert.equal(settled,false,'New-session work must not release the old upstream gate');
    await fs.writeFile(path.join(directory,'release'),'release');
    assert.deepEqual(reply(await pending),{text:'original request',pid:entered.pid,count:1});
    const retained=reply(await old.callTool({name:oldName,arguments:{text:'old revision remains usable'}}));
    assert.equal(retained.pid,entered.pid);assert.equal(retained.count,2,'Original operation must dispatch only once');
    const revisions=hub.getProfiles().clients.filter(c=>c.profileId==='editing').map(c=>c.profileRevision).sort((a,b)=>a-b);
    assert.deepEqual(revisions,[original.revision,updated.revision]);
  }finally{
    await fs.writeFile(path.join(directory,'release'),'cleanup');
    await pending?.catch(()=>{});
    for(const {client,transport} of clients){await transport.terminateSession().catch(()=>{});await client.close().catch(()=>{});}
    await hub?.close();
    const resolved=path.resolve(directory),temporary=path.resolve(os.tmpdir())+path.sep;
    assert(resolved.startsWith(temporary),'Cleanup must remain inside the disposable test directory');
    await fs.rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

test('maintenance interrupts an active real call, reaps its child and resumes without replaying the request',{timeout:30000},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor active maintenance '));
  const clients=[];let hub,pending;
  try{
    hub=await createHub({configPath:path.join(directory,'servers.json'),port:0,toolTimeoutMs:25000});
    await hub.saveServer({id:'held',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/gated-profile-server.mjs',import.meta.url))],env:{HARBOR_FIXTURE_GATE_DIR:directory}});
    await hub.startServer('held');
    const connect=async()=>{
      const client=new Client({name:'active maintenance test',version:'1'});
      const transport=new StreamableHTTPClientTransport(new URL(hub.endpoint));
      clients.push({client,transport});await client.connect(transport);return client;
    };
    const client=await connect(),name=(await client.listTools()).tools[0].name;
    pending=client.callTool({name,arguments:{text:'interrupted operation',wait:true}});
    const rejected=assert.rejects(pending);
    const deadline=Date.now()+8000;let entered;
    while(!entered){
      try{entered=JSON.parse(await fs.readFile(path.join(directory,'entered.json'),'utf8'));}
      catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
      if(Date.now()>deadline)assert.fail('Upstream did not enter active maintenance fixture');
      if(!entered)await delay(10);
    }
    await hub.enterMaintenance();await rejected;
    assert.equal(hub.snapshot().maintenanceReady,true);
    assert.equal(hub.snapshot().servers[0].status,'stopped');
    assert.throws(()=>process.kill(entered.pid,0),error=>error.code==='ESRCH');
    await assert.rejects(hub.startServer('held'),/maintenance/);
    await fs.writeFile(path.join(directory,'release'),'release before explicit resume');
    await hub.leaveMaintenance();
    const fresh=await connect();
    const result=JSON.parse((await fresh.callTool({name,arguments:{text:'explicit new request'}})).content[0].text);
    assert.equal(result.text,'explicit new request');assert.equal(result.count,1,'Interrupted operation must not replay on restart');
    assert.notEqual(result.pid,entered.pid);
    assert.equal(hub.snapshot().maintenance,false);
    const spans=hub.traceSnapshot().events.filter(event=>event.kind==='upstream'&&event.status==='completed');
    assert.equal(spans.length,2,'Only the interrupted call and the explicit new call may dispatch');
    assert.notEqual(spans[0].outcome,'success');
  }finally{
    await fs.writeFile(path.join(directory,'release'),'cleanup');await pending?.catch(()=>{});
    for(const {client,transport} of clients){await transport.terminateSession().catch(()=>{});await client.close().catch(()=>{});}
    await hub?.close();
    const resolved=path.resolve(directory);
    assert(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));
    await fs.rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
