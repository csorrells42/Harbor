import test from 'node:test';
import assert from 'node:assert/strict';
import {assessAdvice,createAdviceReviews} from '../src/diagnostics/advice.mjs';
import {DEFAULT_SETTINGS} from '../src/core/settings.mjs';
import {CATALOG_DEFAULTS} from '../src/diagnostics/catalog-options.js';

function evidence(){
  const trials=[];
  for(const configId of ['all','bm25'])for(let repetition=0;repetition<10;repetition++)for(const task of ['a','b','c','d']){
    const completed=configId==='bm25'||repetition<2;
    trials.push({configId,task,repetition,taskSeed:task+repetition,eligible:true,status:'finished',elapsedMs:configId==='all'?100:200,
      harnessId:'harness',modelId:'model',hardwareId:'hardware',harborFingerprint:'source',suite:'suite',backendId:'backend',inferenceId:'inference',catalogFingerprint:'catalog-'+task,
      settings:{...DEFAULT_SETTINGS,toolMode:configId},setupIdentity:{comparisonReady:true,drift:false,gaps:[]},
      grade:{completed,adherent:completed,accepted:true,claimedDone:completed,toolCorrect:1}});
  }
  return {campaign:{id:'campaign',status:'finished',plannedTrials:80,createdAt:'fixture-date',trials},current:{backendId:'backend',hardwareId:'hardware',harborFingerprint:'source',suite:'suite'}};
}
function controller(options={}){
  const state={evidence:evidence(),profile:{id:'coding',name:'Coding',revision:1,serverIds:['files'],delivery:{...DEFAULT_SETTINGS,portkeyApiKeyFile:'existing-secret-reference'}},catalog:[{name:'read',inputSchema:{type:'object'}}],saves:[],receipts:[],clock:1000};
  const api=createAdviceReviews({refreshEvidence:async()=>structuredClone(state.evidence),getProfile:async()=>structuredClone(state.profile),getCatalog:async()=>structuredClone(state.catalog),
    saveProfile:async(profile,{expectedRevision})=>{assert.equal(expectedRevision,state.profile.revision);state.saves.push(structuredClone(profile));state.profile={...profile,revision:expectedRevision+1};return structuredClone(state.profile);},
    saveReceipt:async value=>state.receipts.push(value),now:()=>state.clock,...options});return {state,api};
}
const selection={campaignId:'campaign',profileId:'coding'};

test('measured advice requires complete, positively identified, current and statistically separated evidence',()=>{
  const valid=evidence(),report=assessAdvice(valid);assert.equal(report.status,'ready');assert.equal(report.winner,'bm25');
  assert.equal(report.tradeoffs.candidate.successMedianMs,200,'Slower correct work can win over faster incorrect work');
  for(const field of ['backendId','hardwareId','harborFingerprint','suite']){const input=evidence();input.current[field]='changed';assert.equal(assessAdvice(input).status,'stale');}
  for(const change of [x=>delete x.current,x=>x.campaign.status='interrupted',x=>x.campaign.trials.pop(),x=>x.campaign.trials.forEach(r=>r.setupIdentity.comparisonReady=false),x=>x.campaign.trials.forEach(r=>{r.grade.completed=true;r.grade.adherent=true;})]){
    const input=evidence();change(input);assert.equal(assessAdvice(input).status,'insufficient');
  }
});

test('aggregate completion cannot hide task/adherence regressions or unsupported catalog changes',()=>{
  const regression=evidence();for(const row of regression.campaign.trials){row.grade.completed=row.configId==='bm25'?row.task!=='a':row.task==='a';row.grade.adherent=row.grade.completed;}
  assert.equal(assessAdvice(regression).status,'insufficient');assert.deepEqual(assessAdvice(regression).regressionTasks,['a']);
  const adherence=evidence();for(const row of adherence.campaign.trials)if(row.configId==='bm25')row.grade.adherent=false;
  assert.equal(assessAdvice(adherence).status,'insufficient');
  const catalog=evidence();for(const row of catalog.campaign.trials)if(row.configId==='bm25')row.catalogVariant={options:{...CATALOG_DEFAULTS,descriptions:'concise'}};
  assert.equal(assessAdvice(catalog).status,'unsupported');
});

test('explicit review applies only measured delivery fields, preserves credentials and retains no history by default',async()=>{
  const {state,api}=controller();const preview=await api.preview(selection);
  assert.equal(state.saves.length,0);assert.deepEqual(preview.changes.map(c=>c.field),['toolMode']);assert.equal(preview.retainHistory,false);
  const result=await api.apply(preview.token);assert.equal(result.applied,true);assert.equal(result.revision,2);assert.equal(result.retainedHistory,false);
  assert.equal(state.profile.delivery.toolMode,'bm25');assert.equal(state.profile.delivery.portkeyApiKeyFile,'existing-secret-reference');assert.deepEqual(state.profile.serverIds,['files']);assert.equal(state.receipts.length,0);
  await assert.rejects(api.apply(preview.token),/already used/);assert.equal(state.saves.length,1);await api.close();
});

test('profile, catalog and evidence drift invalidate one-use reviews before saving',async()=>{
  for(const change of [s=>s.profile.revision++,s=>s.profile.delivery.searchLimit++,s=>s.catalog.push({name:'new-tool'}),s=>s.evidence.current.backendId='other-model',s=>s.evidence.campaign.trials[0].elapsedMs++]){
    const {state,api}=controller();const preview=await api.preview(selection);change(state);await assert.rejects(api.apply(preview.token),/changed/);assert.equal(state.saves.length,0);await assert.rejects(api.apply(preview.token),/already used/);await api.close();
  }
});

test('review expiry, replacement and concurrent duplicate applies cannot duplicate writes',async()=>{
  const {state,api}=controller();const first=await api.preview(selection),second=await api.preview(selection);await assert.rejects(api.apply(first.token),/expired/);
  state.clock=second.expiresAt;await assert.rejects(api.apply(second.token),/expired/);
  const current=await api.preview(selection),results=await Promise.allSettled([api.apply(current.token),api.apply(current.token)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(state.saves.length,1);await api.close();
});

test('history is opt-in and a receipt failure never retries or rolls back a committed profile',async()=>{
  const retained=controller(),review=await retained.api.preview({...selection,retainHistory:true});await retained.api.apply(review.token);assert.equal(retained.state.receipts.length,1);assert.deepEqual(retained.state.receipts[0].changes,[{field:'toolMode',before:'all',after:'bm25'}]);await retained.api.close();
  const failed=controller({saveReceipt:async()=>{throw Error('disk unavailable');}}),next=await failed.api.preview({...selection,retainHistory:true});const result=await failed.api.apply(next.token);assert.equal(result.applied,true);assert.equal(result.retainedHistory,false);assert.match(result.historyError,/was saved/);assert.equal(failed.state.saves.length,1);await failed.api.close();
});

test('closing drains accepted apply work and rejects pending evidence reviews',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve),{state,api}=controller({refreshEvidence:async()=>{await gate;return evidence();}});
  const pending=api.preview(selection);await api.close();release();await assert.rejects(pending,/closed/);assert.equal(state.saves.length,0);
  const other=controller();await assert.rejects(other.api.preview({...selection,profileId:'default'}),/named profile/);await assert.rejects(other.api.preview({...selection,retainHistory:'yes'}),/history/);await other.api.close();
});
