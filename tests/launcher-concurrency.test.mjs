import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';

const exists=file=>fs.access(file).then(()=>true,()=>false);
if(process.argv[2]==='launcher-worker'){
  const root=process.argv[3],pause=process.argv[4],events=[];
  const checkpoint=async name=>{process.send({type:'checkpoint',name});await new Promise(resolve=>process.once('message',resolve));};
  const cp=fs.cp,rename=fs.rename,readFile=fs.readFile,createServer=net.createServer;
  let paused=false;
  fs.cp=async(...args)=>{await cp(...args);events.push({type:'copy',target:args[1]});if(pause==='copied'&&!paused){paused=true;await checkpoint('copied');}};
  fs.rename=async(...args)=>{
    await rename(...args);
    if(pause==='prepared'&&!paused&&args[1]===path.join(root,'data/maintenance/pending-self-update.json')){
      const pending=JSON.parse(await readFile(args[1],'utf8'));
      if(pending.activation&&!pending.activation.complete){paused=true;await checkpoint('prepared');}
    }
  };
  fs.readFile=async(...args)=>{if(args[0]===path.join(root,'data/maintenance/pending-self-update.json'))events.push({type:'read-pending'});return readFile(...args);};
  net.createServer=(...args)=>{const server=createServer(...args);server.on('error',error=>{if(error.code==='EADDRINUSE')process.send({type:'contended',events:[...events]});});return server;};
  childProcess.spawn=(executable,args,options)=>{
    events.push({type:'spawn',executable,cwd:options.cwd});const child=new EventEmitter();child.unref=()=>{};
    if(pause==='spawn-error')queueMicrotask(()=>child.emit('error',Error('Injected fixture spawn failure')));
    else if(pause==='spawn-handoff')void checkpoint('spawn-handoff').then(()=>child.emit('spawn'));
    else queueMicrotask(()=>child.emit('spawn'));
    return child;
  };
  syncBuiltinESMExports();
  await import(pathToFileURL(path.join(root,'support/launcher.mjs')).href);
  const error=await readFile(path.join(root,'launch-error.txt'),'utf8').catch(()=>null);
  process.send({type:'done',exitCode:process.exitCode??0,events,error});process.disconnect();
}else{
  async function fixture(t){
    const parent=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-launch-concurrency-')),root=path.join(parent,'Moved ü folder');
    const children=[];
    t.after(async()=>{
      for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
      await Promise.all(children.map(child=>child.closed));
      assert(path.resolve(root).startsWith(path.resolve(parent)+path.sep));await fs.rm(parent,{recursive:true,force:true,maxRetries:10,retryDelay:100});
    });
    await fs.mkdir(path.join(root,'application/initial'),{recursive:true});await fs.writeFile(path.join(root,'application/initial/MCP Harbor.exe'),'old');
    await fs.writeFile(path.join(root,'application/current.json'),JSON.stringify({path:'application/initial'}));
    await fs.mkdir(path.join(root,'data/maintenance'),{recursive:true});await fs.mkdir(path.join(root,'data/workspace'),{recursive:true});
    await fs.writeFile(path.join(root,'data/harbor-settings.json'),'{"port":41234,"networkEnabled":false}');await fs.writeFile(path.join(root,'data/workspace/user.txt'),'user-data-sentinel');
    const stage='packages/harbor-source',output='artifact/win-unpacked';const outputPath=path.join(root,stage,output);
    await fs.mkdir(outputPath,{recursive:true});await fs.writeFile(path.join(outputPath,'MCP Harbor.exe'),'candidate');await fs.writeFile(path.join(outputPath,'payload.txt'),'runtime');
    await fs.writeFile(path.join(root,'maintenance.json'),JSON.stringify({version:1,retainBackups:false,applicationBackups:0,components:[{id:'harbor',path:stage,output,selfUpdate:true}]}));
    const pendingPath=path.join(root,'data/maintenance/pending-self-update.json');await fs.writeFile(pendingPath,JSON.stringify({stage,output,component:'harbor'}));
    await fs.mkdir(path.join(root,'support'),{recursive:true});await fs.copyFile(new URL('../scripts/portable/launcher.mjs',import.meta.url),path.join(root,'support/launcher.mjs'));await fs.copyFile(new URL('../src/core/release-retention.mjs',import.meta.url),path.join(root,'support/release-retention.mjs'));
    let alias;
    if(process.platform==='win32')alias=root.toUpperCase();
    else{alias=path.join(parent,'alias');await fs.symlink(root,alias,'dir');}
    const invoke=(pause='',useAlias=false)=>{
      const child=childProcess.spawn(process.execPath,[fileURLToPath(import.meta.url),'launcher-worker',useAlias?alias:root,pause],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});children.push(child);
      const received=[],waiters=[];let stderr='',closed=false;
      child.stderr.on('data',chunk=>stderr+=chunk);child.stdout.resume();
      child.closed=new Promise(resolve=>child.once('close',(code,signal)=>{closed=true;for(const waiter of waiters)waiter.reject(Error('Worker exited at '+waiter.type+': '+code+'/'+signal+' '+stderr));resolve({code,signal});}));
      child.on('error',error=>{for(const waiter of waiters)waiter.reject(error);});
      child.on('message',event=>{received.push(event);for(const waiter of [...waiters])if(waiter.type===event.type){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(event);}});
      return {child,received,next(type){const previous=received.find(event=>event.type===type);if(previous)return Promise.resolve(previous);if(closed)return Promise.reject(Error('Worker already exited: '+stderr));return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);reject(Error('Worker timed out at '+type+': '+stderr));},10000);const waiter={type,resolve:event=>{clearTimeout(timer);resolve(event);},reject:error=>{clearTimeout(timer);reject(error);}};waiters.push(waiter);});}};
    };
    return {root,outputPath,pendingPath,invoke};
  }
  async function assertActivated(f,result){
    assert.equal(result.exitCode,0,result.error);assert.equal(result.events.filter(event=>event.type==='spawn').length,1);
    const current=JSON.parse(await fs.readFile(path.join(f.root,'application/current.json'),'utf8'));
    assert.equal(await fs.readFile(path.join(f.root,current.path,'MCP Harbor.exe'),'utf8'),'candidate');
    assert.deepEqual(await fs.readdir(path.join(f.root,'application/releases')),[path.basename(current.path)]);
    assert.equal(await exists(f.pendingPath),false);assert.equal(await exists(f.outputPath),false);assert.equal(await exists(path.join(f.root,'application/initial')),false);
    assert.equal(await fs.readFile(path.join(f.root,'data/workspace/user.txt'),'utf8'),'user-data-sentinel');assert.equal(await fs.readFile(path.join(f.root,'data/harbor-settings.json'),'utf8'),'{"port":41234,"networkEnabled":false}');
  }
  for(const pause of ['copied','spawn-handoff'])test('concurrent launcher waits through '+pause+' and reads fresh activation state',{timeout:20000},async t=>{
    const f=await fixture(t),owner=f.invoke(pause);await owner.next('checkpoint');
    const waiter=f.invoke('',true),contended=await waiter.next('contended');
    assert.deepEqual(contended.events,[],'waiting launcher must not read or copy pending activation before entry');
    owner.child.send({resume:true});const [first,second]=await Promise.all([owner.next('done'),waiter.next('done')]);
    await assertActivated(f,first);await assertActivated(f,second);
    assert.equal([...first.events,...second.events].filter(event=>event.type==='copy').length,1);
    await assertActivated(f,await f.invoke().next('done'));
  });
  test('owner process termination releases activation lock and resumes the prepared release',{timeout:20000},async t=>{
    const f=await fixture(t),owner=f.invoke('prepared');await owner.next('checkpoint');
    const prepared=JSON.parse(await fs.readFile(f.pendingPath,'utf8')).activation.target;
    const waiter=f.invoke();await waiter.next('contended');owner.child.kill('SIGKILL');await owner.child.closed;
    const result=await waiter.next('done');await assertActivated(f,result);
    assert.equal(result.events.filter(event=>event.type==='copy').length,0);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'application/current.json'),'utf8')).path,prepared);
  });
  test('failed child spawn releases activation lock for the next launcher',{timeout:20000},async t=>{
    const f=await fixture(t),failed=await f.invoke('spawn-error').next('done');assert.equal(failed.exitCode,1);assert.match(failed.error,/Injected fixture spawn failure/);
    await assertActivated(f,await f.invoke().next('done'));
  });
}
