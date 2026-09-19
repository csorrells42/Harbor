import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {_electron as electron,expect} from '@playwright/test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const root=path.resolve(process.argv[2]||'.harbor-build/Harbor Portable');
const env={...process.env,HARBOR_PORTABLE_ROOT:root,HARBOR_PORT:'0'};delete env.ELECTRON_RUN_AS_NODE;delete env.HARBOR_DATA_DIR;
const app=await electron.launch({executablePath:path.join(root,'application/initial/MCP Harbor.exe'),args:[],env});
const client=new Client({name:'Harbor Portable functional acceptance',version:'1'});let transport;
const report={observedAt:new Date().toISOString(),root,servers:[],checks:[]};
try{
  const page=await app.firstWindow();await expect(page.getByRole('button',{name:'Maintenance',exact:true})).toBeVisible();
  for(const id of ['filesystem','desktop-commander','typst-mcp','memory','sequential-thinking','fetch','git-local','serena','pdf-tools','playwright','context7','github','exa']){
    try{await page.evaluate(id=>window.harbor.startServer(id),id);const s=(await page.evaluate(()=>window.harbor.snapshot())).servers.find(s=>s.id===id);report.servers.push({id,status:s.status,tools:s.toolCount,error:s.error});}
    catch(error){report.servers.push({id,status:'failed',error:error.message});}
  }
  assert.deepEqual(report.servers.filter(s=>s.status!=='running'||!s.tools),[], 'Every selected bundled server must start and expose tools');
  const snapshot=await page.evaluate(()=>window.harbor.snapshot());transport=new StreamableHTTPClientTransport(new URL(snapshot.endpoint));await client.connect(transport);
  async function call(id,name,args){const tool=(await page.evaluate(()=>window.harbor.snapshot())).tools.find(t=>t.serverId===id&&t.originalName===name);assert(tool,`${id}/${name} missing`);const r=await client.callTool({name:tool.name,arguments:args},undefined,{timeout:60000});assert(!r.isError,JSON.stringify(r));return r.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');}
  const fixture=path.join(root,'data/workspace/Harbor portable verification.typ');
  await call('filesystem','write_file',{path:fixture,content:'#set page(paper: "a4")\n#set text(size: 12pt)\n= Harbor Portable\nThis PDF was created through the real Harbor gateway using the bundled Typst runtime.\n\n#table(columns: 2, [Component], [Verified], [Portable tools], [Yes], [PDF generation], [Yes])\n'});
  const compiled=await call('typst-mcp','doc_compile',{doc_path:fixture});report.pdfCompile=compiled;assert.match(compiled,/"success":\s*true/);
  const pdf=JSON.parse(compiled).pdf_path;assert.equal((await fs.readFile(pdf)).subarray(0,5).toString(),'%PDF-');report.pdf=pdf;
  await page.getByRole('button',{name:'Maintenance',exact:true}).click();await page.getByRole('button',{name:'Enter maintenance mode',exact:true}).click();
  await expect.poll(async()=> (await page.evaluate(()=>window.harbor.snapshot())).maintenance).toBe(true);
  assert((await page.evaluate(()=>window.harbor.snapshot())).servers.every(s=>s.status==='stopped'));report.checks.push('Actual Maintenance UI stopped all owned servers.');
  await fs.mkdir('evidence/portable',{recursive:true});await page.screenshot({path:'evidence/portable/maintenance.png'});
  await page.getByRole('button',{name:'Resume servers',exact:true}).click();await expect.poll(async()=> (await page.evaluate(()=>window.harbor.snapshot())).maintenance,{timeout:60000}).toBe(false);
  report.checks.push('Actual Maintenance UI resumed servers.');
  await page.getByRole('button',{name:'Children Servers Statuses',exact:true}).click();await page.screenshot({path:'evidence/portable/servers.png'});
  report.endpoint=snapshot.endpoint;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{
  await transport?.terminateSession().catch(()=>{});await client.close();const child=app.process();const exit=child.exitCode!==null?Promise.resolve():new Promise(r=>child.once('exit',r));await app.evaluate(({app})=>app.quit()).catch(()=>{});await exit;
  await fs.mkdir('evidence/portable',{recursive:true});await fs.writeFile('evidence/portable/native-acceptance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
