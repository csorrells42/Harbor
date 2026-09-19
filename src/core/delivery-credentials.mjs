import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SEARCH_DEFAULTS} from './delivery-options.js';
export function createDeliverySettings({dataDir,portableRoot,getSettings,updateSettings}){
  const directory=path.join(dataDir,'auth','embeddings');let queue=Promise.resolve();
  const resolve=file=>file.replaceAll('${HARBOR_ROOT}',portableRoot??'');
  const managed=file=>path.dirname(file)===directory&&/^(portkeyApi|portkeyWorkers)-[0-9a-f-]+\.key$/.test(path.basename(file));
  return input=>{
    const job=queue.then(async()=>{
      if(!input||typeof input!=='object')throw new Error('Tool delivery settings are required');
      const before=getSettings(),next={...before},created=[];
      for(const key of ['toolMode',...Object.keys(SEARCH_DEFAULTS)])if(Object.hasOwn(input.settings??{},key))next[key]=input.settings[key];
      try{
        for(const prefix of ['portkeyApi','portkeyWorkers']){
          const value=input.credentials?.[prefix];if(value===undefined)continue;
          if(value===null){next[prefix+'KeyFile']='';continue;}
          if(typeof value!=='string'||!value.trim()||value.length>16384)throw new Error('Enter a nonempty API key');
          await fs.mkdir(directory,{recursive:true});const file=path.join(directory,`${prefix}-${randomUUID()}.key`);
          await fs.writeFile(file,value.trim(),{flag:'wx',mode:0o600});created.push(file);next[prefix+'KeyFile']=portableRoot?'${HARBOR_ROOT}/'+path.relative(portableRoot,file).split(path.sep).join('/'):file;
        }
        const delivery=Object.fromEntries(['toolMode',...Object.keys(SEARCH_DEFAULTS)].map(key=>[key,next[key]]));
        const result=await updateSettings({...getSettings(),...delivery});
        for(const prefix of ['portkeyApi','portkeyWorkers']){const old=before[prefix+'KeyFile'];if(old&&old!==next[prefix+'KeyFile']&&managed(path.normalize(resolve(old))))await fs.unlink(resolve(old)).catch(()=>{});}
        return result;
      }catch(error){await Promise.all(created.map(file=>fs.unlink(file).catch(()=>{})));throw error;}
    });queue=job.catch(()=>{});return job;
  };
}
