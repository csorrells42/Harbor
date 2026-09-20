import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {validateDbhubInput} from '../scripts/portable/build-dbhub-source.mjs';
const load=async()=>JSON.parse(await fs.readFile(new URL('../scripts/portable/source-node-inputs.windows-x64.json',import.meta.url),'utf8'));
test('DBHub binds its frontend and backend manifests to the pinned pnpm workspace',async()=>{const item=validateDbhubInput(await load());assert.equal(item.packageManager,'pnpm@10.17.1');assert.equal(item.files.length,4);});
test('DBHub rejects absent or duplicate workspace inputs and unpinned package manager',async()=>{
 for(const mutate of [c=>c.files.pop(),c=>c.files[1]={...c.files[0]},c=>c.packageManager='pnpm@latest',c=>c.sourceTree='main',c=>c.files[0].sha256='bad',c=>c.files[0].path='../../outside']){const input=await load();mutate(input.components.find(c=>c.id==='dbhub'));assert.throws(()=>validateDbhubInput(input));}
 const input=await load();input.components.push(input.components.find(c=>c.id==='dbhub'));assert.throws(()=>validateDbhubInput(input),/Unique/);
});
