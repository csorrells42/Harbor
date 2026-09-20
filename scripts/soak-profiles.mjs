// Explicit engineering acceptance; no installed profile or model is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createHub} from '../src/core/hub.mjs';

const [output,cyclesText='100']=process.argv.slice(2),cycles=Number(cyclesText);
if(!output||!Number.isInteger(cycles)||cycles<3||cycles>1000)throw Error('Usage: node scripts/soak-profiles.mjs <new-report.json> [3–1000 cycles]');
const reportHandle=await fs.open(path.resolve(output),'wx');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor profile soak '));
const samples=[],latencies=[],report={startedAt:new Date().toISOString(),requestedCycles:cycles,scope:'Synthetic loopback source acceptance, shared/isolated sessions, concurrent calls, profile revisions, process restarts and trace bounds. RSS is this Node gateway/driver only, not the complete process tree.',node:process.version,platform:process.platform,hardware:{cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalRamBytes:os.totalmem()},samples};
let hub,connections=[];
const until=async predicate=>{const end=Date.now()+6000;while(!await predicate()){if(Date.now()>end)throw Error('Owned session/process did not settle');await delay(20);}};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
const close=async connection=>{await connection.transport.terminateSession().catch(()=>{});await connection.client.close();connections=connections.filter(value=>value!==connection);};
async function connect(id){const client=new Client({name:'soak '+id,version:'1'}),transport=new StreamableHTTPClientTransport(new URL(hub.endpoint+'/profiles/'+id)),connection={client,transport};connections.push(connection);await client.connect(transport);connection.tool=(await client.listTools()).tools[0].name;return connection;}
async function call(connection,text,pause=0){const start=performance.now(),result=await connection.client.callTool({name:connection.tool,arguments:{text,delay:pause}});latencies.push(performance.now()-start);assert(!result.isError);return JSON.parse(result.content[0].text);}
try{
  report.sourceFiles=[];
  for(const name of ['scripts/soak-profiles.mjs','src/core/hub.mjs','src/core/gateway.mjs','src/core/profiles.mjs','src/core/profile-runtime.mjs','src/core/profile-contexts.mjs','src/core/upstreams.mjs','src/core/request-traces.mjs','src/core/request-scheduler.mjs','tests/fixtures/server.mjs'])report.sourceFiles.push({name,sha256:createHash('sha256').update(await fs.readFile(new URL('../'+name,import.meta.url))).digest('hex')});
  hub=await createHub({configPath:path.join(root,'servers.json'),port:0});
  await hub.saveServer({id:'fixture',name:'Soak fixture',command:process.execPath,args:[fileURLToPath(new URL('../tests/fixtures/server.mjs',import.meta.url))],autoStart:false,autoRestart:false});await hub.startServer('fixture');
  for(const isolation of ['shared','process'])await hub.saveProfile({id:isolation,name:isolation,serverIds:['fixture'],isolation,delivery:{toolMode:'all'}});
  await hub.updateTraceSettings({mode:'metadata',maxEvents:100,maxBytes:65536});
  let sharedCount=0;
  for(let cycle=0;cycle<cycles;cycle++){
    const sharedPid=hub.snapshot().servers.find(server=>server.id==='fixture').pid;
    const a=await connect('shared'),b=await connect('process');
    const values=await Promise.all([call(a,`shared-${cycle}`),call(b,`isolated-${cycle}`)]);
    assert.equal(values[0].pid,sharedPid);assert.equal(values[0].count,++sharedCount);assert.notEqual(values[1].pid,sharedPid);assert.equal(values[1].count,1);
    const isolatedPid=values[1].pid,profile=hub.getProfile('shared'),pending=call(a,`during-edit-${cycle}`,30);
    await hub.saveProfile({...profile,name:'Shared revision '+cycle},{expectedRevision:profile.revision});
    assert.equal((await pending).count,++sharedCount);
    assert.equal(hub.getProfiles().clients.find(client=>client.name==='soak shared').profileRevision,profile.revision);
    await close(a);await close(b);await until(()=>hub.getProfiles().runtimes.length===0&&!alive(isolatedPid));
    const state=hub.getProfiles();assert.equal(state.clients.length,0);assert.equal(state.admission.public.active,0);assert.equal(state.admission.public.queued,0);
    const trace=hub.traceSnapshot();assert(trace.total<=100);assert(trace.bytes<=65536);
    if((cycle+1)%10===0){await hub.restartServer('fixture');await until(()=>!alive(sharedPid));sharedCount=0;}
    samples.push({cycle:cycle+1,at:new Date().toISOString(),rssBytes:process.memoryUsage().rss,heapUsedBytes:process.memoryUsage().heapUsed,traceEvents:trace.total,traceBytes:trace.bytes,activeSessions:state.clients.length,privateRuntimes:state.runtimes.length});
    if((cycle+1)%10===0)console.log(JSON.stringify(samples.at(-1)));
  }
  report.status='passed';report.completedCycles=samples.length;report.calls=latencies.length;
}catch(error){report.status='failed';report.error=error.stack;process.exitCode=1;}
finally{
  const finalPids=[...new Set([...(hub?.snapshot().servers??[]),...(hub?.getProfiles().runtimes??[]).flatMap(runtime=>runtime.servers)].map(server=>server.pid).filter(Number.isInteger))];
  try{
    for(const connection of [...connections])await close(connection).catch(()=>{});
    await hub?.close();await until(()=>finalPids.every(pid=>!alive(pid)));report.cleanupVerified=true;
  }catch(error){report.cleanupVerified=false;report.cleanupError=error.stack;report.status='failed';process.exitCode=1;}
  report.endedAt=new Date().toISOString();const sorted=[...latencies].sort((a,b)=>a-b);report.medianMs=sorted[Math.ceil(sorted.length*.5)-1]??null;report.p95Ms=sorted[Math.ceil(sorted.length*.95)-1]??null;report.peakRssBytes=Math.max(0,...samples.map(sample=>sample.rssBytes));
  await reportHandle.writeFile(JSON.stringify(report,null,2)+'\n');await reportHandle.close();
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));if(report.cleanupVerified)await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  console.log(JSON.stringify({status:report.status,cycles:report.completedCycles,calls:report.calls,medianMs:report.medianMs,p95Ms:report.p95Ms,peakRssBytes:report.peakRssBytes,cleanupVerified:report.cleanupVerified,error:report.error}));
}
