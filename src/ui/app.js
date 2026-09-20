import {DELIVERY_MODES,SEARCH_DEFAULTS} from '../core/delivery-options.js';
import {CONNECTION_CLIENTS,formatClientConfiguration,clientConnectionSteps,clientConnectionHelp} from '../core/client-config.js';
import {createDeliveryPanel} from './delivery-settings.js';
import { parseServerForm, createTemplate, parseImport } from './helpers.js';
import { createAdvisor } from './advisor.js';

const $ = selector => document.querySelector(selector);
const api = window.harbor;
let advisor,deliveryPanel,gatewayAuthPanel,disposeDiagnostics,disposeTimeline,disposeProfiles,viewRevision=0;
const state = { view:'servers', snapshot:{servers:[],tools:[],clients:[],logs:[]}, info:null, loaded:false, search:'', filter:'all', busy:new Set(), editing:null, signature:'', polling:false };
const paths = {
  harbor:'M12 3v14m-4-6 4 4 4-4M5 12H3a9 9 0 0 0 18 0h-2M9 4h6',
  servers:'M4 3h16v7H4zM4 14h16v7H4zM7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6',
  tools:'m14 4 6 6M4 20l8-8m-2-5 3-4 8 8-4 3-7-7ZM3 21l-1-1 7-7 2 2-8 6Z',
  activity:'M2 12h4l3-8 6 16 3-8h4',
  connections:'M8 8H5a4 4 0 0 0 0 8h4m7-8h3a4 4 0 0 1 0 8h-4M7 12h10',
  shield:'m12 3 8 3v5c0 5-5 8-8 10-3-2-8-5-8-10V6l8-3Zm-4 9 3 3 5-6',
  search:'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 6 6',
  plus:'M12 5v14M5 12h14', import:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  git:'M6 3v12a5 5 0 0 0 10 0V9M3 3a3 3 0 1 0 6 0M13 6a3 3 0 1 0 6 0',
  code:'m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  play:'m8 4 12 8-12 8V4Z', info:'M12 16v-5m0-4h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z',
  app:'M3 4h18v14H3zM8 22h8m-4-4v4', copy:'M8 8h13v13H8zM16 8V3H3v13h5'
};
function icon(name) {
  const node = document.createElementNS('http://www.w3.org/2000/svg','svg');
  for(const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.5','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'})) node.setAttribute(key,value);
  const path = document.createElementNS(node.namespaceURI,'path'); path.setAttribute('d',paths[name] ?? paths.servers); node.append(path); return node;
}
function el(tag, className, text) { const node=document.createElement(tag); if(className)node.className=className; if(text!==undefined)node.textContent=String(text); return node; }
function button(text, action, className='', symbol) { const node=el('button',className); node.type='button'; if(symbol)node.append(icon(symbol)); node.append(document.createTextNode(text)); node.addEventListener('click',action); return node; }
function message(target,text) {
  const node=$(target);node.textContent=text;node.hidden=!text;
  if(text&&node.classList.contains('form-error'))node.scrollIntoView({block:'nearest'});
}
let toastTimer;
function toast(text) { clearTimeout(toastTimer); message('#toast',text); toastTimer=setTimeout(()=>message('#toast',''),4500); }
function errorText(error) { return error?.message || String(error); }
async function copy(text) { try { await api.copy(String(text)); toast('Copied to clipboard'); } catch(error) { toast(errorText(error)); } }
function showDialog(id) { $(id).showModal(); }
function metric(label,value,symbol) { const node=el('div','metric'); const title=el('span','metric-label'); title.append(icon(symbol),document.createTextNode(label)); node.append(title,el('strong','',value)); return node; }
function sharedNote() { const note=el('div','shared-note'); note.append(icon('info'),el('span','','One upstream per server. Connected apps share its tools and mutable state — use separate entries to isolate projects.')); return note; }
function searchBox(label) { const wrap=el('div','search-wrap'); const input=el('input'); input.type='search'; input.placeholder=label; input.setAttribute('aria-label',label); input.value=state.search; input.addEventListener('input',()=>{state.search=input.value;renderLive(true);});wrap.append(icon('search'),input);return wrap; }
function setView(view) {
  const revision=++viewRevision;
  disposeDiagnostics?.();disposeDiagnostics=undefined;
  disposeTimeline?.();disposeTimeline=undefined;
  disposeProfiles?.();disposeProfiles=undefined;
  state.view=view;state.search='';state.filter='all';state.signature='';
  document.querySelectorAll('[data-view]').forEach(node=>{const active=node.dataset.view===view;node.classList.toggle('active',active);if(active)node.setAttribute('aria-current','page');else node.removeAttribute('aria-current');});
  const title=view==='timeline'?'Request timeline':view==='tool-delivery'?'Tool Delivery':view==='this-server'?'This Server':view==='servers'?'Children Servers Statuses':view[0].toUpperCase()+view.slice(1); $('#breadcrumb-view').textContent=title;$('#page-title').textContent=title;
  $('#page-subtitle').textContent={timeline:'Inspect requests, discovery and execution with bounded local traces.','tool-delivery':'Control how your model finds tools and receives search results.',diagnostics:'Compare Harbor delivery for one fixed harness and model setup.',advisor:'Choose the tools for this task, not every tool at once.','this-server':'Connection details and settings for your MCP gateway.',servers:'Manage the servers behind your AI tools.',tools:'Explore the tools available through your gateway.',activity:'A live view of server lifecycle and diagnostic logs.',connections:'One local endpoint for all your MCP-compatible apps.',maintenance:'Update and rebuild your bundled tools on request.'}[view];
  const actions=$('#page-actions');actions.replaceChildren();const content=$('#content');content.replaceChildren();
  if(view==='profiles'){
    $('#page-subtitle').textContent='Separate toolboxes, explicit ownership and saved client connections.';
    import('./profiles.js').then(({mountProfiles})=>{if(state.view==='profiles'&&revision===viewRevision)disposeProfiles=mountProfiles(content,api);}).catch(error=>toast(errorText(error)));
  } else if(view==='timeline'){
    import('./request-timeline.js').then(({mountRequestTimeline})=>{if(state.view==='timeline'&&revision===viewRevision)disposeTimeline=mountRequestTimeline(content,api);}).catch(error=>toast(errorText(error)));
  } else if(view==='diagnostics'){
    const target=content;import('../diagnostics/ui.js').then(({mountDiagnostics})=>{if(state.view==='diagnostics'&&revision===viewRevision)disposeDiagnostics=mountDiagnostics(target,api);}).catch(error=>toast(errorText(error)));
  } else if(view==='servers') {
    actions.append(button('Import config',openImport,'ghost','import'),button('Add server',()=>openEditor(),'primary','plus'));
    content.append(el('div','summary-grid')); const toolbar=el('div','section-toolbar');const heading=el('h3','','All servers ');heading.append(el('span','count','0'));toolbar.append(heading,searchBox('Search servers…'));content.append(toolbar,el('div','results')); 
  } else if(view==='tools'||view==='activity') {
    const toolbar=el('div','section-toolbar');toolbar.append(searchBox(view==='tools'?'Search tools…':'Search activity…'));
    const filters=el('div','filters');const select=el('select');select.setAttribute('aria-label',view==='tools'?'Filter tools by server':'Filter activity level');
    const options=view==='tools'?[['all','All servers'],...state.snapshot.servers.map(s=>[s.id,s.name])]:[['all','All levels'],['error','Errors'],['warn','Warnings'],['info','Info'],['debug','Debug']];
    for(const [value,label] of options){const option=el('option','',label);option.value=value;select.append(option);}
    select.addEventListener('change',()=>{state.filter=select.value;renderLive(true);});filters.append(select);toolbar.append(filters);content.append(toolbar,el('div','results'));
  } else {
    content.append(el('div','results'));
  }
  renderLive(true);
}
function renderLive(force=false) {
  const {servers,tools,clients}=state.snapshot;
  if(state.info?.portableRoot){document.title='Harbor Portable';$('#brand-name').textContent='Harbor Portable';$('#brand-edition').textContent='PORTABLE WORKSPACE';}
  $('#nav-servers').textContent=servers.length;$('#nav-tools').textContent=tools.length;
  $('#status-summary').textContent=state.loaded?`${servers.length} servers · ${tools.length} tools · ${clients.length} connected apps`:'Loading workspace…';
  const selected=['servers','advisor'].includes(state.view)?servers:state.snapshot[state.view==='activity'?'logs':state.view==='connections'?'clients':'tools'];
  const signature=JSON.stringify([selected,state.search,state.filter,[...state.busy],state.loaded,tools.length,clients.length,state.info,state.snapshot.settings,state.snapshot.authentication,state.snapshot.endpoints,state.snapshot.maintenance,state.snapshot.maintenanceReady,state.snapshot.maintenanceTransition,state.snapshot.maintenanceInfo]);
  if(!force&&signature===state.signature)return;state.signature=signature;
  const results=$('#content .results');if(!results)return;
  if(state.view==='servers') {
    $('.summary-grid').replaceChildren(metric('Servers running',servers.filter(s=>s.status==='running').length,'servers'),metric('Available tools',tools.length,'tools'),metric('Connected apps',clients.length,'connections'));
    $('.section-toolbar .count').textContent=servers.length;
    renderServers(results);
  } else if(state.view==='advisor') {
    if(!advisor){
      advisor=createAdvisor({el,button,api,refresh,getSnapshot:()=>state.snapshot,openEditor});
      advisor.update(state.snapshot);
    }
    if(!results.contains(advisor.root))results.replaceChildren(advisor.root);
  } else if(state.view==='tools') renderTools(results);
  else if(state.view==='activity') renderActivity(results);
  else if(state.view==='tool-delivery'){
    if(!deliveryPanel)deliveryPanel=createDeliveryPanel({el,button,api,getSettings:()=>state.snapshot.settings??state.info.settings,onSaved:async()=>{await refresh(true);state.info=await api.connectionInfo();}});
    if(!results.contains(deliveryPanel.root))results.replaceChildren(deliveryPanel.root);deliveryPanel.update();
  }
  else if(state.view==='this-server') renderThisServer(results);
  else if(state.view==='maintenance') renderMaintenance(results);
  else renderConnections(results);
}
function renderMaintenance(results){
  const info=state.snapshot.maintenanceInfo,paused=state.snapshot.maintenance,ready=state.snapshot.maintenanceReady===true,transition=state.snapshot.maintenanceTransition;
  const panel=el('div','connection-card');panel.append(el('h2','','Maintenance'),el('p','muted','Check project repositories and build updates when you request them. Entering maintenance pauses tool calls and stops Harbor-owned servers. Existing selections and project data are retained.'));
  const act=async operation=>{try{await operation();await refresh();}catch(error){toast(errorText(error));}};
  const toggle=button(transition==='entering'?'Stopping servers…':transition==='leaving'?'Resuming servers…':ready?'Resume servers':paused?'Retry maintenance':'Enter maintenance mode',()=>act(()=>ready?api.leaveMaintenance():api.enterMaintenance()),'primary');toggle.disabled=!!info?.busy||!!transition;panel.append(toggle);
  if(paused&&!ready&&!transition)panel.append(el('p','notice','Server shutdown did not finish. Updates remain unavailable; retry maintenance after resolving the reported error.'));
  if(!info){panel.append(el('p','hint','Portable build recipes are not present in this installation.'));results.replaceChildren(panel);return;}
  panel.append(el('p','hint',`${info.phase}: ${info.message}`));if(info.error)panel.append(el('p','form-error',info.error));
  for(const component of info.components){
    const card=el('div','connection-card');card.append(el('h3','',component.name),el('p','mono',component.repository),el('p','muted',component.notes));
    const buttons=el('div','actions');
    for(const [label,operation] of [ ['Update and build',()=>api.updateComponent(component.id,{rebuild:false})],['Rebuild',()=>api.updateComponent(component.id,{rebuild:true})],['Restore previous',()=>api.rollbackComponent(component.id)] ]){
      if(label==='Restore previous'&&component.canRestore===false)continue;
      const b=button(label,()=>act(operation),'ghost');b.disabled=!ready||!!transition||info.busy||(label==='Update and build'&&!component.updatable);buttons.append(b);
    }
    card.append(buttons);panel.append(card);
  }
  const log=el('pre','mono',info.log.join('\n'));log.setAttribute('aria-label','Maintenance log');panel.append(log);results.replaceChildren(panel);
}
function simpleEmpty(target,title,description,symbol){const card=el('div','empty-card');card.append(icon(symbol),el('h2','',title),el('p','',description));target.replaceChildren(card);}
function renderTools(results){
  if(!state.snapshot.tools.length){simpleEmpty(results,'Your tools will appear here.','Start a server to discover its tools. Harbor exposes namespaced tool names to keep servers from colliding.','tools');return;}
  const query=state.search.trim().toLowerCase();const tools=state.snapshot.tools.filter(tool=>(state.filter==='all'||tool.serverId===state.filter)&&[tool.name,tool.originalName,tool.description,tool.serverId].some(value=>String(value??'').toLowerCase().includes(query)));
  if(!tools.length){results.replaceChildren(el('div','no-results','No tools match your filters.'));return;}
  const list=el('div','tool-list');for(const tool of tools){const row=button('',()=>inspectTool(tool),'tool-row');const text=el('div');text.append(el('strong','mono',tool.name),el('p','',tool.description||'No description provided by this server.'));row.append(icon('tools'),text,el('span','tag',tool.serverId),el('span','muted','↗'));list.append(row);}results.replaceChildren(list,sharedNote());
}
function inspectTool(tool){$('#schema-title').textContent=tool.name;$('#schema-description').textContent=tool.description||'No description provided.';$('#schema-meta').textContent=`Server: ${tool.serverId} · Original name: ${tool.originalName??tool.name}`;$('#schema-json').textContent=JSON.stringify(tool.inputSchema??{},null,2);showDialog('#schema-dialog');}
$('#copy-schema').addEventListener('click',()=>copy($('#schema-json').textContent));
function renderActivity(results){
  if(!state.snapshot.logs.length){simpleEmpty(results,'A quiet harbor.','Server startup, shutdown and diagnostic messages will appear here. Add and start a server to see activity.','activity');return;}
  const query=state.search.trim().toLowerCase();const logs=state.snapshot.logs.filter(log=>(state.filter==='all'||log.level===state.filter)&&[log.message,log.serverId,log.level].some(value=>String(value??'').toLowerCase().includes(query)));
  if(!logs.length){results.replaceChildren(el('div','no-results','No activity matches your filters.'));return;}
  const list=el('div','log-list');list.setAttribute('aria-label','Activity log');
  for(const log of [...logs].reverse()){
    const level=['info','warn','error','debug'].includes(log.level)?log.level:'info';const row=el('div',`log-row level-${level}`);const date=new Date(log.time);const time=el('time','log-time',Number.isNaN(date.valueOf())?String(log.time):date.toLocaleTimeString([], {hour12:false}));time.title=String(log.time);row.append(time,el('span','log-level',log.level),el('span','log-server',log.serverId||'Harbor'),el('span','log-message',log.message));list.append(row);
  }
  results.replaceChildren(el('p','hint',`${logs.length} messages · newest first · bounded in-memory history`),list);
}
// Keep the form node (including drafts, focus and errors) across polls and navigation.
let settingsForm=null;
function activeAuthentication() {
  return state.snapshot.authentication??state.info?.authentication??{enabled:false,hasKey:false};
}
function activeLoopbackOnly() {
  return !(state.snapshot.settings??state.info?.settings)?.networkEnabled;
}
function createGatewayAuthPanel() {
  const root=el('form','connection-card settings-form gateway-auth-form');root.id='gateway-auth-form';root.noValidate=true;
  root.append(el('h3','','Gateway access'),el('p','muted','Choose whether to use an API key and limit connections to this computer. Both options are independent. Applying changes reconnects the gateway; reconnect your apps afterward.'));
  const status=el('p','hint');status.id='gateway-auth-status';status.setAttribute('role','status');root.append(status);
  const options=el('div','gateway-protection-options');const requirement=el('label','network-ack');const enabled=el('input');enabled.type='checkbox';enabled.id='gateway-auth-enabled';requirement.htmlFor=enabled.id;requirement.append(enabled,document.createTextNode('Use API key'));
  const loopbackLabel=el('label','network-ack');const loopback=el('input');loopback.type='checkbox';loopback.id='gateway-loopback-only';loopbackLabel.htmlFor=loopback.id;loopbackLabel.append(loopback,document.createTextNode('Loopback only'));options.append(requirement,loopbackLabel);root.append(options);
  const networkNotice=el('p','notice');networkNotice.id='gateway-network-notice';root.append(networkNotice);
  const field=el('div','field');const label=el('label','','Gateway API key');const key=el('input');key.id='gateway-auth-key';label.htmlFor=key.id;key.type='password';key.autocomplete='new-password';key.spellcheck=false;key.setAttribute('aria-describedby','gateway-auth-key-help');
  const help=el('small','','Leave blank to keep the saved key. A generated key takes effect only after Apply protections. Copy key copies the saved key.');help.id='gateway-auth-key-help';field.append(label,key,help);root.append(field);
  const actions=el('div','actions');const result=el('p','hint');result.id='gateway-auth-result';result.setAttribute('role','status');
  const error=el('div','form-error');error.id='gateway-auth-error';error.setAttribute('role','alert');error.hidden=true;
  let dirty=false,busy=false;
  const showError=text=>{error.textContent=text;error.hidden=false;error.scrollIntoView({block:'nearest'});};
  const generate=button('Generate new key',async()=>{
    if(busy)return;busy=true;error.hidden=true;update();
    try{const draft=await api.generateGatewayKey();if(typeof draft!=='string'||!draft.trim())throw new Error('No key generated');key.value=draft;dirty=true;result.textContent='New key generated. Apply protections to save it.';}
    catch{showError('Could not generate an API key. Try again. Your current draft is preserved.');}
    finally{busy=false;update();}
  },'ghost');
  const copySaved=button('Copy key',async()=>{
    if(busy)return;busy=true;error.hidden=true;update();
    try{await api.copyGatewayKey();result.textContent='Saved API key copied to clipboard.';}
    catch{showError('Could not copy the saved API key. Try again.');}
    finally{busy=false;update();}
  },'ghost','copy');actions.append(generate,copySaved);root.append(actions);
  const apply=el('button','primary','Apply protections');apply.type='submit';const footer=el('div','connection-top');footer.append(result,apply);root.append(error,footer);
  root.addEventListener('input',()=>{dirty=true;result.textContent='Unsaved protection changes';});
  root.addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;error.hidden=true;
    const draft=key.value.trim();
    if(enabled.checked&&!draft&&!activeAuthentication().hasKey){showError('Enter an API key or generate a new key before requiring authentication.');return;}
    busy=true;update();result.textContent='Applying protections…';let saved=false;
    try{
      const authentication=await api.updateGatewayAuth({enabled:enabled.checked,loopbackOnly:loopback.checked,...(draft?{key:draft}:{})});
      saved=true;key.value='';dirty=false;state.snapshot.authentication={enabled:!!authentication.enabled,hasKey:!!authentication.hasKey};
      if(state.info)state.info.authentication={...state.snapshot.authentication};
      if(typeof authentication.loopbackOnly==='boolean'){state.snapshot.settings={...(state.snapshot.settings??state.info?.settings),networkEnabled:!authentication.loopbackOnly};if(state.info)state.info.settings={...state.snapshot.settings};}
      update();settingsForm?.updateAuthentication?.();
      await refresh(true);state.info=await api.connectionInfo();renderLive(true);
      result.textContent='Protections applied. Reconnect your apps using the saved configuration.';
    }catch(err){
      const details=draft?errorText(err).split(draft).join('[hidden key]'):errorText(err);
      showError(saved?`Protections were saved, but active details could not refresh: ${details} Check the gateway connection before retrying.`:`Could not apply protections: ${details} Your draft is preserved. Review your choices and retry.`);result.textContent='';
    }finally{busy=false;update();}
  });
  function update(){
    const authentication=activeAuthentication();
    status.textContent=authentication.enabled?'API key required for gateway connections.':`Authentication is disabled.${authentication.hasKey?' A saved key is available.':' No API key is saved.'}`;
    if(!dirty){enabled.checked=authentication.enabled;loopback.checked=activeLoopbackOnly();}
    const localOnly=activeLoopbackOnly();status.textContent+=localOnly?' Loopback only is on.':' Loopback only is off.';
    networkNotice.textContent=localOnly?'Only apps on this computer can connect to the gateway.':authentication.enabled?'Network access is enabled and an API key is required. Traffic uses HTTP and is not encrypted. Harbor does not change firewall or router settings.':'Network access is enabled without an API key. Anyone who can reach this endpoint can use its tools. Traffic uses HTTP and is not encrypted. Harbor does not change firewall or router settings.';
    key.placeholder=authentication.hasKey?'Saved key hidden — enter a replacement':'Enter or generate an API key';
    enabled.disabled=loopback.disabled=key.disabled=generate.disabled=apply.disabled=busy;copySaved.disabled=busy||!authentication.hasKey;
  }
  update();return {root,update};
}
function createSettingsForm(settings) {
  const form=el('form','connection-card settings-form');form.id='settings-form';form.noValidate=true;
  form.append(el('h3','','Gateway settings'),el('p','muted','Changes apply only when saved. Endpoint changes disconnect clients; reconnect them afterward. Child servers stay running.'));
  const grid=el('div','form-grid');
  const fields={};
  function field(name,label,value,type='text') {
    const wrap=el('div','field');const caption=el('label','',label);caption.htmlFor=`setting-${name}`;
    const input=el(type==='textarea'?'textarea':'input');input.id=caption.htmlFor;input.name=name;
    if(type!=='textarea')input.type=type;else input.rows=3;
    if(type==='checkbox')input.checked=value;else input.value=String(value);
    fields[name]=input;wrap.append(caption,input);grid.append(wrap);return input;
  }
  field('port','Port',settings.port,'number');
  field('mcpPath','MCP path',settings.mcpPath);
  const deliveryLink=button('Configure tool delivery',()=>setView('tool-delivery'),'ghost');grid.append(deliveryLink);
  field('requestTimeout','Initialization / discovery timeout (seconds)',settings.requestTimeoutMs/1000,'number');
  field('toolTimeout','Tool timeout (seconds)',settings.toolTimeoutMs/1000,'number');
  const bind=field('bindAddress','Bind address',settings.bindAddress);
  form.append(grid);
  const syncNetwork=()=>{bind.disabled=activeLoopbackOnly();};form.updateAuthentication=syncNetwork;syncNetwork();
  const origins=field('allowedOrigins','Allowed origins (JSON array)',JSON.stringify(settings.allowedOrigins,null,2),'textarea');
  origins.parentElement.classList.add('wide-field');
  origins.parentElement.append(el('small','','Advanced · explicit http(s) browser origins only. [] rejects arbitrary browser origins; this is not authentication.'));
  const error=el('div','form-error');error.id='settings-error';error.setAttribute('role','alert');error.hidden=true;
  const result=el('p','hint');result.id='settings-result';result.setAttribute('role','status');
  const apply=el('button','primary','Apply settings');apply.type='submit';
  const footer=el('div','connection-top');footer.append(result,apply);form.append(error,footer);
  form.addEventListener('input',()=>{result.textContent='Unsaved changes';});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(apply.disabled)return;error.hidden=true;result.textContent='';let saved=false;
    try {
      let allowedOrigins;
      try {allowedOrigins=JSON.parse(origins.value);}catch{throw new Error('Allowed origins must be a valid JSON array of strings.');}
      if(!Array.isArray(allowedOrigins)||allowedOrigins.some(value=>typeof value!=='string'))throw new Error('Allowed origins must be a JSON array of strings.');
      const next={toolMode:'all',...SEARCH_DEFAULTS,...await api.getSettings(),port:Number(fields.port.value),bindAddress:bind.value.trim(),mcpPath:fields.mcpPath.value.trim(),requestTimeoutMs:Number(fields.requestTimeout.value)*1000,toolTimeoutMs:Number(fields.toolTimeout.value)*1000,allowedOrigins};
      if(!Number.isInteger(next.port)||next.port<1||next.port>65535)throw new Error('Port must be an integer from 1 to 65535.');
      for(const [name,value] of [['Initialization / discovery timeout',next.requestTimeoutMs],['Tool timeout',next.toolTimeoutMs]])if(!Number.isInteger(value)||value<1000||value>3600000)throw new Error(`${name} must be from 1 to 3600 seconds, with millisecond precision.`);
      apply.disabled=true;result.textContent='Applying settings…';
      await api.updateSettings(next);saved=true;
      await refresh(true);
      state.info=await api.connectionInfo();
      result.textContent='Settings applied. Reconnect your model client if the endpoint or tool delivery changed so it refreshes its tool list.';renderLive(true);
    } catch(err) {
      error.textContent=saved?`Settings were saved, but could not refresh active details: ${errorText(err)} Check the gateway connection before retrying. Your draft is preserved.`:`Could not apply settings: ${errorText(err)} Review the values and retry. Your draft is preserved.`;error.hidden=false;result.textContent='';error.scrollIntoView({block:'nearest'});
    } finally {apply.disabled=false;}
  });
  return form;
}
function renderThisServer(results) {
  const settings=state.snapshot.settings??state.info?.settings;
  if(!settings){simpleEmpty(results,'Getting gateway settings…','Waiting for the desktop gateway.','harbor');return;}
  if(!settingsForm)settingsForm=createSettingsForm(settings);
  if(!gatewayAuthPanel)gatewayAuthPanel=createGatewayAuthPanel();
  if(!results.contains(settingsForm)){results.replaceChildren(el('div','this-server-connection'),gatewayAuthPanel.root,settingsForm);}
  gatewayAuthPanel.update();settingsForm.updateAuthentication();
  const details=results.querySelector('.this-server-connection');
  renderConnections(details,false);
}
let snippetMode='http', snippetClient='lmstudio', snippetAddress=null, configurationsOpen=false;
// Change only exact endpoint values; never interpolate untrusted data into HTML.
function withEndpoint(config,from,to) {
  if(typeof config==='string')return config===from?to:config;
  if(Array.isArray(config))return config.map(value=>withEndpoint(value,from,to));
  if(config&&typeof config==='object')return Object.fromEntries(Object.entries(config).map(([key,value])=>[key,withEndpoint(value,from,to)]));
  return config;
}
function connectionTemplate(info,format,endpoint) {
  const config=withEndpoint(format==='http'?info.httpConfig:info.stdioConfig,info.endpoint,endpoint);
  const entry=config?.mcpServers?.harbor;
  if(entry){
    // A snapshot can confirm an auth change before refreshed templates arrive.
    // Render only placeholders; the desktop process owns actual-secret copies.
    const property=format==='http'?'headers':'env';const values={...entry[property]};
    for(const name of Object.keys(values))if(format==='http'?name.toLowerCase()==='authorization':name==='HARBOR_API_KEY')delete values[name];
    if(activeAuthentication().enabled)values[format==='http'?'Authorization':'HARBOR_API_KEY']=format==='http'?'Bearer <YOUR_HARBOR_API_KEY>':'<YOUR_HARBOR_API_KEY>';
    if(Object.keys(values).length)entry[property]=values;else delete entry[property];
  }
  return config;
}
function renderConnections(results,includeClients=true){
  const previousConfigs=results.querySelector('.client-configurations');
  if(!includeClients&&previousConfigs)configurationsOpen=previousConfigs.open;
  results.replaceChildren();const info=state.info;
  if(!info){simpleEmpty(results,'Getting connection details…','Waiting for the desktop gateway. No credentials or configuration are sent outside your machine.','connections');return;}
  const endpoint=state.snapshot.endpoints?.local??info.endpoint;
  const networkEndpoints=state.snapshot.endpoints?.network??info.networkEndpoints??[];
  const bindAddress=state.snapshot.endpoints?.bindAddress??info.bindAddress;
  const gateway=el('section','connection-card');gateway.append(el('h3','','Active connection'),el('p','','Streamable HTTP · MCP tools gateway. Keep Harbor open while using your tools.'));
  const line=el('div','endpoint-line');line.append(icon('connections'),el('code','',endpoint),button('Copy endpoint',()=>copy(endpoint),'ghost','copy'));gateway.append(line);
  for(const [index,url] of networkEndpoints.entries()){
    const row=el('div','endpoint-line network-endpoint');row.append(el('span','hint','LAN'),el('code','',url),button(`Copy network endpoint ${index+1}`,()=>copy(url),'ghost','copy'));gateway.append(row);
  }
  gateway.append(el('p','hint',`Listening on ${bindAddress??'unknown'} · ${networkEndpoints.length?'Network access enabled':'No network URLs advertised'}`));
  gateway.append(el('p','hint',`Tool delivery: ${Object.fromEntries(DELIVERY_MODES)[state.snapshot.settings?.toolMode??info.settings?.toolMode??'all']}`));
  if(info.serverName)gateway.append(el('p','hint',`Protocol server: ${info.serverName}${info.version?` · ${info.version}`:''}`));
  gateway.append(el('p','hint',(activeAuthentication().enabled?'API key required for gateway connections. Traffic uses HTTP and is not encrypted.':'No authentication. Any process or device that can reach the endpoint can use its exposed capabilities.')+' Tools, resources and prompts follow the selected profile. Sampling and elicitation are unsupported.'));
  const configs=el('details','client-configurations');configs.open=includeClients||configurationsOpen;configs.append(el('summary','','Help with connections'));configs.addEventListener('toggle',()=>{if(!includeClients&&configs.isConnected)configurationsOpen=configs.open;});
  const clientField=el('div','field'),clientLabel=el('label','','Client application'),clientSelect=el('select');clientLabel.htmlFor='configuration-client';clientSelect.id=clientLabel.htmlFor;
  for(const [value,label] of CONNECTION_CLIENTS){const option=el('option','',label);option.value=value;clientSelect.append(option);}clientSelect.value=snippetClient;
  clientSelect.addEventListener('change',()=>{snippetClient=clientSelect.value;renderLive(true);});clientField.append(clientLabel,clientSelect);configs.append(clientField);
  const addressField=el('div','field');const caption=el('label','','Configuration address');caption.htmlFor='configuration-address';const addresses=el('select');addresses.id=caption.htmlFor;
  const choices=[endpoint,...networkEndpoints];if(!choices.includes(snippetAddress))snippetAddress=endpoint;
  choices.forEach((url,index)=>{const option=el('option','',`${index?'LAN':'Local'} · ${url}`);option.value=url;addresses.append(option);});addresses.value=snippetAddress;
  addresses.addEventListener('change',()=>{snippetAddress=addresses.value;renderLive(true);});addressField.append(caption,addresses);configs.append(addressField);
  const help=clientConnectionHelp(snippetClient);if(!help.formats.includes(snippetMode))snippetMode=help.formats[0];
  const selectedLine=el('div','endpoint-line connection-string');selectedLine.append(el('span','hint','Connection string'),el('code','',snippetAddress),button('Copy selected endpoint',()=>copy(snippetAddress),'ghost','copy'));configs.append(selectedLine);
  const segmented=el('div','segmented');segmented.setAttribute('aria-label','Configuration format');
  for(const [value,label] of [['http','Streamable HTTP'],['stdio','Stdio bridge']]){if(!help.formats.includes(value))continue;const b=button(label,()=>{snippetMode=value;renderLive(true);},snippetMode===value?'active':'');b.setAttribute('aria-pressed',String(snippetMode===value));segmented.append(b);}
  const snippet=formatClientConfiguration(connectionTemplate(info,snippetMode,snippetAddress),snippetClient);
  const steps=el('ol','client-setup-steps');for(const step of clientConnectionSteps(snippetClient,snippetMode))steps.append(el('li','',step));configs.append(segmented,el('p','hint','Setup recipe: support depends on your client version. A saved configuration is not a verified connection. Reconnect and check the tools in your client.'),steps);
  configs.append(el('p','hint',help.caption),el('pre','',snippet));const copyRow=el('div','connection-top');copyRow.append(el('span','hint',activeAuthentication().enabled?'Example key is hidden. Copy configuration includes the saved key; keep the clipboard and pasted configuration private.':'Use the copied settings in the selected client, then reconnect your app.'),button('Copy configuration',async()=>{try{await api.copyConnectionConfiguration({format:snippetMode,endpoint:snippetAddress,client:snippetClient});toast('Configuration copied to clipboard');}catch{toast('Could not copy the connection configuration. Refresh the connection details and try again.');}},'ghost','copy'));configs.append(copyRow);gateway.append(configs);
  gateway.append(el('p','config-path',`Children configuration: ${info.configPath}`),el('p','config-path',`Gateway settings: ${info.settingsPath??'Unavailable'}`));results.append(gateway);
  if(!includeClients)return;
  const clients=el('section','connection-card');const heading=el('div','connection-top');heading.append(el('h3','','Connected apps'),el('span','tag',`${state.snapshot.clients.length} sessions`));clients.append(heading);
  if(!state.snapshot.clients.length){const empty=el('div','clients-empty');const text=el('div');text.append(el('h3','','No apps connected yet'),el('p','','Add the endpoint or bridge configuration to an MCP client. Active sessions will appear here.'));empty.append(icon('app'),text);clients.append(empty);}
  else for(const client of state.snapshot.clients){const row=el('div','client-row');const details=el('div','client-details');const date=new Date(client.connectedAt);details.append(el('strong','',client.name||'Unnamed MCP client'),el('small','',`Version ${client.version||'unknown'} · Connected ${Number.isNaN(date.valueOf())?client.connectedAt:date.toLocaleString()}`));row.append(icon('app'),details,el('span','status-dot'));row.classList.add('online');clients.append(row);}
  results.append(clients,sharedNote());
}
function renderServers(results) {
  results.replaceChildren();
  if(!state.loaded){results.append(el('div','no-results','Loading workspace…'));return;}
  if(!state.snapshot.servers.length) {
    const card=el('div','empty-card');const diagram=el('div','harbor-diagram');diagram.setAttribute('aria-hidden','true');
    for(const [i,symbol] of ['servers','harbor','app'].entries()){if(i)diagram.append(el('span','diagram-line'));const node=el('span','diagram-node'+(i===1?' center':''));node.append(icon(symbol));diagram.append(node);}
    card.append(diagram,el('h2','','Your MCP servers, one harbor.'),el('p','','Start a server once. Connect your favorite AI apps to a single local endpoint, without managing a process for every client.'));
    const actions=el('div','actions');actions.append(button('Add your first server',()=>openEditor(),'primary','plus'),button('Import config',openImport,'ghost'));card.append(actions,el('span','hint','No servers configured. Nothing is running in the background.'));
    results.append(card);
    const onboarding=el('div','onboarding');
    for(const [title,desc,symbol,kind] of [['Serena','Semantic code navigation and editing.','code','serena'],['Git','Repository history, diffs and changes.','git','git'],['Custom server','Your command or HTTP endpoint.','servers','custom']]){
      const b=button('',()=>openEditor(null,kind),'onboarding-card'); const text=el('div');text.append(el('strong','',title),el('p','',desc));b.append(icon(symbol),text,el('span','arrow','↗'));onboarding.append(b);
    }
    results.append(onboarding,sharedNote());return;
  }
  const query=state.search.trim().toLowerCase(); const filtered=state.snapshot.servers.filter(s=>[s.name,s.id,s.command,s.url,s.runtime,s.transport].some(value=>String(value??'').toLowerCase().includes(query)));
  if(!filtered.length){results.append(el('div','no-results','No servers match your search.'));return;}
  const list=el('div','server-list');
  for(const server of filtered){
    const card=el('article','server-card');card.dataset.serverId=server.id;const main=el('div','server-main');const avatar=el('span','server-avatar');avatar.append(icon(server.transport==='stdio'?'servers':'connections'));
    const details=el('div','server-details');const command=server.transport==='stdio'? [server.command,...(server.args??[])].join(' '):server.url;
    details.append(el('h3','',server.name),el('div','server-command mono',command));details.lastChild.title=command??'';
    const status=['running','starting','stopped','error'].includes(server.status)?server.status:'stopped';const badge=el('span',`status-badge status-${status}`);badge.append(el('span','status-dot'),document.createTextNode(status[0].toUpperCase()+status.slice(1)));main.append(avatar,details,badge);card.append(main);
    if(server.error)card.append(el('div','server-error',server.error));
    const footer=el('div','server-footer');const tags=el('div','server-tags');for(const text of [server.transport==='stdio'?(server.runtime==='wsl'?'WSL · stdio':'Native · stdio'):(server.transport==='sse'?'SSE':'HTTP'),`${server.toolCount??0} tools`,server.pid?`PID ${server.pid}`:server.transport==='stdio'?'No active PID':'Remote process',server.id])tags.append(el('span','tag',text));
    if(server.enabled===false)tags.append(el('span','tag','Disabled for use'));
    else if(server.onDemand)tags.append(el('span','tag',server.onDemandBlocked?'On-demand suppressed by Stop':server.idleUncertain?'Idle shutdown paused: request outcome unknown':`${server.cachedToolCount??0} cached tools · on demand${server.onDemandOwned?' · idle shutdown enabled':''}`));
    if(server.transport!=='stdio') {
      const owned=server.ownership==='managed'||server.managedProcesses?.length;
      tags.append(el('span','tag',owned?'Harbor-owned processes':'Externally managed · connection only'));
      for(const process of server.processes??[])tags.append(el('span','tag',process.runtime==='wsl'?`WSL PID ${process.pid??'starting'} · launcher ${process.launcherPid??'starting'}`:`Owned PID ${process.pid??'starting'}`));
    }
    const actions=el('div','actions');
    if(status==='running'||status==='starting')actions.append(button('Stop',()=>serverAction('stopServer',server.id),'ghost'));
    else actions.append(button('Start',()=>serverAction('startServer',server.id),'','play'));
    if(status==='running'||status==='error')actions.append(button('Restart',()=>serverAction('restartServer',server.id),'ghost'));
    actions.append(button('Configure',()=>openEditor(server),'ghost'),button('Remove',()=>confirmRemove(server),'ghost'));
    actions.querySelectorAll('button').forEach(b=>{b.disabled=state.busy.has(server.id)||(server.enabled===false&&['Start','Restart'].includes(b.textContent));if(server.enabled===false&&['Start','Restart'].includes(b.textContent))b.title='Enable this server for use in Configure first';});footer.append(tags,actions);card.append(footer);list.append(card);
  }
  results.append(list,sharedNote());
}
let refreshTask=null;
async function refresh(afterMutation=false) {
  if(refreshTask){await refreshTask;if(afterMutation)return refresh(true);return;}
  refreshTask=(async()=>{
    try {
      state.snapshot=await api.snapshot();state.loaded=true;
      // Observe every accepted snapshot, even off-tab or when rendering is skipped.
      // The keyed Advisor root stays alive; mounting must not update it a second time.
      advisor?.update(state.snapshot);
      message('#connection-error','');const status=$('#gateway-status');status.classList.add('online');status.replaceChildren(el('span','status-dot'),document.createTextNode(state.snapshot.settings?.networkEnabled?'Gateway online · network enabled':'Gateway online · loopback only'));renderLive();
    }
    catch(error){message('#connection-error',`Cannot reach Harbor: ${errorText(error)}. Retrying automatically; displayed data may be stale.`);$('#gateway-status').classList.remove('online');$('#gateway-status').replaceChildren(el('span','status-dot'),document.createTextNode('Gateway unavailable'));return error;}
  })();
  let failure;
  try{failure=await refreshTask;}finally{refreshTask=null;}
  // Poll callers share a non-rejecting task; mutation callers still require verification.
  if(afterMutation&&failure)throw failure;
}
async function serverAction(method,id) { if(state.busy.has(id))return;state.busy.add(id);renderLive(true);try{await api[method](id);await refresh(true);}catch(error){toast(errorText(error));}finally{state.busy.delete(id);renderLive(true);} }
function populateForm(config={}) {
  for(const name of ['id','name','command','cwd','url','distro'])$(`[name="${name}"]`).value=config[name]??'';
  $('#transport').value=config.transport??'stdio';$('#runtime').value=config.runtime??'native';
  $('#args').value=JSON.stringify(config.args??[],null,2);$('#env').value=JSON.stringify(config.env??{},null,2);
  $('#managedProcesses').value=JSON.stringify(config.managedProcesses??[],null,2);
  $('#autoStart').checked=config.autoStart===true;$('#autoRestart').checked=config.autoRestart===true;syncFields();
  $('#server-enabled').checked=config.enabled!==false;$('#onDemand').checked=config.onDemand===true;$('#idleMinutes').value=config.idleMinutes??5;
}
function syncFields(){const remote=$('#transport').value!=='stdio';$('#stdio-fields').hidden=remote;$('#remote-fields').hidden=!remote;$('#runtime-field').hidden=remote;$('#distro-field').hidden=$('#runtime').value!=='wsl';$('#browse-directory').disabled=$('#runtime').value==='wsl';}
function openEditor(server=null,template='custom') {
  state.editing=server?.id??null;$('#server-form').reset();populateForm(server??{});$('#server-id').readOnly=!!server;$('#editor-title').textContent=server?'Edit server':'Add server';$('#template-field').hidden=!!server;$('#template').value=template;$('#template-setup').hidden=true;message('#form-error','');$('#save-hint').textContent=server?'Saving stops this server. Start it again when ready.':'Saving does not start a new server.';showDialog('#server-dialog');syncTemplate();$('#server-name').focus();
}
function syncTemplate() {
  const kind=$('#template').value;$('#template-setup').hidden=kind==='custom'||!!state.editing;
  $('#template-description').textContent=kind==='serena'?'Serena · semantic navigation, editing and project memory.':'Git · inspect and change a repository through MCP tools.';
  $('#template-prerequisite').textContent=kind==='serena'?'Requires Serena installed and initialized in this runtime. Official setup: uv tool install -p 3.13 serena-agent, then serena init. Harbor does not run these setup commands.':'Requires uvx and Git in this runtime. uvx may download mcp-server-git the first time you explicitly start the server.';
}
$('#template').addEventListener('change',syncTemplate);
$('#template-browse').addEventListener('click',async()=>{try{const path=await api.chooseDirectory();if(path)$('#template-repo').value=path;}catch(error){message('#form-error',errorText(error));}});
$('#apply-template').addEventListener('click',()=>{
  try{const config=createTemplate($('#template').value,$('#template-repo').value,$('#runtime').value);populateForm(config);message('#form-error','');toast('Template applied. Review configuration before saving.');}
  catch(error){message('#form-error',errorText(error));}
});
function openImport(){ $('#import-form').reset();message('#import-error','');showDialog('#import-dialog');$('#import-json').focus(); }
$('#import-file').addEventListener('change',async()=>{
  try{const file=$('#import-file').files[0];if(!file)return;if(file.size>1024*1024)throw new Error('Config file is too large. Maximum size is 1 MB.');$('#import-json').value=await file.text();message('#import-error','');}catch(error){message('#import-error',errorText(error));}
});
$('#import-form').addEventListener('submit',async event=>{
  event.preventDefault();const submit=$('#import-submit');submit.disabled=true;message('#import-error','');
  try{const config=parseImport($('#import-json').value);const collisions=Object.keys(config.mcpServers).filter(id=>state.snapshot.servers.some(s=>s.id===id));if(collisions.length)throw new Error(`Server IDs already exist: ${collisions.join(', ')}. Rename them before importing.`);await api.importConfig(config);await refresh(true);$('#import-dialog').close();setView('servers');toast('Servers imported. Start them when you’re ready.');}
  catch(error){message('#import-error',errorText(error));}finally{submit.disabled=false;}
});
let removeTarget=null;
function confirmRemove(server){removeTarget=server;const ownership=server.transport==='stdio'||server.managedProcesses?.length?'This stops its owned processes.':'This disconnects Harbor but does not stop the external process.';$('#confirm-description').textContent=`Remove “${server.name}” and its saved configuration? ${ownership} Its tools are removed for every connected app. This cannot be undone.`;showDialog('#confirm-dialog');}
$('#confirm-remove').addEventListener('click',async()=>{if(!removeTarget)return;const id=removeTarget.id;$('#confirm-dialog').close();await serverAction('removeServer',id);removeTarget=null;});
$('#server-form').addEventListener('submit',async event=>{
  event.preventDefault();message('#form-error','');const save=$('#save-server');save.disabled=true;
  try{
    const form=Object.fromEntries(new FormData(event.currentTarget));form.autoStart=$('#autoStart').checked;form.autoRestart=$('#autoRestart').checked;
    form.enabled=$('#server-enabled').checked;form.onDemand=$('#onDemand').checked;
    const config=parseServerForm(form);
    if(!state.editing&&state.snapshot.servers.some(s=>s.id===config.id))throw new Error('This server ID already exists. Choose a unique ID.');
    await api.saveServer(config);await refresh(true);$('#server-dialog').close();toast('Server configuration saved');
  }catch(error){message('#form-error',errorText(error));}finally{save.disabled=false;}
});
$('#transport').addEventListener('change',syncFields);$('#runtime').addEventListener('change',syncFields);
$('#browse-directory').addEventListener('click',async()=>{try{const path=await api.chooseDirectory();if(path)$('#cwd').value=path;}catch(error){message('#form-error',errorText(error));}});
for(const node of document.querySelectorAll('[data-close]'))node.addEventListener('click',()=>document.getElementById(node.dataset.close).close());
for(const node of document.querySelectorAll('[data-view]'))node.addEventListener('click',()=>setView(node.dataset.view));
for(const node of document.querySelectorAll('[data-icon]'))node.append(icon(node.dataset.icon));
$('#sidebar-connect').addEventListener('click',()=>setView('this-server'));
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='k'&&!$('dialog[open]')){event.preventDefault();$('#content input[type="search"]')?.focus();}});
setView('servers');
if(!api){message('#connection-error','Desktop API unavailable. Open MCP Harbor through the desktop application.');$('#gateway-status').textContent='Desktop connection required';}
else{refresh();api.connectionInfo().then(info=>{state.info=info;renderLive(true);}).catch(error=>toast(errorText(error)));const timer=setInterval(refresh,1500);window.addEventListener('beforeunload',()=>clearInterval(timer));}
