import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {validateSettings} from './settings.mjs';

export const generateGatewayKey=()=>`harbor_${randomBytes(32).toString('base64url')}`;
export function validateGatewayKey(value){
  if(typeof value!=='string'||value.length<16||value.length>4096||!/^[-A-Za-z0-9._~+/]+=*$/.test(value))throw new Error('Use an API key of 16–4096 letters, numbers or standard token characters, without spaces.');
  return value;
}
const digest=value=>createHash('sha256').update(value).digest();

// Kept separate from ordinary settings, snapshots and connection previews.
export async function createGatewayAuthentication({dataDir,defaultEnabled=false}){
  const file=path.join(dataDir,'auth','gateway.json');
  let state={version:1,enabled:false,key:''},queue=Promise.resolve(),available=true;
  const persist=async next=>{
    const temporary=`${file}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(file),{recursive:true});
    try{await fs.writeFile(temporary,JSON.stringify(next)+'\n',{flag:'wx',mode:0o600});await fs.rename(temporary,file);}
    finally{await fs.unlink(temporary).catch(()=>{});}
  };
  try{
    const saved=JSON.parse(await fs.readFile(file,'utf8'));
    if(saved.version!==1||typeof saved.enabled!=='boolean'||typeof saved.key!=='string')throw new Error('Invalid saved API-key settings');
    if(saved.key)validateGatewayKey(saved.key);
    if(saved.enabled&&!saved.key)throw new Error('Enabled API-key authentication has no saved key');
    state={version:1,enabled:saved.enabled,key:saved.key,...(Object.hasOwn(saved,'settings')?{settings:validateSettings(saved.settings)}:{})};
  }catch(error){
    if(error.code!=='ENOENT')throw new Error('Could not load gateway authentication. Restore valid saved credentials before starting Harbor.');
    if(defaultEnabled){state={version:1,enabled:true,key:generateGatewayKey()};await persist(state);}
  }
  const status=()=>({enabled:state.enabled,hasKey:!!state.key});
  return {
    status,
    settings:()=>state.settings&&structuredClone(state.settings),
    available:()=>available,
    accepts(header){
      if(!available)return false;
      if(!state.enabled)return true;
      if(typeof header!=='string'||header.length>4103)return false;
      const match=/^Bearer ([-A-Za-z0-9._~+/]+=*)$/i.exec(header);
      return !!match&&timingSafeEqual(digest(match[1]),digest(state.key));
    },
    key(){return state.key;},
    update(input,apply=async()=>{},context={}){
      // Capture caller data before joining the persistent write queue.
      if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.enabled!=='boolean')return Promise.reject(new Error('Choose whether the gateway requires an API key.'));
      const enabled=input.enabled;let supplied;
      try{if(Object.hasOwn(input,'key'))supplied=validateGatewayKey(input.key);}catch(error){return Promise.reject(error);}
      let settings;
      try{
        if(context.settings!==undefined)settings=validateSettings(context.settings);
      }catch(error){return Promise.reject(error);}
      const job=queue.then(async()=>{
        // The pending record pairs the key with the complete requested settings.
        // An interrupted save is recovered before opening a listener.
        const previous={...state};
        const next={...previous,version:1,enabled,key:supplied??state.key,...(settings?{settings}:{})};
        if(next.enabled&&!next.key)throw new Error('Enter or generate an API key before enabling authentication.');
        await persist(next);state=next;
        try{await apply();available=true;}catch(error){
          state=previous;
          try{await persist(previous);}catch(rollback){
            available=false;
            throw new AggregateError([error,rollback],'Gateway protection recovery could not be saved. Apply protections again before clients can reconnect.');
          }
          throw error;
        }
        if(settings){
          // The mirror and live listener committed. Retire the recovery record so
          // normal offline settings edits remain supported. A cleanup failure must
          // retain the coherent pending record, never roll back a committed key.
          const complete={version:1,enabled:state.enabled,key:state.key};
          try{await persist(complete);state=complete;}catch{}
        }
        return status();
      });queue=job.catch(()=>{});return job;
    }
  };
}
