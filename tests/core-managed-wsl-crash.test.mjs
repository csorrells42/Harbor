import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { wslBootstrap } from '../src/core/wsl-bootstrap.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchManaged } from '../src/core/managed-processes.mjs';
// Opt in: this is an ACTUAL wsl.exe crash, not a launch-spec mock.
const enabled=process.platform==='win32'&&process.env.HARBOR_TEST_WSL==='1';
const linuxPath=p=>p.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,d)=>`/mnt/${d.toLowerCase()}`);
function linux(code,...args){return execFileSync('wsl.exe',['--distribution','Ubuntu','--exec','python3','-c',code,...args.map(String)],{encoding:'utf8'}).trim();}
const identity=pid=>linux('import sys; from pathlib import Path; p=Path("/proc/"+sys.argv[1]+"/stat"); print(p.read_text().rsplit(")",1)[1].split()[19] if p.exists() else "gone")',pid);
test('WSL bootstrap refuses user code when its cleanup acknowledgement cannot be written',{skip:!enabled,timeout:15000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'harbor-wsl-prerequisite-'));
  const child=spawn('wsl.exe',['--distribution','Ubuntu','--exec','python3','-u','-c',wslBootstrap],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const closed=new Promise(resolve=>child.once('close',resolve));child.stderr.resume();
  const outcome=new Promise((resolve,reject)=>{
    child.once('error',reject);child.once('exit',()=>resolve({exited:true}));
    createInterface({input:child.stdout}).on('line',line=>resolve(JSON.parse(line)));
  });
  try {
    child.stdin.write(JSON.stringify({command:'/usr/bin/node',args:['-e','setInterval(()=>{},1000)'],completionPath:join(dir,'missing','complete')})+'\n');
    const result=await outcome;
    assert.equal(result.pid,undefined,'must fail before launching the owned command');
    assert.match(result.error,/ENOENT|No such file/);
  } finally {child.stdin.end();await closed;await rm(dir,{recursive:true,force:true});}
});

test('actual WSL launcher abrupt death reaps detached Linux descendants before close resolves',{skip:!enabled,timeout:30000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'harbor-wsl-crash-'));const file=join(dir,'tree.json');
  const source=`const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(process.env.TREE_FILE,JSON.stringify({pid:process.pid,child:c.pid}));setInterval(()=>{},1000);`;
  const owned=launchManaged({runtime:'wsl',distro:'Ubuntu',command:'/usr/bin/node',args:['-e',source],env:{TREE_FILE:linuxPath(file)}},()=>{},()=>{});
  const identities=new Map();
  try {
    await owned.ready;
    let tree;for(let n=0;n<200&&!tree;n++){tree=await readFile(file,'utf8').then(JSON.parse,()=>null);if(!tree)await new Promise(r=>setTimeout(r,25));}
    assert.ok(tree,'real fixture running');
    for(const pid of [tree.pid,tree.child,owned.record.supervisorPid])identities.set(pid,identity(pid));
    process.kill(owned.record.launcherPid,'SIGKILL');
    await owned.close();
    for(const [pid] of identities)assert.equal(identity(pid),'gone',`Linux PID ${pid} must be reaped when close resolves after wsl.exe death`);
  } finally {
    await owned.close();
    // Rescue only identity-verified fixture processes; never PID alone.
    for(const [pid,start] of identities)linux('import os,sys,signal; from pathlib import Path\npid=int(sys.argv[1]); p=Path("/proc/%s/stat"%pid)\nif p.exists():\n fd=os.pidfd_open(pid)\n if p.exists() and p.read_text().rsplit(")",1)[1].split()[19]==sys.argv[2]: signal.pidfd_send_signal(fd,signal.SIGKILL)\n os.close(fd)',pid,start);
    await rm(dir,{recursive:true,force:true});
  }
});
