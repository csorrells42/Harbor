// Fixture-defined relevance and observed events only. No inference about private
// model reasoning, uninstrumented request definitions or external tools.
export function deliveryEvidence({catalog,baseCatalog=null,catalogVariant=null,relevantToolNames=[],traceBundle,presentation=null,modelRequests=null,taskEvents=[],grade}){
  const relevant=new Set(relevantToolNames),available=new Set(catalog.map(tool=>tool.name));
  const events=traceBundle?.events??[],completed=events.filter(event=>event.status==='completed');
  const discoveries=completed.filter(event=>event.kind==='discovery').map(event=>({
    requestId:event.requestId,tool:event.tool,outcome:event.outcome,durationMs:event.durationMs,
    candidateCount:event.discovery?.candidateCount??null,
    relevantCandidates:Array.isArray(event.discovery?.candidates)?event.discovery.candidates.filter(candidate=>candidate&&typeof candidate==='object'&&relevant.has(candidate.name)).map(({name,rank,sourceRanks})=>({name,rank,sourceRanks})):null,
    candidates:Array.isArray(event.discovery?.candidates)?event.discovery.candidates:null,failedMethods:event.discovery?.failedMethods??null
  }));
  const known=discoveries.filter(row=>row.relevantCandidates!==null),returned=new Set(known.flatMap(row=>row.relevantCandidates.map(candidate=>candidate.name)));
  const relevantAvailable=[...relevant].filter(name=>available.has(name));
  const candidateCoverageComplete=discoveries.every(row=>row.outcome==='success'&&row.candidates!==null&&row.candidateCount===row.candidates.length&&row.candidates.every(candidate=>candidate&&typeof candidate.name==='string'&&Number.isFinite(candidate.rank)));
  const observedCoverage=known.length&&relevantAvailable.length?returned.size/relevantAvailable.length:null;
  const stages=[];
  const workflows=catalogVariant?.validWorkflows;
  const workflowAvailable=workflows?workflows.some(groups=>groups.every(names=>names.some(name=>available.has(name)))):null;
  const workflowRetrieved=workflows&&known.length?workflows.some(groups=>groups.every(names=>names.some(name=>returned.has(name)))):null;
  if(workflowAvailable===false||workflowAvailable===null&&relevantAvailable.length<relevant.size)stages.push('required-capability-unavailable');
  if(discoveries.some(row=>row.outcome!=='success'))stages.push('discovery-failure');
  if(known.some(row=>row.relevantCandidates.length===0))stages.push('discovery-with-no-relevant-result');
  if(taskEvents.some(event=>!event.schemaValid))stages.push('argument-validation-failure');
  if(taskEvents.some(event=>event.schemaValid&&!event.ok&&!event.expectedFailure))stages.push('upstream-execution-failure');
  if(grade?.claimedDone&&!grade.completed)stages.push('false-completion-claim');
  const catalogNames=catalog.map(tool=>tool.name),nameMap=new Map(catalogNames.flatMap(name=>[[name,name],['mcp__diagnostic__'+name,name],['diagnostic__'+name,name]]));
  const modelCatalogOrder=modelRequests?.map(request=>{
    const definitions=request.definitions,names=Array.isArray(definitions)?definitions.map(tool=>nameMap.get(tool.function?.name??tool.name)):[],complete=request.exactDefinitions===true&&names.length===catalogNames.length&&names.every(Boolean)&&new Set(names).size===catalogNames.length;
    return {sequence:request.sequence,completeCatalogMapping:complete,catalogOrderPreserved:complete?names.every((name,index)=>name===catalogNames[index]):null,mappedCatalogTools:names.filter(Boolean).length,unmappedDefinitions:names.filter(name=>!name).length};
  })??null;
  return {schemaVersion:2,catalog,baseCatalog,catalogVariant,workflowAvailable,workflowRetrieved:traceBundle?.evicted===0&&candidateCoverageComplete?workflowRetrieved:null,relevantToolNames:[...relevant],availableRelevantToolNames:relevantAvailable,
    initialPresentation:presentation,perModelRequestPresentation:modelRequests,modelCatalogOrder,externalTools:'unknown',
    discoveries,retrievalCoverage:traceBundle?.evicted===0&&candidateCoverageComplete?observedCoverage:null,observedRetrievalCoverage:observedCoverage,
    discoveryRequests:discoveries.length,upstreamExecutions:completed.filter(event=>event.kind==='upstream').length,
    observedFailureStages:stages,traceCoverage:{events:events.length,evicted:traceBundle?.evicted??null,complete:traceBundle?.evicted===0,candidateCoverageComplete},
    attribution:'Discovery and invocation are associated only where request nesting was observed. Per-request definitions are known only for explicitly captured outbound requests; initial harness definitions alone do not establish them.'};
}
