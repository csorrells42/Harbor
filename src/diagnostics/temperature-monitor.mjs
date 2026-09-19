import path from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createTemperatureHistory,parseNvidiaTemperatures,SAMPLE_MS} from './temperature-history.mjs';

export function createTemperatureMonitor({dataDir,run,clock=Date.now,platform=process.platform,background=true}){
  const history=createTemperatureHistory();
  let closed=false,startedAt=null,lastAttempt=-Infinity,pending=null,timer=null,providers=[];
  async function windows(){
    if(platform!=='win32')return {sensors:[],providers:[{name:'Windows sensors',status:'unavailable',detail:'Available on Windows only'}]};
    const source=await readFile(new URL('./temperature-sensors.ps1',import.meta.url));
    const script=path.join(dataDir,`temperature-sensors-${createHash('sha256').update(source).digest('hex')}.ps1`);
    if(closed)return {sensors:[],providers:[]};
    try{await writeFile(script,source,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
    if(closed)return {sensors:[],providers:[]};
    const output=await run(path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],8000);
    const result=JSON.parse(output.replace(/^\uFEFF/,''));
    if(!Array.isArray(result.sensors)||!Array.isArray(result.providers))throw new Error('Invalid sensor response');
    return result;
  }
  async function nvidia(){
    const query=fields=>run('nvidia-smi',[`--query-gpu=index,name,${fields}`,'--format=csv,noheader,nounits'],2500);
    let output;try{output=await query('temperature.gpu,temperature.memory');}catch{if(closed)throw Error('Closed');output=await query('temperature.gpu');}
    const sensors=parseNvidiaTemperatures(output);
    return {sensors,providers:[{name:'NVIDIA',status:sensors.length?'available':'unavailable',detail:`${sensors.length} temperature sensors exposed; unsupported readings are omitted`}]};
  }
  function poll(){
    if(closed||pending||clock()-lastAttempt<SAMPLE_MS)return pending;
    lastAttempt=clock();
    pending=(async()=>{
      const results=await Promise.allSettled([nvidia(),windows()]);
      if(closed)return;
      const at=clock(),states=[];
      results.forEach((r,i)=>{const source=i===0?'NVIDIA':'Windows sensor providers';
        history.record(source,r.status==='fulfilled'?r.value.sensors:[],at);
        states.push(...(r.status==='fulfilled'?r.value.providers:[{name:source,status:'unavailable',detail:'Temperature query failed or timed out'}]));
      });providers=states;
    })().finally(()=>{pending=null;});
    return pending;
  }
  return {
    sample(){if(startedAt===null&&!closed){startedAt=clock();if(background){timer=setInterval(poll,SAMPLE_MS);timer.unref?.();}}void poll();return {startedAt,sampledAt:clock(),intervalMs:SAMPLE_MS,retentionMinutes:60,collecting:!closed,providers,series:history.snapshot(clock())};},
    async close(){closed=true;clearInterval(timer);await pending;},
  };
}
