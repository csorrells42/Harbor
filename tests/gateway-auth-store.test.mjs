import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createGatewayAuthentication, generateGatewayKey, validateGatewayKey} from '../src/core/gateway-auth.mjs';

const keyA='harbor_synthetic_store_key_A_123456';
const keyB='harbor_synthetic_store_key_B_654321';
async function fixture(t){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-auth-store-'));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  return {dataDir,file:path.join(dataDir,'auth','gateway.json'),auth:await createGatewayAuthentication({dataDir})};
}

test('missing credentials migrate to disabled auth without changing existing settings',async t=>{
  const {dataDir,auth,file}=await fixture(t);
  const settings=path.join(dataDir,'harbor-settings.json');await fs.writeFile(settings,'{"port":37373}');
  assert.deepEqual(auth.status(),{enabled:false,hasKey:false});assert.equal(auth.key(),'');
  assert.equal(auth.accepts(undefined),true);assert.equal(auth.accepts('wrong'),true);
  assert.equal(await fs.readFile(settings,'utf8'),'{"port":37373}');
  await assert.rejects(fs.stat(file),{code:'ENOENT'});
});

test('generated keys are unique validated tokens and validation rejects malformed values',()=>{
  const generated=Array.from({length:256},generateGatewayKey);
  assert.equal(new Set(generated).size,generated.length);
  for(const key of generated){assert.match(key,/^harbor_[A-Za-z0-9_-]{43}$/);assert.equal(validateGatewayKey(key),key);}
  for(const value of [undefined,null,42,{},[],true,'','a'.repeat(15),'a'.repeat(4097),'has spaces between words','harbor_bad\nline_1234','harbor_bad\rline_1234','harbor_bad:colon_1234','harbor_bad=middle_1234'])assert.throws(()=>validateGatewayKey(value),/API key/);
  for(const value of ['a'.repeat(16),'a'.repeat(4096),'synthetic_token+/._~=='])assert.equal(validateGatewayKey(value),value);
});

test('saved enablement, disablement and rotation survive restart without leaking into status',async t=>{
  const {dataDir,auth,file}=await fixture(t);
  assert.deepEqual(await auth.update({enabled:true,key:keyA}),{enabled:true,hasKey:true});
  assert.equal(auth.accepts(`Bearer ${keyA}`),true);assert.equal(auth.accepts(`bEaReR ${keyA}`),true);
  for(const header of [undefined,null,42,[],`Basic ${keyA}`,`Bearer ${keyB}`,`Bearer  ${keyA}`,`Bearer ${keyA} `,`Bearer ${keyA}\r\nextra`,'Bearer '+'a'.repeat(4097)])assert.equal(auth.accepts(header),false);
  let loaded=await createGatewayAuthentication({dataDir});assert.equal(loaded.accepts(`Bearer ${keyA}`),true);
  await loaded.update({enabled:false});loaded=await createGatewayAuthentication({dataDir});
  assert.deepEqual(loaded.status(),{enabled:false,hasKey:true});assert.equal(loaded.key(),keyA);assert.equal(loaded.accepts(undefined),true);
  await loaded.update({enabled:true,key:keyB});loaded=await createGatewayAuthentication({dataDir});
  assert.equal(loaded.accepts(`Bearer ${keyA}`),false);assert.equal(loaded.accepts(`Bearer ${keyB}`),true);
  assert.deepEqual(Object.keys(loaded.status()).sort(),['enabled','hasKey']);assert.ok(!JSON.stringify(loaded.status()).includes(keyB));
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{version:1,enabled:true,key:keyB});
});

test('invalid saves fail before persistence and do not poison the update queue',async t=>{
  const {auth,file}=await fixture(t);
  await assert.rejects(auth.update({enabled:true}),/Enter or generate/);
  await assert.rejects(auth.update({enabled:true,key:'too short'}),/API key/);
  for(const input of [null,[],{},'enabled',{enabled:1}])await assert.rejects(auth.update(input),/Choose whether/);
  await assert.rejects(fs.stat(file),{code:'ENOENT'});
  await auth.update({enabled:true,key:keyA});assert.equal(auth.accepts(`Bearer ${keyA}`),true);
});

test('queued updates capture caller input and key omission uses the last successful queued save',async t=>{
  const {auth,dataDir}=await fixture(t);
  const first={enabled:true,key:keyA};const firstSave=auth.update(first);
  first.key=keyB;first.enabled=false;
  const second={enabled:false};const secondSave=auth.update(second);second.enabled=true;second.key=keyB;
  assert.deepEqual(await firstSave,{enabled:true,hasKey:true});assert.deepEqual(await secondSave,{enabled:false,hasKey:true});
  const loaded=await createGatewayAuthentication({dataDir});assert.equal(loaded.key(),keyA);assert.equal(loaded.status().enabled,false);
  await loaded.update({enabled:true});assert.equal(loaded.accepts(`Bearer ${keyA}`),true);
});

test('live key and durable credentials change only after the atomic replacement succeeds',async t=>{
  const {auth,file}=await fixture(t);await auth.update({enabled:true,key:keyA});
  const rename=fs.rename;let entered,release;
  const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  t.mock.method(fs,'rename',async(...args)=>{entered();await gate;return rename(...args);});
  const pending=auth.update({enabled:true,key:keyB});await waiting;
  try{assert.equal(auth.key(),keyA);assert.equal(auth.accepts(`Bearer ${keyB}`),false);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).key,keyA);}
  finally{release();}
  await pending;assert.equal(auth.key(),keyB);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).key,keyB);
  assert.deepEqual(await fs.readdir(path.dirname(file)),['gateway.json']);
});

