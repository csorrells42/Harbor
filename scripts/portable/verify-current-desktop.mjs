import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {_electron as electron,expect} from '@playwright/test';
const root=path.resolve(process.argv[2]);
const current=JSON.parse(await fs.readFile(path.join(root,'application/current.json')));
const env={...process.env,HARBOR_PORTABLE_ROOT:root};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.join(root,current.path,'MCP Harbor.exe'),args:[],env});
try{
  const page=await app.firstWindow();await expect(page.getByRole('button',{name:'Advisor',exact:true})).toBeVisible();
  await expect.poll(async()=>{const s=await page.evaluate(()=>window.harbor.snapshot());return s.servers.filter(x=>x.autoStart).every(x=>x.status==='running');},{timeout:120000}).toBe(true);
  const snapshot=await page.evaluate(()=>window.harbor.snapshot());
  expect(snapshot.servers).toHaveLength(19);
  expect(snapshot.maintenanceInfo.retainBackups).toBe(false);expect(snapshot.maintenanceInfo.components).toHaveLength(16);
  await page.getByRole('button',{name:'Advisor',exact:true}).click();
  for(const server of snapshot.servers){const check=page.getByLabel(`Select ${server.name}`,{exact:true});if(server.autoStart)await expect(check).toBeChecked();else await expect(check).not.toBeChecked();}
  await expect(page.locator('.advisor')).toContainText(`${snapshot.servers.filter(s=>s.autoStart).length} selected for startup · ${snapshot.servers.filter(s=>s.status==='running').length} running · ${snapshot.servers.length} configured.`);
  await page.screenshot({path:'evidence/portable/current-advisor.png'});
  await page.getByRole('button',{name:'Maintenance',exact:true}).click();
  await expect(page.getByRole('button',{name:'Restore previous',exact:true})).toHaveCount(0);
  await promisify(execFile)(path.join(root,'runtimes/node/node.exe'),['scripts/portable/verify-live.mjs',root],{cwd:process.cwd(),windowsHide:true,maxBuffer:1024*1024});
  await promisify(execFile)(path.join(root,'runtimes/node/node.exe'),['scripts/portable/verify-dbhub.mjs',root,path.join(root,'packages/dbhub'),'http://127.0.0.1:37373/mcp'],{cwd:process.cwd(),windowsHide:true,maxBuffer:1024*1024}).then(r=>fs.writeFile('evidence/portable/dbhub-gateway.json',r.stdout));
  await fs.writeFile('evidence/portable/current-desktop.json',JSON.stringify({application:current.path,servers:snapshot.servers.length,maintenanceComponents:snapshot.maintenanceInfo.components.length,selected:snapshot.servers.filter(s=>s.autoStart).map(s=>s.id),checkboxesMatchSavedPreferences:true,restorePreviousAbsent:true,success:true},null,2));
  console.log('Current packaged Harbor: saved checkboxes, DBHub SQLite operations, no restore controls and real gateway operations passed.');
}finally{
  const exited=new Promise(resolve=>app.process().once('exit',resolve));await app.evaluate(({app})=>app.quit()).catch(()=>{});await exited;
}
