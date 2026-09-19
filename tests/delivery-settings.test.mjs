import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createDeliverySettings} from '../src/core/delivery-credentials.mjs';
import {DEFAULT_SETTINGS,loadSettings,validateSettings} from '../src/core/settings.mjs';
test('delivery saves preserve a gateway setting changed while the form was open',async()=>{
  let reads=0,saved;
  const save=createDeliverySettings({dataDir:path.join(os.tmpdir(),'unused-delivery-credentials'),getSettings:()=>({...DEFAULT_SETTINGS,port:++reads===1?37373:38400}),updateSettings:async settings=>{saved=settings;return settings;}});
  await save({settings:{toolMode:'hybrid',searchLimit:8}});
  assert.equal(saved.port,38400);assert.equal(saved.toolMode,'hybrid');assert.equal(saved.searchLimit,8);
});
test('GUI credentials replace transactionally, preserve unrelated settings, and remain portable',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor credentials '));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let settings={...DEFAULT_SETTINGS},fail=false;
  const save=createDeliverySettings({dataDir:path.join(root,'data'),portableRoot:root,getSettings:()=>settings,updateSettings:async next=>{if(fail)throw new Error('test failed save');settings=validateSettings(next);return settings;}});
  const input={settings:{toolMode:'bm25',port:12345},credentials:{portkeyApi:'test-key-one'}};
  const first=await save(input);assert.equal(first.port,DEFAULT_SETTINGS.port);assert(!JSON.stringify(first).includes('test-key-one'));
  assert(first.portkeyApiKeyFile.startsWith('${HARBOR_ROOT}/'));const resolve=p=>p.replaceAll('${HARBOR_ROOT}',root);
  assert.equal(await fs.readFile(resolve(first.portkeyApiKeyFile),'utf8'),'test-key-one');
  fail=true;await assert.rejects(save({credentials:{portkeyApi:'test-key-two'}}),/test failed/);
  assert.equal((await fs.readdir(path.join(root,'data/auth/embeddings'))).length,1);assert.equal(settings.portkeyApiKeyFile,first.portkeyApiKeyFile);
  fail=false;const second=await save({credentials:{portkeyApi:'test-key-three'}});assert.equal(await fs.readFile(resolve(second.portkeyApiKeyFile),'utf8'),'test-key-three');await assert.rejects(fs.access(resolve(first.portkeyApiKeyFile)));
  await save({credentials:{portkeyApi:null}});assert.equal(settings.portkeyApiKeyFile,'');assert.deepEqual(await fs.readdir(path.join(root,'data/auth/embeddings')),[]);
});
test('old Hybrid All-tools selection migrates without preventing application startup',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor hybrid migration '));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'settings.json');
  for(const modes of [['all','bm25'],['all','regex','code']]){
    await fs.writeFile(file,JSON.stringify({...DEFAULT_SETTINGS,toolMode:'hybrid',hybridModes:modes}));const settings=await loadSettings(file);
    assert(!settings.hybridModes.includes('all'));assert(settings.hybridModes.length>=2);assert.equal(new Set(settings.hybridModes).size,settings.hybridModes.length);
  }
});
