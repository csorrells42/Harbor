function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node;}

export function mountRequestTimeline(root,api) {
  let disposed=false,busy=false,timer,preview,page=0,lastSignature='',ready=false;
  const panel=el('section','connection-card');panel.append(el('h2','','Request timeline'),el('p','muted','Follow observed requests, discovery ranks and upstream execution. Separate discovery and invocation requests have unknown association unless Harbor observes their nesting.'));
  const form=el('form','settings-form');form.id='trace-settings';form.noValidate=true;
  const fields=el('div','form-grid');
  function field(label,id,type='number'){
    const wrapper=el('div','field'),caption=el('label','',label),input=el(type==='select'?'select':'input');
    caption.htmlFor=id;input.id=id;if(type!=='select')input.type=type;wrapper.append(caption,input);fields.append(wrapper);return input;
  }
  const mode=field('Capture mode','trace-mode','select');
  for(const [value,label] of [['off','Off'],['metadata','Metadata only'],['payload','Metadata and payloads']]){const option=el('option','',label);option.value=value;mode.append(option);}
  const maxEvents=field('Retained events','trace-max-events');maxEvents.min=100;maxEvents.max=10000;
  const retention=field('Retention in minutes','trace-retention');retention.min=1;retention.max=1440;
  const maxMiB=field('Maximum storage in MiB','trace-max-mib');maxMiB.min=1;maxMiB.max=32;
  const payloadKiB=field('Payload limit in KiB','trace-payload-kib');payloadKiB.min=1;payloadKiB.max=64;
  const acknowledgment=el('label','network-ack'),ack=el('input');ack.type='checkbox';ack.id='trace-payload-ack';acknowledgment.htmlFor=ack.id;
  acknowledgment.append(ack,document.createTextNode('Capture tool arguments and results. I understand redaction cannot detect every secret in arbitrary content.'));
  const apply=el('button','primary','Apply trace settings');apply.type='submit';
  const active=el('p','notice');active.id='trace-active';active.setAttribute('role','status');
  const error=el('p','form-error');error.id='trace-error';error.setAttribute('role','alert');
  form.append(fields,acknowledgment,apply);
  const settingsPanel=el('details','trace-settings-panel');settingsPanel.append(el('summary','','Capture and retention settings'),form);panel.append(active,settingsPanel,error);
  const controls=el('div','section-toolbar'),filter=el('input');filter.type='search';filter.placeholder='Filter by session, tool, server or outcome';filter.setAttribute('aria-label','Filter request timeline');
  const clear=el('button','ghost','Clear traces'),exportButton=el('button','ghost','Preview export');controls.append(filter,clear,exportButton);
  const summary=el('p','hint');summary.id='trace-summary';
  const list=el('div','trace-list');list.setAttribute('aria-label','Request timeline events');
  const exportPanel=el('section','connection-card');exportPanel.hidden=true;exportPanel.id='trace-export-preview';
  const exportSummary=el('p','notice'),exportText=el('pre','mono');exportText.setAttribute('aria-label','Trace export preview');
  const previous=el('button','ghost','Previous preview page'),next=el('button','ghost','Next preview page'),save=el('button','primary','Save previewed export'),pageLabel=el('span','hint');
  const exportControls=el('div','actions');exportControls.append(previous,pageLabel,next,save);
  exportPanel.append(el('h3','','Inspect before saving'),exportSummary,exportText,exportControls);
  root.replaceChildren(panel,controls,summary,list,exportPanel);
  let snapshot;
  const updateAck=()=>{acknowledgment.hidden=mode.value!=='payload';payloadKiB.disabled=mode.value!=='payload';};mode.addEventListener('change',updateAck);
  function drawEvents(force=false){
    if(!snapshot)return;
    const query=filter.value.trim().toLowerCase();
    const signature=JSON.stringify([snapshot.events,query]);
    if(!force&&signature===lastSignature)return;lastSignature=signature;
    const events=snapshot.events.filter(event=>[event.sessionId,event.tool,event.serverId,event.kind,event.outcome,event.clientName].some(value=>String(value??'').toLowerCase().includes(query)));
    const expanded=new Set([...list.querySelectorAll('details[open]')].map(row=>row.dataset.eventKey));
    list.replaceChildren();
    for(const event of [...events].reverse()){
      const row=el('details','trace-row'),heading=el('summary');
      heading.append(el('span','tag',event.status==='running'?'started':event.outcome),el('strong','',event.kind),el('span','mono',event.tool??''),el('span','hint',event.durationMs===undefined?event.time:event.durationMs.toFixed(2)+' ms'));
      row.dataset.eventKey=event.id+':'+event.status;row.open=expanded.has(row.dataset.eventKey);
      const detailText=JSON.stringify(event,null,2);
      const detail=el('pre','mono',detailText.length>16384?detailText.slice(0,16384)+'\n[Details truncated; inspect the full export]':detailText);row.append(heading,detail);list.append(row);
    }
    if(!events.length)list.append(el('p','muted','No captured requests match this view.'));
  }
  async function refresh(){
    if(disposed||busy)return;busy=true;
    try{
      snapshot=await api.traceSnapshot({limit:200});if(disposed)return;
      const settings=snapshot.settings;
      if(!ready){mode.value=settings.mode;maxEvents.value=settings.maxEvents;retention.value=settings.retentionMinutes;maxMiB.value=settings.maxBytes/1048576;payloadKiB.value=settings.payloadBytes/1024;updateAck();ready=true;}
      active.textContent=settings.mode==='payload'?'Payload capture is ON. Known credentials are redacted; arbitrary content may remain sensitive. Payload capture resets to metadata after restart.':settings.mode==='off'?'Capture is OFF. Retained events remain available until cleared or expired.':'Metadata capture is ON. Tool arguments, results and error messages are not collected.';
      summary.textContent=snapshot.total+' retained events · '+snapshot.bytes+' bytes · '+snapshot.evicted+' evicted · displaying up to 200 events · memory only';
      drawEvents();
    }catch(failure){if(!disposed)error.textContent=failure.message;}
    finally{busy=false;}
  }
  form.addEventListener('submit',async event=>{
    event.preventDefault();error.textContent='';
    if(mode.value==='payload'&&!ack.checked){error.textContent='Acknowledge payload capture before enabling it.';return;}
    apply.disabled=true;
    try{
      await api.updateTraceSettings({mode:mode.value,maxEvents:Number(maxEvents.value),retentionMinutes:Number(retention.value),maxBytes:Number(maxMiB.value)*1048576,payloadBytes:Number(payloadKiB.value)*1024});
      preview=undefined;exportPanel.hidden=true;await refresh();
    }catch(failure){error.textContent=failure.message;}finally{apply.disabled=false;}
  });
  filter.addEventListener('input',()=>drawEvents(true));
  clear.addEventListener('click',async()=>{try{await api.clearTraces();preview=undefined;exportPanel.hidden=true;await refresh();}catch(failure){error.textContent=failure.message;}});
  function drawPreview(){
    if(!preview)return;
    const pageSize=65536,pages=Math.max(1,Math.ceil(preview.text.length/pageSize));page=Math.min(Math.max(0,page),pages-1);
    exportText.textContent=preview.text.slice(page*pageSize,(page+1)*pageSize);
    pageLabel.textContent='Page '+(page+1)+' of '+pages;previous.disabled=page===0;next.disabled=page===pages-1;
    exportSummary.textContent=preview.events+' events · '+preview.payloadEvents+' with payloads · '+preview.bytes+' bytes. This frozen preview is the exact bundle that will be saved. Review every page before sharing.';
  }
  exportButton.addEventListener('click',async()=>{try{preview=await api.previewTraceExport();if(disposed)return;page=0;drawPreview();exportPanel.hidden=false;}catch(failure){error.textContent=failure.message;}});
  previous.addEventListener('click',()=>{page--;drawPreview();});next.addEventListener('click',()=>{page++;drawPreview();});
  save.addEventListener('click',async()=>{if(!preview)return;save.disabled=true;try{const result=await api.saveTraceExport(preview.token);if(result.saved)exportSummary.textContent='Saved '+result.name+'. Inspect the file before sharing it.';}catch(failure){error.textContent=failure.message;}finally{save.disabled=false;}});
  void refresh();timer=setInterval(()=>void refresh(),1500);
  return ()=>{disposed=true;clearInterval(timer);preview=undefined;};
}
