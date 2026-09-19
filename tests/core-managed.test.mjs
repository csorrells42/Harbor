import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, persistConfigs, loadConfigs } from '../src/core/config.mjs';

import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Upstreams } from '../src/core/upstreams.mjs';
const fixture = fileURLToPath(new URL('./fixtures/managed-network.mjs', import.meta.url));
async function freePort() { const s=createServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r)); const port=s.address().port; await new Promise(r=>s.close(r)); return port; }
const alive = pid => {try {process.kill(pid,0);return true;} catch{return false;}};
async function eventually(fn, ms=10000) {const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,40));}assert.fail('Condition timed out');}
async function managed(t, transport='http', overrides={}) {
 const dir=await mkdtemp(join(tmpdir(),'harbor-owned-')); const port=await freePort();
 const spec=env=>({command:process.execPath,args:[fixture,'a b','$(literal)'],env:{PORT:String(port),OWNED_VALUE:'space ; $HOME " quote',...env},runtime:'native'});
 const config=validateConfig({id:'owned',transport,url:`http://127.0.0.1:${port}/${transport==='http'?'mcp':'sse'}`,managedProcesses:[spec({TREE_FILE:join(dir,'tree.json')}),spec({ROLE:'companion',PID_FILE:join(dir,'companion.pid')})],...overrides});
 const upstreams=new Upstreams([config],()=>{},()=>{},{requestTimeoutMs:8000});
 t.after(async()=>{await upstreams.close();await rm(dir,{recursive:true,force:true});});
 return {upstreams,config,dir,port};
}
test('owned HTTP starts two foreground processes, retries SDK readiness, and stops their tree', async t=>{
 const {upstreams,dir}=await managed(t);
 await upstreams.start('owned');
 const state=upstreams.snapshot()[0];
 assert.equal(state.ownership,'managed');assert.equal(state.processes.length,2);assert.equal(state.toolCount,1);
 const result=JSON.parse((await upstreams.get('owned').client.callTool({name:'echo',arguments:{text:'actual SDK'}})).content[0].text);
 assert.deepEqual(result.argv,['a b','$(literal)']);assert.equal(result.env,'space ; $HOME " quote');
 assert.equal(result.pid,state.processes[0].pid);
 // MCP readiness belongs to the primary; the companion can still be writing
 // its diagnostic PID file. Observe that separate fixture event explicitly.
 await eventually(async()=>{
   try{return Number(await readFile(join(dir,'companion.pid'),'utf8'))===state.processes[1].pid;}
   catch(error){if(error.code==='ENOENT')return false;throw error;}
 });
 const tree=JSON.parse(await readFile(join(dir,'tree.json'),'utf8'));const companion=Number(await readFile(join(dir,'companion.pid'),'utf8'));
 await upstreams.stop('owned');
 for(const pid of [tree.pid,tree.child,companion,...state.processes.map(p=>p.supervisorPid)])assert.equal(alive(pid),false,`PID ${pid} reaped`);
 assert.deepEqual(upstreams.snapshot()[0].processes,[]);
});

test('managed startup rejects an occupied endpoint before spawning and never stops its unrelated listener', async t=>{
 const {upstreams,dir,port}=await managed(t);
 const listener=createServer(socket=>socket.destroy());await new Promise(r=>listener.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>listener.close(r)));
 await assert.rejects(upstreams.start('owned'), /already.*use|occupied/i);
 await assert.rejects(readFile(join(dir,'tree.json')), {code:'ENOENT'});
 assert.deepEqual(upstreams.snapshot()[0].processes,[]);
 assert.equal(listener.listening,true);
});

test('a dropped managed HTTP event stream reinitializes MCP without restarting healthy owned processes',async t=>{
 const {upstreams,port}=await managed(t);await upstreams.start('owned');
 const before=upstreams.snapshot()[0],client=upstreams.get('owned').client;
 // Wait for the SDK's GET event stream, then sever the actual response socket.
 await new Promise(r=>setTimeout(r,150));
 await fetch(`http://127.0.0.1:${port}/drop-events`,{method:'POST'});
 await eventually(()=>upstreams.get('owned').client!==client&&upstreams.snapshot()[0].status==='running');
 const after=upstreams.snapshot()[0];assert.equal(after.toolCount,1);
 assert.deepEqual(after.processes.map(p=>p.pid),before.processes.map(p=>p.pid));
 const response=await upstreams.get('owned').client.callTool({name:'echo',arguments:{text:'after reconnect'}});
 assert.equal(JSON.parse(response.content[0].text).text,'after reconnect');
});

