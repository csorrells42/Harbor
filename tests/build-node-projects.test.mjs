import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {validateNodeProjectInputs} from '../scripts/portable/build-node-projects.mjs';

async function fixture(id='typst-mcp'){
 const root=new URL('../scripts/portable/',import.meta.url),input=JSON.parse(await fs.readFile(new URL('source-node-inputs.windows-x64.json',root),'utf8'));
 return {component:input.components.find(c=>c.id===id),manifest:JSON.parse(await fs.readFile(new URL(`source-node-inputs/${id}/package.json`,root),'utf8')),lock:JSON.parse(await fs.readFile(new URL(`source-node-inputs/${id}/package-lock.json`,root),'utf8'))};
}
test('reviewed TypeScript source projects retain exact production and build dependency locks',async()=>{
 for(const id of ['typst-mcp','portkey-tools']){const {component,manifest,lock}=await fixture(id);const result=validateNodeProjectInputs(component,manifest,lock);assert.equal(result.length,component.lockedPackages);}
});
test('reject changed build commands and unsupported project identities before executing source',async()=>{
 const {component,manifest,lock}=await fixture();manifest.scripts.build='tsc && unexpected-command';assert.throws(()=>validateNodeProjectInputs(component,manifest,lock),/build entry/);
 manifest.scripts.build='tsc';assert.throws(()=>validateNodeProjectInputs({...component,id:'dbhub'},manifest,lock),/Unsupported/);assert.throws(()=>validateNodeProjectInputs({...component,sourceTree:'main'},manifest,lock),/tree/);
});
test('reject developer and optional dependency drift, not just production dependencies',async()=>{
 for(const group of ['devDependencies','optionalDependencies']){const {component,manifest,lock}=await fixture();manifest[group]={...(manifest[group]??{}),unexpected:'9.9.9'};assert.throws(()=>validateNodeProjectInputs(component,manifest,lock),/declarations differ/);}
});
test('source project builds reject untrusted transport, links and missing archive integrity',async()=>{
 for(const change of [p=>p.resolved='https://untrusted.example/package.tgz',p=>p.link=true,p=>delete p.integrity]){const {component,manifest,lock}=await fixture();change(Object.entries(lock.packages).find(([name])=>name)[1]);assert.throws(()=>validateNodeProjectInputs(component,manifest,lock));}
});
