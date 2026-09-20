import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchManaged } from '../src/core/managed-processes.mjs';

const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};

test('Windows supervisor crash acknowledges an empty job before close resolves', {skip:process.platform!=='win32',timeout:25000}, async()=>{
  const dir=await mkdtemp(join(tmpdir(),'harbor-windows-job-'));
  const file=join(dir,'tree.json');
  const source=`const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});fs.writeFileSync(process.env.TREE_FILE,JSON.stringify({pid:process.pid,child:c.pid}));setInterval(()=>{},1000);`;
  const owned=launchManaged({command:process.execPath,args:['-e',source],env:{TREE_FILE:file}},()=>{},()=>{});
  try {
    await owned.ready;
    let tree;const deadline=Date.now()+5000;
    while(!tree&&Date.now()<deadline){
      tree=await readFile(file,'utf8').then(JSON.parse,error=>{if(error.code!=='ENOENT')throw error;});
      if(!tree)await new Promise(r=>setTimeout(r,25));
    }
    assert.ok(tree,'the real child and detached grandchild started');
    assert.ok(alive(tree.pid));assert.ok(alive(tree.child));
    process.kill(owned.record.launcherPid,'SIGKILL');
    await owned.close();
    for(const pid of [tree.pid,tree.child,owned.record.launcherPid])assert.equal(alive(pid),false,`PID ${pid} must be gone when close resolves`);
  } finally {await owned.close();await rm(dir,{recursive:true,force:true});}
});

test('Windows ownership lease can close before launch readiness without starting a survivor', {skip:process.platform!=='win32',timeout:25000}, async()=>{
  const owned=launchManaged({command:process.execPath,args:['-e','setInterval(()=>{},1000)']},()=>{},()=>{});
  // Consume the readiness outcome even when cancellation wins before spawn.
  const ready=owned.ready.catch(()=>undefined);
  await owned.close();
  for(const pid of [owned.record.launcherPid,owned.record.pid].filter(Boolean))assert.equal(alive(pid),false);
  // A cancelled pre-spawn launch need not produce a ready record.
  if(owned.record.pid)await ready;
});
