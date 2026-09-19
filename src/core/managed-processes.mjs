import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildLaunchSpec } from './launch.mjs';
import { createConnection } from 'node:net';
import { wslSupervisor } from './wsl-supervisor.mjs';
import { wslBootstrap } from './wsl-bootstrap.mjs';
import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {runBuildCommand} from './maintenance.mjs';

// Probe TCP, not HTTP: even a non-MCP listener must prevent ownership claims.
export function assertEndpointAvailable(endpoint, timeoutMs, signal) {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const socket = createConnection({host:url.hostname.replace(/^\[|\]$/g,''),port:Number(url.port || (url.protocol==='https:'?443:80))});
    const finish = error => {socket.destroy();signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
    const abort = () => finish(signal.reason);
    socket.once('connect',()=>finish(new Error('Managed endpoint is already in use; stop the external service before starting Harbor ownership')));
    socket.once('error',error=>finish(error.code==='ECONNREFUSED'||(error.errors?.length && error.errors.every(e=>e.code==='ECONNREFUSED'))?undefined:error));
    socket.setTimeout(timeoutMs,()=>finish(new Error('Cannot establish endpoint availability: probe timed out')));
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  });
}

export function launchManaged(spec, log, onExit) {
  const wsl = spec.runtime === 'wsl';
  if(wsl && process.platform !== 'win32')throw new Error('WSL runtime requires Windows');
  // Linux ownership requires Python 3 + Linux prctl(/proc) subreaping: process
  // groups alone do not retain descendants that create their own sessions.
  const linux = !wsl && process.platform === 'linux';
  const completionDir = wsl ? mkdtempSync(join(tmpdir(),'harbor-owned-lease-')) : undefined;
  const completionPath = completionDir && join(completionDir,'complete');
  const args = wsl ? [...(spec.distro ? ['--distribution',spec.distro] : []),'--exec','python3','-u','-c',wslBootstrap] : linux ? ['-u','-c',wslSupervisor] : [fileURLToPath(new URL('./managed-supervisor.mjs',import.meta.url))];
  const child=spawn(wsl ? 'wsl.exe' : linux ? 'python3' : process.execPath,args,{
    env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false
  });
  let settled=false,stopping=false,closed=false,resolveReady,rejectReady;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const exited=new Promise(resolve=>child.once('close',()=>{closed=true;resolve();}));
  const record={runtime:spec.runtime??'native',distro:spec.distro,owned:true,launcherPid:child.pid,...(!wsl ? {supervisorPid:child.pid} : {})};
  const fail=error=>{if(!settled){settled=true;rejectReady(error);}if(!stopping)onExit(error);};
  child.once('error',fail);
  child.once('exit',(code,signal)=>{if(!stopping)fail(new Error(`Owned process supervisor exited (${code??signal})`));});
  child.stdin.on('error',()=>{});
  child.stderr.on('data',chunk=>log(chunk.toString().trimEnd()));
  createInterface({input:child.stdout}).on('line',line=>{
    let message;try{message=JSON.parse(line);}catch{return;}
    if(message.pid){Object.assign(record,message);if(!settled){settled=true;resolveReady();}}
    else if(message.error||'exit' in message)fail(new Error(message.error??`Owned process exited (${message.exit??message.signal})`));
  });
  const launch=wsl ? spec : buildLaunchSpec(spec);
  child.stdin.write(JSON.stringify({command:launch.command,args:launch.args,cwd:launch.cwd,env:launch.env,completionPath})+'\n');
  let closing;
  return {record,ready,close:()=>closing??=(async()=>{
    stopping=true;
    if(!closed&&spec.gracefulStop){
      const stop=buildLaunchSpec(spec.gracefulStop);
      try{await runBuildCommand(stop.command,stop.args,{cwd:stop.cwd,env:stop.env,timeout:spec.gracefulStop.timeoutMs??120000,log});}
      catch(error){log(`Graceful shutdown failed: ${error.message}`);}
    }
    if(!closed)child.stdin.end();
    // A WSL launcher exit is NOT an ownership acknowledgement. Its detached
    // owner must report that it actually reaped the tree, even after a crash.
    await exited;
    if(completionPath) {
      const deadline=Date.now()+15000;
      try {
        while(await readFile(completionPath,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;})!=='reaped') {
          if(Date.now()>=deadline)throw new Error('Linux ownership cleanup was not acknowledged; requires Python 3, wslpath and a WSL-accessible Windows temp directory');
          await new Promise(resolve=>setTimeout(resolve,25));
        }
      } finally {await rm(completionDir,{recursive:true,force:true});}
    }
  })()};
}
