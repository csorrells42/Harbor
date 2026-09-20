import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setupIdentity} from '../src/diagnostics/setup-identity.mjs';
import {createDiagnostics} from '../src/diagnostics/service.mjs';

const baseline={fingerprint:'source',runtimeVersions:Object.fromEntries(['python','mcp','mcp-types','openai','httpx','httpx2','jsonschema','pydantic','PyYAML','psutil'].map(key=>[key,'test-version'])),model:'fixture-model',provider:'llamacpp',reasoning:'high',configuredContextLength:4096,endpoint:'http://127.0.0.1:1234/v1',modelServerIdentity:{pid:42,startedAt:123,endpointOwned:true,runtimeKind:'llama.cpp'},modelEvidence:{weightsFingerprint:'a'.repeat(64),contextLength:4096,serverSettingsFingerprint:'b'.repeat(64)}};
Object.assign(baseline.modelEvidence,{verification:'gguf-bytes-and-live-props-v1',files:[{bytes:1024,sha256:'d'.repeat(64),gguf:{'general.file_type':7}}],runtimeSha256:'e'.repeat(64),modelProcess:{pid:43,startedAt:124},gaps:[]});
const request={type:'model-request',sequence:1,parameters:{model:'fixture-model',temperature:0.2,max_tokens:2048},exactParameters:true,parameterFingerprint:'c'.repeat(64)};
const evaluate=options=>setupIdentity({baseline,ready:structuredClone(baseline),end:structuredClone(baseline),events:[request],...options});

test('comparison readiness requires positive setup and request evidence rather than a model name',()=>{
  const verified=evaluate();assert.equal(verified.comparisonReady,true);assert.equal(verified.drift,false);assert.equal(verified.requestedParameters[0].parameters.top_p,null);
  for(const overrides of [{modelEvidence:null},{modelServerIdentity:{...baseline.modelServerIdentity,endpointOwned:null}},{runtimeVersions:{python:'version',mcp:null}},{modelEvidence:{...baseline.modelEvidence,contextLength:null}},{modelEvidence:{...baseline.modelEvidence,serverSettingsFingerprint:null}}]){const value={...baseline,...overrides},result=evaluate({baseline:value,ready:value,end:value});assert.equal(result.comparisonReady,false);assert(result.gaps.length);assert.equal(result.drift,false);}
  for(const options of [{ready:null},{end:null},{events:[]},{events:[{...request,exactParameters:false}]},{events:[request,{...request,sequence:3}]},{eventsTruncated:true}])assert.equal(evaluate(options).comparisonReady,false);
  const unverified={...baseline,modelEvidence:{...baseline.modelEvidence,verification:undefined}};assert.equal(evaluate({baseline:unverified,ready:unverified,end:unverified}).comparisonReady,false,'Digest-shaped strings without file/runtime provenance are insufficient');
});

test('runtime, process lifetime, context, weight and opaque request-control changes invalidate a trial',()=>{
  for(const [key,value] of [['runtimeVersions',{python:'changed'}],['modelServerIdentity',{...baseline.modelServerIdentity,startedAt:456}],['configuredContextLength',8192],['modelEvidence',{...baseline.modelEvidence,weightsFingerprint:'d'.repeat(64)}]]){const result=evaluate({end:{...baseline,[key]:value}});assert.equal(result.drift,true);assert(result.changedFields.includes('end.'+(key==='modelServerIdentity'?'modelServer':key)));assert.equal(result.comparisonReady,false);}
  for(const changed of [{...request,sequence:2,parameters:{...request.parameters,temperature:0.7}},{...request,sequence:2,parameterFingerprint:'e'.repeat(64)}])assert(evaluate({events:[request,changed]}).changedFields.includes('outbound.inferenceParameters'));
  assert.equal(evaluate({events:[request,{...request,sequence:2,definitions:[{function:{name:'another-tool'}}]}]}).drift,false,'Tool definitions are the delivery treatment, not inference settings');
});

test('observed end-of-trial drift is saved, excluded and stops subsequent trials',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor setup drift '));let dispatches=0;
  const inventory={...baseline,revision:'test',hardware:{gpus:null}};
  const diagnostics=await createDiagnostics({dataDir:root,adapter:{probe:async()=>inventory,run:async(_request,{onEvent})=>{dispatches++;onEvent({type:'ready',inventory});return {status:'finished',events:[request,{type:'identity-end',inventory:{...inventory,modelServerIdentity:{...inventory.modelServerIdentity,startedAt:456}}}],result:{finalResponse:'{"status":"blocked","reason":"unavailable"}',harnessCompleted:true}};}}});
  t.after(async()=>{await diagnostics.close();await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  await diagnostics.start({tasks:['unavailable'],variants:[{id:'all',toolMode:'all'}],repetitions:2});const snapshot=await diagnostics.wait();assert.equal(dispatches,1);assert.equal(snapshot.campaign.status,'stopped');const row=snapshot.campaign.trials[0];assert.equal(row.status,'configuration-drift');assert.equal(row.eligible,false);assert.equal(row.grade.completed,true,'Verified outcome remains visible despite exclusion');assert.match(row.error,/end.modelServer/);assert.equal(snapshot.results.recommendation.provisionalLeader,null);assert.equal((await diagnostics.inspectTrial({campaignId:snapshot.campaign.id,trialId:row.id})).setupIdentity.drift,true);
});
