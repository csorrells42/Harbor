import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'node:net';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ResourceUpdatedNotificationSchema,ResourceListChangedNotificationSchema,PromptListChangedNotificationSchema} from '@modelcontextprotocol/sdk/types.js';
import {createHub} from '../src/core/hub.mjs';
import {parseReference,resourceReference} from '../src/core/mcp-primitives.mjs';

const fixture=fileURLToPath(new URL('./fixtures/primitives-server.mjs',import.meta.url));
const uri='fixture://same/path?q=%25#fragment';
const until=async check=>{const end=Date.now()+6000;while(!await check()){assert(Date.now()<end,'Expected MCP state did not settle');await delay(15);}};
async function setup(t,configs=[['one'],['two']]){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor MCP primitives '));
  const hub=await createHub({configPath:path.join(dir,'servers.json'),port:0}),connections=[];
  t.after(async()=>{for(const {client,transport} of connections){await transport.terminateSession().catch(()=>{});await client.close().catch(()=>{});}await hub.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  for(const [id,mode] of configs){await hub.saveServer({id,name:id,command:process.execPath,args:[fixture,...(mode?[mode]:[])]});await hub.startServer(id);}
  const save=(id,serverIds,capabilities=['tools','resources','prompts'],isolation='shared')=>hub.saveProfile({id,name:id,serverIds,capabilities,isolation,delivery:{toolMode:'all'}});
  async function connect(id,version){
    const client=new Client({name:'MCP primitive '+(id??'default'),version:'1'}),transport=new StreamableHTTPClientTransport(new URL(hub.endpoint+(id?'/profiles/'+id:'')));
    if(version){const request=client.request.bind(client);client.request=(message,...args)=>request(message.method==='initialize'?{...message,params:{...message.params,protocolVersion:version}}:message,...args);}
    const notifications={resources:[],prompts:[],updated:[]};
    for(const [schema,kind] of [[ResourceListChangedNotificationSchema,'resources'],[PromptListChangedNotificationSchema,'prompts'],[ResourceUpdatedNotificationSchema,'updated']])client.setNotificationHandler(schema,notification=>notifications[kind].push(notification));
    await client.connect(transport);const connection={client,transport,notifications};connections.push(connection);return connection;
  }
  const control=async(client,id,action,args={},options)=>{
    const tools=(await client.listTools()).tools,name=tools.find(tool=>tool.name.startsWith(id+'__')).name;
    return client.callTool({name,arguments:{action,...args}},undefined,options);
  };
  const state=async(client,id)=>JSON.parse((await control(client,id,'state')).content[0].text);
  return {hub,save,connect,control,state};
}

test('real MCP resources, templates and prompts preserve namespaces, pagination, binary content and embedded tool references',async t=>{
  const {connect,control}=await setup(t),{client}=await connect();
  assert.deepEqual(client.getServerCapabilities(),{tools:{listChanged:true},resources:{listChanged:true,subscribe:true},prompts:{listChanged:true}});
  const listed=await client.listResources();assert.equal(listed.resources.length,4);assert.equal(new Set(listed.resources.map(r=>r.uri)).size,4);
  for(const resource of listed.resources){const read=await client.readResource({uri:resource.uri});assert.equal(read.contents[0].uri,resource.uri);assert.equal(JSON.parse(read.contents[0].text).uri,parseReference(resource.uri).value);assert.equal(read.contents[1].blob,'aGVsbG8=');assert.equal(parseReference(read.contents[1].uri).serverId,parseReference(resource.uri).serverId);}
  const templates=(await client.listResourceTemplates()).resourceTemplates;assert.equal(templates.length,2);
  const expanded=templates[0].uriTemplate.replace('{+path}','a/b').replace('{?query}','?query=x%20y');assert.equal((await client.readResource({uri:expanded})).contents[0].uri,expanded);
  const prompts=(await client.listPrompts()).prompts;assert.equal(new Set(prompts.map(p=>p.name)).size,2);
  for(const prompt of prompts){const result=await client.getPrompt({name:prompt.name});const embedded=result.messages[0].content.resource;assert.equal(parseReference(embedded.uri).serverId,parseReference(prompt.name,'prompt').serverId);await client.readResource({uri:embedded.uri});}
  const result=await control(client,'two','link');assert.equal(result.content.length,2);for(const item of result.content){const ref=item.uri??item.resource.uri;assert.equal(parseReference(ref).serverId,'two');await client.readResource({uri:ref});}
  await assert.rejects(client.readResource({uri}),/Expected a Harbor/);await assert.rejects(client.listResources({cursor:'invented'}),/without cursors/);
});

test('profile capabilities and server exposure apply to reads, prompts, subscriptions and notifications',async t=>{
  const {save,connect,control}=await setup(t);await save('resources-only',['one'],['resources']);await save('second',['two']);await save('tools-only',['one'],['tools']);
  const a=await connect('resources-only'),b=await connect('second'),tools=await connect('tools-only'),all=await connect();
  assert.deepEqual(a.client.getServerCapabilities(),{resources:{listChanged:true,subscribe:true}});assert.deepEqual(tools.client.getServerCapabilities(),{tools:{listChanged:true}});
  assert.equal((await a.client.listResources()).resources.length,2);
  const other=(await b.client.listResources()).resources[0].uri;
  await assert.rejects(a.client.readResource({uri:other}),/outside this live profile/);await assert.rejects(a.client.subscribeResource({uri:other}),/outside this live profile/);
  await assert.rejects(a.client.listPrompts(),/does not expose/);await assert.rejects(tools.client.listResources(),/does not expose/);
  const counts=[a.notifications.resources.length,b.notifications.resources.length];await control(all.client,'two','notify');await until(()=>b.notifications.resources.length>counts[1]);await delay(60);assert.equal(a.notifications.resources.length,counts[0]);assert.equal(tools.notifications.resources.length,0);assert.equal(a.notifications.prompts.length,0);
});

test('shared resource subscriptions are idempotent, reference counted and cleaned up by actual client termination',async t=>{
  const {connect,control,state}=await setup(t,[['one']]),a=await connect(),b=await connect(),c=await connect(),ref=resourceReference('one',uri);
  await Promise.all([a.client.subscribeResource({uri:ref}),a.client.subscribeResource({uri:ref}),b.client.subscribeResource({uri:ref})]);assert.equal((await state(c.client,'one')).subscribes,1);
  await control(c.client,'one','notify');await until(()=>a.notifications.updated.length===1&&b.notifications.updated.length===1);assert.equal(c.notifications.updated.length,0);assert.equal(a.notifications.updated[0].params.uri,ref);
  await a.client.unsubscribeResource({uri:ref});assert.equal((await state(c.client,'one')).unsubscribes,0);
  await control(c.client,'one','notify');await until(()=>b.notifications.updated.length===2);assert.equal(a.notifications.updated.length,1);
  await b.transport.terminateSession();await b.client.close();await until(async()=> (await state(c.client,'one')).unsubscribes===1);
  await c.client.subscribeResource({uri:ref});assert.equal((await state(c.client,'one')).subscribes,2);await c.client.unsubscribeResource({uri:ref});assert.equal((await state(c.client,'one')).unsubscribes,2);
});

test('progress and cancellation follow the originating request for tools, resources and prompts without crossing clients',async t=>{
  const {connect,control,state}=await setup(t,[['one']]),a=await connect(),b=await connect();
  const name=(await a.client.listPrompts()).prompts[0].name,methods=[(options)=>a.client.readResource({uri:resourceReference('one','fixture://slow')},options),(options)=>a.client.getPrompt({name,arguments:{slow:'yes'}},options),(options)=>control(a.client,'one','slow',{slow:true},options)];
  for(const run of methods){
    const abort=new AbortController(),events=[],before=await state(b.client,'one');const pending=assert.rejects(run({signal:abort.signal,onprogress:progress=>events.push(progress)}));
    await until(()=>events.length>0);assert.equal(events[0].progress,1);abort.abort(Error('client requested cancellation'));await pending;await until(async()=> (await state(b.client,'one')).cancelled===before.cancelled+1);
  }
  const events=[];await b.client.readResource({uri:resourceReference('one',uri)},{onprogress:value=>events.push(value)});assert.deepEqual(events.map(value=>value.progress),[1,2]);
  assert.equal(a.notifications.updated.length,0);assert.equal(b.notifications.updated.length,0);
});

test('malformed, looping and oversized upstream content remains isolated; unsupported subscriptions and sampling fail usefully',async t=>{
  const {connect,control,state}=await setup(t,[['bad','malformed'],['loop','loop'],['good'],['limited','no-subscribe'],['tools','tools']]),{client}=await connect();
  const result=await client.listResources();assert.equal(result.resources.length,4);assert.deepEqual(result._meta['harbor/listingErrors'].map(item=>item.serverId),['bad','loop']);
  await assert.rejects(client.readResource({uri:resourceReference('good','fixture://invalid')}));await assert.rejects(client.readResource({uri:resourceReference('good','fixture://oversize')}),/4 MiB/);
  await assert.rejects(client.subscribeResource({uri:resourceReference('limited',uri)}),/does not support resource subscriptions/);
  assert((await client.readResource({uri:resourceReference('good',uri)})).contents[0].text);
  assert.deepEqual((await state(client,'good')).clientCapabilities,{});assert.match((await control(client,'good','sampling')).content[0].text,/sampling/);
});

test('isolated profile resource subscriptions belong to their session process; Stop invalidates subscriptions and permits explicit resubscription after restart',async t=>{
  const {hub,save,connect,control,state}=await setup(t,[['one']]);await save('isolated',['one'],['tools','resources','prompts'],'process');
  const a=await connect('isolated'),b=await connect('isolated'),c=await connect(),ref=resourceReference('one',uri);
  await a.client.subscribeResource({uri:ref});await b.client.subscribeResource({uri:ref});assert.equal((await state(a.client,'one')).subscribes,1);assert.equal((await state(b.client,'one')).subscribes,1);assert.equal((await state(c.client,'one')).subscribes,0);
  await control(a.client,'one','notify');await until(()=>a.notifications.updated.length===1);assert.equal(b.notifications.updated.length,0);
  await c.client.subscribeResource({uri:ref});await hub.stopServer('one');assert.equal((await c.client.listResources()).resources.length,0);await hub.startServer('one');await c.client.subscribeResource({uri:ref});assert.equal((await state(c.client,'one')).subscribes,1);
  await control(c.client,'one','notify');await until(()=>c.notifications.updated.length===1);assert.equal(a.notifications.updated.length,1);
});

test('cancelled resource subscription is reconciled and does not prevent another client from subscribing',async t=>{
  const {connect,control,state}=await setup(t,[['one']]),a=await connect(),b=await connect(),ref=resourceReference('one',uri);
  await control(a.client,'one','slow-subscribe');const abort=new AbortController();const pending=assert.rejects(a.client.subscribeResource({uri:ref},{signal:abort.signal}));await until(async()=> (await state(b.client,'one')).subscribes===1);abort.abort();await pending;
  await until(async()=> (await state(b.client,'one')).unsubscribes===1);await b.client.subscribeResource({uri:ref});assert.equal((await state(b.client,'one')).subscribes,2);await b.client.unsubscribeResource({uri:ref});
});

test('negotiated older MCP versions receive compatible tool content and mismatched HTTP versions are rejected',async t=>{
  const {hub,connect,control}=await setup(t,[['one']]);
  for(const version of ['2024-11-05','2025-03-26','2025-06-18','2025-11-25']){
    const {client,transport}=await connect(undefined,version),result=await control(client,'one','link');
    assert.equal(result.content[0].type,version<'2025-06-18'?'text':'resource_link');assert.equal(result.content[1].type,'resource');
    const resources=await client.listResources();await client.readResource({uri:resources.resources[0].uri});
    const mismatched=await fetch(hub.endpoint,{method:'POST',headers:{Accept:'application/json, text/event-stream','Content-Type':'application/json','Mcp-Session-Id':transport.sessionId,'Mcp-Protocol-Version':version==='2025-11-25'?'2025-03-26':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:300,method:'resources/list'})});assert.equal(mismatched.status,400);await mismatched.text();
  }
});

test('simultaneous client progress tokens remain bound to their own resource requests',async t=>{
  const {connect}=await setup(t,[['one']]),a=await connect(),b=await connect(),one=[],two=[];
  await Promise.all([a.client.readResource({uri:resourceReference('one','fixture://slow-a')},{onprogress:value=>one.push(value)}),b.client.readResource({uri:resourceReference('one','fixture://slow-b')},{onprogress:value=>two.push(value)})]);
  assert.equal(one[0].message,'fixture started fixture://slow-a');assert.equal(two[0].message,'fixture started fixture://slow-b');assert.deepEqual(one.map(v=>v.progress),[1,2]);assert.deepEqual(two.map(v=>v.progress),[1,2]);
});

for(const kind of ['http','sse'])test(`resources and prompts use a real managed ${kind} upstream and retain protocol notifications`,async t=>{
  const {hub,connect,control}=await setup(t,[]),listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  await hub.saveServer({id:'network',name:'network',transport:kind,url:`http://127.0.0.1:${port}/${kind==='http'?'mcp':'sse'}`,managedProcesses:[{command:process.execPath,args:[fixture],runtime:'native',env:{PRIMITIVES_PORT:String(port)}}]});await hub.startServer('network');
  const {client,notifications}=await connect(),resources=await client.listResources();assert.equal(resources.resources.length,2);await client.readResource({uri:resources.resources[0].uri});await client.getPrompt({name:(await client.listPrompts()).prompts[0].name});
  await client.subscribeResource({uri:resources.resources[0].uri});await control(client,'network','notify');await until(()=>notifications.updated.length===1);await client.unsubscribeResource({uri:resources.resources[0].uri});
  const progress=[];await client.readResource({uri:resourceReference('network','fixture://slow')},{onprogress:value=>progress.push(value)});assert.deepEqual(progress.map(value=>value.progress),[1,2]);
});

test('the exported stdio bridge carries resources, prompts and subscription notifications',async t=>{
  const {hub,connect,control}=await setup(t,[['one']]),normal=await connect(),client=new Client({name:'resource bridge',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/bridge.mjs',import.meta.url)),hub.endpoint],stderr:'pipe'}),updates=[];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema,value=>updates.push(value));t.after(()=>client.close());await client.connect(transport);
  const resource=(await client.listResources()).resources[0];await client.readResource({uri:resource.uri});await client.getPrompt({name:(await client.listPrompts()).prompts[0].name});await client.subscribeResource({uri:resource.uri});await control(normal.client,'one','notify');await until(()=>updates.length===1);assert.equal(updates[0].params.uri,resource.uri);await client.unsubscribeResource({uri:resource.uri});
});
