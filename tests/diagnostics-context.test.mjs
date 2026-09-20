import test from 'node:test';
import assert from 'node:assert/strict';
import {compare} from '../src/diagnostics/grading.mjs';
const rows=()=>['all','search'].flatMap(configId=>Array.from({length:8},(_,repetition)=>({configId,settings:{toolMode:configId==='all'?'all':'bm25'},harnessId:'fixed-harness',backendId:'verified-backend',inferenceId:'verified-inference',setupIdentity:{comparisonReady:true,drift:false,gaps:[]},modelId:'fixed-model-and-inference',hardwareId:'fixed-hardware',harborFingerprint:'source',suite:'suite-1',task:'lookup',taskSeed:'seed-'+repetition,catalogFingerprint:'catalog',repetition,eligible:true,status:'finished',elapsedMs:100,grade:{completed:configId==='search',adherent:true,accepted:true,claimedDone:configId==='search',toolCorrect:1}})));
test('only Harbor delivery variants are ranked within a fully identified fixed setup',()=>{
  const result=compare(rows());assert.equal(result.recommendation.winner,'search');assert.equal(result.contexts.length,1);
  for(const field of ['models','harnesses','combinations'])assert(!Object.hasOwn(result,field));
});
test('matched mixtures of different setups cannot create a winner or provisional leader',()=>{
  for(const field of ['harnessId','modelId','hardwareId','harborFingerprint','suite']){
    const mixed=rows().map(row=>({...row,[field]:row.repetition%2?'other':row[field]})),result=compare(mixed);
    assert.equal(result.recommendation.winner,null);assert.equal(result.recommendation.provisionalLeader,null);assert.match(result.recommendation.reason,/Multiple setup/);
  }
});
test('missing identity, duplicate blocks, changed settings and unmatched coverage fail comparison eligibility',()=>{
  const cases=[rows().map(({suite,...row})=>row),[...rows(),...rows()],rows().map(row=>({...row,settings:{toolMode:'all',searchLimit:row.repetition}})),rows().slice(1),rows().map(row=>({...row,taskSeed:row.configId+row.taskSeed})),rows().map(row=>({...row,catalogFingerprint:row.configId+row.catalogFingerprint}))];
  for(const sample of cases){const result=compare(sample);assert.equal(result.recommendation.winner,null);assert.equal(result.recommendation.provisionalLeader,null);}
});

test('declared catalog variants compare against a shared source catalog while unexplained drift fails closed',()=>{
  const sample=rows().map(row=>({...row,catalogFingerprint:'effective-'+row.configId,baseCatalogFingerprint:'same-source',catalogVariant:{workflowPreserved:true,baseCatalogFingerprint:'same-source',catalogFingerprint:'effective-'+row.configId,overlapProviders:true,options:{subset:row.configId==='all'?'all':'workflow',descriptions:'original'}}}));
  const result=compare(sample);assert.equal(result.recommendation.winner,'search');assert.equal(result.contrasts[0].changes.length,2);assert.match(result.contrasts[0].interpretation,/Multiple factors/);
  for(const changed of [sample.map(({catalogVariant,...row})=>row),sample.map(row=>({...row,catalogFingerprint:row.catalogFingerprint+row.repetition})),sample.map(row=>({...row,catalogVariant:{...row.catalogVariant,options:{...row.catalogVariant.options,order:String(row.repetition)}}}))])assert.equal(compare(changed).recommendation.provisionalLeader,null);
});

test('older saved rows cannot regain recommendations without the newly required setup evidence',()=>{
  const old=rows().map(({setupIdentity,...row})=>row),result=compare(old);assert.equal(result.configurations.find(row=>row.id==='search').verifiedCompletion,1);assert.equal(result.recommendation.provisionalLeader,null);assert.equal(result.recommendation.winner,null);assert(result.identityGaps.includes('Saved evidence predates complete setup identity checks'));
  for(const field of ['backendId','inferenceId'])assert.equal(compare(rows().map(row=>({...row,[field]:row.repetition%2?'changed':row[field]}))).recommendation.provisionalLeader,null);
});
