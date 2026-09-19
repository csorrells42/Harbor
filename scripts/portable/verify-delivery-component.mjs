import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const [root,id,stage]=process.argv.slice(2),source=path.join(root,'packages/harbor-source');
process.env.HARBOR_TOOL_RUNTIME_ROOT=root;
process.env[id==='fastmcp-tools'?'HARBOR_FASTMCP_PACKAGE':'HARBOR_PORTKEY_PACKAGE']=stage;
const {createHub}=await import(pathToFileURL(path.join(source,'src/core/hub.mjs')));
const {Client}=await import(pathToFileURL(path.join(source,'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')));
const {StreamableHTTPClientTransport}=await import(pathToFileURL(path.join(source,'node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js')));
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor delivery verify '));
const hub=await createHub({configPath:path.join(dir,'servers.json'),port:0}),client=new Client({name:'Delivery build acceptance',version:'1'});
try{
  await hub.saveServer({id:'fixture',command:process.execPath,args:[path.join(source,'tests/fixtures/server.mjs')]});await hub.startServer('fixture');
  await client.connect(new StreamableHTTPClientTransport(new URL(hub.endpoint)));
  const name=(await client.listTools()).tools[0].name;
  for(const mode of id==='fastmcp-tools'?['bm25','regex','code']:['portkey-local']){
    await hub.updateSettings({...hub.getSettings(),toolMode:mode,semanticMinScore:0});
    const search=mode==='code'?{name:'search',arguments:{query:'echo'}}:{name:'search_tools',arguments:mode==='regex'?{pattern:'echo'}:{query:'repeat text'}};
    const found=await client.callTool(search);assert(!found.isError&&JSON.stringify(found).includes(name),JSON.stringify(found));
    const request=mode==='code'?{name:'execute',arguments:{code:`return await call_tool(${JSON.stringify(name)}, {"text":"verified"})`}}:{name:'call_tool',arguments:{name,arguments:{text:'verified'}}};
    const result=await client.callTool(request);assert(!result.isError&&JSON.stringify(result).includes('verified'),JSON.stringify(result));
  }
  console.log(`${id}: discovery and execution passed.`);
}finally{await client.close();await hub.close();await fs.rm(dir,{recursive:true,force:true});}
