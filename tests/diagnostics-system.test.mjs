import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {cpuTotals,cpuUsage,parseGpuCsv,createSystemMonitor} from '../src/diagnostics/system-monitor.mjs';

test('CPU aggregates every logical processor and GPU parsing keeps unavailable sensors unknown',()=>{
  const before=cpuTotals([{times:{user:100,idle:100}},{times:{user:100,idle:100}}]);
  const after=cpuTotals([{times:{user:200,idle:100}},{times:{user:100,idle:200}}]);assert.equal(cpuUsage(before,after),50);assert.equal(cpuUsage(after,after),null);
  const rows=parseGpuCsv('0, RTX fixture, 0, 16384, 4096, 42, 33.5, [N/A], 610.74\n1, Second GPU, 80, 8192, [Not Supported], 65, 100, 40, 610.74');
  assert.equal(rows[0].utilizationPercent,0);assert.equal(rows[0].fanPercent,null);assert.equal(rows[1].memoryUsedMiB,null);assert.throws(()=>parseGpuCsv('unexpected format'));
});
test('system monitor coalesces queries, refreshes on demand and clears failed GPU values',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'harbor-system-monitor-'));let now=100000,user=0,failGpu=false,calls=[];
  const monitor=createSystemMonitor({dataDir:dir,temperatureBackground:false,clock:()=>now,cpuReader:()=>[{model:'fixture CPU',times:{idle:100,user:user+=100}}],memoryReader:()=>({totalBytes:1024,availableBytes:256}),commandRunner:async(file,args)=>{if(args[0]?.startsWith('--query-gpu=index,name,temperature.gpu'))return '0, fixture GPU, 45, N/A';if(args.at(-1)?.includes('temperature-sensors-'))return '{"sensors":[],"providers":[]}';calls.push(file);if(file==='nvidia-smi'){if(failGpu)throw Error('missing');return '0, fixture GPU, 25, 4096, 2048, 45, 30, 0, 1';}return '{"cpu":[],"memory":[],"disks":[],"volumes":[]}';}});
  t.after(async()=>{await monitor.close();await rm(dir,{recursive:true,force:true});});
  let s=monitor.sample();assert.equal(s.cpu.utilizationPercent,null);assert.equal(s.memory.usedBytes,768);
  await new Promise(r=>setTimeout(r,100));s=monitor.sample();assert.equal(s.gpu.devices[0].utilizationPercent,25);assert.equal(calls.filter(x=>x==='nvidia-smi').length,1);
  now+=3000;failGpu=true;monitor.sample();await new Promise(r=>setTimeout(r,10));s=monitor.sample();assert.equal(s.gpu.status,'unavailable');assert.deepEqual(s.gpu.devices,[]);
  const count=calls.length;await new Promise(r=>setTimeout(r,20));assert.equal(calls.length,count);await monitor.close();now+=60000;monitor.sample();assert.equal(calls.length,count);
});

