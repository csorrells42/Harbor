import fs from 'node:fs/promises';
import path from 'node:path';

const fields=['portkeyApiKeyFile','portkeyWorkersKeyFile'];
const profileId=/^[a-z][a-z0-9-]{0,39}$/;
const keyName=/^(portkeyApi|portkeyWorkers)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.key$/;

// Only Harbor-created profile keys are collectible. External keys and the
// default delivery credential directory are never cleanup candidates.
export function createProfileCredentials({dataDir,portableRoot,getReferences,onError=()=>{}}){
  const root=path.resolve(dataDir,'profile-credentials'),leases=new Map(),deleting=new Set();
  let queue=Promise.resolve();
  const normalize=file=>{
    if(typeof file!=='string'||!file)return null;
    if(file.includes('${HARBOR_ROOT}')&&!portableRoot)return null;
    const resolved=path.resolve(file.replaceAll('${HARBOR_ROOT}',portableRoot??''));
    return process.platform==='win32'?resolved.toLowerCase():resolved;
  };
  const references=settings=>fields.map(key=>normalize(settings?.[key])).filter(Boolean);
  const referenced=file=>leases.has(file)||getReferences().some(settings=>references(settings).includes(file));
  async function safeDirectory(directory){
    // Check every component below dataDir. Never follow a junction or symlink
    // while enumerating/deleting keys, including a substituted profile root.
    const relative=path.relative(path.resolve(dataDir),directory);
    if(relative.startsWith('..')||path.isAbsolute(relative))return false;
    let current=path.resolve(dataDir);
    for(const part of relative.split(path.sep)){
      current=path.join(current,part);
      const stat=await fs.lstat(current);
      if(!stat.isDirectory()||stat.isSymbolicLink())return false;
    }
    return true;
  }
  async function sweep(){
    try{
      if(!await safeDirectory(root))return;
      for(const profile of await fs.readdir(root,{withFileTypes:true})){
        if(!profile.isDirectory()||profile.isSymbolicLink()||!profileId.test(profile.name))continue;
        const directory=path.join(root,profile.name,'auth','embeddings');
        try{
          if(!await safeDirectory(directory))continue;
          for(const entry of await fs.readdir(directory,{withFileTypes:true})){
            if(!entry.isFile()||entry.isSymbolicLink()||!keyName.test(entry.name))continue;
            const file=path.join(directory,entry.name),id=normalize(file);
            if(referenced(id))continue;
            // Reservations are synchronous. Prevent a stale form from reviving
            // this exact path during the asynchronous unlink below.
            deleting.add(id);
            try{
              if(!await safeDirectory(directory))continue;
              const stat=await fs.lstat(file);
              if(stat.isFile()&&!stat.isSymbolicLink()&&!referenced(id))await fs.unlink(file);
            }finally{deleting.delete(id);}
          }
        }catch(error){if(error.code!=='ENOENT')throw error;}
      }
    }catch(error){if(error.code!=='ENOENT')onError();}
  }
  function collect(){const pending=queue.then(sweep);queue=pending.catch(()=>onError());return queue;}
  function reserve(files){
    const ids=[...new Set(files.map(normalize).filter(Boolean))];
    if(ids.some(id=>deleting.has(id)))throw new Error('A profile credential is being retired; reload the profile before saving');
    for(const id of ids)leases.set(id,(leases.get(id)??0)+1);
    let released=false;
    return ()=>{
      if(released)return;released=true;
      for(const id of ids){const count=leases.get(id)-1;if(count)leases.set(id,count);else leases.delete(id);}
      void collect();
    };
  }
  return {reserve,retain:settings=>reserve(fields.map(key=>settings?.[key])),collect,drain:()=>queue};
}
