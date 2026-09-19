const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
const percentile=(xs,p)=>xs.length?[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*p)-1]:null;
export function wilson(successes,n){if(!n)return null;const z=1.96,p=successes/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,r=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/d;return [Math.max(0,c-r),Math.min(1,c+r)];}
export function summarize(rows) {
  const eligible=rows.filter(r=>r.eligible),completed=eligible.filter(r=>r.grade.completed),n=eligible.length;
  return {trials:rows.length,eligible:n,excluded:rows.length-n,verifiedCompletion:mean(eligible.map(r=>+r.grade.completed)),completion95:wilson(completed.length,n),acceptance:mean(eligible.map(r=>+r.grade.accepted)),adherence:mean(eligible.map(r=>+r.grade.adherent)),toolCorrectness:mean(eligible.map(r=>r.grade.toolCorrect).filter(x=>x!=null)),argumentCorrectness:mean(eligible.map(r=>r.argumentCorrectness).filter(x=>x!=null)),falseCompletionClaims:eligible.filter(r=>r.grade.claimedDone&&!r.grade.completed).length,successMedianMs:percentile(completed.map(r=>r.elapsedMs),0.5),successP95Ms:percentile(completed.map(r=>r.elapsedMs),0.95),allTrialsMedianMs:percentile(eligible.map(r=>r.elapsedMs),0.5),timeouts:rows.filter(r=>r.status==='timeout').length,endedWithoutCompletion:eligible.filter(r=>r.status==='finished'&&!r.grade.completed).length,failures:rows.filter(r=>r.status==='infrastructure-error').length,resourceLimitStops:rows.filter(r=>r.status==='resource-limit').length};
}
export function compare(rows) {
  const group=key=>Object.entries(Object.groupBy(rows,r=>r[key])).map(([id,rs])=>({id,...summarize(rs)}));
  const configs=group('configId');
  // Rank only identical task/repeat blocks, pairing, hardware, and observed evidence coverage.
  const eligible=rows.filter(r=>r.eligible),groups=Object.groupBy(eligible,r=>r.configId);
  const signatures=Object.values(groups).map(rs=>JSON.stringify(rs.map(r=>`${r.harnessId}|${r.modelId}|${r.hardwareId}|${r.task}|${r.repetition}`).sort()));
  const comparable=configs.length>1&&configs.every(c=>c.eligible>=5&&c.excluded===0)&&new Set(signatures).size===1;
  const ranked=comparable?[...configs].sort((a,b)=>b.verifiedCompletion-a.verifiedCompletion||b.adherence-a.adherence||(a.successMedianMs??Infinity)-(b.successMedianMs??Infinity)):[];
  const winner=ranked.length>1&&ranked[0].completion95[0]>Math.max(...ranked.slice(1).map(c=>c.completion95[1]))?ranked[0].id:null;
  return {configurations:configs,models:group('modelId'),harnesses:group('harnessId'),combinations:group('combinationId'),recommendation:{winner,provisionalLeader:ranked[0]?.id??null,reason:!comparable?'Insufficient matched trials; no recommendation.':winner?'Completion intervals separate on the tested workload and hardware.':'Matched trials available, but uncertainty overlaps; no confirmed winner.'},scope:'Observed synthetic tasks on this hardware only. Model/harness effects cannot be isolated without crossing those factors.'};
}
