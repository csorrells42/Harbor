import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createGateway} from '../src/core/gateway.mjs';
import {createProfileStore} from '../src/core/profiles.mjs';
import {Upstreams} from '../src/core/upstreams.mjs';
import {DEFAULT_SETTINGS} from '../src/core/settings.mjs';
const until=async check=>{const end=Date.now()+8000;while(!await check()){if(Date.now()>end)throw Error('Admission state did not settle');await delay(10);}};
async function setup(t,options={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor admission '));
  const config={id:'one',name:'one',transport:'stdio',runtime:'native',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/server.mjs',import.meta.url))],env:{},autoStart:false,autoRestart:false,...options.config};
  const upstreams=new Upstreams([config],()=>{});if(!options.noStart)await upstreams.start('one');
  const profiles=await createProfileStore({file:path.join(dir,'profiles.json'),getConfigs:()=>[config],getSettings:()=>DEFAULT_SETTINGS});
  const gateway=await createGateway({...DEFAULT_SETTINGS,port:0,host:'127.0.0.1',upstreams,profiles,log:()=>{},...options.gateway});
  const clients=[];
  t.after(async()=>{for(const value of clients){await value.transport.terminateSession().catch(()=>{});await value.client.close().catch(()=>{});}await gateway.close();await upstreams.close();await profiles.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  async function connect(profile){const client=new Client({name:'admission test',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(gateway.endpoint+(profile?'/profiles/'+profile:'')));clients.push({client,transport});await client.connect(transport);return {client,transport};}
  return {dir,gateway,profiles,upstreams,connect};
}

test('gateway session limit and idle expiry preserve the shared process and release capacity',async t=>{
  const {gateway,connect,upstreams}=await setup(t,{gateway:{maxSessions:1,sessionIdleMs:300,sessionSweepMs:20}});
  const a=await connect(),pid=upstreams.snapshot()[0].pid;
  await assert.rejects(connect(),/429|capacity/);
  const name=(await a.client.listTools()).tools[0].name;
  const pending=a.client.callTool({name,arguments:{delay:550}});await delay(380);
  assert.equal(gateway.admission().sessions,1,'Active calls must not expire as idle');await pending;
  await until(()=>gateway.admission().sessions===0);assert.equal(upstreams.snapshot()[0].pid,pid);
  await assert.rejects(a.client.listTools());const fresh=await connect();assert.equal((await fresh.client.listTools()).tools.length,1);
});

test('bounded gateway queue expires without dispatching or retrying mutations',async t=>{
  const {gateway,connect}=await setup(t,{gateway:{schedulerLimits:{maxActive:1,maxQueued:1,maxPerSession:1,queueTimeoutMs:80}}});
  const a=await connect(),b=await connect(),name=(await a.client.listTools()).tools[0].name;
  const first=a.client.callTool({name,arguments:{delay:300}});await until(()=>gateway.admission().public.active===1);
  const queued=b.client.callTool({name,arguments:{text:'must not dispatch'}}),expired=assert.rejects(queued,/expired.*queue/i);await until(()=>gateway.admission().public.queued===1);
  await assert.rejects(b.client.callTool({name,arguments:{text:'also must not dispatch'}}),/queue is full/);
  await expired;assert.equal(JSON.parse((await first).content[0].text).count,1);
  const next=await b.client.callTool({name,arguments:{}});assert.equal(JSON.parse(next.content[0].text).count,2,'Only admitted calls may increment upstream state');
});

test('credential revocation cancels isolated initialization and reaps its child before the startup deadline',async t=>{
  // A deliberately non-MCP child reports only its test PID and never initializes.
  const {dir,gateway,profiles,connect,upstreams}=await setup(t,{noStart:true,config:{args:['-e',"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",'PLACEHOLDER']},gateway:{requestTimeoutMs:15000}});
  const pidFile=path.join(dir,'starting.pid');upstreams.get('one').config.args[2]=pidFile;
  await profiles.save({id:'isolated',name:'Isolated',serverIds:['one'],isolation:'process',delivery:{toolMode:'all'}});
  const pending=connect('isolated'),rejected=assert.rejects(pending);let pid;
  await until(async()=>{try{pid=Number(await fs.readFile(pidFile,'utf8'));return !!pid;}catch{return false;}});
  const started=Date.now();await gateway.revokePublicSessions();await rejected;await until(()=>gateway.admission().initializing===0);
  assert(Date.now()-started<6500);assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
  assert.equal(gateway.profileRuntimes().length,0);assert.equal(upstreams.snapshot()[0].status,'stopped');
});
