const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
const percentile=(xs,p)=>xs.length?[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*p)-1]:null;
export function wilson(successes,n){if(!n)return null;const z=1.96,p=successes/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,r=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/d;return [Math.max(0,c-r),Math.min(1,c+r)];}
export function summarize(rows) {
  const eligible=rows.filter(r=>r.eligible),completed=eligible.filter(r=>r.grade.completed),n=eligible.length;
  return {trials:rows.length,eligible:n,excluded:rows.length-n,verifiedCompletion:mean(eligible.map(r=>+r.grade.completed)),completion95:wilson(completed.length,n),acceptance:mean(eligible.map(r=>+r.grade.accepted)),adherence:mean(eligible.map(r=>+r.grade.adherent)),toolCorrectness:mean(eligible.map(r=>r.grade.toolCorrect).filter(x=>x!=null)),argumentCorrectness:mean(eligible.map(r=>r.argumentCorrectness).filter(x=>x!=null)),falseCompletionClaims:eligible.filter(r=>r.grade.claimedDone&&!r.grade.completed).length,successMedianMs:percentile(completed.map(r=>r.elapsedMs),0.5),successP95Ms:percentile(completed.map(r=>r.elapsedMs),0.95),allTrialsMedianMs:percentile(eligible.map(r=>r.elapsedMs),0.5),timeouts:rows.filter(r=>r.status==='timeout').length,cancellations:rows.filter(r=>r.status==='cancelled').length,endedWithoutCompletion:eligible.filter(r=>r.status==='finished'&&!r.grade.completed).length,failures:rows.filter(r=>r.status==='infrastructure-error').length,resourceLimitStops:rows.filter(r=>r.status==='resource-limit').length,
    toolSelectionObserved:eligible.filter(r=>r.grade.toolCorrect!=null).length,argumentCorrectnessObserved:eligible.filter(r=>r.argumentCorrectness!=null).length};
}
export function compare(rows) {
  const group=key=>Object.entries(Object.groupBy(rows,r=>r[key])).map(([id,rs])=>({id,...summarize(rs)}));
  const configs=group('configId');
  // Compare Harbor variants only within one fully identified, fixed setup.
  // Combining identical mixtures of multiple models/harnesses is still not a
  // fixed-setup campaign and cannot produce a recommendation.
  const eligible=rows.filter(r=>r.eligible),groups=Object.groupBy(eligible,r=>r.configId);
  const contextFields=['harnessId','modelId','hardwareId','harborFingerprint','suite','backendId','inferenceId'];
  const context=r=>contextFields.map(key=>r[key]??null);
  const contexts=[...new Map(rows.map(row=>[JSON.stringify(context(row)),Object.fromEntries(contextFields.map(key=>[key,row[key]??null]))])).values()];
  const identified=rows.every(row=>[...contextFields,'taskSeed','catalogFingerprint'].every(key=>typeof row[key]==='string'&&row[key].length>0));
  const signatures=Object.values(groups).map(rs=>JSON.stringify(rs.map(r=>JSON.stringify([r.task,r.repetition,r.taskSeed,r.baseCatalogFingerprint??r.catalogFingerprint])).sort()));
  const uniqueBlocks=Object.values(groups).every(rs=>new Set(rs.map(r=>JSON.stringify([r.task,r.repetition]))).size===rs.length);
  const stableSettings=Object.values(groups).every(rs=>rs.every(r=>r.settings&&typeof r.settings==='object')&&new Set(rs.map(r=>JSON.stringify([Object.entries(r.settings).sort(([a],[b])=>a.localeCompare(b)),r.catalogVariant?.options??null,r.catalogVariant?.overlapProviders??null]))).size===1);
  // A changed effective catalog is comparable only with an explicit validated
  // transformation and stable effective identity for each task within a variant.
  const catalogValid=rows.every(row=>!row.baseCatalogFingerprint||row.catalogVariant?.workflowPreserved===true&&row.catalogVariant?.baseCatalogFingerprint===row.baseCatalogFingerprint&&row.catalogVariant?.catalogFingerprint===row.catalogFingerprint);
  const catalogStable=Object.values(groups).every(rs=>Object.values(Object.groupBy(rs,row=>row.task)).every(taskRows=>new Set(taskRows.map(row=>row.catalogFingerprint)).size===1));
  const setupVerified=rows.every(row=>row.setupIdentity?.comparisonReady===true&&!row.setupIdentity.drift),identityGaps=[...new Set(rows.flatMap(row=>row.setupIdentity?.gaps??['Saved evidence predates complete setup identity checks']))];
  const comparable=identified&&setupVerified&&contexts.length===1&&uniqueBlocks&&stableSettings&&catalogValid&&catalogStable&&configs.length>1&&configs.every(c=>c.eligible>=5&&c.excluded===0)&&new Set(signatures).size===1;
  const ranked=comparable?[...configs].sort((a,b)=>b.verifiedCompletion-a.verifiedCompletion||b.adherence-a.adherence||(a.successMedianMs??Infinity)-(b.successMedianMs??Infinity)):[];
  const winner=ranked.length>1&&ranked[0].completion95[0]>Math.max(...ranked.slice(1).map(c=>c.completion95[1]))?ranked[0].id:null;
  const baselineId=configs.some(row=>row.id==='all')?'all':configs.map(row=>row.id).sort()[0],baseline=rows.find(row=>row.configId===baselineId);
  const factors=row=>({...row?.settings,...Object.fromEntries(Object.entries(row?.catalogVariant?.options??{}).map(([key,value])=>['catalog.'+key,value]))});
  const baselineFactors=factors(baseline),contrasts=configs.filter(row=>row.id!==baselineId).map(({id})=>{
    const next=factors(rows.find(row=>row.configId===id)),changes=[...new Set([...Object.keys(baselineFactors),...Object.keys(next)])].sort().filter(key=>JSON.stringify(baselineFactors[key])!==JSON.stringify(next[key])).map(factor=>({factor,before:baselineFactors[factor]??null,after:next[factor]??null}));
    return {baseline:baselineId,variant:id,changes,interpretation:changes.length>1?'Multiple factors changed; outcomes cannot be attributed to one setting':changes.length===1?'One declared delivery factor changed':'No declared delivery-factor difference'};
  });
  const reason=contexts.length>1?'Multiple setup contexts are present; compare each fixed harness/model setup separately.':(!identified||!setupVerified)&&rows.length?'Setup identity is incomplete or unverified; no recommendation.':!uniqueBlocks?'Duplicate task/repetition evidence; no recommendation.':!stableSettings?'A variant changed settings within this campaign; no recommendation.':!catalogValid||!catalogStable?'Catalog transformation evidence is missing or changed within a variant; no recommendation.':!comparable?'Insufficient matched trials; no recommendation.':winner?'Completion intervals separate on this tested workload and fixed setup.':'Matched trials available, but uncertainty overlaps; no confirmed winner.';
  return {configurations:configs,contexts,contrasts,identityGaps,recommendation:{winner,provisionalLeader:ranked[0]?.id??null,reason},scope:'Observed Harbor delivery variants within the identified harness, model, inference configuration, task suite and hardware. Separate setups are not ranked against one another. Missing setup evidence prevents recommendations without erasing independently verified task outcomes.'};
}