test('failed managed HTTP reconnection clears availability and reaps the owned tree',async t=>{
 const {upstreams,port}=await managed(t);await upstreams.start('owned');const before=upstreams.snapshot()[0];
 await new Promise(r=>setTimeout(r,150));
 await fetch(`http://127.0.0.1:${port}/drop-events?unavailable=1`,{method:'POST'});
 await eventually(()=>upstreams.snapshot()[0].status==='error');await upstreams.get('owned').queue;
 assert.equal(upstreams.snapshot()[0].toolCount,0);assert.deepEqual(upstreams.snapshot()[0].processes,[]);
 for(const p of before.processes)assert.equal(alive(p.pid),false);
});

test('unexpected primary exit reaps its descendant and companion before automatic restart', async t=>{
 const {upstreams,dir}=await managed(t,'http',{autoRestart:true});
 await upstreams.start('owned');
 const first=upstreams.snapshot()[0];const tree=JSON.parse(await readFile(join(dir,'tree.json'),'utf8'));
 process.kill(first.pid);
 await eventually(()=>upstreams.snapshot()[0].status==='running'&&upstreams.snapshot()[0].pid!==first.pid);
 assert.equal(alive(tree.child),false);for(const p of first.processes)assert.equal(alive(p.pid),false);
 await upstreams.remove('owned');assert.deepEqual(upstreams.snapshot(),[]);
});

test('owned SSE restart replaces both PIDs and companion exit clears tools and reaps the primary tree', async t=>{
 const {upstreams,dir}=await managed(t,'sse');await upstreams.start('owned');const first=upstreams.snapshot()[0];
 await upstreams.restart('owned');const second=upstreams.snapshot()[0];
 assert.equal(second.toolCount,1);for(const p of first.processes)assert.equal(alive(p.pid),false);assert.notEqual(first.pid,second.pid);
 const tree=JSON.parse(await readFile(join(dir,'tree.json'),'utf8'));process.kill(second.processes[1].pid);
 await eventually(()=>upstreams.snapshot()[0].status==='error');await upstreams.get('owned').queue;
 assert.deepEqual(upstreams.tools(),[]);assert.deepEqual(upstreams.snapshot()[0].processes,[]);
 for(const pid of [tree.pid,tree.child,...second.processes.map(p=>p.pid)])assert.equal(alive(pid),false);
});

test('failed readiness deadline reaps all processes and allows a subsequent corrected start', async t=>{
 const {upstreams,dir}=await managed(t);const entry=upstreams.get('owned');entry.config.managedProcesses[0].env.ROLE='companion';upstreams.requestTimeoutMs=5000;
 await assert.rejects(upstreams.start('owned'),/timed out/);
 const tree=JSON.parse(await readFile(join(dir,'tree.json'),'utf8'));const companion=Number(await readFile(join(dir,'companion.pid'),'utf8'));
 for(const pid of [tree.pid,tree.child,companion])assert.equal(alive(pid),false);
 assert.deepEqual(upstreams.snapshot()[0].processes,[]);
 delete entry.config.managedProcesses[0].env.ROLE;upstreams.requestTimeoutMs=8000;
 await upstreams.start('owned');assert.equal(upstreams.snapshot()[0].status,'running');
});

test('stop cancels managed startup and queued remove prevents a detached restart', async t=>{
 const {upstreams,dir}=await managed(t);upstreams.get('owned').config.managedProcesses[0].env.DELAY='60000';
 const start=upstreams.start('owned');const rejected=assert.rejects(start,/cancelled/);
 await eventually(async()=>{try{await readFile(join(dir,'tree.json'));return true;}catch{return false;}});
 const tree=JSON.parse(await readFile(join(dir,'tree.json'),'utf8'));
 await upstreams.stop('owned');await rejected;
 assert.equal(alive(tree.pid),false);assert.equal(alive(tree.child),false);assert.equal(upstreams.snapshot()[0].status,'stopped');
 const [removed,restarted]=await Promise.allSettled([upstreams.remove('owned'),upstreams.restart('owned')]);
 assert.equal(removed.status,'fulfilled');assert.equal(restarted.status,'rejected');assert.deepEqual(upstreams.snapshot(),[]);
});

