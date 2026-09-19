import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {request} from 'node:http';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createGatewayAuthentication} from '../src/core/gateway-auth.mjs';
import {createHub} from '../src/core/hub.mjs';

const OLD='harbor_auth_test_old_1234567890',NEXT='harbor_auth_test_next_1234567890';
const fixture=fileURLToPath(new URL('./fixtures/server.mjs',import.meta.url));
const initBody={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'auth regression',version:'1'}}};
const until=async check=>{const end=Date.now()+10000;while(!await check()){if(Date.now()>end)throw Error('Timed out waiting for authentication state');await new Promise(r=>setTimeout(r,20));}};
async function setup(t,{enabled=true,child=false}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-auth-core-')),authentication=await createGatewayAuthentication({dataDir:dir});
  if(enabled)await authentication.update({enabled:true,key:OLD});
  const hub=await createHub({configPath:path.join(dir,'servers.json'),port:0,authentication});
  t.after(async()=>{await hub.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  if(child){await hub.saveServer({id:'fixture',command:process.execPath,args:[fixture]});await hub.startServer('fixture');}
  return {dir,authentication,hub};
}
async function send(endpoint,{key=OLD,method='POST',body=initBody,id,headers={}}={}){
  const response=await fetch(endpoint,{method,headers:{Accept:'application/json, text/event-stream',...(method==='POST'?{'Content-Type':'application/json'}:{}),...(key===null?{}:{Authorization:'Bearer '+key}),...(id?{'Mcp-Session-Id':id,'Mcp-Protocol-Version':'2025-03-26'}:{}),...headers},...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
  return {status:response.status,headers:response.headers,text:await response.text()};
}
async function initialize(endpoint,key=OLD){const response=await send(endpoint,{key});assert.equal(response.status,200,response.text);const id=response.headers.get('mcp-session-id');assert(id);const ready=await send(endpoint,{key,id,body:{jsonrpc:'2.0',method:'notifications/initialized'}});assert.equal(ready.status,202);return id;}
const listBody={jsonrpc:'2.0',id:2,method:'tools/list',params:{}};

test('public and raw catalog routes require keys before parsing requests; OPTIONS retains origin policy',async t=>{
  const {hub}=await setup(t);
  for(const endpoint of [hub.endpoint,hub.endpoint+'/_harbor_catalog']){
    for(const key of [null,'incorrect'])for(const method of ['GET','POST','DELETE']){
      const response=await send(endpoint,{key,method,body:'not JSON'});assert.equal(response.status,401);assert.equal(response.text,'{"error":"Unauthorized"}');assert.match(response.headers.get('www-authenticate'),/^Bearer/);
    }
    const id=await initialize(endpoint);assert.equal((await send(endpoint,{id,body:listBody})).status,200);
    assert.equal((await send(endpoint,{id,key:null,body:listBody})).status,401);
    assert.equal((await send(endpoint,{id,key:'incorrect',body:listBody})).status,401);
  }
  const origin=new URL(hub.endpoint).origin;
  const preflight=await send(hub.endpoint,{method:'OPTIONS',key:null,headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type,mcp-session-id'}});
  assert.equal(preflight.status,204);assert.match(preflight.headers.get('access-control-allow-headers'),/authorization/);
  assert.equal((await send(hub.endpoint,{method:'OPTIONS',key:null,headers:{Origin:'https://untrusted.invalid','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization'}})).status,403);
  assert.deepEqual(hub.snapshot().authentication,{enabled:true,hasKey:true});
  assert(!JSON.stringify(hub.snapshot()).includes(OLD));
});

test('rotation revokes public and external catalog sessions, keeps child PID and requires fresh initialization',async t=>{
  const {hub,authentication}=await setup(t,{child:true});
  const pid=hub.snapshot().servers[0].pid,id=await initialize(hub.endpoint),catalog=await initialize(hub.endpoint+'/_harbor_catalog');
  await authentication.update({enabled:true,key:NEXT});
  assert.equal((await send(hub.endpoint,{id,body:listBody})).status,401,'Old key must fail before serialized session cleanup');
  await hub.authenticationChanged();
  assert.equal((await send(hub.endpoint,{key:NEXT,id,body:listBody})).status,404);
  assert.equal((await send(hub.endpoint+'/_harbor_catalog',{key:NEXT,id:catalog,body:listBody})).status,404);
  const fresh=await initialize(hub.endpoint,NEXT);assert.equal((await send(hub.endpoint,{key:NEXT,id:fresh,body:listBody})).status,200);
  assert.equal(hub.snapshot().servers[0].pid,pid);assert(!JSON.stringify(hub.snapshot()).includes(NEXT));
});

test('a POST begun under the old key cannot finish initialization after rotation',async t=>{
  const {hub,authentication}=await setup(t);let resolveResponse;
  const response=new Promise(r=>resolveResponse=r),body=JSON.stringify(initBody);
  const req=request(hub.endpoint,{method:'POST',headers:{Authorization:'Bearer '+OLD,Accept:'application/json, text/event-stream','Content-Type':'application/json'}},res=>{let text='';res.setEncoding('utf8');res.on('data',v=>text+=v);res.on('end',()=>resolveResponse({status:res.statusCode,text}));});
  t.after(()=>req.destroy());req.on('error',error=>resolveResponse({error:error.message}));
  req.write(body.slice(0,30));await new Promise(r=>setTimeout(r,40));
  await authentication.update({enabled:true,key:NEXT});await hub.authenticationChanged();req.end(body.slice(30));
  const denied=await response;assert.equal(denied.status,401,JSON.stringify(denied));assert.equal(hub.snapshot().clients.length,0);
  await initialize(hub.endpoint,NEXT);
});

test('saved authentication changes close an existing SSE stream',async t=>{
  const {hub,authentication}=await setup(t),id=await initialize(hub.endpoint),abort=new AbortController();t.after(()=>abort.abort());
  const response=fetch(hub.endpoint,{headers:{Accept:'text/event-stream',Authorization:'Bearer '+OLD,'Mcp-Session-Id':id,'Mcp-Protocol-Version':'2025-03-26'},signal:abort.signal});
  await new Promise(r=>setTimeout(r,40));
  await hub.updateSettings({...hub.getSettings(),searchLimit:6});
  const stream=await response;assert.equal(stream.status,200);const reader=stream.body.getReader();const first=await reader.read();assert.equal(first.done,false);
  await authentication.update({enabled:true,key:NEXT});await hub.authenticationChanged();
  const end=await Promise.race([reader.read(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Revoked SSE remained open')),3000))]);assert.equal(end.done,true);
});

test('disabled legacy mode and enabling authentication have explicit session transitions',async t=>{
  const {hub,authentication}=await setup(t,{enabled:false});assert.deepEqual(hub.snapshot().authentication,{enabled:false,hasKey:false});
  const id=await initialize(hub.endpoint,null);await authentication.update({enabled:true,key:OLD});await hub.authenticationChanged();
  assert.equal((await send(hub.endpoint,{id,key:null,body:listBody})).status,401);assert.equal((await send(hub.endpoint,{id,body:listBody})).status,404);
  const enabled=await initialize(hub.endpoint);await authentication.update({enabled:false});await hub.authenticationChanged();assert.equal((await send(hub.endpoint,{id:enabled,key:null,body:listBody})).status,404);
  await initialize(hub.endpoint,null);assert.deepEqual(hub.snapshot().authentication,{enabled:false,hasKey:true});
});

test('authenticated FastMCP modes use a private catalog key and survive public key rotation',{
  skip:!process.env.HARBOR_TOOL_RUNTIME_ROOT,timeout:120000
},async t=>{
  const realRoot=path.resolve(process.env.HARBOR_TOOL_RUNTIME_ROOT),root=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor auth FastMCP '));
  const oldEnv=process.env.HARBOR_TOOL_RUNTIME_ROOT;let testHub;
  // Only the support script is staged; binaries are shared read-only via junctions.
  for(const dir of ['runtimes','packages'])await fs.symlink(path.join(realRoot,dir),path.join(root,dir),'junction');
  for(const dir of ['support','data/workspace','data/temp','data/home'])await fs.mkdir(path.join(root,dir),{recursive:true});
  await fs.symlink(path.join(realRoot,'support/python-site'),path.join(root,'support/python-site'),'junction');
  const source=await fs.readFile(new URL('../scripts/portable/fastmcp-gateway.py',import.meta.url),'utf8');
  // Capture only the disposable test gateway's private token to test route isolation.
  const tokenFile=path.join(root,'test-catalog-token');
  await fs.writeFile(path.join(root,'support/fastmcp-gateway.py'),`import os\nfrom pathlib import Path\nPath(${JSON.stringify(tokenFile)}).write_text(os.environ.get("HARBOR_CATALOG_TOKEN", ""))\n`+source);
  process.env.HARBOR_TOOL_RUNTIME_ROOT=root;
  t.after(async()=>{await testHub?.close();process.env.HARBOR_TOOL_RUNTIME_ROOT=oldEnv;for(const dir of ['runtimes','packages','support/python-site'])await fs.unlink(path.join(root,dir));await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const {hub,authentication}=await setup(t,{child:true}),pid=hub.snapshot().servers[0].pid;testHub=hub;
  const clients=[];t.after(async()=>{for(const c of clients)await c.close();});
  const connect=async key=>{const c=new Client({name:'authenticated modes',version:'1'});await c.connect(new StreamableHTTPClientTransport(new URL(hub.endpoint),{requestInit:{headers:{Authorization:'Bearer '+key}}}));clients.push(c);return c;};
  let client=await connect(OLD),currentKey=OLD;
  const tool=hub.snapshot().tools[0].name;
  for(const mode of ['bm25','regex','code','hybrid']){
    await hub.updateSettings({...hub.getSettings(),toolMode:mode,hybridModes:['bm25','regex','code']});
    const names=(await client.listTools()).tools.map(t=>t.name);assert(names.includes(mode==='code'?'execute':'search_tools'));
    const result=mode==='code'?await client.callTool({name:'execute',arguments:{code:`return await call_tool(${JSON.stringify(tool)}, {"text":"authenticated code"})`}}):await client.callTool({name:'search_tools',arguments:mode==='regex'?{pattern:'echo'}:{query:'echo text'}});
    assert(!result.isError,JSON.stringify(result));assert(JSON.stringify(result).includes(mode==='code'?'authenticated code':tool));
    if(mode!=='code'){const invoked=await client.callTool({name:'call_tool',arguments:{name:tool,arguments:{text:'authenticated invocation'}}});assert(!invoked.isError,JSON.stringify(invoked));}
    const token=await fs.readFile(tokenFile,'utf8');assert(token.length>=32);
    assert.equal((await send(hub.endpoint,{key:token})).status,401,'Private catalog key must never grant public access');
    const internal=await initialize(hub.endpoint+'/_harbor_catalog',token);
    const nextKey=currentKey===OLD?NEXT:OLD;await authentication.update({enabled:true,key:nextKey});await hub.authenticationChanged();
    assert.equal((await send(hub.endpoint+'/_harbor_catalog',{key:token,id:internal,body:listBody})).status,200,'Internal catalog session must survive public key rotation');
    await client.close();client=await connect(nextKey);currentKey=nextKey;
    assert((await client.listTools()).tools.length>0);assert.equal(hub.snapshot().servers[0].pid,pid);assert(!JSON.stringify(hub.snapshot()).includes(token));
  }
});
