import fs from 'node:fs/promises';
import path from 'node:path';

// Only owned application directories are eligible; project data is never pruned.
export async function pruneApplicationReleases(root,{applicationBackups=0}={}){
  root=await fs.realpath(root);
  const application=path.join(root,'application');
  if((await fs.lstat(application)).isSymbolicLink())throw new Error('Application directory must not be a link');
  const current=JSON.parse(await fs.readFile(path.join(application,'current.json'),'utf8'));
  if(!/^application\/(initial|releases\/[^/\\]+)$/.test(current.path))throw new Error('Invalid current application path');
  const keep=path.resolve(root,current.path);
  if(!(await fs.realpath(keep)).startsWith(application+path.sep))throw new Error('Current application escapes Harbor');
  await fs.access(path.join(keep,'MCP Harbor.exe'));
  const retained=new Set([keep]);
  const previousFile=path.join(application,'previous.json');
  if(applicationBackups===1){
    const previous=await fs.readFile(previousFile,'utf8').then(JSON.parse,error=>{if(error.code==='ENOENT')return null;throw error;});
    if(previous){
      if(!/^application\/(initial|releases\/[^/\\]+)$/.test(previous.path))throw new Error('Invalid previous application path');
      const previousPath=path.resolve(root,previous.path);
      if(!(await fs.realpath(previousPath)).startsWith(application+path.sep))throw new Error('Previous application escapes Harbor');
      await fs.access(path.join(previousPath,'MCP Harbor.exe'));
      retained.add(previousPath);
    }
  }
  const releases=path.join(application,'releases');
  const entries=await fs.readdir(releases,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  if(entries.length&&(await fs.lstat(releases)).isSymbolicLink())throw new Error('Releases directory must not be a link');
  for(const entry of entries){const target=path.join(releases,entry.name);if(!retained.has(target))await fs.rm(target,{recursive:true,force:true});}
  const initial=path.join(application,'initial');
  if(!retained.has(initial))await fs.rm(initial,{recursive:true,force:true});
  if(applicationBackups!==1)await fs.rm(previousFile,{force:true});
}
