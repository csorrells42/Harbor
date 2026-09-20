import test from 'node:test';
import assert from 'node:assert/strict';
import {deliveryEvidence} from '../src/diagnostics/delivery-evidence.mjs';

test('catalog order is reported as observed, reordered or unknown at the actual model request',()=>{
  const catalog=[{name:'work__z'},{name:'work__a'}],request=names=>({sequence:1,exactDefinitions:true,definitions:names.map(name=>({function:{name}}))});
  for(const [names,expected] of [[['mcp__diagnostic__work__z','mcp__diagnostic__work__a'],true],[['mcp__diagnostic__work__a','mcp__diagnostic__work__z'],false],[['search_tools','call_tool'],null]]){
    const evidence=deliveryEvidence({catalog,modelRequests:[request(names)]});assert.equal(evidence.modelCatalogOrder[0].catalogOrderPreserved,expected);
  }
});
test('delivery evidence preserves observed ranks, actual fixture relevance and missing model visibility',()=>{
  const catalog=[{name:'read'},{name:'write'},{name:'unrelated'}],traceBundle={evicted:0,events:[{kind:'discovery',status:'completed',requestId:'one',outcome:'success',discovery:{candidateCount:2,candidates:[{name:'unrelated',rank:1},{name:'read',rank:2,sourceRanks:{bm25:2}}]}},{kind:'upstream',status:'completed',outcome:'success'}]};
  const evidence=deliveryEvidence({catalog,relevantToolNames:['read','write'],traceBundle});
  assert.equal(evidence.retrievalCoverage,0.5);assert.equal(evidence.discoveries[0].relevantCandidates[0].rank,2);assert.equal(evidence.upstreamExecutions,1);
  assert.equal(evidence.initialPresentation,null);assert.equal(evidence.perModelRequestPresentation,null);assert.equal(evidence.externalTools,'unknown');
  assert.equal(evidence.traceCoverage.complete,true);
});
test('absent discovery remains unknown and truncated traces cannot masquerade as complete coverage',()=>{
  const evidence=deliveryEvidence({catalog:[{name:'read'}],relevantToolNames:['read'],traceBundle:{evicted:2,events:[]},presentation:{source:'initial',definitions:[]}});
  assert.equal(evidence.retrievalCoverage,null);assert.equal(evidence.traceCoverage.complete,false);assert.equal(evidence.perModelRequestPresentation,null);
});
test('bounded candidate details produce only an observed lower bound, not complete retrieval coverage',()=>{
  const evidence=deliveryEvidence({catalog:[{name:'read'},{name:'write'}],relevantToolNames:['read','write'],traceBundle:{evicted:0,events:[{kind:'discovery',status:'completed',outcome:'success',discovery:{candidateCount:200,candidates:[{name:'read',rank:1},'[truncated]']}}]}});
  assert.equal(evidence.retrievalCoverage,null);assert.equal(evidence.observedRetrievalCoverage,0.5);assert.equal(evidence.traceCoverage.candidateCoverageComplete,false);
});
test('observed failure stages distinguish unavailable capabilities, invalid arguments, execution and false claims',()=>{
  const evidence=deliveryEvidence({catalog:[],relevantToolNames:['missing'],traceBundle:{evicted:0,events:[{kind:'discovery',status:'completed',outcome:'search-failure'}]},taskEvents:[{schemaValid:false},{schemaValid:true,ok:false},{schemaValid:true,ok:false,expectedFailure:true}],grade:{claimedDone:true,completed:false}});
  assert.deepEqual(evidence.observedFailureStages,['required-capability-unavailable','discovery-failure','argument-validation-failure','upstream-execution-failure','false-completion-claim']);
});
