import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium,_electron as electron,expect} from '@playwright/test';
import {DEFAULT_PLAN} from '../src/diagnostics/plans.mjs';
import {compare} from '../src/diagnostics/grading.mjs';

test('diagnostics UI invokes controls, preserves typed variants and compares Harbor configurations only',{timeout:90000},async t=>{
  const server=createServer(async(req,res)=>{const name=req.url.slice(1);if(name===''){res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><main id="root"></main><script type="module">import {mountDiagnostics} from "/ui.js"; mountDiagnostics(document.querySelector("main"),window.harbor)</script></body></html>');return;}if(name==='app.css'){res.setHeader('Content-Type','text/css');res.end(await readFile(new URL('../src/ui/styles.css',import.meta.url)));return;}if(!['ui.js','ui.css','system-ui.js','temperature-ui.js','workload-catalog.js','catalog-options.js'].includes(name)){res.writeHead(404).end();return;}res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'text/css');res.end(await readFile(new URL(`../src/diagnostics/${name}`,import.meta.url)));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  // Stop browser traffic before waiting for the fixture listener to close.
  // Speculative connections can otherwise keep Windows CI in teardown forever.
  t.after(async()=>{
    try{await browser?.close();}
    finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
  });
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(({plan,results})=>{window.calls=[];window.data={running:false,defaultPlan:plan,campaign:null,inventory:null,results,dataDir:'C:/explicit-ui-test-fixture'};window.harbor={diagnosticsSnapshot:async()=>window.data,diagnosticsProbe:async input=>{window.probeInput=input;window.calls.push('probe');throw new Error('Fixture: model server is stopped');},diagnosticsStart:async plan=>{window.calls.push(plan);window.data.running=true;},diagnosticsCancel:async()=>{window.calls.push('cancel');window.data.running=false;},copy:async text=>window.calls.push(JSON.parse(text))};},{plan:DEFAULT_PLAN,results:compare([])});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const screenshot=async name=>{if(process.env.HARBOR_PHASE2_EVIDENCE){await mkdir(process.env.HARBOR_PHASE2_EVIDENCE,{recursive:true});await page.screenshot({path:path.join(process.env.HARBOR_PHASE2_EVIDENCE,name),fullPage:true});}};
  await screenshot('guided-connection.png');
  await expect(page.getByRole('button',{name:'Check Hermes',exact:true})).toBeVisible();
  await page.getByLabel('Test harness',{exact:true}).selectOption('lmstudio');
  await page.getByRole('button',{name:'Check LM Studio',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.probeInput),{harness:'lmstudio'});
  await page.getByLabel('Test harness',{exact:true}).selectOption('openclaw');
  await page.getByRole('button',{name:'Check OpenClaw',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.probeInput),{harness:'openclaw'});await page.getByRole('status').filter({hasText:'model server is stopped'}).waitFor();
  await expect(page.locator('.diag-step[open]')).toHaveCount(1);await expect(page.getByLabel('Test All tools',{exact:true})).not.toBeVisible();
  await page.getByText('Connection details',{exact:true}).click();
  await expect(page.getByLabel('Model comparison identity')).toContainText('incomplete');
  await page.evaluate(()=>{window.data.harness='openclaw';window.data.inventory={harness:'OpenClaw',model:'fixture-only',reasoning:'high',hardware:{logicalCpus:4,ramBytes:8*2**30},modelEvidence:{verification:'gguf-bytes-and-live-props-v1',files:[{}],contextLength:4096,build:'fixture-only'}};});
  await expect(page.getByLabel('Model comparison identity')).toContainText('Model files verified: 1');await expect(page.getByLabel('Model comparison identity')).toContainText('4,096 tokens');await expect(page.getByLabel('Model comparison identity')).toContainText('Campaign observations must also match');
  await page.getByLabel('Test harness',{exact:true}).selectOption('hermes');
  await expect(page.getByLabel('Model comparison identity')).toContainText('incomplete');
  await expect(page.locator('.diag-status')).toContainText('Check the selected harness');
  await page.waitForTimeout(1600);
  await expect(page.getByLabel('Model comparison identity')).not.toContainText('Model files verified');
  await page.getByRole('button',{name:'5. Review and run',exact:true}).click();
  await expect(page.getByLabel('Campaign review')).toContainText('not checked yet');
  await page.getByRole('button',{name:'1. Connection',exact:true}).click();
  await page.getByLabel('Test harness',{exact:true}).selectOption('openclaw');
  await expect(page.getByLabel('Model comparison identity')).toContainText('Model files verified');
  await page.getByRole('button',{name:'Continue to tasks',exact:true}).click();await expect(page.getByRole('button',{name:'Select representative pack',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Continue to delivery',exact:true}).click();await expect(page.locator('.diag-step[open]')).toHaveCount(1);
  await screenshot('guided-delivery.png');
  await page.getByText('Advanced delivery settings',{exact:true}).click();await page.getByText('Advanced: custom comparison matrix',{exact:true}).click();await page.getByLabel('Use advanced variant matrix').check();
  const custom=JSON.stringify([{id:'test-all',toolMode:'all'}]);await page.getByLabel('Delivery variants JSON').fill(custom);await page.waitForTimeout(1600);assert.equal(await page.getByLabel('Delivery variants JSON').inputValue(),custom);
  await page.getByRole('button',{name:'Continue to limits',exact:true}).click();await page.getByRole('button',{name:'Review campaign',exact:true}).click();await expect(page.getByLabel('Campaign review')).toContainText('test-all');await expect(page.getByLabel('Campaign review')).toContainText('Planned trials: 18');
  await screenshot('guided-review.png');
  await page.setViewportSize({width:600,height:850});await expect(page.locator('.diag-step[open]')).toHaveCount(1);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Guided setup must fit a narrow window');await screenshot('guided-review-narrow.png');await page.setViewportSize({width:1280,height:1000});
  await page.getByRole('button',{name:'3. Delivery',exact:true}).click();await expect(page.getByLabel('Delivery variants JSON')).toHaveValue(custom);await page.getByRole('button',{name:'5. Review and run',exact:true}).click();
  await page.getByRole('button',{name:'Start campaign',exact:true}).click();await page.getByRole('button',{name:'Cancel campaign',exact:true}).click();
  await page.getByRole('button',{name:'Harbor configurations',exact:true}).click();
  for(const label of ['Models','Harnesses','Combinations'])assert.equal(await page.getByRole('button',{name:label,exact:true}).count(),0);
  await page.getByRole('button',{name:'Copy results JSON',exact:true}).click();const calls=await page.evaluate(()=>window.calls);assert.equal(calls.filter(c=>c==='probe').length,2);const submitted=calls.find(c=>c?.variants);assert.equal(submitted.variants[0].id,'test-all');assert.equal(submitted.harness,'openclaw');assert(calls.includes('cancel'));assert(calls.some(c=>c&&typeof c==='object'&&'results' in c));assert.deepEqual(errors,[]);
  await page.evaluate(()=>{
    window.data.campaign={id:'fixture-campaign',status:'finished',plannedTrials:1,trials:[{id:'fixture-trial',configId:'all',task:'lookup',repetition:0,status:'finished',elapsedMs:10,grade:{completed:true},deliveryObservation:{retrievalCoverage:null,discoveryRequests:0,upstreamExecutions:2,modelRequestCount:null}}]};
    window.harbor.diagnosticsInspectTrial=async input=>{window.inspected=input;return {id:input.trialId,deliveryEvidence:{perModelRequestPresentation:null},trace:{events:[]},fixture:'x'.repeat(70000)};};
  });
  const inspectButton=page.getByRole('button',{name:'Inspect all / lookup / repetition 1',exact:true});
  await expect(inspectButton).toBeVisible();
  const originalInspect=await inspectButton.elementHandle();await originalInspect.focus();
  await page.evaluate(()=>{const snapshot=window.harbor.diagnosticsSnapshot;window.reportPolls=0;window.harbor.diagnosticsSnapshot=async()=>{window.reportPolls++;return structuredClone(await snapshot());};window.data.problem='Fixture: background status changed';});
  await expect.poll(()=>page.evaluate(()=>window.reportPolls)).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.diag-status')).toContainText('background status changed');
  assert(await originalInspect.evaluate(button=>button.isConnected&&document.activeElement===button),'Unchanged report polling must preserve the inspect button and keyboard focus');
  await originalInspect.dispose();await inspectButton.click();
  const countRows=await page.evaluate(()=>{
    const first=window.data.campaign.trials[0];Object.assign(first,{eligible:true,grade:{completed:true,accepted:true,adherent:true,toolCorrect:null},argumentCorrectness:0});
    window.data.campaign.trials.push({...first,id:'cancelled-trial',repetition:1,eligible:false,status:'cancelled'});window.data.campaign.plannedTrials=2;
    return window.data.campaign.trials;
  });
  await page.evaluate(results=>{window.data.results=results;},compare(countRows));
  await expect(page.getByText(/all: 1 excluded, 0 timed out, 1 cancelled/)).toBeVisible();
  await expect(page.getByText(/Tool-selection observations: 0 \/ 1 eligible; argument observations: 1 \/ 1 eligible/)).toBeVisible();
  await expect(page.getByLabel('Trial evidence')).toContainText('Page 1 / 2');await page.getByRole('button',{name:'Next evidence page',exact:true}).click();await expect(page.getByLabel('Trial evidence')).toContainText('Page 2 / 2');
  assert.deepEqual(await page.evaluate(()=>window.inspected),{campaignId:'fixture-campaign',trialId:'fixture-trial'});assert.deepEqual(errors,[]);
  await page.evaluate(()=>{
    window.saved={campaign:{...window.data.campaign,id:'older-campaign',plan:{seed:876},trials:Array.from({length:21},(_,index)=>({...window.data.campaign.trials[0],id:'older-'+index,repetition:index}))},results:window.data.results};
    window.harbor.diagnosticsListCampaigns=async()=>({items:[{id:'older-campaign',status:'finished',trials:21,plannedTrials:21}],page:0,pages:1,total:1});
    window.harbor.diagnosticsInspectCampaign=async id=>{window.opened=id;return window.saved;};
    window.harbor.diagnosticsSaveCampaign=async id=>{window.exported=id;return {saved:true,name:'fixture.json',bytes:12345};};
  });
  await page.getByText('Saved campaigns',{exact:true}).click();await page.getByRole('button',{name:'Refresh saved campaigns',exact:true}).click();await page.getByRole('button',{name:'Open selected campaign',exact:true}).click();
  await expect(page.getByText('Trial page 1 / 2',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Older trials',exact:true}).click();await expect(page.getByText('Trial page 2 / 2',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Inspect all / lookup / repetition 1',exact:true}).click();assert.equal((await page.evaluate(()=>window.inspected)).campaignId,'older-campaign');
  await page.getByText('Selected campaign settings and setup',{exact:true}).click();await expect(page.getByText('Selected campaign settings and setup',{exact:true}).locator('..')).toContainText('876');
  await page.getByRole('button',{name:'Save campaign evidence',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Saved fixture.json'})).toBeVisible();assert.equal(await page.evaluate(()=>window.exported),'older-campaign');
  await page.waitForTimeout(1600);await expect(page.getByText('Trial page 2 / 2',{exact:true})).toBeVisible();await expect(page.getByText('Selected campaign settings and setup',{exact:true}).locator('..')).toHaveAttribute('open','');await page.getByRole('button',{name:'Show latest campaign',exact:true}).click();await expect(page.getByText('Trial page 1 / 1',{exact:true})).toBeVisible();
  assert.deepEqual(errors,[]);
  await page.getByRole('button',{name:'3. Delivery',exact:true}).click();await page.getByLabel('Use advanced variant matrix').uncheck();await page.getByLabel('Compare catalog variant',{exact:true}).check();await page.getByLabel('Include equivalent fixture provider',{exact:true}).check();await page.getByLabel('Candidate tool subset',{exact:true}).selectOption('workflow');await page.getByLabel('Candidate schema annotations',{exact:true}).selectOption('minimal');await page.getByLabel('Candidate preferred fixture provider',{exact:true}).selectOption('alternate');
  await page.getByRole('button',{name:'5. Review and run',exact:true}).click();await expect(page.getByLabel('Campaign review')).toContainText('Planned trials: 216');
  await page.getByRole('button',{name:'Start campaign',exact:true}).click();const catalogPlan=await page.evaluate(()=>window.calls.at(-1));assert.equal(catalogPlan.variants.length,12);assert.equal(catalogPlan.overlapProviders,true);assert.equal(catalogPlan.variants[1].id,'all-catalog');assert.deepEqual(catalogPlan.variants[1].catalog,{subset:'workflow',descriptions:'concise',schemaAnnotations:'minimal',order:'source',provider:'alternate'});await page.getByRole('button',{name:'Cancel campaign',exact:true}).click();assert.deepEqual(errors,[]);
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
    await page.getByText('Hardware and temperature monitoring',{exact:true}).click();
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
    await page.getByText('Hardware and temperature monitoring',{exact:true}).click();
    assert((await page.evaluate(async()=>(await window.harbor.diagnosticsSnapshot()).system.temperatures.series[0].points.length))>samplesBefore);
    await page.locator('.diag-temperature').scrollIntoViewIfNeeded();
    await page.screenshot({path:'src/diagnostics/evidence/temperature-history.png'});
    assert(await page.locator('.diag-temperature-legend').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
    assert.deepEqual(await page.evaluate(()=>window.harbor.getSettings()),before);assert.deepEqual(errors,[]);
  }finally{
    const exited=new Promise(r=>app.process().once('exit',r));await app.evaluate(({app})=>app.quit()).catch(()=>{});await exited;await rm(data,{recursive:true,force:true});
  }
});
