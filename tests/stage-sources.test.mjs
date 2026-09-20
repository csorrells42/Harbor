import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateSourceRevisions,validateSourceTree,stageSources} from '../scripts/portable/stage-sources.mjs';
const hash='1'.repeat(40),blob=(file,mode='100644')=>`${mode} blob ${hash}\t${file}\0`;
const manifest=()=>({schemaVersion:1,observedAt:'2026-09-19T00:00:00Z',components:[{id:'example',repository:'https://github.com/owner/repository',upstreamRevision:hash,upstreamTree:hash,patchedTree:hash}]});
test('checked-in nine-component source contract validates',async()=>{
 const input=JSON.parse(await readFile(new URL('../scripts/portable/source-revisions.windows-x64.json',import.meta.url),'utf8'));
 assert.equal(validateSourceRevisions(input).components.length,9);
});
test('source contract rejects paths, credentials, mutable refs and unmatched patches',()=>{
 for(const repository of ['file:///tmp/source','https://github.com/../repo','https://user:pass@github.com/owner/repo','https://github.com/owner/repo?token=secret','https://example.com/owner/repo']){
  const input=manifest();input.components[0].repository=repository;assert.throws(()=>validateSourceRevisions(input));
 }
 for(const change of [{id:'../escape'},{upstreamRevision:'main'},{patchedTree:'2'.repeat(40)},{patch:{path:'../escape.patch',bytes:1,sha256:'a'.repeat(64)}}]){
  const input=manifest();Object.assign(input.components[0],change);assert.throws(()=>validateSourceRevisions(input));
 }
 const duplicate=manifest();duplicate.components.push({...duplicate.components[0]});assert.throws(()=>validateSourceRevisions(duplicate),/duplicate/);
});
test('regular portable source files retain executable modes and Unicode paths',()=>{
 assert.equal(validateSourceTree(blob('src/main.js')+blob('scripts/run.sh','100755')+blob('docs/naïve name.md')),3);
});
test('source trees reject links, submodules, traversal and Windows special paths before checkout',()=>{
 for(const listing of [blob('link','120000'),`160000 commit ${hash}\tsubmodule\0`,...['../escape','/absolute','folder//empty','CON.txt','data/aux','src/.GiT/config','C:/escape','dir/name.','dir/name ','dir\\name','line\nname'].map(file=>blob(file))])assert.throws(()=>validateSourceTree(listing));
});
test('source tree rejects file and parent case collisions',()=>{
 assert.throws(()=>validateSourceTree(blob('README.md')+blob('readme.md')),/case collision/);
 assert.throws(()=>validateSourceTree(blob('Src/a.js')+blob('src/b.js')),/case collision/);
 assert.throws(()=>validateSourceTree(blob('src')+blob('src/b.js')),/collision/);
 assert.throws(()=>validateSourceTree(blob('src/b.js')+blob('src')),/collision/);
 assert.throws(()=>validateSourceTree(blob('same')+blob('same')),/duplicate/);
});
async function fixture(testBody){
 const parent=path.resolve(os.tmpdir()),directory=await mkdtemp(path.join(parent,'harbor-source-stage-'));
 try{await testBody(directory);}finally{
  assert.equal(path.dirname(path.resolve(directory)),parent);assert.ok(path.basename(directory).startsWith('harbor-source-stage-'));
  await rm(directory,{recursive:true,force:true});
 }
}
test('existing output is preserved and rejected before any Git operation',()=>fixture(async directory=>{
 const input=path.join(directory,'sources.json'),output=path.join(directory,'existing');
 await writeFile(input,JSON.stringify(manifest()));await mkdir(output);await writeFile(path.join(output,'keep.txt'),'untouched');
 await assert.rejects(stageSources(input,process.execPath,output),error=>error.code==='EEXIST');
 assert.equal(await readFile(path.join(output,'keep.txt'),'utf8'),'untouched');
}));
test('patch integrity fails before an output directory is created',()=>fixture(async directory=>{
 const input=manifest();input.components[0].patchedTree='2'.repeat(40);input.components[0].patch={path:'source-patches/example.patch',bytes:3,sha256:'a'.repeat(64)};
 await mkdir(path.join(directory,'source-patches'));await writeFile(path.join(directory,'source-patches/example.patch'),'bad');await writeFile(path.join(directory,'sources.json'),JSON.stringify(input));
 const output=path.join(directory,'new-output');await assert.rejects(stageSources(path.join(directory,'sources.json'),process.execPath,output),/Patch hash differs/);
 await assert.rejects(stat(output),error=>error.code==='ENOENT');
}));
