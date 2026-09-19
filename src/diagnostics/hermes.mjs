import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export function createHermesAdapter({source=path.join(process.env.LOCALAPPDATA||'', 'hermes'),workerPath=fileURLToPath(new URL('./hermes_worker.py',import.meta.url)),spawnProcess=spawn}={}) {
  const python=path.join(source,'hermes-agent/venv/Scripts/python.exe');
  const invocations=new Set();let closed=false,closing;
  function invoke(request,{signal,onEvent=()=>{},timeout=30000}={}) {
    if(closed)return Promise.reject(new Error('Hermes adapter is closed'));
    const invocation={stop:null,done:null};
    const done=new Promise((resolve,reject)=>{
      const events=[];let stopping=null,force,ended=false,termination=Promise.resolve();
      const child=spawnProcess(python,['-B',workerPath],{windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','ignore'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
      const kill=reason=>{
        if(stopping||ended)return;stopping=reason;
        if(child.pid){
          if(process.platform==='win32'){
            // Kill descendants before the worker disappears; the completion
            // promise also waits for taskkill's acknowledgement.
            termination=new Promise(finish=>{
              const killer=spawn(path.join(process.env.SystemRoot||'C:/Windows','System32/taskkill.exe'),['/pid',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
              killer.once('error',()=>{child.kill();finish();});killer.once('close',finish);
            });
          }else {try{process.kill(-child.pid,'SIGTERM');}catch{child.kill();}}
        }
        force=setTimeout(()=>{if(process.platform!=='win32'&&child.pid){try{process.kill(-child.pid,'SIGKILL');}catch{}}else child.kill('SIGKILL');},1500);
      };
      invocation.stop=()=>kill('cancelled');
      const abort=()=>kill('cancelled');
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      const timer=setTimeout(()=>kill('timeout'),timeout);
      createInterface({input:child.stdout}).on('line',line=>{if(line.length>200000)return;try{const e=JSON.parse(line);events.push(e);onEvent(e);}catch{}});
      child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({...request,source}));
      const cleanup=()=>{clearTimeout(timer);clearTimeout(force);signal?.removeEventListener('abort',abort);};
      child.on('error',error=>{ended=true;cleanup();reject(new Error(`Hermes Python could not start: ${error.code||'unknown'}`));});
      child.on('close',async code=>{ended=true;cleanup();await termination;resolve({events,status:stopping||(code===0?'finished':'infrastructure-error'),error:events.find(e=>e.type==='error')?.message,result:events.find(e=>e.type==='result')});});
    });
    invocation.done=done;invocations.add(invocation);
    done.then(()=>invocations.delete(invocation),()=>invocations.delete(invocation));
    return done;
  }
  return {
    async probe(options){const r=await invoke({op:'probe'},options);const inventory=r.events.find(e=>e.type==='inventory');if(!inventory)throw new Error(r.error||`Hermes probe ${r.status}`);return inventory;},
    run:(request,options)=>invoke({op:'run',...request},{...options,timeout:request.maxTrialSeconds*1000}),
    close(){
      if(closing)return closing;closed=true;
      for(const invocation of invocations)invocation.stop?.();
      return closing=Promise.allSettled([...invocations].map(invocation=>invocation.done)).then(()=>{});
    },
  };
}
