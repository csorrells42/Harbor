import {freemem} from 'node:os';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createGateway} from '../core/gateway.mjs';
import {createHermesAdapter} from './hermes.mjs';
import {createOpenClawAdapter} from './openclaw.mjs';
import {createLmStudioAdapter} from './lmstudio.mjs';
import {validatePlan,schedule,hash,DEFAULT_PLAN} from './plans.mjs';
import {createTask,SUITE_VERSION} from './tasks.mjs';
import {compare} from './grading.mjs';
import {withDeadline} from '../core/deadline.mjs';
import {claimCampaignLock} from './lock.mjs';
import {createSystemMonitor} from './system-monitor.mjs';
import {createRequestTraces} from '../core/request-traces.mjs';
import {deliveryEvidence} from './delivery-evidence.mjs';
import {createWorkloadTask} from './workloads.mjs';
import {WORKLOAD_TASKS,WORKLOAD_SUITE_VERSION} from './workload-catalog.js';
import {createCampaignArchive} from './archive.mjs';
import {createCatalogVariant} from './catalog-variants.mjs';
import {setupIdentity} from './setup-identity.mjs';
export const MIN_HOST_AVAILABLE_BYTES=500_000_000;
const workloadIds=new Set(WORKLOAD_TASKS.map(task=>task.id));
const suiteFor=plan=>plan.tasks.some(id=>workloadIds.has(id))?SUITE_VERSION+'+'+WORKLOAD_SUITE_VERSION:SUITE_VERSION;

