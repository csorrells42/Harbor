import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createHub} from '../src/core/hub.mjs';
import {DEFAULT_SETTINGS,validateSettings,loadSettings} from '../src/core/settings.mjs';

test('legacy settings retain All tools and invalid delivery modes are rejected',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor legacy mode '));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const old={...DEFAULT_SETTINGS};delete old.toolMode;await fs.writeFile(path.join(dir,'settings.json'),JSON.stringify(old));
  assert.equal((await loadSettings(path.join(dir,'settings.json'))).toolMode,'all');
  for(const toolMode of ['unknown',null,{},1])assert.throws(()=>validateSettings({...DEFAULT_SETTINGS,toolMode}),/toolMode/);
});

test('FastMCP modes share children, refresh catalogs, preserve errors and survive restart',{skip:!process.env.HARBOR_TOOL_RUNTIME_ROOT},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor delivery ')),configPath=path.join(dir,'servers.json');
  let hub=await createHub({configPath,port:0});
  const clients=[];t.after(async()=>{for(const c of clients)await c.close();await hub.close();await fs.rm(dir,{recursive:true,force:true});});
  const connect=async()=>{const c=new Client({name:'mode test',version:'1'});await c.connect(new StreamableHTTPClientTransport(new URL(hub.endpoint)));clients.push(c);return c;};
  await hub.saveServer({id:'fixture',command:process.execPath,args:[path.resolve('tests/fixtures/server.mjs')],autoStart:true});await hub.startServer('fixture');
  const first=await connect(),second=await connect(),original=(await first.listTools()).tools[0],pid=hub.snapshot().servers[0].pid;
  const ok=async(c,name,args)=>{const r=await c.callTool({name,arguments:args});assert(!r.isError,JSON.stringify(r));return r;};
  for(const mode of ['bm25','regex','code']){
    await hub.updateSettings({...hub.getSettings(),toolMode:mode});
    const names=(await first.listTools()).tools.map(t=>t.name);
    assert.deepEqual(names,mode==='code'?['search','get_schema','execute']:['search_tools','call_tool']);
    assert.deepEqual((await second.listTools()).tools.map(t=>t.name),names);
    if(mode==='code'){
      const result=await ok(first,'execute',{code:`a = await call_tool(${JSON.stringify(original.name)}, {"text":"one"})\nb = await call_tool(${JSON.stringify(original.name)}, {"text":"two"})\nreturn [a,b]`});assert(JSON.stringify(result).includes('two'));
    }else{
      const result=await ok(first,'search_tools',mode==='bm25'?{query:'echo text'}:{pattern:'echo'});assert(JSON.stringify(result).includes(original.name));
      const error=await first.callTool({name:'call_tool',arguments:{name:original.name,arguments:{fail:true}}});assert(error.isError);
      const unknown=await first.callTool({name:'call_tool',arguments:{name:'not_a_tool',arguments:{}}});assert(unknown.isError);
      if(mode==='regex'){
        const invalid=await ok(first,'search_tools',{pattern:'['});assert(!JSON.stringify(invalid).includes(original.name));
        await ok(first,'call_tool',{name:original.name,arguments:{change:true}});
        let found;for(let i=0;i<30;i++){found=await ok(second,'search_tools',{pattern:'new_tool'});if(JSON.stringify(found).includes('new_tool'))break;await new Promise(r=>setTimeout(r,100));}assert(JSON.stringify(found).includes('new_tool'));
      }
    }
    assert.equal(hub.snapshot().servers[0].pid,pid);
  }
  await hub.updateSettings({...hub.getSettings(),toolMode:'hybrid',hybridModes:['bm25','regex','code','portkey-local'],semanticMinScore:0});
  const hybrid=await ok(first,'search_tools',{query:'echo text'}),merged=JSON.parse(hybrid.content[0].text);
  const match=merged.tools.find(t=>t.name===original.name);assert(match,JSON.stringify(merged));assert.deepEqual([...match.matchedBy].sort(),['bm25','code','portkey-local','regex']);assert.equal(merged.warnings.length,0);
  assert.equal(merged.tools.filter(t=>t.name===original.name).length,1);
  assert.deepEqual((await first.listTools()).tools.map(t=>t.name),['search_tools','call_tool','get_schema','execute']);
  assert(JSON.stringify(await ok(first,'execute',{code:`return await call_tool(${JSON.stringify(original.name)}, {"text":"hybrid works"})`})).includes('hybrid works'));
  await hub.enterMaintenance();await hub.leaveMaintenance();
  assert(JSON.stringify(await ok(first,'search_tools',{query:'echo'})).includes(original.name));
  await hub.updateSettings({...hub.getSettings(),toolMode:'bm25'});
  await hub.stopServer('fixture');
  assert(!JSON.stringify(await ok(first,'search_tools',{query:'echo'})).includes(original.name));
  for(const c of clients)await c.close();clients.length=0;await hub.close();
  hub=await createHub({configPath,port:0});assert.equal(hub.getSettings().toolMode,'bm25');
  const restarted=await connect();assert.deepEqual((await restarted.listTools()).tools.map(t=>t.name),['search_tools','call_tool']);
  await hub.updateSettings({...hub.getSettings(),toolMode:'all'});
  assert((await restarted.listTools()).tools.every(t=>!['search_tools','call_tool'].includes(t.name)));
});
