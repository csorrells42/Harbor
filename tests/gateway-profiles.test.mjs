import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createHub} from '../src/core/hub.mjs';
import {adviceFingerprint} from '../src/diagnostics/advice.mjs';

const fixture=fileURLToPath(new URL('./fixtures/server.mjs',import.meta.url));
const until=async check=>{const end=Date.now()+8000;while(!await check()){if(Date.now()>end)throw Error('Profile state did not settle');await delay(20);}};
async function setup(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor gateway profiles '));
  const hub=await createHub({configPath:path.join(dir,'servers.json'),port:0});
  const connections=[];
  t.after(async()=>{for(const {client,transport} of connections){await transport.terminateSession().catch(()=>{});await client.close().catch(()=>{});}await hub.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  for(const id of ['one','two']){await hub.saveServer({id,name:id,command:process.execPath,args:[fixture]});await hub.startServer(id);}
  const save=(id,serverIds,isolation='shared',extra={})=>hub.saveProfile({id,name:id,serverIds,isolation,delivery:{toolMode:'all'},...extra});
  async function connect(id){
    const endpoint=hub.endpoint+(id?'/profiles/'+id:'');
    const client=new Client({name:'profile '+(id??'default'),version:'1'}),transport=new StreamableHTTPClientTransport(new URL(endpoint));
    await client.connect(transport);const connection={client,transport,endpoint};connections.push(connection);return connection;
  }
  return {hub,dir,save,connect};
}
async function echo(client,name,args={}){return JSON.parse((await client.callTool({name,arguments:{text:'profile test',...args}})).content[0].text);}

test('advice saves through profile persistence and rejects queued profile or catalog drift',async t=>{
  const {hub,save,connect,dir}=await setup(t),profile=await save('advised',['one']);
  const old=await connect('advised'),originalCatalog=await old.client.listTools(),defaultSettings=hub.getSettings();
  const catalog=adviceFingerprint(hub.getAdviceCatalog(profile.id));
  const saved=await hub.saveAdviceProfile({...profile,delivery:{...profile.delivery,searchLimit:7}},{expectedRevision:profile.revision,expectedCatalogFingerprint:catalog});
  assert.equal(saved.revision,profile.revision+1);assert.equal(saved.adviceCatalogChanged,false);
  assert.equal(hub.getProfile(profile.id).delivery.searchLimit,7);assert.deepEqual(hub.getSettings(),defaultSettings);
  assert.deepEqual(await old.client.listTools(),originalCatalog);assert.equal(hub.getProfiles().clients.find(c=>c.profileId==='advised').profileRevision,profile.revision);
  await assert.rejects(hub.saveAdviceProfile(profile,{expectedRevision:profile.revision,expectedCatalogFingerprint:catalog}),/profile changed/);
  const queued=hub.saveServer({id:'one',name:'Changed server configuration',command:process.execPath,args:[fixture]});
  const stale=hub.saveAdviceProfile({...saved,delivery:{...saved.delivery,searchLimit:9}},{expectedRevision:saved.revision,expectedCatalogFingerprint:catalog});
  await queued;await assert.rejects(stale,/catalog changed/);assert.equal(hub.getProfile(profile.id).delivery.searchLimit,7);
  const files=await fs.readdir(dir);const profileFile=files.find(file=>file.includes('profiles'));assert(profileFile,'Named profile persistence exists');
  assert.match(await fs.readFile(path.join(dir,profileFile),'utf8'),/"searchLimit": 7/);
});

test('profile catalogs and invocations are filtered; sessions cannot cross endpoints or open private catalogs',async t=>{
  const {hub,save,connect}=await setup(t);
  await save('first',['one']);await save('second',['two']);
  const a=await connect('first'),b=await connect('second'),normal=await connect();
  const aTools=(await a.client.listTools()).tools,bTools=(await b.client.listTools()).tools;
  assert.equal(aTools.length,1);assert.equal(bTools.length,1);assert.notEqual(aTools[0].name,bTools[0].name);
  assert.equal((await normal.client.listTools()).tools.length,2);
  await assert.rejects(a.client.callTool({name:bTools[0].name,arguments:{}}),/Unknown tool/);
  const headers={Accept:'application/json, text/event-stream','Content-Type':'application/json','Mcp-Session-Id':a.transport.sessionId,'Mcp-Protocol-Version':'2025-03-26'};
  const cross=await fetch(b.endpoint,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/list'})});
  assert.equal(cross.status,404);await cross.text();
  const context=hub.getProfiles().runtimes.find(runtime=>runtime.profileId==='first');
  const privateResponse=await fetch(hub.endpoint+'/_harbor_profile_catalog/'+context.contextId,{method:'POST',headers,body:'invalid'});
  assert.equal(privateResponse.status,401);await privateResponse.text();
  assert.equal((await echo(a.client,aTools[0].name)).pid,hub.snapshot().servers.find(server=>server.id==='one').pid);
});

test('profile edits apply to new sessions while old revisions and the default stay stable',async t=>{
  const {hub,save,connect}=await setup(t),original=await save('editable',['one']);
  const old=await connect('editable'),oldName=(await old.client.listTools()).tools[0].name;
  const updated=await hub.saveProfile({...original,serverIds:['two']},{expectedRevision:original.revision});
  const fresh=await connect('editable');assert(updated.revision>original.revision);
  assert.equal((await old.client.listTools()).tools[0].name,oldName);
  assert.notEqual((await fresh.client.listTools()).tools[0].name,oldName);
  const revisions=hub.getProfiles().clients.filter(client=>client.profileId==='editable').map(client=>client.profileRevision).sort((a,b)=>a-b);
  assert.deepEqual(revisions,[original.revision,updated.revision]);
  assert.equal(hub.getSettings().toolMode,'all');assert.equal((await (await connect()).client.listTools()).tools.length,2);
  await hub.removeProfile('editable',{expectedRevision:updated.revision});
  await until(()=>!hub.getProfiles().runtimes.some(runtime=>runtime.profileId==='editable'));
  await assert.rejects(old.client.listTools());await assert.rejects(fresh.client.listTools());
  assert(hub.snapshot().servers.every(server=>server.status==='running'));
});

test('two isolated MCP sessions own separate child state; termination reaps only its owner',async t=>{
  const {hub,save,connect}=await setup(t);await save('isolated',['one'],'process');
  const a=await connect('isolated'),b=await connect('isolated'),normal=await connect();
  const name=(await a.client.listTools()).tools[0].name;
  const first=await echo(a.client,name),second=await echo(b.client,name),shared=await echo(normal.client,name);
  assert.equal(first.count,1);assert.equal(second.count,1);assert.equal(new Set([first.pid,second.pid,shared.pid]).size,3);
  await a.transport.terminateSession();await a.client.close();
  await until(()=>{try{process.kill(first.pid,0);return false;}catch(error){return error.code==='ESRCH';}});
  assert.equal((await echo(b.client,name)).count,2);assert.equal((await echo(normal.client,name)).pid,shared.pid);
  await hub.disconnectProfile('isolated');
  await until(()=>{try{process.kill(second.pid,0);return false;}catch(error){return error.code==='ESRCH';}});
  assert.equal((await echo(normal.client,name)).pid,shared.pid);
  assert.equal(hub.getProfiles().runtimes.length,0);
});

test('profile capability controls deny tools without changing other clients',async t=>{
  const {hub,save,connect}=await setup(t);await save('no-tools',['one'],'shared',{capabilities:['resources']});
  const restricted=await connect('no-tools'),normal=await connect();
  assert.deepEqual((await restricted.client.listTools()).tools,[]);
  const name=(await normal.client.listTools()).tools[0].name;
  await assert.rejects(restricted.client.callTool({name,arguments:{}}),/disabled/);
  assert((await echo(normal.client,name)).pid);
  assert.equal(hub.getProfiles().admission.public.active,0);
});

test('All and Hybrid profiles retain independent discovery catalogs and enforce invocation filtering',{
  skip:!process.env.HARBOR_TOOL_RUNTIME_ROOT,timeout:90000
},async t=>{
  const installed=process.env.HARBOR_TOOL_RUNTIME_ROOT,runtime=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor profile search runtime '));
  for(const folder of ['runtimes','packages'])await fs.symlink(path.join(installed,folder),path.join(runtime,folder),process.platform==='win32'?'junction':'dir');
  await fs.cp(path.join(installed,'support'),path.join(runtime,'support'),{recursive:true});
  await fs.copyFile(new URL('../scripts/portable/fastmcp-gateway.py',import.meta.url),path.join(runtime,'support/fastmcp-gateway.py'));
  for(const folder of ['data/workspace','data/temp','data/home'])await fs.mkdir(path.join(runtime,folder),{recursive:true});
  process.env.HARBOR_TOOL_RUNTIME_ROOT=runtime;let testHub;
  t.after(async()=>{await testHub?.close();process.env.HARBOR_TOOL_RUNTIME_ROOT=installed;for(const folder of ['runtimes','packages'])await fs.unlink(path.join(runtime,folder));await fs.rm(runtime,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const {hub,save,connect}=await setup(t);testHub=hub;
  await save('all-one',['one']);await save('search-two',['two'],'shared',{delivery:{toolMode:'hybrid',hybridModes:['bm25','regex']}});
  const a=await connect('all-one'),b=await connect('search-two');
  const direct=(await a.client.listTools()).tools[0].name;
  assert.deepEqual((await b.client.listTools()).tools.map(tool=>tool.name),['search_tools','call_tool']);
  const result=await b.client.callTool({name:'search_tools',arguments:{query:'echo'}});
  assert(!result.isError,JSON.stringify(result));assert(!JSON.stringify(result).includes(direct));
  const selected=hub.snapshot().tools.find(tool=>tool.serverId==='two').name;assert(JSON.stringify(result).includes(selected));
  const denied=await b.client.callTool({name:'call_tool',arguments:{name:direct,arguments:{}}});assert.equal(denied.isError,true);
  const success=await b.client.callTool({name:'call_tool',arguments:{name:selected,arguments:{text:'scoped search'}}});assert(!success.isError);
  assert.equal((await a.client.listTools()).tools[0].name,direct);assert.equal(hub.getSettings().toolMode,'all');
  await hub.disconnectProfile('search-two');assert((await echo(a.client,direct)).pid);
  assert(!hub.getProfiles().runtimes.some(context=>context.profileId==='search-two'));
});
