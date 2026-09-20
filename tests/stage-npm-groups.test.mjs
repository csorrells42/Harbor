import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {validateNpmLock} from '../scripts/portable/stage-npm-groups.mjs';

const fixture=()=>({lockfileVersion:3,packages:{'':{dependencies:{example:'1.0.0'}},'node_modules/example':{version:'1.0.0',resolved:'https://registry.npmjs.org/example/-/example-1.0.0.tgz',integrity:'sha512-'+Buffer.alloc(64).toString('base64')}}});
const manifest={dependencies:{example:'1.0.0'}};
test('all three declared npm group locks satisfy the extraction contract',async()=>{
 for(const id of ['general-local','browser-docs','search']){
  const root=new URL(`../scripts/portable/package-inputs/${id}/`,import.meta.url);
  const input=JSON.parse(await fs.readFile(new URL('package.json',root),'utf8')),lock=JSON.parse(await fs.readFile(new URL('package-lock.json',root),'utf8'));
  const packages=validateNpmLock(input,lock);assert(packages.length>0);assert(packages.every(item=>item.integrity.startsWith('sha512-')));
 }
});
test('reject dependency transport changes, credentials, mutable queries and missing integrity',()=>{
 for(const resolved of ['http://registry.npmjs.org/example.tgz','https://other.example/example.tgz','https://token@registry.npmjs.org/example.tgz','https://registry.npmjs.org/example.tgz?token=test','https://registry.npmjs.org/example.tgz#ref','file:///example.tgz']){
  const lock=fixture();lock.packages['node_modules/example'].resolved=resolved;assert.throws(()=>validateNpmLock(manifest,lock));
 }
 const lock=fixture();lock.packages['node_modules/example'].integrity='sha1-old';assert.throws(()=>validateNpmLock(manifest,lock),/SHA-512/);
});
test('reject traversal, links, mismatched root dependencies and unsupported locks',()=>{
 for(const location of ['../node_modules/example','node_modules/../example','node_modules/example:stream','node_modules\\example']){
  const lock=fixture(),entry=lock.packages['node_modules/example'];delete lock.packages['node_modules/example'];lock.packages[location]=entry;assert.throws(()=>validateNpmLock(manifest,lock),/location/);
 }
 const linked=fixture();linked.packages['node_modules/example'].link=true;assert.throws(()=>validateNpmLock(manifest,linked),/Linked/);
 const drift=fixture();drift.packages[''].dependencies.example='2.0.0';assert.throws(()=>validateNpmLock(manifest,drift),/differ/);
 const old=fixture();old.lockfileVersion=2;assert.throws(()=>validateNpmLock(manifest,old),/version 3/);
});
