import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createMaintenance,runBuildCommand,contained} from '../src/core/maintenance.mjs';

test('self-update recovery retains rollback metadata and pending activation can be cancelled',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-self-update-'));
  const state=path.join(root,'data/maintenance'),active=path.join(root,'packages/harbor');
  await fs.mkdir(active,{recursive:true});await fs.mkdir(state,{recursive:true});
  await fs.writeFile(path.join(active,'version.txt'),'old');
  await fs.writeFile(path.join(root,'maintenance.json'),JSON.stringify({version:1,components:[{id:'harbor',name:'Harbor',path:'packages/harbor',selfUpdate:true,output:'artifact',build:[{command:process.execPath,args:['-e',"require('fs').writeFileSync('version.txt','new')"]}],verify:[{command:process.execPath,args:['-e',"if(require('fs').readFileSync('version.txt','utf8')!=='new')process.exit(1)"]}]}]}));
  let manager=await createMaintenance({root,isPaused:()=>true});
  try{
    manager.start('harbor',{rebuild:true});assert.equal((await manager.wait()).phase,'restart-required');
    const pending=JSON.parse(await fs.readFile(path.join(state,'pending-self-update.json'),'utf8'));assert.equal(pending.stage,'packages/harbor');
    await manager.rollback('harbor');assert.equal(await fs.readFile(path.join(active,'version.txt'),'utf8'),'old');
    await assert.rejects(fs.access(path.join(state,'pending-self-update.json')));
    await manager.close();
    // Power loss after directory activation but before metadata publication.
    const backup='data/maintenance/recovery-backup';await fs.mkdir(path.join(root,backup),{recursive:true});
    await fs.writeFile(path.join(root,backup,'version.txt'),'previous');
    await fs.writeFile(path.join(state,'activation.json'),JSON.stringify({target:'packages/harbor',backup,stage:'data/maintenance/missing-stage',component:'harbor',selfUpdate:true,output:'artifact'}));
    manager=await createMaintenance({root,isPaused:()=>true});
    assert.equal(JSON.parse(await fs.readFile(path.join(state,'rollback-harbor.json'),'utf8')).backup,backup);
    assert.equal(JSON.parse(await fs.readFile(path.join(state,'pending-self-update.json'),'utf8')).output,'artifact');
    await manager.rollback('harbor');assert.equal(await fs.readFile(path.join(active,'version.txt'),'utf8'),'previous');
  }finally{await manager.close();await fs.rm(root,{recursive:true,force:true});}
});

test('staged local builds preserve data, retain working version on failure, and roll back',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-build-test-'));
  const active=path.join(root,'packages/fixture');await fs.mkdir(active,{recursive:true});await fs.writeFile(path.join(active,'version.txt'),'old');
  await fs.mkdir(path.join(root,'data'),{recursive:true});await fs.writeFile(path.join(root,'data/user.txt'),'keep');
  const manifest={version:1,components:[{id:'fixture',name:'Fixture',path:'packages/fixture',build:[{command:process.execPath,args:['-e',"require('fs').writeFileSync('version.txt','new')"]}],verify:[{command:process.execPath,args:['-e',"if(require('fs').readFileSync('version.txt','utf8')!=='new')process.exit(1)"]}]}]};
  await fs.writeFile(path.join(root,'maintenance.json'),JSON.stringify(manifest));let paused=false;
  const manager=await createMaintenance({root,isPaused:()=>paused});
  try{
    assert.throws(()=>manager.start('fixture'),/maintenance mode/);paused=true;manager.start('fixture');assert.throws(()=>manager.start('fixture'),/already running/);
    assert.equal((await manager.wait()).phase,'complete');assert.equal(await fs.readFile(path.join(active,'version.txt'),'utf8'),'new');
    await manager.rollback('fixture');assert.equal(await fs.readFile(path.join(active,'version.txt'),'utf8'),'old');
    assert.equal(await fs.readFile(path.join(root,'data/user.txt'),'utf8'),'keep');
    manifest.components[0].verify[0].args=['-e','process.exit(2)'];await fs.writeFile(path.join(root,'maintenance.json'),JSON.stringify(manifest));
    const failed=await createMaintenance({root,isPaused:()=>true});failed.start('fixture');assert.equal((await failed.wait()).phase,'failed');await failed.close();
    assert.equal(await fs.readFile(path.join(active,'version.txt'),'utf8'),'old');
    // Simulate interruption after backing up the old directory but before publishing.
    await fs.rename(active,path.join(root,'data/interrupted'));await fs.writeFile(path.join(root,'data/maintenance/activation.json'),JSON.stringify({target:'packages/fixture',backup:'data/interrupted'}));
    const recovered=await createMaintenance({root,isPaused:()=>true});assert.equal(await fs.readFile(path.join(active,'version.txt'),'utf8'),'old');await recovered.close();
    assert.throws(()=>contained(root,'../outside'),/escapes/);
  }finally{await manager.close();await fs.rm(root,{recursive:true,force:true});}
});

test('repository updates preserve local commits, detect current versions and retain active source on conflicts',async()=>{
  const git=process.platform==='win32'
    ? (process.env.PATH||process.env.Path).split(path.delimiter).map(p=>path.join(p,'git.exe')).find(existsSync)
    : execFileSync('which',['git'],{encoding:'utf8'}).trim().split(/\r?\n/)[0];
  assert(git,'Git must be available for repository maintenance acceptance');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-git-update-'));
  const remote=path.join(root,'upstream'),active=path.join(root,'packages/fixture');
  const run=(cwd,args)=>execFileSync(git,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const commit=cwd=>run(cwd,['-c','user.name=Fixture','-c','user.email=fixture@localhost','-c','commit.gpgsign=false','commit','-am','fixture']);
  await fs.mkdir(remote,{recursive:true});run(remote,['init']);await fs.writeFile(path.join(remote,'version.txt'),'one');run(remote,['add','.']);commit(remote);
  await fs.mkdir(path.dirname(active),{recursive:true});run(root,['clone',remote,active]);
  await fs.writeFile(path.join(active,'local.txt'),'preserve local fix');run(active,['add','.']);commit(active);
  await fs.writeFile(path.join(remote,'version.txt'),'two');commit(remote);
  await fs.writeFile(path.join(root,'maintenance.json'),JSON.stringify({version:1,components:[{id:'fixture',name:'Fixture',path:'packages/fixture',repository:remote,verify:[{command:process.execPath,args:['-e',"if(require('fs').readFileSync('local.txt','utf8')!=='preserve local fix')process.exit(1)"]}]}]}));
  const manager=await createMaintenance({root,isPaused:()=>true,gitCommand:git});
  try{
    manager.start('fixture');let result=await manager.wait();assert.equal(result.phase,'complete',result.error);assert.equal(await fs.readFile(path.join(active,'version.txt'),'utf8'),'two');
    manager.start('fixture');assert.equal((await manager.wait()).phase,'current');
    await fs.writeFile(path.join(active,'version.txt'),'local version');commit(active);
    await fs.writeFile(path.join(remote,'version.txt'),'conflicting upstream');commit(remote);
    manager.start('fixture');result=await manager.wait();assert.equal(result.phase,'failed');assert.equal(await fs.readFile(path.join(active,'version.txt'),'utf8'),'local version');
    assert.equal(run(active,['status','--porcelain']),'');
    await fs.writeFile(path.join(active,'unsaved.txt'),'keep unsaved work');manager.start('fixture');assert.match((await manager.wait()).error,/local changes/);
  }finally{await manager.close();await fs.rm(root,{recursive:true,force:true});}
});
