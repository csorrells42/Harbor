import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import path from 'node:path';

// A bundled Node process keeps native ONNX modules independent of Electron's ABI.
export function createSemanticWorker(){
  let child,sequence=0,closed=false,selected=true;const pending=new Map(),processes=new Map();
  const retire=()=>{if(!selected&&!pending.size&&child){const proc=child;child=undefined;proc.kill();}};
  function start(){
    if(closed)throw new Error('Semantic search is closed');
    if(child)return child;
    const root=process.env.HARBOR_TOOL_RUNTIME_ROOT||process.env.HARBOR_PORTABLE_ROOT;
    if(!root)throw new Error('Semantic search needs Harbor Portable.');
    const processChild=spawn(path.join(root,'runtimes/node/node.exe'),[path.join(root,'support/portkey-worker.mjs'),root,...(process.env.HARBOR_PORTKEY_PACKAGE?[process.env.HARBOR_PORTKEY_PACKAGE]:[])],{windowsHide:true,stdio:['pipe','pipe','pipe']});child=processChild;
    const exited=new Promise(resolve=>processChild.once('close',resolve));
    processes.set(processChild,exited);exited.then(()=>processes.delete(processChild));
    const fail=error=>{if(child===processChild)child=undefined;for(const entry of pending.values())if(entry.proc===processChild)entry.reject(error);};
    processChild.on('error',()=>fail(new Error('Semantic search could not start.')));
    // A failed write also emits a stream error even when write has a callback.
    // Handle it here so a crashed search worker cannot terminate Harbor.
    processChild.stdin.on('error',()=>{fail(new Error('Semantic search input failed'));processChild.kill();});
    processChild.on('exit',()=>fail(new Error('Semantic search stopped. Retry the search.')));
    processChild.stderr.resume();
    createInterface({input:processChild.stdout}).on('line',line=>{let r;try{r=JSON.parse(line);}catch{return;}const entry=pending.get(r.id);if(!entry)return;pending.delete(r.id);r.error?entry.reject(new Error(r.error)):entry.resolve(r.result);});
    return processChild;
  }
  return {
    select(value){selected=value;retire();},
    request(data,{timeout=120000,signal}={}){
      if(signal?.aborted)return Promise.reject(new Error('Search cancelled'));
      const proc=start(),id=++sequence;
      return new Promise((resolve,reject)=>{
        const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);pending.delete(id);retire();};
        const cancel=()=>{cleanup();reject(new Error('Search cancelled'));};
        const timer=setTimeout(()=>{cleanup();reject(new Error('Semantic search timed out'));proc.kill();},timeout);
        pending.set(id,{proc,resolve:r=>{cleanup();resolve(r);},reject:e=>{cleanup();reject(e);}});
        signal?.addEventListener('abort',cancel,{once:true});
        proc.stdin.write(JSON.stringify({...data,id})+'\n',error=>{if(error)pending.get(id)?.reject(new Error('Semantic search input failed'));});
      });
    },
    async close(){closed=true;await Promise.all([...processes].map(([proc,exited])=>{proc.kill();return exited;}));}
  };
}
