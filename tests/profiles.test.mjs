import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createProfileStore} from '../src/core/profiles.mjs';
import {DEFAULT_SETTINGS} from '../src/core/settings.mjs';

async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor profiles '));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const configs=[{id:'filesystem',transport:'stdio',runtime:'native',autoStart:true},{id:'dbhub',transport:'stdio',runtime:'native',autoStart:false},{id:'remote',transport:'http',runtime:'native',autoStart:false}];
  const args={file:path.join(dir,'profiles.json'),getConfigs:()=>configs,getSettings:()=>DEFAULT_SETTINGS};
  return {store:await createProfileStore(args),configs,args};
}

test('profile presets and editing preserve startup selections and default settings',async t=>{
  const {store,configs}=await fixture(t),before=structuredClone(configs);
  assert.deepEqual(store.snapshot().profiles.map(p=>p.name),['Coding','Documents','Research','Databases']);
  assert.deepEqual(store.get('coding').serverIds,['filesystem']);
  const saved=await store.save({id:'selected',name:'Selected',serverIds:['dbhub'],delivery:{toolMode:'regex'},isolation:'shared'});
  assert.equal(saved.delivery.toolMode,'regex');assert.equal(store.snapshot().defaultProfile.delivery.toolMode,'all');
  assert.deepEqual(configs,before);assert.match(saved.boundary,/not separate authorization/);
});

test('profile revisions persist, reject stale edits and never reuse a deleted revision',async t=>{
  const {store,args}=await fixture(t);
  const input={id:'custom',name:'Custom',serverIds:['filesystem'],isolation:'process'};
  const first=await store.save(input);
  const second=await store.save({...input,name:'Updated'},{expectedRevision:first.revision});
  assert(second.revision>first.revision);
  assert.equal((await createProfileStore(args)).get('custom').name,'Updated');
  await assert.rejects(store.save(input,{expectedRevision:first.revision}),/changed/);
  await store.remove('custom',{expectedRevision:second.revision});
  const third=await store.save(input);assert(third.revision>second.revision);
});

test('profiles reject invalid Hybrid, unknown servers, duplicate selections and unsupported isolation',async t=>{
  const {store}=await fixture(t);
  const input={id:'custom',name:'Custom',serverIds:['filesystem']};
  for(const bad of [
    {...input,serverIds:['missing']},{...input,serverIds:['filesystem','filesystem']},
    {...input,isolation:'process',serverIds:['remote']},
    {...input,delivery:{toolMode:'hybrid',hybridModes:['all','regex']}},
    {...input,delivery:{toolMode:'hybrid',hybridModes:['regex']}},
    {...input,id:'default'},{...input,delivery:{networkEnabled:true}}
  ])await assert.rejects(store.save(bad));
});

test('changed or removed servers do not corrupt saved profiles; unsupported isolation fails explicitly at connection',async t=>{
  const {store,configs,args}=await fixture(t);
  await store.save({id:'private',name:'Private processes',serverIds:['filesystem','dbhub'],isolation:'process'});
  configs.splice(configs.findIndex(c=>c.id==='dbhub'),1);
  configs[0].transport='http';
  const reopened=await createProfileStore(args);
  assert.deepEqual(reopened.get('private').missingServerIds,['dbhub']);
  assert.deepEqual(reopened.get('private').unsupportedIsolationIds,['filesystem']);
  assert.throws(()=>reopened.get('private',{forSession:true}),/native stdio/);
});

test('failed persistence leaves the prior profile revision intact and later writes remain usable',async t=>{
  const {store,args}=await fixture(t);const original=store.get('coding');
  await fs.mkdir(args.file);
  await assert.rejects(store.save({...original,name:'Should not persist'},{expectedRevision:original.revision}));
  assert.equal(store.get('coding').name,original.name);assert.equal(store.get('coding').revision,original.revision);
  await fs.rmdir(args.file);
  assert.equal((await store.save({...original,name:'Recovered'},{expectedRevision:original.revision})).name,'Recovered');
});
