// Opt-in, real Windows→Ubuntu WSL lifecycle verification. No server downloads.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHub } from '../src/core/hub.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
assert.equal(process.platform,'win32','Run this verification from Windows');
const root=fileURLToPath(new URL('../',import.meta.url));
const linuxRoot=execFileSync('wsl.exe',['-d','Ubuntu','--exec','wslpath','-a',root],{encoding:'utf8'}).trim();
const data=await mkdtemp(path.join(tmpdir(),'harbor-wsl-'));
const hub=await createHub({configPath:path.join(data,'config.json'),port:0});
const client=new Client({name:'actual-wsl-verification',version:'1'});
const pids=[];
try {
  await hub.saveServer({id:'ubuntu',name:'Real Ubuntu fixture',transport:'stdio',runtime:'wsl',distro:'Ubuntu',command:'node',args:[`${linuxRoot}tests/fixtures/server.mjs`,'argument with spaces'],cwd:linuxRoot,env:{HARBOR_TEST:'WSL value with spaces'},autoStart:false,autoRestart:false});
  await hub.startServer('ubuntu');
  await client.connect(new StreamableHTTPClientTransport(new URL(hub.endpoint)));
  const tools=await client.listTools();assert.equal(tools.tools.length,1);
  let result=JSON.parse((await client.callTool({name:tools.tools[0].name,arguments:{text:'WSL works'}})).content[0].text);
  assert.equal(result.text,'WSL works');assert.equal(result.env,'WSL value with spaces');assert.deepEqual(result.argv,['argument with spaces']);pids.push(result.pid);
  await hub.restartServer('ubuntu');
  result=JSON.parse((await client.callTool({name:tools.tools[0].name,arguments:{text:'restarted'}})).content[0].text);
  assert.notEqual(result.pid,pids[0]);pids.push(result.pid);
  await hub.stopServer('ubuntu');
  for(const pid of pids){const check=spawnSync('wsl.exe',['-d','Ubuntu','--exec','kill','-0',String(pid)]);assert.notEqual(check.status,0,`Linux server PID ${pid} should be stopped`);}
  console.log(JSON.stringify({result:'PASS',runtime:'Windows → Ubuntu WSL',cwd:result.cwd,oldPid:pids[0],newPid:pids[1],checks:['initialize','list tools','call tool','env and argv preservation','restart','stop','Linux process cleanup']},null,2));
} finally {await client.close();await hub.close();await rm(data,{recursive:true,force:true});}
