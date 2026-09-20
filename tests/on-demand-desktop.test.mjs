import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {_electron as electron,expect} from '@playwright/test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('native activation controls preserve a dormant catalog across restart and start only for a real invocation',{
  skip:!process.env.HARBOR_TEST_ON_DEMAND,timeout:150000
},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor dormant desktop ')),data=path.join(dir,'profile');
  const env={...process.env,HARBOR_DATA_DIR:data,HARBOR_PORT:'0'};delete env.HARBOR_PORTABLE_ROOT;delete env.ELECTRON_RUN_AS_NODE;
  const launch=()=>electron.launch({args:[path.resolve(fileURLToPath(new URL('..',import.meta.url)))],env,timeout:30000});let app,client,transport,page;
  const close=async()=>{if(!app)return;const proc=app.process(),exited=new Promise(resolve=>proc.once('exit',resolve));await app.evaluate(({app})=>{setTimeout(()=>app.quit(),0);});await exited;app=undefined;};
  t.after(async()=>{await transport?.terminateSession().catch(()=>{});await client?.close().catch(()=>{});await close();await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const open=async()=>{app=await launch();page=await app.firstWindow();await expect(page.locator('#gateway-status')).toContainText('Gateway online');};await open();
  await page.evaluate(config=>window.harbor.saveServer(config),{id:'lazy-fixture',name:'Lazy fixture',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/server.mjs',import.meta.url))]});
  await page.getByRole('button',{name:'Children Servers Statuses',exact:true}).click();const card=()=>page.locator('[data-server-id="lazy-fixture"]');
  await card().getByRole('button',{name:'Configure',exact:true}).click();await expect(page.getByLabel('Enabled for use',{exact:true})).toBeChecked();
  await page.getByLabel('Eligible for on-demand start',{exact:true}).check();await page.getByLabel('On-demand idle shutdown (minutes)',{exact:true}).fill('1');
  await page.getByRole('button',{name:'Save server',exact:true}).click();await expect(page.locator('#server-dialog')).not.toBeVisible();
  await card().getByRole('button',{name:'Start',exact:true}).click();await expect(card()).toContainText('Running');
  await card().getByRole('button',{name:'Stop',exact:true}).click();await expect(card()).toContainText('On-demand suppressed by Stop');
  await close();await open();await page.getByRole('button',{name:'Children Servers Statuses',exact:true}).click();await expect(card()).toContainText('1 cached tools · on demand');
  const before=await page.evaluate(()=>window.harbor.snapshot());assert.equal(before.servers[0].status,'stopped');assert.equal(before.servers[0].autoStart,false);
  const auth=JSON.parse(await fs.readFile(path.join(data,'auth/gateway.json'),'utf8'));
  client=new Client({name:'native dormant fixture',version:'1'});transport=new StreamableHTTPClientTransport(new URL(before.endpoint),{requestInit:{headers:{Authorization:'Bearer '+auth.key}}});await client.connect(transport);
  const tools=(await client.listTools()).tools;assert.equal(tools.length,1);assert.equal((await page.evaluate(()=>window.harbor.snapshot())).servers[0].status,'stopped');
  const result=await client.callTool({name:tools[0].name,arguments:{text:'actual dormant dispatch'}});assert.equal(JSON.parse(result.content[0].text).count,1);
  await expect(card()).toContainText('idle shutdown enabled');
  if(process.env.HARBOR_PHASE2_EVIDENCE){await fs.mkdir(process.env.HARBOR_PHASE2_EVIDENCE,{recursive:true});await page.screenshot({path:path.join(process.env.HARBOR_PHASE2_EVIDENCE,'on-demand-native.png'),fullPage:true});}
  const idleStarted=Date.now(),ownedPid=JSON.parse(result.content[0].text).pid;
  await expect.poll(async()=> (await page.evaluate(()=>window.harbor.snapshot())).servers[0].status,{timeout:80000,intervals:[1000]}).toBe('stopped');
  assert(Date.now()-idleStarted>=55000,'The real one-minute idle policy must elapse');assert.throws(()=>process.kill(ownedPid,0));assert.equal((await client.listTools()).tools.length,1);
  await expect(card()).toContainText('Stopped');await expect(card()).not.toContainText('idle shutdown enabled');
  if(process.env.HARBOR_PHASE2_EVIDENCE){await fs.writeFile(path.join(process.env.HARBOR_PHASE2_EVIDENCE,'on-demand-idle.json'),JSON.stringify({idleSettingMinutes:1,observedElapsedMs:Date.now()-idleStarted,ownedPidReaped:true,cachedToolsAfterIdle:1},null,2)+'\n');await page.screenshot({path:path.join(process.env.HARBOR_PHASE2_EVIDENCE,'on-demand-idle.png'),fullPage:true});}
  // Warm activation first, then cancel a slow dispatched operation. A timeout
  // during startup alone must not be confused with an uncertain tool outcome.
  await client.callTool({name:tools[0].name,arguments:{text:'warm again'}});
  await assert.rejects(client.callTool({name:tools[0].name,arguments:{text:'uncertain',delay:3000}},undefined,{timeout:100}),/timed out/i);
  await expect(card()).toContainText('Idle shutdown paused: request outcome unknown');
  if(process.env.HARBOR_PHASE2_EVIDENCE)await page.screenshot({path:path.join(process.env.HARBOR_PHASE2_EVIDENCE,'on-demand-uncertain.png'),fullPage:true});
  await card().getByRole('button',{name:'Stop',exact:true}).click();await expect(card()).toContainText('On-demand suppressed by Stop');
  await expect.poll(async()=> (await page.evaluate(()=>window.harbor.snapshot())).servers[0].idleUncertain).toBe(false);
  await card().getByRole('button',{name:'Configure',exact:true}).click();await page.getByLabel('Eligible for on-demand start',{exact:true}).uncheck();await page.getByLabel('Enabled for use',{exact:true}).uncheck();await page.getByRole('button',{name:'Save server',exact:true}).click();
  await expect(card()).toContainText('Disabled for use');await expect(card().getByRole('button',{name:'Start',exact:true})).toBeDisabled();assert.deepEqual((await client.listTools()).tools,[]);
});
