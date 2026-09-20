const el=(tag,text='',className='')=>{const node=document.createElement(tag);node.textContent=text;node.className=className;return node;};
const pct=value=>Number.isFinite(value)?(100*value).toFixed(1)+'%':'Unknown';
const seconds=value=>Number.isFinite(value)?(value/1000).toFixed(1)+' s':'Unknown';
const valueText=value=>typeof value==='string'?value:JSON.stringify(value);

export function createMeasuredAdvice({api}){
  let busy=false,page=0,pages=1,evidence=null,review=null,historyCount=0;
  const root=el('details','','connection-card measured-advice');root.append(el('summary','Measured configuration advice'));
  root.append(el('p','Saved diagnostic results can support a Harbor delivery change for one fixed harness/model setup. These measurements are separate from the static toolbox rules below.'));
  const status=el('p','Load saved evidence to begin.','hint');status.setAttribute('role','status');status.setAttribute('aria-label','Measured advice status');
  const campaigns=el('select');campaigns.setAttribute('aria-label','Advice campaign');
  const profiles=el('select');profiles.setAttribute('aria-label','Advice target profile');
  const retain=el('input');retain.type='checkbox';retain.setAttribute('aria-label','Retain previous delivery values');
  const retention=el('label');retention.append(retain,document.createTextNode(' Keep prior delivery values in local configuration history'));
  const output=el('section'),previewOutput=el('section');previewOutput.setAttribute('aria-label','Reviewed profile change');
  const load=el('button','Load saved evidence'),previous=el('button','Previous evidence page'),next=el('button','Next evidence page'),inspect=el('button','Check this campaign'),preview=el('button','Review profile change'),apply=el('button','Apply reviewed change','primary');
  const controls=el('div','','actions');controls.append(load,previous,next,inspect);
  const choices=el('div','','advisor-controls');const campaignLabel=el('label','Saved campaign');campaignLabel.append(campaigns);const profileLabel=el('label','Named profile');profileLabel.append(profiles);choices.append(campaignLabel,profileLabel);
  const changes=el('div','','actions');changes.append(preview,apply);
  const history=el('details'),historyOutput=el('div'),historyLoad=el('button','Refresh configuration history'),historyClear=el('button','Clear configuration history');
  history.append(el('summary','Optional configuration history'),el('p','Only explicitly retained delivery changes appear here. No application backups are created. Clearing this history does not change current profiles.','hint'),historyLoad,historyClear,historyOutput);
  root.append(status,choices,controls,output,retention,el('p','History is off by default. Applying creates a new profile revision; connected clients keep their current revision until reconnecting.','hint'),changes,previewOutput,history);
  function enable(){load.disabled=historyLoad.disabled=busy;previous.disabled=busy||page===0;next.disabled=busy||page+1>=pages;inspect.disabled=busy||!campaigns.value;preview.disabled=busy||evidence?.status!=='ready'||!profiles.value;apply.disabled=busy||!review;historyClear.disabled=busy||!historyCount;campaigns.disabled=profiles.disabled=retain.disabled=busy;}
  function resetReview(){review=null;previewOutput.replaceChildren();enable();}
  function renderHistory(value){historyCount=value.receipts.length;historyOutput.replaceChildren(el('p',`${historyCount} retained changes · limit ${value.limit}`,'hint'));for(const receipt of value.receipts){const item=el('details');item.append(el('summary',`${new Date(receipt.appliedAt).toLocaleString()} · ${receipt.profileId} · revision ${receipt.previousRevision} → ${receipt.revision}`));for(const change of receipt.changes)item.append(el('p',`${change.field}: ${valueText(change.before)} → ${valueText(change.after)}`));historyOutput.append(item);}enable();}
  async function action(operation,message){if(busy)return;busy=true;enable();if(message)status.textContent=message;try{await operation();}catch(error){resetReview();status.textContent=error.message||String(error);}finally{busy=false;enable();}}
  async function loadPage(target){
    const [saved,named]=await Promise.all([api.diagnosticsListCampaigns({page:target}),api.getProfiles()]);
    page=saved.page;pages=saved.pages;campaigns.replaceChildren();profiles.replaceChildren();
    for(const item of saved.items){const option=el('option',`${item.createdAt??item.id} · ${item.status} · ${item.trials??'?'} trials · ${item.model??'unknown model'}`);option.value=item.id;option.disabled=item.status==='unreadable';campaigns.append(option);}
    for(const profile of named.profiles){const option=el('option',`${profile.name} · revision ${profile.revision}`);option.value=profile.id;profiles.append(option);}
    evidence=null;output.replaceChildren();resetReview();status.textContent=saved.total?`${saved.total} saved campaigns · page ${page+1} of ${pages}. Check a campaign to inspect its evidence.`:'No saved diagnostic campaigns. Run a campaign in Diagnostics first.';
  }
  function renderEvidence(result){
    evidence=result;resetReview();output.replaceChildren(el('h3',{ready:'Measured improvement found',stale:'Evidence needs revalidation',unsupported:'Candidate cannot be applied',insufficient:'Not enough evidence'}[result.status]??'Evidence unavailable'));
    for(const reason of result.reasons)output.append(el('p',reason));
    if(result.interpretation)output.append(el('p',result.interpretation));
    if(result.setup)output.append(el('p',`${result.setup.harness??'Unknown harness'} · ${result.setup.model??'Unknown model'} · ${result.setup.provider??'Unknown provider'} · reasoning ${result.setup.reasoning??'unknown'}`,'hint'));
    output.append(el('p',`${result.observations} observations · tasks: ${result.taskIds.join(', ')||'none'}`,'hint'));
    const table=el('table'),head=el('tr');for(const title of ['Configuration','Eligible / total','Verified completion','95% completion interval','Adherence','Successful median / p95'])head.append(el('th',title));table.append(head);
    for(const row of result.comparison.configurations){const tr=el('tr');for(const value of [row.id,`${row.eligible} / ${row.trials}`,pct(row.verifiedCompletion),row.completion95?row.completion95.map(pct).join(' – '):'Unknown',pct(row.adherence),`${seconds(row.successMedianMs)} / ${seconds(row.successP95Ms)}`])tr.append(el('td',value));table.append(tr);}output.append(table);
    if(result.tradeoffs)for(const row of result.tradeoffs.resources)output.append(el('p',`${row.id}: sampled peak host RAM ${row.peakHostUsedGiB?.toFixed(1)??'unknown'} GiB; GPU ${row.peakGpuUsedMiB??'unknown'} MiB. ${row.scope}`,'hint'));
    output.append(el('p',result.scope,'hint'));status.textContent=result.status==='ready'?'Review the evidence and select a named profile.':'No profile change is available from this evidence.';enable();
  }
  load.onclick=()=>action(()=>loadPage(0),'Loading saved campaigns and profiles…');
  previous.onclick=()=>action(()=>loadPage(page-1));next.onclick=()=>action(()=>loadPage(page+1));
  campaigns.onchange=()=>{evidence=null;output.replaceChildren();resetReview();};profiles.onchange=retain.onchange=resetReview;
  inspect.onclick=()=>action(async()=>renderEvidence(await api.adviceInspect(campaigns.value)),'Checking evidence and the current setup; large model-file checks can take up to two minutes…');
  preview.onclick=()=>action(async()=>{
    review=await api.advicePreview({campaignId:campaigns.value,profileId:profiles.value,retainHistory:retain.checked});
    previewOutput.replaceChildren(el('h3',`${review.profileId} · revision ${review.profileRevision} · proposed change`));
    for(const change of review.changes)previewOutput.append(el('p',`${change.field}: ${valueText(change.before)} → ${valueText(change.after)}`));
    previewOutput.append(el('p',`${review.retainHistory?'Prior delivery values will be retained in configuration history.':'No configuration-history receipt will be retained.'} Review expires at ${new Date(review.expiresAt).toLocaleTimeString()}.`,'hint'));
    status.textContent='Review the proposed change below, then apply explicitly.';
  },'Preparing a fresh profile review…');
  apply.onclick=()=>action(async()=>{
    const token=review.token;review=null;const result=await api.adviceApply(token);
    previewOutput.replaceChildren();status.textContent=`Saved ${result.profileId}, revision ${result.revision}. ${result.sessionPolicy}${result.catalogWarning?' '+result.catalogWarning:''}${result.historyError?' '+result.historyError:''}`;
    if(result.retainedHistory)try{renderHistory(await api.adviceHistory());}catch{status.textContent+=' The saved history could not be refreshed; retry Refresh configuration history.';}
  },'Rechecking the reviewed evidence and saving the named profile…');
  historyLoad.onclick=()=>action(async()=>{renderHistory(await api.adviceHistory());status.textContent='Configuration history refreshed.';});
  historyClear.onclick=()=>action(async()=>{renderHistory(await api.adviceClearHistory());status.textContent='Configuration history cleared. Current profiles are unchanged.';});
  enable();return {root};
}
