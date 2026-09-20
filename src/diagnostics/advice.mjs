import {createHash,randomUUID} from 'node:crypto';
import {compare,summarize} from './grading.mjs';
import {CATALOG_DEFAULTS} from './catalog-options.js';

export const ADVICE_FIELDS=Object.freeze(['toolMode','hybridModes','searchLimit','semanticMinScore','portkeyLocalModel']);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value??null;
export const adviceFingerprint=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const delivery=settings=>Object.fromEntries(ADVICE_FIELDS.map(key=>[key,structuredClone(settings[key])]));
const identityFields=['backendId','hardwareId','harborFingerprint','suite'];

// Advice is a separate consumer of diagnostic evidence. Static toolbox rules
// neither create measured evidence nor override an inconclusive comparison.
export function assessAdvice({campaign,current}={}){
  const rows=campaign?.trials??[],comparison=compare(rows),reasons=[];
  const report={status:'insufficient',campaignId:campaign?.id??null,createdAt:campaign?.createdAt??null,comparison,taskIds:[...new Set(rows.map(row=>row.task))],observations:rows.length,winner:null,delivery:null,reasons,
    scope:'Harbor delivery settings on the recorded synthetic tasks and fixed harness/model setup. Applying them to another tool catalog is a transfer that requires its own validation.',
    setup:campaign?.inventory?{harness:campaign.inventory.harness,revision:campaign.inventory.revision,model:campaign.inventory.model,provider:campaign.inventory.provider,reasoning:campaign.inventory.reasoning,hardware:campaign.inventory.hardware}:null};
  if(!campaign||campaign.status!=='finished'||rows.length!==campaign.plannedTrials){reasons.push('A complete campaign is required.');return report;}
  if(!current||identityFields.some(key=>typeof current[key]!=='string'||!current[key])){reasons.push(comparison.recommendation.winner?'Recheck the current model, runtime and hardware before reviewing advice.':comparison.recommendation.reason);return report;}
  const changed=identityFields.filter(key=>rows.some(row=>row[key]!==current[key]));
  if(changed.length){report.status='stale';reasons.push('Evidence is stale: '+changed.join(', ')+'. Rerun or revalidate the diagnostics.');return report;}
  const winner=comparison.recommendation.winner;
  if(!winner){reasons.push(comparison.recommendation.reason);return report;}
  const chosen=rows.filter(row=>row.configId===winner),baselineId=comparison.configurations.some(row=>row.id==='all')?'all':comparison.configurations.map(row=>row.id).sort()[0];
  const baseline=rows.filter(row=>row.configId===baselineId),selectedSummary=summarize(chosen),baselineSummary=summarize(baseline);
  const regressions=report.taskIds.filter(task=>{
    const candidate=summarize(chosen.filter(row=>row.task===task)),reference=summarize(baseline.filter(row=>row.task===task));
    return candidate.verifiedCompletion<reference.verifiedCompletion||candidate.adherence<reference.adherence;
  });
  if(regressions.length||selectedSummary.adherence<baselineSummary.adherence||selectedSummary.falseCompletionClaims>baselineSummary.falseCompletionClaims){
    reasons.push('The aggregate leader has an instruction, task or false-completion regression against '+baselineId+'. Faster execution cannot compensate for incorrect work.');report.regressionTasks=regressions;return report;
  }
  if(chosen.some(row=>Object.entries(row.catalogVariant?.options??CATALOG_DEFAULTS).some(([key,value])=>value!==CATALOG_DEFAULTS[key]))){
    report.status='unsupported';reasons.push('The measured candidate includes fixture catalog transformations that named profiles cannot apply. The complete candidate must be supported; no partial change is offered.');return report;
  }
  report.status='ready';report.winner=winner;report.delivery=delivery(chosen[0].settings);
  report.baselineId=baselineId;report.tradeoffs={candidate:selectedSummary,baseline:baselineSummary,resources:comparison.configurations.map(({id})=>{
    const selected=rows.filter(row=>row.configId===id),known=key=>selected.map(row=>row.resources?.[key]).filter(Number.isFinite);
    const peak=key=>known(key).length?Math.max(...known(key)):null;
    return {id,peakHostUsedGiB:peak('peakHostUsedGiB'),peakGpuUsedMiB:peak('peakGpuUsedMiB'),scope:'Sampled whole-system use; includes other workloads, not exclusive Harbor or model memory.'};
  })};
  const delta=selectedSummary.verifiedCompletion-baselineSummary.verifiedCompletion;
  report.interpretation=winner===baselineId?'The reference delivery method leads on verified completion in these tasks. The alternatives did not justify replacing it on this evidence.':`${winner} improved verified completion by ${(delta*100).toFixed(1)} percentage points against ${baselineId} on the tested tasks.`;
  if(selectedSummary.successMedianMs!==null&&baselineSummary.successMedianMs!==null)report.interpretation+=` Successful-task median was ${(selectedSummary.successMedianMs/1000).toFixed(2)} s versus ${(baselineSummary.successMedianMs/1000).toFixed(2)} s. These medians cover each method's successful tasks and are not a paired speedup estimate.`;
  report.interpretation+=' Resource peaks include other activity. No monetary-cost or universal efficiency ranking is inferred.';
  reasons.push(comparison.recommendation.reason,'Review the task coverage, uncertainty and tradeoffs before changing a named profile. Existing sessions retain their current revision.');
  return report;
}

