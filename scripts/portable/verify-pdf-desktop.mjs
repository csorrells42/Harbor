import fs from 'node:fs/promises';
import path from 'node:path';
import {_electron as electron,expect} from '@playwright/test';
const root=path.resolve(process.argv[2]);
const current=JSON.parse(await fs.readFile(path.join(root,'application/current.json')));
const env={...process.env,HARBOR_PORTABLE_ROOT:root};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.join(root,current.path,'MCP Harbor.exe'),args:[],env});
try{
  const page=await app.firstWindow();
  await expect(page.getByRole('button',{name:'Children Servers Statuses',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Children Servers Statuses',exact:true}).click();
  await expect.poll(async()=>{const s=await page.evaluate(()=>window.harbor.snapshot());return s.servers.find(s=>s.id==='pdf-tools')?.status;},{timeout:60000}).toBe('running');
  const snapshot=await page.evaluate(()=>window.harbor.snapshot());
  expect(snapshot.servers.find(s=>s.id==='typst-mcp').status).toBe('running');
  await page.screenshot({path:'evidence/portable/pdf-desktop.png'});
  await fs.writeFile('evidence/portable/pdf-desktop.json',JSON.stringify({application:current.path,servers:snapshot.servers.map(s=>({id:s.id,status:s.status})),maintenance:snapshot.maintenanceInfo.components.map(c=>c.id)},null,2));
  console.log('Packaged desktop: PDF Tools and Typst running.');
}finally{
  const process=app.process();const exited=new Promise(r=>process.once('exit',r));
  await app.evaluate(({app})=>app.quit()).catch(()=>{});await exited;
}
