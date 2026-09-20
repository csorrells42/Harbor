import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {_electron as electron,expect} from '@playwright/test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {load as loadYaml} from 'js-yaml';

test('native profile controls save, test, copy, retain session revisions and persist across restart',{
  skip:!process.env.HARBOR_TEST_PROFILES,timeout:120000
},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor profiles desktop '));
  const env={...process.env,HARBOR_DATA_DIR:path.join(dir,'profile'),HARBOR_PORT:'0'};delete env.HARBOR_PORTABLE_ROOT;delete env.ELECTRON_RUN_AS_NODE;
  const source=path.resolve(fileURLToPath(new URL('..',import.meta.url))),launch=()=>electron.launch({args:[source],env});
  let app=await launch(),client,transport;const errors=[];
  const close=async()=>{if(app){const child=app.process(),exited=new Promise(resolve=>child.once('exit',resolve));await app.evaluate(({app})=>{setTimeout(()=>app.quit(),0);});await exited;app=undefined;}};
  t.after(async()=>{await transport?.terminateSession().catch(()=>{});await client?.close().catch(()=>{});await close();await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  let page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
  await expect(page.locator('#gateway-status')).toContainText('Gateway online');
  await expect(page.getByRole('button',{name:'Profiles',exact:true})).toBeVisible();await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await page.evaluate(config=>window.harbor.saveServer(config),{id:'profile-fixture',name:'Profile fixture',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/server.mjs',import.meta.url))]});
  await page.getByRole('button',{name:'Profiles',exact:true}).click();await expect(page.getByLabel('Selected profile')).toHaveValue('default');
  await page.getByRole('button',{name:'New profile',exact:true}).click();
  await page.getByLabel('Profile name',{exact:true}).fill('Native acceptance');await page.getByLabel('Profile ID',{exact:true}).fill('native-acceptance');
  await page.getByLabel('Include Profile fixture',{exact:true}).check();await page.getByLabel('Process ownership',{exact:true}).selectOption('process');
  await page.getByRole('button',{name:'Save profile',exact:true}).click();await expect(page.locator('#profile-status')).toContainText('Saved revision');
  await expect(page.getByLabel('Profile connection preview')).toContainText('/profiles/native-acceptance');await expect(page.getByLabel('Profile connection preview')).toContainText('<YOUR_HARBOR_API_KEY>');
  await page.getByRole('button',{name:'Test connection',exact:true}).click();await expect(page.locator('#profile-status')).toContainText('1 advertised tools',{timeout:30000});
  await expect.poll(()=>page.evaluate(async()=> (await window.harbor.getProfiles()).runtimes.length)).toBe(0);
  const authentication=JSON.parse(await fs.readFile(path.join(dir,'profile/auth/gateway.json'),'utf8'));
  await page.getByRole('button',{name:'Copy configuration',exact:true}).click();
  const copied=JSON.parse(await app.evaluate(({clipboard})=>clipboard.readText()));assert.equal(copied.mcpServers.harbor.headers.Authorization,'Bearer '+authentication.key);
  assert(!(await page.locator('#content').textContent()).includes(authentication.key));
  for(const clientName of ['hermes','openclaw']){
    await page.getByLabel('Client application',{exact:true}).selectOption(clientName);
    for(const format of ['http','stdio']){
      await page.getByLabel('Configuration format',{exact:true}).selectOption(format);
      await page.getByRole('button',{name:'Copy configuration',exact:true}).click();
      const text=await app.evaluate(({clipboard})=>clipboard.readText());
      const entry=clientName==='hermes'?loadYaml(text).mcp_servers.harbor:JSON.parse(text).mcp.servers.harbor;
      const target=format==='http'?entry.url:entry.args[1];assert.match(target,/\/profiles\/native-acceptance$/);
      assert.equal(format==='http'?entry.headers.Authorization:entry.env.HARBOR_API_KEY,format==='http'?'Bearer '+authentication.key:authentication.key);
      assert(!(await page.locator('#content').textContent()).includes(authentication.key));
      const exportedClient=new Client({name:'Exported '+clientName+' '+format,version:'1'});
      const exportedTransport=format==='http'?new StreamableHTTPClientTransport(new URL(entry.url),{requestInit:{headers:entry.headers}}):new StdioClientTransport({...entry,stderr:'pipe'});try{await exportedClient.connect(exportedTransport);assert.equal((await exportedClient.listTools()).tools.length,1);}finally{if(format==='http')await exportedTransport.terminateSession();await exportedClient.close();}
      if(process.env.HARBOR_PHASE2_EVIDENCE){await fs.mkdir(process.env.HARBOR_PHASE2_EVIDENCE,{recursive:true});await page.getByLabel('Profile connection preview').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.HARBOR_PHASE2_EVIDENCE,clientName+'-'+format+'.png')});}
    }
  }
  await page.getByLabel('Client application',{exact:true}).selectOption('lmstudio');
  await page.getByLabel('Configuration format',{exact:true}).selectOption('stdio');await page.getByRole('button',{name:'Copy configuration',exact:true}).click();
  const bridgeConfig=JSON.parse(await app.evaluate(({clipboard})=>clipboard.readText())).mcpServers.harbor;
  assert.equal(bridgeConfig.env.HARBOR_API_KEY,authentication.key);
  const bridgeClient=new Client({name:'Native exported stdio profile',version:'1'});
  try{await bridgeClient.connect(new StdioClientTransport({...bridgeConfig,stderr:'pipe'}));const tools=(await bridgeClient.listTools()).tools;assert.equal(tools.length,1);const result=await bridgeClient.callTool({name:tools[0].name,arguments:{text:'exported bridge'}});assert.equal(JSON.parse(result.content[0].text).count,1);}finally{await bridgeClient.close();}
  await expect.poll(()=>page.evaluate(async()=> (await window.harbor.getProfiles()).runtimes.length)).toBe(0);
  await page.getByLabel('Configuration format',{exact:true}).selectOption('http');
  const saveFixtureKey=async value=>{
    const before=await page.evaluate(async()=> (await window.harbor.getProfiles()).profiles.find(profile=>profile.id==='native-acceptance').revision);
    await page.getByText('Profile tool delivery and search settings',{exact:true}).click();
    await page.getByLabel('Tool delivery',{exact:true}).selectOption('portkey-api');
    await page.locator('#delivery-portkeyApiKey').fill(value);
    // Save the synthetic credential without selecting an external service.
    await page.getByLabel('Tool delivery',{exact:true}).selectOption('all');
    await page.getByRole('button',{name:'Apply tool delivery',exact:true}).click();
    await expect.poll(()=>page.evaluate(async()=> (await window.harbor.getProfiles()).profiles.find(profile=>profile.id==='native-acceptance').revision)).toBeGreaterThan(before);
    await expect(page.locator('#profile-status')).toContainText('Saved delivery revision');
    return page.evaluate(async()=> (await window.harbor.getProfiles()).profiles.find(profile=>profile.id==='native-acceptance').delivery.portkeyApiKeyFile);
  };
  const oldKey=await saveFixtureKey('native-old-synthetic-key');assert.equal(await fs.readFile(oldKey,'utf8'),'native-old-synthetic-key');
  client=new Client({name:'Native revision client',version:'1'});transport=new StreamableHTTPClientTransport(new URL(copied.mcpServers.harbor.url),{requestInit:{headers:copied.mcpServers.harbor.headers}});await client.connect(transport);
  const tool=(await client.listTools()).tools[0].name;const call=await client.callTool({name:tool,arguments:{text:'native actual call'}});assert.equal(JSON.parse(call.content[0].text).count,1);
  const newKey=await saveFixtureKey('native-new-synthetic-key');assert.notEqual(newKey,oldKey);assert.equal(await fs.readFile(oldKey,'utf8'),'native-old-synthetic-key');
  await page.getByLabel('Profile name',{exact:true}).fill('Edited acceptance');await page.getByRole('button',{name:'Save profile',exact:true}).click();
  await expect(page.locator('#profile-status')).toContainText('Saved revision');
  await expect.poll(()=>page.evaluate(async()=>{const snapshot=await window.harbor.getProfiles();return snapshot.clients.find(client=>client.name==='Native revision client')?.profileRevision<snapshot.profiles.find(profile=>profile.id==='native-acceptance').revision;})).toBe(true);
  await page.getByText('Profile tool delivery and search settings',{exact:true}).click();
  await page.getByLabel('Tool delivery',{exact:true}).selectOption('hybrid');
  for(const mode of ['bm25','portkey-local'])await page.locator('#hybrid-'+mode).uncheck();
  await page.getByRole('button',{name:'Apply tool delivery',exact:true}).click();await expect(page.locator('#delivery-error')).toContainText('two distinct');
  await page.getByLabel('Tool delivery',{exact:true}).selectOption('all');await page.getByLabel('Results per search method',{exact:true}).evaluate(node=>{node.value='7';});
  await page.getByRole('button',{name:'Apply tool delivery',exact:true}).click();await expect(page.locator('#profile-status')).toContainText('Saved delivery revision');
  await page.getByRole('button',{name:'Disconnect profile sessions',exact:true}).click();await expect(page.locator('#profile-status')).toContainText('disconnected');
  await assert.rejects(client.listTools());await client.close();client=undefined;transport=undefined;
  await expect.poll(()=>fs.access(oldKey).then(()=>true,()=>false)).toBe(false);assert.equal(await fs.readFile(newKey,'utf8'),'native-new-synthetic-key');
  const box=await page.getByLabel('Include Profile fixture',{exact:true}).boundingBox();assert(box.width<=20&&box.height<=20,'Checkbox must remain a compact control');
  if(process.env.HARBOR_PHASE2_EVIDENCE){await fs.mkdir(process.env.HARBOR_PHASE2_EVIDENCE,{recursive:true});await page.locator('#content').evaluate(node=>node.scrollTop=0);await page.screenshot({path:path.join(process.env.HARBOR_PHASE2_EVIDENCE,'profiles-native.png'),fullPage:true});await page.getByLabel('Profile connection preview').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.HARBOR_PHASE2_EVIDENCE,'profiles-connection.png'),fullPage:true});}
  await close();app=await launch();page=await app.firstWindow();await expect(page.locator('#gateway-status')).toContainText('Gateway online');await page.getByRole('button',{name:'Profiles',exact:true}).click();
  await page.getByLabel('Selected profile').selectOption('native-acceptance');await expect(page.getByLabel('Profile name',{exact:true})).toHaveValue('Edited acceptance');await expect(page.getByLabel('Process ownership',{exact:true})).toHaveValue('process');
  assert.equal(await page.evaluate(async()=> (await window.harbor.getProfiles()).profiles.find(profile=>profile.id==='native-acceptance').delivery.searchLimit),7);
  assert.equal(await page.evaluate(async()=> (await window.harbor.snapshot()).servers[0].autoStart),false);
  assert.equal(await fs.readFile(newKey,'utf8'),'native-new-synthetic-key');
  await page.getByRole('button',{name:'Delete profile',exact:true}).click();await page.getByRole('button',{name:'Confirm delete',exact:true}).click();await expect(page.locator('#profile-status')).toContainText('Profile deleted');
  await expect.poll(()=>fs.access(newKey).then(()=>true,()=>false)).toBe(false);
  assert.deepEqual(errors,[]);
});
