import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCatalogCache,exposedName,launchFingerprint} from '../src/core/catalog-cache.mjs';
import {validateConfig} from '../src/core/config.mjs';

test('versioned catalogs retain exact tool contracts and hashed launch identity without persisting environment credentials',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor catalog '));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'cache.json');
  const config=validateConfig({id:'one',command:'fixture',env:{TOKEN:'synthetic-sensitive-value'},onDemand:true}),tools=[{serverId:'one',originalName:'echo',name:exposedName('one','echo'),inputSchema:{type:'object'}}];
  const cache=await createCatalogCache({file});await cache.set(config,tools);const text=await fs.readFile(file,'utf8');assert(!text.includes('synthetic-sensitive-value'));
  const reopened=await createCatalogCache({file});assert.deepEqual(reopened.get(config).tools,tools);assert.equal(reopened.get({...config,name:'renamed',onDemand:false}).launchFingerprint,launchFingerprint(config));
  assert.equal(reopened.get({...config,env:{TOKEN:'different'}}),null);
  await reopened.prune([{...config,args:['new']}]);assert.equal(reopened.get(config),null);assert.equal((await createCatalogCache({file})).get(config),null);
});

test('malformed, future-version and tampered catalogs are discarded with a visible error signal',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor invalid catalog '));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'cache.json');let warnings=0;
  for(const text of ['not JSON',JSON.stringify({schemaVersion:99,records:{}}),JSON.stringify({schemaVersion:1,records:{one:{launchFingerprint:'a'.repeat(64),observedAt:1,catalogFingerprint:'b'.repeat(64),tools:[]}}})]){
    await fs.writeFile(file,text);const cache=await createCatalogCache({file,onError:()=>warnings++});assert.equal(cache.get({id:'one'}),null);
  }
  assert.equal(warnings,3);
});

test('legacy settings preserve startup choices and require explicit on-demand eligibility',()=>{
  const legacy=validateConfig({id:'legacy',command:'fixture',autoStart:true});assert.equal(legacy.enabled,true);assert.equal(legacy.autoStart,true);assert.equal(legacy.onDemand,false);
  for(const patch of [{enabled:false,autoStart:true},{enabled:false,onDemand:true},{idleMinutes:0},{idleMinutes:1441},{onDemand:'yes'}])assert.throws(()=>validateConfig({id:'one',command:'fixture',...patch}));
});
