import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {_electron as electron,expect} from '@playwright/test';
import {CONFORMANCE_TASKS,WORKLOAD_TASKS} from '../src/diagnostics/workload-catalog.js';
import {createWorkloadModelFixture} from './fixtures/workload-model.mjs';

test('native catalog comparison preserves real outcomes and captures transformed outbound definitions',{
  skip:!process.env.HARBOR_TEST_DIAGNOSTICS_CATALOG_CAMPAIGN,timeout:300000
},async t=>{
  const installed=path.join(process.env.LOCALAPPDATA,'hermes/hermes-agent');await fs.access(path.join(installed,'venv/Scripts/python.exe'));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor catalog desktop ')),local=path.join(root,'local'),source=path.join(local,'hermes');await fs.mkdir(path.join(source,'runtimes/llamacpp'),{recursive:true});await fs.symlink(installed,path.join(source,'hermes-agent'),'junction');
  const fixture=await createWorkloadModelFixture();await fs.writeFile(path.join(source,'config.yaml'),`model:\n  provider: llamacpp\n  default: ${fixture.model}\n`);await fs.writeFile(path.join(source,'runtimes/llamacpp/server.json'),JSON.stringify({pid:process.pid,base_url:fixture.endpoint,api_key:'synthetic-only'}));
  const env={...process.env,LOCALAPPDATA:local,HARBOR_DATA_DIR:path.join(root,'profile'),HARBOR_PORT:'0'};delete env.ELECTRON_RUN_AS_NODE;delete env.HARBOR_PORTABLE_ROOT;delete env.HERMES_HOME;
  let app;t.after(async()=>{if(app){const exited=new Promise(resolve=>app.process().once('exit',resolve));await app.evaluate(({app})=>{setTimeout(()=>app.quit(),0);}).catch(()=>{});await exited;}await fixture.close();await fs.unlink(path.join(source,'hermes-agent'));assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  app=await electron.launch({args:['.'],env});const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));await expect(page.locator('#gateway-status')).toContainText('Gateway online');await page.getByRole('button',{name:'Diagnostics',exact:true}).click();await page.getByRole('button',{name:'Check Hermes',exact:true}).click();await expect(page.locator('.diag-status')).toContainText('ready to run',{timeout:30000});
  await page.getByRole('button',{name:'Continue to tasks',exact:true}).click();await page.getByText('Choose individual tasks',{exact:true}).click();
  const tasks=['document-brief','merge-csv','database-summary','dependent-report','browser-extract'];for(const task of [...CONFORMANCE_TASKS,...WORKLOAD_TASKS])await page.getByLabel('Task: '+task.name,{exact:true}).setChecked(tasks.includes(task.id));
  await page.getByRole('button',{name:'Continue to delivery',exact:true}).click();
  for(const name of ['BM25 search','Regex search','Code Mode','Local semantic search','Hybrid search'])await page.getByLabel('Test '+name,{exact:true}).uncheck();
  await page.getByText('Advanced delivery settings',{exact:true}).click();await page.getByLabel('Compare catalog variant',{exact:true}).check();await page.getByLabel('Include equivalent fixture provider',{exact:true}).check();
  for(const [title,value] of [['Candidate tool subset','workflow'],['Candidate descriptions','concise'],['Candidate schema annotations','minimal'],['Candidate catalog order','name-desc'],['Candidate preferred fixture provider','alternate']])await page.getByLabel(title,{exact:true}).selectOption(value);
  await page.getByRole('button',{name:'Continue to limits',exact:true}).click();await page.getByText('Advanced limits and repeatability',{exact:true}).click();
  await page.getByLabel('Repetitions per task and configuration',{exact:true}).fill('1');await page.getByLabel('Matched task seed',{exact:true}).fill('24091');await page.getByLabel('Maximum model turns',{exact:true}).fill('10');await page.getByLabel('Seconds per trial (including harness startup)',{exact:true}).fill('45');await page.getByLabel('Campaign time limit in seconds',{exact:true}).fill('240');
  await page.getByRole('button',{name:'Review campaign',exact:true}).click();await expect(page.getByLabel('Campaign review')).toContainText('Planned trials: 10');
  await page.getByRole('button',{name:'Start campaign',exact:true}).click();await expect.poll(()=>page.evaluate(async()=>{const snapshot=await window.harbor.diagnosticsSnapshot();return snapshot.campaign&&!snapshot.running?snapshot.campaign.status:'pending';}),{timeout:250000}).toBe('finished');
  const snapshot=await page.evaluate(()=>window.harbor.diagnosticsSnapshot());assert.deepEqual(fixture.errors,[]);assert.equal(snapshot.campaign.trials.length,10);
  for(const trial of snapshot.campaign.trials){assert.equal(trial.eligible,true,JSON.stringify(trial));assert.equal(trial.grade.completed,true,JSON.stringify(trial));assert.equal(trial.grade.adherent,true,JSON.stringify(trial));}
  assert.equal(snapshot.results.contexts.length,1);assert.equal(snapshot.results.recommendation.provisionalLeader,null);assert(snapshot.results.identityGaps.includes('Model weight identity not verified'));assert.equal(snapshot.results.recommendation.winner,null);assert.equal(snapshot.results.contrasts[0].changes.length,5);assert.match(snapshot.results.contrasts[0].interpretation,/Multiple factors/);
  for(const task of tasks){const rows=snapshot.campaign.trials.filter(row=>row.task===task);assert.equal(rows[0].baseCatalogFingerprint,rows[1].baseCatalogFingerprint);assert.notEqual(rows[0].catalogFingerprint,rows[1].catalogFingerprint);}
  const candidate=snapshot.campaign.trials.find(row=>row.task==='document-brief'&&row.configId==='all-catalog');const detail=await page.evaluate(input=>window.harbor.diagnosticsInspectTrial(input),{campaignId:snapshot.campaign.id,trialId:candidate.id});
  assert.equal(detail.deliveryEvidence.workflowAvailable,true);assert.equal(detail.deliveryEvidence.catalog.length,2);assert(detail.deliveryEvidence.perModelRequestPresentation.length>=3);
  assert.equal(candidate.deliveryObservation.catalogOrderAtModel,'reordered');assert(detail.deliveryEvidence.modelCatalogOrder.every(row=>row.catalogOrderPreserved===false));
  for(const request of detail.deliveryEvidence.perModelRequestPresentation){assert(request.exactDefinitions);assert(request.definitions.every(tool=>tool.function.name.includes('work_alternate__')));const read=request.definitions.find(tool=>tool.function.name.endsWith('__fs_read'));assert(!read.function.parameters.properties.path.description);}
  assert(fixture.requests.some(request=>request.advertisedName?.includes('work_alternate__')));assert.deepEqual(errors,[]);
  await page.getByRole('button',{name:'Inspect all-catalog / document-brief / repetition 1',exact:true}).click();await expect(page.getByLabel('Trial evidence')).toContainText('document-brief');
  if(process.env.HARBOR_PHASE2_EVIDENCE){const evidence=process.env.HARBOR_PHASE2_EVIDENCE;await fs.mkdir(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,'catalog-comparison-native.png'),fullPage:true});await fs.writeFile(path.join(evidence,'catalog-comparison-native.json'),JSON.stringify({kind:'Deterministic protocol fixture; multi-factor contract acceptance, not model-quality attribution',campaign:snapshot.campaign,results:snapshot.results,requests:fixture.requests,candidateDetail:detail},null,2));}
  console.log(JSON.stringify({trials:10,completed:10,changedFactors:5,toolCalls:fixture.requests.filter(request=>request.tool).length,alternateInvocations:fixture.requests.filter(request=>request.advertisedName?.includes('work_alternate__')).length,modelQualityClaim:false}));
});
