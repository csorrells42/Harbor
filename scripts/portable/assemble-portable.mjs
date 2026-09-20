import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify,isDeepStrictEqual} from 'node:util';
import {pathToFileURL} from 'node:url';
import {realDirectory,regular,inventory} from './build-node-projects.mjs';
import {validateSourceTree} from './stage-sources.mjs';
import {stageReleaseSupport} from './stage-release.mjs';
import {writeSeedCatalog} from './seed-catalog.mjs';
const execute=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex'),demand=(v,m)=>{if(!v)throw Error(m);};
const kinds={runtime:'runtime-stage.json',browser:'runtime-stage.json',npm:'npm-stage.json',python:'python-stage.json',pythonProjects:'python-project-build.json',source:'source-stage.json',node:'node-project-build.json',dbhub:'dbhub-source-build.json',models:'embedding-stage.json',binaries:'runtime-stage.json',application:'application-build.json'};
export function safeAssemblyPath(value){
 demand(typeof value==='string'&&value.split('/').every(p=>p&&!['.','..'].includes(p)&&!/[\\:\x00-\x1f<>"|?*]/.test(p)&&!/[. ]$/.test(p)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)),'Unsafe assembly path');return value;
}
export function validateAssemblyPlan(plan){
 demand(plan?.schemaVersion===1&&/^[a-z0-9][a-z0-9-]{0,80}$/.test(plan.release??''),'Invalid assembly plan');
 demand(isDeepStrictEqual(Object.keys(plan.stages??{}).sort(),Object.keys(kinds).sort()),'Exactly the reviewed component stages are required');
 for(const [id,entry] of Object.entries(plan.stages)){demand(typeof entry.root==='string'&&entry.root.length>0&&/^[a-f0-9]{64}$/.test(entry.receiptSha256??''),'Each stage needs a root and pinned receipt hash');demand(entry.receipt===kinds[id],'Unexpected stage receipt');}
 return plan;
}
export async function assemblePortable(planFile,outputRoot){
 demand(process.platform==='win32'&&process.arch==='x64','Windows x64 assembly required');
 const planPath=path.resolve(planFile),planBytes=await fs.readFile(planPath),plan=validateAssemblyPlan(JSON.parse(planBytes)),output=path.resolve(outputRoot);
 await realDirectory(path.dirname(output));const stages={};
 for(const [id,item] of Object.entries(plan.stages)){
  const root=path.resolve(path.dirname(planPath),item.root);await realDirectory(root);demand(output!==root&&!output.startsWith(root+path.sep)&&!root.startsWith(output+path.sep),'Assembly cannot overlap an input stage');
  const bytes=await fs.readFile(path.join(root,item.receipt));demand(hash(bytes)===item.receiptSha256,'Stage receipt changed: '+id);const receipt=JSON.parse(bytes);demand(receipt.status==='complete','Incomplete input stage: '+id);stages[id]={root,receipt};
 }
 await fs.mkdir(output);const marker=path.join(output,'ASSEMBLY-INCOMPLETE.json');await fs.writeFile(marker,'{"status":"in-progress"}\n',{flag:'wx'});
 const written=new Map(),components=[];
 async function copyFiles(id,from,files,prefix=''){
  let bytes=0;
  for(const item of files){
   const relative=safeAssemblyPath(item.path),targetRelative=safeAssemblyPath(prefix+relative),key=targetRelative.toLowerCase();
   demand(!written.has(key),'Overlapping assembly target: '+targetRelative);demand(Number.isSafeInteger(item.bytes)&&item.bytes>=0&&/^[a-f0-9]{64}$/.test(item.sha256),'Invalid staged file inventory');
   const source=path.join(from,relative);await regular(source);const data=await fs.readFile(source);demand(data.length===item.bytes&&hash(data)===item.sha256,'Staged file differs: '+id+'/'+relative);
   const target=path.join(output,targetRelative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,data,{flag:'wx'});written.set(key,{path:targetRelative,bytes:item.bytes,sha256:item.sha256});bytes+=item.bytes;
  }
  components.push({id,files:files.length,bytes});console.log(JSON.stringify({assembled:id,files:files.length}));
 }
 const git=path.join(stages.runtime.root,'runtimes/git/cmd/git.exe');
 const gitEnv={SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PATH:path.join(process.env.SystemRoot,'System32'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL',GIT_CONFIG_SYSTEM:'NUL',GIT_TERMINAL_PROMPT:'0'};
 const gitRun=async(folder,args)=>(await execute(git,['-c','core.fsmonitor=false','-c','core.autocrlf=false','-C',folder,...args],{env:gitEnv,windowsHide:true,timeout:60000,maxBuffer:32*1024**2})).stdout;
 try{
  for(const type of ['runtime','browser'])for(const component of stages[type].receipt.components)await copyFiles(type+'/'+component.artifact,stages[type].root,component.files);
  await copyFiles('embedding-models',stages.models.root,stages.models.receipt.files);
  const github=stages.binaries.receipt.components.filter(c=>c.artifact==='github-mcp-win-x64');demand(github.length===1,'Unique GitHub binary required');
  await copyFiles('github',path.join(stages.binaries.root,'runtimes/github-mcp'),github[0].files.map(f=>({...f,path:f.path.replace(/^runtimes\/github-mcp\//,'')})),'packages/github/');
  await fs.writeFile(path.join(output,'packages/github/harbor-version.json'),JSON.stringify({version:github[0].version,sha256:github[0].archiveSha256})+'\n',{flag:'wx'});
  // npm stages have registry-integrity receipts but no complete original file
  // inventory. Record their current files explicitly; do not imply a past hash.
  for(const group of stages.npm.receipt.groups){
   demand(['general-local','browser-docs','search'].includes(group.id),'Unexpected npm group');const root=path.join(stages.npm.root,'packages',group.id);
   await copyFiles('npm/'+group.id,root,await inventory(root),'packages/'+group.id+'/');
  }
  for(const group of stages.python.receipt.groups){
   demand(['python-tools','fastmcp-tools'].includes(group.id),'Unexpected shared Python group');const root=path.join(stages.python.root,'packages',group.id);
   await copyFiles('python/'+group.id,path.join(root,'python'),group.files,'packages/'+group.id+'/python/');
   const inputs=(await inventory(root)).filter(f=>['requirements.in','requirements.txt','requirements.lock.txt'].includes(f.path));await copyFiles('python-inputs/'+group.id,root,inputs,'packages/'+group.id+'/');
  }
  const sourceIds=stages.source.receipt.components.map(c=>c.id);
  demand(sourceIds.length===9&&new Set(sourceIds).size===9,'Expected nine source projects');
  for(const component of stages.source.receipt.components){
   const root=path.join(stages.source.root,'packages',component.id);
   demand((await gitRun(root,['rev-parse','HEAD^{tree}'])).trim()===component.tree,'Source tree changed');
   demand(!(await gitRun(root,['status','--porcelain=v1','--untracked-files=all'])).trim(),'Source stage is dirty');
   demand((await gitRun(root,['config','--get','remote.origin.url'])).trim()===component.repository+'.git','Source origin changed');
   const listing=await gitRun(root,['ls-tree','-rz','HEAD']);validateSourceTree(listing);
   if(stages.pythonProjects.receipt.groups.some(g=>g.id===component.id)){
    await copyFiles('source/'+component.id,root,await inventory(root),'packages/'+component.id+'/');
    const group=stages.pythonProjects.receipt.groups.find(g=>g.id===component.id);demand(group.sourceTree===component.tree,'Python source/build tree differs');
    await copyFiles('built/'+component.id,path.join(stages.pythonProjects.root,'packages',component.id,'python'),group.files,'packages/'+component.id+'/python/');
   }else{
    const isDb=component.id==='dbhub',stage=isDb?stages.dbhub:stages.node,build=isDb?stage.receipt:stage.receipt.projects.find(p=>p.id===component.id);
    demand(build&&build.sourceTree===component.tree,'Node source/build tree differs');
    await copyFiles('built/'+component.id,path.join(stage.root,'packages',component.id),build.files,'packages/'+component.id+'/');
    await copyFiles('history/'+component.id,path.join(root,'.git'),await inventory(path.join(root,'.git')),'packages/'+component.id+'/.git/');
   }
   const exclude=path.join(output,'packages',component.id,'.git/info/exclude');await fs.mkdir(path.dirname(exclude),{recursive:true});await fs.appendFile(exclude,'\n/python/\n/node_modules/\n/dist/\n/frontend/node_modules/\n/frontend/tsconfig.tsbuildinfo\n');
  }
  const app=stages.application,appRoot=path.join(app.root,'application/win-unpacked'),source=path.join(app.root,'source');
  demand(isDeepStrictEqual(await inventory(appRoot),app.receipt.files),'Application output changed');
  for(const file of app.receipt.sourceFiles){await regular(path.join(source,file.path));demand(hash(await fs.readFile(path.join(source,file.path)))===file.sha256,'Application source snapshot changed');}
  await stageReleaseSupport(source,output,{application:appRoot});
  await writeSeedCatalog(path.join(output,'catalog.json'));await fs.writeFile(path.join(output,'portable.json'),'{"version":1}\n',{flag:'wx'});
  const files=(await inventory(output)).filter(f=>f.path!=='ASSEMBLY-INCOMPLETE.json');
  const report={schemaVersion:1,status:'complete',release:plan.release,planSha256:hash(planBytes),stages:Object.fromEntries(Object.entries(plan.stages).map(([id,s])=>[id,{receipt:s.receipt,sha256:s.receiptSha256}])),components,files,scope:'Fresh payload assembled from pinned completed stages, clean catalog and no user profile. Runtime acceptance, complete license inventory and independent clean-user testing are separate. npm file hashes reflect assembly-time observations.'};
  await fs.writeFile(path.join(output,'assembly.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});await fs.unlink(marker);return report;
 }catch(error){await fs.writeFile(marker,JSON.stringify({status:'failed',error:error.message,completed:components.map(c=>c.id)},null,2));throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 demand(process.argv.length===4,'Usage: assemble-portable.mjs <pinned-stage-plan.json> <new-output>');const result=await assemblePortable(...process.argv.slice(2));console.log(JSON.stringify({status:result.status,files:result.files.length}));
}
