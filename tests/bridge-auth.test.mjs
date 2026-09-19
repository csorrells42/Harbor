import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

const keyA='harbor_synthetic_bridge_key_A_12345',keyB='harbor_synthetic_bridge_key_B_67890';
const bridge=fileURLToPath(new URL('../src/bridge.mjs',import.meta.url));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<300;i++){if(check())return;await delay(10);}throw new Error('Timed out waiting for bridge wire request');}
async function fixture(t,{key=keyA,status=401,streamOnReject=false,streamRejectedGet=false}={}){
  const requests=[];let expected=key,rejectedClosed=0;
  const server=createServer(async(req,res)=>{
    requests.push({method:req.method,authorization:req.headers.authorization,session:req.headers['mcp-session-id']});
    if(req.headers.authorization!==`Bearer ${expected}`){
      res.on('close',()=>rejectedClosed++);res.writeHead(status);
      const body=`Synthetic rejected header: ${req.headers.authorization}; expected ${expected}`;
      if(streamOnReject)res.write(body);else res.end(body);return;
    }
    if(req.method==='GET'){if(streamRejectedGet){res.on('close',()=>rejectedClosed++);res.writeHead(403);res.write('synthetic rejected notification stream');}else res.writeHead(405).end();return;}
    if(req.method==='DELETE'){res.writeHead(204).end();return;}
    let raw='';for await(const chunk of req)raw+=chunk;const message=JSON.parse(raw);
    if(message.id===undefined){res.writeHead(202).end();return;}
    res.writeHead(200,{'content-type':'application/json','mcp-session-id':'synthetic-auth-session'});
    res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:message.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'auth-fixture',version:'1'}}:{ok:true}}));
  }).listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {requests,endpoint:`http://127.0.0.1:${server.address().port}/mcp`,rotate:value=>expected=value,get rejectedClosed(){return rejectedClosed;}};
}
function launch(t,endpoint,env){
  const child=spawn(process.execPath,[bridge,endpoint],{env:{SystemRoot:process.env.SystemRoot??'C:\\Windows',PATH:path.dirname(process.execPath),...env},stdio:['pipe','pipe','pipe'],windowsHide:true});
  const exited=once(child,'exit'),pending=new Map();let stdout='',stderr='',nextId=0;
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const lines=createInterface({input:child.stdout});lines.on('line',line=>{const message=JSON.parse(line);pending.get(message.id)?.(message);});
  t.after(async()=>{if(child.exitCode===null)child.kill();await exited;lines.close();});
  return {
    child,exited,get stdout(){return stdout;},get stderr(){return stderr;},
    async send(method){const id=++nextId;let timer;try{const response=new Promise((resolve,reject)=>{pending.set(id,resolve);timer=setTimeout(()=>reject(new Error('Bridge did not answer')),4000);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method})+'\n');return await response;}finally{clearTimeout(timer);pending.delete(id);}},
    notify(method){child.stdin.write(JSON.stringify({jsonrpc:'2.0',method})+'\n');},
    async close(){child.stdin.end();await exited;}
  };
}

for(const source of ['environment','plain-file'])test(`bridge carries Bearer authentication on POST, GET and DELETE using ${source}`,async t=>{
  const server=await fixture(t);const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-bridge-auth-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const keyFile=path.join(dir,'plain API key.txt');await fs.writeFile(keyFile,`  ${keyA}\r\n`);
  const env=source==='environment'?{HARBOR_API_KEY:keyA,HARBOR_API_KEY_FILE:path.join(dir,'deliberately missing.txt')}:{HARBOR_API_KEY_FILE:keyFile};
  const client=launch(t,server.endpoint,env);assert.equal((await client.send('initialize')).result.serverInfo.name,'auth-fixture');
  client.notify('notifications/initialized');await until(()=>server.requests.some(r=>r.method==='GET'));
  assert.deepEqual((await client.send('ping')).result,{ok:true});await client.close();
  assert.ok(server.requests.some(r=>r.method==='DELETE'));assert.ok(server.requests.every(r=>r.authorization===`Bearer ${keyA}`));
  assert.ok(server.requests.filter(r=>r.method!=='POST').every(r=>r.session==='synthetic-auth-session'));
  assert.ok(!client.stdout.includes(keyA));assert.ok(!client.stderr.includes(keyA));
});

for(const status of [401,403])test(`bridge returns a generic HTTP ${status} authentication failure without reflecting either key`,async t=>{
  const server=await fixture(t,{status});const client=launch(t,server.endpoint,{HARBOR_API_KEY:keyB});
  const reply=await client.send('initialize');assert.equal(reply.error.code,-32000);assert.match(reply.error.message,/Harbor authentication failed/);
  assert.ok(!JSON.stringify(reply).includes(keyA));assert.ok(!JSON.stringify(reply).includes(keyB));await client.close();
  assert.ok(!client.stderr.includes(keyA));assert.ok(!client.stderr.includes(keyB));
});

test('restarting the stdio bridge after plain-file rotation reads the new key',async t=>{
  const server=await fixture(t);const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-bridge-rotate-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const keyFile=path.join(dir,'api-key.txt');await fs.writeFile(keyFile,keyA);
  const old=launch(t,server.endpoint,{HARBOR_API_KEY_FILE:keyFile});assert.ok((await old.send('initialize')).result);
  server.rotate(keyB);await fs.writeFile(keyFile,keyB);
  assert.match((await old.send('ping')).error.message,/authentication failed/);await old.close();
  const fresh=launch(t,server.endpoint,{HARBOR_API_KEY_FILE:keyFile});assert.ok((await fresh.send('initialize')).result);assert.deepEqual((await fresh.send('ping')).result,{ok:true});await fresh.close();
  assert.ok(!fresh.stdout.includes(keyB));assert.ok(!fresh.stderr.includes(keyB));
});

test('missing or malformed bridge credentials fail without sending requests or echoing their values',async t=>{
  const server=await fixture(t);const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-bridge-invalid-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const invalid=`${keyA}\r\nInjected: value`;
  for(const env of [{HARBOR_API_KEY_FILE:path.join(dir,'missing.txt')},{HARBOR_API_KEY:invalid}]){
    const client=launch(t,server.endpoint,env);const [code]=await client.exited;assert.notEqual(code,0);assert.equal(client.stdout,'');assert.ok(!client.stderr.includes(keyA));assert.match(client.stderr,/Could not read the Harbor API key file|Invalid Harbor API key format/);
  }
  assert.equal(server.requests.length,0);
});


test('authentication rejection releases an unfinished HTTP response body before the bridge exits',async t=>{
  const server=await fixture(t,{streamOnReject:true});const client=launch(t,server.endpoint,{HARBOR_API_KEY:keyB});
  assert.match((await client.send('initialize')).error.message,/authentication failed/);
  await until(()=>server.rejectedClosed===1);
  assert.equal(client.child.exitCode,null,'The live bridge must release the rejected stream without requiring process exit');
  await client.close();
});


test('notification authentication rejection cancels its unfinished GET body without stopping the bridge',async t=>{
  const server=await fixture(t,{streamRejectedGet:true});const client=launch(t,server.endpoint,{HARBOR_API_KEY:keyA});
  assert.ok((await client.send('initialize')).result);client.notify('notifications/initialized');
  await until(()=>server.requests.some(request=>request.method==='GET'));
  await until(()=>server.rejectedClosed===1);
  assert.deepEqual((await client.send('ping')).result,{ok:true});await client.close();
});
