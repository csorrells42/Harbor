import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import {request} from 'node:http';
import {createGatewayAuthentication} from '../src/core/gateway-auth.mjs';
import {createHub} from '../src/core/hub.mjs';
import {DEFAULT_SETTINGS} from '../src/core/settings.mjs';

const OLD='harbor_transaction_old_1234567890',NEXT='harbor_transaction_next_1234567890';
const fixture=fileURLToPath(new URL('./fixtures/server.mjs',import.meta.url));
const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'protection transaction regression',version:'1'}}};
const listing={jsonrpc:'2.0',id:2,method:'tools/list',params:{}};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function waitFor(promise,timeoutMs=10000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Deterministic transaction interception did not activate')),timeoutMs))]);}finally{clearTimeout(timer);}}
async function send(endpoint,{key=null,body=initialize,id}={}){
  const response=await fetch(endpoint,{method:'POST',headers:{Accept:'application/json, text/event-stream','Content-Type':'application/json',...(key?{Authorization:'Bearer '+key}:{}),...(id?{'Mcp-Session-Id':id,'Mcp-Protocol-Version':'2025-03-26'}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  return {status:response.status,text:await response.text(),id:response.headers.get('mcp-session-id')};
}
async function connect(endpoint,key=OLD){const result=await send(endpoint,{key});assert.equal(result.status,200,result.text);assert(result.id);assert.equal((await send(endpoint,{key,id:result.id,body:{jsonrpc:'2.0',method:'notifications/initialized'}})).status,202);return result.id;}
async function denied(endpoint,options={}){const result=await send(endpoint,options);assert.equal(result.status,503,result.text);}
async function setup(t,{child=false,network=false}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-protection-transaction-'));
  const authentication=await createGatewayAuthentication({dataDir:dir});await authentication.update({enabled:true,key:OLD});
  const hub=await createHub({configPath:path.join(dir,'servers.json'),port:0,authentication});
  t.after(async()=>{await hub.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  if(network)await hub.updateSettings({...hub.getSettings(),networkEnabled:true,bindAddress:'127.0.0.2'});
  if(child){await hub.saveServer({id:'fixture',command:process.execPath,args:[fixture]});await hub.startServer('fixture');}
  return {dir,hub,authentication,settingsFile:path.join(dir,'harbor-settings.json'),authFile:path.join(dir,'auth','gateway.json')};
}
function interceptRename(t,intercept){
  const original=fs.rename;fs.rename=async(...args)=>intercept(original,...args);syncBuiltinESMExports();
  const restore=()=>{fs.rename=original;syncBuiltinESMExports();};t.after(restore);return restore;
}
async function reopen(t,dir){
  const authentication=await createGatewayAuthentication({dataDir:dir}),hub=await createHub({configPath:path.join(dir,'servers.json'),port:0,authentication});
  t.after(()=>hub.close());return {hub,authentication};
}

test('queued protection change denies public and catalog work before auth changes and preserves healthy child',async t=>{
  const {hub,settingsFile,authentication}=await setup(t,{network:true,child:true});
  const endpoint=hub.endpoint,pid=hub.snapshot().servers[0].pid,id=await connect(endpoint),catalogId=await connect(endpoint+'/_harbor_catalog');
  assert.equal((await send(endpoint)).status,401);
  const entered=deferred(),release=deferred();let held=false;
  const restore=interceptRename(t,async(rename,source,destination)=>{if(destination===settingsFile&&!held){held=true;entered.resolve();await release.promise;}return rename(source,destination);});
  const settings=hub.patchSettings({toolTimeoutMs:130000}),settled=[];
  let protections;
  try{
    await waitFor(entered.promise);protections=hub.updateGatewayAuth({enabled:false,loopbackOnly:true});
    assert.equal(authentication.status().enabled,true,'Auth must remain unchanged while protection operation waits in the common queue');
    for(const route of [endpoint,endpoint+'/_harbor_catalog'])for(const key of [null,OLD])await denied(route,{key});
    await denied(endpoint,{key:OLD,id,body:listing});await denied(endpoint+'/_harbor_catalog',{key:OLD,id:catalogId,body:listing});
    assert.equal(hub.snapshot().servers[0].pid,pid);
  }finally{release.resolve();settled.push(...await Promise.allSettled([settings,protections]));restore();}
  assert(settled.every(result=>result.status==='fulfilled'),JSON.stringify(settled));
  assert.deepEqual(authentication.status(),{enabled:false,hasKey:true});assert.equal(new URL(hub.endpoint).hostname,'127.0.0.1');
  assert.equal((await send(hub.endpoint,{id,body:listing})).status,404,'The old public session is revoked');
  const fresh=await connect(hub.endpoint,null),echo=hub.snapshot().tools.find(tool=>tool.originalName==='echo');assert(echo);
  const result=await send(hub.endpoint,{id:fresh,body:{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:echo.name,arguments:{text:'transaction legitimate echo'}}}});
  assert.equal(result.status,200);assert(result.text.includes('transaction legitimate echo'));assert.equal(hub.snapshot().servers[0].pid,pid);
});

test('advanced and delivery snapshots queued behind protections cannot restore stale network enablement',async t=>{
  const {hub,settingsFile}=await setup(t,{network:true});const stale=hub.getSettings(),entered=deferred(),release=deferred();let held=false;
  const restore=interceptRename(t,async(rename,source,destination)=>{if(destination===settingsFile&&!held){held=true;entered.resolve();await release.promise;}return rename(source,destination);});
  const protections=hub.updateGatewayAuth({enabled:false,loopbackOnly:true});let advanced,delivery;
  try{await waitFor(entered.promise);advanced=hub.patchSettings({...stale,requestTimeoutMs:65000});delivery=hub.patchSettings({...stale,searchLimit:7},'delivery');}
  finally{release.resolve();await Promise.all([protections,advanced,delivery]);restore();}
  assert.equal(hub.getSettings().networkEnabled,false);assert.equal(hub.getSettings().requestTimeoutMs,65000);assert.equal(hub.getSettings().searchLimit,7);
  assert.equal(new URL(hub.endpoint).hostname,'127.0.0.1');await connect(hub.endpoint,null);
});

test('a slow anonymous initialization cannot cross a protection transition after reading its first body bytes',async t=>{
  const {hub,authFile}=await setup(t);await hub.updateGatewayAuth({enabled:false,loopbackOnly:true});
  const response=deferred(),body=JSON.stringify(initialize),req=request(hub.endpoint,{method:'POST',headers:{Accept:'application/json, text/event-stream','Content-Type':'application/json'}},res=>{let text='';res.setEncoding('utf8');res.on('data',part=>text+=part);res.on('end',()=>response.resolve({status:res.statusCode,text}));});
  req.on('error',error=>response.resolve({error:error.message}));t.after(()=>req.destroy());req.write(body.slice(0,30));
  // Flush headers/body to the actual socket before starting the queued protection write.
  await new Promise(resolve=>req.once('socket',socket=>socket.connecting?socket.once('connect',resolve):resolve()));
  await new Promise(resolve=>setTimeout(resolve,30));
  const entered=deferred(),release=deferred();let held=false;
  const restore=interceptRename(t,async(rename,source,destination)=>{if(destination===authFile&&!held){held=true;entered.resolve();await release.promise;}return rename(source,destination);});
  const update=hub.updateGatewayAuth({enabled:true,key:NEXT,loopbackOnly:true});
  try{await waitFor(entered.promise);req.end(body.slice(30));const result=await waitFor(response.promise);assert([401,503].includes(result.status),JSON.stringify(result));assert.equal(hub.snapshot().clients.length,0);}
  finally{release.resolve();await update;restore();}
  assert.equal((await send(hub.endpoint)).status,401);await connect(hub.endpoint,NEXT);
});

test('a failed first protection save does not poison a queued save or capture mutated caller choices',async t=>{
  const {hub,authentication,settingsFile,authFile}=await setup(t,{network:true}),endpoint=hub.endpoint;
  const firstEntered=deferred(),firstRelease=deferred(),secondEntered=deferred(),secondRelease=deferred();let settingsWrites=0,authWrites=0;
  const restore=interceptRename(t,async(rename,source,destination)=>{
    if(destination===settingsFile&&++settingsWrites===1){firstEntered.resolve();await firstRelease.promise;throw Error('Synthetic first protection failure');}
    if(destination===authFile&&++authWrites===3){secondEntered.resolve();await secondRelease.promise;}
    return rename(source,destination);
  });
  const first=hub.updateGatewayAuth({enabled:true,key:NEXT,loopbackOnly:true}),firstRejected=assert.rejects(first,/Synthetic first protection failure/);let second;
  try{
    await waitFor(firstEntered.promise);const input={enabled:false,loopbackOnly:true};second=hub.updateGatewayAuth(input);input.enabled=true;input.key=NEXT;input.loopbackOnly=false;
    firstRelease.resolve();await firstRejected;await waitFor(secondEntered.promise);await denied(endpoint);await denied(endpoint,{key:OLD});await denied(endpoint+'/_harbor_catalog',{key:OLD});
  }finally{firstRelease.resolve();secondRelease.resolve();await Promise.all([firstRejected,second]);restore();}
  assert.deepEqual(authentication.status(),{enabled:false,hasKey:true});assert.equal(authentication.key(),OLD,'Omission uses the last successful key, not a failed save or later caller mutation');assert.equal(hub.getSettings().networkEnabled,false);await connect(hub.endpoint,null);
});

test('failed listener apply keeps public traffic gated through delayed rollback and restores old live credentials first',async t=>{
  const {dir,hub,authentication,settingsFile,authFile}=await setup(t,{network:true}),endpoint=hub.endpoint;
  const rollback=deferred(),release=deferred();let authWrites=0;
  const restore=interceptRename(t,async(rename,source,destination)=>{
    if(destination===settingsFile)throw Error('Synthetic settings replacement failure');
    if(destination===authFile&&++authWrites===2){rollback.resolve();await release.promise;}
    return rename(source,destination);
  });
  const update=hub.updateGatewayAuth({enabled:false,loopbackOnly:true}),rejected=assert.rejects(update,/Synthetic settings replacement failure/);
  try{await waitFor(rollback.promise);assert.equal(authentication.status().enabled,true);assert.equal(authentication.key(),OLD);await denied(endpoint);await denied(endpoint,{key:OLD});await denied(endpoint+'/_harbor_catalog');}
  finally{release.resolve();await rejected;restore();}
  assert.equal(hub.endpoint,endpoint);assert.equal((await send(endpoint)).status,401);await connect(endpoint);
  const durable=JSON.parse(await fs.readFile(authFile,'utf8'));assert.equal(durable.enabled,true);await hub.close();
  const restarted=await reopen(t,dir);assert.equal(restarted.hub.getSettings().networkEnabled,true);assert.equal(new URL(restarted.hub.endpoint).hostname,'127.0.0.2');assert.equal((await send(restarted.hub.endpoint)).status,401);await connect(restarted.hub.endpoint,OLD);await restarted.hub.close();
});

test('rollback persistence failure remains closed until successful retry and its durable record restarts coherently',async t=>{
  const {hub,authentication,settingsFile,authFile}=await setup(t,{network:true}),endpoint=hub.endpoint;let authWrites=0;
  const restore=interceptRename(t,async(rename,source,destination)=>{
    if(destination===settingsFile)throw Error('Synthetic settings replacement failure');
    if(destination===authFile&&++authWrites===2)throw Error('Synthetic protection rollback replacement failure');
    return rename(source,destination);
  });
  try{await assert.rejects(hub.updateGatewayAuth({enabled:false,loopbackOnly:true}),/recovery could not be saved/);}finally{restore();}
  assert.equal(authentication.status().enabled,true);assert.equal(authentication.available(),false);
  for(const route of [endpoint,endpoint+'/_harbor_catalog'])for(const key of [null,OLD,NEXT])await denied(route,{key});
  const durable=JSON.parse(await fs.readFile(authFile,'utf8'));assert.equal(durable.enabled,false);assert.equal(durable.settings.networkEnabled,false);
  const crashDir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-protection-recovery-'));t.after(()=>fs.rm(crashDir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  await fs.mkdir(path.join(crashDir,'auth'));await fs.writeFile(path.join(crashDir,'auth','gateway.json'),JSON.stringify(durable));await fs.copyFile(settingsFile,path.join(crashDir,'harbor-settings.json'));
  const restarted=await reopen(t,crashDir);assert.equal(new URL(restarted.hub.endpoint).hostname,'127.0.0.1');await connect(restarted.hub.endpoint,null);await restarted.hub.close();
  await hub.updateGatewayAuth({enabled:false,loopbackOnly:true});assert.equal(authentication.available(),true);assert.equal(new URL(hub.endpoint).hostname,'127.0.0.1');await connect(hub.endpoint,null);
});

test('atomic authority pairs key rotation with listener narrowing across an interrupted settings mirror',async t=>{
  const {hub,settingsFile,authFile}=await setup(t,{network:true});const oldSettings=await fs.readFile(settingsFile,'utf8'),entered=deferred(),release=deferred();let held=false;
  const restore=interceptRename(t,async(rename,source,destination)=>{if(destination===settingsFile&&!held){held=true;entered.resolve();await release.promise;}return rename(source,destination);});
  const update=hub.updateGatewayAuth({enabled:true,key:NEXT,loopbackOnly:true});let authority;
  try{await waitFor(entered.promise);authority=await fs.readFile(authFile,'utf8');const saved=JSON.parse(authority);assert.equal(saved.key,NEXT);assert.equal(saved.settings.networkEnabled,false);assert.equal(await fs.readFile(settingsFile,'utf8'),oldSettings);}
  finally{release.resolve();await update;restore();}
  const crashDir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-protection-crash-'));t.after(()=>fs.rm(crashDir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  await fs.mkdir(path.join(crashDir,'auth'));await fs.writeFile(path.join(crashDir,'auth','gateway.json'),authority);
  // The stale mirror can even reference a disappeared LAN interface; authority must win before that draft is validated.
  await fs.writeFile(path.join(crashDir,'harbor-settings.json'),JSON.stringify({...JSON.parse(oldSettings),bindAddress:'192.0.2.234'}));
  const restarted=await reopen(t,crashDir);assert.equal(new URL(restarted.hub.endpoint).hostname,'127.0.0.1');assert.equal((await send(restarted.hub.endpoint,{key:OLD})).status,401);assert.equal((await send(restarted.hub.endpoint)).status,401);await connect(restarted.hub.endpoint,NEXT);await restarted.hub.close();
});

test('atomic authority preserves the requested concrete bind rather than replaying an old dormant wildcard',async t=>{
  const {hub,settingsFile,authFile}=await setup(t);await hub.updateSettings(hub.getSettings());await hub.updateGatewayAuth({enabled:false,loopbackOnly:true});
  const oldSettings=await fs.readFile(settingsFile,'utf8');assert.equal(JSON.parse(oldSettings).bindAddress,'0.0.0.0');
  const entered=deferred(),release=deferred();let held=false,authority;
  const restore=interceptRename(t,async(rename,source,destination)=>{if(destination===settingsFile&&!held){held=true;entered.resolve();await release.promise;}return rename(source,destination);});
  const update=hub.updateSettings({...hub.getSettings(),networkEnabled:true,bindAddress:'127.0.0.1'});
  try{await waitFor(entered.promise);authority=await fs.readFile(authFile,'utf8');}finally{release.resolve();await update;restore();}
  const crashDir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-protection-bind-'));t.after(()=>fs.rm(crashDir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  await fs.mkdir(path.join(crashDir,'auth'));await fs.writeFile(path.join(crashDir,'auth','gateway.json'),authority);await fs.writeFile(path.join(crashDir,'harbor-settings.json'),oldSettings);
  const restarted=await reopen(t,crashDir);assert.equal(restarted.hub.getSettings().networkEnabled,true);assert.equal(restarted.hub.getSettings().bindAddress,'127.0.0.1');assert.equal(new URL(restarted.hub.endpoint).hostname,'127.0.0.1');await connect(restarted.hub.endpoint,null);await restarted.hub.close();
});

for(const enabled of [false,true])for(const loopbackOnly of [false,true])test(`independent protections survive restart: API key ${enabled}, loopback only ${loopbackOnly}`,async t=>{
  const {dir,hub,authentication}=await setup(t);await hub.patchSettings({bindAddress:'127.0.0.2'});
  const input={enabled,loopbackOnly};await hub.updateGatewayAuth(input);assert.equal(authentication.key(),OLD,'Omitting the key preserves its previous value');
  assert.equal(hub.getSettings().networkEnabled,!loopbackOnly);assert.equal(new URL(hub.endpoint).hostname,loopbackOnly?'127.0.0.1':'127.0.0.2');await connect(hub.endpoint,enabled?OLD:null);await hub.close();
  const restarted=await reopen(t,dir);assert.deepEqual(restarted.authentication.status(),{enabled,hasKey:true});assert.equal(restarted.hub.getSettings().networkEnabled,!loopbackOnly);assert.equal(new URL(restarted.hub.endpoint).hostname,loopbackOnly?'127.0.0.1':'127.0.0.2');
  assert.equal((await send(restarted.hub.endpoint)).status,enabled?401:200);await connect(restarted.hub.endpoint,enabled?OLD:null);await restarted.hub.close();
});

test('completed saves preserve offline settings edits and reject a malformed settings mirror on restart',async t=>{
  const {dir,hub,settingsFile,authFile}=await setup(t,{network:true});
  await hub.updateGatewayAuth({enabled:true,key:NEXT,loopbackOnly:true});await hub.patchSettings({requestTimeoutMs:65000});
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(authFile,'utf8')),'settings'),false,'A complete save retires the transaction authority');
  const saved=hub.getSettings();await hub.close();await fs.writeFile(settingsFile,JSON.stringify({...saved,mcpPath:'/offline-edited',searchLimit:9}));
  const restarted=await reopen(t,dir);assert.equal(new URL(restarted.hub.endpoint).pathname,'/offline-edited');assert.equal(restarted.hub.getSettings().searchLimit,9);assert.equal(restarted.hub.getSettings().requestTimeoutMs,65000);await connect(restarted.hub.endpoint,NEXT);await restarted.hub.close();
  await fs.writeFile(settingsFile,'{"not_valid_json":');const authentication=await createGatewayAuthentication({dataDir:dir});
  await assert.rejects(createHub({configPath:path.join(dir,'servers.json'),port:0,authentication}),SyntaxError);
});

test('postcommit journal-clear failure preserves committed protections and startup repairs the mirror before retiring recovery',async t=>{
  const {dir,hub,authentication,settingsFile,authFile}=await setup(t,{network:true}),stale=await fs.readFile(settingsFile,'utf8');let writes=0;
  const restore=interceptRename(t,async(rename,source,destination)=>{if(destination===authFile&&++writes===2)throw Error('Synthetic postcommit journal retirement failure');return rename(source,destination);});
  try{await hub.updateGatewayAuth({enabled:true,key:NEXT,loopbackOnly:true});}finally{restore();}
  assert.equal(authentication.key(),NEXT);assert.equal(authentication.available(),true);assert.equal(hub.getSettings().networkEnabled,false);assert.equal(new URL(hub.endpoint).hostname,'127.0.0.1');assert.equal((await send(hub.endpoint,{key:OLD})).status,401);await connect(hub.endpoint,NEXT);
  const pending=JSON.parse(await fs.readFile(authFile,'utf8'));assert.equal(pending.key,NEXT);assert.equal(pending.settings.networkEnabled,false);await hub.close();
  await fs.writeFile(settingsFile,stale);const restarted=await reopen(t,dir);
  assert.equal(new URL(restarted.hub.endpoint).hostname,'127.0.0.1');assert.equal(restarted.authentication.key(),NEXT);assert.equal(JSON.parse(await fs.readFile(settingsFile,'utf8')).networkEnabled,false);assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(authFile,'utf8')),'settings'),false);
  assert.equal((await send(restarted.hub.endpoint,{key:OLD})).status,401);await connect(restarted.hub.endpoint,NEXT);await restarted.hub.close();
});

