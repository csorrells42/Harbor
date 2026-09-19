import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTemperatureHistory,parseNvidiaTemperatures,HISTORY_MS} from '../src/diagnostics/temperature-history.mjs';
import {createTemperatureMonitor} from '../src/diagnostics/temperature-monitor.mjs';
import {temperaturePath,visibleTemperaturePoints} from '../src/diagnostics/temperature-ui.js';

test('temperature history retains an hour, distinguishes zero from missing and never bridges missing samples',()=>{
  const h=createTemperatureHistory(),reading=celsius=>[{id:'cpu',label:'CPU package',celsius}];
  h.record('fixture',reading(0),1000);h.record('fixture',[],11000);h.record('fixture',reading(45),21000);
  const points=h.snapshot(21000)[0].points;assert.deepEqual(points.map(p=>p.celsius),[0,null,45]);
  assert.equal(temperaturePath(points,x=>x,y=>y,25000),'M1000.00,0.00  M21000.00,45.00');
  assert.equal(temperaturePath([{at:0,celsius:30},{at:30000,celsius:40}],x=>x,y=>y,25000),'M0.00,30.00 M30000.00,40.00');
  assert.equal(h.snapshot(HISTORY_MS+11001)[0].points.length,1);assert.equal(h.snapshot(HISTORY_MS+21001).length,0);
  assert.equal(parseNvidiaTemperatures('0, GPU, 42, N/A').length,1);assert.equal(parseNvidiaTemperatures('0, GPU, 42, 60')[1].celsius,60);
  assert.deepEqual(parseNvidiaTemperatures('0, GPU, N/A, [Not Supported]'),[]);
});
test('chart windows filter by timestamps for each requested duration',()=>{
  const now=4000000,points=[1,6,20,45,61].map(m=>({at:now-m*60000,celsius:40}));
  for(const [minutes,count] of [[5,1],[10,2],[30,3],[60,4]])assert.equal(visibleTemperaturePoints(points,now,minutes).length,count);
});
test('temperature monitor discovers multiple providers, coalesces polls and records failures as gaps',async()=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'harbor-temperature-'));let now=100000,fail=false,calls=0;
  const monitor=createTemperatureMonitor({dataDir,platform:'win32',background:false,clock:()=>now,run:async(file)=>{calls++;if(fail)throw Error('offline');if(file==='nvidia-smi')return '0, GPU, 40, N/A';return JSON.stringify({sensors:[{id:'lhm/cpu',label:'CPU package',celsius:65},{id:'disk/0',label:'SSD',celsius:35}],providers:[{name:'fixture Windows',status:'available',detail:'2 sensors'}]});}});
  try{
    monitor.sample();monitor.sample();
    for(let i=0;i<100&&monitor.sample().series.length<3;i++)await new Promise(r=>setTimeout(r,10));
    let s=monitor.sample();assert.equal(s.series.length,3);assert.equal(calls,2);
    now+=10000;fail=true;monitor.sample();
    for(let i=0;i<100&&monitor.sample().series[0].points.length<2;i++)await new Promise(r=>setTimeout(r,10));
    s=monitor.sample();assert(s.series.every(s=>s.points.at(-1).celsius===null));assert(s.providers.every(p=>p.status==='unavailable'));
    await monitor.close();const count=calls;now+=10000;monitor.sample();assert.equal(calls,count);
  }finally{await monitor.close();await rm(dataDir,{recursive:true,force:true});}
});
