import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function quitDesktop(app) {
  const process=app.process();
  if(process.exitCode!==null)return;
  const exited=new Promise(resolve=>process.once('exit',resolve));
  await app.evaluate(({app})=>app.quit()).catch(error=>{if(!/closed|Target/.test(error.message))throw error;});
  let timer;
  try{await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Desktop failed to exit after Quit')),20000);})]);}
  finally{clearTimeout(timer);}
}

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Read only this test's disposable profile; never send credentials through renderer
// evaluations or assertions, where Playwright traces could persist the secret.
async function savedAuthentication(data) {
  const authentication=JSON.parse(await readFile(path.join(data,'auth/gateway.json'),'utf8'));
  return authentication.enabled?{headers:{Authorization:'Bearer '+authentication.key},env:{HARBOR_API_KEY:authentication.key}}:{headers:{},env:{}};
}

async function authenticatedTransport(endpoint,data) {
  const {headers}=await savedAuthentication(data);
  return new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers}});
}

test('tool delivery controls apply, call real tools and persist hybrid choices after restart',async()=>{
  test.skip(!process.env.HARBOR_TOOL_RUNTIME_ROOT,'Bundled tool runtimes required');
  test.setTimeout(120000);
  const data=await mkdtemp(path.join(tmpdir(),'harbor-delivery-ui-'));
  const env={...process.env,HARBOR_DATA_DIR:data,HARBOR_PORT:'0'};delete env.ELECTRON_RUN_AS_NODE;
  const launch=()=>electron.launch({...(process.env.HARBOR_EXECUTABLE?{executablePath:process.env.HARBOR_EXECUTABLE,args:[]}:{args:['.']}),env});
  let app=await launch(),client;
  try{
    let page=await app.firstWindow();await expect(page.getByRole('button',{name:'Tool Delivery',exact:true})).toBeVisible();
    await page.evaluate(config=>window.harbor.saveServer(config),{id:'delivery',name:'Delivery fixture',command:process.execPath,args:[path.resolve('tests/fixtures/server.mjs')],autoStart:true});
    await page.evaluate(()=>window.harbor.startServer('delivery'));
    await page.getByRole('button',{name:'Tool Delivery',exact:true}).click();
    await expect(page.getByLabel('Tool delivery',{exact:true})).toHaveValue('all');
    expect(await page.getByLabel('Tool delivery',{exact:true}).locator('option').count()).toBe(8);
    await page.getByLabel('Tool delivery',{exact:true}).selectOption('hybrid');
    await expect(page.locator('#hybrid-all')).toHaveCount(0);
    await page.locator('#hybrid-portkey-local').uncheck();
    await page.getByRole('button',{name:'Apply tool delivery',exact:true}).click();
    await expect(page.locator('#delivery-error')).toContainText('at least two distinct');
    expect((await page.evaluate(()=>window.harbor.getSettings())).toolMode).toBe('all');
    await page.locator('#hybrid-portkey-local').check();
    const info=await page.evaluate(()=>window.harbor.connectionInfo());client=new Client({name:'Delivery UI acceptance',version:'1'});await client.connect(await authenticatedTransport(info.endpoint,data));
    const original=(await client.listTools()).tools[0].name;
    for(const mode of ['bm25','regex','code','portkey-local','hybrid']){
      await page.getByLabel('Tool delivery',{exact:true}).selectOption(mode);
      if(mode==='hybrid')await page.locator('#hybrid-regex').check();
      await page.getByRole('button',{name:'Apply tool delivery',exact:true}).click();
      await expect(page.locator('#delivery-result')).toContainText('Saved.');
      const listed=(await client.listTools()).tools;expect(listed.length).toBeLessThanOrEqual(3);
      const search=mode==='code'?{name:'search',arguments:{query:'echo'}}:{name:'search_tools',arguments:mode==='regex'?{pattern:'echo'}:{query:'echo text'}};
      expect(JSON.stringify(await client.callTool(search))).toContain(original);
      const request=mode==='code'?{name:'execute',arguments:{code:`return await call_tool(${JSON.stringify(original)}, {"text":"UI verified"})`}}:{name:'call_tool',arguments:{name:original,arguments:{text:'UI verified'}}};
      const result=await client.callTool(request);expect(result.isError).not.toBe(true);expect(JSON.stringify(result)).toContain('UI verified');
    }
    await page.getByLabel('Tool delivery',{exact:true}).scrollIntoViewIfNeeded();
    expect(await page.locator('#content').evaluate(n=>n.scrollWidth<=n.clientWidth+1)).toBe(true);
    await page.screenshot({path:'evidence/portable/tool-delivery-ui.png',fullPage:true});
    await page.getByLabel('Tool delivery',{exact:true}).selectOption('portkey-api');
    await page.getByLabel('API key',{exact:true}).filter({visible:true}).fill('ui-fixture-key-only');
    await page.getByRole('button',{name:'Apply tool delivery',exact:true}).click();
    await expect(page.locator('#delivery-result')).toContainText('Saved.');
    const keyed=await page.evaluate(()=>window.harbor.getSettings());
    expect(JSON.stringify(keyed)).not.toContain('ui-fixture-key-only');
    expect(await readFile(keyed.portkeyApiKeyFile,'utf8')).toBe('ui-fixture-key-only');
    await expect(page.getByLabel('API key',{exact:true}).filter({visible:true})).toHaveValue('');
    await page.getByLabel('Tool delivery',{exact:true}).selectOption('hybrid');
    await page.getByRole('button',{name:'Apply tool delivery',exact:true}).click();
    await expect(page.locator('#delivery-result')).toContainText('Saved.');
    // Saving network settings must not reset the separate delivery settings.
    await page.getByRole('button',{name:'This Server',exact:true}).click();
    await page.getByRole('button',{name:'Apply settings',exact:true}).click();
    await expect(page.locator('#settings-result')).toContainText('Settings applied');
    expect((await page.evaluate(()=>window.harbor.getSettings())).toolMode).toBe('hybrid');
    await client.close();client=undefined;await quitDesktop(app);app=await launch();page=await app.firstWindow();
    await page.getByRole('button',{name:'Tool Delivery',exact:true}).click();
    await expect(page.getByLabel('Tool delivery',{exact:true})).toHaveValue('hybrid');
    for(const mode of ['bm25','regex','portkey-local'])await expect(page.locator(`#hybrid-${mode}`)).toBeChecked();
    await expect(page.locator('#hybrid-code')).not.toBeChecked();
  }finally{await client?.close();await quitDesktop(app);await rm(data,{recursive:true,force:true,maxRetries:3});}
});

