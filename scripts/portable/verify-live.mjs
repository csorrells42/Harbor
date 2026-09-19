import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const root=path.resolve(process.argv[2]),endpoint=process.argv[3]||'http://127.0.0.1:37373/mcp';
const client=new Client({name:'Harbor Portable final launch acceptance',version:'1'});
const transport=new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:process.env.HARBOR_API_KEY?{Authorization:'Bearer '+process.env.HARBOR_API_KEY}:{}}});
const report={observedAt:new Date().toISOString(),root,endpoint,checks:[]};
const fixture=http.createServer((_req,res)=>res.writeHead(200,{'Content-Type':'text/html'}).end('<h1>Harbor Portable browser verified</h1>'));
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
const outside=path.join(os.tmpdir(),`harbor-portable-access-${Date.now()}.txt`);
try{
  await client.connect(transport);
  const selected=JSON.parse(await fs.readFile(path.join(root,'data/servers.json'),'utf8')).servers.filter(s=>s.autoStart).map(s=>s.id);
  let tools;const until=Date.now()+120000;
  do{tools=(await client.listTools()).tools;if(selected.every(id=>tools.some(t=>t.name.startsWith(id+'__'))))break;await new Promise(r=>setTimeout(r,1000));}while(Date.now()<until);
  assert(selected.every(id=>tools.some(t=>t.name.startsWith(id+'__'))),'An automatically selected server did not expose tools');
  report.tools=tools.length;report.servers=selected;
  async function call(id,name,args){const tool=tools.find(t=>t.name.startsWith(`${id}__${name}__`));assert(tool,`${id}/${name} missing`);const result=await client.callTool({name:tool.name,arguments:args},undefined,{timeout:120000});assert(!result.isError,JSON.stringify(result));return result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');}
  await call('filesystem','write_file',{path:outside,content:'Harbor Portable can write outside its workspace.'});
  assert.equal(await fs.readFile(outside,'utf8'),'Harbor Portable can write outside its workspace.');report.checks.push('Filesystem wrote a real file outside the portable folder.');
  const command=await call('desktop-commander','start_process',{command:'cmd.exe /d /c echo HARBOR_PORTABLE_EXEC_OK',timeout_ms:10000});assert(command.includes('HARBOR_PORTABLE_EXEC_OK'));report.checks.push('Desktop Commander launched a Windows executable.');
  await call('playwright','browser_navigate',{url:`http://127.0.0.1:${fixture.address().port}`});
  const browser=await call('playwright','browser_evaluate',{function:'() => document.body.innerText'});assert(browser.includes('Harbor Portable browser verified'),browser.slice(0,3000));await call('playwright','browser_close',{});report.checks.push('Bundled Chromium rendered a real local page through Playwright MCP.');
  const source=path.join(root,'data/workspace/Harbor Portable verification.typ');
  await call('filesystem','write_file',{path:source,content:'= Harbor Portable\nVerified through the desktop-launched Harbor gateway.\n\nExternal file access, executable launching, Chromium, and PDF creation are working.'});
  const pdf=JSON.parse(await call('typst-mcp','doc_compile',{doc_path:source}));assert(pdf.success);assert.equal((await fs.readFile(pdf.pdf_path)).subarray(0,5).toString(),'%PDF-');
  report.pdf=path.join(root,'data/workspace/Harbor Portable verification.pdf');await fs.copyFile(pdf.pdf_path,report.pdf);report.checks.push('Typst created a real PDF through the final gateway.');
  if(tools.some(t=>t.name.startsWith('github__get_me__'))){await call('github','get_me',{});report.checks.push('GitHub completed an authenticated current-user API request.');}
  report.application=JSON.parse(await fs.readFile(path.join(root,'application/current.json'),'utf8')).path;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{await fs.unlink(outside).catch(()=>{});await transport.terminateSession().catch(()=>{});await client.close();fixture.close();await fs.writeFile('evidence/portable/final-launch.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
