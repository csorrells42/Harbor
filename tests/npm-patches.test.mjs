import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {applyNpmPatches} from '../scripts/portable/apply-npm-patches.mjs';
const digest=text=>createHash('sha256').update(text).digest('hex');
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-patch-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const parent=path.join(root,'node_modules/example');await fs.mkdir(parent,{recursive:true});
 await fs.writeFile(path.join(parent,'package.json'),JSON.stringify({name:'example',version:'1.0.0'}));
 await fs.writeFile(path.join(parent,'index.js'),'before\n');
 const patch={id:'fixture',group:'general-local',packageName:'example',version:'1.0.0',packageJson:'node_modules/example/package.json',file:'node_modules/example/index.js',beforeSha256:digest('before\n'),afterSha256:digest('after\n'),edits:[{before:'before',after:'after'}]};
 return {root,parent,patch,manifest:{schemaVersion:1,patches:[patch]}};
}
test('versioned package patch verifies bytes and is idempotent',async t=>{
 const {root,parent,manifest}=await fixture(t);
 const first=await applyNpmPatches(root,'general-local',{manifest});assert.equal(first.patches[0].alreadyApplied,false);assert.equal(await fs.readFile(path.join(parent,'index.js'),'utf8'),'after\n');
 const next=await applyNpmPatches(root,'general-local',{manifest});assert.equal(next.patches[0].alreadyApplied,true);
 assert.deepEqual((await applyNpmPatches(root,'search',{manifest})).patches,[]);
});
test('version and source drift fail without overwriting the original',async t=>{
 const {root,parent,patch,manifest}=await fixture(t);patch.version='2.0.0';
 await assert.rejects(applyNpmPatches(root,'general-local',{manifest}),/version mismatch/);patch.version='1.0.0';
 await fs.writeFile(path.join(parent,'index.js'),'upstream changed\n');await assert.rejects(applyNpmPatches(root,'general-local',{manifest}),/source drift/);
 assert.equal(await fs.readFile(path.join(parent,'index.js'),'utf8'),'upstream changed\n');
});
test('all patch inputs and expected outputs are validated before a write',async t=>{
 const {root,parent,patch,manifest}=await fixture(t);patch.afterSha256=digest('wrong');
 await assert.rejects(applyNpmPatches(root,'general-local',{manifest}),/output differs/);assert.equal(await fs.readFile(path.join(parent,'index.js'),'utf8'),'before\n');
 patch.afterSha256=digest('after\n');manifest.patches.push({...patch,id:'bad',file:'node_modules/example/missing.js'});
 await assert.rejects(applyNpmPatches(root,'general-local',{manifest}),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(parent,'index.js'),'utf8'),'before\n');
});
test('unsafe destinations, package escape and duplicate paths are rejected',async t=>{
 const {root,patch,manifest}=await fixture(t);
 for(const file of ['../outside','node_modules/example/../outside','node_modules/example/C:bad','node_modules/other/index.js','node_modules/example/NUL.txt']){
  await assert.rejects(applyNpmPatches(root,'general-local',{manifest:{schemaVersion:1,patches:[{...patch,file}]}}),/Unsafe/);
 }
 manifest.patches.push({...patch,id:'duplicate'});await assert.rejects(applyNpmPatches(root,'general-local',{manifest}),/duplicate/);
});
