import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron,expect} from '@playwright/test';

test('native maintenance keeps build controls unavailable until real child shutdown finishes',{
 skip:!process.env.HARBOR_TEST_MAINTENANCE_DESKTOP,timeout:120000
},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor maintenance native '));
 assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));
 let app;
 try{
  await fs.writeFile(path.join(root,'portable.json'),'{"version":1}');
  await fs.writeFile(path.join(root,'catalog.json'),JSON.stringify({version:1,servers:[{id:'fixture',name:'Maintenance fixture',command:process.execPath,args:[path.resolve('tests/fixtures/server.mjs')],autoStart:false}]}));
  await fs.mkdir(path.join(root,'packages/fixture'),{recursive:true});await fs.writeFile(path.join(root,'packages/fixture/proof.txt'),'unchanged');
  await fs.writeFile(path.join(root,'maintenance.json'),JSON.stringify({version:1,components:[{id:'fixture',name:'Fixture',path:'packages/fixture',build:[{command:process.execPath,args:['-e',"require('fs').writeFileSync('proof.txt','updated')"]}],verify:[{command:process.execPath,args:['-e',"if(require('fs').readFileSync('proof.txt','utf8')!=='updated')process.exit(1)"]}]}]}));
  const env={...process.env,HARBOR_PORTABLE_ROOT:root,HARBOR_PORT:'0'};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:['.'],env});const page=await app.firstWindow();
  await expect(page.locator('#gateway-status')).toContainText('Gateway online');
  await page.evaluate(()=>window.harbor.startServer('fixture'));
  await app.evaluate(({app})=>{
   const require=process.getBuiltinModule('node:module').createRequire(app.getAppPath()+'/package.json');
   const {Upstreams}=require('./src/core/upstreams.mjs');
   const original=Upstreams.prototype.stop;let release;const hold=new Promise(resolve=>{release=resolve;});
   globalThis.__maintenanceReadinessTest={entered:false,release,restore:()=>{Upstreams.prototype.stop=original;}};
   Upstreams.prototype.stop=async function(id){if(id==='fixture'){globalThis.__maintenanceReadinessTest.entered=true;await hold;}return original.call(this,id);};
  });
  await page.getByRole('button',{name:'Maintenance',exact:true}).click();await page.getByRole('button',{name:'Enter maintenance mode',exact:true}).click();
  await expect.poll(()=>app.evaluate(()=>globalThis.__maintenanceReadinessTest.entered)).toBe(true);
  await expect(page.getByRole('button',{name:'Stopping servers…',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Rebuild',exact:true})).toBeDisabled();
  await assert.rejects(page.evaluate(()=>window.harbor.updateComponent('fixture',{rebuild:true})),/maintenance mode/);
  assert.equal(await fs.readFile(path.join(root,'packages/fixture/proof.txt'),'utf8'),'unchanged');
  await app.evaluate(()=>globalThis.__maintenanceReadinessTest.release());
  await expect(page.getByRole('button',{name:'Resume servers',exact:true})).toBeEnabled();
  await expect(page.getByRole('button',{name:'Rebuild',exact:true})).toBeEnabled();
  assert((await page.evaluate(()=>window.harbor.snapshot())).servers.every(server=>server.status==='stopped'));
  if(process.env.HARBOR_PHASE2_EVIDENCE){await fs.mkdir(process.env.HARBOR_PHASE2_EVIDENCE,{recursive:true});await page.screenshot({path:path.join(process.env.HARBOR_PHASE2_EVIDENCE,'maintenance-ready.png'),fullPage:true});}
  await page.getByRole('button',{name:'Rebuild',exact:true}).click();
  await expect.poll(async()=>(await page.evaluate(()=>window.harbor.snapshot())).maintenanceInfo.phase).toBe('complete');
  assert.equal(await fs.readFile(path.join(root,'packages/fixture/proof.txt'),'utf8'),'updated');
  await app.evaluate(()=>{
   const files=process.getBuiltinModule('node:fs/promises'),original=files.readFile;
   let release;const hold=new Promise(resolve=>{release=resolve;});
   globalThis.__maintenanceRollbackTest={entered:false,release,restore:()=>{files.readFile=original;}};
   files.readFile=async function(file,...args){if(String(file).endsWith('rollback-fixture.json')){globalThis.__maintenanceRollbackTest.entered=true;await hold;}return original.call(this,file,...args);};
  });
  await page.getByRole('button',{name:'Restore previous',exact:true}).click();
  await expect.poll(()=>app.evaluate(()=>globalThis.__maintenanceRollbackTest.entered)).toBe(true);
  await expect(page.getByRole('button',{name:'Resume servers',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Rebuild',exact:true})).toBeDisabled();
  await assert.rejects(page.evaluate(()=>window.harbor.leaveMaintenance()),/Wait for maintenance/);
  await assert.rejects(page.evaluate(()=>window.harbor.updateComponent('fixture',{rebuild:true})),/already running/);
  await app.evaluate(()=>globalThis.__maintenanceRollbackTest.release());
  await expect.poll(async()=>(await page.evaluate(()=>window.harbor.snapshot())).maintenanceInfo.phase).toBe('rolled-back');
  await expect(page.getByRole('button',{name:'Resume servers',exact:true})).toBeEnabled();
  assert.equal(await fs.readFile(path.join(root,'packages/fixture/proof.txt'),'utf8'),'unchanged');
  if(process.env.HARBOR_PHASE2_EVIDENCE)await page.screenshot({path:path.join(process.env.HARBOR_PHASE2_EVIDENCE,'maintenance-restored.png'),fullPage:true});
 }finally{
  if(app){await app.evaluate(()=>{globalThis.__maintenanceReadinessTest?.release();globalThis.__maintenanceReadinessTest?.restore();globalThis.__maintenanceRollbackTest?.release();globalThis.__maintenanceRollbackTest?.restore();}).catch(()=>{});const child=app.process(),done=child.exitCode!==null?Promise.resolve():new Promise(resolve=>child.once('exit',resolve));await app.evaluate(({app})=>app.quit()).catch(()=>{});await done;}
  await fs.rm(root,{recursive:true,force:true});
 }
});
