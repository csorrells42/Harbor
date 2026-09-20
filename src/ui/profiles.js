import {createDeliveryPanel} from './delivery-settings.js';
import {CONNECTION_CLIENTS,formatClientConfiguration,clientConnectionSteps,clientConnectionHelp} from '../core/client-config.js';
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node;}
function button(text,action,className='ghost'){const node=el('button',className,text);node.type='button';node.addEventListener('click',action);return node;}

export function mountProfiles(root,api){
  let disposed=false,snapshot,selected,version=0,timer,busy=false;
  const toolbar=el('div','section-toolbar'),select=el('select');select.setAttribute('aria-label','Selected profile');
  const status=el('p','notice');status.id='profile-status';status.setAttribute('role','status');
  const error=el('p','form-error');error.id='profile-error';error.setAttribute('role','alert');
  const editor=el('div'),runtime=el('section','connection-card');runtime.setAttribute('aria-label','Profile sessions');
  toolbar.append(select,button('New profile',()=>show(undefined)),button('Reload profiles',()=>load(select.value)));
  root.replaceChildren(toolbar,status,error,editor,runtime);
  const report=err=>{error.textContent=err.message??String(err);};
  async function attempt(operation){error.textContent='';try{await operation();}catch(err){report(err);}}
  function field(grid,name,label,value,type='text'){
    const wrap=el('div','field'),input=el(type==='select'?'select':'input'),caption=el('label','',label);input.id='profile-'+name;caption.htmlFor=input.id;
    if(type!=='select')input.type=type;input.value=value??'';wrap.append(caption,input);grid.append(wrap);return input;
  }
  async function load(id=selected?.id){
    await attempt(async()=>{snapshot=await api.getProfiles();if(disposed)return;
      select.replaceChildren();for(const profile of [snapshot.defaultProfile,...snapshot.profiles]){const option=el('option','',profile.name);option.value=profile.id;select.append(option);}
      select.value=id&&snapshot.profiles.some(profile=>profile.id===id)?id:'default';
      await show(select.value==='default'?snapshot.defaultProfile:snapshot.profiles.find(profile=>profile.id===select.value));await refreshRuntime();
    });
  }
  async function show(profile){
    const current=++version;selected=profile;error.textContent='';status.textContent='';editor.replaceChildren();
    if(profile?.id==='default'){
      editor.append(el('section','connection-card','Default uses the existing server startup choices and Tool Delivery settings. Named profiles have separate settings.'));
      return;
    }
    if(profile)select.value=profile.id;else select.selectedIndex=-1;
    const form=el('form','connection-card');form.noValidate=true;form.append(el('h2','',profile?'Edit '+profile.name:'New profile'));
    const grid=el('div','form-grid');form.append(grid);
    const name=field(grid,'name','Profile name',profile?.name),id=field(grid,'id','Profile ID',profile?.id);id.disabled=!!profile;
    const isolation=field(grid,'isolation','Process ownership',undefined,'select');
    for(const [value,label] of [['shared','Share existing server processes'],['process','Separate native process per client session']]){const option=el('option','',label);option.value=value;isolation.append(option);}isolation.value=profile?.isolation??'shared';
    const idle=field(grid,'idle','Idle session expiry (minutes)',profile?.sessionIdleMinutes??15,'number');idle.min=1;idle.max=1440;
    const boundary=el('p','notice');const updateBoundary=()=>{boundary.textContent=isolation.value==='process'?'Each client owns separate native stdio child processes. Files, working directories, credentials and external services can still be shared. Remote and WSL servers do not support this isolation.':'Clients share upstream processes and mutable state. A profile is a configuration boundary, not separate authorization. Shared servers follow their existing Start and Stop controls.';};isolation.addEventListener('change',updateBoundary);updateBoundary();form.append(boundary);
    const servers=el('fieldset','profile-choices');servers.append(el('legend','','Enabled servers'));const boxes=new Map();
    for(const server of snapshot.servers){const label=el('label','delivery-method'),input=el('input');input.type='checkbox';input.checked=profile?.serverIds.includes(server.id)??false;input.setAttribute('aria-label','Include '+server.name);
      const text=el('span');text.append(el('strong','',server.name),el('small','',server.id+' · '+server.transport+' / '+server.runtime+' · '+server.status+' · '+(server.transport==='stdio'&&server.runtime==='native'?'Separate process supported; configured data can still be shared.':'Shared connection only; external service state is shared.')));label.append(input,text);servers.append(label);boxes.set(server.id,input);}
    if(!snapshot.servers.length)servers.append(el('p','hint','Add a server in Children Servers Statuses to include it here.'));form.append(servers);
    if(profile?.missingServerIds.length)form.append(el('p','notice','Unavailable servers: '+profile.missingServerIds.join(', ')+'. Saving removes these selections.'));
    const capabilities=el('fieldset','profile-choices');capabilities.append(el('legend','','Enabled capability types'));const capabilityInputs=new Map();
    for(const value of ['tools','resources','prompts']){const label=el('label','delivery-method'),input=el('input');input.type='checkbox';input.checked=(profile?.capabilities??['tools','resources','prompts']).includes(value);label.append(input,document.createTextNode(value));capabilities.append(label);capabilityInputs.set(value,input);}form.append(capabilities);
    form.append(el('p','hint','Existing sessions keep their saved revision. Reconnect to apply edits. Resources and prompts come from running selected servers. Resource subscriptions end when their upstream connection stops; reconnect or subscribe again after restarting it.'));
    const save=el('button','primary','Save profile');save.type='submit';const actions=el('div','actions');actions.append(save);
    if(profile){
      const remove=button('Delete profile',()=>{confirm.hidden=!confirm.hidden;});actions.append(remove);
      const confirm=el('div','notice');confirm.hidden=true;confirm.append(el('p','','Delete this profile and disconnect its sessions? Owned children stop; shared server processes keep running.'),button('Confirm delete',()=>attempt(async()=>{await api.removeProfile(profile.id,{expectedRevision:profile.revision});await load();status.textContent='Profile deleted.';}),'danger'));form.append(confirm);
      actions.append(button('Disconnect profile sessions',()=>attempt(async()=>{await api.disconnectProfile(profile.id);status.textContent='Profile sessions disconnected. Shared processes remain available.';await refreshRuntime();})));
    }
    form.append(actions);editor.append(form);
    form.addEventListener('submit',event=>{event.preventDefault();if(save.disabled)return;attempt(async()=>{save.disabled=true;try{
      const saved=await api.saveProfile({id:id.value.trim(),name:name.value.trim(),serverIds:[...boxes].filter(([,input])=>input.checked).map(([key])=>key),isolation:isolation.value,sessionIdleMinutes:Number(idle.value),capabilities:[...capabilityInputs].filter(([,input])=>input.checked).map(([key])=>key),delivery:profile?.delivery??snapshot.defaultProfile.delivery},{expectedRevision:profile?.revision??0});
      await load(saved.id);status.textContent='Saved revision '+saved.revision+'. Existing sessions retain their previous revision.';
    }finally{save.disabled=false;}});});
    if(!profile)return;
    let deliveryProfile=profile;
    const delivery=createDeliveryPanel({el,button,getSettings:()=>deliveryProfile.delivery,api:{updateDeliverySettings:async input=>{deliveryProfile=await api.saveProfileDelivery(profile.id,deliveryProfile.revision,input);}},onSaved:async()=>{await load(profile.id);status.textContent='Saved delivery revision '+deliveryProfile.revision+'. Reconnect clients to apply it.';}});
    const deliveryDetails=el('details','connection-card');deliveryDetails.append(el('summary','','Profile tool delivery and search settings'),delivery.root);editor.append(deliveryDetails);
    try{
      const info=await api.profileConnectionInfo(profile.id);if(disposed||current!==version)return;
      const connection=el('section','connection-card');connection.append(el('h3','','Help with connections'),el('p','mono',info.endpoint),el('p','hint','Copy configuration exports settings for your client. It does not configure or control the client application. The preview hides the saved API key; copying includes it when authentication is enabled.'));
      const format=field(connection,'format','Configuration format',undefined,'select');for(const [value,label] of [['http','Streamable HTTP'],['stdio','Stdio bridge']]){const option=el('option','',label);option.value=value;format.append(option);}
      const client=field(connection,'client','Client application',undefined,'select');for(const [value,label] of CONNECTION_CLIENTS){const option=el('option','',label);option.value=value;client.append(option);}
      const steps=el('ol','client-setup-steps'),caption=el('p','hint'),preview=el('pre','mono');preview.setAttribute('aria-label','Profile connection preview');const render=()=>{const help=clientConnectionHelp(client.value);if(!help.formats.includes(format.value))format.value=help.formats[0];for(const option of format.options){option.disabled=!help.formats.includes(option.value);option.hidden=option.disabled;}caption.textContent=help.caption;preview.textContent=formatClientConfiguration(format.value==='http'?info.httpConfig:info.stdioConfig,client.value);steps.replaceChildren(...clientConnectionSteps(client.value,format.value).map(step=>el('li','',step)));};format.addEventListener('change',render);client.addEventListener('change',render);render();connection.append(el('p','hint','Setup recipe: reconnect and check the tools in your client to verify compatibility with its version.'),steps,caption,preview);
      const test=button('Test connection',()=>attempt(async()=>{test.disabled=true;status.textContent='Connecting to the saved profile and listing enabled capabilities…';try{const result=await api.testProfileConnection(profile.id);status.textContent='Connected: '+result.server.name+' '+result.server.version+' · profile revision '+result.revision+' · '+result.toolCount+' advertised tools · '+(result.resourceCount??0)+' resources · '+(result.templateCount??0)+' resource templates · '+(result.promptCount??0)+' prompts. '+(result.listingErrors?.length?'Some catalogs could not be listed; inspect Activity. ':'')+'Test session closed; no tool invoked.';await refreshRuntime();}finally{test.disabled=false;}}));
      const controls=el('div','actions');controls.append(button('Copy configuration',()=>attempt(async()=>{await api.copyConnectionConfiguration({format:format.value,endpoint:info.endpoint,profileId:profile.id,client:client.value});status.textContent='Configuration copied'+(info.authentication.enabled?' with the saved gateway API key.':'.');})),test);connection.append(controls);editor.append(connection);
    }catch(err){if(current===version)report(err);}
  }
  async function refreshRuntime(){
    if(disposed||busy)return;busy=true;try{const fresh=await api.getProfiles();if(disposed)return;
      runtime.replaceChildren(el('h3','','Active profile sessions'));
      const clients=fresh.clients.filter(client=>client.profileId===(selected?.id??''));
      if(!clients.length)runtime.append(el('p','hint','No active sessions for this profile.'));
      for(const client of clients)runtime.append(el('p','',client.name+' · revision '+client.profileRevision+' · '+client.isolation+' · '+client.id));
      for(const context of fresh.runtimes.filter(value=>value.profileId===selected?.id))for(const server of context.servers)runtime.append(el('p','hint',server.name+' · '+server.status+' · PID '+(server.pid??'unavailable')+' · '+context.ownerCount+' session owner(s) · revision '+context.revision));
      runtime.append(el('p','hint','Requests: '+fresh.admission.public.active+' active, '+fresh.admission.public.queued+' queued. Session limit: '+fresh.admission.maxSessions+'.'));
    }catch(err){report(err);}finally{busy=false;}
  }
  select.addEventListener('change',()=>show(select.value==='default'?snapshot.defaultProfile:snapshot.profiles.find(profile=>profile.id===select.value)));
  void load();timer=setInterval(refreshRuntime,2000);return ()=>{disposed=true;version++;clearInterval(timer);};
}