test('companion spawn failure reaps an already-started primary tree', async t=>{
 const {upstreams,dir}=await managed(t);const entry=upstreams.get('owned');entry.config.managedProcesses[1].command='harbor-no-such-executable';
 const start=upstreams.start('owned');const rejected=assert.rejects(start,/ENOENT|exited/);await Promise.resolve();
 let launched=[];entry.startAbort.signal.addEventListener('abort',()=>{launched=(entry.owned??[]).map(p=>({...p.record}));},{once:true});
 await rejected;assert.ok(launched[0]?.pid,'The first process was spawned before companion failure');
 for(const p of launched)for(const pid of [p.pid,p.supervisorPid].filter(Boolean))assert.equal(alive(pid),false);
 // On a fast failing launch the primary may be killed before its JS imports
 // finish. If it reached the grandchild fixture, that child must also be gone.
 const tree=await readFile(join(dir,'tree.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code!=='ENOENT')throw error;});
 if(tree)assert.equal(alive(tree.child),false);assert.deepEqual(upstreams.snapshot()[0].processes,[]);
});

test('managed launches reject a native wsl wrapper that cannot guarantee Linux ownership',()=>{
 assert.throws(()=>validateConfig({id:'unsafe',url:'http://localhost/mcp',managedProcesses:[{command:'C:/Windows/System32/wsl.exe',args:['node','server.js']}]}),/managedProcesses.*runtime.*wsl/i);
});

test('graceful shutdown command completes while the owned tree is still alive',async t=>{
 const {upstreams,dir}=await managed(t);
 const acknowledgement=join(dir,'graceful.txt');
 const entry=upstreams.get('owned');
 entry.config.managedProcesses[0].gracefulStop={command:process.execPath,args:['-e',"const fs=require('fs');const tree=JSON.parse(fs.readFileSync(process.argv[1]));process.kill(tree.pid,0);fs.writeFileSync(process.argv[2],'saved before exit');",join(dir,'tree.json'),acknowledgement],timeoutMs:10000};
 await upstreams.start('owned');
 const pid=upstreams.snapshot()[0].pid;
 await upstreams.stop('owned');
 assert.equal(await readFile(acknowledgement,'utf8'),'saved before exit');assert.equal(alive(pid),false);
});

test('external HTTP stop/restart/remove changes only the connection, not the live service', async t=>{
 const {upstreams,config}=await managed(t);await upstreams.start('owned');const pid=upstreams.snapshot()[0].pid;
 const external=new Upstreams([validateConfig({id:'external',transport:'http',url:config.url,managedProcesses:[]})],()=>{});t.after(()=>external.close());
 await external.start('external');assert.equal(external.snapshot()[0].ownership,'external');assert.deepEqual(external.snapshot()[0].processes,[]);assert.equal(external.snapshot()[0].pid,undefined);
 await external.stop('external');assert.equal(alive(pid),true);await external.restart('external');assert.equal(alive(pid),true);
 await external.remove('external');assert.equal(alive(pid),true);assert.equal(upstreams.snapshot()[0].pid,pid);
});

test('managed readiness allows slow SDK discovery within the overall startup deadline',async t=>{
 const {upstreams}=await managed(t);upstreams.requestTimeoutMs=7000;upstreams.get('owned').config.managedProcesses[0].env.LIST_DELAY='1300';
 await upstreams.start('owned');assert.equal(upstreams.snapshot()[0].toolCount,1);
});

test('managed launch schema rejects explicit null instead of silently defaulting typed fields',()=>{
 for(const field of ['args','env','runtime','cwd','distro'])assert.throws(()=>validateConfig({id:'nulls',url:'http://localhost/mcp',managedProcesses:[{command:'node',[field]:null}]}),/managedProcesses/);
});

const processSpec = { command: 'node', args: ['a b', '$(not-a-shell)'], cwd: '/tmp/a b', env: { VALUE: 'a b; $HOME' }, runtime: 'wsl', distro: 'Ubuntu' };
test('managed HTTP launch array validates and persists without changing external or stdio defaults', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'harbor-managed-config-')); t.after(() => rm(dir, { recursive:true, force:true }));
  const config = validateConfig({ id:'managed', transport:'http', url:'http://127.0.0.1:4401/mcp', managedProcesses:[processSpec] });
  assert.deepEqual(config.managedProcesses, [processSpec]);
  const path = join(dir, 'servers.json'); await persistConfigs(path, [config]);
  assert.deepEqual((await loadConfigs(path))[0].managedProcesses, [processSpec]);
  assert.equal(validateConfig({id:'external',url:'http://localhost/mcp'}).managedProcesses, undefined);
  assert.deepEqual(validateConfig({id:'empty',url:'http://localhost/mcp',managedProcesses:[]}).managedProcesses, []);
  for (const managedProcesses of [{}, [null], [{command:''}], [{command:'node',args:[1]}], [{command:'node',env:{'BAD-NAME':'x'}}], [{command:'node',runtime:'docker'}], [{command:'node',distro:3}], [{command:'node',unknown:true}]]) {
    assert.throws(() => validateConfig({id:'bad',url:'http://localhost/mcp',managedProcesses}), /managedProcesses/);
  }
  assert.throws(() => validateConfig({id:'stdio',command:'node',managedProcesses:[processSpec]}), /managedProcesses.*HTTP|managedProcesses.*stdio/i);
});