test('key-only enablement and rotation remain available when saved FastMCP mode has no installed runtime',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-protection-no-runtime-')),savedEnv=Object.fromEntries(['HARBOR_TOOL_RUNTIME_ROOT','HARBOR_PORTABLE_ROOT'].map(key=>[key,process.env[key]]));
  let hub;t.after(async()=>{await hub?.close();for(const [key,value] of Object.entries(savedEnv))if(value===undefined)delete process.env[key];else process.env[key]=value;await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  delete process.env.HARBOR_TOOL_RUNTIME_ROOT;delete process.env.HARBOR_PORTABLE_ROOT;
  await fs.writeFile(path.join(dir,'harbor-settings.json'),JSON.stringify({...DEFAULT_SETTINGS,toolMode:'bm25'}));
  const authentication=await createGatewayAuthentication({dataDir:dir});hub=await createHub({configPath:path.join(dir,'servers.json'),port:0,authentication});
  assert.equal(hub.getSettings().toolMode,'bm25');await hub.updateGatewayAuth({enabled:true,key:OLD,loopbackOnly:true});assert.equal((await send(hub.endpoint)).status,401);const oldSession=await connect(hub.endpoint,OLD);
  await hub.updateGatewayAuth({enabled:true,key:NEXT,loopbackOnly:true});assert.equal((await send(hub.endpoint,{key:OLD})).status,401);assert.equal((await send(hub.endpoint,{key:NEXT,id:oldSession,body:listing})).status,404);await connect(hub.endpoint,NEXT);
  assert.equal(hub.getSettings().toolMode,'bm25');assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(path.join(dir,'auth','gateway.json'),'utf8')),'settings'),false);
});

