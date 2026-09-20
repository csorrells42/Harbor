import {createSystemOverview} from './system-ui.js';
import {CONFORMANCE_TASKS,WORKLOAD_TASKS} from './workload-catalog.js';
import {CATALOG_CHOICES,CATALOG_DEFAULTS} from './catalog-options.js';
const el=(tag,text='',className='')=>{const n=document.createElement(tag);n.textContent=text;n.className=className;return n;};
const pct=x=>x===null||x===undefined?'Unknown':`${(x*100).toFixed(1)}%`;
const seconds=x=>x===null||x===undefined?'—':`${(x/1000).toFixed(1)} s`;
export function mountDiagnostics(container,api) {
  if(!document.querySelector('link[data-diagnostics]')){const css=document.createElement('link');css.rel='stylesheet';css.href=new URL('./ui.css',import.meta.url).href;css.dataset.diagnostics='true';document.head.append(css);}
  let disposed=false,busy=false,checking=false,current,loaded=false,view='configurations',localError=null;
  let selectedCampaign=null,historyPage=0,trialPage=0,reportId=null,settingsOpen=false,reportSignature=null;
  const displayed=()=>selectedCampaign??current;
  const root=el('div','','diagnostics'),intro=el('p','Choose what to test, compare how Harbor delivers tools, and inspect what actually worked. Use the same model and harness for each delivery comparison.','diag-intro');
  const systemOverview=createSystemOverview();
  const status=el('div','Loading diagnostics…','diag-status');status.setAttribute('role','status');
  const identity=el('p','','muted');
  const modelEvidence=el('p','','diag-note');modelEvidence.setAttribute('aria-label','Model comparison identity');
  const setup=el('section','','diag-setup');setup.setAttribute('aria-label','Campaign setup');
  const fields=el('div','','diag-fields'),controls={};
  for(const [key,title,value,min,max] of [['repetitions','Repetitions per task and configuration',3,1,30],['seed','Matched task seed',18431,0,2147483647],['maxTrialSeconds','Seconds per trial (including harness startup)',120,10,1800],['maxCampaignSeconds','Campaign time limit in seconds',1800,10,86400],['maxTurns','Maximum model turns',12,1,100],['maxHostUsedGiB','Maximum total host RAM used (GiB)',null,1,10000],['maxGpuUsedMiB','Maximum used memory per GPU (MiB)',null,1,1000000]]){
    const label=el('label',title),input=el('input');input.type='number';input.min=min;input.max=max;if(value!==null)input.value=value;else input.placeholder='No limit';input.setAttribute('aria-label',title);label.append(input);fields.append(label);controls[key]=input;
  }
  const variants=el('textarea');variants.rows=13;variants.setAttribute('aria-label','Delivery variants JSON');
  const modeControls=el('div','','diag-fields'),chosen=[];
  for(const [id,label,mode] of [['all','All tools','all'],['bm25','BM25 search','bm25'],['regex','Regex search','regex'],['code','Code Mode','code'],['semantic','Local semantic search','portkey-local'],['hybrid','Hybrid search','hybrid']]){const l=el('label'),c=el('input');c.type='checkbox';c.checked=true;c.setAttribute('aria-label',`Test ${label}`);l.append(c,document.createTextNode(label));modeControls.append(l);chosen.push({id,label,mode,c});}
  const hybridControls=el('div','','diag-fields'),hybridMethods=[];
  for(const [mode,label] of [['bm25','BM25'],['regex','Regex'],['code','Code Mode'],['portkey-local','Local semantic']]){const l=el('label'),c=el('input');c.type='checkbox';c.checked=['bm25','portkey-local'].includes(mode);c.setAttribute('aria-label',`Hybrid uses ${label}`);l.append(c,document.createTextNode(label));hybridControls.append(l);hybridMethods.push({mode,c});}
  const limit=el('input');limit.type='number';limit.value=5;limit.min=1;limit.max=50;limit.setAttribute('aria-label','Search result limit');
  const threshold=el('input');threshold.type='number';threshold.value=0.25;threshold.min=0;threshold.max=1;threshold.step=0.05;threshold.setAttribute('aria-label','Semantic minimum score');
  const embedding=el('select');embedding.setAttribute('aria-label','Local embedding model');for(const id of ['Xenova/all-MiniLM-L6-v2','Xenova/all-MiniLM-L12-v2','Xenova/bge-small-en-v1.5','Xenova/bge-base-en-v1.5']){const o=el('option',id);o.value=id;embedding.append(o);}
  const tuning=el('div','','diag-fields');for(const [name,node] of [['Search result limit',limit],['Semantic minimum score',threshold],['Local embedding model',embedding]]){const label=el('label',name);label.append(node);tuning.append(label);}
  const catalogFields=el('div','','diag-fields'),catalogControls={},catalogToggle=el('input'),overlap=el('input');
  catalogToggle.type=overlap.type='checkbox';catalogToggle.setAttribute('aria-label','Compare catalog variant');overlap.setAttribute('aria-label','Include equivalent fixture provider');
  const catalogLabel=el('label'),overlapLabel=el('label');catalogLabel.append(catalogToggle,document.createTextNode('Compare a catalog variant alongside each selected delivery mode'));overlapLabel.append(overlap,document.createTextNode('Include an equivalent fixture provider in every variant'));catalogFields.append(catalogLabel,overlapLabel);
  const catalogTitles={subset:'Candidate tool subset',descriptions:'Candidate descriptions',schemaAnnotations:'Candidate schema annotations',order:'Candidate catalog order',provider:'Candidate preferred fixture provider'};
  for(const [key,options] of Object.entries(CATALOG_CHOICES)){const label=el('label',catalogTitles[key]),select=el('select');select.setAttribute('aria-label',catalogTitles[key]);for(const [value,title] of Object.entries(options)){const option=el('option',title);option.value=value;select.append(option);}select.value=key==='descriptions'?'concise':CATALOG_DEFAULTS[key];select.disabled=true;label.append(select);catalogFields.append(label);catalogControls[key]=select;}
  catalogToggle.onchange=()=>{for(const select of Object.values(catalogControls))select.disabled=!catalogToggle.checked;};
  const advanced=el('details'),advancedToggle=el('input');advancedToggle.type='checkbox';advancedToggle.setAttribute('aria-label','Use advanced variant matrix');const advancedLabel=el('label');advancedLabel.append(advancedToggle,document.createTextNode('Use advanced variant matrix instead of the controls above'));advanced.append(el('summary','Advanced: custom comparison matrix'),advancedLabel,variants);
  const taskControls=el('div','','diag-fields'),taskChoices=new Map(),taskActions=el('div','','actions');
  for(const [title,pack] of [['Select conformance pack',CONFORMANCE_TASKS],['Select representative pack',WORKLOAD_TASKS]]){const button=el('button',title);button.type='button';button.onclick=()=>{for(const [id,input] of taskChoices)input.checked=pack.some(task=>task.id===id);};taskActions.append(button);}
  for(const task of [...CONFORMANCE_TASKS,...WORKLOAD_TASKS]){const label=el('label'),input=el('input');input.type='checkbox';input.checked=CONFORMANCE_TASKS.some(value=>value.id===task.id);input.setAttribute('aria-label','Task: '+task.name);const title=el('span',task.name);if(task.description)title.title=task.description;label.append(input,title);taskChoices.set(task.id,input);taskControls.append(label);}
  const harnessChoice=el('select');harnessChoice.setAttribute('aria-label','Test harness');for(const [id,title] of [['hermes','Hermes'],['openclaw','OpenClaw'],['lmstudio','LM Studio']]){const option=el('option',title);option.value=id;harnessChoice.append(option);}
  const harnessName=()=>({hermes:'Hermes',openclaw:'OpenClaw',lmstudio:'LM Studio'})[harnessChoice.value];
  const selectedInventory=()=>current&&(current.harness??'hermes')===harnessChoice.value?current.inventory:null;
  harnessChoice.onchange=()=>{localError=null;probe.textContent='Check '+harnessName();identity.textContent='Check this harness before starting.';void refresh();};
  const buttons=el('div','','actions'),probe=el('button','Check Hermes'),start=el('button','Start campaign','primary'),cancel=el('button','Cancel campaign'),exportButton=el('button','Copy results JSON'),saveButton=el('button','Save campaign evidence');
  buttons.append(probe,start,cancel,exportButton,saveButton);
  const exportStatus=el('p','','hint');exportStatus.setAttribute('role','status');
  const history=el('details'),historySelect=el('select'),historyStatus=el('p','','hint'),historyRefresh=el('button','Refresh saved campaigns'),historyPrevious=el('button','Previous campaigns'),historyNext=el('button','Next campaigns'),historyOpen=el('button','Open selected campaign'),historyLive=el('button','Show latest campaign');
  historySelect.setAttribute('aria-label','Saved campaign');historyPrevious.disabled=historyNext.disabled=historyOpen.disabled=true;
  const historyActions=el('div','','actions');historyActions.append(historyRefresh,historyPrevious,historyNext,historyOpen,historyLive);
  history.append(el('summary','Saved campaigns'),historyStatus,historySelect,historyActions);
  async function loadHistory(page){const result=await api.diagnosticsListCampaigns({page});if(disposed)return;historyPage=result.page;historySelect.replaceChildren();for(const item of result.items){const option=el('option',`${item.createdAt??item.id} · ${item.status} · ${item.trials??'?'} / ${item.plannedTrials??'?'} · ${item.model??'unknown model'}${item.error?' · '+item.error:''}`);option.value=item.id;option.disabled=item.status==='unreadable';historySelect.append(option);}historyStatus.textContent=`${result.total} saved campaigns · page ${result.page+1} / ${result.pages}. Most recently updated first; refresh to include new runs.`;historyPrevious.disabled=result.page===0;historyNext.disabled=result.page+1>=result.pages;historyOpen.disabled=!result.items.some(item=>item.status!=='unreadable');}
  const report=el('div'),tabs=el('div','','actions'),inspection=el('section','','connection-card');inspection.hidden=true;inspection.setAttribute('aria-label','Trial evidence');
  async function inspectTrial(trial){
    try{const campaignId=displayed().campaign.id,detail=await api.diagnosticsInspectTrial({campaignId,trialId:trial.id});if(disposed||displayed().campaign.id!==campaignId)return;
      let page=0;const text=JSON.stringify(detail,null,2),size=65536,total=Math.max(1,Math.ceil(text.length/size));
      const pre=el('pre','','mono'),label=el('p','','hint'),previous=el('button','Previous evidence page'),next=el('button','Next evidence page');
      const draw=()=>{pre.textContent=text.slice(page*size,(page+1)*size);label.textContent=`Page ${page+1} / ${total}. Initial and per-request presentation are separate observations; missing evidence remains unknown.`;previous.disabled=page===0;next.disabled=page===total-1;};
      previous.onclick=()=>{page--;draw();};next.onclick=()=>{page++;draw();};const controls=el('div','','actions');controls.append(previous,label,next);
      inspection.replaceChildren(el('h3',`${trial.configId} · ${trial.task} · trial evidence`),controls,pre);draw();inspection.hidden=false;inspection.scrollIntoView({block:'start'});
    }catch(error){localError=error.message;status.textContent=localError;}
  }
  for(const [key,label] of [['configurations','Harbor configurations']]){const b=el('button',label);b.onclick=()=>{view=key;renderReport();};tabs.append(b);}
  const warning=el('p','Recommendations apply to this fixed harness and model setup. Missing comparison identity stays unknown. System readings include other applications; these tests do not reserve hardware.','diag-note');
  const steps=[],stepNav=el('nav','','diag-step-nav');stepNav.setAttribute('aria-label','Campaign steps');
  const review=el('div','','diag-review');review.setAttribute('aria-label','Campaign review');
  const disclose=(title,...nodes)=>{const details=el('details');details.append(el('summary',title),...nodes);return details;};
  function showStep(index,scroll=true){
    for(const [i,step] of steps.entries()){step.panel.open=i===index;step.nav.setAttribute('aria-current',i===index?'step':'false');}
    if(index===4)updateReview();
    if(scroll){steps[index].heading.focus({preventScroll:true});steps[index].panel.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}
  }
  for(const [index,title] of ['Connection','Tasks','Delivery','Limits','Review and run'].entries()){
    const panel=el('details','','diag-step'),heading=el('summary',`${index+1}. ${title}`),body=el('div','','diag-step-body'),nav=el('button',`${index+1}. ${title}`);
    heading.onclick=event=>{event.preventDefault();showStep(index);};nav.type='button';nav.onclick=()=>showStep(index);panel.append(heading,body);stepNav.append(nav);steps.push({panel,heading,body,nav});setup.append(panel);
  }
  const next=(index,text)=>{const button=el('button',text,'primary');button.type='button';button.onclick=()=>showStep(index+1);steps[index].body.append(button);};
  steps[0].body.append(el('p','Choose a harness. Hermes uses its saved local model connection; OpenClaw and native LM Studio use the single model already loaded in LM Studio. Native LM Studio requires server authentication, Allow calling servers from mcp.json, and an API token with that permission supplied through LM_STUDIO_API_TOKEN. Each trial adds and then removes its own temporary MCP entry; your existing entries are preserved. Internal model requests remain unknown. Checking does not load or switch models.'),harnessChoice,probe,identity,disclose('Connection details',modelEvidence,warning));next(0,'Continue to tasks');
  steps[1].body.append(el('p','Choose a starting pack. You can adjust individual tasks before continuing.'),taskActions,el('p','Conformance checks exact tool sequences. Representative tasks exercise files, SQLite and a local browser page. Both use disposable test data.','muted'),disclose('Choose individual tasks',taskControls));next(1,'Continue to delivery');
  steps[2].body.append(el('p','Select the delivery methods to compare. The same chosen tasks run for each method.'),modeControls,el('p','All tools sends the complete toolbox. Search modes find a smaller selection; Hybrid combines search methods. Code Mode exposes a programmable interface.','muted'),disclose('Advanced delivery settings',el('h3','Methods in the hybrid variant'),hybridControls,tuning,el('h3','Controlled catalog comparison'),catalogFields,el('p','Change one factor at a time when possible. These options change the synthetic test catalog; they do not rename your installed tools.','muted'),advanced));next(2,'Continue to limits');
  const basicLimits=el('div','','diag-fields'),extraLimits=el('div','','diag-fields');
  for(const [key,input] of Object.entries(controls))(['repetitions','maxTrialSeconds','maxCampaignSeconds'].includes(key)?basicLimits:extraLimits).append(input.parentElement);
  steps[3].body.append(el('p','Set how often to repeat each task and how long the test may run. More repetitions provide stronger evidence but take longer.'),basicLimits,disclose('Advanced limits and repeatability',extraLimits),el('p','RAM and GPU limits stop the entire campaign. An always-on emergency backstop also stops it at 500 MB or less available system memory. These checks do not reserve memory or change the model’s context size.','muted'));next(3,'Review campaign');
  steps[4].body.append(review,start,el('p','Starting runs the selected tasks through your chosen harness. Nothing runs while you are choosing settings.','muted'));
  buttons.replaceChildren(cancel,exportButton,saveButton);
  function updateReview(){
    const tasks=[...taskChoices].filter(([,input])=>input.checked).map(([id])=>id);let count=chosen.filter(value=>value.c.checked).length*(catalogToggle.checked?2:1),description=chosen.filter(value=>value.c.checked).map(value=>value.label).join(', ')||'None selected';
    if(advancedToggle.checked){try{const values=JSON.parse(variants.value);if(!Array.isArray(values))throw Error();count=values.length;description=values.map(value=>value.id??'unnamed').join(', ');}catch{count=null;description='Advanced variant JSON needs correction';}}
    const repetitions=Number(controls.repetitions.value),trials=count===null?null:tasks.length*count*repetitions;
    review.replaceChildren(el('p',`Connection: ${selectedInventory()?.model??'not checked yet'}`),el('p',`Tasks: ${tasks.length} selected`),el('p',`Delivery: ${description}`),el('p',`Planned trials: ${Number.isSafeInteger(trials)&&trials>0?trials:'check your selections'} · ${controls.repetitions.value||'?'} repetitions per task and method`),el('p',`Time limits: ${controls.maxTrialSeconds.value||'?'} seconds per trial; ${controls.maxCampaignSeconds.value||'?'} seconds for the campaign`));
  }
  setup.addEventListener('input',()=>{if(steps[4].panel.open)updateReview();});
  root.append(intro,status,stepNav,setup,el('h2','Results'),buttons,exportStatus,history,tabs,report,inspection,disclose('Hardware and temperature monitoring',systemOverview.element));container.replaceChildren(root);showStep(0,false);
  async function action(fn){if(busy)return;busy=true;localError=null;start.disabled=probe.disabled=saveButton.disabled=harnessChoice.disabled=true;try{await fn();await refresh();}catch(e){localError=e.message||String(e);status.textContent=localError;}finally{busy=false;start.disabled=!!current?.running;probe.disabled=false;harnessChoice.disabled=!!current?.running;saveButton.disabled=!displayed()?.campaign;}}
  probe.onclick=()=>action(async()=>{checking=true;status.textContent='Checking local model files and live settings; hashing large weights can take up to two minutes.';try{await api.diagnosticsProbe({harness:harnessChoice.value});}finally{checking=false;}});
  start.onclick=()=>action(async()=>{
    let selected=chosen.filter(x=>x.c.checked).map(x=>({id:x.id,toolMode:x.mode,searchLimit:Number(limit.value),semanticMinScore:Number(threshold.value),portkeyLocalModel:embedding.value,...(x.mode==='hybrid'?{hybridModes:hybridMethods.filter(m=>m.c.checked).map(m=>m.mode)}:{})}));
    if(advancedToggle.checked)selected=JSON.parse(variants.value);else if(catalogToggle.checked){const catalog=Object.fromEntries(Object.entries(catalogControls).map(([key,select])=>[key,select.value]));selected=selected.flatMap(variant=>[variant,{...variant,id:variant.id+'-catalog',catalog}]);}
    const plan={...current.defaultPlan,harness:harnessChoice.value,variants:selected,overlapProviders:overlap.checked,tasks:[...taskChoices].filter(([,input])=>input.checked).map(([id])=>id)};for(const [key,input] of Object.entries(controls))plan[key]=input.value===''?null:Number(input.value);
    await api.diagnosticsStart(plan);selectedCampaign=null;inspection.hidden=true;exportStatus.textContent='';
  });
  cancel.onclick=()=>action(()=>api.diagnosticsCancel());
  exportButton.onclick=()=>action(()=>api.copy(JSON.stringify({campaign:displayed().campaign,results:displayed().results},null,2)));
  saveButton.onclick=()=>action(async()=>{const result=await api.diagnosticsSaveCampaign(displayed().campaign.id);exportStatus.textContent=result.saved?`Saved ${result.name} (${result.bytes.toLocaleString()} bytes). Contains local paths and synthetic tool evidence; inspect before sharing.`:'Save cancelled.';});
  historyRefresh.onclick=()=>action(()=>loadHistory(0));historyPrevious.onclick=()=>action(()=>loadHistory(historyPage-1));historyNext.onclick=()=>action(()=>loadHistory(historyPage+1));
  historyOpen.onclick=()=>action(async()=>{selectedCampaign=await api.diagnosticsInspectCampaign(historySelect.value);inspection.hidden=true;exportStatus.textContent='';});
  historyLive.onclick=()=>action(async()=>{selectedCampaign=null;inspection.hidden=true;exportStatus.textContent='';});
  function renderReport(){
    if(!current)return;
    const c=displayed().campaign,r=displayed().results;saveButton.disabled=!c||busy;
    if(reportId!==c?.id){reportId=c?.id;trialPage=0;settingsOpen=false;}
    // Hardware/status polling must not replace unchanged report controls while
    // the user scrolls, clicks or uses keyboard focus to inspect a trial.
    const signature=JSON.stringify([c,r,!!selectedCampaign,view,trialPage,current.dataDir]);
    if(signature===reportSignature)return;
    reportSignature=signature;report.replaceChildren();
    report.append(el('p',r.recommendation.reason));
    if(r.identityGaps?.length)report.append(el('p','Comparison identity gaps: '+r.identityGaps.join('; '),'diag-note'));
    if(r.recommendation.provisionalLeader)report.append(el('p',`Provisional leader: ${r.recommendation.provisionalLeader}. Confirmed winner: ${r.recommendation.winner||'none'}.`));
    if(!c){report.append(el('p','No campaigns yet. Check your harness, choose variants, and start.'));return;}
    report.append(el('p',`${selectedCampaign?'Saved campaign snapshot':'Latest campaign'} · ${c.id} · ${c.createdAt??'date unknown'}`,'hint'));
    if(c.note)report.append(el('p',c.note,'diag-note'));
    const savedSettings=el('details'),settingsText=el('pre',JSON.stringify({plan:c.plan,inventory:c.inventory,suite:c.suite,harborFingerprint:c.harborFingerprint},null,2),'mono');savedSettings.open=settingsOpen;savedSettings.ontoggle=()=>{if(savedSettings.isConnected)settingsOpen=savedSettings.open;};savedSettings.append(el('summary','Selected campaign settings and setup'),settingsText);report.append(savedSettings);
    report.append(el('p',`${c.status}: ${c.trials.length} / ${c.plannedTrials} trials. ${c.current?`Now: ${c.current.configId} / ${c.current.task} / repetition ${c.current.repetition}`:''}`));
    const table=el('table','','diag-table'),head=el('tr');for(const text of ['Entry','Eligible / total','Verified completion (95% interval)','Acceptance','Instructions','Tool selection / arguments','Success median / p95','False completion claims'])head.append(el('th',text));table.append(head);
    for(const row of r[view]){const tr=el('tr');const interval=row.completion95?` (${pct(row.completion95[0])}–${pct(row.completion95[1])})`:'';for(const text of [row.id,`${row.eligible} / ${row.trials}`,pct(row.verifiedCompletion)+interval,pct(row.acceptance),pct(row.adherence),`${pct(row.toolCorrectness)} / ${pct(row.argumentCorrectness)}`,`${seconds(row.successMedianMs)} / ${seconds(row.successP95Ms)}`,String(row.falseCompletionClaims)])tr.append(el('td',text));table.append(tr);}
    const wrap=el('div','','diag-scroll');wrap.append(table);report.append(wrap,el('p',r.scope,'muted'));
    for(const row of r[view]){
      const count=value=>Number.isInteger(value)?String(value):'unknown';
      report.append(el('p',`${row.id}: ${count(row.excluded)} excluded, ${count(row.timeouts)} timed out, ${count(row.cancellations)} cancelled, ${count(row.failures)} infrastructure failures, ${count(row.resourceLimitStops)} resource stops out of ${count(row.trials)} recorded trials. Tool-selection observations: ${count(row.toolSelectionObserved)} / ${count(row.eligible)} eligible; argument observations: ${count(row.argumentCorrectnessObserved)} / ${count(row.eligible)} eligible. Exclusions and status counts may overlap.`,'diag-note'));
    }
    for(const contrast of r.contrasts??[])report.append(el('p',`${contrast.baseline} → ${contrast.variant}: ${contrast.interpretation}. ${contrast.changes.map(change=>`${change.factor}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`).join('; ')}`,'hint'));
    const totalPages=Math.max(1,Math.ceil(c.trials.length/20));trialPage=Math.min(trialPage,totalPages-1);
    const trialActions=el('div','','actions'),newer=el('button','Newer trials'),older=el('button','Older trials');newer.disabled=trialPage===0;older.disabled=trialPage===totalPages-1;newer.onclick=()=>{trialPage--;renderReport();};older.onclick=()=>{trialPage++;renderReport();};trialActions.append(newer,el('p',`Trial page ${trialPage+1} / ${totalPages}`),older);report.append(el('h3','Trials'),trialActions);
    for(const t of c.trials.slice().reverse().slice(trialPage*20,trialPage*20+20)){
      const row=el('div');row.append(el('p',`${t.configId} · ${t.task} · ${t.status} · ${t.grade.completed?'verified completion':'not completed'} · ${seconds(t.elapsedMs)}${t.error?` · ${t.error}`:''}`));
      if(t.deliveryObservation){const observation=t.deliveryObservation;row.append(el('p',`Relevant-tool retrieval: ${pct(observation.retrievalCoverage)} · discovery requests: ${observation.discoveryRequests} · upstream executions: ${observation.upstreamExecutions} · observed model requests: ${observation.modelRequestCount??'unknown'} · catalog order at model: ${observation.catalogOrderAtModel??'unknown'}`,'hint'));}
      if(t.catalogVariant)row.append(el('p',`Catalog: ${t.catalogVariant.options.subset}, ${t.catalogVariant.options.descriptions}, ${t.catalogVariant.options.schemaAnnotations} schema annotations, ${t.catalogVariant.options.order}, ${t.catalogVariant.options.provider} providers · ${t.catalogVariant.filteredTools.length} filtered tools · complete workflow preserved`,'hint'));
      const inspect=el('button',`Inspect ${t.configId} / ${t.task} / repetition ${t.repetition+1}`);inspect.onclick=()=>inspectTrial(t);row.append(inspect);report.append(row);
    }
    report.append(el('p',`Results saved locally: ${current.dataDir}. Unknown usage and cost remain unknown.`,'muted'));
  }
  async function refresh(){
    try{
      const s=await api.diagnosticsSnapshot();if(disposed)return;current=s;systemOverview.update(s.system);
      if(!loaded){variants.value=JSON.stringify(s.defaultPlan.variants,null,2);harnessChoice.value=s.harness??'hermes';probe.textContent='Check '+harnessName();loaded=true;}
      const matches=(s.harness??'hermes')===harnessChoice.value,inventory=selectedInventory();
      status.textContent=checking?'Checking local model files and live settings; hashing large weights can take up to two minutes.':localError||(matches?s.problem:null)||(s.running?'Diagnostic campaign running':inventory?.ready?`${inventory.harness} connection checked; ready to run`:'Check the selected harness to verify the current model connection');
      identity.textContent=inventory?`${inventory.harness} · ${inventory.model} · reasoning ${inventory.reasoning} · ${inventory.hardware.logicalCpus} logical CPUs · ${(inventory.hardware.ramBytes/2**30).toFixed(1)} GiB RAM`:'No verified connection for the selected harness yet.';
      const evidence=inventory?.modelEvidence;
      modelEvidence.textContent=evidence?.verification==='gguf-bytes-and-live-props-v1'?`Model files verified: ${evidence.files.length} · effective context: ${evidence.contextLength.toLocaleString()} tokens · runtime: ${evidence.build}. Campaign observations must also match before advice is available.`:'Model comparison identity is incomplete. '+(evidence?.gaps?.join('; ')||'Check the running model to inspect its effective context and runtime settings.');
      start.disabled=busy||s.running;cancel.disabled=!s.running;harnessChoice.disabled=busy||s.running;renderReport();
      if(steps[4].panel.open)updateReview();
    }catch(e){if(!disposed)status.textContent=e.message||String(e);}
  }
  void refresh();const timer=setInterval(refresh,1500);
  return ()=>{disposed=true;clearInterval(timer);};
}
