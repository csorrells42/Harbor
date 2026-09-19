import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createTemperatureMonitor} from './temperature-monitor.mjs';

export function cpuTotals(cpus){return cpus.reduce((a,c)=>({idle:a.idle+c.times.idle,total:a.total+Object.values(c.times).reduce((s,n)=>s+n,0)}),{idle:0,total:0});}
export function cpuUsage(previous,current){const total=current.total-previous.total,idle=current.idle-previous.idle;return total>0&&idle>=0?Math.max(0,Math.min(100,100*(1-idle/total))):null;}
const numeric=s=>{if(!s?.trim()||/N\/A|not supported/i.test(s))return null;const n=Number(s);return Number.isFinite(n)&&n>=0?n:null;};
export function parseGpuCsv(text){
  return text.trim().split(/\r?\n/).filter(Boolean).map(line=>{
    const p=line.split(',').map(s=>s.trim());if(p.length!==9)throw new Error('Unsupported GPU response');
    return {index:numeric(p[0]),name:p[1],utilizationPercent:numeric(p[2]),memoryTotalMiB:numeric(p[3]),memoryUsedMiB:numeric(p[4]),temperatureC:numeric(p[5]),powerW:numeric(p[6]),fanPercent:numeric(p[7]),driver:p[8]};
  });
}
export function createSystemMonitor({dataDir,platform=process.platform,clock=Date.now,cpuReader=os.cpus,memoryReader=()=>({totalBytes:os.totalmem(),availableBytes:os.freemem()}),commandRunner,temperatureBackground=true}={}){
  let closed=false,previous=null,lastCpuAt=0,lastGpuAttempt=-Infinity,lastInfoAttempt=-Infinity,gpuPending=false,infoPending=false;
  let gpu={status:'loading',devices:[],sampledAt:null,error:null},hardware={status:'loading',data:null,sampledAt:null,error:null};
  const children=new Set();
  const run=commandRunner??((file,args,timeout)=>new Promise((resolve,reject)=>{
    const child=execFile(file,args,{windowsHide:true,timeout,maxBuffer:1024*1024},(error,stdout)=>{children.delete(child);error?reject(error):resolve(stdout);});children.add(child);
  }));
  const temperatures=createTemperatureMonitor({dataDir,platform,clock,run,background:temperatureBackground});
  async function gpuSample(now){
    gpuPending=true;lastGpuAttempt=now;
    try{const output=await run('nvidia-smi',['--query-gpu=index,name,utilization.gpu,memory.total,memory.used,temperature.gpu,power.draw,fan.speed,driver_version','--format=csv,noheader,nounits'],2500);
      if(!closed)gpu={status:'ready',devices:parseGpuCsv(output),sampledAt:clock(),error:null};
    }catch{if(!closed)gpu={status:'unavailable',devices:[],sampledAt:null,error:'Live GPU readings require a working NVIDIA driver and nvidia-smi.'};}
    finally{gpuPending=false;}
  }
  async function infoSample(now){
    infoPending=true;lastInfoAttempt=now;
    try{
      if(platform!=='win32')throw new Error('Windows inventory unavailable');
      const source=await readFile(new URL('./system-info.ps1',import.meta.url));
      const script=path.join(dataDir,`system-info-${createHash('sha256').update(source).digest('hex')}.ps1`);
      if(closed)return;
      try{await writeFile(script,source,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
      if(closed)return;
      const shell=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
      const output=await run(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],10000);
      if(!closed)hardware={status:'ready',data:JSON.parse(output.replace(/^\uFEFF/,'')),sampledAt:clock(),error:null};
    }catch{if(!closed)hardware={status:'unavailable',data:null,sampledAt:null,error:'Detailed hardware inventory is unavailable. Basic CPU and RAM readings are still shown.'};}
    finally{infoPending=false;}
  }
  return {
    sample(){
      const now=clock(),cpus=cpuReader(),totals=cpuTotals(cpus),memory=memoryReader();
      const utilization=previous&&now-lastCpuAt<=10000?cpuUsage(previous,totals):null;previous=totals;lastCpuAt=now;
      // Gauges are on demand; temperature history continues after the first visit.
      if(!closed&&!gpuPending&&now-lastGpuAttempt>=(gpu.status==='unavailable'?30000:2500))void gpuSample(now);
      if(!closed&&!infoPending&&now-lastInfoAttempt>=30000)void infoSample(now);
      return {sampledAt:now,cpu:{name:cpus[0]?.model??'Unknown processor',logicalCpus:cpus.length,utilizationPercent:utilization},memory:{...memory,usedBytes:Math.max(0,memory.totalBytes-memory.availableBytes)},uptimeSeconds:os.uptime(),platform:`${os.type()} ${os.release()} · ${os.arch()}`,gpu:{...gpu,stale:gpu.sampledAt!==null&&now-gpu.sampledAt>10000},hardware:{...hardware,stale:hardware.sampledAt!==null&&now-hardware.sampledAt>90000},temperatures:temperatures.sample()};
    },
    async close(){closed=true;const done=temperatures.close();for(const child of children)child.kill();children.clear();await done;},
  };
}
