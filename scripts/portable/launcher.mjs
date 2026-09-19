import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {pruneApplicationReleases} from './release-retention.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const inside=relative=>{const resolved=path.resolve(root,relative);if(!resolved.startsWith(root+path.sep))throw new Error('Invalid Harbor application path');return resolved;};
const pointer=path.join(root,'application/current.json');
try{
  const manifest=JSON.parse(await fs.readFile(path.join(root,'maintenance.json'),'utf8'));
  const retainBackups=manifest.retainBackups!==false;
  const applicationBackups=manifest.applicationBackups??(retainBackups?1:0);
  const rollbackFile=path.join(root,'data/maintenance/pending-self-rollback.json');
  if(await fs.access(rollbackFile).then(()=>true,()=>false)){
    const previousPath=path.join(root,'application/previous.json');
    const previous=JSON.parse(await fs.readFile(previousPath,'utf8'));
    await fs.access(path.join(inside(previous.path),'MCP Harbor.exe'));
    const current=JSON.parse(await fs.readFile(pointer,'utf8'));
    await fs.writeFile(pointer+'.tmp',JSON.stringify(previous));await fs.rename(pointer+'.tmp',pointer);
    await fs.writeFile(previousPath,JSON.stringify(current));await fs.unlink(rollbackFile);
  }
  const pendingPath=path.join(root,'data/maintenance/pending-self-update.json');
  const pending=await fs.readFile(pendingPath,'utf8').then(JSON.parse,error=>{if(error.code==='ENOENT')return null;throw error;});
  if(pending){
    const staged=inside(pending.stage),output=path.resolve(staged,pending.output);
    if(!output.startsWith(staged+path.sep))throw new Error('Invalid staged application output');
    await fs.access(path.join(output,'MCP Harbor.exe'));
    const previous=JSON.parse(await fs.readFile(pointer,'utf8'));
    const relative=`application/releases/${Date.now()}`;
    await fs.mkdir(path.dirname(inside(relative)),{recursive:true});
    await fs.cp(output,inside(relative),{recursive:true});
    if(applicationBackups===1)await fs.writeFile(path.join(root,'application/previous.json'),JSON.stringify(previous));
    await fs.writeFile(pointer+'.tmp',JSON.stringify({path:relative}));await fs.rename(pointer+'.tmp',pointer);
    await fs.unlink(pendingPath);
    if(!retainBackups)await fs.rm(output,{recursive:true,force:true});
  }
  if(!retainBackups)await pruneApplicationReleases(root,{applicationBackups});
  const current=JSON.parse(await fs.readFile(pointer,'utf8'));
  const executable=path.join(inside(current.path),'MCP Harbor.exe');
  const env={...process.env,HARBOR_PORTABLE_ROOT:root};delete env.ELECTRON_RUN_AS_NODE;delete env.HARBOR_DATA_DIR;delete env.HARBOR_PORT;
  const child=spawn(executable,[],{cwd:root,env,detached:true,windowsHide:false,stdio:'ignore'});child.on('error',async error=>{await fs.writeFile(path.join(root,'launch-error.txt'),error.message);});child.unref();
}catch(error){await fs.writeFile(path.join(root,'launch-error.txt'),`${error.message}\n`);process.exitCode=1;}
