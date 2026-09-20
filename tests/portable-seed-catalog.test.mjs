import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createSeedCatalog,writeSeedCatalog} from '../scripts/portable/seed-catalog.mjs';
import {initializePortable,resolvePortableConfig} from '../src/core/portable.mjs';
import {loadConfigs} from '../src/core/config.mjs';

test('release seed has complete attributed membership and explicit startup policy',async()=>{
 const catalog=createSeedCatalog(),licenses=JSON.parse(await fs.readFile(new URL('../third-party/portable/default-server-licenses.json',import.meta.url),'utf8'));
 assert.deepEqual(catalog.servers.map(s=>s.id).sort(),licenses.servers.map(s=>s.id).sort());
 assert.deepEqual(catalog.servers.filter(s=>s.autoStart).map(s=>s.id).sort(),['dbhub','desktop-commander','filesystem','pdf-tools','typst-mcp']);
 assert(catalog.servers.every(s=>!s.onDemand&&s.enabled));
 const accountServers=catalog.servers.filter(s=>['github','brave-search','exa','context7'].includes(s.id));
 assert(accountServers.every(s=>!s.autoStart));
 assert.deepEqual(catalog.servers.find(s=>s.id==='git-local').args,['-m','mcp_server_git']);
 const browserLayout=JSON.parse(await fs.readFile(new URL('../scripts/portable/browser-layout.windows-x64.json',import.meta.url),'utf8'));
 const browserTarget=browserLayout.components.find(c=>c.artifact==='chromium-win-x64').target;
 const playwright=catalog.servers.find(s=>s.id==='playwright');
 assert(playwright.args.includes('--allow-unrestricted-file-access'),'Local browser tools must accept files outside Harbor workspace, subject to Windows permissions');
 assert.equal(playwright.args[playwright.args.indexOf('--executable-path')+1],`${'${HARBOR_ROOT}'}/${browserTarget}/chrome-win64/chrome.exe`);
 assert.equal(catalog.servers.find(s=>s.id==='desktop-commander').env.HARBOR_BUNDLED_CHROMIUM,playwright.args[playwright.args.indexOf('--executable-path')+1]);
});

test('clean seed is independently constructed and contains no machine/account state',()=>{
 const first=createSeedCatalog();first.servers[0].env.INJECTED_SECRET='test';
 const catalog=createSeedCatalog(),text=JSON.stringify(catalog);
 assert(!text.includes('INJECTED_SECRET'));
 assert(!/Bearer\s|ghp_|sk-/i.test(text));
 const strings=value=>typeof value==='string'?[value]:value&&typeof value==='object'?Object.values(value).flatMap(strings):[];
 assert(strings(catalog).every(value=>!/^(?:[A-Z]:[\\/]|\\\\|\/Users\/|\/home\/)/i.test(value)));
 for(const server of catalog.servers){
  if(server.command){assert(server.command.startsWith('${HARBOR_ROOT}/'));assert(server.cwd.startsWith('${HARBOR_ROOT}/'));}
  for(const [key,value] of Object.entries(server.env))if(/TOKEN|SECRET|PASSWORD|API_KEY/.test(key)){assert.equal(key,'BRAVE_API_KEY_FILE');assert.equal(value,'${HARBOR_ROOT}/data/auth/brave-api-key.txt');}
 }
});

test('real seed initializes a relocated folder and never replaces saved selections',async()=>{
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-seed-'));
 try{
  const first=path.join(temporary,'Fresh portable'),moved=path.join(temporary,'Moved ü portable');await fs.mkdir(first);
  await fs.writeFile(path.join(first,'portable.json'),'{"version":1}');await writeSeedCatalog(path.join(first,'catalog.json'));
  await assert.rejects(writeSeedCatalog(path.join(first,'catalog.json')),{code:'EEXIST'});
  await initializePortable(first);const saved=await loadConfigs(path.join(first,'data/servers.json'));
  assert.equal(saved.length,19);saved[0].enabled=false;const personal=JSON.stringify({version:1,servers:saved});
  await fs.writeFile(path.join(first,'data/servers.json'),personal);
  await fs.rename(first,moved);await initializePortable(moved);
  assert.equal(await fs.readFile(path.join(moved,'data/servers.json'),'utf8'),personal);
  for(const server of saved.filter(s=>s.command))assert(resolvePortableConfig(server,moved).command.startsWith(moved.replaceAll('\\','/')+'/'));
  assert.deepEqual(await fs.readdir(path.join(moved,'data/home')),[]);
  await assert.rejects(fs.access(path.join(moved,'data/auth')),{code:'ENOENT'});
 }finally{await fs.rm(temporary,{recursive:true,force:true});}
});
