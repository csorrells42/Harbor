import {DELIVERY_MODES,LOCAL_MODELS,SEARCH_DEFAULTS} from '../core/delivery-options.js';
const explanations={
  all:'Send every tool and its instructions up front. Simple, but a large toolbox takes more of the model’s context.',
  bm25:'Search by words. Returns the best word matches with instructions for calling each tool. No extra model or account.',
  regex:'Search by text patterns. Useful for exact names or groups of tools. The calling model needs to understand regular expressions. No extra model or account.',
  code:'Find tools, inspect their inputs, then combine calls using short Python code. Useful for multi-step work. Experimental; no extra AI model or account.',
  'portkey-local':'Search by meaning, even when the wording differs. Uses a small model bundled with Harbor and runs on your CPU. No account or internet needed.',
  'portkey-api':'Search by meaning using your chosen embedding service or local server. Enter its address and model below; provide a key if required.',
  'portkey-workers':'Search by meaning using Cloudflare Workers AI. Requires a Cloudflare account, embedding model and API key.',
  hybrid:'Combine at least two distinct methods into one result list. Duplicate tools appear once, with their full calling instructions. Send everything is not available in Hybrid.'
};
export function createDeliveryPanel({el,button,api,getSettings,onSaved}){
  const initial={...SEARCH_DEFAULTS,...getSettings()},form=el('form','connection-card delivery-panel');form.id='delivery-form';form.noValidate=true;
  const active=el('p','hint');form.append(active,el('h3','','How tools are returned'),el('p','muted','Choose what your model sees. Harbor remembers these choices for the next launch.'));
  const grid=el('div','form-grid');form.append(grid);const fields={},boxes=new Map(),keys={},keyStatus={};
  function field(name,label,value,type='text',target=grid){
    const wrap=el('div','field'),caption=el('label','',label),input=el(type==='select'?'select':'input');caption.htmlFor=`delivery-${name}`;input.id=caption.htmlFor;
    if(type!=='select')input.type=type;if(type==='checkbox')input.checked=value;else input.value=value??'';
    wrap.append(caption,input);target.append(wrap);fields[name]=input;return input;
  }
  const mode=field('toolMode','Tool delivery',initial.toolMode??'all','select');mode.parentElement.classList.add('wide-field');
  for(const [id,title] of DELIVERY_MODES){const option=el('option','',title);option.value=id;mode.append(option);}mode.value=initial.toolMode??'all';
  const explanation=el('p','delivery-explanation');mode.parentElement.append(explanation);
  const hybrid=el('div','wide-field delivery-methods');hybrid.append(el('h3','','Combine methods'),el('p','hint','Choose two or more different methods. Code Mode also adds Python execution.'));grid.append(hybrid);
  for(const [id,title] of DELIVERY_MODES.filter(([id])=>!['all','hybrid'].includes(id))){const label=el('label','delivery-method'),input=el('input');input.type='checkbox';input.checked=initial.hybridModes.includes(id);input.id=`hybrid-${id}`;const text=el('span');text.append(el('strong','',title),el('small','',explanations[id]));label.append(input,text);hybrid.append(label);boxes.set(id,input);}
  const results=field('searchLimit','Results per search method',initial.searchLimit,'number');results.min='1';results.max='50';results.parentElement.append(el('small','','Each method returns up to this many tools. Hybrid merges the lists, so its total may be larger.'));
  const tuning=el('details','wide-field delivery-tuning');tuning.append(el('summary','','Search settings'));const tuningGrid=el('div','form-grid');tuning.append(tuningGrid);grid.append(tuning);
  const score=field('semanticMinScore','Minimum relevance',initial.semanticMinScore,'number',tuningGrid);score.min='0';score.max='1';score.step='0.05';score.parentElement.append(el('small','','0 allows more matches; 1 requires a near-exact meaning match. Default: 0.25.'));
  const local=field('portkeyLocalModel','Local search model',initial.portkeyLocalModel,'select',tuningGrid);
  for(const model of LOCAL_MODELS){const option=el('option','',model.replace('Xenova/','')+(model===LOCAL_MODELS[0]?' · smallest, default':''));option.value=model;local.append(option);}local.value=initial.portkeyLocalModel;
  const providers=[];
  for(const [prefix,id,label] of [['portkeyApi','portkey-api','OpenAI-compatible service'],['portkeyWorkers','portkey-workers','Cloudflare Workers AI']]){
    const section=el('div','wide-field delivery-provider');section.append(el('h3','',label),el('p','hint','This service receives your search text and tool descriptions.'));const providerGrid=el('div','form-grid');section.append(providerGrid);grid.append(section);providers.push({id,section});
    field(prefix+'Url','Embedding service URL',initial[prefix+'Url'],'url',providerGrid);field(prefix+'Model','Embedding model name',initial[prefix+'Model'],'text',providerGrid);
    const key=field(prefix+'Key','API key',undefined,'password',providerGrid);key.autocomplete='new-password';keys[prefix]=key;
    const status=el('small');keyStatus[prefix]=status;key.parentElement.append(status,el('small','','Saved locally in Harbor. In the portable edition, saved keys travel with the folder.'));
    key.parentElement.append(button('Remove saved key',()=>{key.value='';key.dataset.remove='true';status.textContent='Key will be removed when you apply.';},'ghost'));key.addEventListener('input',()=>{delete key.dataset.remove;});
    if(prefix==='portkeyApi')field('noApiKey','This endpoint does not require an API key',false,'checkbox',providerGrid);
    const advanced=el('details','wide-field');advanced.append(el('summary','','Provider details'));const sub=el('div','form-grid');advanced.append(sub);providerGrid.append(advanced);field(prefix+'Dimensions','Embedding dimensions',initial[prefix+'Dimensions'],'number',sub);
    if(prefix==='portkeyWorkers')section.append(el('small','','Use your Cloudflare account AI v1 URL and an @cf/ model name.'));
  }
  const guide=el('details','wide-field delivery-guide');guide.append(el('summary','','All modes explained'));for(const [id,title] of DELIVERY_MODES){const row=el('div');row.append(el('strong','',title),el('p','muted',explanations[id]));guide.append(row);}grid.append(guide);
  const error=el('p','form-error');error.id='delivery-error';error.setAttribute('role','alert');error.hidden=true;
  const status=el('p','hint');status.id='delivery-result';status.setAttribute('role','status');
  const apply=el('button','primary','Apply tool delivery');apply.type='submit';const footer=el('div','connection-top');footer.append(status,apply);form.append(error,footer);
  const update=()=>{const settings=getSettings();active.textContent=`Active: ${Object.fromEntries(DELIVERY_MODES)[settings.toolMode??'all']}`;for(const prefix of Object.keys(keys))if(!keys[prefix].value&&!keys[prefix].dataset.remove)keyStatus[prefix].textContent=settings[prefix+'KeyFile']?'A key is saved. Leave blank to keep it.':'No key saved. Paste one here; no file editing needed.';};
  const sync=()=>{const methods=mode.value==='hybrid'?[...boxes].filter(([,b])=>b.checked).map(([id])=>id):[mode.value];explanation.textContent=explanations[mode.value];hybrid.hidden=mode.value!=='hybrid';results.parentElement.hidden=mode.value==='all';tuning.hidden=!methods.some(m=>m.startsWith('portkey-'));local.parentElement.hidden=!methods.includes('portkey-local');for(const p of providers)p.section.hidden=!methods.includes(p.id);};
  form.addEventListener('change',sync);form.addEventListener('input',()=>{status.textContent='Unsaved changes';});sync();update();
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(apply.disabled)return;error.hidden=true;status.textContent='';
    try{
      const settings={toolMode:mode.value,hybridModes:[...boxes].filter(([,b])=>b.checked).map(([id])=>id)};
      if(settings.hybridModes.length<2){if(mode.value==='hybrid')throw new Error('Select at least two distinct Hybrid methods.');settings.hybridModes=getSettings().hybridModes??[...SEARCH_DEFAULTS.hybridModes];}
      for(const key of Object.keys(SEARCH_DEFAULTS))if(fields[key])settings[key]=fields[key].type==='number'?Number(fields[key].value):fields[key].value.trim();
      if(!Number.isInteger(settings.searchLimit)||settings.searchLimit<1||settings.searchLimit>50)throw new Error('Results per search method must be between 1 and 50.');
      const credentials={};for(const [prefix,input] of Object.entries(keys)){if(input.value.trim())credentials[prefix]=input.value.trim();else if(input.dataset.remove)credentials[prefix]=null;}
      if(fields.noApiKey.checked)credentials.portkeyApi='harbor-local-no-auth';
      apply.disabled=true;status.textContent='Applying…';await api.updateDeliverySettings({settings,credentials});
      for(const input of Object.values(keys)){input.value='';delete input.dataset.remove;}fields.noApiKey.checked=false;
      await onSaved();update();status.textContent='Saved. Reconnect your model client to refresh its tools.';
    }catch(err){error.textContent=err.message;error.hidden=false;status.textContent='';error.scrollIntoView({block:'nearest'});}finally{apply.disabled=false;}
  });
  return {root:form,update};
}
