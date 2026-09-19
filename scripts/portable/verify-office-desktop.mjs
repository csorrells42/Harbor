import fs from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {_electron as electron,expect} from '@playwright/test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(process.argv[2]);
const current=JSON.parse(await fs.readFile(path.join(root,'application/current.json')));
const env={...process.env,HARBOR_PORTABLE_ROOT:root};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.join(root,current.path,'MCP Harbor.exe'),args:[],env});
const ids=['duckdb','markitdown','excel','word'],report={application:current.path,components:{}};
try{
  const page=await app.firstWindow();await expect(page.getByRole('button',{name:'Advisor',exact:true})).toBeVisible();
  const before=await page.evaluate(()=>window.harbor.snapshot());
  for(const id of ids){expect(before.servers.find(s=>s.id===id).autoStart).toBe(false);expect(before.maintenanceInfo.components.some(c=>c.id===id)).toBe(true);}
  await page.getByRole('button',{name:'Children Servers Statuses',exact:true}).click();
  for(const id of ids){
    await page.evaluate(id=>window.harbor.startServer(id),id);
    await expect.poll(async()=>{const s=await page.evaluate(()=>window.harbor.snapshot());return s.servers.find(s=>s.id===id)?.status;},{timeout:60000}).toBe('running');
    const {stdout}=await promisify(execFile)(path.join(root,'runtimes/node/node.exe'),['scripts/portable/verify-office-tools.mjs',root,id,path.join(root,'packages',id),before.endpoint],{cwd:process.cwd(),windowsHide:true,maxBuffer:1024*1024});
    const proof=JSON.parse(stdout);expect(proof.success).toBe(true);report.components[id]=proof;
    await fs.writeFile(`evidence/portable/${id}-gateway.json`,JSON.stringify(proof,null,2));
  }
  const wordCard=page.getByRole('heading',{name:'Word Documents',exact:true});await wordCard.scrollIntoViewIfNeeded();await expect(wordCard).toBeVisible();
  await page.screenshot({path:'evidence/portable/office-desktop.png'});
  const word=report.components.word.document;
  const client=new Client({name:'Harbor document roundtrip',version:'1'});
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL(before.endpoint)));
    const digest=createHash('sha256').update(JSON.stringify(['markitdown','convert_to_markdown'])).digest('hex').slice(0,16);
    const tool=(await client.listTools()).tools.find(t=>t.name.endsWith('__'+digest));
    const result=await client.callTool({name:tool.name,arguments:{uri:pathToFileURL(word).href}});
    expect(result.isError).not.toBe(true);const text=result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');expect(text).toContain('Harbor Report');expect(text).toContain('Working');
    report.wordToMarkdown=true;
  }finally{await client.close();}
  for(const id of ids)await page.evaluate(id=>window.harbor.stopServer(id),id);
  const after=await page.evaluate(()=>window.harbor.snapshot());
  for(const id of ids){expect(after.servers.find(s=>s.id===id).status).toBe('stopped');expect(after.servers.find(s=>s.id===id).autoStart).toBe(false);}
  report.success=true;await fs.writeFile('evidence/portable/office-desktop.json',JSON.stringify(report,null,2));console.log('Four office servers passed real gateway operations; Word output converted through MarkItDown. On-demand defaults restored.');
}finally{
  const child=app.process();const exited=new Promise(r=>child.once('exit',r));await app.evaluate(({app})=>app.quit()).catch(()=>{});await exited;
}
