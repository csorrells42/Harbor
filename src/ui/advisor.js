import {advise, categories, tierLabels} from './advisor-rules.js';
import {createMeasuredAdvice} from './measured-advice.js';

// Keep controls and keyed rows alive: polling must not steal focus or drafts.
export function createAdvisor({el,button,openEditor,api,refresh,getSnapshot}) {
  let servers=[];
  let busy=false;
  let choosing=false;
  const outcomes=new Map();
  const selected=new Set();
  const saving=new Set();
  const evidence=new Map();
  const pending=new Map();
  const launchIdentity=server=>JSON.stringify(['transport','runtime','command','args','cwd','env','url','distro','managedProcesses'].map(key=>server[key]));
  // Session-only launch evidence, invalidated by configuration change/removal.
  function verifiedIds(){
    const ids=new Set();
    for(const server of servers){
      const launch=launchIdentity(server);
      if(evidence.get(server.id)!==launch)evidence.delete(server.id);
      if(server.status==='running')evidence.set(server.id,launch);
      if(evidence.has(server.id))ids.add(server.id);
    }
    for(const id of evidence.keys())if(!servers.some(s=>s.id===id))evidence.delete(id);
    return ids;
  }
  const root=el('section','advisor');
  root.append(el('p','eyebrow','LOCAL ADVISOR · EXPLAINABLE RULES'),el('p','muted','Checked servers start with Harbor. Changes save immediately and stay selected across restarts. Task categories only change recommendations.'));
  root.append(createMeasuredAdvice({api}).root);
  const controls=el('div','advisor-controls');
  const label=el('label','','Task category');label.htmlFor='advisor-task';
  const task=el('select');task.id=label.htmlFor;
  for(const [value,text] of categories){const option=el('option','',text);option.value=value;task.append(option);}
  const field=el('div','field');field.append(label,task);controls.append(field);
  const networkLabel=el('label','advisor-choice');const internet=el('input');internet.type='checkbox';internet.checked=true;
  networkLabel.append(internet,document.createTextNode('Internet available for this task'));controls.append(networkLabel);
  const recommended=button('Use recommended selection',async()=>{
    // Replace the draft against running coverage, not the draft being replaced.
    const next=advise(servers,{category:task.value,internet:internet.checked,verified:verifiedIds()}).filter(entry=>entry.tier==='recommended'&&entry.selectable).map(entry=>entry.server.id);
    choosing=true;render();
    try{for(const server of servers){if(!!server.autoStart!==next.includes(server.id))await saveChoice(server.id,next.includes(server.id));}}
    finally{choosing=false;render();}
  });
  controls.append(recommended);root.append(controls);
  root.append(el('p','notice','Offline filters suggestions; it is not a machine sandbox or firewall. Local commands, browsers and custom servers may still access the network. Running means MCP connected, not business readiness.'));
  const actions=el('div','advisor-actions');
  const start=button('Start selected',()=>applySelection(false));
  const manage=button('Keep selected running',()=>applySelection(true),'primary');
  const result=el('p','hint');result.id='advisor-result';result.setAttribute('role','status');
  actions.append(start,manage);root.append(actions,el('p','hint','Checkboxes save startup preferences immediately. Unchecking also turns off automatic restart. Already running servers stay available until stopped. Start selected starts checked servers now. Keep selected running also enables automatic restart; saving that setting may briefly reconnect a server.'),result);
  const summary=el('p','hint');root.append(summary);
  const empty=el('p','no-results','No servers configured. Add or import servers in Children Servers Statuses.');root.append(empty);
  const list=el('div','advisor-list');list.setAttribute('aria-label','Configured server checklist');root.append(list);
  const rows=new Map();
  const entries=()=>advise(servers,{category:task.value,selected,internet:internet.checked,verified:verifiedIds()});
  const currentLaunch=(id,launch)=>selected.has(id)&&pending.get(id)===launch&&servers.some(s=>s.id===id&&launchIdentity(s)===launch);
  async function saveChoice(id,enabled){
    if(saving.has(id))return;
    saving.add(id);if(enabled)selected.add(id);else selected.delete(id);render();
    try{
      await api.setServerStartup(id,enabled);
      await refresh(true);servers=getSnapshot().servers;
      if(servers.find(s=>s.id===id)?.autoStart!==enabled)throw new Error('Startup preference was not verified');
      outcomes.set(id,enabled?'Saved: starts with Harbor.':'Saved: automatic startup and restart are off.');
    }catch(error){outcomes.set(id,`Could not save startup preference: ${error?.message??String(error)}`);}
    finally{saving.delete(id);syncSelection();render();}
  }
  function syncSelection(){for(const server of servers){if(saving.has(server.id))continue;if(server.autoStart)selected.add(server.id);else selected.delete(server.id);}}
  async function applySelection(managed){
    if(busy)return;
    // Preserve checklist order while binding each action to its original launch.
    const batch=[...selected].map(id=>servers.find(s=>s.id===id)).filter(Boolean).map(server=>[server.id,launchIdentity(server)]);
    for(const [id,launch] of batch)pending.set(id,launch);
    busy=true;outcomes.clear();result.textContent='Checking fresh server state…';render();
    try{
      for(const [id,launch] of batch){
        try{
          await refresh(true);servers=getSnapshot().servers;
          let entry=entries().find(e=>e.server.id===id);
          if(!entry){outcomes.set(id,'Skipped: server removed.');continue;}
          if(!selected.has(id))continue;
          if(!entry.selectable){outcomes.set(id,`Skipped: ${entry.reason}`);continue;}
          if(!currentLaunch(id,launch)){outcomes.set(id,'Skipped: launch configuration changed. Review and select again.');continue;}
          if(managed&&entry.server.status==='starting'){outcomes.set(id,'Skipped: starting. Wait for startup before changing management.');continue;}
          if(managed&&(!entry.server.autoStart||!entry.server.autoRestart)){
            outcomes.set(id,'Saving automatic management…');render();
            const {status,error,toolCount,pid,ownership,processes,...config}=entry.server;
            await api.saveServer({...config,autoStart:true,autoRestart:true});
            await refresh(true);servers=getSnapshot().servers;
            const saved=servers.find(s=>s.id===id);
            if(!saved?.autoStart||!saved?.autoRestart)throw new Error('Automatic settings were not verified. Review Configure before retrying.');
            if(!selected.has(id))continue;
            if(!currentLaunch(id,launch)||launchIdentity(saved)!==launchIdentity(config))throw new Error('Launch configuration changed after saving. Review Configure before retrying.');
            entry=entries().find(e=>e.server.id===id);
            if(!entry.selectable){outcomes.set(id,`Skipped: ${entry.reason}`);continue;}
          }
          if(entry.server.status==='stopped'){
            outcomes.set(id,'Starting…');render();await api.startServer(id);
          } else if(!managed||entry.server.status!=='running'){
            outcomes.set(id,`Unchanged: ${entry.server.status}. Start only applies to stopped entries; use individual controls to retry errors.`);continue;
          }
          await refresh(true);servers=getSnapshot().servers;
          const actual=servers.find(s=>s.id===id);
          if(!currentLaunch(id,launch))throw new Error('Launch configuration changed before verification.');
          if(managed&&(!actual?.autoStart||!actual?.autoRestart))throw new Error('Automatic settings were not verified after startup.');
          outcomes.set(id,actual?.status==='running'?(managed?'Verified managed and running (MCP connection only).':'Verified running (MCP connection only).'):`Start not running: ${actual?.status??'removed'}. ${actual?.error??'Review Activity and individual controls.'}`);
        }catch(error){
          outcomes.set(id,currentLaunch(id,launch)?`Could not start or verify: ${error?.message??String(error)}`:'Action interrupted: launch configuration changed or server removed. Review current state before retrying.');
        }
        render();
      }
      result.textContent=`Batch complete. Review per-server results below; unselected servers were unchanged.${managed?' Saved management is shown on each card.':' Automatic settings were unchanged.'}`;
    }finally{pending.clear();busy=false;render();}
  }
  function render(){
    for(const id of outcomes.keys())if(!servers.some(s=>s.id===id))outcomes.delete(id);
    for(const [id,launch] of pending){
      const server=servers.find(s=>s.id===id);
      if(!server||launchIdentity(server)!==launch)pending.delete(id);
    }
    const changing=busy||choosing||saving.size>0;
    task.disabled=changing;internet.disabled=changing;recommended.disabled=changing;start.disabled=changing||!selected.size;manage.disabled=changing||!selected.size;
    empty.hidden=servers.length>0;
    summary.textContent=`${selected.size} selected for startup · ${servers.filter(s=>s.status==='running').length} running · ${servers.length} configured.`;
    for(const entry of entries()){
      const {server}=entry;
      let row=rows.get(server.id);
      const launch=launchIdentity(server);
      if(row&&row.launch!==launch)outcomes.delete(server.id);
      if(!row){
        const card=el('article','advisor-card');card.dataset.advisorId=server.id;
        const check=el('input');check.type='checkbox';
        check.addEventListener('change',()=>saveChoice(server.id,check.checked));
        const caption=el('label','advisor-choice');const name=el('strong');caption.append(check,name);
        const tier=el('span','tag');const top=el('div','advisor-card-top');top.append(caption,tier);
        const reason=el('p','advisor-reason');reason.id=`advisor-reason-${server.id}`;check.setAttribute('aria-describedby',reason.id);
        const warnings=el('div','advisor-warnings');const meta=el('p','hint');
        const configure=button('Configure',()=>openEditor(servers.find(s=>s.id===server.id)),'ghost');
        const footer=el('div','advisor-card-footer');footer.append(meta,configure);
        const outcome=el('p','advisor-outcome');outcome.setAttribute('role','status');
        card.append(top,reason,warnings,footer,outcome);list.append(card);
        row={card,check,name,tier,reason,warnings,meta,configure,outcome};rows.set(server.id,row);
      }
      row.launch=launch;
      row.name.textContent=server.name;row.check.setAttribute('aria-label',`Select ${server.name}`);
      row.check.checked=selected.has(server.id);row.check.disabled=changing||(!entry.selectable&&!selected.has(server.id));row.configure.disabled=changing;
      row.card.classList.toggle('is-selected',row.check.checked);
      row.tier.textContent=tierLabels[entry.tier];row.tier.className=`tag advisor-tier-${entry.tier}`;row.reason.textContent=entry.reason;
      row.warnings.replaceChildren(...entry.warnings.map(text=>el('p','',text)));
      const network={required:'Internet required',conditional:'Internet depends on target',local:'Local capability',unknown:'Internet requirement unknown'}[entry.internet];
      row.meta.textContent=`${server.status} · ${server.toolCount??0} tools${server.pid?` · PID ${server.pid}`:''} · ${network} · ${server.id} · Autostart ${server.autoStart?'on':'off'} · Autorestart ${server.autoRestart?'on':'off'}`;
      const previous=outcomes.get(server.id);
      if(previous?.startsWith('Verified')&&(server.status!=='running'||(previous.includes('managed')&&(!server.autoStart||!server.autoRestart))))outcomes.set(server.id,'State changed since the last action. See current status and automatic settings above.');
      row.outcome.textContent=[outcomes.get(server.id),server.error].filter(Boolean).join(' · ');row.outcome.hidden=!row.outcome.textContent;
    }
    for(const [id,row] of rows)if(!servers.some(s=>s.id===id)){row.card.remove();rows.delete(id);selected.delete(id);}
  }
  task.addEventListener('change',render);internet.addEventListener('change',render);
  return {root,update(snapshot){servers=snapshot.servers;syncSelection();render();}};
}
