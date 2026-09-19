import {createSystemOverview} from './system-ui.js';
const el=(tag,text='',className='')=>{const n=document.createElement(tag);n.textContent=text;n.className=className;return n;};
const pct=x=>x===null||x===undefined?'Unknown':`${(x*100).toFixed(1)}%`;
const seconds=x=>x===null||x===undefined?'—':`${(x/1000).toFixed(1)} s`;
export function mountDiagnostics(container,api) {
  if(!document.querySelector('link[data-diagnostics]')){const css=document.createElement('link');css.rel='stylesheet';css.href=new URL('./ui.css',import.meta.url).href;css.dataset.diagnostics='true';document.head.append(css);}
  let disposed=false,busy=false,current,loaded=false,view='configurations',localError=null;
  const root=el('div','','diagnostics'),intro=el('p','Run repeatable tasks through a private Harbor gateway and a fresh Hermes session. Compare settings, models, harnesses, and combinations using independently checked outcomes.');
  const systemOverview=createSystemOverview();
  const status=el('div','Loading diagnostics…','diag-status');status.setAttribute('role','status');
  const identity=el('p','','muted');
  const setup=el('details');setup.open=true;setup.append(el('summary','Campaign settings'));
  const fields=el('div','','diag-fields'),controls={};
  for(const [key,title,value,min,max] of [['repetitions','Repetitions per task and configuration',3,1,30],['maxTrialSeconds','Seconds per trial (including Hermes startup)',120,10,1800],['maxCampaignSeconds','Campaign time limit in seconds',1800,10,86400],['maxTurns','Maximum model turns',12,1,100],['maxHostUsedGiB','Maximum total host RAM used (GiB)',null,1,10000],['maxGpuUsedMiB','Maximum used memory per GPU (MiB)',null,1,1000000]]){
    const label=el('label',title),input=el('input');input.type='number';input.min=min;input.max=max;if(value!==null)input.value=value;else input.placeholder='No limit';input.setAttribute('aria-label',title);label.append(input);fields.append(label);controls[key]=input;
  }
  const variants=el('textarea');variants.rows=13;variants.setAttribute('aria-label','Delivery variants JSON');
  const modeControls=el('div','','diag-fields'),chosen=[];
  for(const [id,label,mode] of [['all','All tools','all'],['bm25','BM25 search','bm25'],['regex','Regex search','regex'],['code','Code Mode','code'],['semantic','Local semantic search','portkey-local'],['hybrid','Hybrid search','hybrid']]){const l=el('label'),c=el('input');c.type='checkbox';c.checked=true;c.setAttribute('aria-label',`Test ${label}`);l.append(c,document.createTextNode(label));modeControls.append(l);chosen.push({id,mode,c});}
  const hybridControls=el('div','','diag-fields'),hybridMethods=[];
  for(const [mode,label] of [['bm25','BM25'],['regex','Regex'],['code','Code Mode'],['portkey-local','Local semantic']]){const l=el('label'),c=el('input');c.type='checkbox';c.checked=['bm25','portkey-local'].includes(mode);c.setAttribute('aria-label',`Hybrid uses ${label}`);l.append(c,document.createTextNode(label));hybridControls.append(l);hybridMethods.push({mode,c});}
  const limit=el('input');limit.type='number';limit.value=5;limit.min=1;limit.max=50;limit.setAttribute('aria-label','Search result limit');
  const threshold=el('input');threshold.type='number';threshold.value=0.25;threshold.min=0;threshold.max=1;threshold.step=0.05;threshold.setAttribute('aria-label','Semantic minimum score');
  const embedding=el('select');embedding.setAttribute('aria-label','Local embedding model');for(const id of ['Xenova/all-MiniLM-L6-v2','Xenova/all-MiniLM-L12-v2','Xenova/bge-small-en-v1.5','Xenova/bge-base-en-v1.5']){const o=el('option',id);o.value=id;embedding.append(o);}
  const tuning=el('div','','diag-fields');for(const [name,node] of [['Search result limit',limit],['Semantic minimum score',threshold],['Local embedding model',embedding]]){const label=el('label',name);label.append(node);tuning.append(label);}
  const advanced=el('details'),advancedToggle=el('input');advancedToggle.type='checkbox';advancedToggle.setAttribute('aria-label','Use advanced variant matrix');const advancedLabel=el('label');advancedLabel.append(advancedToggle,document.createTextNode('Use advanced variant matrix instead of the controls above'));advanced.append(el('summary','Advanced: custom comparison matrix'),advancedLabel,variants);
  setup.append(fields,el('h3','Delivery modes to compare'),modeControls,el('h3','Methods in the hybrid variant'),hybridControls,tuning,advanced);
  const buttons=el('div','','actions'),probe=el('button','Check Hermes'),start=el('button','Start campaign','primary'),cancel=el('button','Cancel campaign'),exportButton=el('button','Copy results JSON');
  buttons.append(probe,start,cancel,exportButton);
  const report=el('div'),tabs=el('div','','actions');
  for(const [key,label] of [['configurations','Harbor configurations'],['models','Models'],['harnesses','Harnesses'],['combinations','Combinations']]){const b=el('button',label);b.onclick=()=>{view=key;renderReport();};tabs.append(b);}
  const warning=el('p','First adapter: Hermes with its configured local llama.cpp model. Model and harness rankings require additional matched pairings. CPU, RAM and GPU measurements include other workloads; this mode does not reserve hardware.','diag-note');
  root.append(systemOverview.element,intro,status,identity,buttons,setup,warning,tabs,report);container.replaceChildren(root);
  async function action(fn){if(busy)return;busy=true;localError=null;start.disabled=probe.disabled=true;try{await fn();await refresh();}catch(e){localError=e.message||String(e);status.textContent=localError;}finally{busy=false;start.disabled=!!current?.running;probe.disabled=false;}}
  probe.onclick=()=>action(()=>api.diagnosticsProbe());
  start.onclick=()=>action(()=>{const selected=advancedToggle.checked?JSON.parse(variants.value):chosen.filter(x=>x.c.checked).map(x=>({id:x.id,toolMode:x.mode,searchLimit:Number(limit.value),semanticMinScore:Number(threshold.value),portkeyLocalModel:embedding.value,...(x.mode==='hybrid'?{hybridModes:hybridMethods.filter(m=>m.c.checked).map(m=>m.mode)}:{})}));const plan={...current.defaultPlan,variants:selected};for(const [key,input] of Object.entries(controls))plan[key]=input.value===''?null:Number(input.value);return api.diagnosticsStart(plan);});
  cancel.onclick=()=>action(()=>api.diagnosticsCancel());
  exportButton.onclick=()=>action(()=>api.copy(JSON.stringify({campaign:current.campaign,results:current.results},null,2)));
  function renderReport(){
    report.replaceChildren();if(!current)return;
    const c=current.campaign,r=current.results;
    report.append(el('p',r.recommendation.reason));
    if(r.recommendation.provisionalLeader)report.append(el('p',`Provisional leader: ${r.recommendation.provisionalLeader}. Confirmed winner: ${r.recommendation.winner||'none'}.`));
    if(!c){report.append(el('p','No campaigns yet. Check Hermes, choose variants, and start.'));return;}
    report.append(el('p',`${c.status}: ${c.trials.length} / ${c.plannedTrials} trials. ${c.current?`Now: ${c.current.configId} / ${c.current.task} / repetition ${c.current.repetition}`:''}`));
    const table=el('table','','diag-table'),head=el('tr');for(const text of ['Entry','Eligible / total','Verified completion (95% interval)','Acceptance','Instructions','Tool selection / arguments','Success median / p95','False completion claims'])head.append(el('th',text));table.append(head);
    for(const row of r[view]){const tr=el('tr');const interval=row.completion95?` (${pct(row.completion95[0])}–${pct(row.completion95[1])})`:'';for(const text of [row.id,`${row.eligible} / ${row.trials}`,pct(row.verifiedCompletion)+interval,pct(row.acceptance),pct(row.adherence),`${pct(row.toolCorrectness)} / ${pct(row.argumentCorrectness)}`,`${seconds(row.successMedianMs)} / ${seconds(row.successP95Ms)}`,String(row.falseCompletionClaims)])tr.append(el('td',text));table.append(tr);}
    const wrap=el('div','','diag-scroll');wrap.append(table);report.append(wrap,el('p',r.scope,'muted'));
    report.append(el('h3','Recent trials'));
    for(const t of c.trials.slice(-20).reverse())report.append(el('p',`${t.configId} · ${t.task} · ${t.status} · ${t.grade.completed?'verified completion':'not completed'} · ${seconds(t.elapsedMs)}${t.error?` · ${t.error}`:''}`));
    report.append(el('p',`Results saved locally: ${current.dataDir}. Unknown usage and cost remain unknown.`,'muted'));
  }
  async function refresh(){try{const s=await api.diagnosticsSnapshot();if(disposed)return;current=s;systemOverview.update(s.system);if(!loaded){variants.value=JSON.stringify(s.defaultPlan.variants,null,2);loaded=true;}status.textContent=localError||s.problem|| (s.running?'Diagnostic campaign running':s.inventory?.ready?'Hermes connection checked; ready to run':'Check Hermes to verify the current model connection');identity.textContent=s.inventory?`${s.inventory.harness} · ${s.inventory.model} · reasoning ${s.inventory.reasoning} · ${s.inventory.hardware.logicalCpus} logical CPUs · ${(s.inventory.hardware.ramBytes/2**30).toFixed(1)} GiB RAM`:'No verified harness connection yet.';start.disabled=busy||s.running;cancel.disabled=!s.running;renderReport();}catch(e){if(!disposed)status.textContent=e.message||String(e);}}
  void refresh();const timer=setInterval(refresh,1500);
  return ()=>{disposed=true;clearInterval(timer);};
}
