import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createHub} from '../src/core/hub.mjs';

test('real Hybrid search returns dormant cached tools without activating their server; selected invocation starts it once',{
  skip:!process.env.HARBOR_TOOL_RUNTIME_ROOT,timeout:90000
},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor dormant discovery ')),configPath=path.join(dir,'servers.json'),fixture=path.join(dir,'fixture.json'),events=path.join(dir,'events.jsonl');
  await fs.writeFile(fixture,JSON.stringify({events}));let hub,client,transport;
  t.after(async()=>{await transport?.terminateSession().catch(()=>{});await client?.close().catch(()=>{});await hub?.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  hub=await createHub({configPath,port:0});await hub.saveServer({id:'dormant',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/dormant-server.mjs',import.meta.url)),fixture],onDemand:true});await hub.startServer('dormant');await hub.close();
  hub=await createHub({configPath,port:0});await hub.saveProfile({id:'search',name:'Search',serverIds:['dormant'],delivery:{toolMode:'hybrid',hybridModes:['bm25','regex']}});
  client=new Client({name:'dormant Hybrid fixture',version:'1'});transport=new StreamableHTTPClientTransport(new URL(hub.endpoint+'/profiles/search'));await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),['search_tools','call_tool']);
  const result=await client.callTool({name:'search_tools',arguments:{query:'write'}});assert(!result.isError,JSON.stringify(result));const found=JSON.parse(result.content[0].text);assert.equal(found.tools.length,1);
  assert.equal(hub.snapshot().servers[0].status,'stopped');assert.equal((await fs.readFile(events,'utf8')).trim().split('\n').length,1);
  const called=await client.callTool({name:'call_tool',arguments:{name:found.tools[0].name,arguments:{value:'one dispatch'}}});assert(!called.isError,JSON.stringify(called));
  const recorded=(await fs.readFile(events,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(recorded.filter(event=>event.kind==='start').length,2);assert.equal(recorded.filter(event=>event.kind==='call').length,1);
  await hub.removeServer('dormant');const stale=await client.callTool({name:'call_tool',arguments:{name:found.tools[0].name,arguments:{value:'must not dispatch'}}});assert.equal(stale.isError,true);
  assert.equal((await fs.readFile(events,'utf8')).trim().split('\n').map(JSON.parse).filter(event=>event.kind==='call').length,1);
});