test('desktop configures a real server and shares its tools with HTTP and stdio clients',async()=>{
  const data=await mkdtemp(path.join(tmpdir(),'harbor-e2e-real-'));
  const env={...process.env,HARBOR_DATA_DIR:data,HARBOR_PORT:'0'};delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({...(process.env.HARBOR_EXECUTABLE ? {executablePath:process.env.HARBOR_EXECUTABLE,args:[]} : {args:['.']}),env,timeout:20000});
  const http=new Client({name:'HTTP test app',version:'1'}),stdio=new Client({name:'Stdio test app',version:'1'});
  try {
    const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.getByRole('button',{name:'Add server',exact:true}).first().click();
    await page.getByLabel('Server name').fill('Integration fixture');
    await page.getByLabel('Server ID').fill('integration');
    await page.getByLabel('Command',{exact:true}).fill(process.execPath);
    await page.getByLabel('Arguments (JSON array)').fill(JSON.stringify([path.resolve('tests/fixtures/server.mjs')]));
    await page.getByRole('button',{name:'Save server',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Integration fixture',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Start',exact:true}).click();
    await expect(page.getByText('Running',{exact:true})).toBeVisible({timeout:30000});
    const info=await page.evaluate(()=>window.harbor.connectionInfo());
    await http.connect(await authenticatedTransport(info.endpoint,data));
    const spec=info.stdioConfig.mcpServers.harbor;
    await stdio.connect(new StdioClientTransport({command:process.execPath,args:spec.args,env:{...process.env,...(await savedAuthentication(data)).env}}));
    const name=(await http.listTools()).tools[0].name;
    expect((await stdio.listTools()).tools[0].name).toBe(name);
    const results=await Promise.all([http.callTool({name,arguments:{text:'from HTTP'}}),stdio.callTool({name,arguments:{text:'from stdio'}})]);
    const values=results.map(r=>JSON.parse(r.content[0].text));
    expect(values.map(r=>r.text)).toEqual(['from HTTP','from stdio']);expect(values[0].pid).toBe(values[1].pid);
    await page.getByRole('button',{name:'Connections',exact:true}).click();
    await expect(page.getByText('HTTP test app',{exact:true})).toBeVisible();
    await expect(page.getByText('Stdio test app',{exact:true})).toBeVisible();
    await page.screenshot({path:'test-results/desktop-connected.png'});
    await page.getByRole('button',{name:'Children Servers Statuses',exact:true}).click();
    await page.getByRole('button',{name:'Restart',exact:true}).click();
    await expect.poll(async()=>{const s=await page.evaluate(()=>window.harbor.snapshot());const entry=s.servers.find(s=>s.id==='integration');return entry?.status==='running' ? entry.pid : values[0].pid;},{timeout:30000,message:'Restart must reach running with a different PID within the lifecycle budget'}).not.toBe(values[0].pid);
    expect(JSON.parse((await http.callTool({name,arguments:{text:'after restart'}})).content[0].text).text).toBe('after restart');
    await page.getByRole('button',{name:'Stop',exact:true}).click();
    await expect(page.getByText('Stopped',{exact:true})).toBeVisible({timeout:15000});
    expect((await http.listTools()).tools).toEqual([]);expect(errors).toEqual([]);
  } finally {await http.close();await stdio.close();await quitDesktop(app);await rm(data,{recursive:true,force:true,maxRetries:3});}
});

