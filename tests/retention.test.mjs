import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createMaintenance} from '../src/core/maintenance.mjs';
import {pruneApplicationReleases} from '../src/core/release-retention.mjs';

test('no component backups: verified replacement, failed build cleanup and interrupted activation recovery',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-retention-'));
  const active=path.join(root,'packages/tool'),state=path.join(root,'data/maintenance');
  await fs.mkdir(active,{recursive:true});await fs.writeFile(path.join(active,'version'),'old');
  const manifest={version:1,retainBackups:false,applicationBackups:1,components:[{id:'tool',name:'Tool',path:'packages/tool',build:[{command:process.execPath,args:['-e',"require('fs').writeFileSync('version','new')"]}],verify:[{command:process.execPath,args:['-e',"if(require('fs').readFileSync('version','utf8')!=='new')process.exit(1)"]}]}]};
  let manager;
  try{
    await fs.writeFile(path.join(root,'maintenance.json'),JSON.stringify(manifest));
    manager=await createMaintenance({root,isPaused:()=>true});manager.start('tool',{rebuild:true});
    assert.equal(manager.snapshot().components[0].canRestore,false);
    assert.equal((await manager.wait()).phase,'complete');
    assert.equal(await fs.readFile(path.join(active,'version'),'utf8'),'new');
    assert.deepEqual(await fs.readdir(path.join(state,'backups')),[]);
    assert.deepEqual(await fs.readdir(path.join(state,'staging')),[]);
    await assert.rejects(manager.rollback('tool'),/not retained/);await manager.close();
    manifest.components[0].verify[0].args=['-e','process.exit(2)'];
    await fs.writeFile(path.join(root,'maintenance.json'),JSON.stringify(manifest));
    manager=await createMaintenance({root,isPaused:()=>true});manager.start('tool',{rebuild:true});
    assert.equal((await manager.wait()).phase,'failed');
    assert.equal(await fs.readFile(path.join(active,'version'),'utf8'),'new');
    assert.deepEqual(await fs.readdir(path.join(state,'staging')),[]);await manager.close();
    const backup='data/maintenance/backups/interrupted';await fs.mkdir(path.join(root,backup));
    await fs.writeFile(path.join(root,backup,'version'),'old');
    await fs.writeFile(path.join(state,'activation.json'),JSON.stringify({target:'packages/tool',backup,stage:'data/maintenance/staging/missing',component:'tool'}));
    manager=await createMaintenance({root,isPaused:()=>true});
    await assert.rejects(fs.access(path.join(root,backup)));await assert.rejects(fs.access(path.join(state,'rollback-tool.json')));
    assert.equal(await fs.readFile(path.join(active,'version'),'utf8'),'new');
  }finally{await manager?.close();await fs.rm(root,{recursive:true,force:true});}
});

test('application retention keeps current plus one prior build and rejects an invalid pointer before deletion',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-releases-'));
  const app=path.join(root,'application');
  try{
    for(const dir of ['initial','releases/old','releases/previous','releases/current']){
      await fs.mkdir(path.join(app,dir),{recursive:true});await fs.writeFile(path.join(app,dir,'MCP Harbor.exe'),'fixture');
    }
    await fs.mkdir(path.join(root,'data/workspace'),{recursive:true});await fs.writeFile(path.join(root,'data/workspace/user.txt'),'keep');
    await fs.writeFile(path.join(app,'current.json'),JSON.stringify({path:'application/releases/missing'}));
    await fs.writeFile(path.join(app,'previous.json'),JSON.stringify({path:'application/releases/previous'}));
    await assert.rejects(pruneApplicationReleases(root,{applicationBackups:1}));
    await fs.access(path.join(app,'initial/MCP Harbor.exe'));
    await fs.writeFile(path.join(app,'current.json'),JSON.stringify({path:'application/releases/current'}));
    await pruneApplicationReleases(root,{applicationBackups:1});
    assert.deepEqual((await fs.readdir(path.join(app,'releases'))).sort(),['current','previous']);
    await assert.rejects(fs.access(path.join(app,'initial')));
    assert.equal(await fs.readFile(path.join(root,'data/workspace/user.txt'),'utf8'),'keep');
    await fs.writeFile(path.join(root,'maintenance.json'),JSON.stringify({version:1,retainBackups:false,applicationBackups:1,components:[{id:'harbor',name:'Harbor',path:'packages/harbor',selfUpdate:true}]}));
    const manager=await createMaintenance({root,isPaused:()=>true});
    try{assert.equal(manager.snapshot().components[0].canRestore,true);await manager.rollback('harbor');await fs.access(path.join(root,'data/maintenance/pending-self-rollback.json'));}finally{await manager.close();}
    await pruneApplicationReleases(root,{applicationBackups:0});
    assert.deepEqual(await fs.readdir(path.join(app,'releases')),['current']);
    await assert.rejects(fs.access(path.join(app,'previous.json')));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});


