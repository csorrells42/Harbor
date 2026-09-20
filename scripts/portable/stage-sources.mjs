import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const execute=promisify(execFile),sha=/^[a-f0-9]{40}$/;
const requireValue=(condition,message)=>{if(!condition)throw Error(message);};

export function validateSourceRevisions(input){
 requireValue(input?.schemaVersion===1&&Array.isArray(input.components)&&input.components.length>0&&input.components.length<=32,'Expected a bounded source revision manifest');
 requireValue(typeof input.observedAt==='string'&&Number.isFinite(Date.parse(input.observedAt)),'Pinned patch commit timestamp required');
 const seen=new Set();
 for(const component of input.components){
  requireValue(/^[a-z0-9][a-z0-9-]{0,63}$/.test(component.id??'')&&!seen.has(component.id),'Invalid or duplicate source ID');seen.add(component.id);
  requireValue(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(component.repository??'')&&!component.repository.split('/').some(part=>part==='.'||part==='..'),'Source repository must be a public GitHub HTTPS URL');
  requireValue([component.upstreamRevision,component.upstreamTree,component.patchedTree].every(value=>sha.test(value??'')),'Exact source commit and tree IDs required');
  if(component.patch){const patch=component.patch;requireValue(patch.path===`source-patches/${component.id}.patch`&&/^[a-f0-9]{64}$/.test(patch.sha256??'')&&Number.isSafeInteger(patch.bytes)&&patch.bytes>0&&patch.bytes<=8*1024**2,'Invalid source patch declaration');}
  else requireValue(component.upstreamTree===component.patchedTree,'A changed tree requires a declared patch');
 }
 return input;
}

