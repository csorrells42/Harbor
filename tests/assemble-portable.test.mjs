import test from 'node:test';
import assert from 'node:assert/strict';
import {safeAssemblyPath,validateAssemblyPlan} from '../scripts/portable/assemble-portable.mjs';
test('assembly paths reject escapes and Windows aliases',()=>{
 assert.equal(safeAssemblyPath('packages/typst-mcp/.git/HEAD'),'packages/typst-mcp/.git/HEAD');
 for(const value of ['../a','/a','a/../b','a\\b','C:/a','a/nul.txt','a/name.','a/file:stream'])assert.throws(()=>safeAssemblyPath(value),/Unsafe/);
});
test('assembly requires pinned complete stage selection',()=>{
 const kinds={runtime:'runtime-stage.json',browser:'runtime-stage.json',npm:'npm-stage.json',python:'python-stage.json',pythonProjects:'python-project-build.json',source:'source-stage.json',node:'node-project-build.json',dbhub:'dbhub-source-build.json',models:'embedding-stage.json',binaries:'runtime-stage.json',application:'application-build.json'};
 const plan={schemaVersion:1,release:'test-1',stages:Object.fromEntries(Object.entries(kinds).map(([id,receipt])=>[id,{root:id,receipt,receiptSha256:'a'.repeat(64)}]))};
 assert.equal(validateAssemblyPlan(plan),plan);
 const missing=structuredClone(plan);delete missing.stages.browser;assert.throws(()=>validateAssemblyPlan(missing),/reviewed/);
 const changed=structuredClone(plan);changed.stages.runtime.receipt='other.json';assert.throws(()=>validateAssemblyPlan(changed),/receipt/);
 const unpinned=structuredClone(plan);unpinned.stages.source.receiptSha256='';assert.throws(()=>validateAssemblyPlan(unpinned),/hash/);
});
