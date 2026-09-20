import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify,isDeepStrictEqual} from 'node:util';
import {pathToFileURL} from 'node:url';
import {realDirectory,regular,inventory} from './build-node-projects.mjs';
import {validateNpmLock} from './stage-npm-groups.mjs';
const execute=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex');
const demand=(v,m)=>{if(!v)throw Error(m);};
const sourceItems=['src','assets','tests','docs','third-party','scripts','package.json','package-lock.json','README.md','LICENSE','LICENSING.md','THIRD-PARTY-NOTICES.txt','HARBOR-MANUAL.pdf','playwright.config.mjs'];
const excluded=new Set(['node_modules','.git','.harbor-build','evidence','test-results','playwright-report','__pycache__','.pytest_cache','.venv','.cache','tmp','temp']);
export function includeApplicationSource(relative){
 const parts=relative.split('/');
 return parts.every(p=>p&&!['.','..'].includes(p)&&!excluded.has(p)&&!/[\\:\x00-\x1f]/.test(p))&&!/\.(?:py[co]|tmp|temp|log|key|pem)$/i.test(relative)&&!parts.some(p=>p==='.env'||p.startsWith('.env.'));
}
export function validateApplicationInputs(manifest,lock){
 demand(manifest.name==='mcp-harbor'&&manifest.main==='src/desktop/main.cjs','Expected Harbor application');
 demand(manifest.devDependencies?.electron==='44.3.0'&&manifest.devDependencies?.['electron-builder']==='26.15.3','Unexpected application build tools');
 for(const key of ['dependencies','devDependencies','optionalDependencies'])demand(isDeepStrictEqual(manifest[key]??{},lock.packages?.['']?.[key]??{}),'Application manifest and lock differ');
 return validateNpmLock(manifest,lock);
}
async function snapshot(source,destination){
 const files=[];
 async function copy(relative){
  if(!includeApplicationSource(relative))return;
  const from=path.join(source,relative),to=path.join(destination,relative),info=await fs.lstat(from);
  demand(!info.isSymbolicLink(),'Application source links are not supported');
  if(info.isDirectory()){await fs.mkdir(to,{recursive:true});for(const name of (await fs.readdir(from)).sort())await copy(relative+'/'+name);}
  else {await regular(from);demand(info.size<=64*1024**2,'Application source file exceeds bound');const data=await fs.readFile(from);await fs.mkdir(path.dirname(to),{recursive:true});await fs.writeFile(to,data,{flag:'wx'});files.push({path:relative,bytes:data.length,sha256:hash(data)});}
 }
 for(const item of sourceItems)await copy(item);
 return files.sort((a,b)=>a.path.localeCompare(b.path));
}
export async function buildHarborApplication(sourceRoot,runtimeRoot,binaryRoot,cacheRoot,outputRoot,{offline=false}={}){
 demand(process.platform==='win32'&&process.arch==='x64','Windows x64 build required');
 const source=path.resolve(sourceRoot),runtime=path.resolve(runtimeRoot),binary=path.resolve(binaryRoot),cache=path.resolve(cacheRoot),output=path.resolve(outputRoot);
 demand(!output.startsWith(source+path.sep),'Application output must be outside the source snapshot');
 for(const dir of [source,runtime,binary,cache,path.dirname(output)])await realDirectory(dir);
 const node=path.join(runtime,'runtimes/node/node.exe'),npm=path.join(runtime,'runtimes/node/node_modules/npm/bin/npm-cli.js');
 for(const file of [node,npm])await regular(file);
 const receiptBytes=await fs.readFile(path.join(binary,'runtime-stage.json')),receipt=JSON.parse(receiptBytes);
 const pins=JSON.parse(await fs.readFile(path.join(source,'scripts/portable/application-binary-inputs.windows-x64.json'),'utf8'));
 const pin=pins.artifacts.find(a=>a.id==='electron-win-x64'),components=receipt.components?.filter(c=>c.artifact==='electron-win-x64');
 demand(receipt.status==='complete'&&components?.length===1,'Complete Electron stage required');
 const electron=components[0];demand(electron.archiveSha256===pin.sha256&&electron.version==='44.3.0'&&electron.target==='runtimes/electron','Electron stage does not match approved archive');
 const expected=electron.files.map(f=>{demand(f.path.startsWith('runtimes/electron/'),'Unexpected Electron path');return {...f,path:f.path.slice('runtimes/electron/'.length)};}).sort((a,b)=>a.path.localeCompare(b.path));
 demand(isDeepStrictEqual(await inventory(path.join(binary,electron.target)),expected),'Electron stage files changed');
 const manifestBytes=await fs.readFile(path.join(source,'package.json')),lockBytes=await fs.readFile(path.join(source,'package-lock.json'));
 const dependencies=validateApplicationInputs(JSON.parse(manifestBytes),JSON.parse(lockBytes));
 await fs.mkdir(output);const marker=path.join(output,'APPLICATION-BUILD-INCOMPLETE.json');await fs.writeFile(marker,'{"status":"in-progress"}\n',{flag:'wx'});
 const steps=[];
 try{
  const cwd=path.join(output,'source'),sourceFiles=await snapshot(source,cwd);
  demand(hash(await fs.readFile(path.join(cwd,'package.json')))===hash(manifestBytes)&&hash(await fs.readFile(path.join(cwd,'package-lock.json')))===hash(lockBytes),'Source inputs changed while copying');
  await fs.writeFile(path.join(output,'source-snapshot.json'),JSON.stringify({files:sourceFiles,sha256:hash(JSON.stringify(sourceFiles))},null,2)+'\n',{flag:'wx'});
  const home=path.join(output,'.build-home');for(const dir of ['temp','roaming','local'])await fs.mkdir(path.join(home,dir),{recursive:true});
  const user=path.join(home,'user.npmrc'),global=path.join(home,'global.npmrc');for(const file of [user,global])await fs.writeFile(file,'',{flag:'wx'});
  const env={SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,ComSpec:path.join(process.env.SystemRoot,'System32/cmd.exe'),PATHEXT:'.COM;.EXE;.BAT;.CMD',PATH:[path.dirname(node),path.join(process.env.SystemRoot,'System32'),path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0')].join(path.delimiter),HOME:home,USERPROFILE:home,APPDATA:path.join(home,'roaming'),LOCALAPPDATA:path.join(home,'local'),TEMP:path.join(home,'temp'),TMP:path.join(home,'temp'),CI:'true',ELECTRON_SKIP_BINARY_DOWNLOAD:'1',PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1',CSC_IDENTITY_AUTO_DISCOVERY:'false',npm_config_userconfig:user,npm_config_globalconfig:global};
  const run=async(label,args)=>{console.log(JSON.stringify({application:'harbor',step:label}));try{const result=await execute(node,args,{cwd,env,windowsHide:true,timeout:600000,maxBuffer:16*1024**2});await fs.writeFile(path.join(output,label+'.log'),result.stdout+result.stderr,{flag:'wx'});steps.push(label);}catch(error){await fs.writeFile(path.join(output,label+'.log'),(error.stdout??'')+(error.stderr??'')+'\n'+error.message,{flag:'wx'});throw error;}};
  const args=[npm,'ci','--ignore-scripts','--no-audit','--no-fund','--include=optional','--fetch-retries=0','--fetch-timeout=60000','--registry=https://registry.npmjs.org',`--cache=${cache}`,`--userconfig=${user}`,`--globalconfig=${global}`];if(offline)args.push('--offline');
  await run('dependencies',args);
  await run('package',[path.join(cwd,'node_modules/electron-builder/cli.js'),'--win','--x64','--dir','--publish','never','--config.directories.output='+path.join(output,'application'),'--config.electronDist='+path.join(binary,electron.target),'--config.npmRebuild=false','--config.nodeGypRebuild=false']);
  for(const item of sourceFiles){const data=await fs.readFile(path.join(cwd,item.path));demand(hash(data)===item.sha256,'Build mutated application source');}
  const packaged=path.join(output,'application/win-unpacked');await regular(path.join(packaged,'MCP Harbor.exe'));await regular(path.join(packaged,'resources/app.asar'));
  const report={status:'complete',offline,sourceSha256:hash(JSON.stringify(sourceFiles)),sourceFiles,dependencies,suppressedInstallScripts:dependencies.filter(d=>d.installScriptSuppressed).map(d=>d.path),electronReceiptSha256:hash(receiptBytes),electronArchiveSha256:pin.sha256,steps,files:await inventory(packaged),scope:'Clean locked application package from a recorded source snapshot and verified Electron runtime. Installer, full toolbox assembly, UI acceptance and complete license inventory are separate gates.'};
  await fs.writeFile(path.join(output,'application-build.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});await fs.unlink(marker);return report;
 }catch(error){await fs.writeFile(marker,JSON.stringify({status:'failed',steps,error:error.message},null,2));throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);demand(args.length===5||args.length===6&&args[5]==='--offline','Usage: build-harbor-application.mjs <source> <runtime-stage> <binary-stage> <npm-cache> <new-output> [--offline]');
 const result=await buildHarborApplication(...args.slice(0,5),{offline:args[5]==='--offline'});console.log(JSON.stringify({status:result.status,files:result.files.length,sourceSha256:result.sourceSha256}));
}
