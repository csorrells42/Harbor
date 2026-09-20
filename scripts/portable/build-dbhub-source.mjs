import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {realDirectory,regular,inventory} from './build-node-projects.mjs';
import {validateSourceTree} from './stage-sources.mjs';
const execute=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex'),demand=(v,m)=>{if(!v)throw Error(m);};
export function validateDbhubInput(input){
 demand(input?.schemaVersion===1&&Array.isArray(input.components),'Invalid source Node inputs');
 const matches=input.components.filter(c=>c.id==='dbhub');demand(matches.length===1,'Unique DBHub source input required');const item=matches[0];
 demand(item.packageManager==='pnpm@10.17.1'&&/^[a-f0-9]{40}$/.test(item.sourceTree??''),'Pinned DBHub tree and package manager required');
 const names=['package.json','frontend/package.json','pnpm-lock.yaml','pnpm-workspace.yaml'];
 demand(item.files?.length===names.length,'Unexpected DBHub input file set');
 for(const name of names){const files=item.files.filter(f=>f.path==='source-node-inputs/dbhub/'+name);demand(files.length===1&&/^[a-f0-9]{64}$/.test(files[0].sha256??'')&&Number.isSafeInteger(files[0].bytes)&&files[0].bytes>0&&files[0].bytes<=16*1024**2,'Invalid pinned DBHub input file');}
 return item;
}
export async function buildDbhubSource(manifestFile,sourceRoot,runtimeRoot,pnpmRoot,storeRoot,outputRoot,{offline=false}={}){
 demand(process.platform==='win32'&&process.arch==='x64','Windows x64 build required');
 const inputFile=path.resolve(manifestFile),base=path.dirname(inputFile),source=path.resolve(sourceRoot,'packages/dbhub'),runtime=path.resolve(runtimeRoot),pnpmStage=path.resolve(pnpmRoot),store=path.resolve(storeRoot),output=path.resolve(outputRoot);
 for(const dir of [base,source,runtime,pnpmStage,store,path.dirname(output)])await realDirectory(dir);
 const inputBytes=await fs.readFile(inputFile),item=validateDbhubInput(JSON.parse(inputBytes));
 const node=path.join(runtime,'runtimes/node/node.exe'),git=path.join(runtime,'runtimes/git/cmd/git.exe'),pnpm=path.join(pnpmStage,'runtimes/pnpm/bin/pnpm.cjs');
 for(const file of [node,git,pnpm])await regular(file);
 const stage=JSON.parse(await fs.readFile(path.join(pnpmStage,'runtime-stage.json'),'utf8'));
 demand(stage.status==='complete'&&stage.release==='phase2-node-build-tools-1','Verified pnpm stage required');
 const toolInput=JSON.parse(await fs.readFile(path.join(base,'node-build-tools.windows-x64.json'),'utf8'));
 demand(stage.components?.length===1&&stage.components[0].artifact==='pnpm-build-tool'&&stage.components[0].archiveSha256===toolInput.artifacts?.find(a=>a.id==='pnpm-build-tool')?.sha256,'pnpm stage does not match pinned archive');
 demand(Array.isArray(stage.components[0].files)&&stage.components[0].files.length===stage.files,'Invalid pnpm file inventory');
 for(const file of stage.components[0].files){const target=path.resolve(pnpmStage,file.path);demand(target.startsWith(pnpmStage+path.sep),'Unsafe pnpm inventory path');await regular(target);const data=await fs.readFile(target);demand(data.length===file.bytes&&hash(data)===file.sha256,'pnpm staged bytes changed');}
 const packageInfo=JSON.parse(await fs.readFile(path.join(pnpmStage,'runtimes/pnpm/package.json'),'utf8'));demand(packageInfo.name==='pnpm'&&packageInfo.version==='10.17.1','Unexpected pnpm version');
 const gitRun=async args=>(await execute(git,['-c','core.fsmonitor=false','-C',source,...args],{windowsHide:true,timeout:60000,maxBuffer:16*1024**2})).stdout;
 demand((await gitRun(['rev-parse','HEAD^{tree}'])).trim()===item.sourceTree,'DBHub source tree changed');
 demand(!(await gitRun(['status','--porcelain=v1','--untracked-files=normal'])).trim(),'DBHub source checkout is not clean');
 const listing=await gitRun(['ls-tree','-rz','HEAD']);validateSourceTree(listing);
 const pinned=new Map();for(const file of item.files){const target=path.join(base,file.path);await regular(target);const data=await fs.readFile(target);demand(data.length===file.bytes&&hash(data)===file.sha256,'DBHub captured input changed');pinned.set(file.path.replace('source-node-inputs/dbhub/',''),data);}
 demand(JSON.parse(pinned.get('package.json')).packageManager===item.packageManager,'Source package manager differs');
 await fs.mkdir(output);const marker=path.join(output,'DBHUB-BUILD-INCOMPLETE.json');await fs.writeFile(marker,'{"status":"in-progress"}\n',{flag:'wx'});
 const cwd=path.join(output,'packages/dbhub'),home=path.join(output,'.build-home');await fs.mkdir(cwd,{recursive:true});for(const dir of ['temp','roaming','local'])await fs.mkdir(path.join(home,dir),{recursive:true});
 const npmrc=path.join(home,'user.npmrc'),globalrc=path.join(home,'global.npmrc');for(const file of [npmrc,globalrc])await fs.writeFile(file,'',{flag:'wx'});
 const env={SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PATH:[path.dirname(node),path.join(process.env.SystemRoot,'System32')].join(path.delimiter),HOME:home,USERPROFILE:home,APPDATA:path.join(home,'roaming'),LOCALAPPDATA:path.join(home,'local'),TEMP:path.join(home,'temp'),TMP:path.join(home,'temp'),CI:'true',npm_config_userconfig:npmrc,npm_config_globalconfig:globalrc,COREPACK_ENABLE_PROJECT_SPEC:'0'};
 const steps=[];
 try{
  let total=0;for(const entry of listing.split('\0').filter(Boolean)){const match=/^\d+ blob ([a-f0-9]{40})\t(.+)$/.exec(entry),file=path.join(source,match[2]);demand((await regular(file)).size<=32*1024**2,'Source file exceeds bound');const data=await fs.readFile(file);total+=data.length;demand(total<=128*1024**2,'Source tree exceeds bound');demand(createHash('sha1').update(Buffer.from(`blob ${data.length}\0`)).update(data).digest('hex')===match[1],'Source blob differs');const target=path.join(cwd,match[2]);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,data,{flag:'wx'});}
  for(const [name,data] of pinned)demand(hash(await fs.readFile(path.join(cwd,name)))===hash(data),'Staged DBHub input differs');
  const run=async(label,args)=>{console.log(JSON.stringify({project:'dbhub',step:label}));const result=await execute(node,[pnpm,...args],{cwd,env,windowsHide:true,timeout:600000,maxBuffer:16*1024**2});await fs.writeFile(path.join(output,label+'.log'),result.stdout+result.stderr,{flag:'wx'});steps.push(label);};
  const install=['install','--frozen-lockfile','--ignore-scripts','--node-linker=hoisted','--package-import-method=copy',`--store-dir=${store}`,'--registry=https://registry.npmjs.org','--config.verify-store-integrity=true','--config.manage-package-manager-versions=false'];if(offline)install.push('--offline');
  await run('dependencies',install);
  await run('api-types',['run','generate:api-types']);await run('backend',['exec','tsup']);
  await run('frontend-types',['--dir','frontend','exec','tsc','-b']);await run('frontend',['--dir','frontend','exec','vite','build']);
  await run('sqlite-integration',['exec','vitest','run','--maxWorkers=1','--project','integration','src/connectors/__tests__/sqlite.integration.test.ts','src/connectors/__tests__/multi-sqlite-sources.integration.test.ts']);
  await run('production-dependencies',[...install,'--prod']);
  for(const file of ['dist/index.js','dist/public/index.html'])await regular(path.join(cwd,file));
  for(const [name,data] of pinned)demand(hash(await fs.readFile(path.join(cwd,name)))===hash(data),'Build changed pinned DBHub manifest/lock');
  const report={status:'complete',offline,manifestSha256:hash(inputBytes),sourceTree:item.sourceTree,pnpmVersion:packageInfo.version,steps,files:await inventory(cwd),scope:'Full backend/frontend source build and actual SQLite integration tests; lifecycle scripts disabled. MCP and non-SQLite connector acceptance remain separate.'};
  await fs.writeFile(path.join(output,'dbhub-source-build.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});await fs.unlink(marker);return report;
 }catch(error){await fs.writeFile(marker,JSON.stringify({status:'failed',steps,error:error.message},null,2));throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const args=process.argv.slice(2);demand(args.length===6||args.length===7&&args[6]==='--offline','Usage: build-dbhub-source.mjs <inputs> <source-stage> <runtime-stage> <pnpm-stage> <store> <new-output> [--offline]');const report=await buildDbhubSource(...args.slice(0,6),{offline:args[6]==='--offline'});console.log(JSON.stringify({status:report.status,files:report.files.length,steps:report.steps}));}
