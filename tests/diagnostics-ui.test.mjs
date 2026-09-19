import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium,_electron as electron,expect} from '@playwright/test';
import {DEFAULT_PLAN} from '../src/diagnostics/plans.mjs';
import {compare} from '../src/diagnostics/grading.mjs';

test('diagnostics UI invokes controls, preserves typed variants and renders all comparison views',async t=>{
  const server=createServer(async(req,res)=>{const name=req.url.slice(1);if(name===''){res.end('<html><head></head><body><main id="root"></main><script type="module">import {mountDiagnostics} from "/ui.js"; mountDiagnostics(document.querySelector("main"),window.harbor)</script></body></html>');return;}if(!['ui.js','ui.css','system-ui.js','temperature-ui.js'].includes(name)){res.writeHead(404).end();return;}res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'text/css');res.end(await readFile(new URL(`../src/diagnostics/${name}`,import.meta.url)));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1280,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(({plan,results})=>{window.calls=[];window.data={running:false,defaultPlan:plan,campaign:null,inventory:null,results,dataDir:'C:/explicit-ui-test-fixture'};window.harbor={diagnosticsSnapshot:async()=>window.data,diagnosticsProbe:async()=>{window.calls.push('probe');throw new Error('Fixture: model server is stopped');},diagnosticsStart:async plan=>{window.calls.push(plan);window.data.running=true;},diagnosticsCancel:async()=>{window.calls.push('cancel');window.data.running=false;},copy:async text=>window.calls.push(JSON.parse(text))};},{plan:DEFAULT_PLAN,results:compare([])});
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'Check Hermes',exact:true}).click();await page.getByRole('status').filter({hasText:'model server is stopped'}).waitFor();
  await page.getByText('Advanced: custom comparison matrix',{exact:true}).click();await page.getByLabel('Use advanced variant matrix').check();
  const custom=JSON.stringify([{id:'test-all',toolMode:'all'}]);await page.getByLabel('Delivery variants JSON').fill(custom);await page.waitForTimeout(1600);assert.equal(await page.getByLabel('Delivery variants JSON').inputValue(),custom);
  await page.getByRole('button',{name:'Start campaign',exact:true}).click();await page.getByRole('button',{name:'Cancel campaign',exact:true}).click();
  for(const label of ['Harbor configurations','Models','Harnesses','Combinations'])await page.getByRole('button',{name:label,exact:true}).click();
  await page.getByRole('button',{name:'Copy results JSON',exact:true}).click();const calls=await page.evaluate(()=>window.calls);assert.equal(calls[0],'probe');assert.equal(calls[1].variants[0].id,'test-all');assert.equal(calls[2],'cancel');assert('results' in calls[3]);assert.deepEqual(errors,[]);
  await mkdir('src/diagnostics/evidence',{recursive:true});await page.screenshot({path:'src/diagnostics/evidence/ui-fixture.png',fullPage:true});
});