export function validateSourceTree(listing){
 const entries=listing.split('\0').filter(Boolean);requireValue(entries.length>0&&entries.length<=100000,'Source tree entry bound');
 const seen=new Map(),kinds=new Map();
 for(const entry of entries){
  const match=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);requireValue(match,'Source trees must contain regular files only');
  const parts=match[3].split('/');
  requireValue(parts.every(part=>part&&!['.','..','.git'].includes(part.toLowerCase())&&!/[\\:<>"|?*\x00-\x1f]/.test(part)&&!/[. ]$/.test(part)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),'Source path is unsafe or not Windows-portable');
  for(let i=1;i<=parts.length;i++){const exact=parts.slice(0,i).join('/'),folded=exact.toLowerCase(),kind=i===parts.length?'file':'directory';requireValue(!seen.has(folded)||seen.get(folded)===exact,'Source tree has a Windows case collision');requireValue(!kinds.has(folded)||(kinds.get(folded)===kind&&kind==='directory'),'Source tree has a duplicate or file/directory collision');seen.set(folded,exact);kinds.set(folded,kind);}
 }
 return entries.length;
}

async function realDirectory(directory){
 const absolute=path.resolve(directory),parent=path.dirname(absolute);if(parent!==absolute)await realDirectory(parent);
 const info=await fs.lstat(absolute);requireValue(info.isDirectory()&&!info.isSymbolicLink(),'Staging paths cannot contain directory links');
}

export async function stageSources(manifestFile,gitPath,outputDirectory){
 const manifestPath=path.resolve(manifestFile),manifestRoot=path.dirname(manifestPath),input=validateSourceRevisions(JSON.parse(await fs.readFile(manifestPath,'utf8')));
 const output=path.resolve(outputDirectory),git=path.resolve(gitPath),binary=await fs.lstat(git);
 requireValue(binary.isFile()&&!binary.isSymbolicLink(),'An explicit regular Git executable is required');
 await realDirectory(path.dirname(output));await realDirectory(manifestRoot);
 const patches=new Map();
 for(const component of input.components)if(component.patch){
  const patchPath=path.join(manifestRoot,component.patch.path);await realDirectory(path.dirname(patchPath));const info=await fs.lstat(patchPath);
  requireValue(info.isFile()&&!info.isSymbolicLink()&&info.size===component.patch.bytes,'Patch type/size differs');const content=await fs.readFile(patchPath);
  requireValue(createHash('sha256').update(content).digest('hex')===component.patch.sha256,'Patch hash differs');patches.set(component.id,content);
 }
 await fs.mkdir(output); // Never overwrite an existing stage, installation or failed candidate.
 const marker=path.join(output,'SOURCE-STAGING-INCOMPLETE.json'),template=path.join(output,'.empty-git-template');
 await fs.mkdir(template);await fs.mkdir(path.join(output,'packages'));await fs.writeFile(marker,JSON.stringify({status:'in-progress'}),{flag:'wx'});
 const env={SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:process.env.TEMP,TMP:process.env.TMP,PATH:path.join(process.env.SystemRoot,'System32'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL',GIT_CONFIG_SYSTEM:'NUL',GIT_TERMINAL_PROMPT:'0',GIT_AUTHOR_NAME:'Harbor Portable Build',GIT_AUTHOR_EMAIL:'build@localhost',GIT_COMMITTER_NAME:'Harbor Portable Build',GIT_COMMITTER_EMAIL:'build@localhost',GIT_AUTHOR_DATE:input.observedAt,GIT_COMMITTER_DATE:input.observedAt};
 const gitRun=async(cwd,args)=>(await execute(git,['-c','credential.helper=','-c','protocol.file.allow=never','-c','protocol.ext.allow=never','-c','core.autocrlf=false','-c','commit.gpgsign=false','-c',`core.hooksPath=${template}`,...args],{cwd,env,windowsHide:true,timeout:180000,maxBuffer:16*1024**2})).stdout;
 const components=[];
 try{
  for(const component of input.components){
   const target=path.join(output,'packages',component.id);await fs.mkdir(target);
   await gitRun(target,['init','--initial-branch=main',`--template=${template}`]);
   await gitRun(target,['config','core.autocrlf','false']);
   await gitRun(target,['remote','add','origin',component.repository+'.git']);
   await gitRun(target,['fetch','--depth=1','--no-tags','--no-recurse-submodules','origin',component.upstreamRevision]);
   requireValue((await gitRun(target,['rev-parse','FETCH_HEAD'])).trim()===component.upstreamRevision,'Fetched commit differs from pin');
   requireValue((await gitRun(target,['rev-parse','FETCH_HEAD^{tree}'])).trim()===component.upstreamTree,'Fetched tree differs from verified archive');
   validateSourceTree(await gitRun(target,['ls-tree','-r','-z','FETCH_HEAD']));
   await gitRun(target,['read-tree','FETCH_HEAD']);
   let stagedRevision=component.upstreamRevision;
   if(component.patch){
    const patchPath=path.join(output,`.${component.id}.patch`);await fs.writeFile(patchPath,patches.get(component.id),{flag:'wx'});
    // Apply to the index first. Validate every resulting path before checkout.
    await gitRun(target,['apply','--check','--cached',patchPath]);await gitRun(target,['apply','--cached',patchPath]);
    requireValue((await gitRun(target,['write-tree'])).trim()===component.patchedTree,'Applied patch tree differs');
    validateSourceTree(await gitRun(target,['ls-tree','-r','-z',component.patchedTree]));
    stagedRevision=(await gitRun(target,['commit-tree',component.patchedTree,'-p',component.upstreamRevision,'-m',`Apply pinned Harbor compatibility patch for ${component.id}`])).trim();
    await fs.unlink(patchPath);
   }
   await gitRun(target,['update-ref','refs/heads/main',stagedRevision]);
   await gitRun(target,['checkout','--force','main']);
   requireValue((await gitRun(target,['rev-parse','HEAD^{tree}'])).trim()===component.patchedTree,'Staged source tree differs');
   requireValue(!(await gitRun(target,['status','--porcelain','--untracked-files=normal'])).trim(),'Staged source is dirty');
   // Retain the actual upstream commit as an ancestor for maintenance merging.
   await gitRun(target,['merge-base','--is-ancestor',component.upstreamRevision,'HEAD']);
   components.push({id:component.id,path:`packages/${component.id}`,repository:component.repository,upstreamRevision:component.upstreamRevision,tree:component.patchedTree,revision:(await gitRun(target,['rev-parse','HEAD'])).trim(),patchSha256:component.patch?.sha256??null});
  }
  const report={status:'complete',manifestSha256:createHash('sha256').update(await fs.readFile(manifestPath)).digest('hex'),components,scope:'Pinned clean Git source checkouts with patch commits and maintenance ancestry. No dependencies installed, source executed or full Portable acceptance claimed.'};
  await fs.writeFile(path.join(output,'source-stage.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});await fs.unlink(marker);return report;
 }catch(error){await fs.writeFile(marker,JSON.stringify({status:'failed',error:error.message,completed:components},null,2));throw error;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 if(process.argv.length!==5)throw Error('Usage: node stage-sources.mjs <source-revisions.json> <git.exe> <new-output-directory>');
 const result=await stageSources(...process.argv.slice(2));console.log(JSON.stringify({status:result.status,components:result.components.length}));
}
