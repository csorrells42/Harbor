import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {_electron as electron,expect} from '@playwright/test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {fileURLToPath} from 'node:url';

test('native timeline uses real IPC, traces calls, previews/saves the exact export and persists retention', {
  skip:!process.env.HARBOR_TEST_TIMELINE,timeout:90000
},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor timeline desktop '));
  const env={...process.env,HARBOR_DATA_DIR:path.join(dir,'profile'),HARBOR_PORT:'0'};
  delete env.HARBOR_PORTABLE_ROOT;delete env.ELECTRON_RUN_AS_NODE;
  const source=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
  const launch=()=>electron.launch({args:[source],env});
  let app=await launch(),client;const errors=[];
  const close=async()=>{if(app){const child=app.process();const exited=new Promise(resolve=>child.once('exit',resolve));await app.evaluate(({app})=>{setTimeout(()=>app.quit(),0);});await exited;app=undefined;}};
  t.after(async()=>{await client?.close();await close();await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  let page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
  await expect(page.getByRole('button',{name:'Request timeline',exact:true})).toBeVisible();
  await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await page.evaluate(config=>window.harbor.saveServer(config),{id:'trace-fixture',name:'Trace fixture',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/server.mjs',import.meta.url))]});
  await page.evaluate(()=>window.harbor.startServer('trace-fixture'));
  const info=await page.evaluate(()=>window.harbor.connectionInfo());
  const authentication=JSON.parse(await fs.readFile(path.join(dir,'profile/auth/gateway.json'),'utf8'));
  client=new Client({name:'Native trace acceptance',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(info.endpoint),{requestInit:{headers:{Authorization:'Bearer '+authentication.key}}}));
  const tool=(await client.listTools()).tools[0].name;
  await page.getByRole('button',{name:'Request timeline',exact:true}).click();
  await expect(page.locator('#trace-mode')).toHaveValue('metadata');
  await client.callTool({name:tool,arguments:{text:'metadata-omits-this'}});
  await expect(page.getByLabel('Request timeline events')).toContainText('tools/call');
  assert(!(await page.getByLabel('Request timeline events').textContent()).includes('metadata-omits-this'));
  await page.getByText('Capture and retention settings',{exact:true}).click();
  await page.getByLabel('Capture mode',{exact:true}).selectOption('payload');
  await page.getByRole('button',{name:'Apply trace settings',exact:true}).click();
  await expect(page.locator('#trace-error')).toContainText('Acknowledge');
  await page.locator('#trace-payload-ack').check();
  await page.getByLabel('Retained events',{exact:true}).fill('200');
  await page.getByRole('button',{name:'Apply trace settings',exact:true}).click();
  await expect(page.locator('#trace-active')).toContainText('Payload capture is ON');
  await client.callTool({name:tool,arguments:{text:'visible payload fixture',password:'private-value'}});
  await expect(page.getByLabel('Request timeline events')).toContainText('visible payload fixture');
  if(process.env.HARBOR_PHASE2_EVIDENCE){
    await fs.mkdir(process.env.HARBOR_PHASE2_EVIDENCE,{recursive:true});
    await page.locator('#trace-settings').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(process.env.HARBOR_PHASE2_EVIDENCE,'timeline-controls.png'),fullPage:true});
  }
  await page.getByRole('button',{name:'Preview export',exact:true}).click();
  await expect(page.locator('#trace-export-preview')).toBeVisible();
  const preview=await page.getByLabel('Trace export preview').textContent();
  assert(preview.includes('visible payload fixture'));assert(!preview.includes('private-value'));assert(!preview.includes(authentication.key));
  const exported=path.join(dir,'inspected-traces.json');
  await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},exported);
  await page.getByRole('button',{name:'Save previewed export',exact:true}).click();
  await expect(page.locator('#trace-export-preview')).toContainText('Saved inspected-traces.json');
  assert.equal(await fs.readFile(exported,'utf8'),preview);
  const evidence=process.env.HARBOR_PHASE2_EVIDENCE;
  if(evidence){await fs.mkdir(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,'timeline-native.png'),fullPage:true});}
  await page.getByRole('button',{name:'Clear traces',exact:true}).click();
  await expect(page.locator('#trace-summary')).toContainText('0 retained events');
  assert.equal(await page.getByRole('button',{name:/Replay/i}).count(),0);
  await client.close();client=undefined;await close();
  app=await launch();page=await app.firstWindow();
  await page.getByRole('button',{name:'Request timeline',exact:true}).click();
  await expect(page.locator('#trace-mode')).toHaveValue('metadata');
  await expect(page.getByLabel('Retained events',{exact:true})).toHaveValue('200');
  assert.deepEqual(errors,[]);
});
