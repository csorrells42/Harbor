import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export function createHermesAdapter({source=path.join(process.env.LOCALAPPDATA||'', 'hermes'),workerPath=fileURLToPath(new URL('./hermes_worker.py',import.meta.url))}={}) {
  const python=path.join(source,'hermes-agent/venv/Scripts/python.exe');
  function invoke(request,{signal,onEvent=()=>{},timeout=30000}={}) {
    return new Promise((resolve,reject)=>{
      const events=[];let stopping=null,force;
      const child=spawn(python,['-B',workerPath],{windowsHide:true,stdio:['pipe','pipe','ignore'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
      const kill=reason=>{if(stopping)return;stopping=reason;child.kill();force=setTimeout(()=>child.kill('SIGKILL'),1500);};
      const abort=()=>kill('cancelled');
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      const timer=setTimeout(()=>kill('timeout'),timeout);
      createInterface({input:child.stdout}).on('line',line=>{if(line.length>200000)return;try{const e=JSON.parse(line);events.push(e);onEvent(e);}catch{}});
      child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({...request,source}));
      const cleanup=()=>{clearTimeout(timer);clearTimeout(force);signal?.removeEventListener('abort',abort);};
      child.on('error',error=>{cleanup();reject(new Error(`Hermes Python could not start: ${error.code||'unknown'}`));});
      child.on('close',code=>{cleanup();resolve({events,status:stopping||(code===0?'finished':'infrastructure-error'),error:events.find(e=>e.type==='error')?.message,result:events.find(e=>e.type==='result')});});
    });
  }
  return {
    async probe(){const r=await invoke({op:'probe'});const inventory=r.events.find(e=>e.type==='inventory');if(!inventory)throw new Error(r.error||`Hermes probe ${r.status}`);return inventory;},
    run:(request,options)=>invoke({op:'run',...request},{...options,timeout:request.maxTrialSeconds*1000}),
  };
}
