import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolvePortableConfig, portableEnvironment} from './portable.mjs';

const exists = file => fs.access(file).then(()=>true,()=>false);
export function contained(root, relative) {
  if(typeof relative!=='string'||!relative||path.isAbsolute(relative))throw new Error('Component paths must be relative to Harbor');
  const resolved=path.resolve(root,relative);
  if(!resolved.startsWith(path.resolve(root)+path.sep))throw new Error('Component path escapes Harbor folder');
  return resolved;
}
async function atomic(file,value){
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temp=`${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n');await fs.rename(temp,file);
}

export async function runBuildCommand(command,args,{cwd,env,log=()=>{},signal,timeout=1800000}={}) {
  signal?.throwIfAborted();
  const child=spawn(command,args,{cwd,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let text='',killed=false;
  const receive=chunk=>{const line=chunk.toString();text=(text+line).slice(-64000);log(line);};
  child.stdout.on('data',receive);child.stderr.on('data',receive);
  const stop=()=>{
    killed=true;
    if(!child.pid)return;
    if(process.platform==='win32')spawn(path.join(process.env.SystemRoot,'System32/taskkill.exe'),['/pid',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('error',()=>{});
    else child.kill('SIGTERM');
  };
  const timer=setTimeout(stop,timeout);signal?.addEventListener('abort',stop,{once:true});
  try{
    await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0&&!killed?resolve():reject(new Error(killed?'Build cancelled or timed out':`Build command failed (${code}): ${text.slice(-2000)}`)));});
    return text.trim();
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);}
}

export async function createMaintenance({root,isPaused,gitCommand}) {
  const stateDir=path.join(root,'data/maintenance');await fs.mkdir(stateDir,{recursive:true});
  const file=path.join(stateDir,'status.json');
  let status={busy:false,phase:'idle',message:'Ready',components:[],log:[]},controller,job;
  const manifest=JSON.parse(await fs.readFile(path.join(root,'maintenance.json'),'utf8'));
  if(manifest.version!==1||!Array.isArray(manifest.components))throw new Error('Invalid maintenance manifest');
  const retainBackups=manifest.retainBackups!==false;
  const ids=new Set();
  for(const c of manifest.components){
    if(!/^[a-z0-9_-]+$/.test(c.id)||ids.has(c.id))throw new Error('Invalid or duplicate maintenance component');
    ids.add(c.id);contained(root,c.path);
  }
  // Complete an interrupted directory switch before any server can start.
  const journalFile=path.join(stateDir,'activation.json');
  if(await exists(journalFile)){
    const j=JSON.parse(await fs.readFile(journalFile,'utf8'));
    const target=contained(root,j.target),backup=contained(root,j.backup);
    if(!await exists(target)&&await exists(backup))await fs.rename(backup,target);
    else if(j.component&&j.stage&&await exists(target)&&!await exists(contained(root,j.stage))){
      if(retainBackups)await atomic(path.join(stateDir,`rollback-${j.component}.json`),{target:j.target,backup:j.backup});
      if(j.selfUpdate)await atomic(path.join(stateDir,'pending-self-update.json'),{stage:j.target,output:j.output,component:j.component});
      if(!retainBackups){await fs.rm(backup,{recursive:true,force:true});await fs.rm(path.join(stateDir,`rollback-${j.component}.json`),{force:true});}
    }
    await fs.unlink(journalFile);
    status.message='Recovered interrupted maintenance activation.';
  }
  const persist=()=>atomic(file,status);
  const log=line=>{status.log.push(String(line).slice(-4000));if(status.log.length>120)status.log.shift();};
  const env=portableEnvironment(root,{...process.env,HARBOR_PORTABLE_ROOT:root,GIT_TERMINAL_PROMPT:'0'});
  const git=gitCommand??path.join(root,'runtimes/git/cmd/git.exe');
  const execute=(cmd,args,cwd)=>runBuildCommand(cmd,args,{cwd,env,log,signal:controller?.signal});
  const snapshot=()=>structuredClone({...status,retainBackups,components:manifest.components.map(c=>({id:c.id,name:c.name,repository:c.repository??(c.npmPackages||c.update?'Official package releases':'Local source'),path:c.path,updatable:!!(c.repository||c.npmPackages||c.update),canRestore:!!(retainBackups||(c.selfUpdate&&manifest.applicationBackups===1)),notes:c.notes??''}))});
  async function update(id,rebuild){
    if(!isPaused())throw new Error('Enter maintenance mode before updating components');
    const c=manifest.components.find(c=>c.id===id);if(!c)throw new Error('Unknown component');
    const active=contained(root,c.path);
    const stamp=`${Date.now()}-${id}`;
    const stage=contained(root,`data/maintenance/staging/${stamp}`);
    try{
    await fs.mkdir(path.dirname(stage),{recursive:true});
    status.phase='preparing';status.component=id;await persist();
    if(c.repository){
      // Active packages are source checkouts. Never reset or discard local edits.
      const dirty=await execute(git,['status','--porcelain','--untracked-files=normal'],active);
      if(dirty)throw new Error(`${c.name} has local changes; preserve or commit them before updating.`);
      const gitConfig=await fs.readFile(path.join(active,'.git/config'),'utf8');
      if(/^\s*promisor\s*=\s*true\s*$/mi.test(gitConfig)){
        // A local clone cannot serve missing objects from a partial checkout.
        // Copy its independent object database and upstream promisor metadata;
        // checkout can then obtain missing objects from the original upstream.
        await fs.mkdir(stage,{recursive:true});
        await fs.cp(path.join(active,'.git'),path.join(stage,'.git'),{recursive:true});
        await execute(git,['reset','--hard','HEAD'],stage);
      }else{
        await execute(git,['clone','--no-hardlinks',...(c.sparsePaths?.length?['--sparse']:[]),active,stage],root);
      }
      if(c.sparsePaths?.length)await execute(git,['sparse-checkout','set',...c.sparsePaths],stage);
      if(c.generatedPaths?.length)await fs.appendFile(path.join(stage,'.git/info/exclude'),'\n'+c.generatedPaths.map(p=>`/${p}/`).join('\n')+'\n');
      if(!rebuild){
      status.phase='fetching';await persist();
      let ref=c.ref||'HEAD';
      if(c.releaseRepository){
        const response=await fetch(`https://api.github.com/repos/${c.releaseRepository}/releases/latest`,{headers:{'User-Agent':'Harbor-Portable'},signal:AbortSignal.timeout(30000)});
        if(!response.ok)throw new Error(`Stable release lookup failed: ${response.status}`);
        ref=(await response.json()).tag_name;
        if(typeof ref!=='string'||!/^v?\d+\.\d+\.\d+$/.test(ref))throw new Error('Expected a stable numbered release');
      }
      await execute(git,['fetch',c.repository,ref],stage);
      const incoming=await execute(git,['rev-list','--count','HEAD..FETCH_HEAD'],stage);
      if(incoming==='0'&&!rebuild){status.phase='current';status.message=`${c.name} is already current`;return;}
      await execute(git,['-c','user.name=Harbor Maintenance','-c','user.email=harbor@localhost','-c','commit.gpgsign=false','merge','--no-edit','FETCH_HEAD'],stage);
      }
      status.revision=await execute(git,['rev-parse','HEAD'],stage);
    }else{
      const excluded=['node_modules','.venv','release','data','artifact',...(c.excludeFromStage??[])];
      await fs.cp(active,stage,{recursive:true,filter:source=>!excluded.includes(path.relative(active,source).split(path.sep)[0])});
    }
    status.phase='building';await persist();
    if(c.npmPackages?.length && !rebuild){
      await execute(path.join(root,'runtimes/node/node.exe'),[path.join(root,'runtimes/node/node_modules/npm/bin/npm-cli.js'),'install','--save-exact','--no-audit','--no-fund',...c.npmPackages.map(name=>`${name}@latest`)],stage);
    }
    for(const step of [...(!rebuild?c.update??[]:[]),...c.build??[]]){
      const expanded=resolvePortableConfig(step,root);
      const replace=s=>String(s).replaceAll('${STAGE}',stage.replaceAll('\\','/'));
      await runBuildCommand(replace(expanded.command),(expanded.args??[]).map(replace),{cwd:step.cwd?contained(stage,step.cwd):stage,env:{...env,...Object.fromEntries(Object.entries(expanded.env??{}).map(([k,v])=>[k,replace(v)]))},log,signal:controller?.signal});
    }
    status.phase='verifying';await persist();
    if(!c.verify?.length)throw new Error('Component has no verification recipe; activation refused');
    for(const step of c.verify){
      const expanded=resolvePortableConfig(step,root);const replace=s=>String(s).replaceAll('${STAGE}',stage.replaceAll('\\','/'));
      await runBuildCommand(replace(expanded.command),(expanded.args??[]).map(replace),{cwd:step.cwd?contained(stage,step.cwd):stage,env:{...env,...Object.fromEntries(Object.entries(expanded.env??{}).map(([k,v])=>[k,replace(v)]))},log,signal:controller?.signal});
    }
    if(!isPaused())throw new Error('Maintenance mode ended before activation');
    const backupRel=`data/maintenance/backups/${stamp}`,backup=contained(root,backupRel);await fs.mkdir(path.dirname(backup),{recursive:true});
    await atomic(journalFile,{target:c.path,backup:backupRel,stage:path.relative(root,stage),component:id,selfUpdate:!!c.selfUpdate,output:c.output});
    await fs.rename(active,backup);
    try{await fs.rename(stage,active);}catch(error){await fs.rename(backup,active);throw error;}
    status.activated=true;
    if(retainBackups)await atomic(path.join(stateDir,`rollback-${id}.json`),{target:c.path,backup:backupRel});
    if(c.selfUpdate){
      await atomic(path.join(root,'data/maintenance/pending-self-update.json'),{stage:c.path,output:c.output,component:id,createdAt:new Date().toISOString()});
      if(!retainBackups){await fs.rm(backup,{recursive:true,force:true});await fs.rm(path.join(stateDir,`rollback-${id}.json`),{force:true});}
      await fs.unlink(journalFile);
      status.phase='restart-required';status.message='Harbor update built and verified. Quit, then use Start Harbor to activate it.';return;
    }
    if(!retainBackups){await fs.rm(backup,{recursive:true,force:true});await fs.rm(path.join(stateDir,`rollback-${id}.json`),{force:true});}
    await fs.unlink(journalFile);
    status.phase='complete';status.message=`${c.name} updated and verified; ${retainBackups?'previous version retained':'only the current version retained'}`;
    }finally{
      // Leave an interrupted switch intact for recovery; discard finished or failed build staging.
      if(!retainBackups&&!await exists(journalFile))await fs.rm(stage,{recursive:true,force:true});
    }
  }
  return {
    snapshot,
    start(id,{rebuild=false}={}){
      if(status.busy)throw new Error('A maintenance operation is already running');
      if(!isPaused())throw new Error('Enter maintenance mode first');
      status={...status,busy:true,phase:'starting',message:'Working',component:id,log:[],error:undefined,activated:false};controller=new AbortController();
      job=update(id,rebuild).catch(error=>{status.phase='failed';status.error=error.message;status.message=status.activated?'New component activated, but maintenance metadata needs recovery on restart':'Current version retained';log(error.message);}).finally(async()=>{status.busy=false;try{await persist();}catch(error){status.error=`Maintenance status could not be saved: ${error.message}`;log(status.error);}});
      return snapshot();
    },
    async rollback(id){
      if(status.busy||!isPaused())throw new Error('Rollback requires idle maintenance mode');
      if(!ids.has(id))throw new Error('Unknown component');
      if(!retainBackups){
        const c=manifest.components.find(c=>c.id===id);
        if(!c.selfUpdate||manifest.applicationBackups!==1)throw new Error('Previous versions are not retained for this component');
        if(await exists(path.join(stateDir,'pending-self-update.json')))throw new Error('Activate the pending Harbor update before restoring the previous application');
        const previous=JSON.parse(await fs.readFile(path.join(root,'application/previous.json'),'utf8'));
        if(!/^application\/(initial|releases\/[^/\\]+)$/.test(previous.path))throw new Error('Invalid previous application path');
        await fs.access(path.join(contained(root,previous.path),'MCP Harbor.exe'));
        await atomic(path.join(stateDir,'pending-self-rollback.json'),{createdAt:new Date().toISOString()});
        status.message='Previous Harbor application selected for the next Start Harbor launch; current source is unchanged';status.phase='restart-required';await persist();return snapshot();
      }
      const record=path.join(stateDir,`rollback-${id}.json`);const r=JSON.parse(await fs.readFile(record,'utf8'));
      const component=manifest.components.find(c=>c.id===id);
      const pendingFile=path.join(stateDir,'pending-self-update.json');
      const hasPending=component.selfUpdate&&await exists(pendingFile);
      if(component.selfUpdate&&!hasPending){
        const previous=JSON.parse(await fs.readFile(path.join(root,'application/previous.json'),'utf8'));
        await fs.access(path.join(contained(root,previous.path),'MCP Harbor.exe'));
      }
      const target=contained(root,r.target),backup=contained(root,r.backup),retired=contained(root,`data/maintenance/backups/${Date.now()}-${id}-replaced`);
      await atomic(journalFile,{target:r.target,backup:path.relative(root,retired)});
      await fs.rename(target,retired);try{await fs.rename(backup,target);}catch(error){await fs.rename(retired,target);throw error;}
      await fs.unlink(journalFile);await atomic(record,{target:r.target,backup:path.relative(root,retired)});
      if(component.selfUpdate){
        if(hasPending)await fs.unlink(pendingFile);
        else await atomic(path.join(stateDir,'pending-self-rollback.json'),{createdAt:new Date().toISOString()});
        status.message=hasPending?'Pending Harbor update cancelled; previous source restored':'Previous Harbor restored for the next Start Harbor launch';status.phase='restart-required';await persist();return snapshot();
      }
      status.message='Previous version restored';status.phase='rolled-back';await persist();return snapshot();
    },
    async close(){controller?.abort();await job;},
    async wait(){await job;return snapshot();}
  };
}
