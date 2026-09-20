import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {applyNpmPatches} from './apply-npm-patches.mjs';
const execute=promisify(execFile),groups=['general-local','browser-docs','search'];
const demand=(condition,message)=>{if(!condition)throw Error(message);};
const digest=buffer=>createHash('sha256').update(buffer).digest('hex');

export function validateNpmLock(manifest,lock){
 demand(lock?.lockfileVersion===3&&lock.packages?.[''],'A version 3 npm lock is required');
 const entries=Object.entries(lock.packages);demand(entries.length>1&&entries.length<=10000,'npm package count exceeds the build bound');
 demand(JSON.stringify(manifest.dependencies)===JSON.stringify(lock.packages[''].dependencies),'Root dependency declarations differ from the lock');
 const packages=[];
 for(const [location,entry] of entries){
  if(!location)continue;
  demand(location.startsWith('node_modules/')&&!location.includes('\\')&&location.split('/').every(part=>part&&!['.','..'].includes(part)&&!/[\x00-\x1f:<>"|?*]/.test(part)),'Unsafe dependency location');
  demand(!entry.link&&typeof entry.version==='string'&&entry.version.length>0,'Linked/unversioned dependencies are not supported');
  let url;try{url=new URL(entry.resolved);}catch{throw Error('Dependency needs an exact registry URL');}
  demand(url.protocol==='https:'&&url.hostname==='registry.npmjs.org'&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname.endsWith('.tgz'),'Dependency must use a credential-free official npm registry archive');
  demand(/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity??''),'Dependency needs SHA-512 registry integrity');
  packages.push({path:location,version:entry.version,integrity:entry.integrity,url:entry.resolved,installScriptSuppressed:entry.hasInstallScript===true,optional:entry.optional===true});
 }
 return packages;
}

async function realDirectory(directory){
 const absolute=path.resolve(directory),parent=path.dirname(absolute);if(parent!==absolute)await realDirectory(parent);
 const info=await fs.lstat(absolute);demand(info.isDirectory()&&!info.isSymbolicLink(),'Build directories cannot contain directory links');
}

export async function stageNpmGroups(manifestFile,runtimeRoot,cacheDirectory,outputDirectory,{offline=false}={}){
 demand(process.platform==='win32','This recipe is pinned for Windows x64');
 demand(process.arch==='x64','This recipe requires an x64 build process');
 const inputFile=path.resolve(manifestFile),inputRoot=path.dirname(inputFile),inputBytes=await fs.readFile(inputFile),input=JSON.parse(inputBytes);
 demand(input.schemaVersion===1&&Array.isArray(input.files)&&input.files.length<=128,'Invalid package-input manifest');
 const output=path.resolve(outputDirectory),cache=path.resolve(cacheDirectory),runtime=path.resolve(runtimeRoot);
 await realDirectory(inputRoot);await realDirectory(runtime);await realDirectory(cache);await realDirectory(path.dirname(output));
 const node=path.join(runtime,'runtimes/node/node.exe'),npm=path.join(runtime,'runtimes/node/node_modules/npm/bin/npm-cli.js');
 for(const file of [node,npm]){const info=await fs.lstat(file);demand(info.isFile()&&!info.isSymbolicLink(),'Explicit staged Node/npm files required');await realDirectory(path.dirname(file));}
 const prepared=[];
 for(const id of groups){
  const content={};
  for(const file of ['package.json','package-lock.json']){
   const matches=input.files.filter(item=>item.id===id&&item.file===file);demand(matches.length===1,'A unique pinned npm input is required');const item=matches[0];
   demand(item.path===`package-inputs/${id}/${file}`&&Number.isSafeInteger(item.bytes)&&item.bytes>0&&item.bytes<=16*1024**2&&/^[a-f0-9]{64}$/.test(item.sha256),'Invalid pinned npm input');
   const source=path.join(inputRoot,item.path);await realDirectory(path.dirname(source));const info=await fs.lstat(source);demand(info.isFile()&&!info.isSymbolicLink()&&info.size===item.bytes,'npm input type/size differs');
   const bytes=await fs.readFile(source);demand(digest(bytes)===item.sha256,'npm input SHA-256 differs');content[file]=bytes;
  }
  const packages=validateNpmLock(JSON.parse(content['package.json']),JSON.parse(content['package-lock.json']));prepared.push({id,content,packages});
 }
 await fs.mkdir(output); // Existing output, installations and failed stages are never replaced.
 const marker=path.join(output,'NPM-STAGING-INCOMPLETE.json');await fs.writeFile(marker,'{"status":"in-progress"}\n',{flag:'wx'});
 const home=path.join(output,'.build-home');await fs.mkdir(home);await fs.mkdir(path.join(home,'temp'));await fs.mkdir(path.join(home,'roaming'));await fs.mkdir(path.join(home,'local'));
 const npmrc=path.join(home,'user.npmrc'),globalNpmrc=path.join(home,'global.npmrc');for(const file of [npmrc,globalNpmrc])await fs.writeFile(file,'',{flag:'wx'});await fs.mkdir(path.join(output,'packages'));
 const env={SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PATH:[path.dirname(node),path.join(process.env.SystemRoot,'System32')].join(path.delimiter),HOME:home,USERPROFILE:home,APPDATA:path.join(home,'roaming'),LOCALAPPDATA:path.join(home,'local'),TEMP:path.join(home,'temp'),TMP:path.join(home,'temp'),CI:'1',PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1'};
 const results=[];
 try{
  for(const group of prepared){
   const cwd=path.join(output,'packages',group.id);await fs.mkdir(cwd);
   for(const [file,bytes] of Object.entries(group.content))await fs.writeFile(path.join(cwd,file),bytes,{flag:'wx'});
   const args=[npm,'ci','--ignore-scripts','--no-audit','--no-fund','--include=optional','--fetch-retries=0','--fetch-timeout=60000','--registry=https://registry.npmjs.org',`--cache=${cache}`,`--userconfig=${npmrc}`,`--globalconfig=${globalNpmrc}`];if(offline)args.push('--offline');
   const result=await execute(node,args,{cwd,env,windowsHide:true,timeout:600000,maxBuffer:8*1024**2});
   await fs.writeFile(path.join(output,`${group.id}.npm.log`),result.stdout+result.stderr,{flag:'wx'});
   for(const [file,bytes] of Object.entries(group.content))demand(digest(await fs.readFile(path.join(cwd,file)))===digest(bytes),'npm changed a pinned input');
   const patches=await applyNpmPatches(cwd,group.id);
   const present=[];
   for(const entry of group.packages){
    try{const installed=JSON.parse(await fs.readFile(path.join(cwd,entry.path,'package.json'),'utf8'));demand(installed.version===entry.version,'Installed npm package version differs');present.push({path:entry.path,name:installed.name,version:installed.version,integrity:entry.integrity,license:installed.license??null,installScriptSuppressed:entry.installScriptSuppressed});}
    catch(error){if(error.code==='ENOENT'&&entry.optional)continue;throw error;}
   }
   results.push({id:group.id,declaredPackages:group.packages.length,installedPackages:present.length,packages:present,patches});
  }
  const report={status:'complete',manifestSha256:digest(inputBytes),offline,groups:results,scope:'Integrity-checked npm ci extraction with lifecycle scripts disabled and isolated account/config environment. Native helper assets, suppressed install steps and actual MCP functionality require separate acceptance; this is not a complete toolbox build.'};
  await fs.writeFile(path.join(output,'npm-stage.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});await fs.unlink(marker);return report;
 }catch(error){await fs.writeFile(marker,JSON.stringify({status:'failed',error:error.message,completedGroups:results.map(group=>group.id)},null,2));throw error;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);if(args.length<4||args.length>5||args.length===5&&args[4]!=='--offline')throw Error('Usage: node stage-npm-groups.mjs <package-inputs.json> <runtime-stage> <existing-cache> <new-output> [--offline]');
 const report=await stageNpmGroups(...args.slice(0,4),{offline:args[4]==='--offline'});console.log(JSON.stringify({status:report.status,groups:report.groups.map(({id,installedPackages})=>({id,installedPackages}))}));
}