test('Diagnostics tab in the real Electron window uses backend IPC and preserves primary settings',{skip:!process.env.HARBOR_TEST_DIAGNOSTICS_DESKTOP,timeout:60000},async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'harbor-diagnostic-desktop-'));
  const env={...process.env,HARBOR_DATA_DIR:data,HARBOR_PORT:'0'};delete env.ELECTRON_RUN_AS_NODE;delete env.HARBOR_PORTABLE_ROOT;
  const app=await electron.launch({...(process.env.HARBOR_EXECUTABLE?{executablePath:process.env.HARBOR_EXECUTABLE,args:[]}:{args:['.']}),env,timeout:20000});
  try{
    const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    const before=await page.evaluate(()=>window.harbor.getSettings());await page.getByRole('button',{name:'Diagnostics',exact:true}).click();
    await page.getByRole('button',{name:'Check Hermes',exact:true}).waitFor();await page.getByRole('button',{name:'Check Hermes',exact:true}).click();
    await expect.poll(()=>page.evaluate(async()=>{const s=await window.harbor.diagnosticsSnapshot();return !!(s.problem||s.inventory);}),{timeout:30000}).toBe(true);
    const snap=await page.evaluate(()=>window.harbor.diagnosticsSnapshot());assert(snap.problem||snap.inventory.ready);assert.equal(snap.running,false);
    await expect.poll(()=>page.evaluate(async()=>{const s=await window.harbor.diagnosticsSnapshot();return s.system.hardware.status;}),{timeout:20000}).toBe('ready');
    await expect(page.getByRole('meter',{name:'CPU',exact:true})).toHaveAttribute('aria-valuenow',/\d/);
    await expect(page.getByRole('meter',{name:'System memory',exact:true})).toHaveAttribute('aria-valuenow',/\d/);
    await expect(page.getByRole('meter',{name:'GPU memory',exact:true})).toHaveAttribute('aria-valuenow',/\d/);
    await expect(page.locator('.diag-temperature-legend')).toContainText('NVIDIA',{timeout:20000});
    for(const m of [10,30,60,5]){await page.getByRole('button',{name:`${m} min`,exact:true}).click();await expect(page.getByRole('button',{name:`${m} min`,exact:true})).toHaveAttribute('aria-pressed','true');}
    const sensor=page.locator('.diag-temperature-legend input').first(),sensorCount=await page.locator('.diag-temperature-chart path').count();await sensor.uncheck();await expect(page.locator('.diag-temperature-chart path')).toHaveCount(sensorCount-1);await sensor.check();
    await page.getByText('Processor, memory and storage details',{exact:true}).click();
    await expect(page.getByRole('heading',{name:'Physical drives',exact:true})).toBeVisible();
    await expect(page.locator('.diag-hardware-grid')).toContainText('C:');
    const recovery=await app.evaluate(async({app},dir)=>{
      const require=process.getBuiltinModule('node:module').createRequire(app.getAppPath()+'/package.json');
      const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
      const {createDiagnostics}=require(path.join(app.getAppPath(),'src/diagnostics/service.mjs'));
      const root=path.join(dir,'explicit-packaged-lock-fixture'),d=await createDiagnostics({dataDir:root,adapter:{probe:async()=>{throw new Error('Explicit test preflight; no model invoked');}}});
      await fs.writeFile(path.join(root,'campaign.lock'),JSON.stringify({pid:2147483647,host:os.hostname(),token:'dead-packaged-fixture'}));
      let failure;try{await d.start({tasks:['lookup'],variants:[{id:'all',toolMode:'all'}],repetitions:1});}catch(e){failure=e.message;}
      await d.close();return {failure,lockRemains:await fs.access(path.join(root,'campaign.lock')).then(()=>true,()=>false),helperMaterialized:(await fs.readdir(root)).some(f=>f.endsWith('.ps1'))};
    },data);
    assert.equal(recovery.failure,'Explicit test preflight; no model invoked');assert.equal(recovery.lockRemains,false);assert.equal(recovery.helperMaterialized,true);
    await mkdir('src/diagnostics/evidence',{recursive:true});await page.locator('#content').evaluate(e=>e.scrollTop=0);await page.screenshot({path:'src/diagnostics/evidence/system-overview.png',fullPage:true});
    const samplesBefore=await page.evaluate(async()=>(await window.harbor.diagnosticsSnapshot()).system.temperatures.series[0].points.length);
    await page.getByRole('button',{name:'This Server',exact:true}).click();await page.waitForTimeout(12000);
    await page.getByRole('button',{name:'Diagnostics',exact:true}).click();await page.getByRole('button',{name:'Check Hermes',exact:true}).waitFor();
    assert((await page.evaluate(async()=>(await window.harbor.diagnosticsSnapshot()).system.temperatures.series[0].points.length))>samplesBefore);
    await page.locator('.diag-temperature').scrollIntoViewIfNeeded();
    await page.screenshot({path:'src/diagnostics/evidence/temperature-history.png'});
    assert(await page.locator('.diag-temperature-legend').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
    assert.deepEqual(await page.evaluate(()=>window.harbor.getSettings()),before);assert.deepEqual(errors,[]);
  }finally{
    const exited=new Promise(r=>app.process().once('exit',r));await app.evaluate(({app})=>app.quit()).catch(()=>{});await exited;await rm(data,{recursive:true,force:true});
  }
});
