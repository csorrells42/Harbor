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
