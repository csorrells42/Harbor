import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {initializePortable,resolvePortableConfig,portableEnvironment} from '../src/core/portable.mjs';
import {createHub} from '../src/core/hub.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('portable folder moves without rewriting configs and preserves existing project state',async()=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-portable-'));
  const first=path.join(parent,'Original folder'),second=path.join(parent,'Moved ü folder');
  try{
    await fs.mkdir(first);await fs.writeFile(path.join(first,'portable.json'),JSON.stringify({version:1}));
    const config={version:1,servers:[{id:'test',command:'${HARBOR_ROOT}/runtimes/node/node.exe',args:['${HARBOR_ROOT}/packages/server.js','literal $HOME'],env:{MEMORY_FILE_PATH:'${HARBOR_ROOT}/data/memory.json'}}]};
    await fs.writeFile(path.join(first,'catalog.json'),JSON.stringify(config));await initializePortable(first);
    await fs.writeFile(path.join(first,'data/preserved.txt'),'user work');await fs.rename(first,second);await initializePortable(second);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(second,'data/servers.json'),'utf8')),config);
    const resolved=resolvePortableConfig(config.servers[0],second);
    assert.equal(resolved.command,second.replaceAll('\\','/')+'/runtimes/node/node.exe');assert.equal(resolved.args[1],'literal $HOME');
    assert.equal(await fs.readFile(path.join(second,'data/preserved.txt'),'utf8'),'user work');
    await assert.rejects(fs.access(path.join(second,'data/vault')), {code:'ENOENT'});
    const env=portableEnvironment(second,{PATH:'C:/developer/node',SystemRoot:'C:/Windows'});
    assert(!env.PATH.includes('developer'));assert(env.PATH.includes('runtimes'));assert.equal(env.HOME,path.join(second,'data/home'));
  }finally{await fs.rm(parent,{recursive:true,force:true});}
});

test('maintenance blocks gateway calls, stops only its children and resumes the same selections',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-maintenance-'));
  const configPath=path.join(dir,'servers.json');const configs={version:1,servers:[{id:'fixture',command:process.execPath,args:[path.resolve('tests/fixtures/server.mjs')],autoStart:false}]};
  await fs.writeFile(configPath,JSON.stringify(configs));const hub=await createHub({configPath,port:0});
  const client=new Client({name:'maintenance test',version:'1'});const transport=new StreamableHTTPClientTransport(new URL(hub.endpoint));
  try{
    await hub.startServer('fixture');await client.connect(transport);assert.equal((await client.listTools()).tools.length,1);
    const before=hub.snapshot().servers[0].pid;await hub.enterMaintenance();
    assert.equal(hub.snapshot().servers[0].status,'stopped');await assert.rejects(()=>hub.startServer('fixture'),/maintenance/);
    assert.equal((await fetch(hub.endpoint)).status,503);
    await hub.leaveMaintenance();assert.equal(hub.snapshot().servers[0].status,'running');assert.notEqual(hub.snapshot().servers[0].pid,before);
    assert.equal((await client.listTools()).tools.length,1);assert.deepEqual(JSON.parse(await fs.readFile(configPath,'utf8')),configs);
  }finally{await transport.terminateSession().catch(()=>{});await client.close();await hub.close();await fs.rm(dir,{recursive:true,force:true});}
});
