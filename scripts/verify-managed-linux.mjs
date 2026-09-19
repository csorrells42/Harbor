// Exercise the native Linux code path with real setsid descendants (Python 3 required).
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchManaged } from '../src/core/managed-processes.mjs';
if(process.platform!=='linux')throw new Error('Requires native Linux Node');
const dir=await mkdtemp(join(tmpdir(),'harbor-native-owned-'));
const treeFile=join(dir,'tree.json');
const source=`const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(process.env.TREE_FILE,JSON.stringify({pid:process.pid,child:c.pid}));setInterval(()=>{},1000);`;
const identity=pid=>readFile(`/proc/${pid}/stat`,'utf8').then(s=>s.slice(s.lastIndexOf(')')+2).split(' ')[19],()=>null);
let owned,tree,childIdentity;
try {
  owned=launchManaged({command:process.execPath,args:['-e',source],env:{TREE_FILE:treeFile}},()=>{},()=>{});
  await owned.ready;
  for(let n=0;n<200&&!tree;n++){tree=await readFile(treeFile,'utf8').then(JSON.parse,()=>null);if(!tree)await new Promise(r=>setTimeout(r,25));}
  assert.ok(tree,'fixture started');childIdentity=await identity(tree.child);assert.ok(childIdentity);
  await owned.close();
  assert.equal(await identity(tree.child),null,'native Linux close must reap setsid descendant');
  assert.equal(await identity(tree.pid),null,'native Linux primary reaped');
  assert.equal(await identity(owned.record.supervisorPid),null,'native Linux supervisor reaped');
  console.log(JSON.stringify({verified:true,runtime:'native',platform:process.platform,checks:['setsid descendant reaped','primary reaped','supervisor reaped'],processes:tree}));
} finally {
  await owned?.close();
  // Failed-regression rescue is restricted to the fixture PID AND its starttime.
  if(tree&&childIdentity&&await identity(tree.child)===childIdentity)process.kill(tree.child,'SIGKILL');
  await rm(dir,{recursive:true,force:true});
}