async function codeFingerprint(){const h=createHash('sha256');for(const file of ['gateway.mjs','mcp-primitives.mjs','tool-delivery.mjs','tool-router.mjs','semantic-worker.mjs','delivery-options.js','request-traces.mjs','request-scheduler.mjs','settings.mjs'])h.update(await readFile(new URL(`../core/${file}`,import.meta.url)));for(const file of ['service.mjs','plans.mjs','tasks.mjs','workloads.mjs','workload-catalog.js','catalog-options.js','catalog-variants.mjs','delivery-evidence.mjs','setup-identity.mjs','hermes.mjs','hermes_worker.py','openclaw.mjs','lmstudio.mjs','lmstudio-registration.mjs','openclaw-observer.cjs','grading.mjs'])h.update(await readFile(new URL(file,import.meta.url)));return h.digest('hex');}
async function save(file,value){const tmp=`${file}.${randomUUID()}.tmp`;await writeFile(tmp,JSON.stringify(value,null,2),{flag:'wx'});await rename(tmp,file);}
function compactTrial(trial){
  const {trace,deliveryEvidence,...summary}=trial;
  return {...summary,deliveryObservation:deliveryEvidence?{retrievalCoverage:deliveryEvidence.retrievalCoverage,observedRetrievalCoverage:deliveryEvidence.observedRetrievalCoverage,discoveryRequests:deliveryEvidence.discoveryRequests,upstreamExecutions:deliveryEvidence.upstreamExecutions,observedFailureStages:deliveryEvidence.observedFailureStages,traceCoverage:deliveryEvidence.traceCoverage,modelRequestCount:deliveryEvidence.perModelRequestPresentation?.length??null,catalogOrderAtModel:deliveryEvidence.modelCatalogOrder?.some(row=>row.catalogOrderPreserved===false)?'reordered':deliveryEvidence.modelCatalogOrder?.length&&deliveryEvidence.modelCatalogOrder.every(row=>row.catalogOrderPreserved===true)?'preserved':'unknown'}:null};
}
export async function createDiagnostics({dataDir,adapter,adapters={},memoryReader=freemem,gatewayFactory=createGateway,taskFactory=(id,nonce,options)=>workloadIds.has(id)?createWorkloadTask(id,nonce,options):createTask(id,nonce)}={}) {
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
  const harnessAdapters={hermes:adapter,...adapters};let selectedHarness='hermes';
  let inventory=null,campaign=null,active=null,abort=null,problem=null,closed=false,closing;
  const lifetime=new AbortController(),operations=new Set();
  const track=operation=>{operations.add(operation);operation.then(()=>operations.delete(operation),()=>operations.delete(operation));return operation;};
  const archive=createCampaignArchive(root,{liveCampaign:()=>active?campaign:null});
  const archived=operation=>{if(closed)return Promise.reject(new Error('Diagnostics is closed'));return track(operation());};
  try{campaign=JSON.parse(await readFile(path.join(root,'latest.json'),'utf8'));if(campaign.status==='running'){campaign.status='interrupted';campaign.note='Previous process ended; unfinished trials were not scored.';}}catch(e){if(e.code!=='ENOENT')problem='Previous results could not be read.';}
  const persist=async()=>{await save(path.join(root,campaign.id,'campaign.json'),campaign);await save(path.join(root,'latest.json'),campaign);};
  function probe({harness=selectedHarness}={}){
    if(closed)return Promise.reject(new Error('Diagnostics is closed'));
    if(!['hermes','openclaw','lmstudio'].includes(harness))return Promise.reject(new Error('Choose Hermes, OpenClaw or LM Studio'));
    if(harness!==selectedHarness){
      if(active||operations.size) return Promise.reject(new Error('Wait for the current diagnostic operation before switching harnesses'));
      harnessAdapters[harness]??=harness==='lmstudio'?createLmStudioAdapter():createOpenClawAdapter();adapter=harnessAdapters[harness];selectedHarness=harness;inventory=null;
    }
    return track((async()=>{try{
      const value=await withDeadline(adapter.probe({signal:lifetime.signal}),120000,lifetime.signal);
      if(closed)throw new Error('Diagnostics is closed');
      inventory=value;problem=null;return inventory;
    }catch(e){if(!closed){inventory=null;problem=e.message;}throw e;}})());
  }
  function snapshot(){return structuredClone({running:!!active,harness:selectedHarness,inventory,problem,defaultPlan:DEFAULT_PLAN,campaign,results:compare(campaign?.trials??[]),dataDir:root,system:systemMonitor.sample()});}
  async function run(plan,rows,baseline,coreHash,lock) {
    const begin=performance.now();
    const campaignTimer=setTimeout(()=>{campaign.stopReason='campaign-budget';abort.abort();},plan.maxCampaignSeconds*1000);
    try {
      for(const row of rows){
        if(abort.signal.aborted)break;
        if(memoryReader()<=MIN_HOST_AVAILABLE_BYTES){campaign.stopReason='resource-limit';campaign.resourceLimit='500 MB available system memory emergency floor';break;}
        if(await codeFingerprint()!==coreHash){campaign.stopReason='Harbor source changed during testing';break;}
        const trialId=randomUUID(),trialDir=path.join(root,campaign.id,trialId);await mkdir(trialDir);
        campaign.current={task:row.task,configId:row.variant.id,repetition:row.repetition+1};
        const started=performance.now(),samples=[];
        const trialAbort=new AbortController();const stop=()=>trialAbort.abort();abort.signal.addEventListener('abort',stop,{once:true});
        if(abort.signal.aborted)trialAbort.abort();
        let gateway,result,task,variant,catalog=[],resourceExceeded=false,ready=null;
        let memoryWatch;
        const traces=await createRequestTraces({});
        await traces.update({mode:'metadata',maxBytes:256*1024,maxEvents:1000});
        const trial={id:trialId,task:row.task,repetition:row.repetition,configId:row.variant.id,harnessId:`${baseline.harness??'Hermes'}:${baseline.revision}:${baseline.fingerprint}`,modelId:`${baseline.provider}:${baseline.model}:${baseline.reasoning}`,hardwareId:hash({...baseline.hardware,gpus:baseline.hardware.gpus?.map(({usedMiB,...g})=>g)}),harborFingerprint:coreHash,suite:suiteFor(plan),taskSuite:workloadIds.has(row.task)?WORKLOAD_SUITE_VERSION:SUITE_VERSION,settings:row.variant.settings,eligible:false};
        trial.combinationId=hash([trial.configId,trial.settings,trial.harnessId,trial.modelId,trial.hardwareId]);
        try {
          memoryWatch=setInterval(()=>{if(memoryReader()<=MIN_HOST_AVAILABLE_BYTES){resourceExceeded=true;campaign.stopReason='resource-limit';campaign.resourceLimit='500 MB available system memory emergency floor';trialAbort.abort();}},500);
          task=await taskFactory(row.task,row.nonce,{directory:path.join(trialDir,'fixture'),signal:trialAbort.signal});
          variant=createCatalogVariant(task,row.variant.catalog,{overlapProviders:plan.overlapProviders});catalog=variant.catalog;
          trial.catalogVariant=variant.metadata;trial.baseCatalogFingerprint=variant.metadata.baseCatalogFingerprint;
          gateway=await gatewayFactory({...row.variant.settings,host:'127.0.0.1',port:0,networkEnabled:false,upstreams:variant.upstreams,log:()=>{},traces});
          await withDeadline(gateway.prepareMode(row.variant.settings),plan.maxTrialSeconds*1000,trialAbort.signal);
          if(abort.signal.aborted)throw new Error('Campaign stopped');
          const remainingSeconds=Math.max(1,plan.maxTrialSeconds-(performance.now()-started)/1000);
          result=await adapter.run({home:path.join(trialDir,selectedHarness+'-home'),gateway:gateway.endpoint,prompt:task.prompt,responseFormat:task.responseFormat,emptyCatalog:row.variant.settings.toolMode==='all'&&catalog.length===0,maxTurns:plan.maxTurns,maxTrialSeconds:remainingSeconds},{signal:trialAbort.signal,onEvent:e=>{
            if(e.type==='ready')ready=e;
            if(e.type==='resources'){
              samples.push(e);
              if((plan.maxHostUsedGiB!==null&&e.hostUsedGiB>plan.maxHostUsedGiB)||(plan.maxGpuUsedMiB!==null&&e.gpus?.some(g=>g.usedMiB>plan.maxGpuUsedMiB))){resourceExceeded=true;campaign.stopReason='resource-limit';trialAbort.abort();}
            }
          }});
          if(result.cleanupFailed){campaign.stopReason='Temporary LM Studio MCP cleanup failed; inspect mcp.json before restarting';}
          if(result.cancellationUnconfirmed){campaign.stopReason='Native inference cancellation unconfirmed; verify LM Studio is idle before restarting';trial.cancellationUnconfirmed=true;}
          trial.status=resourceExceeded?'resource-limit':result.status;
          trial.error=result.error??null;
          trial.grade=await task.verify(result.result?.finalResponse??'');
          trial.harnessCompleted=result.result?.harnessCompleted??null;
          trial.apiCalls=result.result?.apiCalls??null;
          trial.modelReported=result.result?.modelReported??null;
          trial.usage=result.result?.usage??null;trial.cost=result.result?.cost??null;
          trial.startupMs=ready?.startupMs??null;
          trial.controls=ready?.controls??null;
          const toolEvents=result.events.filter(e=>e.type==='tool-start');
          const observedArguments=toolEvents.filter(e=>typeof e.schemaValid==='boolean');
          trial.argumentCorrectness=observedArguments.length?observedArguments.filter(e=>e.schemaValid).length/observedArguments.length:null;
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
          trial.observationLimited=result.eventsTruncated===true;
          if(trial.observationLimited){trial.eligible=false;trial.status='observation-limit';}
        }catch(e){trial.status=resourceExceeded?'resource-limit':abort.signal.aborted?'cancelled':'infrastructure-error';trial.error=e.message;trial.eligible=false;trial.grade={completed:false,adherent:false,accepted:false,claimedDone:false,toolCorrect:null};if(task)try{trial.grade=await task.verify('');}catch(verificationError){trial.error+='; verifier failed: '+verificationError.message;}}
        finally{
          clearInterval(memoryWatch);
          abort.signal.removeEventListener('abort',stop);
          if(gateway)try{await gateway.close();}catch(error){trial.status='infrastructure-error';trial.eligible=false;trial.error='Gateway cleanup failed: '+error.message;campaign.stopReason='gateway-cleanup-failure';}
          try{await task?.close?.();}catch(error){trial.status='infrastructure-error';trial.eligible=false;trial.error='Fixture cleanup failed: '+error.message;campaign.stopReason='fixture-cleanup-failure';}
          const traceBundle=JSON.parse(traces.previewExport().text);
          trial.catalogFingerprint=hash(catalog);trial.taskSeed=row.nonce;
          trial.deliveryEvidence=deliveryEvidence({catalog,baseCatalog:variant?.baseCatalog,catalogVariant:variant?.metadata,relevantToolNames:variant?.relevantToolNames,traceBundle,
            presentation:ready?.advertisedDefinitions?{source:ready.presentationSource??`${baseline.harness??'Hermes'} initial tool catalog`,definitions:ready.advertisedDefinitions,perRequest:false}:null,
            modelRequests:result?.events?.some(event=>event.type==='model-request')?result.events.filter(event=>event.type==='model-request'):null,taskEvents:task?.events,grade:trial.grade});
          trial.trace=traceBundle;await traces.close();
        }
        trial.setupIdentity=setupIdentity({baseline,ready:ready?.inventory,end:result?.events?.findLast(event=>event.type==='identity-end')?.inventory,events:result?.events,eventsTruncated:result?.eventsTruncated});
        trial.backendId=trial.setupIdentity.backendId;trial.inferenceId=trial.setupIdentity.inferenceId;
        if(trial.setupIdentity.drift){trial.status='configuration-drift';trial.eligible=false;trial.error='Observed setup changed: '+trial.setupIdentity.changedFields.join(', ');campaign.stopReason='Harness/model/inference setup changed during testing';}
        if(await codeFingerprint()!==coreHash){trial.status='configuration-drift';trial.eligible=false;campaign.stopReason='Harbor source changed during testing';}
        trial.elapsedMs=performance.now()-started;
        trial.resources={sampleCount:samples.length,peakHostUsedGiB:samples.length?Math.max(...samples.map(s=>s.hostUsedGiB)):null,peakWorkerRssBytes:samples.some(s=>Number.isFinite(s.workerRssBytes))?Math.max(...samples.map(s=>s.workerRssBytes).filter(Number.isFinite)):null,meanHostCpuPercent:samples.slice(1).some(s=>Number.isFinite(s.hostCpuPercent))?samples.slice(1).filter(s=>Number.isFinite(s.hostCpuPercent)).reduce((a,s,_,rows)=>a+s.hostCpuPercent/rows.length,0):null,peakGpuUsedMiB:samples.some(s=>s.gpus?.length)?Math.max(...samples.flatMap(s=>s.gpus?.map(g=>g.usedMiB)??[])):null,scope:`System-wide RAM/GPU and available ${baseline.harness??'Hermes'} worker RSS, sampled every 2 seconds; shared workloads included. Missing worker measurements remain unknown. Peaks between samples may be missed.`};
        await save(path.join(trialDir,'result.json'),trial);campaign.trials.push(compactTrial(trial));await persist();
        if(campaign.stopReason)break;
      }
      campaign.status=campaign.stopReason==='resource-limit'?'stopped':campaign.trials.length===rows.length?'finished':abort.signal.aborted?'cancelled':'stopped';
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
        const baseline=await probe({harness:plan.harness});
        if(closed)throw new Error('Diagnostics is closed');
        if(plan.maxGpuUsedMiB!==null&&!baseline.hardware.gpus?.length)throw new Error('GPU memory budget needs available NVIDIA telemetry');
        const coreHash=await codeFingerprint();
        campaign={id:randomUUID(),status:'running',createdAt:new Date().toISOString(),plan,input,inventory:baseline,harborFingerprint:coreHash,plannedTrials:rows.length,trials:[],suite:suiteFor(plan)};
        await mkdir(path.join(root,campaign.id));await persist();
        if(closed){campaign.status='cancelled';campaign.stopReason='application-closing';campaign.endedAt=new Date().toISOString();await persist();throw new Error('Diagnostics is closed');}
        abort=new AbortController();active=run(plan,rows,baseline,coreHash,lock);active.catch(e=>{problem=e.message;});
        return snapshot();
      }catch(e){await lock.close();throw e;}
  }
  return {probe,snapshot,start:async input=>{const plan=validatePlan(input);if(plan.harness!==selectedHarness)await probe({harness:plan.harness});return track(start(input));},
    listCampaigns:input=>archived(()=>archive.list(input)),
    inspectCampaign:id=>archived(()=>archive.inspect(id)),
    reviewEvidence:id=>archived(async()=>{
      if(active)throw new Error('Finish the active diagnostic campaign before reviewing advice');
      const saved=await archive.inspect(id);
      // Missing or overlapping evidence must stay inconclusive without
      // starting a model or requiring an otherwise unnecessary model probe.
      if(saved.campaign.status!=='finished'||!saved.results.recommendation.winner)return {campaign:saved.campaign,current:null};
      const lock=await claimCampaignLock(root);
      try{
        const fresh=await probe();
        return {campaign:saved.campaign,current:{backendId:setupIdentity({baseline:fresh}).backendId,hardwareId:hash({...fresh.hardware,gpus:fresh.hardware.gpus?.map(({usedMiB,...gpu})=>gpu)}),harborFingerprint:await codeFingerprint(),suite:suiteFor(saved.campaign.plan)}};
      }finally{await lock.close();}
    }),
    exportCampaign:id=>archived(()=>archive.export(id)),
    inspectTrial:input=>archived(()=>archive.trial(input??{})),
    cancel(){if(abort){campaign.stopReason='user-cancelled';abort.abort();}return snapshot();},
    close(){
      if(closing)return closing;closed=true;lifetime.abort(new Error('Diagnostics is closed'));
      if(abort){campaign.stopReason='application-closing';abort.abort();}
      return closing=(async()=>{
        const cleanup=Promise.allSettled([Promise.resolve().then(()=>systemMonitor.close()),...Object.values(harnessAdapters).map(value=>Promise.resolve().then(()=>value.close?.()))]);
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
