import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {DEFAULT_SETTINGS} from '../src/core/settings.mjs';

test('Hybrid retains one semantic index per provider and invalidates only changed indexes',{skip:!process.env.HARBOR_TOOL_RUNTIME_ROOT,timeout:30000},async t=>{
  const root=process.env.HARBOR_TOOL_RUNTIME_ROOT;
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-semantic-cache-'));
  const key=path.join(dir,'mock.key');await fs.writeFile(key,'mock-only');
  const requests=[];let failModel;
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const data=JSON.parse(body),inputs=Array.isArray(data.input)?data.input:[data.input];
    requests.push({model:data.model,count:inputs.length});
    res.setHeader('content-type','application/json');
    if(data.model===failModel){res.writeHead(401);res.end('{"error":"mock failure"}');return;}
    res.end(JSON.stringify({data:inputs.map((_,index)=>({index,embedding:data.encoding_format==='base64'?Buffer.from(new Float32Array([1,0,0]).buffer).toString('base64'):[1,0,0]})),usage:{prompt_tokens:1,total_tokens:1}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const proc=spawn(process.execPath,[path.resolve('scripts/portable/portkey-worker.mjs'),root],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let sequence=0,stderr='';const pending=new Map();
  proc.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});
  const fail=error=>{for(const entry of pending.values())entry.reject(error);pending.clear();};
  proc.on('error',fail);proc.stdin.on('error',fail);
  proc.on('exit',()=>fail(new Error(`Semantic worker exited: ${stderr}`)));
  createInterface({input:proc.stdout}).on('line',line=>{const result=JSON.parse(line),entry=pending.get(result.id);if(!entry)return;pending.delete(result.id);result.error?entry.reject(new Error(result.error)):entry.resolve(result.result);});
  t.after(async()=>{
    if(proc.exitCode===null){const exited=new Promise(resolve=>proc.once('exit',resolve));proc.kill();await exited;}
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await fs.rm(dir,{recursive:true,force:true});
  });
  const settings={...DEFAULT_SETTINGS,toolMode:'hybrid',hybridModes:['portkey-api','portkey-workers'],semanticMinScore:0,
    portkeyApiUrl:`http://127.0.0.1:${server.address().port}/v1`,portkeyApiKeyFile:key,portkeyApiDimensions:3,
    portkeyWorkersUrl:`http://127.0.0.1:${server.address().port}/v1`,portkeyWorkersKeyFile:key,portkeyWorkersDimensions:3};
  const catalog=Array.from({length:3},(_,i)=>({name:`fixture_${i}`,serverId:'fixture',description:`Fixture tool ${i}`,inputSchema:{type:'object'}}));
  const search=(mode,options=settings,tools=catalog)=>new Promise((resolve,reject)=>{
    const id=++sequence;pending.set(id,{resolve,reject});
    proc.stdin.write(JSON.stringify({id,op:'search',mode,settings:options,tools,query:`find fixture request ${id}`})+'\n');
  });
  const counts=()=>requests.splice(0).map(({count})=>count);
  for(const mode of settings.hybridModes)await search(mode);
  assert.deepEqual(counts(),[3,1,3,1],'first searches build both indexes');
  for(const mode of settings.hybridModes)await search(mode);
  assert.deepEqual(counts(),[1,1],'unchanged Hybrid searches embed only queries');
  const changed={...settings,portkeyApiModel:'changed-model'};
  await search('portkey-api',changed);await search('portkey-workers',changed);
  assert.deepEqual(counts(),[3,1,1],'one provider setting change leaves the other index warm');
  for(const mode of settings.hybridModes)await search(mode,changed,catalog.slice(1));
  assert.deepEqual(counts(),[2,1,2,1],'catalog changes rebuild both affected indexes');
  failModel='broken-model';
  await assert.rejects(search('portkey-api',{...changed,portkeyApiModel:failModel},catalog.slice(1)),/provider request failed/i);
  counts();
  await search('portkey-workers',changed,catalog.slice(1));
  assert.deepEqual(counts(),[1],'a failed replacement does not discard the other provider index');
  await search('portkey-api',changed,catalog.slice(1));
  assert.deepEqual(counts(),[2,1],'failed provider can rebuild on a subsequent valid request');
  await search('portkey-api',{...changed,toolMode:'portkey-api'},catalog.slice(1));
  assert.deepEqual(counts(),[1]);
  await search('portkey-workers',changed,catalog.slice(1));
  assert.deepEqual(counts(),[2,1],'deselected provider is retired instead of retained indefinitely');
});
