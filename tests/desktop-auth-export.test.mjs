import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter,once} from 'node:events';
import {createServer} from 'node:http';
import {Module,createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import vm from 'node:vm';
import {connectionInfo} from '../src/desktop/policy.mjs';

const secret='harbor_synthetic_export_key_123456';
const mainPath=fileURLToPath(new URL('../src/desktop/main.cjs',import.meta.url));
const require=createRequire(import.meta.url);

test('connection previews use standard Authorization headers and redact credentials even when extra key fields are supplied',()=>{
  const info=connectionInfo({endpoint:'http://127.0.0.1:37373/mcp',bridgePath:'C:/Harbor/bridge.mjs',nodePath:'C:/Harbor/node.exe',authentication:{enabled:true,hasKey:true,key:secret}});
  assert.deepEqual(info.authentication,{enabled:true,hasKey:true});
  assert.deepEqual(info.httpConfig.mcpServers.harbor.headers,{Authorization:'Bearer <YOUR_HARBOR_API_KEY>'});
  assert.deepEqual(info.stdioConfig.mcpServers.harbor.env,{HARBOR_API_KEY:'<YOUR_HARBOR_API_KEY>'});
  assert.ok(!JSON.stringify(info).includes(secret));
  const disabled=connectionInfo({endpoint:info.endpoint,bridgePath:'bridge.mjs',authentication:{enabled:false,hasKey:true,key:secret}});
  assert.equal(disabled.httpConfig.mcpServers.harbor.headers,undefined);assert.equal(disabled.stdioConfig.mcpServers.harbor.env,undefined);assert.ok(!JSON.stringify(disabled).includes(secret));
});

test('preload exposes explicit auth operations without a plaintext-key getter',async()=>{
  let api;const calls=[];
  vm.runInNewContext(await fs.readFile(new URL('../src/desktop/preload.cjs',import.meta.url),'utf8'),{require:name=>{assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(_key,value)=>api=value},ipcRenderer:{invoke:(...args)=>{calls.push(args);return Promise.resolve(true);}}};}});
  for(const name of ['getGatewayAuth','generateGatewayKey','updateGatewayAuth','copyGatewayKey','copyConnectionConfiguration'])assert.equal(typeof api[name],'function');
  assert.equal(api.getGatewayKey,undefined);assert.equal(Object.isFrozen(api),true);
  await api.copyConnectionConfiguration({format:'http',endpoint:'http://127.0.0.1:1/mcp'});
  assert.equal(calls[0][0],'harbor:copyConnectionConfiguration');
});

async function desktop(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-auth-export-'));
  await fs.writeFile(path.join(dir,'servers.json'),JSON.stringify({version:1,servers:[]}));
  const handlers=new Map(),errors=[],copies=[];let startup,runtime;
  const app=Object.assign(new EventEmitter(),{setName(){},setPath(){},requestSingleInstanceLock:()=>true,getPath:()=>dir,getVersion:()=>'test',whenReady:()=>({then:start=>({catch:handle=>startup=Promise.resolve().then(start).catch(handle)})}),quit(){},exit(){}});
  class BrowserWindow extends EventEmitter{
    constructor(){super();this.webContents=Object.assign(new EventEmitter(),{mainFrame:{url:pathToFileURL(path.resolve(path.dirname(mainPath),'../ui/index.html')).href},setWindowOpenHandler(){},session:{setPermissionRequestHandler(){}}});}
    async loadFile(){}show(){}isMinimized(){return false;}focus(){}hide(){}
  }
  class Tray extends EventEmitter{setToolTip(){}setContextMenu(){}destroy(){}}
  const electron={app,BrowserWindow,Tray,Menu:{buildFromTemplate:value=>value},nativeImage:{createFromBitmap(){}},ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},clipboard:{writeText:text=>copies.push(text)},dialog:{showErrorBox:(_title,message)=>errors.push(message),showOpenDialog:async()=>({canceled:true})}};
  const compiled=new Module(mainPath);compiled.filename=mainPath;
  compiled._compile(`module.exports=(require,process,console)=>{\n${await fs.readFile(mainPath,'utf8')}\nreturn {get hub(){return hub;},get window(){return window;}};\n};`,mainPath);
  runtime=compiled.exports(name=>name==='electron'?electron:require(name),{env:{HARBOR_DATA_DIR:dir,HARBOR_PORT:'0'},platform:process.platform},{error:error=>errors.push(error.message)});
  t.after(async()=>{await runtime.hub?.close();await fs.rm(dir,{recursive:true,force:true});});
  await startup;assert.deepEqual(errors,[]);
  const sender=runtime.window.webContents,senderFrame=sender.mainFrame;
  return {runtime,dir,copies,errors,call:(name,...args)=>handlers.get(`harbor:${name}`)({sender,senderFrame},...args)};
}

