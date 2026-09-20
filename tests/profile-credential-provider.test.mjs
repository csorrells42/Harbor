import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createHub} from '../src/core/hub.mjs';

test('old and new profile revisions actually authenticate semantic requests with their retained credentials',{
  skip:!process.env.HARBOR_TOOL_RUNTIME_ROOT,timeout:45000
},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor profile provider ')),seen=[],connections=[];
  let hub;
  const provider=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),inputs=Array.isArray(body.input)?body.input:[body.input];
    seen.push(req.headers.authorization);res.setHeader('content-type','application/json');
    res.end(JSON.stringify({data:inputs.map((_,index)=>({index,embedding:body.encoding_format==='base64'?Buffer.from(new Float32Array([1,0,0]).buffer).toString('base64'):[1,0,0]})),usage:{prompt_tokens:1,total_tokens:1}}));
  });
  t.after(async()=>{
    for(const {client,transport} of connections){await transport.terminateSession().catch(()=>{});await client.close().catch(()=>{});}
    await hub?.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  hub=await createHub({configPath:path.join(dir,'servers.json'),port:0});
  await hub.saveServer({id:'fixture',name:'Fixture',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/server.mjs',import.meta.url))]});await hub.startServer('fixture');
  let profile=await hub.saveProfile({id:'provider',name:'Provider',serverIds:['fixture']});
  profile=await hub.saveProfileDelivery(profile.id,profile.revision,{settings:{toolMode:'portkey-api',portkeyApiUrl:`http://127.0.0.1:${provider.address().port}/v1`,portkeyApiDimensions:3,semanticMinScore:0},credentials:{portkeyApi:'old-synthetic-provider-key'}});
  const oldFile=profile.delivery.portkeyApiKeyFile;
  async function connect(){const client=new Client({name:'credential provider fixture',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(hub.endpoint+'/profiles/provider'));await client.connect(transport);const connection={client,transport};connections.push(connection);return connection;}
  const old=await connect();
  profile=await hub.saveProfileDelivery(profile.id,profile.revision,{credentials:{portkeyApi:'new-synthetic-provider-key'}});const currentFile=profile.delivery.portkeyApiKeyFile;
  const fresh=await connect();await hub.collectProfileCredentials();
  let sequence=0;
  async function search(client,expected){
    seen.length=0;const result=await client.callTool({name:'search_tools',arguments:{query:'echo a fixture value '+(++sequence)}});
    assert(!result.isError,JSON.stringify(result));assert.equal(JSON.parse(result.content[0].text).tools.length,1);
    assert(seen.length>0);assert(seen.every(value=>value===expected));
  }
  // Start the old revision's worker only after rotation: it must still be able
  // to read and use its key, not merely rely on a credential cached in memory.
  await search(old.client,'Bearer old-synthetic-provider-key');await search(fresh.client,'Bearer new-synthetic-provider-key');
  await old.transport.terminateSession();await old.client.close();
  // MCP termination acknowledges the session before asynchronous worker reaping.
  // Its key must be collected only after that retirement finishes.
  const deadline=Date.now()+5000;
  while(await fs.access(oldFile).then(()=>true,()=>false)){assert(Date.now()<deadline,'Retired provider key must be collected after worker shutdown');await delay(20);}
  await search(fresh.client,'Bearer new-synthetic-provider-key');await fs.access(currentFile);
  await hub.removeProfile(profile.id,{expectedRevision:profile.revision});await assert.rejects(fs.access(currentFile));
});
