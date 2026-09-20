import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {_electron as electron,expect} from '@playwright/test';
import {WORKLOAD_TASKS} from '../src/diagnostics/workload-catalog.js';
import {createWorkloadModelFixture} from './fixtures/workload-model.mjs';

test('native representative campaign runs real file, SQLite and Chromium tasks through installed Hermes',{
  skip:!process.env.HARBOR_TEST_DIAGNOSTICS_WORKLOAD_CAMPAIGN,timeout:300000
},async t=>{
  const installed=path.join(process.env.LOCALAPPDATA,'hermes/hermes-agent');await fs.access(path.join(installed,'venv/Scripts/python.exe'));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor representative desktop ')),local=path.join(root,'local'),source=path.join(local,'hermes'),profile=path.join(root,'profile');
  await fs.mkdir(path.join(source,'runtimes/llamacpp'),{recursive:true});await fs.symlink(installed,path.join(source,'hermes-agent'),'junction');
  const fixture=await createWorkloadModelFixture();
  await fs.writeFile(path.join(source,'config.yaml'),`model:\n  provider: llamacpp\n  default: ${fixture.model}\n`);
  await fs.writeFile(path.join(source,'runtimes/llamacpp/server.json'),JSON.stringify({pid:process.pid,base_url:fixture.endpoint,api_key:'synthetic-only'}));
  const env={...process.env,LOCALAPPDATA:local,HARBOR_DATA_DIR:profile,HARBOR_PORT:'0'};delete env.ELECTRON_RUN_AS_NODE;delete env.HARBOR_PORTABLE_ROOT;delete env.HERMES_HOME;
  let app;
  t.after(async()=>{if(app){const exited=new Promise(resolve=>app.process().once('exit',resolve));await app.evaluate(({app})=>{setTimeout(()=>app.quit(),0);}).catch(()=>{});await exited;}await fixture.close();await fs.unlink(path.join(source,'hermes-agent'));assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  app=await electron.launch({args:['.'],env});const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await expect(page.locator('#gateway-status')).toContainText('Gateway online');
  await page.getByRole('button',{name:'Diagnostics',exact:true}).click();await expect(page.getByRole('button',{name:'Check Hermes',exact:true})).toBeVisible();await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await page.getByRole('button',{name:'Check Hermes',exact:true}).click();await expect(page.locator('.diag-status')).toContainText('ready to run',{timeout:30000});
  await page.getByRole('button',{name:'Continue to tasks',exact:true}).click();await page.getByRole('button',{name:'Select representative pack',exact:true}).click();await page.getByText('Choose individual tasks',{exact:true}).click();
  for(const task of WORKLOAD_TASKS)await expect(page.getByLabel('Task: '+task.name,{exact:true})).toBeChecked();await expect(page.getByLabel('Task: Record lookup',{exact:true})).not.toBeChecked();
  await page.getByRole('button',{name:'Continue to delivery',exact:true}).click();for(const name of ['BM25 search','Regex search','Code Mode','Local semantic search','Hybrid search'])await page.getByLabel('Test '+name,{exact:true}).uncheck();
  await page.getByRole('button',{name:'Continue to limits',exact:true}).click();await page.getByText('Advanced limits and repeatability',{exact:true}).click();
  await page.getByLabel('Repetitions per task and configuration',{exact:true}).fill('1');await page.getByLabel('Matched task seed',{exact:true}).fill('23091');await page.getByLabel('Maximum model turns',{exact:true}).fill('10');await page.getByLabel('Seconds per trial (including harness startup)',{exact:true}).fill('45');await page.getByLabel('Campaign time limit in seconds',{exact:true}).fill('240');
  await page.getByRole('button',{name:'Review campaign',exact:true}).click();await expect(page.getByLabel('Campaign review')).toContainText('Planned trials: 10');await page.getByRole('button',{name:'Start campaign',exact:true}).click();
  await expect.poll(()=>page.evaluate(async()=>{const snapshot=await window.harbor.diagnosticsSnapshot();return snapshot.campaign&&!snapshot.running?snapshot.campaign.status:'pending';}),{timeout:250000}).toBe('finished');
  const snapshot=await page.evaluate(()=>window.harbor.diagnosticsSnapshot());
  assert.deepEqual(fixture.errors,[]);assert.equal(snapshot.campaign.trials.length,10);assert.equal(snapshot.campaign.plan.seed,23091);
  for(const trial of snapshot.campaign.trials){assert.equal(trial.eligible,true,JSON.stringify(trial));assert.equal(trial.grade.completed,true,JSON.stringify(trial));assert.equal(trial.grade.adherent,true,JSON.stringify(trial));}
  const browser=snapshot.campaign.trials.find(trial=>trial.task==='browser-extract');assert(browser.grade.browserVersion);assert.equal(browser.grade.browserStarts,1);
  await page.getByRole('button',{name:'Inspect all / database-summary / repetition 1',exact:true}).click();await expect(page.getByLabel('Trial evidence')).toContainText('database-summary');
  await page.getByText('Saved campaigns',{exact:true}).click();await page.getByRole('button',{name:'Refresh saved campaigns',exact:true}).click();await page.getByRole('button',{name:'Open selected campaign',exact:true}).click();
  await expect(page.getByText('Saved campaign snapshot',{exact:false})).toContainText(snapshot.campaign.id);
  await app.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>({canceled:true});});await page.getByRole('button',{name:'Save campaign evidence',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Save cancelled.'})).toBeVisible();
  const exportPath=path.join(root,'export.json');await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},exportPath);await page.getByRole('button',{name:'Save campaign evidence',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Saved export.json'})).toBeVisible();
  const exported=JSON.parse(await fs.readFile(exportPath,'utf8'));assert.equal(exported.campaign.id,snapshot.campaign.id);assert.equal(exported.trials.length,10);assert(exported.trials.every(trial=>trial.trace&&trial.deliveryEvidence));
  await page.getByRole('button',{name:'Inspect all / database-summary / repetition 1',exact:true}).click();
  if(process.env.HARBOR_PHASE2_EVIDENCE){const evidence=process.env.HARBOR_PHASE2_EVIDENCE;await fs.mkdir(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,'representative-campaign-native.png'),fullPage:true});await fs.writeFile(path.join(evidence,'representative-campaign-native.json'),JSON.stringify({kind:'Deterministic protocol fixture with real filesystem/SQLite/Chromium; not model quality',campaign:snapshot.campaign,results:snapshot.results,requests:fixture.requests},null,2));}
  assert.deepEqual(errors,[]);console.log(JSON.stringify({tasks:10,accepted:snapshot.campaign.trials.filter(trial=>trial.grade.completed).length,browserVersion:browser.grade.browserVersion,toolCalls:fixture.requests.filter(request=>request.tool).length,modelQualityClaim:false}));
  const exited=new Promise(resolve=>app.process().once('exit',resolve));await app.evaluate(({app})=>{setTimeout(()=>app.quit(),0);});await exited;app=null;
  app=await electron.launch({args:['.'],env});const restarted=await app.firstWindow();await restarted.getByRole('button',{name:'Diagnostics',exact:true}).click();await restarted.getByText('Saved campaigns',{exact:true}).click();await restarted.getByRole('button',{name:'Refresh saved campaigns',exact:true}).click();await restarted.getByRole('button',{name:'Open selected campaign',exact:true}).click();await restarted.getByRole('button',{name:'Inspect all / database-summary / repetition 1',exact:true}).click();await expect(restarted.getByLabel('Trial evidence')).toContainText('database-summary');
});
