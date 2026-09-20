import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createHub} from '../src/core/hub.mjs';

const output=process.argv[2];if(!output)throw new Error('Supply an output JSON path');
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor trace benchmark '));
let hub,client;
try{
 hub=await createHub({configPath:path.join(dir,'servers.json'),port:0});
 await hub.saveServer({id:'fixture',command:process.execPath,args:[fileURLToPath(new URL('../tests/fixtures/server.mjs',import.meta.url))]});
 await hub.startServer('fixture');
 client=new Client({name:'Trace overhead measurement',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(hub.endpoint)));
 const name=(await client.listTools()).tools[0].name,request={name,arguments:{text:'Synthetic tracing workload '+'.'.repeat(256)}};
 for(let i=0;i<30;i++)await client.callTool(request);
 const rounds=[],orders=[['off','metadata','payload'],['payload','off','metadata'],['metadata','payload','off']];
 for(let round=0;round<orders.length;round++)for(const mode of orders[round]){
   await hub.updateTraceSettings({...hub.traceSnapshot().settings,mode});hub.clearTraces();
   const samples=[],cpu=process.cpuUsage(),rssStart=process.memoryUsage().rss;
   for(let i=0;i<150;i++){const start=performance.now();const result=await client.callTool(request);if(result.isError)throw new Error('Fixture call failed');samples.push(performance.now()-start);}
   const used=process.cpuUsage(cpu);samples.sort((a,b)=>a-b);
   rounds.push({round:round+1,mode,calls:samples.length,medianMs:samples[Math.floor(samples.length/2)],p95Ms:samples[Math.ceil(samples.length*.95)-1],cpuMs:(used.user+used.system)/1000,rssStart,rssEnd:process.memoryUsage().rss,traceBytes:hub.traceSnapshot().bytes,retainedEvents:hub.traceSnapshot().total});
 }
 const modes=['off','metadata','payload'].map(mode=>{const rows=rounds.filter(r=>r.mode===mode);return {mode,calls:rows.reduce((n,r)=>n+r.calls,0),meanRoundMedianMs:rows.reduce((n,r)=>n+r.medianMs,0)/rows.length,meanRoundP95Ms:rows.reduce((n,r)=>n+r.p95Ms,0)/rows.length};});
 const baseline=modes[0];for(const mode of modes.slice(1)){mode.medianDeltaMs=mode.meanRoundMedianMs-baseline.meanRoundMedianMs;mode.p95DeltaMs=mode.meanRoundP95Ms-baseline.meanRoundP95Ms;}
 const report={schemaVersion:1,measuredAt:new Date().toISOString(),workload:'1350 sequential loopback MCP echo calls; 30 warmups; 3 balanced-order rounds; no inference or external services',hardware:{platform:process.platform,arch:process.arch,node:process.version,cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalMemoryBytes:os.totalmem()},scope:'Latency includes client/gateway/fixture IPC. CPU and RSS are for the benchmark/gateway Node process, not the child or a model. RSS includes GC variance. These short local samples are not throughput or soak acceptance.',rounds,modes};
 await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(modes));
}finally{await client?.close();await hub?.close();await fs.rm(dir,{recursive:true,force:true});}
