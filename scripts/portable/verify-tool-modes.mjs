import {createHub} from '../../src/core/hub.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(process.argv[2]);process.env.HARBOR_TOOL_RUNTIME_ROOT=root;
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor tool modes '));
const hub=await createHub({configPath:path.join(dir,'servers.json'),port:0});
const client=new Client({name:'Harbor mode verification',version:'1'});
try{
  await hub.saveServer({id:'fixture',command:process.execPath,args:[path.resolve('tests/fixtures/server.mjs')],autoStart:false});await hub.startServer('fixture');
  await client.connect(new StreamableHTTPClientTransport(new URL(hub.endpoint)));
  const original=(await client.listTools()).tools[0],pid=hub.snapshot().servers[0].pid;
  for(const mode of ['bm25','regex','code','all']){
    await hub.updateSettings({...hub.getSettings(),toolMode:mode});
    const tools=(await client.listTools()).tools;console.log(JSON.stringify({mode,tools:tools.map(t=>({name:t.name,inputSchema:t.inputSchema,description:mode==='code'?t.description:undefined}))}));
    const call=async(name,args)=>{const r=await client.callTool({name,arguments:args},undefined,{timeout:60000});assert(!r.isError,JSON.stringify(r));return r;};
    if(mode==='bm25'||mode==='regex'){
      const found=await call('search_tools',mode==='bm25'?{query:'echo text'}:{pattern:'echo'});assert(JSON.stringify(found).includes(original.name));
      const result=await call('call_tool',{name:original.name,arguments:{text:`verified ${mode}`}});assert(JSON.stringify(result).includes(`verified ${mode}`));
    }else if(mode==='code'){
      await call('search',{query:'echo'});await call('get_schema',{tools:[original.name]});
      const result=await call('execute',{code:`a = await call_tool(${JSON.stringify(original.name)}, {"text": "first"})\nb = await call_tool(${JSON.stringify(original.name)}, {"text": "verified code"})\nreturn b`});assert(JSON.stringify(result).includes('verified code'));
    }else{assert.equal(tools[0].name,original.name);assert(JSON.stringify(await call(original.name,{text:'verified all'})).includes('verified all'));}
    assert.equal(hub.snapshot().servers[0].pid,pid);assert.equal(JSON.parse(await fs.readFile(path.join(dir,'harbor-settings.json'))).toolMode,mode);
  }
  console.log('PASS: all four modes called the same live server; settings were saved.');
}catch(error){console.error(error);console.error(hub.snapshot().logs.slice(-8));process.exitCode=1;}
finally{await client.close();await hub.close();}
