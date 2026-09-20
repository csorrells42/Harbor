import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify,isDeepStrictEqual} from 'node:util';
import {pathToFileURL} from 'node:url';
import {validateNpmLock} from './stage-npm-groups.mjs';
import {validateSourceTree} from './stage-sources.mjs';
const execute=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex');
const demand=(ok,message)=>{if(!ok)throw Error(message);};
const projects=['typst-mcp','portkey-tools'];

export function validateNodeProjectInputs(component,manifest,lock){
 demand(projects.includes(component?.id)&&/^[a-f0-9]{40}$/.test(component.sourceTree??''),'Unsupported Node source project or tree');
 demand(manifest.scripts?.build==='tsc','Only the reviewed TypeScript build entry is supported');
 for(const group of ['dependencies','devDependencies','optionalDependencies'])demand(isDeepStrictEqual(manifest[group]??{},lock.packages?.['']?.[group]??{}),'Manifest and lock dependency declarations differ');
 return validateNpmLock(manifest,lock);
}
async function realDirectory(directory){
 const absolute=path.resolve(directory),parent=path.dirname(absolute);if(parent!==absolute)await realDirectory(parent);
 const info=await fs.lstat(absolute);demand(info.isDirectory()&&!info.isSymbolicLink(),'Build path contains a directory link');
}
async function regular(file){await realDirectory(path.dirname(file));const info=await fs.lstat(file);demand(info.isFile()&&!info.isSymbolicLink(),'Expected a regular build input');return info;}
async function inventory(directory,prefix=''){
 const files=[];
 for(const entry of await fs.readdir(directory,{withFileTypes:true})){
  const relative=prefix+entry.name,file=path.join(directory,entry.name);demand(!entry.isSymbolicLink(),'Unexpected link in built package');
  if(entry.isDirectory())files.push(...await inventory(file,relative+'/'));
  else {demand(entry.isFile(),'Unexpected build output kind');const bytes=await fs.readFile(file);files.push({path:relative,bytes:bytes.length,sha256:hash(bytes)});}
 }
 return files.sort((a,b)=>a.path.localeCompare(b.path));
}
export {realDirectory,regular,inventory};