test('desktop copies usable LM Studio HTTP and stdio credentials only through explicit clipboard actions',async t=>{
  const d=await desktop(t);assert.deepEqual(d.call('getGatewayAuth'),{enabled:true,hasKey:true,loopbackOnly:true});
  const input={enabled:true,key:secret};const save=d.call('updateGatewayAuth',input);input.key='harbor_later_caller_mutation_12345';input.enabled=false;
  assert.deepEqual(await save,{enabled:true,hasKey:true,loopbackOnly:true});
  const info=d.call('connectionInfo');assert.ok(!JSON.stringify(info).includes(secret));assert.ok(!JSON.stringify(d.call('snapshot')).includes(secret));assert.ok(!JSON.stringify(d.call('getSettings')).includes(secret));
  assert.equal(d.call('copyConnectionConfiguration',{format:'http',endpoint:info.endpoint}),true);
  assert.deepEqual(JSON.parse(d.copies.at(-1)),{mcpServers:{harbor:{url:info.endpoint,headers:{Authorization:`Bearer ${secret}`}}}});
  assert.equal(d.call('copyConnectionConfiguration',{format:'stdio',endpoint:info.endpoint}),true);
  const stdio=JSON.parse(d.copies.at(-1)).mcpServers.harbor;assert.equal(stdio.command,'node');assert.equal(stdio.args[1],info.endpoint);assert.deepEqual(stdio.env,{HARBOR_API_KEY:secret});
  assert.equal(d.call('copyGatewayKey'),true);assert.equal(d.copies.at(-1),secret);
  const copied=d.copies.length;
  assert.throws(()=>d.call('copyConnectionConfiguration',{format:'http',endpoint:'https://unapproved.example/mcp'}),/active Harbor endpoint/);
  assert.throws(()=>d.call('copyConnectionConfiguration',{format:'unknown',endpoint:info.endpoint}),/configuration format/);assert.equal(d.copies.length,copied);
  await d.call('updateGatewayAuth',{enabled:false});
  d.call('copyConnectionConfiguration',{format:'http',endpoint:info.endpoint});assert.equal(JSON.parse(d.copies.at(-1)).mcpServers.harbor.headers,undefined);
  d.call('copyConnectionConfiguration',{format:'stdio',endpoint:info.endpoint});assert.equal(JSON.parse(d.copies.at(-1)).mcpServers.harbor.env,undefined);
  assert.deepEqual(d.errors,[]);
});


test('desktop permits an explicit combined both-off choice and can restore both protections',async t=>{
  const d=await desktop(t);
  assert.deepEqual(await d.call('updateGatewayAuth',{enabled:false,loopbackOnly:false}),{enabled:false,hasKey:true,loopbackOnly:false});
  assert.equal(d.call('getSettings').networkEnabled,true);
  const open=await fetch(d.runtime.hub.endpoint);assert.notEqual(open.status,401);assert.notEqual(open.status,403);await open.body?.cancel();
  assert.deepEqual(await d.call('updateGatewayAuth',{enabled:true,loopbackOnly:true}),{enabled:true,hasKey:true,loopbackOnly:true});
  assert.equal(d.call('getSettings').networkEnabled,false);
  const protectedReply=await fetch(d.runtime.hub.endpoint);assert.equal(protectedReply.status,401);await protectedReply.body?.cancel();
});

test('failed network bind rolls the desktop combined update back to its previous key, settings and live listener',async t=>{
  const d=await desktop(t);await d.call('updateGatewayAuth',{enabled:true,key:secret,loopbackOnly:true});
  const port=Number(new URL(d.runtime.hub.endpoint).port);
  await d.call('updateSettings',{...d.call('getSettings'),port,bindAddress:'127.0.0.2'});
  const settingsBefore=d.call('getSettings');
  const savedBefore=await fs.readFile(path.join(d.dir,'auth','gateway.json'),'utf8');
  const blocker=createServer((_req,res)=>res.writeHead(204).end()).listen(port,'127.0.0.2');await once(blocker,'listening');
  t.after(async()=>{blocker.closeAllConnections();await new Promise(resolve=>blocker.close(resolve));});
  const replacement='harbor_synthetic_failed_bind_key_67890';
  await assert.rejects(d.call('updateGatewayAuth',{enabled:false,key:replacement,loopbackOnly:false}),/EADDRINUSE|address already in use/i);
  assert.deepEqual(d.call('getGatewayAuth'),{enabled:true,hasKey:true,loopbackOnly:true});assert.deepEqual(d.call('getSettings'),settingsBefore);
  assert.equal(await fs.readFile(path.join(d.dir,'auth','gateway.json'),'utf8'),savedBefore);
  d.call('copyGatewayKey');assert.equal(d.copies.at(-1),secret);
  const oldKey=await fetch(d.runtime.hub.endpoint,{headers:{Authorization:`Bearer ${secret}`}});assert.notEqual(oldKey.status,401);assert.notEqual(oldKey.status,403);await oldKey.body?.cancel();
  const newKey=await fetch(d.runtime.hub.endpoint,{headers:{Authorization:`Bearer ${replacement}`}});assert.equal(newKey.status,401);await newKey.body?.cancel();
});
