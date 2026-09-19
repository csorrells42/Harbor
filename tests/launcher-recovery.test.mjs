import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {EventEmitter} from 'node:events';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {pruneApplicationReleases} from '../src/core/release-retention.mjs';

const launcher=await fs.readFile(new URL('../scripts/portable/launcher.mjs',import.meta.url),'utf8');
const body=launcher.replace(/^import .*;\r?\n/gm,'');
const exists=file=>fs.access(file).then(()=>true,()=>false);
let sequence=1700000000000;
async function fixture(t,{retainBackups=false,applicationBackups=0}={}){
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-launch-recovery-'));
  const root=path.join(parent,'Moved ü folder');
  t.after(()=>fs.rm(parent,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  await fs.mkdir(path.join(root,'application/initial'),{recursive:true});
  await fs.writeFile(path.join(root,'application/initial/MCP Harbor.exe'),'old');
  await fs.writeFile(path.join(root,'application/current.json'),JSON.stringify({path:'application/initial'}));
  await fs.mkdir(path.join(root,'data/maintenance'),{recursive:true});
  await fs.mkdir(path.join(root,'data/workspace'),{recursive:true});
  await fs.writeFile(path.join(root,'data/workspace/user.txt'),'preserve user data');
  await fs.writeFile(path.join(root,'data/harbor-settings.json'),'{"port":41234,"networkEnabled":false}');
  const stage='packages/harbor-source',output='artifact/win-unpacked',outputPath=path.join(root,stage,output);
  await fs.mkdir(outputPath,{recursive:true});await fs.writeFile(path.join(outputPath,'MCP Harbor.exe'),'new');await fs.writeFile(path.join(outputPath,'payload.txt'),'runtime');
  await fs.writeFile(path.join(root,'maintenance.json'),JSON.stringify({version:1,retainBackups,applicationBackups,components:[{id:'harbor',path:stage,output,selfUpdate:true}]}));
  await fs.writeFile(path.join(root,'data/maintenance/pending-self-update.json'),JSON.stringify({stage,output,component:'harbor'}));
  return {root,outputPath,copies:0};
}
// Run the production launcher against real disposable files. The final spawn is
// recorded; native first-window behavior has its own launcher-visibility test.
async function invoke(f,fault){
  const {root,outputPath}=f,pointer=path.join(root,'application/current.json'),pending=path.join(root,'data/maintenance/pending-self-update.json');
  const launches=[],state={platform:process.platform,exitCode:0,env:{ELECTRON_RUN_AS_NODE:'1',HARBOR_DATA_DIR:'host-profile',HARBOR_PORT:'9'}};let fired=false;
  const wrapped={...fs,cp:async(from,to,options)=>{f.copies++;return fs.cp(from,to,options);}};
  if(fault==='publish-pointer'||fault==='publish-complete')wrapped.rename=async(from,to)=>{
    const complete=to===pending&&JSON.parse(await fs.readFile(from,'utf8')).activation?.complete;
    if(!fired&&((fault==='publish-pointer'&&to===pointer)||(fault==='publish-complete'&&complete))){fired=true;throw Error('Injected publication interruption');}
    return fs.rename(from,to);
  };
  if(fault==='partial-output')wrapped.rm=async(file,options)=>{
    if(!fired&&file===outputPath){fired=true;await fs.unlink(path.join(file,'MCP Harbor.exe'));throw Error('Injected partial output deletion');}
    return fs.rm(file,options);
  };
  if(fault==='remove-pending')wrapped.unlink=async file=>{if(!fired&&file===pending){fired=true;throw Error('Injected marker deletion interruption');}return fs.unlink(file);};
  const spawn=(executable,args,options)=>{launches.push({executable,args,options});const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;};
  const url=pathToFileURL(path.join(root,'support/launcher.mjs')).href;
  const context=vm.createContext({fs:wrapped,path,fileURLToPath,pruneApplicationReleases,createServer,createHash,delay,process:state,spawn,Date:{now:()=>++sequence}});
  await vm.runInContext(`(async()=>{${body.replaceAll('import.meta.url',JSON.stringify(url))}\n})()`,context);
  return {exitCode:state.exitCode,launches,fired};
}
async function assertActivated(f,result){
  assert.equal(result.exitCode,0);assert.equal(result.launches.length,1);
  const current=JSON.parse(await fs.readFile(path.join(f.root,'application/current.json'),'utf8'));
  assert.equal(await fs.readFile(path.join(f.root,current.path,'MCP Harbor.exe'),'utf8'),'new');
  assert.deepEqual(await fs.readdir(path.join(f.root,'application/releases')),[path.basename(current.path)]);
  assert.equal(await exists(path.join(f.root,'application/initial')),false);
  assert.equal(await exists(f.outputPath),false);assert.equal(await exists(path.join(f.root,'data/maintenance/pending-self-update.json')),false);
  assert.equal(await fs.readFile(path.join(f.root,'data/workspace/user.txt'),'utf8'),'preserve user data');
  assert.equal(await fs.readFile(path.join(f.root,'data/harbor-settings.json'),'utf8'),'{"port":41234,"networkEnabled":false}');
  assert.equal(result.launches[0].options.cwd,f.root);assert.equal(result.launches[0].options.env.HARBOR_PORTABLE_ROOT,f.root);
  for(const key of ['ELECTRON_RUN_AS_NODE','HARBOR_DATA_DIR','HARBOR_PORT'])assert.equal(key in result.launches[0].options.env,false);
}

test('pending portable activation supports relocated paths and preserves settings with no backups',async t=>{
  const f=await fixture(t);await assertActivated(f,await invoke(f));assert.equal(f.copies,1);
});
for(const fault of ['publish-pointer','publish-complete','partial-output','remove-pending'])test('launcher resumes '+fault+' without recopying the application release',async t=>{
  const f=await fixture(t);const failed=await invoke(f,fault);assert.equal(failed.fired,true);assert.equal(failed.exitCode,1);assert.equal(failed.launches.length,0);
  const pending=JSON.parse(await fs.readFile(path.join(f.root,'data/maintenance/pending-self-update.json'),'utf8'));assert.ok(pending.activation.target);
  if(fault==='partial-output'){assert.equal(await exists(path.join(f.outputPath,'MCP Harbor.exe')),false);assert.equal(await exists(path.join(f.outputPath,'payload.txt')),true);}
  await assertActivated(f,await invoke(f));assert.equal(f.copies,1);
});
test('completed activation refuses cleanup after the current pointer changes',async t=>{
  const f=await fixture(t);await invoke(f,'partial-output');
  await fs.writeFile(path.join(f.root,'application/current.json'),JSON.stringify({path:'application/initial'}));
  const result=await invoke(f);assert.equal(result.exitCode,1);assert.equal(result.launches.length,0);assert.equal(f.copies,1);
  assert.equal(await exists(path.join(f.outputPath,'payload.txt')),true);assert.equal(await exists(path.join(f.root,'data/maintenance/pending-self-update.json')),true);
  assert.equal(await fs.readFile(path.join(f.root,'data/workspace/user.txt'),'utf8'),'preserve user data');
  assert.match(await fs.readFile(path.join(f.root,'launch-error.txt'),'utf8'),/Current application changed/);
});
test('pending cleanup refuses an output that does not match the owned maintenance recipe',async t=>{
  const f=await fixture(t);await invoke(f,'partial-output');
  const pendingPath=path.join(f.root,'data/maintenance/pending-self-update.json'),pending=JSON.parse(await fs.readFile(pendingPath,'utf8'));
  pending.stage='data';pending.output='workspace';await fs.writeFile(pendingPath,JSON.stringify(pending));
  const result=await invoke(f);assert.equal(result.exitCode,1);assert.equal(result.launches.length,0);assert.equal(f.copies,1);
  assert.equal(await fs.readFile(path.join(f.root,'data/workspace/user.txt'),'utf8'),'preserve user data');assert.equal(await exists(pendingPath),true);
  assert.match(await fs.readFile(path.join(f.root,'launch-error.txt'),'utf8'),/does not match its maintenance recipe/);
});
test('retained-backup mode keeps the previous application and staged build after a retried publication',async t=>{
  const f=await fixture(t,{retainBackups:true,applicationBackups:1});await invoke(f,'publish-complete');const result=await invoke(f);
  assert.equal(result.exitCode,0);assert.equal(f.copies,1);assert.equal(result.launches.length,1);
  assert.equal(await exists(f.outputPath),true);assert.equal(await exists(path.join(f.root,'application/initial/MCP Harbor.exe')),true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root,'application/previous.json'),'utf8')),{path:'application/initial'});
  assert.equal(await exists(path.join(f.root,'data/maintenance/pending-self-update.json')),false);
});
