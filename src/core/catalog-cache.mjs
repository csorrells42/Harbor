import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,rename,unlink,stat} from 'node:fs/promises';
import path from 'node:path';

const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const catalogDigest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const launchFingerprint=config=>catalogDigest(Object.fromEntries(['id','transport','runtime','command','args','env','cwd','url','distro','managedProcesses'].map(key=>[key,config[key]??null])));
export function exposedName(id,name){return `${id.slice(0,20)}__${name.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,24)}__${catalogDigest([id,name]).slice(0,16)}`;}
const maximum=8*1024*1024;
function validTools(tools,id){
  return Array.isArray(tools)&&tools.length<=10000&&new Set(tools.map(tool=>tool?.name)).size===tools.length&&tools.every(tool=>tool&&typeof tool.originalName==='string'&&tool.originalName.length>0&&tool.serverId===id&&tool.name===exposedName(id,tool.originalName)&&tool.inputSchema&&typeof tool.inputSchema==='object'&&!Array.isArray(tool.inputSchema));
}
export async function createCatalogCache({file,onError=()=>{}}={}){
  let records={},queue=Promise.resolve();
  if(file)try{
    if((await stat(file)).size>maximum)throw Error('Catalog cache too large');
    const saved=JSON.parse(await readFile(file,'utf8'));
    if(saved.schemaVersion!==1||!saved.records||Array.isArray(saved.records)||typeof saved.records!=='object'||Object.keys(saved.records).length>256)throw Error('Invalid catalog cache');
    for(const [id,record] of Object.entries(saved.records)){
      if(!/^[a-zA-Z0-9_-]{1,40}$/.test(id)||!/^[a-f0-9]{64}$/.test(record?.launchFingerprint??'')||!Number.isFinite(record.observedAt)||!validTools(record.tools,id)||record.catalogFingerprint!==catalogDigest(record.tools))throw Error('Invalid catalog identity');
    }
    records=saved.records;
  }catch(error){if(error.code!=='ENOENT')onError();}
  function persist(){
    if(!file)return Promise.resolve();
    const text=JSON.stringify({schemaVersion:1,records})+'\n';
    if(Buffer.byteLength(text)>maximum){onError();return Promise.resolve();}
    const job=queue.then(async()=>{
      await mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';
      try{await writeFile(temp,text,{flag:'wx',mode:0o600});await rename(temp,file);}finally{await unlink(temp).catch(()=>{});}
    });queue=job.catch(()=>onError());return queue;
  }
  return {
    get(config){const record=records[config.id];return record?.launchFingerprint===launchFingerprint(config)?structuredClone(record):null;},
    async set(config,tools){
      if(!validTools(tools,config.id)||Buffer.byteLength(JSON.stringify(tools))>maximum/2){onError();return;}
      records={...records,[config.id]:{launchFingerprint:launchFingerprint(config),catalogFingerprint:catalogDigest(tools),observedAt:Date.now(),tools:structuredClone(tools)}};await persist();
    },
    async invalidate(id){if(id===undefined)records={};else{records={...records};delete records[id];}await persist();},
    async prune(configs){const retained={};for(const config of configs){const record=records[config.id];if(record?.launchFingerprint===launchFingerprint(config))retained[config.id]=record;}records=retained;await persist();},
    close:()=>queue
  };
}
