import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {_electron as electron,expect} from '@playwright/test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('native gateway key controls protect HTTP and bridge clients, rotate keys and persist without exposing secrets',{skip:!process.env.HARBOR_TEST_AUTH_DESKTOP,timeout:180000},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor gateway auth desktop '));
 const env={...process.env,HARBOR_DATA_DIR:dir,HARBOR_PORT:'0'};delete env.ELECTRON_RUN_AS_NODE;delete env.HARBOR_PORTABLE_ROOT;
 const launch=()=>electron.launch({...(process.env.HARBOR_EXECUTABLE?{executablePath:process.env.HARBOR_EXECUTABLE,args:[]}:{args:['.']}),env});
 let app=await launch(),page=await app.firstWindow(),clients=[],clipboardBefore=await app.evaluate(({clipboard})=>clipboard.readText());
 const key1='fixture_gateway_key_one_0123456789',key2='fixture_gateway_key_two_0123456789';
 const quit=async()=>{const p=app.process(),done=p.exitCode===null?new Promise(r=>p.once('exit',r)):Promise.resolve();await app.evaluate(({app})=>app.quit()).catch(()=>{});await done;};
 const connect=async(endpoint,key)=>{const client=new Client({name:'Auth desktop acceptance',version:'1'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:key?{Authorization:'Bearer '+key}:{}}}));return client;};
 const setAuth=async(key,enabled=true,loopbackOnly=true)=>{await page.getByLabel('Use API key',{exact:true}).setChecked(enabled);await page.getByLabel('Loopback only',{exact:true}).setChecked(loopbackOnly);if(key!==undefined)await page.getByLabel('Gateway API key',{exact:true}).fill(key);await page.getByRole('button',{name:'Apply protections',exact:true}).click();await expect(page.locator('#gateway-auth-result')).toContainText(/saved|applied/i);};
 try{
  await page.evaluate(config=>window.harbor.saveServer(config),{id:'auth-fixture',name:'Auth fixture',command:process.execPath,args:[path.resolve('tests/fixtures/server.mjs')],autoStart:true});await page.evaluate(()=>window.harbor.startServer('auth-fixture'));
  const before=await page.evaluate(()=>window.harbor.getSettings()),pid=(await page.evaluate(()=>window.harbor.snapshot())).servers[0].pid;
  await page.getByRole('button',{name:'This Server',exact:true}).click();await expect(page.getByLabel('Gateway API key',{exact:true})).toHaveAttribute('type','password');
  let info=await page.evaluate(()=>window.harbor.connectionInfo());
  await expect(page.getByLabel('Use API key',{exact:true})).toBeChecked();await expect(page.getByLabel('Loopback only',{exact:true})).toBeChecked();
  assert.deepEqual(await page.evaluate(()=>window.harbor.getGatewayAuth()),{enabled:true,hasKey:true,loopbackOnly:true});assert.equal((await fetch(info.endpoint)).status,401);
  await setAuth(undefined,false);const anonymous=await connect(info.endpoint);
  await setAuth(key1);await expect(page.getByLabel('Gateway API key',{exact:true})).toHaveValue('');
  assert.equal((await fetch(info.endpoint)).status,401);assert.equal((await fetch(info.endpoint+'/_harbor_catalog')).status,401);
  await assert.rejects(connect(info.endpoint,'wrong_fixture_key_0123456'));
  await assert.rejects(anonymous.listTools());
  let authorized=await connect(info.endpoint,key1);assert((await authorized.listTools()).tools.length);
  await page.getByRole('button',{name:'Copy key',exact:true}).click();assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),key1);
  info=await page.evaluate(()=>window.harbor.connectionInfo());assert(!JSON.stringify(info).includes(key1));assert(info.httpConfig.mcpServers.harbor.headers.Authorization.includes('<YOUR_HARBOR_API_KEY>'));
  await page.evaluate(({endpoint})=>window.harbor.copyConnectionConfiguration({format:'http',endpoint}),info);
  const copied=JSON.parse(await app.evaluate(({clipboard})=>clipboard.readText()));assert.equal(copied.mcpServers.harbor.headers.Authorization,'Bearer '+key1);
  await page.evaluate(({endpoint})=>window.harbor.copyConnectionConfiguration({format:'stdio',endpoint}),info);
  const bridge=JSON.parse(await app.evaluate(({clipboard})=>clipboard.readText())).mcpServers.harbor;
  assert.equal(bridge.env.HARBOR_API_KEY,key1);const stdio=new Client({name:'Copied bridge acceptance',version:'1'});clients.push(stdio);await stdio.connect(new StdioClientTransport({...bridge,command:process.execPath,env:{...process.env,...bridge.env},stderr:'pipe'}));assert((await stdio.listTools()).tools.length);await stdio.close();
  if(process.env.HARBOR_TOOL_RUNTIME_ROOT){
   const original=(await authorized.listTools()).tools[0].name;
   for(const mode of ['bm25','regex','code','portkey-local','hybrid','all']){
    await page.evaluate(settings=>window.harbor.updateDeliverySettings({settings}),{...before,toolMode:mode});
    const advertised=(await authorized.listTools()).tools;assert(advertised.length);
    if(mode!=='all'){const params=mode==='code'?{name:'search',arguments:{query:'echo',detail:'full'}}:{name:'search_tools',arguments:mode==='regex'?{pattern:'echo'}:{query:'repeat echo text'}};const r=await authorized.callTool(params,undefined,{timeout:120000});assert(!r.isError,mode+' '+JSON.stringify(r));assert(JSON.stringify(r).includes(original),mode+' '+JSON.stringify(r));}
    const request=mode==='all'?{name:original,arguments:{text:'authenticated'}}:mode==='code'?{name:'execute',arguments:{code:`return await call_tool(${JSON.stringify(original)}, {"text":"authenticated"})`}}:{name:'call_tool',arguments:{name:original,arguments:{text:'authenticated'}}};
    const r=await authorized.callTool(request,undefined,{timeout:120000});assert(!r.isError,mode);assert(JSON.stringify(r).includes('authenticated'),mode);
   }
   await page.evaluate(s=>window.harbor.updateDeliverySettings({settings:s}),before);
  }
  await setAuth(key2);assert.equal((await fetch(info.endpoint,{headers:{Authorization:'Bearer '+key1}})).status,401);await assert.rejects(authorized.listTools());
  authorized=await connect(info.endpoint,key2);assert((await authorized.listTools()).tools.length);
  assert.equal((await page.evaluate(()=>window.harbor.snapshot())).servers[0].pid,pid);
  const safe=JSON.stringify(await page.evaluate(async()=>({snapshot:await window.harbor.snapshot(),settings:await window.harbor.getSettings(),info:await window.harbor.connectionInfo()})));assert(!safe.includes(key1));assert(!safe.includes(key2));
  await page.getByRole('button',{name:'Generate new key',exact:true}).click();const draft=await page.getByLabel('Gateway API key',{exact:true}).inputValue();assert(draft.startsWith('harbor_'));assert(draft.length>=40);assert((await authorized.listTools()).tools.length);
  await setAuth(draft);assert.equal((await fetch(info.endpoint,{headers:{Authorization:'Bearer '+key2}})).status,401);
  for(const c of clients)await c.close();clients=[];await quit();app=await launch();page=await app.firstWindow();await page.getByRole('button',{name:'This Server',exact:true}).click();
  await expect(page.getByLabel('Use API key',{exact:true})).toBeChecked();await expect(page.getByLabel('Loopback only',{exact:true})).toBeChecked();await expect(page.getByLabel('Gateway API key',{exact:true})).toHaveValue('');info=await page.evaluate(()=>window.harbor.connectionInfo());
  assert.equal((await fetch(info.endpoint)).status,401);authorized=await connect(info.endpoint,draft);await expect.poll(async()=>(await authorized.listTools()).tools.length).toBeGreaterThan(0);
  await page.getByRole('button',{name:'Copy key',exact:true}).click();assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),draft);
  for(const [enabled,loopbackOnly] of [[true,false],[false,true],[false,false]]){
   await setAuth(undefined,enabled,loopbackOnly);info=await page.evaluate(()=>window.harbor.connectionInfo());
   assert.deepEqual(await page.evaluate(()=>window.harbor.getGatewayAuth()),{enabled,hasKey:true,loopbackOnly});
   assert.equal((await page.evaluate(()=>window.harbor.getSettings())).networkEnabled,!loopbackOnly);
   const client=await connect(info.endpoint,enabled?draft:undefined);assert((await client.listTools()).tools.length);
   if(enabled)assert.equal((await fetch(info.endpoint)).status,401);
  }
  if(process.env.HARBOR_AUTH_SCREENSHOT)await page.screenshot({path:process.env.HARBOR_AUTH_SCREENSHOT,fullPage:true});
  for(const c of clients)await c.close();clients=[];await quit();app=await launch();page=await app.firstWindow();
  await page.getByRole('button',{name:'This Server',exact:true}).click();await expect(page.getByLabel('Use API key',{exact:true})).not.toBeChecked();await expect(page.getByLabel('Loopback only',{exact:true})).not.toBeChecked();
  info=await page.evaluate(()=>window.harbor.connectionInfo());assert((await (await connect(info.endpoint)).listTools()).tools.length);
 }finally{
  for(const c of clients)await c.close().catch(()=>{});await app.evaluate(({clipboard},value)=>clipboard.writeText(value),clipboardBefore).catch(()=>{});await quit();await fs.rm(dir,{recursive:true,force:true});
 }
});