import { createServer } from 'node:net';

test('Advisor checkbox choices survive full application restarts and control startup',async()=>{
  const data=await mkdtemp(path.join(tmpdir(),'harbor-checkbox-e2e-'));
  const env={...process.env,HARBOR_DATA_DIR:data,HARBOR_PORT:'0'};delete env.ELECTRON_RUN_AS_NODE;
  const launch=()=>electron.launch({...(process.env.HARBOR_EXECUTABLE?{executablePath:process.env.HARBOR_EXECUTABLE,args:[]}:{args:['.']}),env,timeout:20000});
  let app=await launch();
  try{
    let page=await app.firstWindow();await expect(page.getByRole('button',{name:'Advisor',exact:true})).toBeVisible();
    await page.evaluate(config=>window.harbor.saveServer(config),{id:'startup-fixture',name:'Startup fixture',command:process.execPath,args:[path.resolve('tests/fixtures/server.mjs')],autoStart:false,autoRestart:true});
    await page.getByRole('button',{name:'Advisor',exact:true}).click();
    await page.getByLabel('Select Startup fixture',{exact:true}).check();
    await expect(page.getByText('Saved: starts with Harbor.',{exact:true})).toBeVisible();
    await quitDesktop(app);app=await launch();page=await app.firstWindow();
    await page.getByRole('button',{name:'Advisor',exact:true}).click();
    await expect(page.getByLabel('Select Startup fixture',{exact:true})).toBeChecked();
    await expect.poll(async()=>(await page.evaluate(()=>window.harbor.snapshot())).servers[0].status).toBe('running');
    await page.getByLabel('Select Startup fixture',{exact:true}).uncheck();
    await expect(page.getByText('Saved: automatic startup and restart are off.',{exact:true})).toBeVisible();
    await quitDesktop(app);app=await launch();page=await app.firstWindow();
    await page.getByRole('button',{name:'Advisor',exact:true}).click();
    await expect(page.getByLabel('Select Startup fixture',{exact:true})).not.toBeChecked();
    const after=(await page.evaluate(()=>window.harbor.snapshot())).servers[0];
    expect(after.status).toBe('stopped');expect(after.autoStart).toBe(false);expect(after.autoRestart).toBe(false);
    await page.screenshot({path:'test-results/startup-selection-restored.png'});
  }finally{await quitDesktop(app);await rm(data,{recursive:true,force:true,maxRetries:3});}
});

test('settings IPC applies a new endpoint without restarting children and persists across app restart',async()=>{
  const data=await mkdtemp(path.join(tmpdir(),'harbor-settings-e2e-'));
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const env={...process.env,HARBOR_DATA_DIR:data,HARBOR_PORT:'0'};delete env.ELECTRON_RUN_AS_NODE;
  const launch=nextEnv=>electron.launch({...(process.env.HARBOR_EXECUTABLE?{executablePath:process.env.HARBOR_EXECUTABLE,args:[]}:{args:['.']}),env:nextEnv,timeout:20000});
  let app=await launch(env);
  try {
    let page=await app.firstWindow();
    await expect(page.getByRole('button',{name:'This Server',exact:true})).toBeVisible();
    const original=await page.evaluate(()=>window.harbor.getSettings());expect(original.networkEnabled).toBe(false);
    await page.evaluate(config=>window.harbor.saveServer(config),{id:'alive',name:'Keep running',transport:'stdio',runtime:'native',command:process.execPath,args:[path.resolve('tests/fixtures/server.mjs')],autoStart:false,autoRestart:false});
    await page.evaluate(()=>window.harbor.startServer('alive'));
    const before=await page.evaluate(()=>window.harbor.snapshot());
    const changed={...original,port,mcpPath:'/harbor-tools',requestTimeoutMs:90000,toolTimeoutMs:180000};
    await page.evaluate(settings=>window.harbor.updateSettings(settings),changed);
    const after=await page.evaluate(()=>window.harbor.snapshot());expect(after.servers[0].pid).toBe(before.servers[0].pid);
    expect(after.endpoint).toBe(`http://127.0.0.1:${port}/harbor-tools`);
    const client=new Client({name:'changed endpoint',version:'1'});
    try{await client.connect(await authenticatedTransport(after.endpoint,data));expect((await client.listTools()).tools).toHaveLength(1);}finally{await client.close();}
    await page.getByRole('button',{name:'This Server',exact:true}).click();
    await expect(page.locator('body')).toContainText(after.endpoint);
    await page.screenshot({path:'test-results/this-server-settings.png'});
    await quitDesktop(app);app=null;
    const restoredEnv={...env};delete restoredEnv.HARBOR_PORT;
    app=await launch(restoredEnv);page=await app.firstWindow();
    const restored=await page.evaluate(()=>window.harbor.getSettings());expect(restored).toEqual(changed);
    expect((await page.evaluate(()=>window.harbor.connectionInfo())).endpoint).toBe(after.endpoint);
  }finally{if(app)await quitDesktop(app);await rm(data,{recursive:true,force:true,maxRetries:3});}
});

