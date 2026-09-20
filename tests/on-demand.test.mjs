import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createCatalogCache} from '../src/core/catalog-cache.mjs';
import {Upstreams} from '../src/core/upstreams.mjs';
import {validateConfig} from '../src/core/config.mjs';
import {createHub} from '../src/core/hub.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const until=async check=>{const deadline=Date.now()+6000;while(!await check()){assert(Date.now()<deadline,'Expected lifecycle state did not settle');await delay(15);}};
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor on demand ')),file=path.join(dir,'fixture.json'),events=path.join(dir,'events.jsonl'),cacheFile=path.join(dir,'catalog.json');
  const managers=[];let now=0;
  const configure=async patch=>fs.writeFile(file,JSON.stringify({events,...patch}));await configure({});
  const config=validateConfig({id:'dormant',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/dormant-server.mjs',import.meta.url)),file],onDemand:true,idleMinutes:1});
  const manager=async()=>{const cache=await createCatalogCache({file:cacheFile}),upstreams=new Upstreams([config],()=>{},()=>{},{catalogCache:cache,now:()=>now,requestTimeoutMs:5000});managers.push(upstreams);return upstreams;};
  const seed=await manager();await seed.start(config.id);const tool=seed.tools()[0];await seed.close();
  t.after(async()=>{for(const manager of managers)await manager.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  return {dir,config,tool,configure,manager,cacheFile,advance:()=>now+=60001,events:async()=> (await fs.readFile(events,'utf8')).trim().split('\n').map(JSON.parse)};
}

test('a persisted dormant catalog answers discovery without startup; concurrent invocations share one real process and idle reaps it',async t=>{
  const f=await fixture(t),u=await f.manager();assert.equal(u.get('dormant').status,'stopped');assert.equal(u.tools().length,1);
  assert.equal((await f.events()).length,1,'cached discovery starts nothing');
  const results=await Promise.all(Array.from({length:8},(_,i)=>u.invoke(f.tool,{value:String(i)})));
  const pids=results.map(result=>JSON.parse(result.content[0].text).pid);assert.equal(new Set(pids).size,1);assert.equal((await f.events()).filter(e=>e.kind==='start').length,2);
  f.advance();await u.sweepIdle();assert.equal(u.get('dormant').status,'stopped');assert.throws(()=>process.kill(pids[0],0));assert.equal(u.tools().length,1);
  await u.invoke(f.tool,{value:'restart'});assert.equal((await f.events()).filter(e=>e.kind==='start').length,3);
});

test('one cancelled initializer does not cancel its sibling; last cancellation waits for owned startup cleanup',async t=>{
  const f=await fixture(t);await f.configure({startDelay:750});const u=await f.manager(),a=new AbortController(),b=new AbortController();
  const cancelled=assert.rejects(u.invoke(f.tool,{value:'cancelled'},{signal:a.signal})),success=u.invoke(f.tool,{value:'remaining'},{signal:b.signal});
  await until(async()=> (await f.events()).filter(e=>e.kind==='start').length===2);a.abort(Error('one caller cancelled'));await cancelled;await success;
  assert.equal((await f.events()).filter(e=>e.kind==='call').length,1);
  f.advance();await u.sweepIdle();const c=new AbortController(),d=new AbortController();
  const both=[assert.rejects(u.invoke(f.tool,{value:'c'},{signal:c.signal})),assert.rejects(u.invoke(f.tool,{value:'d'},{signal:d.signal}))];
  await until(async()=> (await f.events()).filter(e=>e.kind==='start').length===3);c.abort();d.abort();await Promise.all(both);
  const pid=(await f.events()).filter(e=>e.kind==='start').at(-1).pid;assert.throws(()=>process.kill(pid,0));assert.equal((await f.events()).filter(e=>e.kind==='call').length,1);
});

test('changed live schemas and invalid arguments never dispatch; a timed-out mutation is not replayed',async t=>{
  const f=await fixture(t);await f.configure({numeric:true,callDelay:200});const u=await f.manager();
  await assert.rejects(u.invoke(f.tool,{value:'stale'}),/schema changed/);assert.equal((await f.events()).filter(e=>e.kind==='call').length,0);
  const live=u.tools()[0];await assert.rejects(u.invoke(live,{value:'wrong'}),/Arguments/);assert.equal((await f.events()).filter(e=>e.kind==='call').length,0);
  await assert.rejects(u.invoke(live,{value:3},{timeout:30}),/timed out/i);await delay(250);assert.equal((await f.events()).filter(e=>e.kind==='call').length,1);
});

test('active calls, profile pins and manual ownership prevent idle stops; explicit Stop and disabled configuration prevent activation',async t=>{
  const f=await fixture(t);await f.configure({callDelay:250});const u=await f.manager();
  const call=u.invoke(f.tool,{value:'active'});await until(async()=> (await f.events()).some(e=>e.kind==='call'));f.advance();await u.sweepIdle();assert.equal(u.get('dormant').status,'running');await call;
  const release=u.retainServers(['dormant'],'profile');f.advance();await u.sweepIdle();assert.equal(u.get('dormant').status,'running');release();
  await u.start('dormant');f.advance();await u.sweepIdle();assert.equal(u.get('dormant').status,'running','manual Start takes ownership');
  await u.stop('dormant');assert.equal(u.tools().length,0);await assert.rejects(u.invoke(f.tool,{value:'blocked'}),/not available/);
  await u.set({...f.config,enabled:false,onDemand:false});assert.equal(u.tools().length,0);await assert.rejects(u.start('dormant'),/disabled/);await assert.rejects(u.invoke(f.tool,{value:'disabled'}),/disabled/);
});

test('changed launch config, removal and maintenance invalidation cannot leave callable stale cache entries',async t=>{
  const f=await fixture(t),u=await f.manager();await u.set({...f.config,args:[...f.config.args,'new-launch']});assert.equal(u.tools().length,0);
  const reopened=await f.manager();assert.equal(reopened.tools().length,0);await reopened.start('dormant');await reopened.invalidateCatalogs();await reopened.close();
  // Close must not write its last observed catalog back over an invalidation.
  assert.equal((await f.manager()).tools().length,0);
  await u.remove('dormant');await assert.rejects(u.invoke(f.tool,{value:'removed'}),/Unknown/);
});

test('gateway and named profile discover dormant tools and call them through the real MCP route',async t=>{
  const f=await fixture(t),configPath=path.join(f.dir,'servers.json');let hub;const connections=[];
  t.after(async()=>{for(const {client,transport} of connections){await transport.terminateSession().catch(()=>{});await client.close().catch(()=>{});}await hub?.close();});
  hub=await createHub({configPath,port:0});await hub.saveServer(f.config);await hub.startServer('dormant');await hub.close();
  hub=await createHub({configPath,port:0});await hub.saveProfile({id:'lazy',name:'Lazy',serverIds:['dormant']});
  assert.equal(hub.snapshot().servers[0].status,'stopped');
  for(const suffix of ['', '/profiles/lazy']){
    const client=new Client({name:'dormant caller',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(hub.endpoint+suffix));await client.connect(transport);connections.push({client,transport});
    const tools=(await client.listTools()).tools;assert.equal(tools.length,1);
    const result=await client.callTool({name:tools[0].name,arguments:{value:suffix||'default'}});assert(!result.isError);assert(JSON.parse(result.content[0].text).pid);
  }
  await hub.enterMaintenance();assert.equal(hub.snapshot().tools.length,0);
});

test('failed readiness is shared without automatic retries, and a configuration change cancels pending activation',async t=>{
  const f=await fixture(t);await f.configure({failStart:true});const u=await f.manager();u.get('dormant').config.autoRestart=true;
  const failed=await Promise.allSettled(Array.from({length:6},()=>u.invoke(f.tool,{value:'never'})));assert(failed.every(result=>result.status==='rejected'));
  await delay(600);assert.equal((await f.events()).filter(e=>e.kind==='start').length,2);assert.equal((await f.events()).filter(e=>e.kind==='call').length,0);
  const failedPid=(await f.events()).at(-1).pid;assert.throws(()=>process.kill(failedPid,0));
  await f.configure({startDelay:750});const rejected=assert.rejects(u.invoke(f.tool,{value:'changed'}));
  await until(async()=> (await f.events()).filter(e=>e.kind==='start').length===3);await u.set({...f.config,env:{UPDATED:'1'}});await rejected;
  assert.equal(u.tools().length,0);assert.equal((await f.events()).filter(e=>e.kind==='call').length,0);const cancelledPid=(await f.events()).at(-1).pid;assert.throws(()=>process.kill(cancelledPid,0));
});
