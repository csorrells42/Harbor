import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {pruneApplicationReleases} from './release-retention.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const inside=relative=>{const resolved=path.resolve(root,relative);if(!resolved.startsWith(root+path.sep))throw new Error('Invalid Harbor application path');return resolved;};
const pointer=path.join(root,'application/current.json');
// Windows pipes and Linux abstract sockets are released by the OS even if the
// owner crashes. A waiting launcher must read activation state only after entry.
async function acquireActivationLock(){
  const canonical=await fs.realpath(root);
  const identity=createHash('sha256').update(process.platform==='win32'?canonical.toLowerCase():canonical).digest('hex').slice(0,32);
  const address=process.platform==='win32'?'\\\\.\\pipe\\harbor-launch-'+identity:'\0harbor-launch-'+identity;
  for(let attempt=0;attempt<1200;attempt++){
    const server=createServer(socket=>socket.destroy());
    try{
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({path:address,exclusive:true},resolve);});
      return ()=>new Promise(resolve=>server.close(resolve));
    }catch(error){if(error.code!=='EADDRINUSE')throw error;}
    await delay(100);
  }
  throw new Error('Another Harbor launcher is still updating this folder. Try again when it finishes.');
}
let releaseLock;
try{
  releaseLock=await acquireActivationLock();
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
    const component=manifest.components?.find(c=>c.id===pending.component&&c.selfUpdate);
    if(!component||inside(component.path)!==staged||path.resolve(staged,component.output)!==output)throw new Error('Pending application output does not match its maintenance recipe');
    const savePending=async()=>{await fs.writeFile(pendingPath+'.tmp',JSON.stringify(pending));await fs.rename(pendingPath+'.tmp',pendingPath);};
    if(!pending.activation){
      await fs.access(path.join(output,'MCP Harbor.exe'));
      const previous=JSON.parse(await fs.readFile(pointer,'utf8'));
      const target='application/releases/'+Date.now();
      await fs.mkdir(path.dirname(inside(target)),{recursive:true});
      await fs.cp(output,inside(target),{recursive:true});
      // Keep the prepared release identity before publishing its pointer, so a
      // retry finishes the same activation instead of copying another release.
      pending.activation={target,previous:previous.path,complete:false};await savePending();
    }
    const activation=pending.activation;
    if(!/^application\/releases\/[^/\\]+$/.test(activation.target)||!/^application\/(initial|releases\/[^/\\]+)$/.test(activation.previous)||typeof activation.complete!=='boolean')throw new Error('Invalid pending application activation');
    await fs.access(path.join(inside(activation.target),'MCP Harbor.exe'));
    const current=JSON.parse(await fs.readFile(pointer,'utf8'));
    if(current.path!==activation.target){
      if(activation.complete||current.path!==activation.previous)throw new Error('Current application changed during pending activation; staged output was preserved');
      if(applicationBackups===1)await fs.writeFile(path.join(root,'application/previous.json'),JSON.stringify({path:activation.previous}));
      await fs.writeFile(pointer+'.tmp',JSON.stringify({path:activation.target}));await fs.rename(pointer+'.tmp',pointer);
    }
    if(!activation.complete){activation.complete=true;await savePending();}
    // Cleanup can be interrupted after deleting only part of the build output.
    // The completed marker resumes it without requiring or recopying that output.
    const published=JSON.parse(await fs.readFile(pointer,'utf8'));
    if(published.path!==activation.target)throw new Error('Current application changed before output cleanup; staged output was preserved');
    if(!retainBackups)await fs.rm(output,{recursive:true,force:true});
    await fs.unlink(pendingPath);
  }
  if(!retainBackups)await pruneApplicationReleases(root,{applicationBackups});
  const current=JSON.parse(await fs.readFile(pointer,'utf8'));
  const executable=path.join(inside(current.path),'MCP Harbor.exe');
  const env={...process.env,HARBOR_PORTABLE_ROOT:root};delete env.ELECTRON_RUN_AS_NODE;delete env.HARBOR_DATA_DIR;delete env.HARBOR_PORT;
  const child=spawn(executable,[],{cwd:root,env,detached:true,windowsHide:false,stdio:'ignore'});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
}catch(error){await fs.writeFile(path.join(root,'launch-error.txt'),`${error.message}\n`);process.exitCode=1;}finally{await releaseLock?.();}
