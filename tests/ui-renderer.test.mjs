import {SEARCH_DEFAULTS} from '../src/core/delivery-options.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

async function openUI(t) {
  const server = createServer(async (req, res) => {
    try {
      const path = req.url === '/' ? 'index.html' : req.url.slice(1);
      if (!['index.html','styles.css','app.js','profiles.js','helpers.js','advisor.js','advisor-rules.js','measured-advice.js','delivery-settings.js','core/delivery-options.js','core/client-config.js'].includes(path)) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(await readFile(new URL('../src/' + (path.startsWith('core/') ? path : 'ui/'+path), import.meta.url)));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  // Close the browser before the fixture server: speculative HTTP connections
  // can otherwise make server.close() wait forever and hide test results.
  t.after(async () => {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  browser = await chromium.launch({ ...(process.platform === 'win32' ? { channel: 'msedge' } : {}), headless: true });
  const page = await browser.newPage({ viewport: { width:1200, height:800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    // Explicit IPC fixture, never included in production renderer.
    window.fixture = { endpoint:'http://127.0.0.1:37373/mcp',servers:[],tools:[],clients:[],logs:[],authentication:{enabled:false,hasKey:false}, settings:{port:37373,networkEnabled:false,bindAddress:'0.0.0.0',mcpPath:'/mcp',requestTimeoutMs:60000,toolTimeoutMs:120000,allowedOrigins:[]}, endpoints:{local:'http://127.0.0.1:37373/mcp',network:[],bindAddress:'127.0.0.1'} };
    window.calls = [];
    window.startupCalls=[];
    window.gatewayAuthCalls=[];window.connectionCopyCalls=[];let savedGatewayKey='',generatedKeys=0;
    const configs=(endpoint,key)=>({httpConfig:{mcpServers:{harbor:{url:endpoint,...(key?{headers:{Authorization:'Bearer '+key}}:{})}}},stdioConfig:{mcpServers:{harbor:{command:'node',args:['bridge.mjs',endpoint],...(key?{env:{HARBOR_API_KEY:key}}:{})}}}});
    window.harbor = {
      snapshot: async () => structuredClone(window.fixture),
      getGatewayAuth:async()=>({...structuredClone(window.fixture.authentication),loopbackOnly:!window.fixture.settings.networkEnabled}),
      generateGatewayKey:async()=>{window.gatewayAuthCalls.push(['generate']);return `generated-fixture-key-${++generatedKeys}`;},
      updateGatewayAuth:async options=>{window.gatewayAuthCalls.push(['update',structuredClone(options)]);if(options.key)savedGatewayKey=options.key;window.fixture.authentication={enabled:options.enabled,hasKey:!!savedGatewayKey};if(typeof options.loopbackOnly==='boolean')window.fixture.settings.networkEnabled=!options.loopbackOnly;window.fixture.endpoints={local:window.fixture.endpoint,network:window.fixture.settings.networkEnabled?[`http://192.168.1.20:${window.fixture.settings.port}${window.fixture.settings.mcpPath}`]:[],bindAddress:window.fixture.settings.networkEnabled?window.fixture.settings.bindAddress:'127.0.0.1'};return {...structuredClone(window.fixture.authentication),loopbackOnly:!window.fixture.settings.networkEnabled};},
      copyGatewayKey:async()=>{window.gatewayAuthCalls.push(['copy']);window.copied=savedGatewayKey;return true;},
      copyConnectionConfiguration:async options=>{window.connectionCopyCalls.push(structuredClone(options));const config=configs(options.endpoint,window.fixture.authentication.enabled?savedGatewayKey:'');window.copied=JSON.stringify(options.format==='http'?config.httpConfig:config.stdioConfig,null,2);return true;},
      setServerStartup:async(id,enabled)=>{
        window.startupCalls.push([id,enabled]);
        const server=window.fixture.servers.find(s=>s.id===id);if(!server)throw new Error('Unknown server');
        server.autoStart=enabled;if(!enabled)server.autoRestart=false;
        return structuredClone(server);
      },
      getSettings: async () => structuredClone(window.fixture.settings),
      updateSettings: async settings => {
        window.calls.push(['settings',structuredClone(settings)]);
        window.fixture.settings=structuredClone(settings);
        window.fixture.endpoint=`http://127.0.0.1:${settings.port}${settings.mcpPath}`;
        window.fixture.endpoints={local:window.fixture.endpoint,network:settings.networkEnabled?[`http://192.168.1.20:${settings.port}${settings.mcpPath}`]:[],bindAddress:settings.networkEnabled?settings.bindAddress:'127.0.0.1'};
        return structuredClone(settings);
      },
      connectionInfo: async () => ({ endpoint:window.fixture.endpoint,networkEndpoints:window.fixture.endpoints.network,bindAddress:window.fixture.endpoints.bindAddress,settings:structuredClone(window.fixture.settings),authentication:structuredClone(window.fixture.authentication),...configs(window.fixture.endpoint,window.fixture.authentication.enabled?'<YOUR_HARBOR_API_KEY>':''),configPath:'C:/test/config.json',settingsPath:'C:/test/harbor-settings.json',platform:'win32',serverName:'mcp-harbor',version:'0.2.0' }),
      saveServer: async config => { window.calls.push(['save',config]); window.fixture.servers = [...window.fixture.servers.filter(s=>s.id!==config.id),{...config,status:'stopped',toolCount:0}]; },
      startServer: async id => { window.calls.push(['start',id]); window.fixture.servers.find(s=>s.id===id).status='running'; },
      stopServer: async id => { window.calls.push(['stop',id]); window.fixture.servers.find(s=>s.id===id).status='stopped'; },
      restartServer: async id => { window.calls.push(['restart',id]); window.fixture.servers.find(s=>s.id===id).status='running'; },
      removeServer: async id => { window.calls.push(['remove',id]); window.fixture.servers = window.fixture.servers.filter(s=>s.id!==id); },
      copy: async text => { window.copied=text; },
      chooseDirectory: async () => 'C:/chosen repo',
      importConfig: async object => { window.calls.push(['import',object]); for(const [id,s] of Object.entries(object.mcpServers)) window.fixture.servers.push({...s,id,name:id,status:'stopped',toolCount:0}); }
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  return { page, errors };
}

test('maintenance controls refresh when only readiness or transition changes', {timeout:30000}, async t=>{
  const {page,errors}=await openUI(t);
  await page.waitForFunction(()=>document.querySelector('#gateway-status').textContent.includes('Gateway online'));
  await page.evaluate(()=>Object.assign(window.fixture,{
    maintenance:true,maintenanceReady:false,maintenanceTransition:'entering',
    maintenanceInfo:{busy:false,phase:'idle',message:'Ready',log:[],components:[{id:'fixture',name:'Fixture',repository:'',notes:'',updatable:true,canRestore:false}]}
  }));
  await page.getByRole('button',{name:'Maintenance',exact:true}).click();
  await page.getByRole('button',{name:'Stopping servers…',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Rebuild',exact:true}).isDisabled(),true);
  // Keep catalogs, maintenanceInfo and the pause flag identical: only the
  // completed drain changes. No navigation or action may force a redraw.
  await page.evaluate(()=>{window.fixture.maintenanceReady=true;window.fixture.maintenanceTransition=null;});
  await page.getByRole('button',{name:'Resume servers',exact:true}).waitFor({timeout:5000});
  assert.equal(await page.getByRole('button',{name:'Rebuild',exact:true}).isEnabled(),true);
  await page.evaluate(()=>{window.fixture.maintenanceReady=false;window.fixture.maintenanceTransition='entering';});
  await page.getByRole('button',{name:'Stopping servers…',exact:true}).waitFor({timeout:5000});
  await page.evaluate(()=>{window.fixture.maintenanceTransition=null;});
  await page.getByRole('button',{name:'Retry maintenance',exact:true}).waitFor({timeout:5000});
  assert.equal(await page.getByRole('button',{name:'Rebuild',exact:true}).isDisabled(),true);
  await page.evaluate(()=>{window.fixture.maintenanceReady=true;});
  await page.getByRole('button',{name:'Resume servers',exact:true}).waitFor({timeout:5000});
  assert.equal(await page.getByRole('button',{name:'Rebuild',exact:true}).isEnabled(),true);
  assert.deepEqual(errors,[]);
});

for(const action of ['Start selected','Keep selected running'])for(const remove of [true,false])test(`Advisor cross-tab ${action} invalidates ${remove?'same-launch removal and re-add':'launch change and restore'} without returning`,async t=>{
  const {page,errors}=await openUI(t);
  await page.evaluate(()=>{
    window.fixture.servers=['memory','filesystem'].map(id=>({id,name:id,transport:'stdio',command:'node',status:'stopped',autoStart:false,autoRestart:false}));
    window.originalFilesystem=structuredClone(window.fixture.servers[1]);
    const start=window.harbor.startServer;
    window.harbor.startServer=async id=>{if(id==='memory')await new Promise(resolve=>window.releaseMemory=resolve);await start(id);};
  });
  await page.getByRole('button',{name:'Advisor',exact:true}).click();
  for(const id of ['memory','filesystem'])await page.getByLabel(`Select ${id}`,{exact:true}).check();
  await page.getByRole('button',{name:action,exact:true}).click();
  await page.waitForFunction(()=>window.releaseMemory);
  // Retain the real detached panel only to observe completion, never remount it.
  await page.evaluate(()=>window.advisorRoot=document.querySelector('.advisor'));
  await page.getByRole('button',{name:'Children Servers Statuses',exact:true}).click();
  const filesystem=page.locator('[data-server-id="filesystem"]');
  if(remove){
    await filesystem.getByRole('button',{name:'Remove',exact:true}).click();
    await page.getByRole('button',{name:'Remove server',exact:true}).click();
    await filesystem.waitFor({state:'detached'});
    await page.evaluate(()=>window.fixture.servers.push(structuredClone(window.originalFilesystem)));
    await filesystem.waitFor();
  }else{
    await page.evaluate(()=>window.fixture.servers.find(s=>s.id==='filesystem').command='replacement-node');
    await filesystem.locator('.server-command').getByText('replacement-node',{exact:true}).waitFor();
    await page.evaluate(()=>window.fixture.servers.find(s=>s.id==='filesystem').command='node');
    await filesystem.locator('.server-command').getByText('node',{exact:true}).waitFor();
  }
  assert.equal(await page.locator('.advisor').count(),0);
  await page.evaluate(()=>window.releaseMemory());
  await page.waitForFunction(()=>window.advisorRoot.querySelector('#advisor-result').textContent.includes('Batch complete'));
  assert.equal(await page.locator('#page-title').textContent(),'Children Servers Statuses');
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c[0]==='start'||c[0]==='save').map(c=>[c[0],typeof c[1]==='string'?c[1]:c[1].id])),action==='Start selected'?[['start','memory']]:[['save','memory'],['start','memory']]);
  assert.deepEqual(await page.evaluate(()=>window.fixture.servers.find(s=>s.id==='filesystem')),await page.evaluate(remove=>({...window.originalFilesystem,...(!remove?{autoStart:true}:{})}),remove));
  assert.deepEqual(errors,[]);
});

test('Advisor cross-tab evidence invalidation bypasses an unchanged Tools render signature without disturbing focus',async t=>{
  const {page,errors}=await openUI(t);
  await page.evaluate(()=>{
    window.fixture.servers=[{id:'brave-search',name:'brave-search',transport:'http',url:'https://original.test/mcp',status:'running'}];
    const snapshot=window.harbor.snapshot;
    window.harbor.snapshot=async()=>{const next=await snapshot();window.lastSnapshotServer=next.servers[0];return next;};
  });
  await page.getByRole('button',{name:'Advisor',exact:true}).click();
  await page.getByLabel('Select brave-search',{exact:true}).check();
  await page.evaluate(()=>window.advisorTask=document.querySelector('#advisor-task'));
  await page.getByRole('button',{name:'Tools',exact:true}).click();
  await page.getByRole('searchbox').fill('draft search');
  await page.evaluate(()=>{
    window.toolsResult=document.querySelector('#content .results').firstChild;
    window.toolsSearch=document.activeElement;
    Object.assign(window.fixture.servers[0],{status:'stopped',url:'https://changed.test/mcp'});
  });
  await page.waitForFunction(()=>window.lastSnapshotServer.url==='https://changed.test/mcp');
  await page.evaluate(()=>window.fixture.servers[0].url='https://original.test/mcp');
  await page.waitForFunction(()=>window.lastSnapshotServer.url==='https://original.test/mcp'&&window.lastSnapshotServer.status==='stopped');
  assert.equal(await page.evaluate(()=>document.activeElement===window.toolsSearch&&window.toolsSearch.value==='draft search'),true);
  assert.equal(await page.evaluate(()=>document.querySelector('#content .results').firstChild===window.toolsResult),true,'server-only snapshots must not rerender Tools');
  await page.getByRole('button',{name:'Advisor',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.querySelector('#advisor-task')===window.advisorTask),true,'navigation keeps the keyed Advisor controls');
  assert.equal(await page.getByLabel('Select brave-search',{exact:true}).isDisabled(),false,'saved selection can always be unchecked');
  assert.match(await page.locator('[data-advisor-id="brave-search"]').textContent(),/API key.*not been verified/);
  assert.deepEqual(await page.evaluate(()=>window.calls),[]);
  assert.deepEqual(errors,[]);
});

for(const action of ['Start selected','Keep selected running'])test(`Advisor ${action} excludes a removed and re-added unchecked pending entry`,async t=>{
  const {page,errors}=await openUI(t);
  await page.evaluate(()=>{
    window.fixture.servers=['memory','filesystem'].map(id=>({id,name:id,transport:'stdio',command:'node',status:'stopped',autoStart:false,autoRestart:false}));
    const start=window.harbor.startServer;
    window.harbor.startServer=async id=>{if(id==='memory')await new Promise(resolve=>window.releaseMemory=resolve);await start(id);};
  });
  await page.getByRole('button',{name:'Advisor',exact:true}).click();
  for(const id of ['memory','filesystem'])await page.getByLabel(`Select ${id}`,{exact:true}).check();
  await page.getByRole('button',{name:action,exact:true}).click();
  await page.waitForFunction(()=>window.releaseMemory);
  await page.getByRole('button',{name:'Children Servers Statuses',exact:true}).click();
  await page.locator('[data-server-id="filesystem"]').getByRole('button',{name:'Remove',exact:true}).click();
  await page.getByRole('button',{name:'Remove server',exact:true}).click();
  await page.locator('[data-server-id="filesystem"]').waitFor({state:'detached'});
  await page.getByRole('button',{name:'Advisor',exact:true}).click();
  await page.locator('[data-advisor-id="filesystem"]').waitFor({state:'detached'});
  await page.evaluate(()=>window.fixture.servers.push({id:'filesystem',name:'replacement',transport:'stdio',command:'replacement-node',status:'stopped',autoStart:false,autoRestart:false}));
  const replacement=page.getByLabel('Select replacement',{exact:true});await replacement.waitFor();
  assert.equal(await replacement.isChecked(),false);
  await page.evaluate(()=>window.releaseMemory());
  await page.waitForFunction(()=>document.querySelector('#advisor-result').textContent.includes('Batch complete'));
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c[0]==='start'||c[0]==='save').map(c=>[c[0],typeof c[1]==='string'?c[1]:c[1].id])),action==='Start selected'?[['start','memory']]:[['save','memory'],['start','memory']]);
  assert.equal(await page.evaluate(()=>window.fixture.servers.find(s=>s.id==='filesystem').status),'stopped');
  assert.deepEqual(errors,[]);
});

for(const action of ['Start selected','Keep selected running'])for(const restore of [false,true])test(`Advisor ${action} invalidates a pending launch change${restore?' even if restored':''}`,async t=>{
  const {page,errors}=await openUI(t);
  await page.evaluate(()=>{
    window.fixture.servers=['memory','filesystem'].map(id=>({id,name:id,transport:'stdio',command:'node',status:'stopped',autoStart:false,autoRestart:false}));
    const start=window.harbor.startServer;
    window.harbor.startServer=async id=>{if(id==='memory')await new Promise(resolve=>window.releaseMemory=resolve);await start(id);};
  });
  await page.getByRole('button',{name:'Advisor',exact:true}).click();
  for(const id of ['memory','filesystem'])await page.getByLabel(`Select ${id}`,{exact:true}).check();
  await page.getByRole('button',{name:action,exact:true}).click();await page.waitForFunction(()=>window.releaseMemory);
  await page.evaluate(()=>Object.assign(window.fixture.servers.find(s=>s.id==='filesystem'),{command:'replacement-node',toolCount:11}));
  await page.locator('[data-advisor-id="filesystem"]').getByText('stopped · 11 tools',{exact:false}).waitFor();
  if(restore){
    await page.evaluate(()=>Object.assign(window.fixture.servers.find(s=>s.id==='filesystem'),{command:'node',toolCount:12}));
    await page.locator('[data-advisor-id="filesystem"]').getByText('stopped · 12 tools',{exact:false}).waitFor();
  }
  await page.evaluate(()=>window.releaseMemory());
  await page.waitForFunction(()=>document.querySelector('#advisor-result').textContent.includes('Batch complete'));
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c[0]==='start'||c[0]==='save').map(c=>[c[0],typeof c[1]==='string'?c[1]:c[1].id])),action==='Start selected'?[['start','memory']]:[['save','memory'],['start','memory']]);
  assert.match(await page.locator('[data-advisor-id="filesystem"] .advisor-outcome').textContent(),/Skipped:.*launch.*changed/i);
  assert.deepEqual(errors,[]);
});

for(const [field,value] of Object.entries({transport:'sse',runtime:'wsl',command:'replacement-node',args:['replacement.mjs'],cwd:'C:/replacement',env:{TOKEN:'changed'},url:'https://changed.test/mcp',distro:'Other',managedProcesses:[{command:'replacement-node',args:[],env:{},runtime:'native'}]}))test(`Advisor management rejects a concurrent ${field} launch change after saving`,async t=>{
  const {page,errors}=await openUI(t);
  const config={id:'brave-search',name:'brave-search',transport:'http',runtime:'native',command:'node',args:['original.mjs'],cwd:'C:/original',env:{TOKEN:'original'},url:'https://original.test/mcp',distro:'Ubuntu',managedProcesses:[],autoStart:false,autoRestart:false};
  await page.evaluate(config=>{
    window.fixture.servers=[{...config,status:'running',toolCount:1}];
    const save=window.harbor.saveServer;
    window.harbor.saveServer=async payload=>{await save(payload);await new Promise(resolve=>window.releaseSave=resolve);};
  },config);
  await page.getByRole('button',{name:'Advisor',exact:true}).click();await page.getByLabel('Select brave-search',{exact:true}).check();
  await page.getByRole('button',{name:'Keep selected running',exact:true}).click();await page.waitForFunction(()=>window.releaseSave);
  await page.evaluate(({field,value})=>{window.fixture.servers[0][field]=value;window.releaseSave();},{field,value});
  await page.waitForFunction(()=>document.querySelector('#advisor-result').textContent.includes('Batch complete'));
  assert.deepEqual(await page.evaluate(()=>window.calls),[['save',{...config,autoStart:true,autoRestart:true}]],'a verified flag write cannot authorize starting a different launch');
  assert.equal(await page.evaluate(()=>window.fixture.servers[0].status),'stopped');
  assert.equal(await page.getByLabel('Select brave-search',{exact:true}).isDisabled(),false);
  assert.match(await page.locator('[data-advisor-id="brave-search"] .advisor-outcome').textContent(),/launch configuration changed/i);
  assert.doesNotMatch(await page.locator('[data-advisor-id="brave-search"] .advisor-outcome').textContent(),/Verified managed/);
  assert.deepEqual(errors,[]);
});

for(const remove of [false,true])for(const fail of [false,true])test(`Advisor clears historical ${fail?'failure':'success'} on ${remove?'removal and same-ID re-add':'launch replacement'}`,async t=>{
  const {page,errors}=await openUI(t);
  await page.evaluate(fail=>{
    window.fixture.servers=[{id:'memory',name:'memory',transport:'stdio',command:'node',status:'stopped'}];
    const start=window.harbor.startServer;
    window.harbor.startServer=async id=>{await new Promise(resolve=>window.releaseStart=resolve);if(fail)throw new Error('Original launch failed');await start(id);};
  },fail);
  await page.getByRole('button',{name:'Advisor',exact:true}).click();await page.getByLabel('Select memory',{exact:true}).check();
  await page.getByRole('button',{name:'Start selected',exact:true}).click();await page.waitForFunction(()=>window.releaseStart);
  await page.evaluate(()=>window.releaseStart());
  await page.waitForFunction(()=>document.querySelector('#advisor-result').textContent.includes('Batch complete'));
  assert.match(await page.locator('[data-advisor-id="memory"] .advisor-outcome').textContent(),fail?/Original launch failed/:/Verified running/);
  if(remove){
    await page.evaluate(()=>window.fixture.servers=[]);
    await page.locator('[data-advisor-id="memory"]').waitFor({state:'detached'});
  }
  await page.evaluate(()=>window.fixture.servers=[{id:'memory',name:'replacement',transport:'stdio',command:'replacement-node',status:'running'}]);
  await page.getByLabel('Select replacement',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-advisor-id="memory"] .advisor-outcome').textContent(),'','historical results belong only to the original launch');
  assert.deepEqual(errors,[]);
});

for(const fail of [false,true])test(`Advisor does not attach a delayed ${fail?'failure':'success'} to a replacement launch`,async t=>{
  const {page,errors}=await openUI(t);
  await page.evaluate(fail=>{
    window.fixture.servers=[{id:'memory',name:'memory',transport:'stdio',command:'node',status:'stopped'}];
    const start=window.harbor.startServer;
    window.harbor.startServer=async id=>{await start(id);await new Promise(resolve=>window.releaseStart=resolve);if(fail)throw new Error('Original launch failed');};
  },fail);
  await page.getByRole('button',{name:'Advisor',exact:true}).click();await page.getByLabel('Select memory',{exact:true}).check();
  await page.getByRole('button',{name:'Start selected',exact:true}).click();await page.waitForFunction(()=>window.releaseStart);
  await page.evaluate(()=>window.fixture.servers=[{id:'memory',name:'replacement',transport:'stdio',command:'replacement-node',status:'running'}]);
  await page.getByLabel('Select replacement',{exact:true}).waitFor();
  await page.evaluate(()=>window.releaseStart());
  await page.waitForFunction(()=>document.querySelector('#advisor-result').textContent.includes('Batch complete'));
  assert.doesNotMatch(await page.locator('[data-advisor-id="memory"] .advisor-outcome').textContent(),/Verified running|Original launch failed/,'an old in-flight completion is not evidence about the replacement');
  assert.deepEqual(await page.evaluate(()=>window.calls),[['start','memory']]);assert.deepEqual(errors,[]);
});

test('Advisor does not resurrect outcomes when a removed in-flight action settles',async t=>{
  const {page,errors}=await openUI(t);
  await page.evaluate(()=>{
    window.fixture.servers=[{id:'memory',name:'memory',command:'node',status:'stopped'}];
    window.harbor.startServer=async()=>{await new Promise(resolve=>window.releaseStart=resolve);throw new Error('Original launch failed');};
  });
  await page.getByRole('button',{name:'Advisor',exact:true}).click();await page.getByLabel('Select memory',{exact:true}).check();
  await page.getByRole('button',{name:'Start selected',exact:true}).click();await page.waitForFunction(()=>window.releaseStart);
  await page.evaluate(()=>window.fixture.servers=[]);await page.locator('[data-advisor-id="memory"]').waitFor({state:'detached'});
  await page.evaluate(()=>window.releaseStart());
  await page.waitForFunction(()=>document.querySelector('#advisor-result').textContent.includes('Batch complete'));
  await page.evaluate(()=>window.fixture.servers=[{id:'memory',name:'replacement',command:'replacement-node',status:'running'}]);
  await page.getByLabel('Select replacement',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-advisor-id="memory"] .advisor-outcome').textContent(),'');assert.deepEqual(errors,[]);
});

test('Advisor Use recommended saves a stable minimal startup selection',async t=>{
  const {page}=await openUI(t);
  await page.evaluate(()=>window.fixture.servers=['filesystem','desktop-commander'].map(id=>({id,name:id,status:'stopped'})));
  await page.getByRole('button',{name:'Advisor',exact:true}).click();await page.getByLabel('Task category').selectOption('files');
  await page.getByLabel('Select desktop-commander',{exact:true}).check();
  const use=page.getByRole('button',{name:'Use recommended selection',exact:true});
  await use.click();assert.equal(await page.getByLabel('Select filesystem',{exact:true}).isChecked(),true);
  assert.equal(await page.getByLabel('Select desktop-commander',{exact:true}).isChecked(),false);
  await use.click();assert.equal(await page.getByLabel('Select filesystem',{exact:true}).isChecked(),true);
  assert.deepEqual(await page.evaluate(()=>window.calls),[]);
});

test('Advisor post-start verification waits out stale polls and does not claim success when the fresh read fails',async t=>{
  const {page,errors}=await openUI(t);
  await page.evaluate(()=>window.fixture.servers=[{id:'memory',name:'memory',status:'stopped'}]);
  await page.getByRole('button',{name:'Advisor',exact:true}).click();await page.getByLabel('Select memory',{exact:true}).check();
  await page.evaluate(()=>{
    let delayed=false;
    window.harbor.snapshot=async()=>{const snap=structuredClone(window.fixture);if(!delayed){delayed=true;window.pollStarted=true;await new Promise(resolve=>window.releasePoll=resolve);}return snap;};
    window.harbor.startServer=async id=>{window.calls.push(['start',id]);window.fixture.servers[0].status='running';window.harbor.snapshot=async()=>{throw new Error('Fresh read failed');};};
  });
  await page.waitForFunction(()=>window.pollStarted);
  await page.getByRole('button',{name:'Start selected',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.calls),[]);
  await page.evaluate(()=>window.releasePoll());
  await page.getByText('Could not start or verify: Fresh read failed',{exact:true}).waitFor();
  assert.doesNotMatch(await page.locator('[data-advisor-id="memory"]').textContent(),/Verified running/);
  assert.deepEqual(await page.evaluate(()=>window.calls),[['start','memory']]);assert.deepEqual(errors,[]);
});

test('Advisor management refuses unverified saves and retains persisted flags when startup fails',async t=>{
  const {page}=await openUI(t);
  await page.evaluate(()=>{
    window.fixture.servers=['filesystem','memory'].map(id=>({id,name:id,status:'stopped',command:'node',transport:'stdio',autoStart:false,autoRestart:false}));
    const save=window.harbor.saveServer;
    window.harbor.saveServer=async config=>{if(config.id==='filesystem'){window.calls.push(['save-unpersisted',config.id]);return;}await save(config);};
    window.harbor.startServer=async id=>{window.calls.push(['start',id]);throw new Error('Missing executable');};
  });
  await page.getByRole('button',{name:'Advisor',exact:true}).click();
  for(const id of ['filesystem','memory'])await page.getByLabel(`Select ${id}`,{exact:true}).check();
  await page.getByRole('button',{name:'Keep selected running',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#advisor-result').textContent.includes('Batch complete'));
  assert.match(await page.locator('[data-advisor-id="filesystem"]').textContent(),/Automatic settings were not verified/);
  const memory=await page.locator('[data-advisor-id="memory"]').textContent();
  assert.match(memory,/Autostart on · Autorestart on/);assert.match(memory,/Missing executable/);assert.doesNotMatch(memory,/Verified managed/);
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c[0]==='start')),[['start','memory']]);
});

test('Advisor never retains a running success claim after polling observes a stop',async t=>{
  const {page}=await openUI(t);
  await page.evaluate(()=>window.fixture.servers=[{id:'memory',name:'memory',status:'stopped'}]);
  await page.getByRole('button',{name:'Advisor',exact:true}).click();await page.getByLabel('Select memory',{exact:true}).check();
  await page.getByRole('button',{name:'Start selected',exact:true}).click();
  await page.getByText('Verified running (MCP connection only).',{exact:true}).waitFor();
  await page.evaluate(()=>window.fixture.servers[0].status='stopped');
  await page.getByText('stopped · 0 tools',{exact:false}).waitFor();
  assert.doesNotMatch(await page.locator('[data-advisor-id="memory"] .advisor-outcome').textContent(),/Verified running/);
});

test('Advisor remembers observed successful startup only for unchanged launch configuration and rejects stale selections at apply',async t=>{
  const {page}=await openUI(t);
  await page.evaluate(()=>{window.fixture.servers=[{id:'brave-search',name:'brave-search',transport:'http',url:'https://example.test/mcp',status:'running',toolCount:1,autoStart:false,autoRestart:false}];});
  await page.getByRole('button',{name:'Advisor',exact:true}).click();await page.locator('[data-advisor-id="brave-search"]').waitFor();
  await page.getByLabel('Select brave-search',{exact:true}).check();
  await page.evaluate(()=>window.fixture.servers[0].status='stopped');
  await page.getByText('stopped · 1 tools',{exact:false}).waitFor();
  assert.equal(await page.getByLabel('Select brave-search',{exact:true}).isDisabled(),false,'prior successful runtime allows same launch to restart');
  await page.getByRole('button',{name:'Start selected',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#advisor-result').textContent.includes('Batch complete'));
  assert.deepEqual(await page.evaluate(()=>window.calls),[['start','brave-search']]);
  // Change config between the displayed poll and explicit action: fresh preflight must block it.
  await page.evaluate(()=>{window.calls=[];Object.assign(window.fixture.servers[0],{status:'stopped',url:'https://changed.test/mcp'});});
  await page.getByRole('button',{name:'Keep selected running',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#advisor-result').textContent.includes('Batch complete'));
  assert.deepEqual(await page.evaluate(()=>window.calls),[]);
  assert.equal(await page.getByLabel('Select brave-search',{exact:true}).isDisabled(),false);
  assert.match(await page.locator('[data-advisor-id="brave-search"]').textContent(),/Skipped:.*API key/s);
});

test('Advisor Keep selected running persists only selected eligible full configs and verifies flags before reporting management',async t=>{
  const {page,errors}=await openUI(t);
  const config={id:'filesystem',name:'filesystem',command:'node',args:['a path.mjs'],cwd:'C:/test workspace',env:{LITERAL:'value'},runtime:'native',transport:'stdio',autoStart:false,autoRestart:false};
  await page.evaluate(config=>{window.fixture.servers=[{...config,status:'stopped',toolCount:0},{id:'serena',name:'serena',command:'node',transport:'stdio',status:'running',toolCount:7,autoStart:true,autoRestart:true},{id:'brave-search',name:'brave-search',status:'stopped'},{id:'other',name:'other',status:'running',autoStart:false,autoRestart:false}];},config);
  await page.getByRole('button',{name:'Advisor',exact:true}).click();await page.locator('[data-advisor-id="other"]').waitFor();
  assert.match(await page.locator('[data-advisor-id="serena"]').textContent(),/Autostart on · Autorestart on/);
  await page.getByLabel('Select filesystem',{exact:true}).check();await page.getByLabel('Select serena',{exact:true}).check();
  assert.deepEqual(await page.evaluate(()=>window.calls),[]);
  assert.equal(await page.getByRole('button',{name:'Keep selected running',exact:true}).count(),1);
  assert.match(await page.locator('.advisor').textContent(),/saving.*reconnect/i);
  await page.getByRole('button',{name:'Keep selected running',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#advisor-result')?.textContent.includes('Batch complete'));
  assert.deepEqual(await page.evaluate(()=>window.calls),[['save',{...config,autoStart:true,autoRestart:true}],['start','filesystem']]);
  assert.match(await page.locator('[data-advisor-id="filesystem"]').textContent(),/Verified managed and running/);
  assert.match(await page.locator('[data-advisor-id="serena"]').textContent(),/Verified managed and running/);
  assert.equal(await page.evaluate(()=>window.fixture.servers.find(s=>s.id==='other').autoStart),false);
  assert.deepEqual(errors,[]);
});

test('Advisor Start selected starts only eligible checked servers, reports each failure and verifies actual status', async t=>{
  const {page,errors}=await openUI(t);
  await page.evaluate(()=>{
    window.fixture.servers=['filesystem','memory','sequential-thinking','custom','serena','brave-search'].map(id=>({id,name:id,transport:'stdio',command:'node',status:id==='serena'?'running':'stopped',toolCount:0,autoStart:false,autoRestart:false}));
    window.harbor.startServer=async id=>{window.calls.push(['start',id]);if(id==='memory')throw new Error('<img src=x> launch failed');if(id!=='custom')window.fixture.servers.find(s=>s.id===id).status='running';};
  });
  await page.getByRole('button',{name:'Advisor',exact:true}).click();await page.locator('[data-advisor-id="brave-search"]').waitFor();
  for(const id of ['filesystem','memory','custom','serena'])await page.getByLabel(`Select ${id}`,{exact:true}).check();
  assert.equal(await page.getByRole('button',{name:'Start selected',exact:true}).count(),1);
  await page.getByRole('button',{name:'Start selected',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#advisor-result')?.textContent.includes('Batch complete'));
  assert.deepEqual(await page.evaluate(()=>window.calls),[['start','filesystem'],['start','memory'],['start','custom']]);
  assert.match(await page.locator('[data-advisor-id="filesystem"]').textContent(),/Verified running/);
  assert.match(await page.locator('[data-advisor-id="memory"]').textContent(),/launch failed/);
  assert.equal(await page.locator('[data-advisor-id="memory"] img').count(),0);
  const startBox=await page.getByRole('button',{name:'Start selected',exact:true}).boundingBox();
  const manageBox=await page.getByRole('button',{name:'Keep selected running',exact:true}).boundingBox();
  assert.ok(manageBox.x>=startBox.x+startBox.width+8,'separate one-shot and persistent actions visually');
  assert.match(await page.locator('[data-advisor-id="custom"]').textContent(),/not running.*stopped/i);
  assert.deepEqual(await page.evaluate(()=>window.fixture.servers.filter(s=>s.autoStart).map(s=>s.id)),['filesystem','memory','custom','serena']);
  assert.equal(await page.evaluate(()=>window.fixture.servers.every(s=>s.autoRestart===false)),true);
  assert.deepEqual(errors,[]);
});

test('Advisor reflects live readiness and preserves saved choices through polling, offline filtering and navigation', async t=>{
  const {page,errors}=await openUI(t);
  await page.evaluate(()=>{window.fixture.servers=['serena','desktop-commander','brave-search','exa','memory','filesystem','playwright','custom'].map(id=>({id,name:id,transport:'stdio',command:'node',status:id==='desktop-commander'?'running':'stopped',toolCount:id==='desktop-commander'?8:0}));});
  await page.getByRole('button',{name:'Advisor',exact:true}).click();
  await page.locator('[data-advisor-id="custom"]').waitFor();
  assert.equal(await page.getByLabel('Select brave-search',{exact:true}).isDisabled(),true);
  assert.match(await page.locator('[data-advisor-id="brave-search"]').textContent(),/Configure.*start individually/);
  await page.locator('[data-advisor-id="brave-search"]').getByRole('button',{name:'Configure',exact:true}).click();
  await page.getByRole('heading',{name:'Edit server',exact:true}).waitFor();
  await page.getByRole('button',{name:'Close server editor',exact:true}).click();
  await page.getByLabel('Task category').selectOption('files');
  assert.match(await page.locator('[data-advisor-id="filesystem"]').textContent(),/Optional.*desktop-commander \(running\)/s);
  assert.match(await page.locator('[data-advisor-id="desktop-commander"]').textContent(),/running · 8 tools/);
  const choice=page.getByLabel('Select filesystem',{exact:true});await choice.check();await choice.focus();
  await page.evaluate(()=>{window.fixture.servers.find(s=>s.id==='desktop-commander').toolCount=9;});
  await page.getByText('running · 9 tools',{exact:false}).waitFor();
  assert.equal(await choice.evaluate(el=>el===document.activeElement),true);assert.equal(await choice.isChecked(),true);
  await page.getByLabel('Task category').selectOption('research');
  await page.getByLabel('Internet available for this task',{exact:true}).uncheck();
  assert.equal(await page.getByLabel('Select exa',{exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Use recommended selection',exact:true}).click();
  assert.equal(await page.getByLabel('Select exa',{exact:true}).isChecked(),false);
  assert.match(await page.locator('.advisor').textContent(),/not a.*sandbox/i);
  await page.getByRole('button',{name:'Tools',exact:true}).click();await page.getByRole('button',{name:'Advisor',exact:true}).click();
  assert.equal(await page.getByLabel('Internet available for this task',{exact:true}).isChecked(),false);
  assert.equal(await page.locator('#content').evaluate(el=>el.scrollWidth<=el.clientWidth&&el.scrollHeight>el.clientHeight),true);
  await page.getByLabel('Select custom',{exact:true}).scrollIntoViewIfNeeded();
  const box=await page.getByLabel('Select custom',{exact:true}).boundingBox();assert.ok(box.y>=0&&box.y+box.height<=800);
  if(process.env.HARBOR_ADVISOR_SCREENSHOT){await page.locator('#content').evaluate(el=>el.scrollTop=0);await page.screenshot({path:process.env.HARBOR_ADVISOR_SCREENSHOT});}
  assert.deepEqual(await page.evaluate(()=>window.calls),[]);assert.deepEqual(errors,[]);
});

test('Advisor recommendation categories preserve preferences until the user explicitly applies a selection', async t=>{
  const {page,errors}=await openUI(t);
  await page.evaluate(()=>{window.fixture.servers=['serena','filesystem','sequential-thinking','exa'].map(id=>({id,name:id,command:'node',transport:'stdio',status:'stopped',toolCount:0,autoStart:false}));});
  assert.equal(await page.getByRole('button',{name:'Advisor',exact:true}).count(),1);
  await page.getByRole('button',{name:'Advisor',exact:true}).click();
  const task=page.getByLabel('Task category',{exact:true});
  assert.deepEqual(await task.locator('option').allTextContents(),['Research','Coding','Files / documents','Browser testing','Debugging','Planning','Offline / local']);
  await page.locator('[data-advisor-id="serena"]').waitFor();
  await task.selectOption('coding');
  assert.match(await page.locator('[data-advisor-id="serena"]').textContent(),/Recommended.*Semantic code/s);
  await page.getByRole('button',{name:'Use recommended selection',exact:true}).click();
  assert.equal(await page.getByLabel('Select serena',{exact:true}).isChecked(),true);
  assert.equal(await page.getByLabel('Select exa',{exact:true}).isChecked(),false);
  await task.selectOption('planning');
  assert.match(await page.locator('[data-advisor-id="sequential-thinking"]').textContent(),/Recommended.*not a separate model/s);
  assert.equal(await page.getByLabel('Select serena',{exact:true}).isChecked(),true);
  assert.deepEqual(await page.evaluate(()=>window.calls),[]);
  assert.deepEqual(await page.evaluate(()=>window.startupCalls),[['serena',true]]);
  assert.deepEqual(errors,[]);
});

test('Advisor reflects saved startup settings and restores a checkbox when saving fails',async t=>{
  const {page,errors}=await openUI(t);
  await page.evaluate(()=>{
    window.fixture.servers=[{id:'memory',name:'memory',status:'stopped',autoStart:true,autoRestart:true}];
    const save=window.harbor.setServerStartup;
    window.harbor.setServerStartup=async(id,enabled)=>{if(window.rejectStartup)throw new Error('Disk write failed');return save(id,enabled);};
  });
  await page.getByRole('button',{name:'Advisor',exact:true}).click();
  const check=page.getByLabel('Select memory',{exact:true});await check.waitFor();assert.equal(await check.isChecked(),true);
  await check.uncheck();await page.getByText('Saved: automatic startup and restart are off.',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>[window.fixture.servers[0].autoStart,window.fixture.servers[0].autoRestart]),[false,false]);
  await page.evaluate(()=>window.rejectStartup=true);await check.click();
  await page.getByText('Could not save startup preference: Disk write failed',{exact:true}).waitFor();
  assert.equal(await check.isChecked(),false);
  await page.evaluate(()=>window.fixture.servers[0].autoStart=true);
  await page.waitForFunction(()=>document.querySelector('[aria-label="Select memory"]').checked);
  assert.deepEqual(errors,[]);
});

test('HTTP ownership JSON editor validates, persists, and renders owned Linux PIDs', async t=>{
 const {page,errors}=await openUI(t);
 await page.getByRole('button',{name:'Add server',exact:true}).click();
 await page.getByLabel('Server name',{exact:true}).fill('Owned HTTP');await page.getByLabel('Server ID',{exact:true}).fill('owned');
 await page.getByLabel('Transport',{exact:true}).selectOption('http');await page.getByLabel('Server URL',{exact:true}).fill('http://127.0.0.1:4401/mcp');
 const editor=page.getByLabel('Managed processes (JSON array)',{exact:true});
 assert.equal(await editor.count(),1,'HTTP configure exposes labelled ownership editor');
 await editor.fill('[{"command":"node","env":{"BAD-NAME":"x"}}]');await page.getByRole('button',{name:'Save server',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.calls),[]);assert.match(await page.locator('#form-error').textContent(),/managed processes/i);
 const specs=[{command:'/usr/bin/node',args:['dist/index.js'],cwd:'/home/a b',env:{A:'$(literal)'},runtime:'wsl',distro:'Ubuntu'},{command:'/usr/bin/node',args:['plugin.js'],env:{},runtime:'wsl',distro:'Ubuntu'}];
 await editor.fill(JSON.stringify(specs));if(process.env.HARBOR_UI_SCREENSHOT)await page.screenshot({path:process.env.HARBOR_UI_SCREENSHOT});await page.getByRole('button',{name:'Save server',exact:true}).click();await page.locator('#server-dialog').waitFor({state:'hidden'});
 assert.deepEqual((await page.evaluate(()=>window.calls))[0][1].managedProcesses,specs);
 await page.locator('[data-server-id="owned"]').getByRole('button',{name:'Configure',exact:true}).click();assert.deepEqual(JSON.parse(await editor.inputValue()),specs);
 await page.getByRole('button',{name:'Close server editor',exact:true}).click();
 await page.evaluate(()=>{Object.assign(window.fixture.servers[0],{status:'running',ownership:'managed',processes:[{runtime:'wsl',pid:123,supervisorPid:121,launcherPid:456,owned:true},{runtime:'wsl',pid:124,supervisorPid:122,launcherPid:457,owned:true}]});});
 await page.getByText('Harbor-owned processes',{exact:true}).waitFor();await page.getByText('WSL PID 123 · launcher 456',{exact:true}).waitFor();await page.getByText('WSL PID 124 · launcher 457',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);
});

test('external HTTP removal explains connection-only semantics and does not retain hidden launch drafts', async t=>{
 const {page}=await openUI(t);
 await page.evaluate(()=>{window.fixture.servers=[{id:'external',name:'External HTTP',transport:'http',url:'http://localhost/mcp',managedProcesses:[],status:'running',toolCount:0,ownership:'external'}];});
 const card=page.locator('[data-server-id="external"]');await card.getByText('Externally managed · connection only',{exact:true}).waitFor();
 await card.getByRole('button',{name:'Remove',exact:true}).click();
 assert.match(await page.locator('#confirm-description').textContent(),/does not stop.*external process/i);
 assert.doesNotMatch(await page.locator('#confirm-description').textContent(),/stops its process/i);
});

test('gateway authentication generates a draft, applies explicitly, and copies only the saved key',async t=>{
  const {page,errors}=await openUI(t);
  await page.getByRole('button',{name:'This Server',exact:true}).click();
  const key=page.getByLabel('Gateway API key',{exact:true});
  assert.equal(await key.getAttribute('type'),'password');
  assert.equal(await key.inputValue(),'');
  assert.equal(await page.getByRole('button',{name:'Copy key',exact:true}).isDisabled(),true);
  await page.getByLabel('Use API key',{exact:true}).check();
  await page.getByRole('button',{name:'Apply protections',exact:true}).click();
  assert.match(await page.locator('#gateway-auth-error').textContent(),/Enter an API key or generate/);
  assert.deepEqual(await page.evaluate(()=>window.gatewayAuthCalls),[]);
  await page.getByRole('button',{name:'Generate new key',exact:true}).click();
  assert.equal(await key.inputValue(),'generated-fixture-key-1');
  assert.match(await page.locator('#gateway-auth-result').textContent(),/Apply protections to save/);
  assert.deepEqual(await page.evaluate(()=>window.fixture.authentication),{enabled:false,hasKey:false});
  assert.equal(await page.getByRole('button',{name:'Copy key',exact:true}).isDisabled(),true);
  assert.doesNotMatch(await page.locator('body').textContent(),/generated-fixture-key/);
  await page.getByRole('button',{name:'Apply protections',exact:true}).click();
  await page.getByText('Protections applied. Reconnect your apps using the saved configuration.',{exact:true}).waitFor();
  assert.equal(await key.inputValue(),'');
  assert.deepEqual(await page.evaluate(()=>window.gatewayAuthCalls),[['generate'],['update',{enabled:true,loopbackOnly:true,key:'generated-fixture-key-1'}]]);
  await page.getByRole('button',{name:'Generate new key',exact:true}).click();
  assert.equal(await key.inputValue(),'generated-fixture-key-2');
  await page.getByRole('button',{name:'Copy key',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.copied),'generated-fixture-key-1','copy never publishes the uncommitted draft');
  assert.equal(await key.inputValue(),'generated-fixture-key-2');
  assert.doesNotMatch(await page.locator('body').textContent(),/generated-fixture-key/);
  assert.deepEqual(await page.evaluate(()=>window.harbor.getGatewayAuth()),{enabled:true,hasKey:true,loopbackOnly:true});
  assert.deepEqual(errors,[]);
});

test('gateway authentication errors and both settings drafts survive polling and navigation without exposing keys',async t=>{
  const {page,errors}=await openUI(t);
  await page.getByRole('button',{name:'This Server',exact:true}).click();
  await page.getByLabel('Port',{exact:true}).fill('38403');
  await page.getByLabel('Use API key',{exact:true}).check();
  await page.getByLabel('Gateway API key',{exact:true}).fill('private-draft-should-not-render');
  await page.evaluate(()=>{
    window.authForm=document.querySelector('#gateway-auth-form');window.settingsForm=document.querySelector('#settings-form');
    window.harbor.updateGatewayAuth=async()=>{throw new Error('Rejected private-draft-should-not-render');};
  });
  await page.getByRole('button',{name:'Apply protections',exact:true}).click();
  await page.locator('#gateway-auth-error').waitFor();
  assert.match(await page.locator('#gateway-auth-error').textContent(),/draft is preserved/);
  assert.doesNotMatch(await page.locator('body').textContent(),/private-draft-should-not-render/);
  await page.getByLabel('Gateway API key',{exact:true}).focus();
  await page.evaluate(()=>window.fixture.authentication.hasKey=true);
  await page.getByRole('button',{name:'Copy key',exact:true}).waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('#gateway-auth-form').querySelectorAll('button')[1].disabled);
  assert.equal(await page.getByLabel('Gateway API key',{exact:true}).evaluate(node=>node===document.activeElement),true);
  await page.getByRole('button',{name:'Tools',exact:true}).click();
  await page.getByRole('button',{name:'This Server',exact:true}).click();
  assert.equal(await page.getByLabel('Gateway API key',{exact:true}).inputValue(),'private-draft-should-not-render');
  assert.equal(await page.getByLabel('Use API key',{exact:true}).isChecked(),true);
  assert.equal(await page.getByLabel('Port',{exact:true}).inputValue(),'38403');
  assert.equal(await page.evaluate(()=>document.querySelector('#gateway-auth-form')===window.authForm&&document.querySelector('#settings-form')===window.settingsForm),true);
  assert.match(await page.locator('#gateway-auth-status').textContent(),/Authentication is disabled/);
  assert.equal(await page.locator('#gateway-auth-error').isVisible(),true);
  assert.deepEqual(errors,[]);
});

test('gateway protections independently support all four access choices without mandatory acknowledgement',async t=>{
  const {page,errors}=await openUI(t);
  await page.getByRole('button',{name:'This Server',exact:true}).click();
  const useKey=page.getByLabel('Use API key',{exact:true}),loopback=page.getByLabel('Loopback only',{exact:true});
  assert.equal(await loopback.isChecked(),true);
  assert.equal(await useKey.isChecked(),false);
  assert.equal(await page.locator('.gateway-protection-options input[type=checkbox]').count(),2);
  assert.equal(await page.getByLabel('Enable network access').count(),0);
  assert.equal(await page.getByLabel('I understand network access is unauthenticated').count(),0);
  await page.getByLabel('Port',{exact:true}).fill('38404');
  await loopback.uncheck();
  await page.getByRole('button',{name:'Apply protections',exact:true}).click();
  await page.getByText('Protections applied. Reconnect your apps using the saved configuration.',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.gatewayAuthCalls.at(-1)),['update',{enabled:false,loopbackOnly:false}]);
  assert.equal(await page.getByLabel('Bind address',{exact:true}).isDisabled(),false);
  assert.equal(await page.getByLabel('Port',{exact:true}).inputValue(),'38404');
  assert.match(await page.locator('#gateway-network-notice').textContent(),/Network access is enabled without an API key/);
  await loopback.check();
  await page.getByRole('button',{name:'Apply settings',exact:true}).click();
  await page.getByText('Settings applied. Reconnect your model client if the endpoint or tool delivery changed so it refreshes its tool list.',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.fixture.settings.networkEnabled),true,'unrelated settings preserve the saved network choice, not the pending loopback draft');
  assert.equal(await loopback.isChecked(),true,'pending protection choices survive unrelated saves');
  await loopback.uncheck();
  await useKey.check();
  await page.getByRole('button',{name:'Generate new key',exact:true}).click();
  await page.getByRole('button',{name:'Apply protections',exact:true}).click();
  await page.waitForFunction(()=>window.fixture.authentication.enabled===true);
  assert.deepEqual(await page.evaluate(()=>window.gatewayAuthCalls.at(-1)),['update',{enabled:true,loopbackOnly:false,key:'generated-fixture-key-1'}]);
  assert.match(await page.locator('#gateway-network-notice').textContent(),/API key is required.*HTTP.*not encrypted/);
  await loopback.check();
  await page.getByRole('button',{name:'Apply protections',exact:true}).click();
  await page.waitForFunction(()=>window.fixture.settings.networkEnabled===false);
  assert.deepEqual(await page.evaluate(()=>window.gatewayAuthCalls.at(-1)),['update',{enabled:true,loopbackOnly:true}]);
  assert.equal(await page.getByLabel('Bind address',{exact:true}).isDisabled(),true);
  await useKey.uncheck();
  await page.getByRole('button',{name:'Apply protections',exact:true}).click();
  await page.waitForFunction(()=>window.fixture.authentication.enabled===false);
  assert.deepEqual(await page.evaluate(()=>window.gatewayAuthCalls.at(-1)),['update',{enabled:false,loopbackOnly:true}]);
  assert.equal(await page.getByRole('button',{name:'Copy key',exact:true}).isDisabled(),false);
  assert.equal(await page.getByLabel('Gateway API key',{exact:true}).inputValue(),'');
  assert.deepEqual(errors,[]);
});

test('authenticated connection snippets stay redacted and copy configurations through the desktop API',async t=>{
  const {page,errors}=await openUI(t);
  await page.getByRole('button',{name:'This Server',exact:true}).click();
  await page.getByLabel('Use API key',{exact:true}).check();
  await page.getByLabel('Gateway API key',{exact:true}).fill('saved-clipboard-secret-123');
  await page.getByRole('button',{name:'Apply protections',exact:true}).click();
  await page.getByText('Protections applied. Reconnect your apps using the saved configuration.',{exact:true}).waitFor();
  await page.evaluate(()=>window.fixture.endpoints.network=['http://192.168.1.20:37373/mcp']);
  await page.getByRole('button',{name:'Connections',exact:true}).click();
  await page.getByText('http://192.168.1.20:37373/mcp',{exact:true}).waitFor();
  assert.match(await page.locator('#content').textContent(),/API key required for gateway connections/);
  await page.getByLabel('Configuration address').selectOption('http://192.168.1.20:37373/mcp');
  assert.match(await page.locator('.client-configurations pre').textContent(),/<YOUR_HARBOR_API_KEY>/);
  assert.doesNotMatch(await page.locator('body').textContent(),/saved-clipboard-secret-123/);
  await page.getByRole('button',{name:'Copy configuration',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.connectionCopyCalls.at(-1)),{format:'http',endpoint:'http://192.168.1.20:37373/mcp',client:'lmstudio'});
  const http=JSON.parse(await page.evaluate(()=>window.copied));
  assert.equal(http.mcpServers.harbor.headers.Authorization,'Bearer saved-clipboard-secret-123');
  await page.getByRole('button',{name:'Stdio bridge',exact:true}).click();
  assert.match(await page.locator('.client-configurations pre').textContent(),/<YOUR_HARBOR_API_KEY>/);
  await page.getByRole('button',{name:'Copy configuration',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.connectionCopyCalls.at(-1)),{format:'stdio',endpoint:'http://192.168.1.20:37373/mcp',client:'lmstudio'});
  const stdio=JSON.parse(await page.evaluate(()=>window.copied));
  assert.equal(stdio.mcpServers.harbor.env.HARBOR_API_KEY,'saved-clipboard-secret-123');
  assert.deepEqual(stdio.mcpServers.harbor.args,['bridge.mjs','http://192.168.1.20:37373/mcp']);
  for(const client of ['hermes','openclaw']){
    await page.getByLabel('Client application',{exact:true}).selectOption(client);
    assert.match(await page.locator('.client-configurations pre').textContent(),client==='hermes'?/mcp_servers:/ : /"mcp":/);
    assert.match(await page.locator('.client-setup-steps').textContent(),client==='hermes'?/config.yaml/:/openclaw.json/);
    await page.getByRole('button',{name:'Copy configuration',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.connectionCopyCalls.at(-1)),{format:'stdio',endpoint:'http://192.168.1.20:37373/mcp',client});
    await page.getByRole('button',{name:'Streamable HTTP',exact:true}).click();
    assert.match(await page.locator('.client-configurations pre').textContent(),/Bearer <YOUR_HARBOR_API_KEY>/);
    await page.getByRole('button',{name:'Copy configuration',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.connectionCopyCalls.at(-1)),{format:'http',endpoint:'http://192.168.1.20:37373/mcp',client});
    await page.getByRole('button',{name:'Stdio bridge',exact:true}).click();
  }
  assert.doesNotMatch(await page.locator('body').textContent(),/saved-clipboard-secret-123/);
  assert.doesNotMatch(await page.evaluate(async()=>JSON.stringify([await window.harbor.snapshot(),await window.harbor.connectionInfo()])),/saved-clipboard-secret-123/);
  assert.deepEqual(errors,[]);
});

test('gateway authentication clears a successfully saved key even when the subsequent refresh fails',async t=>{
  const {page,errors}=await openUI(t);
  await page.getByRole('button',{name:'This Server',exact:true}).click();
  await page.getByLabel('Use API key',{exact:true}).check();
  await page.getByLabel('Gateway API key',{exact:true}).fill('save-success-readback-failure');
  await page.evaluate(()=>{const update=window.harbor.updateGatewayAuth;window.harbor.updateGatewayAuth=async options=>{const auth=await update(options);window.harbor.snapshot=async()=>{throw new Error('snapshot unavailable');};return auth;};});
  await page.getByRole('button',{name:'Apply protections',exact:true}).click();
  await page.locator('#gateway-auth-error').waitFor();
  assert.match(await page.locator('#gateway-auth-error').textContent(),/Protections were saved.*could not refresh/);
  assert.equal(await page.getByLabel('Gateway API key',{exact:true}).inputValue(),'');
  assert.doesNotMatch(await page.locator('#gateway-auth-result').textContent(),/Protections applied/);
  await page.getByRole('button',{name:'Connections',exact:true}).click();
  assert.match(await page.locator('.client-configurations pre').textContent(),/Bearer <YOUR_HARBOR_API_KEY>/,'safe templates follow confirmed auth even when connectionInfo remains stale');
  assert.doesNotMatch(await page.locator('body').textContent(),/save-success-readback-failure/);
  assert.deepEqual(errors,[]);
});

test('This Server applies complete settings while preserving saved gateway protections', async t => {
  const {page,errors}=await openUI(t);
  assert.equal(await page.getByRole('button',{name:'This Server',exact:true}).count(),1);
  await page.getByRole('button',{name:'This Server',exact:true}).click();
  await page.getByLabel('Port',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Port',{exact:true}).inputValue(),'37373');
  assert.equal(await page.getByLabel('Loopback only',{exact:true}).isChecked(),true);
  assert.equal(await page.getByLabel('Bind address',{exact:true}).isDisabled(),true);
  await page.getByLabel('Port',{exact:true}).fill('38400');
  await page.getByLabel('MCP path',{exact:true}).fill('/tools');
  await page.getByLabel('Initialization / discovery timeout (seconds)').fill('45');
  await page.getByLabel('Tool timeout (seconds)').fill('180');
  await page.getByLabel('Allowed origins (JSON array)').fill('["https://client.example"]');
  await page.getByLabel('Loopback only',{exact:true}).uncheck();
  await page.getByRole('button',{name:'Apply protections',exact:true}).click();
  await page.getByText('Protections applied. Reconnect your apps using the saved configuration.',{exact:true}).waitFor();
  await page.getByLabel('Bind address',{exact:true}).fill('0.0.0.0');
  assert.deepEqual(await page.evaluate(()=>window.calls),[]);
  await page.getByRole('button',{name:'Apply settings',exact:true}).click();
  await page.getByText('Settings applied. Reconnect your model client if the endpoint or tool delivery changed so it refreshes its tool list.',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.calls),[['settings',{port:38400,networkEnabled:true,bindAddress:'0.0.0.0',mcpPath:'/tools',requestTimeoutMs:45000,toolTimeoutMs:180000,allowedOrigins:['https://client.example'],toolMode:'all',...SEARCH_DEFAULTS}]]);
  await page.locator('.this-server-connection .connection-card > .endpoint-line').getByText('http://127.0.0.1:38400/tools',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
});

test('This Server exposes active local and LAN connection copies without advertising wildcard binds', async t => {
  const {page,errors}=await openUI(t);
  await page.evaluate(()=>{
    window.fixture.settings.networkEnabled=true;
    window.fixture.endpoints={local:window.fixture.endpoint,network:['http://192.168.1.20:37373/mcp','http://[fd00::20]:37373/mcp'],bindAddress:'0.0.0.0'};
  });
  await page.getByRole('button',{name:'This Server',exact:true}).click();
  await page.getByText('http://[fd00::20]:37373/mcp',{exact:true}).waitFor();
  await page.getByText('No authentication.',{exact:false}).first().waitFor();
  await page.getByRole('button',{name:'Copy endpoint',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.copied),'http://127.0.0.1:37373/mcp');
  await page.getByRole('button',{name:'Copy network endpoint 2',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.copied),'http://[fd00::20]:37373/mcp');
  await page.getByText('Help with connections',{exact:true}).click();
  await page.getByLabel('Configuration address').selectOption('http://192.168.1.20:37373/mcp');
  await page.getByRole('button',{name:'Copy configuration',exact:true}).click();
  assert.equal(JSON.parse(await page.evaluate(()=>window.copied)).mcpServers.harbor.url,'http://192.168.1.20:37373/mcp');
  await page.getByRole('button',{name:'Stdio bridge',exact:true}).click();
  await page.getByRole('button',{name:'Copy configuration',exact:true}).click();
  assert.deepEqual(JSON.parse(await page.evaluate(()=>window.copied)).mcpServers.harbor.args,['bridge.mjs','http://192.168.1.20:37373/mcp']);
  assert.match(await page.locator('.this-server-connection').textContent(),/Protocol server: mcp-harbor · 0.2.0/);
  await page.getByText('C:/test/harbor-settings.json',{exact:false}).waitFor();
  assert.match(await page.locator('#gateway-status').textContent(),/network enabled/i);
  assert.deepEqual(await page.evaluate(()=>window.calls),[]);
  assert.deepEqual(errors,[]);
});

test('settings rebind errors preserve drafts through polling and navigation', async t => {
  const {page,errors}=await openUI(t);
  await page.getByRole('button',{name:'This Server',exact:true}).click();
  await page.getByLabel('Port',{exact:true}).fill('38401');
  await page.evaluate(()=>{window.harbor.updateSettings=async()=>{throw new Error('EADDRINUSE: port 38401 is busy. Choose another port.');};window.fixture.clients=[{name:'New client'}];});
  await page.waitForTimeout(1700);
  assert.equal(await page.getByLabel('Port',{exact:true}).inputValue(),'38401');
  assert.equal(await page.getByLabel('Port',{exact:true}).evaluate(el=>el===document.activeElement),true);
  await page.getByRole('button',{name:'Apply settings',exact:true}).click();
  await page.getByText('EADDRINUSE:',{exact:false}).waitFor();
  const errorBox=await page.locator('#settings-error').boundingBox();
  assert.ok(errorBox.y>=0&&errorBox.y+errorBox.height<=800);
  await page.getByRole('button',{name:'Tools',exact:true}).click();
  await page.getByRole('button',{name:'This Server',exact:true}).click();
  assert.equal(await page.getByLabel('Port',{exact:true}).inputValue(),'38401');
  assert.match(await page.locator('#settings-error').textContent(),/EADDRINUSE/);
  await page.locator('.this-server-connection .connection-card > .endpoint-line').getByText('http://127.0.0.1:37373/mcp',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.fixture.settings.port),37373);
  assert.deepEqual(errors,[]);
});

test('settings success is not claimed until a fresh snapshot verifies the write', async t => {
  const {page}=await openUI(t);
  await page.getByRole('button',{name:'This Server',exact:true}).click();
  await page.getByLabel('Port',{exact:true}).fill('38402');
  await page.evaluate(()=>{const update=window.harbor.updateSettings;window.harbor.updateSettings=async settings=>{const saved=await update(settings);window.harbor.snapshot=async()=>{throw new Error('IPC read failed');};return saved;};});
  await page.getByRole('button',{name:'Apply settings',exact:true}).click();
  await page.getByRole('button',{name:'Apply settings',exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('#settings-form button[type=submit]').disabled);
  assert.doesNotMatch(await page.locator('#settings-result').textContent(),/Settings applied/);
  assert.match(await page.locator('#settings-error').textContent(),/saved.*refresh.*IPC read failed/i);
  assert.equal(await page.getByLabel('Port',{exact:true}).inputValue(),'38402');
});

test('Children Servers Statuses shows process health and explicit configure/restart controls', async t => {
  const {page,errors}=await openUI(t);
  assert.equal(await page.getByRole('button',{name:'Children Servers Statuses',exact:true}).count(),1);
  await page.evaluate(()=>{
    window.fixture.servers=[{id:'healthy',name:'Healthy child',command:'node',args:['child.mjs'],transport:'stdio',runtime:'native',status:'running',pid:4242,toolCount:7},{id:'broken',name:'Broken child',command:'missing',transport:'stdio',status:'error',toolCount:0,error:'<img src=x onerror=unsafe()> executable not found'}];
    window.fixture.tools=Array.from({length:7},(_,index)=>({name:`healthy__tool_${index}`,serverId:'healthy',inputSchema:{type:'object'}}));
  });
  await page.getByRole('heading',{name:'Children Servers Statuses',exact:true}).waitFor();
  await page.getByText('PID 4242',{exact:true}).waitFor();
  await page.getByText('7 tools',{exact:true}).waitFor();
  const broken=page.locator('[data-server-id="broken"]');
  assert.equal(await broken.locator('.server-error img').count(),0);
  assert.match(await broken.locator('.server-error').textContent(),/executable not found/);
  await broken.getByRole('button',{name:'Configure',exact:true}).click();
  assert.equal(await page.getByLabel('Command',{exact:true}).inputValue(),'missing');
  await page.getByRole('button',{name:'Close server editor',exact:true}).click();
  if(process.env.HARBOR_UI_CHILDREN_SCREENSHOT)await page.screenshot({path:process.env.HARBOR_UI_CHILDREN_SCREENSHOT,animations:'disabled'});
  await broken.getByRole('button',{name:'Restart',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(call=>call[0]==='restart'&&call[1]==='broken'));
  assert.deepEqual(await page.evaluate(()=>window.calls),[['restart','broken']]);

  assert.deepEqual(errors,[]);
});

test('This Server remains keyboard-labelled and scrollable at 1200 by 800', async t => {
  const {page,errors}=await openUI(t);
  const childNav=page.getByRole('button',{name:'Children Servers Statuses',exact:true});
  assert.equal(await childNav.evaluate(el=>el.scrollWidth<=el.clientWidth),true,'full child navigation label fits');
  await page.getByRole('button',{name:'This Server',exact:true}).click();
  await page.getByLabel('Port',{exact:true}).waitFor();
  const toggleBox=await page.getByLabel('Loopback only',{exact:true}).boundingBox();
  assert.ok(toggleBox.width<=24&&toggleBox.height<=24,'network checkbox has a compact hit indicator');
  for(const label of ['Port','MCP path','Bind address','Initialization / discovery timeout (seconds)','Tool timeout (seconds)','Allowed origins (JSON array)'])assert.equal(await page.getByLabel(label,{exact:true}).count(),1);
  assert.equal(await page.locator('#content').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  if(process.env.HARBOR_UI_SETTINGS_SCREENSHOT)await page.screenshot({path:process.env.HARBOR_UI_SETTINGS_SCREENSHOT,animations:'disabled'});
  await page.getByRole('button',{name:'Apply settings',exact:true}).scrollIntoViewIfNeeded();
  const applyBox=await page.getByRole('button',{name:'Apply settings',exact:true}).boundingBox();
  assert.ok(applyBox.y>=0&&applyBox.y+applyBox.height<=800);
  if(process.env.HARBOR_UI_SETTINGS_FORM_SCREENSHOT)await page.screenshot({path:process.env.HARBOR_UI_SETTINGS_FORM_SCREENSHOT,animations:'disabled'});
  assert.deepEqual(await page.evaluate(()=>window.calls),[]);
  assert.deepEqual(errors,[]);
});

test('settings validation rejects malformed JSON and out-of-range numeric values before IPC', async t => {
  const {page}=await openUI(t);
  await page.getByRole('button',{name:'This Server',exact:true}).click();
  await page.getByLabel('Port',{exact:true}).fill('65536');
  await page.getByRole('button',{name:'Apply settings',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.calls),[]);
  assert.match(await page.locator('#settings-error').textContent(),/Port.*1.*65535/);
  await page.getByLabel('Port',{exact:true}).fill('37373');
  await page.getByLabel('Tool timeout (seconds)').fill('0');
  await page.getByRole('button',{name:'Apply settings',exact:true}).click();
  assert.match(await page.locator('#settings-error').textContent(),/timeout.*1.*3600/i);
  await page.getByLabel('Tool timeout (seconds)').fill('120');
  for(const value of ['not JSON','{}','[12]']) {
    await page.getByLabel('Allowed origins (JSON array)').fill(value);
    await page.getByRole('button',{name:'Apply settings',exact:true}).click();
    assert.match(await page.locator('#settings-error').textContent(),/Allowed origins.*JSON array/);
  }
  assert.deepEqual(await page.evaluate(()=>window.calls),[]);
});

test('a poll sharing a failed settings verification does not leak an unhandled rejection', async t => {
  const {page,errors}=await openUI(t);
  await page.getByRole('button',{name:'This Server',exact:true}).click();
  await page.getByLabel('Port',{exact:true}).fill('38403');
  await page.evaluate(()=>{
    const update=window.harbor.updateSettings;
    window.harbor.updateSettings=async settings=>{const saved=await update(settings);window.harbor.snapshot=()=>new Promise((resolve,reject)=>window.rejectVerification=()=>reject(new Error('Verification interrupted')));return saved;};
  });
  await page.getByRole('button',{name:'Apply settings',exact:true}).click();
  await page.waitForFunction(()=>window.rejectVerification);
  await page.waitForTimeout(1700);
  await page.evaluate(()=>window.rejectVerification());
  await page.locator('#settings-error').waitFor();
  await page.waitForTimeout(50);
  assert.deepEqual(errors,[]);
});

test('mutation waits for a fresh snapshot even when a poll is already in flight', async t => {
  const {page}=await openUI(t);
  await page.getByRole('heading',{name:'Your MCP servers, one harbor.'}).waitFor();
  await page.getByRole('button',{name:'Add server',exact:true}).first().click();
  await page.getByLabel('Server name').fill('Fresh server');
  await page.getByLabel('Server ID').fill('fresh');
  await page.getByLabel('Command',{exact:true}).fill('node');
  await page.evaluate(()=>{let delayed=false;window.harbor.snapshot=async()=>{const snap=structuredClone(window.fixture);if(!delayed){delayed=true;window.pollStarted=true;await new Promise(resolve=>window.releasePoll=resolve);}return snap;};});
  await page.waitForFunction(()=>window.pollStarted);
  await page.getByRole('button',{name:'Save server',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c[0]==='save'));
  assert.equal(await page.locator('#server-dialog').evaluate(el=>el.open),true);
  await page.evaluate(()=>window.releasePoll());
  await page.locator('#server-dialog').waitFor({state:'hidden'});
  assert.equal(await page.getByRole('heading',{name:'Fresh server',exact:true}).count(),1);
});

test('live tool inspector, log search and connection snippets render untrusted strings safely', async t => {
  const {page,errors}=await openUI(t);
  await page.evaluate(()=>{
    window.fixture.tools=[{name:'git__status',serverId:'git',originalName:'status',description:'<img src=x onerror=alert(1)>',inputSchema:{type:'object',properties:{repo:{type:'string'}}}},{name:'git__diff',serverId:'git',description:'Compare changes',inputSchema:{type:'object'}}];
    window.fixture.logs=[{time:new Date().toISOString(),serverId:'git',level:'error',message:'<script>unsafe()</script> failed'},{time:new Date().toISOString(),serverId:'git',level:'info',message:'Ready'}];
    window.fixture.clients=[{id:'one',name:'My client',version:'1.0',connectedAt:new Date().toISOString()}];
  });
  await page.getByRole('button',{name:'Tools',exact:true}).click();
  await page.getByLabel('Search tools…').fill('status');
  await page.getByRole('button',{name:'git__status',exact:false}).click();
  assert.equal(await page.locator('#schema-description').textContent(),'<img src=x onerror=alert(1)>');
  assert.equal(await page.locator('#schema-description img').count(),0);
  await page.getByRole('button',{name:'Copy schema',exact:true}).click();
  await page.waitForFunction(()=>window.copied?.includes('properties'));
  await page.getByRole('button',{name:'Close tool inspector',exact:true}).click();
  await page.getByRole('button',{name:'Activity',exact:true}).click();
  await page.getByLabel('Search activity…').fill('failed');
  await page.getByText('<script>unsafe()</script> failed',{exact:true}).waitFor();
  assert.equal(await page.getByText('Ready',{exact:true}).count(),0);
  assert.equal(await page.locator('.log-message script').count(),0);
  await page.getByRole('button',{name:'Connections',exact:true}).click();
  await page.getByText('My client',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Copy endpoint',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.copied),'http://127.0.0.1:37373/mcp');
  await page.getByRole('button',{name:'Stdio bridge',exact:true}).click();
  await page.getByRole('button',{name:'Copy configuration',exact:true}).click();
  assert.equal(JSON.parse(await page.evaluate(()=>window.copied)).mcpServers.harbor.command,'node');
  assert.deepEqual(errors,[]);
});

test('templates, HTTP editing, confirmation and config import remain explicit user actions', async t => {
  const {page,errors}=await openUI(t);
  await page.getByRole('button',{name:'Serena Semantic',exact:false}).click();
  await page.getByRole('button',{name:'Apply template',exact:true}).click();
  await page.getByText('Choose or enter a repository path first.',{exact:true}).waitFor();
  const errorBox=await page.locator('#form-error').boundingBox();
  assert.ok(errorBox.y>=0 && errorBox.y+errorBox.height<=800,'validation error is brought into view');
  await page.getByRole('button',{name:'Browse…',exact:true}).first().click();
  await page.getByRole('button',{name:'Apply template',exact:true}).click();
  assert.equal(await page.getByLabel('Command',{exact:true}).inputValue(),'serena');
  assert.equal(await page.getByLabel('Start automatically when Harbor opens').isChecked(),false);
  assert.deepEqual(await page.evaluate(()=>window.calls),[]);
  await page.getByRole('button',{name:'Save server',exact:true}).click();
  await page.getByRole('heading',{name:'Serena',exact:true}).waitFor();
  await page.getByRole('button',{name:'Configure',exact:true}).click();
  assert.equal(await page.locator('#save-hint').textContent(),'Saving stops this server. Start it again when ready.');
  await page.getByLabel('Transport',{exact:true}).selectOption('http');
  await page.getByLabel('Server URL').fill('https://example.org/mcp');
  await page.getByRole('button',{name:'Save server',exact:true}).click();
  await page.getByText('https://example.org/mcp',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Remove',exact:true}).click();
  assert.equal(await page.getByRole('heading',{name:'Remove server?',exact:true}).count(),1);
  await page.getByRole('button',{name:'Remove server',exact:true}).click();
  await page.getByRole('heading',{name:'Your MCP servers, one harbor.'}).waitFor();
  await page.getByRole('button',{name:'Import config',exact:true}).first().click();
  await page.getByLabel('Configuration JSON').fill('{"mcpServers":{"imported":{"command":"node","args":["server.mjs"],"autoStart":true}}}');
  await page.getByRole('button',{name:'Import servers',exact:true}).click();
  await page.getByRole('heading',{name:'imported',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.at(-1)[1].mcpServers.imported.autoStart),false);
  assert.deepEqual(errors,[]);
});

test('renderer has honest empty state and saves a draft without executing it', async t => {
  const {page,errors} = await openUI(t);
  await page.getByRole('heading',{name:'Your MCP servers, one harbor.'}).waitFor();
  if(process.env.HARBOR_UI_SCREENSHOT) await page.screenshot({path:process.env.HARBOR_UI_SCREENSHOT});
  for (const name of ['This Server','Children Servers Statuses','Tools','Activity','Connections']) assert.equal(await page.getByRole('button',{name,exact:true}).count(),1);
  await page.getByRole('button',{name:'Add server',exact:true}).first().click();
  await page.getByLabel('Server name').fill('Local server');
  await page.getByLabel('Server ID').fill('local');
  await page.getByLabel('Command',{exact:true}).fill('node');
  await page.getByLabel('Arguments (JSON array)').fill('["a path.mjs"]');
  await page.waitForTimeout(1650);
  assert.equal(await page.getByLabel('Server name').inputValue(),'Local server');
  await page.getByRole('button',{name:'Save server',exact:true}).click();
  await page.getByRole('heading',{name:'Local server',exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.calls.map(c=>c[0])),['save']);
  assert.deepEqual(await page.evaluate(()=>window.calls[0][1].args),['a path.mjs']);
  await page.getByRole('button',{name:'Start',exact:true}).click();
  await page.getByText('Running',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
});

test('connection dropdown covers all recipes, preserves LAN address and switches HTTP-only clients safely',async t=>{
  const {page,errors}=await openUI(t);
  await page.evaluate(()=>window.fixture.endpoints.network=['http://192.168.1.20:37373/mcp']);
  await page.getByRole('button',{name:'Connections',exact:true}).click();
  await page.getByLabel('Configuration address').selectOption('http://192.168.1.20:37373/mcp');
  const clients=['lmstudio','hermes','openclaw','opencode','opencode-v1','openhands','goose','interpreter','openwebui','letta','anythingllm','general'];
  assert.deepEqual(await page.getByLabel('Client application',{exact:true}).locator('option').evaluateAll(items=>items.map(item=>item.value)),clients);
  await page.getByRole('button',{name:'Stdio bridge',exact:true}).click();
  for(const client of clients){
    await page.getByLabel('Client application',{exact:true}).selectOption(client);
    assert.match(await page.locator('.client-configurations pre').textContent(),/http:\/\/192.168.1.20:37373\/mcp/);
    assert.equal(await page.locator('.client-setup-steps li').count(),4);
    if(client==='openwebui'){
      assert.equal(await page.getByRole('button',{name:'Stdio bridge',exact:true}).count(),0);
      assert.match(await page.locator('.client-configurations pre').textContent(),/Type: MCP \(Streamable HTTP\)/);
    }
    await page.getByRole('button',{name:'Copy configuration',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.connectionCopyCalls.at(-1)),{client,endpoint:'http://192.168.1.20:37373/mcp',format:clients.indexOf(client)<8?'stdio':'http'});
  }
  if(process.env.HARBOR_CLIENT_HELP_EVIDENCE){
    const fs=await import('node:fs/promises');await fs.mkdir(process.env.HARBOR_CLIENT_HELP_EVIDENCE,{recursive:true});
    await page.getByLabel('Client application',{exact:true}).selectOption('openwebui');
    await page.setViewportSize({width:1200,height:1500});await page.locator('#content').evaluate(node=>node.scrollTop=0);await page.screenshot({path:process.env.HARBOR_CLIENT_HELP_EVIDENCE+'/connection-help-openwebui.png'});
  }
  await page.setViewportSize({width:600,height:800});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const addressBox=await page.locator('.connection-string code').boundingBox();assert.ok(addressBox.width>200&&addressBox.height<50,'connection string must remain readable at narrow widths');
  if(process.env.HARBOR_CLIENT_HELP_EVIDENCE){await page.setViewportSize({width:600,height:1800});await page.locator('#content').evaluate(node=>node.scrollTop=0);await page.screenshot({path:process.env.HARBOR_CLIENT_HELP_EVIDENCE+'/connection-help-narrow.png'});}
  assert.deepEqual(errors,[]);
});

test('profile connection recipes retain the profile endpoint and recover from HTTP-only selection',async t=>{
  const {page,errors}=await openUI(t);
  await page.evaluate(()=>{
    window.harbor.getProfiles=async()=>({defaultProfile:{id:'default',name:'Default',delivery:{toolMode:'all'}},profiles:[{id:'build',name:'Build',revision:1,serverIds:[],missingServerIds:[],capabilities:['tools'],delivery:{toolMode:'all'}}],servers:[],clients:[],runtimes:[],admission:{public:{active:0,queued:0},maxSessions:10}});
    window.harbor.profileConnectionInfo=async()=>({endpoint:'http://127.0.0.1:37373/mcp/profiles/build',authentication:{enabled:true},httpConfig:{mcpServers:{harbor:{url:'http://127.0.0.1:37373/mcp/profiles/build',headers:{Authorization:'Bearer <YOUR_HARBOR_API_KEY>'}}}},stdioConfig:{mcpServers:{harbor:{command:'node',args:['C:\\Harbor ü\\bridge.mjs','http://127.0.0.1:37373/mcp/profiles/build'],env:{HARBOR_API_KEY:'<YOUR_HARBOR_API_KEY>'}}}}});
  });
  await page.getByRole('button',{name:'Profiles',exact:true}).click();
  await page.getByLabel('Selected profile').selectOption('build');
  await page.getByLabel('Configuration format',{exact:true}).selectOption('stdio');
  await page.getByLabel('Client application',{exact:true}).selectOption('openwebui');
  assert.equal(await page.getByLabel('Configuration format',{exact:true}).inputValue(),'http');
  assert.equal(await page.locator('#profile-format option[value="stdio"]').isDisabled(),true);
  for(const client of ['opencode','opencode-v1','openhands','goose','interpreter','openwebui','letta','anythingllm','general']){
    await page.getByLabel('Client application',{exact:true}).selectOption(client);
    assert.match(await page.getByLabel('Profile connection preview').textContent(),/\/mcp\/profiles\/build/);
    assert.match(await page.getByLabel('Profile connection preview').textContent(),/<YOUR_HARBOR_API_KEY>/);
    await page.getByRole('button',{name:'Copy configuration',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.connectionCopyCalls.at(-1)),{client,format:'http',endpoint:'http://127.0.0.1:37373/mcp/profiles/build',profileId:'build'});
  }
  assert.equal(await page.locator('#profile-format option[value="stdio"]').isDisabled(),false);
  await page.getByLabel('Configuration format',{exact:true}).selectOption('stdio');
  assert.match(await page.getByLabel('Profile connection preview').textContent(),/Harbor ü/);
  assert.deepEqual(errors,[]);
});
