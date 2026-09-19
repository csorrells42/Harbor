import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';

export const generateGatewayKey=()=>`harbor_${randomBytes(32).toString('base64url')}`;
export function validateGatewayKey(value){
  if(typeof value!=='string'||value.length<16||value.length>4096||!/^[-A-Za-z0-9._~+/]+=*$/.test(value))throw new Error('Use an API key of 16–4096 letters, numbers or standard token characters, without spaces.');
  return value;
}
const digest=value=>createHash('sha256').update(value).digest();

// Kept separate from ordinary settings, snapshots and connection previews.
export async function createGatewayAuthentication({dataDir,defaultEnabled=false}){
  const file=path.join(dataDir,'auth','gateway.json');
  let state={version:1,enabled:false,key:''},queue=Promise.resolve();
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
    state={version:1,enabled:saved.enabled,key:saved.key};
  }catch(error){
    if(error.code!=='ENOENT')throw new Error('Could not load gateway authentication. Restore valid saved credentials before starting Harbor.');
    if(defaultEnabled){state={version:1,enabled:true,key:generateGatewayKey()};await persist(state);}
  }
  const status=()=>({enabled:state.enabled,hasKey:!!state.key});
  return {
    status,
    accepts(header){
      if(!state.enabled)return true;
      if(typeof header!=='string'||header.length>4103)return false;
      const match=/^Bearer ([-A-Za-z0-9._~+/]+=*)$/i.exec(header);
      return !!match&&timingSafeEqual(digest(match[1]),digest(state.key));
    },
    key(){return state.key;},
    update(input,apply=async()=>{}){
      // Capture caller data before joining the persistent write queue.
      if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.enabled!=='boolean')return Promise.reject(new Error('Choose whether the gateway requires an API key.'));
      const enabled=input.enabled;let supplied;
      try{if(Object.hasOwn(input,'key'))supplied=validateGatewayKey(input.key);}catch(error){return Promise.reject(error);}
      const job=queue.then(async()=>{
        const previous=state,next={version:1,enabled,key:supplied??state.key};
        if(next.enabled&&!next.key)throw new Error('Enter or generate an API key before enabling authentication.');
        await persist(next);state=next;
        try{await apply();}catch(error){await persist(previous);state=previous;throw error;}
        return status();
      });queue=job.catch(()=>{});return job;
    }
  };
}