test('packaged-compatible desktop owns native HTTP primary and companion process lifetime',async()=>{
  const data=await mkdtemp(path.join(tmpdir(),'harbor-managed-e2e-'));
  const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const env={...process.env,HARBOR_DATA_DIR:data,HARBOR_PORT:'0'};delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({...(process.env.HARBOR_EXECUTABLE?{executablePath:process.env.HARBOR_EXECUTABLE,args:[]}:{args:['.']}),env,timeout:20000});
  const client=new Client({name:'Packaged managed process check',version:'1'});
  try{
    const page=await app.firstWindow();
    const fixture=path.resolve('tests/fixtures/managed-network.mjs');
    await page.evaluate(config=>window.harbor.saveServer(config),{id:'owned',name:'Owned HTTP pair',transport:'http',url:`http://127.0.0.1:${port}/mcp`,managedProcesses:[{command:process.execPath,args:[fixture],env:{PORT:String(port)}},{command:process.execPath,args:[fixture],env:{ROLE:'companion'}}]});
    await page.evaluate(()=>window.harbor.startServer('owned'));
    const before=await page.evaluate(()=>window.harbor.snapshot());expect(before.servers[0].ownership).toBe('managed');expect(before.servers[0].processes).toHaveLength(2);
    await client.connect(await authenticatedTransport(before.endpoint,data));
    const name=(await client.listTools()).tools[0].name;
    expect(JSON.parse((await client.callTool({name,arguments:{text:'actual packaged helper'}})).content[0].text).text).toBe('actual packaged helper');
    await page.evaluate(()=>window.harbor.restartServer('owned'));
    const after=await page.evaluate(()=>window.harbor.snapshot());
    for(let i=0;i<2;i++)expect(after.servers[0].processes[i].pid).not.toBe(before.servers[0].processes[i].pid);
    expect(after.servers[0].status).toBe('running');
    await page.evaluate(()=>window.harbor.stopServer('owned'));
    expect((await page.evaluate(()=>window.harbor.snapshot())).servers[0].status).toBe('stopped');
    for(const p of after.servers[0].processes)expect(()=>process.kill(p.pid,0)).toThrow();
  }finally{await client.close();await quitDesktop(app);await rm(data,{recursive:true,force:true,maxRetries:3});}
});

test('desktop opens isolated, connects IPC, and remains running when window closes',async()=>{
  await expect(access('src/desktop/main.cjs')).resolves.toBeUndefined();
  const data=await mkdtemp(path.join(tmpdir(),'harbor-e2e-'));
  const env={...process.env,HARBOR_DATA_DIR:data,HARBOR_PORT:'0'}; delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({...(process.env.HARBOR_EXECUTABLE ? {executablePath:process.env.HARBOR_EXECUTABLE,args:[]} : {args:['.']}),env,timeout:20000});
  try {
    const page=await app.firstWindow();
    await expect(page).toHaveTitle(/MCP Harbor/);
    await expect(page.locator('body')).toContainText('Servers');
    const snapshot=await page.evaluate(()=>window.harbor.snapshot());
    expect(snapshot.servers).toEqual([]);
    expect(snapshot.authentication).toEqual({enabled:true,hasKey:true});
    expect((await page.evaluate(()=>window.harbor.getSettings())).networkEnabled).toBe(false);
    const anonymous=await fetch(snapshot.endpoint);expect(anonymous.status).toBe(401);await anonymous.body?.cancel();
    expect(snapshot.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(await page.evaluate(()=>typeof window.require)).toBe('undefined');
    const info=await page.evaluate(()=>window.harbor.connectionInfo());
    expect(info.httpConfig.mcpServers.harbor.url).toBe(snapshot.endpoint);
    const prefs=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    expect(prefs.contextIsolation).toBe(true);expect(prefs.nodeIntegration).toBe(false);expect(prefs.sandbox).toBe(true);
    await page.screenshot({path:'test-results/desktop-empty.png'});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
    expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
  } finally {await quitDesktop(app);await rm(data,{recursive:true,force:true,maxRetries:3});}
});