export async function buildNodeProjects(manifestFile,sourceRoot,runtimeRoot,cacheDirectory,outputDirectory,{offline=false}={}){
 demand(process.platform==='win32'&&process.arch==='x64','Recipe requires Windows x64');
 const inputFile=path.resolve(manifestFile),inputRoot=path.dirname(inputFile),source=path.resolve(sourceRoot),runtime=path.resolve(runtimeRoot),cache=path.resolve(cacheDirectory),output=path.resolve(outputDirectory);
 for(const dir of [inputRoot,source,runtime,cache,path.dirname(output)])await realDirectory(dir);
 const bytes=await fs.readFile(inputFile),input=JSON.parse(bytes);
 demand(input.schemaVersion===1&&Array.isArray(input.components),'Invalid source Node input manifest');
 const node=path.join(runtime,'runtimes/node/node.exe'),npm=path.join(runtime,'runtimes/node/node_modules/npm/bin/npm-cli.js'),git=path.join(runtime,'runtimes/git/cmd/git.exe');
 for(const file of [node,npm,git])await regular(file);
 const gitRun=async(folder,args)=>(await execute(git,['-c','core.fsmonitor=false','-c','core.autocrlf=false','-C',folder,...args],{windowsHide:true,timeout:60000,maxBuffer:16*1024**2})).stdout;
 const prepared=[];
 for(const id of projects){
  const matches=input.components.filter(c=>c.id===id);demand(matches.length===1,'Unique pinned Node project required');const component=matches[0],content={};
  for(const name of ['package.json','package-lock.json']){
   const pinned=component.files.filter(f=>f.path===`source-node-inputs/${id}/${name}`);demand(pinned.length===1,'Unique pinned manifest/lock required');const item=pinned[0],file=path.join(inputRoot,item.path);
   demand((await regular(file)).size===item.bytes,'Pinned input size differs');const data=await fs.readFile(file);demand(hash(data)===item.sha256,'Pinned input hash differs');content[name]=data;
  }
  const packages=validateNodeProjectInputs(component,JSON.parse(content['package.json']),JSON.parse(content['package-lock.json']));
  const folder=path.join(source,'packages',id);await realDirectory(folder);
  demand((await gitRun(folder,['rev-parse','HEAD^{tree}'])).trim()===component.sourceTree,'Source tree identity differs');
  demand(!(await gitRun(folder,['status','--porcelain=v1','--untracked-files=normal'])).trim(),'Source checkout is not clean');
  const listing=await gitRun(folder,['ls-tree','-rz','HEAD']);validateSourceTree(listing);
  const entries=listing.split('\0').filter(Boolean).map(line=>{const m=/^\d+ blob ([a-f0-9]{40})\t(.+)$/.exec(line);return {blob:m[1],name:m[2]};});
  prepared.push({id,component,folder,content,packages,entries});
 }
 await fs.mkdir(output);const marker=path.join(output,'NODE-PROJECTS-INCOMPLETE.json');await fs.writeFile(marker,'{"status":"in-progress"}\n',{flag:'wx'});
 const home=path.join(output,'.build-home');for(const name of ['temp','roaming','local'])await fs.mkdir(path.join(home,name),{recursive:true});
 const userconfig=path.join(home,'user.npmrc'),globalconfig=path.join(home,'global.npmrc');for(const file of [userconfig,globalconfig])await fs.writeFile(file,'',{flag:'wx'});
 const env={SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PATH:[path.dirname(node),path.join(process.env.SystemRoot,'System32')].join(path.delimiter),HOME:home,USERPROFILE:home,APPDATA:path.join(home,'roaming'),LOCALAPPDATA:path.join(home,'local'),TEMP:path.join(home,'temp'),TMP:path.join(home,'temp'),CI:'1',PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1',npm_config_userconfig:userconfig,npm_config_globalconfig:globalconfig};
 const results=[];
 try{
  for(const project of prepared){
   const cwd=path.join(output,'packages',project.id);await fs.mkdir(cwd,{recursive:true});let total=0;
   for(const entry of project.entries){
    const file=path.join(project.folder,entry.name),info=await regular(file);demand(info.size<=32*1024**2,'Source file exceeds bound');const data=await fs.readFile(file);total+=data.length;demand(total<=128*1024**2,'Source tree exceeds bound');
    demand(createHash('sha1').update(Buffer.from(`blob ${data.length}\0`)).update(data).digest('hex')===entry.blob,'Source bytes differ from reviewed Git blob');
    const target=path.join(cwd,entry.name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,data,{flag:'wx'});
   }
   for(const [name,data] of Object.entries(project.content))demand(hash(await fs.readFile(path.join(cwd,name)))===hash(data),'Copied source manifest differs from pin');
   const npmArgs=['--ignore-scripts','--no-audit','--no-fund','--fetch-retries=0','--fetch-timeout=60000','--registry=https://registry.npmjs.org',`--cache=${cache}`,`--userconfig=${userconfig}`,`--globalconfig=${globalconfig}`];if(offline)npmArgs.push('--offline');
   const run=async(label,args)=>{const result=await execute(node,args,{cwd,env,windowsHide:true,timeout:600000,maxBuffer:8*1024**2});await fs.writeFile(path.join(output,project.id+'.'+label+'.log'),result.stdout+result.stderr,{flag:'wx'});};
   await run('install',[npm,'ci','--include=optional',...npmArgs]);
   await run('build',[path.join(cwd,'node_modules/typescript/bin/tsc')]);
   await regular(path.join(cwd,'dist/index.js'));
   await run('prune',[npm,'prune','--omit=dev',...npmArgs]);
   for(const [name,data] of Object.entries(project.content))demand(hash(await fs.readFile(path.join(cwd,name)))===hash(data),'Build changed pinned manifest or lock');
   const files=await inventory(cwd);
   results.push({id:project.id,sourceTree:project.component.sourceTree,files,sourceBytes:total,suppressedInstallScripts:project.packages.filter(p=>p.installScriptSuppressed).map(p=>p.path),runtimeAcceptance:'pending'});
  }
  const report={status:'complete',manifestSha256:hash(bytes),offline,projects:results,scope:'TypeScript compilation from verified reviewed source trees, locked npm extraction and production pruning. Lifecycle scripts disabled. Native assets and real component behavior require independent acceptance.'};
  await fs.writeFile(path.join(output,'node-project-build.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});await fs.unlink(marker);return report;
 }catch(error){await fs.writeFile(marker,JSON.stringify({status:'failed',error:error.message,completedProjects:results.map(p=>p.id)},null,2));throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);demand(args.length===5||args.length===6&&args[5]==='--offline','Usage: build-node-projects.mjs <source-node-inputs.json> <source-stage> <runtime-stage> <npm-cache> <new-output> [--offline]');
 const report=await buildNodeProjects(...args.slice(0,5),{offline:args[5]==='--offline'});console.log(JSON.stringify({status:report.status,projects:report.projects.map(p=>({id:p.id,files:p.files.length,suppressedInstallScripts:p.suppressedInstallScripts}))}));
}
