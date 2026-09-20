import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createCampaignArchive} from '../src/diagnostics/archive.mjs';

async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor saved campaigns '));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));return root;}
async function saved(root,{status='finished',trials=[],...fields}={}){const campaign={id:randomUUID(),createdAt:new Date().toISOString(),status,plannedTrials:trials.length,trials,...fields};await fs.mkdir(path.join(root,campaign.id));await fs.writeFile(path.join(root,campaign.id,'campaign.json'),JSON.stringify(campaign));return campaign;}

test('archive pages campaign summaries, leaves unreadable runs visible and labels abandoned work',async t=>{
  const root=await fixture(t),archive=createCampaignArchive(root);
  const running=await saved(root,{status:'running'});
  for(let i=0;i<25;i++)await saved(root);
  const broken=await saved(root);await fs.writeFile(path.join(root,broken.id,'campaign.json'),'not JSON');
  const first=await archive.list(),second=await archive.list({page:1});assert.equal(first.total,27);assert.equal(first.items.length,25);assert.equal(second.items.length,2);
  const all=[...first.items,...second.items];assert.equal(new Set(all.map(row=>row.id)).size,27);assert.equal(all.find(row=>row.id===broken.id).status,'unreadable');
  assert.equal((await archive.inspect(running.id)).campaign.status,'interrupted');
  assert.equal((await createCampaignArchive(root,{liveCampaign:()=>running}).inspect(running.id)).campaign.status,'running');
  await assert.rejects(archive.list({page:-1}),/valid campaign page/);await assert.rejects(archive.inspect('../../outside'),/Choose/);
});

test('export contains full recorded evidence and rejects missing, mismatched or oversized records',async t=>{
  const root=await fixture(t),archive=createCampaignArchive(root),trialId=randomUUID();
  const summary={id:trialId,task:'lookup',configId:'all',eligible:false,status:'cancelled',grade:{completed:false}},campaign=await saved(root,{trials:[summary],plan:{seed:52}});
  const dir=path.join(root,campaign.id,trialId);await fs.mkdir(dir);const file=path.join(dir,'result.json');
  const detail={...summary,trace:{events:[{kind:'upstream',outcome:'cancelled'}]},deliveryEvidence:{catalog:[{name:'known'}]}};await fs.writeFile(file,JSON.stringify(detail));
  const bundle=JSON.parse(await archive.export(campaign.id));assert.equal(bundle.campaign.plan.seed,52);assert.deepEqual(bundle.trials[0],detail);assert.equal(bundle.results.configurations[0].eligible,0);
  await assert.rejects(archive.trial({campaignId:campaign.id,trialId:randomUUID()}),/does not belong/);
  await fs.writeFile(file,JSON.stringify({...detail,id:randomUUID()}));await assert.rejects(archive.export(campaign.id),/identity/);
  await fs.writeFile(file,'x'.repeat(16*1024*1024+1));await assert.rejects(archive.export(campaign.id),/16 MiB/);
  await fs.unlink(file);await assert.rejects(archive.export(campaign.id),/ENOENT/);
  await fs.writeFile(path.join(root,campaign.id,'campaign.json'),JSON.stringify({...campaign,id:randomUUID()}));await assert.rejects(archive.inspect(campaign.id),/identity/);
});