// Bounded, expiring, one-use reviews. The renderer supplies only an opaque
// token on apply; settings and evidence are reconstructed in the main process.
export function createAdviceReviews({refreshEvidence,getProfile,getCatalog,saveProfile,saveReceipt,now=Date.now}={}){
  const reviews=new Map();let writes=Promise.resolve(),closed=false;
  const expire=()=>{for(const [id,review] of reviews)if(review.expiresAt<=now())reviews.delete(id);};
  const inspect=async campaignId=>{if(closed)throw Error('Advice is closed');const value=await refreshEvidence(campaignId);if(closed)throw Error('Advice is closed');return assessAdvice(value);};
  return {
    inspect,
    async preview({campaignId,profileId,retainHistory=false}={}){
      if(typeof retainHistory!=='boolean')throw Error('Choose whether to retain configuration history');
      if(profileId==='default')throw Error('Choose a named profile; advice does not change the live default gateway');
      if(retainHistory&&!saveReceipt)throw Error('Configuration history is unavailable');
      const evidence=await inspect(campaignId);if(evidence.status!=='ready')throw Error(evidence.reasons.join(' '));
      const profile=await getProfile(profileId),catalog=await getCatalog(profile);
      if(closed)throw Error('Advice is closed');
      const changes=ADVICE_FIELDS.filter(key=>adviceFingerprint(profile.delivery[key])!==adviceFingerprint(evidence.delivery[key])).map(field=>({field,before:structuredClone(profile.delivery[field]),after:structuredClone(evidence.delivery[field])}));
      if(!changes.length)throw Error('This profile already uses the measured delivery settings');
      expire();for(const [id,review] of reviews)if(review.profileId===profileId)reviews.delete(id);
      if(reviews.size>=20)reviews.delete(reviews.keys().next().value);
      const review={token:randomUUID(),expiresAt:now()+300000,campaignId,profileId,profileRevision:profile.revision,profileFingerprint:adviceFingerprint(profile),catalogFingerprint:adviceFingerprint(catalog),evidenceFingerprint:adviceFingerprint(evidence),retainHistory,changes,evidence};
      reviews.set(review.token,review);return structuredClone(review);
    },
    apply(token){
      const job=writes.then(async()=>{
        if(closed)throw Error('Advice is closed');expire();
        const review=reviews.get(token);if(!review)throw Error('Review expired or was already used; review the change again');
        reviews.delete(token);
        const evidence=await inspect(review.campaignId);
        if(evidence.status!=='ready'||adviceFingerprint(evidence)!==review.evidenceFingerprint)throw Error('Campaign evidence or setup changed; review the change again');
        const profile=await getProfile(review.profileId);
        if(profile.revision!==review.profileRevision||adviceFingerprint(profile)!==review.profileFingerprint)throw Error('The profile changed; review the change again');
        if(adviceFingerprint(await getCatalog(profile))!==review.catalogFingerprint)throw Error('The selected tool catalog changed; review the change again');
        const saved=await saveProfile({...profile,delivery:{...profile.delivery,...evidence.delivery}},{expectedRevision:review.profileRevision,expectedCatalogFingerprint:review.catalogFingerprint});
        const result={applied:true,profileId:saved.id,revision:saved.revision,retainedHistory:false,sessionPolicy:'Reconnect to use the new profile revision. Existing client sessions are unchanged.'};
        if(saved.adviceCatalogChanged)result.catalogWarning='The profile was saved, but the tool catalog changed during the save. Revalidate its behavior after reconnecting.';
        if(review.retainHistory)try{
          await saveReceipt({appliedAt:new Date(now()).toISOString(),campaignId:review.campaignId,evidenceFingerprint:review.evidenceFingerprint,profileId:saved.id,previousRevision:review.profileRevision,revision:saved.revision,changes:review.changes});result.retainedHistory=true;
        }catch{result.historyError='The profile was saved, but its optional configuration-history receipt could not be retained.';}
        return result;
      });writes=job.catch(()=>{});return job;
    },
    async close(){closed=true;reviews.clear();await writes;}
  };
}
