import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const pdf=path.resolve(process.argv[2]);await fs.access(pdf);
const client=new Client({name:'Harbor PDF opening acceptance',version:'1'});
const transport=new StreamableHTTPClientTransport(new URL('http://127.0.0.1:37373/mcp'));
try{
  await client.connect(transport);
  const tool=(await client.listTools()).tools.find(t=>t.name.startsWith('desktop-commander__start_process__'));assert(tool);
  const result=await client.callTool({name:tool.name,arguments:{command:`powershell.exe -NoProfile -WindowStyle Hidden -Command "$ErrorActionPreference='Stop'; Start-Process -FilePath '${pdf.replaceAll("'","''")}'; Write-Output HARBOR_PDF_OPENED"`,timeout_ms:10000}});
  const output=result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');assert(!result.isError&&output.includes('HARBOR_PDF_OPENED'),output);
  console.log('Windows accepted the PDF open request through Desktop Commander.');
}finally{await transport.terminateSession().catch(()=>{});await client.close();}
