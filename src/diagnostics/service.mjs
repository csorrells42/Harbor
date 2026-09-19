import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createGateway} from '../core/gateway.mjs';
import {createHermesAdapter} from './hermes.mjs';
import {validatePlan,schedule,hash,DEFAULT_PLAN} from './plans.mjs';
import {createTask,SUITE_VERSION} from './tasks.mjs';
import {compare} from './grading.mjs';
import {withDeadline} from '../core/deadline.mjs';
import {claimCampaignLock} from './lock.mjs';
import {createSystemMonitor} from './system-monitor.mjs';

async function codeFingerprint(){const h=createHash('sha256');for(const file of ['gateway.mjs','tool-delivery.mjs','tool-router.mjs','semantic-worker.mjs','delivery-options.js'])h.update(await readFile(new URL(`../core/${file}`,import.meta.url)));return h.digest('hex');}
async function save(file,value){const tmp=`${file}.${randomUUID()}.tmp`;await writeFile(tmp,JSON.stringify(value,null,2),{flag:'wx'});await rename(tmp,file);}
export async function createDiagnostics({dataDir,adapter,gatewayFactory=createGateway}={}) {
  if(!dataDir)throw new Error('Diagnostics needs a dedicated data directory');
  const root=path.resolve(dataDir);await mkdir(root,{recursive:true});
  const systemMonitor=createSystemMonitor({dataDir:root});
  if(!adapter){
    // Python cannot execute a file inside Electron's asar virtual filesystem.
    const source=await readFile(new URL('./hermes_worker.py',import.meta.url));
    const workerPath=path.join(root,`hermes-worker-${createHash('sha256').update(source).digest('hex')}.py`);
    try{await writeFile(workerPath,source,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
    adapter=createHermesAdapter({workerPath});
  }
  let inventory=null,campaign=null,active=null,abort=null,problem=null,closed=false,closing;
  const lifetime=new AbortController(),operations=new Set();
  const track=operation=>{operations.add(operation);operation.then(()=>operations.delete(operation),()=>operations.delete(operation));return operation;};
  try{campaign=JSON.parse(await readFile(path.join(root,'latest.json'),'utf8'));if(campaign.status==='running'){campaign.status='interrupted';campaign.note='Previous process ended; unfinished trials were not scored.';}}catch(e){if(e.code!=='ENOENT')problem='Previous results could not be read.';}
  const persist=async()=>{await save(path.join(root,campaign.id,'campaign.json'),campaign);await save(path.join(root,'latest.json'),campaign);};
  function probe(){
    if(closed)return Promise.reject(new Error('Diagnostics is closed'));
    return track((async()=>{try{
      const value=await withDeadline(adapter.probe({signal:lifetime.signal}),30000,lifetime.signal);
      if(closed)throw new Error('Diagnostics is closed');
      inventory=value;problem=null;return inventory;
    }catch(e){if(!closed){inventory=null;problem=e.message;}throw e;}})());
  }
  function snapshot(){return structuredClone({running:!!active,inventory,problem,defaultPlan:DEFAULT_PLAN,campaign,results:compare(campaign?.trials??[]),dataDir:root,system:systemMonitor.sample()});}
  async function run(plan,rows,baseline,coreHash,lock) {
    const begin=performance.now();
    const campaignTimer=setTimeout(()=>{campaign.stopReason='campaign-budget';abort.abort();},plan.maxCampaignSeconds*1000);
    try {
      for(const row of rows){
        if(abort.signal.aborted)break;
        if(await codeFingerprint()!==coreHash){campaign.stopReason='Harbor source changed during testing';break;}
        const trialId=randomUUID(),trialDir=path.join(root,campaign.id,trialId);await mkdir(trialDir);
        campaign.current={task:row.task,configId:row.variant.id,repetition:row.repetition+1};
        const started=performance.now(),task=createTask(row.task,row.nonce),samples=[];
        const trialAbort=new AbortController();const stop=()=>trialAbort.abort();abort.signal.addEventListener('abort',stop,{once:true});
        let gateway,result,resourceExceeded=false,ready=null;
        const trial={id:trialId,task:row.task,repetition:row.repetition,configId:row.variant.id,harnessId:`Hermes:${baseline.revision}:${baseline.fingerprint}`,modelId:`${baseline.provider}:${baseline.model}:${baseline.reasoning}`,hardwareId:hash({...baseline.hardware,gpus:baseline.hardware.gpus?.map(({usedMiB,...g})=>g)}),harborFingerprint:coreHash,suite:SUITE_VERSION,settings:row.variant.settings,eligible:false};
        trial.combinationId=hash([trial.configId,trial.settings,trial.harnessId,trial.modelId,trial.hardwareId]);
        try {
          gateway=await gatewayFactory({...row.variant.settings,host:'127.0.0.1',port:0,networkEnabled:false,upstreams:task.upstreams,log:()=>{}});
          await withDeadline(gateway.prepareMode(row.variant.settings),plan.maxTrialSeconds*1000,trialAbort.signal);
          if(abort.signal.aborted)throw new Error('Campaign stopped');
          const remainingSeconds=Math.max(1,plan.maxTrialSeconds-(performance.now()-started)/1000);
          result=await adapter.run({home:path.join(trialDir,'hermes-home'),gateway:gateway.endpoint,prompt:task.prompt,maxTurns:plan.maxTurns,maxTrialSeconds:remainingSeconds},{signal:trialAbort.signal,onEvent:e=>{
            if(e.type==='ready')ready=e;
            if(e.type==='resources'){
              samples.push(e);
              if((plan.maxHostUsedGiB!==null&&e.hostUsedGiB>plan.maxHostUsedGiB)||(plan.maxGpuUsedMiB!==null&&e.gpus?.some(g=>g.usedMiB>plan.maxGpuUsedMiB))){resourceExceeded=true;trialAbort.abort();}
            }
          }});
          trial.status=resourceExceeded?'resource-limit':result.status;
          trial.error=result.error??null;
          trial.grade=task.verify(result.result?.finalResponse??'');
          trial.harnessCompleted=result.result?.harnessCompleted??null;
          trial.apiCalls=result.result?.apiCalls??null;
          trial.modelReported=result.result?.modelReported??null;
          trial.usage=result.result?.usage??null;trial.cost=result.result?.cost??null;
          trial.startupMs=ready?.startupMs??null;
          trial.controls=ready?.controls??null;
          const toolEvents=result.events.filter(e=>e.type==='tool-start');
          trial.argumentCorrectness=toolEvents.length?toolEvents.filter(e=>e.schemaValid).length/toolEvents.length:null;
          trial.toolTrace=toolEvents;
          if(['no-tool','unavailable'].includes(row.task)&&toolEvents.length){trial.grade.completed=false;trial.grade.adherent=false;trial.grade.accepted=false;trial.grade.toolCorrect=0;}
          trial.toolAttempts=toolEvents.length;trial.timeToFirstToolMs=toolEvents[0]?.ms??null;
          trial.acceptanceMs=trial.grade.accepted?task.events[0]?.ms??null:null;
          trial.eligible=!!ready&&['finished','timeout'].includes(trial.status)&&!result.result?.failed&&!result.result?.interrupted;
          if(trial.status==='finished'&&trial.harnessCompleted===false&&trial.apiCalls>=plan.maxTurns)trial.status='iteration-limit';
          if(result.result?.failed){trial.status='harness-error';trial.eligible=!!ready;}
          if(ready&&(ready.inventory.fingerprint!==baseline.fingerprint||ready.inventory.model!==baseline.model||ready.inventory.reasoning!==baseline.reasoning)){trial.eligible=false;trial.status='configuration-drift';}
          if(result.result?.modelReported&&result.result.modelReported!==baseline.model){trial.eligible=false;trial.status='model-drift';}
          if(trial.status==='finished'&&!result.result){trial.status='infrastructure-error';trial.eligible=false;}
        }catch(e){trial.status=abort.signal.aborted?'cancelled':'infrastructure-error';trial.error=e.message;trial.grade=task.verify('');}
        finally{abort.signal.removeEventListener('abort',stop);if(gateway)await gateway.close();}
        if(await codeFingerprint()!==coreHash){trial.status='configuration-drift';trial.eligible=false;campaign.stopReason='Harbor source changed during testing';}
        trial.elapsedMs=performance.now()-started;
        trial.resources={sampleCount:samples.length,peakHostUsedGiB:samples.length?Math.max(...samples.map(s=>s.hostUsedGiB)):null,peakWorkerRssBytes:samples.length?Math.max(...samples.map(s=>s.workerRssBytes)):null,meanHostCpuPercent:samples.length>1?samples.slice(1).reduce((a,s)=>a+s.hostCpuPercent,0)/(samples.length-1):null,peakGpuUsedMiB:samples.some(s=>s.gpus?.length)?Math.max(...samples.flatMap(s=>s.gpus?.map(g=>g.usedMiB)??[])):null,scope:'System-wide RAM/GPU and Hermes worker RSS, sampled every 2 seconds; shared workloads included. Peaks between samples may be missed.'};
        campaign.trials.push(trial);await save(path.join(trialDir,'result.json'),trial);await persist();
        if(campaign.stopReason)break;
      }
      campaign.status=campaign.trials.length===rows.length?'finished':abort.signal.aborted?'cancelled':'stopped';
    }catch(e){campaign.status='error';problem=e.message;campaign.stopReason=e.message;}
    finally{
      clearTimeout(campaignTimer);campaign.current=null;campaign.elapsedMs=performance.now()-begin;campaign.endedAt=new Date().toISOString();
      try{await persist();}finally{try{await lock.close();}finally{active=null;abort=null;}}
    }
  }
  async function start(input){
      if(closed)throw new Error('Diagnostics is closed');
      if(active)throw new Error('A diagnostic campaign is already running');
      const plan=validatePlan(input),rows=schedule(plan);
      // Exclusive lock is acquired before asynchronous preflight; protects multiple windows/processes.
      const lock=await claimCampaignLock(root);
      try{
        const baseline=await probe();
        if(closed)throw new Error('Diagnostics is closed');
        if(plan.maxGpuUsedMiB!==null&&!baseline.hardware.gpus?.length)throw new Error('GPU memory budget needs available NVIDIA telemetry');
        const coreHash=await codeFingerprint();
        campaign={id:randomUUID(),status:'running',createdAt:new Date().toISOString(),plan,input,inventory:baseline,harborFingerprint:coreHash,plannedTrials:rows.length,trials:[],suite:SUITE_VERSION};
        await mkdir(path.join(root,campaign.id));await persist();
        if(closed){campaign.status='cancelled';campaign.stopReason='application-closing';campaign.endedAt=new Date().toISOString();await persist();throw new Error('Diagnostics is closed');}
        abort=new AbortController();active=run(plan,rows,baseline,coreHash,lock);active.catch(e=>{problem=e.message;});
        return snapshot();
      }catch(e){await lock.close();throw e;}
  }
  return {probe,snapshot,start:input=>track(start(input)),
    cancel(){if(abort){campaign.stopReason='user-cancelled';abort.abort();}return snapshot();},
    close(){
      if(closing)return closing;closed=true;lifetime.abort(new Error('Diagnostics is closed'));
      if(abort){campaign.stopReason='application-closing';abort.abort();}
      return closing=(async()=>{
        const cleanup=Promise.allSettled([Promise.resolve().then(()=>systemMonitor.close()),Promise.resolve().then(()=>adapter.close?.())]);
        // Preflight owns the campaign lock before active exists. Wait for that
        // operation to unwind, as well as every probe and active trial.
        await Promise.allSettled([...operations]);
        const [runResults,cleanupResults]=await Promise.all([Promise.allSettled([active]),cleanup]);
        const failed=[...runResults,...cleanupResults].find(result=>result.status==='rejected');if(failed)throw failed.reason;
      })();
    },
    async wait(){await active;return snapshot();},
  };
}
