import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DEFAULT_SETTINGS,validateSettings} from './settings.mjs';
import {SEARCH_DEFAULTS} from './delivery-options.js';

export const PROFILE_DELIVERY_FIELDS=['toolMode',...Object.keys(SEARCH_DEFAULTS)];
const clone=value=>structuredClone(value);
const pickDelivery=settings=>Object.fromEntries(PROFILE_DELIVERY_FIELDS.map(key=>[key,clone(settings[key]??DEFAULT_SETTINGS[key])]));

export function validateProfile(input,{configs=[],settings=DEFAULT_SETTINGS,allowMissing=false,allowUnsupported=false}={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('A profile is required');
  if(typeof input.id!=='string'||!/^[a-z][a-z0-9-]{0,39}$/.test(input.id)||input.id==='default')throw new Error('Choose a profile ID using lowercase letters, numbers and hyphens; default is reserved');
  if(typeof input.name!=='string'||!input.name.trim()||input.name.length>80)throw new Error('Profile name must contain 1–80 characters');
  if(!Array.isArray(input.serverIds)||input.serverIds.length>256||input.serverIds.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,40}$/.test(id))||new Set(input.serverIds).size!==input.serverIds.length)throw new Error('Select unique server IDs');
  if(!allowMissing&&input.serverIds.some(id=>!configs.some(config=>config.id===id)))throw new Error('A selected server no longer exists; refresh the profile');
  const isolation=input.isolation??'shared';
  if(!['shared','process'].includes(isolation))throw new Error('Choose shared or per-session process isolation');
  if(isolation==='process'&&!allowUnsupported){
    const unsupported=configs.filter(config=>input.serverIds.includes(config.id)&&(config.transport!=='stdio'||config.runtime!=='native'));
    if(unsupported.length)throw new Error('Per-session process isolation requires native stdio servers: '+unsupported.map(config=>config.id).join(', '));
  }
  const capabilities=input.capabilities??['tools','resources','prompts'];
  if(!Array.isArray(capabilities)||!capabilities.length||capabilities.some(value=>!['tools','resources','prompts'].includes(value))||new Set(capabilities).size!==capabilities.length)throw new Error('Select supported capability types');
  const deliveryInput=input.delivery??{};
  if(!deliveryInput||typeof deliveryInput!=='object'||Array.isArray(deliveryInput)||Object.keys(deliveryInput).some(key=>!PROFILE_DELIVERY_FIELDS.includes(key)))throw new Error('Invalid profile delivery fields');
  const delivery=pickDelivery(validateSettings({...DEFAULT_SETTINGS,...pickDelivery(settings),...deliveryInput}));
  const sessionIdleMinutes=input.sessionIdleMinutes??15;
  if(!Number.isInteger(sessionIdleMinutes)||sessionIdleMinutes<1||sessionIdleMinutes>1440)throw new Error('Session idle expiry must be 1–1440 minutes');
  return {id:input.id,name:input.name.trim(),serverIds:[...input.serverIds],isolation,capabilities:[...capabilities],delivery,sessionIdleMinutes};
}

function presets(configs,settings){
  return [
    ['coding','Coding',/filesystem|git|serena|context7|browser-docs|general-local/],
    ['documents','Documents',/filesystem|word|excel|pdf|typst|markitdown|general-local/],
    ['research','Research',/browser|search|exa|fetch|context7|memory|sequential/],
    ['databases','Databases',/dbhub|duckdb|filesystem/]
  ].map(([id,name,pattern],index)=>({...validateProfile({id,name,serverIds:configs.filter(config=>pattern.test(config.id)).map(config=>config.id)},{configs,settings}),revision:index+1}));
}

export async function createProfileStore({file,getConfigs,getSettings}){
  let state,queue=Promise.resolve();
  try{
    const saved=JSON.parse(await readFile(file,'utf8'));
    if(saved.schemaVersion!==1||!Array.isArray(saved.profiles)||saved.profiles.length>32||!Number.isSafeInteger(saved.revisionCounter)||saved.revisionCounter<0)throw new Error('Invalid profiles file');
    const profiles=saved.profiles.map(profile=>{
      if(!Number.isSafeInteger(profile.revision)||profile.revision<1||profile.revision>saved.revisionCounter)throw new Error('Invalid profile revision');
      return {...validateProfile(profile,{configs:getConfigs(),settings:getSettings(),allowMissing:true,allowUnsupported:true}),revision:profile.revision};
    });
    if(new Set(profiles.map(profile=>profile.id)).size!==profiles.length)throw new Error('Duplicate profile IDs');
    state={schemaVersion:1,revisionCounter:saved.revisionCounter,profiles};
  }catch(error){if(error.code!=='ENOENT')throw error;state={schemaVersion:1,revisionCounter:4,profiles:presets(getConfigs(),getSettings())};}
  async function persist(next){
    await mkdir(dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';
    try{await writeFile(temp,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temp,file);}
    finally{await unlink(temp).catch(()=>{});}
    state=next;
  }
  function serial(operation){const pending=queue.then(operation);queue=pending.catch(()=>{});return pending;}
  function describe(profile){
    return {...clone(profile),missingServerIds:profile.serverIds.filter(id=>!getConfigs().some(config=>config.id===id)),
      unsupportedIsolationIds:profile.isolation==='process'?getConfigs().filter(config=>profile.serverIds.includes(config.id)&&(config.transport!=='stdio'||config.runtime!=='native')).map(config=>config.id):[],
      sessionPolicy:'Existing sessions retain the profile revision they connected with. Reconnect to use edits.',
      boundary:profile.isolation==='process'?'Separate native child process per client session; configured files, working directories, credentials and external services can still be shared.':'Shared upstream processes and mutable state. Profile filtering is a configuration boundary, not separate authorization.'};
  }
  return {
    snapshot:()=>({schemaVersion:1,profiles:state.profiles.map(describe),defaultProfile:{id:'default',name:'Default',revision:0,serverIds:getConfigs().map(config=>config.id),delivery:pickDelivery(getSettings()),isolation:'shared',managedBy:'Existing server and Tool Delivery settings'}}),
    get(id,{forSession=false}={}){const profile=state.profiles.find(profile=>profile.id===id);if(!profile)throw new Error('Unknown profile');if(forSession)validateProfile(profile,{configs:getConfigs(),settings:getSettings(),allowMissing:true});return describe(profile);},
    save(input,{expectedRevision=0}={}){
      const captured=clone(input);
      return serial(async()=>{
        const previous=state.profiles.find(profile=>profile.id===captured?.id);
        if((previous?.revision??0)!==expectedRevision)throw new Error('This profile changed; reload it before saving');
        if(!previous&&state.profiles.length>=32)throw new Error('At most 32 named profiles are supported');
        const profile={...validateProfile(captured,{configs:getConfigs(),settings:getSettings()}),revision:state.revisionCounter+1};
        if(!Number.isSafeInteger(profile.revision))throw new Error('Profile revision limit reached');
        const profiles=previous?state.profiles.map(value=>value.id===profile.id?profile:value):[...state.profiles,profile];
        await persist({...state,profiles,revisionCounter:profile.revision});return describe(profile);
      });
    },
    remove(id,{expectedRevision}={}){
      return serial(async()=>{
        const previous=state.profiles.find(profile=>profile.id===id);if(!previous)throw new Error('Unknown profile');
        if(previous.revision!==expectedRevision)throw new Error('This profile changed; reload it before deleting');
        await persist({...state,profiles:state.profiles.filter(profile=>profile.id!==id)});
      });
    },
    close:()=>queue
  };
}
