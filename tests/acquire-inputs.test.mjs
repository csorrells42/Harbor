import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {acquireInputs,validateInputs} from '../scripts/portable/acquire-inputs.mjs';
const bytes=Buffer.from('a pinned public artifact');
const sha256=createHash('sha256').update(bytes).digest('hex');
const manifest=()=>({schemaVersion:1,release:'fixture-1',artifacts:[{id:'node',role:'runtime',version:'1.2.3',usage:'both',url:'https://downloads.example.com/v1.2.3/runtime.zip',bytes:bytes.length,sha256,license:'MIT'}]});
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-inputs-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const cache=path.join(root,'Cache ü');return {root,cache};}
test('verified download is reused offline with rehash and deduplicated bytes',async t=>{
 const {cache}=await fixture(t);let calls=0;
 const plan=manifest();plan.artifacts.push({...plan.artifacts[0],id:'same-payload'});
 const receipt=await acquireInputs(plan,cache,{fetchImpl:async()=>{calls++;return new Response(bytes);}});
 assert.equal(calls,1);assert.equal(receipt.uniqueCacheBytes,bytes.length);assert.equal(receipt.declaredBytes,2*bytes.length);assert.equal(receipt.artifacts[1].acquired,'verified-cache');
 assert.equal((await acquireInputs(plan,cache,{offline:true,fetchImpl:()=>{throw Error('No network allowed');}})).artifacts.length,2);
 assert.deepEqual(await fs.readdir(cache),[sha256+'.blob']);
 await fs.writeFile(path.join(cache,sha256+'.blob'),Buffer.alloc(bytes.length,1));
 await assert.rejects(acquireInputs(plan,cache,{offline:true}),/checksum mismatch/);
});
for(const [name,payload,error] of [['wrong hash',Buffer.alloc(bytes.length,2),/checksum/],['short',bytes.subarray(1),/truncated/],['oversized',Buffer.concat([bytes,bytes]),/exceeded/]])test(`rejects ${name} without publishing cache bytes`,async t=>{
 const {cache}=await fixture(t);await assert.rejects(acquireInputs(manifest(),cache,{fetchImpl:async()=>new Response(payload)}),error);assert.deepEqual(await fs.readdir(cache),[]);
});
test('offline missing input never downloads; malformed manifest never creates cache',async t=>{
 const {cache,root}=await fixture(t);await assert.rejects(acquireInputs(manifest(),cache,{offline:true,fetchImpl:()=>assert.fail('download')}),/Offline input missing/);
 const bad=manifest();delete bad.artifacts[0].sha256;const other=path.join(root,'other');await assert.rejects(acquireInputs(bad,other),/SHA-256/);await assert.rejects(fs.stat(other),{code:'ENOENT'});
});
test('interrupt and stream failure remove partial bytes and release ownership',async t=>{
 const {cache}=await fixture(t);const controller=new AbortController();
 await assert.rejects(acquireInputs(manifest(),cache,{signal:controller.signal,fetchImpl:async()=>new Response(new ReadableStream({start(stream){stream.enqueue(bytes.subarray(0,3));controller.abort();stream.close();}}))}),/abort/i);
 assert.deepEqual(await fs.readdir(cache),[]);
 await assert.rejects(acquireInputs(manifest(),cache,{fetchImpl:async()=>new Response(new ReadableStream({start(stream){stream.error(new Error('fixture stream failed'));}}))}),/fixture stream failed/);
 assert.deepEqual(await fs.readdir(cache),[]);
});
test('redirects are bounded, credential-free and never recorded with signed query strings',async t=>{
 const {cache}=await fixture(t);const observed=[];
 const result=await acquireInputs(manifest(),cache,{fetchImpl:async(url,options)=>{observed.push({url,options});return observed.length===1?new Response(null,{status:302,headers:{location:'https://assets.example.com/payload?signature=transient'}}):new Response(bytes);}});
 assert.equal(observed[1].options.redirect,'manual');assert.deepEqual(Object.keys(observed[1].options.headers),['User-Agent']);assert(!JSON.stringify(result).includes('transient'));
 const second=path.join(path.dirname(cache),'second');await assert.rejects(acquireInputs(manifest(),second,{fetchImpl:async()=>new Response(null,{status:302,headers:{location:'http://assets.example.com/file'}})}),/HTTPS/);
 const third=path.join(path.dirname(cache),'third');let calls=0;await assert.rejects(acquireInputs(manifest(),third,{fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://assets.example.com/file'}});}}),/Too many/);assert.equal(calls,6);
});
test('cache lock excludes another acquirer without deleting its lock',async t=>{
 const {cache}=await fixture(t);await fs.mkdir(cache);await fs.writeFile(path.join(cache,'.acquire.lock'),'owned');await assert.rejects(acquireInputs(manifest(),cache),{code:'EEXIST'});assert.equal(await fs.readFile(path.join(cache,'.acquire.lock'),'utf8'),'owned');
});
test('cache directory junctions and cached input links are rejected',async t=>{
 const {root,cache}=await fixture(t);await fs.mkdir(cache);const linked=path.join(root,'linked');await fs.symlink(cache,linked,process.platform==='win32'?'junction':'dir');await assert.rejects(acquireInputs(manifest(),linked,{offline:true}),/links/);
});
test('moving references, secrets, duplicate IDs and invalid bounds fail validation',()=>{
 for(const [field,value] of [['url','https://a.example.com/latest/file'],['url','https://user:secret@a.example.com/v1/file'],['url','https://a.example.com/v1/file?key=secret'],['bytes',0],['bytes',9*1024**3],['version',null],['usage','unknown']]){const p=manifest();p.artifacts[0][field]=value;assert.throws(()=>validateInputs(p));}
 const p=manifest();p.artifacts.push({...p.artifacts[0]});assert.throws(()=>validateInputs(p),/duplicate/);
});
