import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {includeApplicationSource,validateApplicationInputs} from '../scripts/portable/build-harbor-application.mjs';
test('application snapshot excludes local data, credential files and traversal',()=>{
 for(const p of ['src/core/config.mjs','docs/HARBOR-MANUAL.md','scripts/portable/package-inputs/a/package.json'])assert.equal(includeApplicationSource(p),true,p);
 for(const p of ['src/diagnostics/evidence/report.json','scripts/.env','scripts/.env.local','docs/key.pem','src/../secret','src\\secret','src/node_modules/a.js'])assert.equal(includeApplicationSource(p),false,p);
});
test('application build checks both dependency groups and pinned build tools',async()=>{
 const manifest=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url))),lock=JSON.parse(await fs.readFile(new URL('../package-lock.json',import.meta.url)));
 assert.ok(validateApplicationInputs(manifest,lock).length>0);
 const altered=structuredClone(lock);altered.packages[''].devDependencies.electron='1.0.0';assert.throws(()=>validateApplicationInputs(manifest,altered),/differ/);
 assert.throws(()=>validateApplicationInputs({...manifest,devDependencies:{...manifest.devDependencies,electron:'1.0.0'}},lock),/build tools/);
});
