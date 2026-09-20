import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createProfileCredentials} from '../src/core/profile-credentials.mjs';
import {createDeliverySettings} from '../src/core/delivery-credentials.mjs';
import {DEFAULT_SETTINGS} from '../src/core/settings.mjs';
import {createHub} from '../src/core/hub.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor profile credentials ')),dataDir=path.join(root,'data');
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const key=async(id='one',prefix='portkeyApi')=>{
    const file=path.join(dataDir,'profile-credentials',id,'auth','embeddings',`${prefix}-${randomUUID()}.key`);
    await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'synthetic credential');return file;
  };
  return {root,dataDir,key};
}
const exists=async file=>fs.access(file).then(()=>true,()=>false);

test('credential collection preserves saved, cross-profile, portable and live references; deletes only managed orphan files',async t=>{
  const {root,dataDir,key}=await fixture(t),saved=await key(),live=await key(),unused=await key('deleted'),workers=await key('one','portkeyWorkers');
  let references=[{portkeyApiKeyFile:'${HARBOR_ROOT}/'+path.relative(root,saved).split(path.sep).join('/'),portkeyWorkersKeyFile:workers}];
  const manager=createProfileCredentials({dataDir,portableRoot:root,getReferences:()=>references});
  const release=manager.retain({portkeyApiKeyFile:live}),otherOwner=manager.retain({portkeyApiKeyFile:live});
  const external=path.join(root,'external.key'),unmanaged=path.join(path.dirname(saved),'manual.key'),defaultKey=path.join(dataDir,'auth','embeddings',`portkeyApi-${randomUUID()}.key`);
  await fs.mkdir(path.dirname(defaultKey),{recursive:true});for(const file of [external,unmanaged,defaultKey])await fs.writeFile(file,'preserve');
  await manager.collect();assert.equal(await exists(unused),false);
  for(const file of [saved,live,workers,external,unmanaged,defaultKey])assert.equal(await exists(file),true);
  release();release();await manager.drain();assert.equal(await exists(live),true,'other session still needs old revision');
  otherOwner();await manager.drain();assert.equal(await exists(live),false);
  references=[];await manager.collect();assert.equal(await exists(saved),false);assert.equal(await exists(workers),false);
  for(const file of [external,unmanaged,defaultKey])assert.equal(await exists(file),true);
});

test('an in-flight credential save cannot lose its new file to collection; failed saves roll back',async t=>{
  const {dataDir}=await fixture(t);let settings={...DEFAULT_SETTINGS},fail=false,entered,continueSave;
  const manager=createProfileCredentials({dataDir,getReferences:()=>[settings]});
  const save=createDeliverySettings({dataDir:path.join(dataDir,'profile-credentials','one'),getSettings:()=>settings,
    retainReplaced:()=>true,reserveCreated:manager.reserve,updateSettings:async next=>{
      entered(next);await new Promise(resolve=>continueSave=resolve);if(fail)throw Error('rejected save');settings=next;return next;
    }});
  async function attempt(shouldFail){
    fail=shouldFail;const ready=new Promise(resolve=>entered=resolve),pending=save({credentials:{portkeyApi:'fixture-key'}});
    const rejected=shouldFail?assert.rejects(pending,/rejected save/):null,next=await ready;
    await manager.collect();assert.equal(await exists(next.portkeyApiKeyFile),true);continueSave();
    if(rejected)await rejected;else await pending;await manager.drain();return next.portkeyApiKeyFile;
  }
  const first=await attempt(false),failed=await attempt(true);assert.equal(await exists(first),true);assert.equal(await exists(failed),false);
  const replacement=await attempt(false);assert.equal(await exists(first),false);assert.equal(await exists(replacement),true);
});

