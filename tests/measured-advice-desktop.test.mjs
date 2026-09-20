import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {_electron as electron,expect} from '@playwright/test';

test('native Advisor reads real saved evidence, withholds unsupported advice and clears only opted-in history',{skip:!process.env.HARBOR_TEST_ADVICE_DESKTOP,timeout:60000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor advice desktop ')),campaignId='11111111-2222-4333-8444-555555555555';
  const campaignDir=path.join(dir,'diagnostics',campaignId);await fs.mkdir(campaignDir,{recursive:true});
  await fs.writeFile(path.join(campaignDir,'campaign.json'),JSON.stringify({id:campaignId,status:'interrupted',createdAt:new Date().toISOString(),plannedTrials:16,trials:[],inventory:{model:'Explicit incomplete acceptance fixture'}}));
  await fs.writeFile(path.join(dir,'advice-history.json'),JSON.stringify({schemaVersion:1,receipts:[{appliedAt:new Date().toISOString(),campaignId,evidenceFingerprint:'a'.repeat(64),profileId:'coding',previousRevision:1,revision:2,changes:[{field:'toolMode',before:'all',after:'bm25'}]}]}));
  const env={...process.env,HARBOR_DATA_DIR:dir,HARBOR_PORT:'0'};delete env.HARBOR_PORTABLE_ROOT;delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({args:[path.resolve(fileURLToPath(new URL('..',import.meta.url)))],env});
  t.after(async()=>{const child=app.process(),exited=new Promise(resolve=>child.once('exit',resolve));await app.evaluate(({app})=>{setTimeout(()=>app.quit(),0);});await exited;assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const page=await app.firstWindow(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));await expect(page.locator('#gateway-status')).toContainText('Gateway online');
  await page.evaluate(()=>window.harbor.saveProfile({id:'advice-fixture',name:'Advice acceptance',serverIds:[],isolation:'shared',delivery:{toolMode:'all'}}));
  const before=await page.evaluate(async()=>({settings:await window.harbor.getSettings(),profiles:await window.harbor.getProfiles()}));
  await page.getByRole('button',{name:'Advisor',exact:true}).click();await page.getByText('Measured configuration advice',{exact:true}).click();await page.getByRole('button',{name:'Load saved evidence',exact:true}).click();
  await expect(page.getByLabel('Advice campaign')).toContainText('Explicit incomplete acceptance fixture');await page.getByRole('button',{name:'Check this campaign',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Not enough evidence',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Review profile change',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Apply reviewed change',exact:true})).toBeDisabled();
  await page.getByText('Optional configuration history',{exact:true}).click();await page.getByRole('button',{name:'Refresh configuration history',exact:true}).click();await expect(page.getByText('1 retained changes · limit 50',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Clear configuration history',exact:true}).click();await expect(page.getByText('0 retained changes · limit 50',{exact:true})).toBeVisible();assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'advice-history.json'),'utf8')).receipts,[]);
  assert.deepEqual(await page.evaluate(()=>window.harbor.getSettings()),before.settings);assert.deepEqual((await page.evaluate(()=>window.harbor.getProfiles())).profiles,before.profiles.profiles);
  const diagnostics=await page.evaluate(()=>window.harbor.diagnosticsSnapshot());assert.equal(diagnostics.running,false);assert.equal(diagnostics.inventory,null,'An incomplete campaign must not probe or activate a model');
  if(process.env.HARBOR_PHASE2_EVIDENCE){await fs.mkdir(process.env.HARBOR_PHASE2_EVIDENCE,{recursive:true});await page.locator('#content').evaluate(node=>node.scrollTop=0);await page.screenshot({path:path.join(process.env.HARBOR_PHASE2_EVIDENCE,'measured-advice-native.png'),fullPage:true});}
  assert.deepEqual(errors,[]);
});