test('failed replacement preserves old live and saved key, cleans its temporary file and permits retry',async t=>{
  const {auth,dataDir,file}=await fixture(t);await auth.update({enabled:true,key:keyA});
  const rename=fs.rename;let fail=true;
  t.mock.method(fs,'rename',async(...args)=>{if(fail)throw Object.assign(new Error('Synthetic replacement denied'),{code:'EACCES'});return rename(...args);});
  await assert.rejects(auth.update({enabled:true,key:keyB}),error=>{assert.ok(!error.message.includes(keyA));assert.ok(!error.message.includes(keyB));return error.code==='EACCES';});
  assert.equal(auth.key(),keyA);assert.equal(auth.accepts(`Bearer ${keyA}`),true);assert.equal(auth.accepts(`Bearer ${keyB}`),false);
  assert.equal((await createGatewayAuthentication({dataDir})).key(),keyA);assert.deepEqual(await fs.readdir(path.dirname(file)),['gateway.json']);
  fail=false;await auth.update({enabled:true,key:keyB});assert.equal(auth.key(),keyB);
});

test('malformed saved credentials fail closed with a generic error and preserve their contents',async t=>{
  const {dataDir,file}=await fixture(t);await fs.mkdir(path.dirname(file),{recursive:true});
  for(const saved of [keyA,JSON.stringify({version:2,enabled:true,key:keyA}),JSON.stringify({version:1,enabled:'false',key:keyA}),JSON.stringify({version:1,enabled:true,key:''}),JSON.stringify({version:1,enabled:false,key:'bad secret value'})]){
    await fs.writeFile(file,saved);
    await assert.rejects(createGatewayAuthentication({dataDir}),error=>{assert.match(error.message,/Could not load gateway authentication/);assert.ok(!error.message.includes(keyA));assert.ok(!error.message.includes('bad secret value'));return true;});
    assert.equal(await fs.readFile(file,'utf8'),saved);
  }
});

test('fresh desktop profiles generate and persist an enabled key before returning from initialization',async t=>{
  const {dataDir,file}=await fixture(t);
  const auth=await createGatewayAuthentication({dataDir,defaultEnabled:true});
  assert.deepEqual(auth.status(),{enabled:true,hasKey:true});assert.equal(validateGatewayKey(auth.key()),auth.key());assert.match(auth.key(),/^harbor_/);
  assert.equal(auth.accepts(undefined),false);assert.equal(auth.accepts(`Bearer ${auth.key()}`),true);
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{version:1,enabled:true,key:auth.key()});
  const restarted=await createGatewayAuthentication({dataDir,defaultEnabled:true});assert.equal(restarted.key(),auth.key());assert.deepEqual(restarted.status(),auth.status());
});

test('explicit saved authentication disablement survives a new enabled-by-default desktop version',async t=>{
  const {dataDir,file}=await fixture(t);await fs.mkdir(path.dirname(file),{recursive:true});
  for(const key of ['',keyA]){
    const saved=JSON.stringify({version:1,enabled:false,key});await fs.writeFile(file,saved);
    const auth=await createGatewayAuthentication({dataDir,defaultEnabled:true});
    assert.deepEqual(auth.status(),{enabled:false,hasKey:!!key});assert.equal(auth.key(),key);assert.equal(auth.accepts(undefined),true);assert.equal(await fs.readFile(file,'utf8'),saved);
  }
});

test('successful authentication apply callback observes the saved new credentials and completes once',async t=>{
  const {auth,file,dataDir}=await fixture(t);await auth.update({enabled:true,key:keyA});let calls=0;
  const status=await auth.update({enabled:true,key:keyB},async()=>{
    calls++;assert.equal(auth.key(),keyB);assert.equal(auth.accepts(`Bearer ${keyA}`),false);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).key,keyB);
  });
  assert.equal(calls,1);assert.deepEqual(status,{enabled:true,hasKey:true});assert.equal((await createGatewayAuthentication({dataDir})).key(),keyB);
});

test('failed live-apply rolls credentials back before the next queued update and preserves restart behavior',async t=>{
  const {auth,file,dataDir}=await fixture(t);await auth.update({enabled:true,key:keyA});
  let entered,release;const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const failed=auth.update({enabled:true,key:keyB},async()=>{entered();await gate;throw new Error('Synthetic listener reconfiguration failure');});
  const failureCheck=assert.rejects(failed,/Synthetic listener reconfiguration failure/);
  const queued=auth.update({enabled:false});
  await waiting;try{assert.equal(auth.key(),keyB);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).key,keyB);}finally{release();}
  await failureCheck;assert.deepEqual(await queued,{enabled:false,hasKey:true});
  assert.equal(auth.key(),keyA);assert.equal(auth.accepts(undefined),true);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{version:1,enabled:false,key:keyA});
  const restarted=await createGatewayAuthentication({dataDir,defaultEnabled:true});assert.equal(restarted.key(),keyA);assert.equal(restarted.status().enabled,false);
  await auth.update({enabled:true});assert.equal(auth.accepts(`Bearer ${keyA}`),true);assert.equal(auth.accepts(`Bearer ${keyB}`),false);
  assert.deepEqual(await fs.readdir(path.dirname(file)),['gateway.json']);
});