test('collection never traverses a profile junction or removes linked and unrecognized entries',async t=>{
  const {root,dataDir,key}=await fixture(t),normal=await key(),outside=path.join(root,'outside');
  await fs.mkdir(path.join(outside,'auth','embeddings'),{recursive:true});
  const target=path.join(outside,'auth','embeddings',`portkeyApi-${randomUUID()}.key`);await fs.writeFile(target,'preserve target');
  const junction=path.join(dataDir,'profile-credentials','linked');await fs.symlink(outside,junction,process.platform==='win32'?'junction':'dir');
  // Remove the link itself before recursive fixture cleanup, never its target.
  try{
    const manager=createProfileCredentials({dataDir,getReferences:()=>[]});await manager.collect();
    assert.equal(await exists(normal),false);assert.equal(await fs.readFile(target,'utf8'),'preserve target');
    assert((await fs.lstat(junction)).isSymbolicLink());
  }finally{await fs.unlink(junction);}
});

test('real MCP sessions retain old keys through rotation and last-owner disconnect, while saved references survive restart',async t=>{
  const {dataDir,key}=await fixture(t),orphan=await key('removed');
  let hub=await createHub({configPath:path.join(dataDir,'servers.json'),port:0});const connections=[];
  t.after(async()=>{for(const {client,transport} of connections){await transport.terminateSession().catch(()=>{});await client.close().catch(()=>{});}await hub.close();});
  assert.equal(await exists(orphan),false,'startup collects a crash orphan');
  let profile=await hub.saveProfile({id:'editable',name:'Editable',serverIds:[],delivery:{toolMode:'all'}});
  profile=await hub.saveProfileDelivery(profile.id,profile.revision,{credentials:{portkeyApi:'old-fixture-key'}});
  const old=profile.delivery.portkeyApiKeyFile;
  async function connect(){
    const client=new Client({name:'credential reference fixture',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(hub.endpoint+'/profiles/editable'));
    await client.connect(transport);const connection={client,transport};connections.push(connection);return connection;
  }
  const a=await connect(),b=await connect();
  profile=await hub.saveProfileDelivery(profile.id,profile.revision,{credentials:{portkeyApi:'new-fixture-key'}});
  const current=profile.delivery.portkeyApiKeyFile;await hub.collectProfileCredentials();assert.equal(await exists(old),true);
  await a.transport.terminateSession();await a.client.close();await hub.collectProfileCredentials();assert.equal(await exists(old),true);
  assert.deepEqual((await b.client.listTools()).tools,[]);
  await b.transport.terminateSession();await b.client.close();await hub.collectProfileCredentials();assert.equal(await exists(old),false);
  const other=await hub.saveProfile({id:'other',name:'Other',serverIds:[],delivery:{portkeyApiKeyFile:current}});
  await hub.removeProfile(profile.id,{expectedRevision:profile.revision});assert.equal(await exists(current),true,'another saved profile references the key');
  await hub.close();hub=await createHub({configPath:path.join(dataDir,'servers.json'),port:0});assert.equal(await exists(current),true);
  await hub.removeProfile(other.id,{expectedRevision:other.revision});assert.equal(await exists(current),false);
});

test('invalid and stale profile credential changes preserve the committed key and create no orphan',async t=>{
  const {dataDir}=await fixture(t),hub=await createHub({configPath:path.join(dataDir,'servers.json'),port:0});t.after(()=>hub.close());
  let profile=await hub.saveProfile({id:'editable',name:'Editable',serverIds:[]});
  const revision=profile.revision;profile=await hub.saveProfileDelivery(profile.id,revision,{credentials:{portkeyApi:'committed fixture'}});
  await assert.rejects(hub.saveProfileDelivery(profile.id,revision,{credentials:{portkeyApi:'stale fixture'}}),/changed/);
  await assert.rejects(hub.saveProfileDelivery(profile.id,profile.revision,{settings:{searchLimit:0},credentials:{portkeyApi:'invalid fixture'}}),/limit/i);
  await hub.collectProfileCredentials();
  assert.equal(await fs.readFile(profile.delivery.portkeyApiKeyFile,'utf8'),'committed fixture');
  assert.equal((await fs.readdir(path.dirname(profile.delivery.portkeyApiKeyFile))).length,1);
});