test('FastMCP candidate listeners allow only their private catalog during a protection transition',{skip:!process.env.HARBOR_TOOL_RUNTIME_ROOT,timeout:180000},async t=>{
  const realRoot=path.resolve(process.env.HARBOR_TOOL_RUNTIME_ROOT),root=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor protection FastMCP ')),oldEnv=process.env.HARBOR_TOOL_RUNTIME_ROOT;
  for(const name of ['runtimes','packages'])await fs.symlink(path.join(realRoot,name),path.join(root,name),'junction');
  for(const name of ['support','data/workspace','data/temp','data/home'])await fs.mkdir(path.join(root,name),{recursive:true});
  await fs.symlink(path.join(realRoot,'support/python-site'),path.join(root,'support/python-site'),'junction');
  const tokenFile=path.join(root,'test-catalog-token'),source=await fs.readFile(new URL('../scripts/portable/fastmcp-gateway.py',import.meta.url),'utf8');
  await fs.writeFile(path.join(root,'support/fastmcp-gateway.py'),`import os\nfrom pathlib import Path\nPath(${JSON.stringify(tokenFile)}).write_text(os.environ.get("HARBOR_CATALOG_TOKEN", ""))\n`+source);
  process.env.HARBOR_TOOL_RUNTIME_ROOT=root;let ownedHub;
  t.after(async()=>{await ownedHub?.close();process.env.HARBOR_TOOL_RUNTIME_ROOT=oldEnv;for(const name of ['runtimes','packages','support/python-site'])await fs.unlink(path.join(root,name));await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const {hub,settingsFile}=await setup(t,{network:true,child:true});ownedHub=hub;const pid=hub.snapshot().servers[0].pid;
  for(const mode of ['bm25','regex','code','hybrid']){
    await hub.updateSettings({...hub.getSettings(),toolMode:mode,hybridModes:['bm25','regex','code']});
    const nextLoopback=!(!hub.getSettings().networkEnabled),hostname=nextLoopback?'127.0.0.1':'127.0.0.2';
    const endpoint=new URL(hub.endpoint);endpoint.hostname=hostname;
    const entered=deferred(),release=deferred();let held=false;
    const restore=interceptRename(t,async(rename,from,to)=>{if(to===settingsFile&&!held){held=true;entered.resolve();await release.promise;}return rename(from,to);});
    const update=hub.updateGatewayAuth({enabled:true,key:NEXT,loopbackOnly:nextLoopback});let token;
    try{
      // Hybrid prepares three real Python workers before the settings write.
      // Keep request-denial assertions unchanged; surface early failure directly.
      await waitFor(Promise.race([entered.promise,update.then(()=>{throw Error('Protection update completed without the expected settings interception');})]),45000);
      token=await fs.readFile(tokenFile,'utf8');assert(token.length>=32);
      await denied(endpoint.href,{key:NEXT});await denied(endpoint.href+'/_harbor_catalog',{key:NEXT});await denied(endpoint.href+'/_harbor_catalog',{key:'wrong_private_token'});await denied(endpoint.href,{key:token});
      const internal=await connect(endpoint.href+'/_harbor_catalog',token);assert.equal((await send(endpoint.href+'/_harbor_catalog',{key:token,id:internal,body:listing})).status,200);
    }finally{release.resolve();await update;restore();}
    assert.equal((await send(hub.endpoint,{key:token})).status,401);const id=await connect(hub.endpoint,NEXT);const tools=await send(hub.endpoint,{key:NEXT,id,body:listing});assert.equal(tools.status,200);assert(tools.text.includes(mode==='code'?'execute':'search_tools'),tools.text);assert.equal(hub.snapshot().servers[0].pid,pid);
    const echo=hub.snapshot().tools.find(tool=>tool.originalName==='echo');assert(echo);
    const search=await send(hub.endpoint,{key:NEXT,id,body:{jsonrpc:'2.0',id:3,method:'tools/call',params:mode==='code'?{name:'execute',arguments:{code:`return await call_tool(${JSON.stringify(echo.name)}, {"text":"candidate catalog echo"})`}}:{name:'search_tools',arguments:mode==='regex'?{pattern:'echo'}:{query:'echo text'}}}});
    assert.equal(search.status,200);assert(!search.text.includes('"isError":true'),search.text);assert(search.text.includes(mode==='code'?'candidate catalog echo':echo.name),search.text);
    if(mode!=='code'){const call=await send(hub.endpoint,{key:NEXT,id,body:{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'call_tool',arguments:{name:echo.name,arguments:{text:'candidate catalog echo'}}}}});assert.equal(call.status,200);assert(call.text.includes('candidate catalog echo'),call.text);assert(!call.text.includes('"isError":true'),call.text);}
  }
});