for(const checkpoint of ['before-backup','after-backup'])test('no-backup recovery removes abandoned staging '+checkpoint,async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-recovery-stage-'));
  const target=path.join(root,'packages/tool'),stage='data/maintenance/staging/interrupted',backup='data/maintenance/backups/interrupted',state=path.join(root,'data/maintenance');
  let manager;
  try{
    await fs.mkdir(target,{recursive:true});await fs.writeFile(path.join(target,'version'),'old');
    await fs.mkdir(path.join(root,stage),{recursive:true});await fs.writeFile(path.join(root,stage,'version'),'candidate');
    await fs.mkdir(path.dirname(path.join(root,backup)),{recursive:true});
    await fs.mkdir(path.join(root,'data/workspace'),{recursive:true});await fs.writeFile(path.join(root,'data/workspace/user.txt'),'preserve');
    await fs.writeFile(path.join(root,'maintenance.json'),JSON.stringify({version:1,retainBackups:false,applicationBackups:0,components:[{id:'tool',name:'Tool',path:'packages/tool'}]}));
    if(checkpoint==='after-backup')await fs.rename(target,path.join(root,backup));
    await fs.writeFile(path.join(state,'activation.json'),JSON.stringify({target:'packages/tool',backup,stage,component:'tool'}));
    manager=await createMaintenance({root,isPaused:()=>true});
    assert.equal(await fs.readFile(path.join(target,'version'),'utf8'),'old');
    assert.deepEqual(await fs.readdir(path.join(state,'staging')),[]);
    assert.deepEqual(await fs.readdir(path.join(state,'backups')),[]);
    await assert.rejects(fs.access(path.join(state,'activation.json')),{code:'ENOENT'});
    assert.equal(await fs.readFile(path.join(root,'data/workspace/user.txt'),'utf8'),'preserve');
  }finally{await manager?.close();await fs.rm(root,{recursive:true,force:true});}
});

test('recovery cleanup refuses non-staging paths and keeps the journal and user data',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-recovery-boundary-'));
  const target=path.join(root,'packages/tool'),state=path.join(root,'data/maintenance');
  try{
    await fs.mkdir(target,{recursive:true});await fs.writeFile(path.join(target,'version'),'old');
    await fs.mkdir(path.join(root,'data/workspace'),{recursive:true});await fs.writeFile(path.join(root,'data/workspace/user.txt'),'preserve');await fs.mkdir(state,{recursive:true});
    await fs.writeFile(path.join(root,'maintenance.json'),JSON.stringify({version:1,retainBackups:false,components:[{id:'tool',name:'Tool',path:'packages/tool'}]}));
    for(const stage of ['data/workspace','packages/tool','data/maintenance/staging']){
      await fs.writeFile(path.join(state,'activation.json'),JSON.stringify({target:'packages/tool',backup:'data/maintenance/backups/missing',stage,component:'tool'}));
      await assert.rejects(createMaintenance({root,isPaused:()=>true}),/Invalid maintenance recovery staging path/);
      await fs.access(path.join(state,'activation.json'));assert.equal(await fs.readFile(path.join(target,'version'),'utf8'),'old');
      assert.equal(await fs.readFile(path.join(root,'data/workspace/user.txt'),'utf8'),'preserve');
    }
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('recovery cleanup preserves the candidate and journal when neither active nor backup exists',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-recovery-missing-active-'));
  const state=path.join(root,'data/maintenance'),stage='data/maintenance/staging/only-candidate';
  try{
    await fs.mkdir(path.join(root,stage),{recursive:true});await fs.writeFile(path.join(root,stage,'version'),'candidate');
    await fs.writeFile(path.join(root,'maintenance.json'),JSON.stringify({version:1,retainBackups:false,components:[{id:'tool',name:'Tool',path:'packages/tool'}]}));
    await fs.writeFile(path.join(state,'activation.json'),JSON.stringify({target:'packages/tool',backup:'data/maintenance/backups/missing',stage,component:'tool'}));
    await assert.rejects(createMaintenance({root,isPaused:()=>true}),/active component is missing/);
    await fs.access(path.join(state,'activation.json'));assert.equal(await fs.readFile(path.join(root,stage,'version'),'utf8'),'candidate');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
