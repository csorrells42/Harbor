import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {_electron as electron,expect} from '@playwright/test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const root=path.resolve(process.argv[2]),current=JSON.parse(await fs.readFile(path.join(root,'application/current.json')));
const env={...process.env,HARBOR_PORTABLE_ROOT:root};delete env.ELECTRON_RUN_AS_NODE;delete env.HARBOR_TOOL_RUNTIME_ROOT;
const app=await electron.launch({executablePath:path.join(root,current.path,'MCP Harbor.exe'),args:[],env}),client=new Client({name:'Portable delivery acceptance',version:'1'});
let initial;
try{
  const page=await app.firstWindow();await expect(page.getByRole('button',{name:'Tool Delivery',exact:true})).toBeVisible();
  await expect.poll(async()=>{const s=await page.evaluate(()=>window.harbor.snapshot());return s.servers.filter(s=>s.autoStart).every(s=>s.status==='running');},{timeout:120000}).toBe(true);
  initial=await page.evaluate(()=>window.harbor.getSettings());const before=await page.evaluate(()=>window.harbor.snapshot());
  // Keep the saved credential outside the renderer, screenshots, and evidence output.
  const authentication=JSON.parse(await fs.readFile(path.join(root,'data/auth/gateway.json'),'utf8'));
  const headers=authentication.enabled?{Authorization:'Bearer '+authentication.key}:{};
  await client.connect(new StreamableHTTPClientTransport(new URL(before.endpoint),{requestInit:{headers}}));
  const original=before.tools.find(t=>t.serverId==='filesystem'&&t.originalName==='list_directory');assert(original,'Filesystem listing required');
  const evidence=[];
  await page.getByRole('button',{name:'Tool Delivery',exact:true}).click();
  for(const mode of ['bm25','regex','code','portkey-local','hybrid','all']){
    await page.getByLabel('Tool delivery',{exact:true}).selectOption(mode);
    await page.getByRole('button',{name:'Apply tool delivery',exact:true}).click();await expect(page.locator('#delivery-result')).toContainText('Saved.');
    const advertised=(await client.listTools()).tools,start=performance.now();
    let discovery;
    if(mode!=='all'){
      const params=mode==='code'?{name:'search',arguments:{query:'list_directory',detail:'full'}}:{name:'search_tools',arguments:mode==='regex'?{pattern:'list_directory'}:{query:'list_directory list files directory'}};
      discovery=await client.callTool(params,undefined,{timeout:120000});assert(!discovery.isError,JSON.stringify(discovery));assert(JSON.stringify(discovery).includes(original.name),JSON.stringify(discovery));
      if(mode==='hybrid'){const merged=JSON.parse(discovery.content[0].text);assert.equal(new Set(merged.tools.map(t=>t.name)).size,merged.tools.length);assert.equal(merged.warnings.length,0);}
    }
    const args={path:path.join(root,'data/workspace')};
    const params=mode==='all'?{name:original.name,arguments:args}:mode==='code'?{name:'execute',arguments:{code:`return await call_tool(${JSON.stringify(original.name)}, ${JSON.stringify(args)})`}}:{name:'call_tool',arguments:{name:original.name,arguments:args}};
    const result=await client.callTool(params,undefined,{timeout:120000});assert(!result.isError,JSON.stringify(result));
    const after=await page.evaluate(()=>window.harbor.snapshot());assert.deepEqual(after.servers.map(s=>[s.id,s.autoStart,s.pid]),before.servers.map(s=>[s.id,s.autoStart,s.pid]));
    evidence.push({mode,advertised:advertised.length,discoveryAndCallMs:Math.round(performance.now()-start),tool:original.name,success:true});
    if(mode==='hybrid'){await page.getByLabel('Tool delivery',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:'evidence/portable/delivery-live.png'});}
  }
  await fs.writeFile('evidence/portable/delivery-live.json',JSON.stringify({application:current.path,tools:before.tools.length,servers:before.servers.length,selected:before.servers.filter(s=>s.autoStart).map(s=>s.id),evidence},null,2));
  console.log(JSON.stringify(evidence));
}finally{
  if(initial)await (await app.firstWindow()).evaluate(s=>window.harbor.updateSettings(s),initial).catch(()=>{});
  await client.close();const exited=new Promise(resolve=>app.process().once('exit',resolve));await app.evaluate(({app})=>app.quit()).catch(()=>{});await exited;
}
