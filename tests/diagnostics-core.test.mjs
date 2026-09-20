import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {validatePlan,schedule} from '../src/diagnostics/plans.mjs';
import {createTask} from '../src/diagnostics/tasks.mjs';
import {compare,wilson} from '../src/diagnostics/grading.mjs';
import {createDiagnostics} from '../src/diagnostics/service.mjs';
import {claimCampaignLock} from '../src/diagnostics/lock.mjs';

test('balanced seeded schedule uses identical task payloads across configurations',()=>{
  const p=validatePlan(),a=schedule(p);assert.deepEqual(a,schedule(p));assert.equal(a.length,108);
  for(const task of p.tasks)assert.equal(new Set(a.filter(r=>r.task===task&&r.repetition===0).map(r=>r.nonce)).size,1);
  assert.throws(()=>validatePlan({variants:[{id:'cloud',toolMode:'portkey-api'}]}),/local/);
  assert.throws(()=>validatePlan({repetitions:0}),/repetitions/);
  assert.throws(()=>validatePlan({variants:[{id:'x',toolMode:'all',port:37373}]}),/Invalid/);
});
test('oracle rejects claims, wrong values, forbidden writes, wrong order and malformed arguments',async()=>{
  const t=createTask('boundary','abc'),call=(name,args)=>t.upstreams.get().client.callTool({name,arguments:args});
  assert.equal(t.verify('{"status":"done","value":"value-abc"}').completed,false);
  await call('read_record',{id:'record-abc',extra:true});assert.equal(t.events[0].schemaValid,false);
  await call('reset_records',{confirm:true});await call('write_result',{value:'value-abc'});
  const v=t.verify('{"status":"done","value":"value-abc"}');assert.equal(v.completed,false);assert.equal(v.adherent,false);
});
test('oracle verifies positive chains, expected retry and appropriate abstention',async()=>{
  for(const id of ['lookup','chain','recovery']){
    const t=createTask(id,'abc'),c=(name,args)=>t.upstreams.get().client.callTool({name,arguments:args});
    if(id==='recovery'){assert((await c('unstable_read',{id:'record-abc'})).isError);await c('unstable_read',{id:'record-abc'});}else await c('read_record',{id:'record-abc'});
    if(id==='chain')await c('read_next',{id:'next-abc'});
    const value=id==='chain'?'joined-abc':'value-abc';await c('write_result',{value});const v=t.verify(JSON.stringify({status:'done',value}));assert(v.completed);assert(v.adherent);assert.equal(v.toolCorrect,1);
  }
  assert(createTask('unavailable','abc').verify('{"status":"blocked","reason":"unavailable"}').completed);
  assert(createTask('no-tool','abc').verify('{"status":"done","value":"abc"}').completed);
});
test('comparisons retain unknowns and abstain on unmatched or tiny samples',()=>{
  assert.equal(compare([]).recommendation.winner,null);assert.equal(wilson(0,0),null);
  const row={configId:'a',modelId:'m',harnessId:'h',hardwareId:'hw',combinationId:'a/m/h',task:'lookup',repetition:0,eligible:true,status:'finished',elapsedMs:100,grade:{completed:true,adherent:true,accepted:true,claimedDone:true,toolCorrect:null}};
  const r=compare([row,{...row,configId:'b',eligible:false,status:'infrastructure-error'}]);assert.equal(r.configurations[1].verifiedCompletion,null);assert.equal(r.recommendation.winner,null);assert.equal(r.configurations[0].toolCorrectness,null);
});

test('summary separates cancellations and excluded outcomes from observed metric denominators',()=>{
  const row={configId:'all',eligible:true,status:'finished',elapsedMs:1,grade:{completed:true,accepted:true,adherent:true,toolCorrect:0},argumentCorrectness:0};
  const rows=[row,{...row,grade:{...row.grade,toolCorrect:null},argumentCorrectness:null},
    ...['cancelled','timeout','infrastructure-error','resource-limit'].map(status=>({...row,status,eligible:false}))];
  const summary=compare(rows).configurations[0];
  assert.equal(summary.trials,6);assert.equal(summary.eligible,2);assert.equal(summary.excluded,4);
  for(const field of ['cancellations','timeouts','failures','resourceLimitStops','toolSelectionObserved','argumentCorrectnessObserved'])assert.equal(summary[field],1);
  assert.equal(summary.toolCorrectness,0);assert.equal(summary.argumentCorrectness,0);assert.equal(summary.verifiedCompletion,1);
  const unknown=compare([{...row,grade:{...row.grade,toolCorrect:null},argumentCorrectness:null}]).configurations[0];
  assert.equal(unknown.toolSelectionObserved,0);assert.equal(unknown.toolCorrectness,null);
});
const baseline={harness:'Hermes',revision:'test',fingerprint:'fixture',model:'fixture-model',provider:'fixture',reasoning:'high',hardware:{logicalCpus:1,ramBytes:1024,gpus:null}};
test('campaign exercises real private MCP gateway, verifies artifacts and reloads persisted results',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'harbor-diagnostics-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const adapter={probe:async()=>baseline,async run(req,{onEvent}){
    const c=new Client({name:'explicit-test-fixture',version:'1'});await c.connect(new StreamableHTTPClientTransport(new URL(req.gateway)));
    try{
      onEvent({type:'ready',inventory:baseline,startupMs:1});const id=req.prompt.match(/record (record-\w+)/)[1];
      const read=await c.callTool({name:'diag__read_record',arguments:{id}}),value=JSON.parse(read.content[0].text).value;
      await c.callTool({name:'diag__write_result',arguments:{value}});
      return {status:'finished',events:[],result:{finalResponse:JSON.stringify({status:'done',value}),harnessCompleted:true,modelReported:'fixture-model'}};
    }finally{await c.close();}
  }};
  const d=await createDiagnostics({dataDir:dir,adapter});t.after(()=>d.close());
  await d.start({tasks:['lookup'],variants:[{id:'all',toolMode:'all'}],repetitions:1});const s=await d.wait();
  assert.equal(s.campaign.status,'finished');assert(s.campaign.trials[0].eligible);assert(s.campaign.trials[0].grade.completed);assert.equal(s.campaign.trials[0].cost,null);
  const reloaded=await createDiagnostics({dataDir:dir,adapter});assert.equal(reloaded.snapshot().campaign.id,s.campaign.id);
});
test('cancellation stops the adapter and excludes the interrupted result',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'harbor-diagnostics-'));t.after(()=>rm(dir,{recursive:true,force:true}));let entered;
  const running=new Promise(r=>entered=r);
  const adapter={probe:async()=>baseline,run:async(req,{signal,onEvent})=>{onEvent({type:'ready',inventory:baseline,startupMs:0});entered();await new Promise(r=>{if(signal.aborted)r();else signal.addEventListener('abort',r,{once:true});});return {status:'cancelled',events:[]};}};
  const d=await createDiagnostics({dataDir:dir,adapter});await d.start({tasks:['lookup'],variants:[{id:'all',toolMode:'all'}],repetitions:2});await running;d.cancel();const s=await d.wait();assert.equal(s.campaign.status,'cancelled');assert.equal(s.campaign.trials[0].eligible,false);
});

test('resource limits and forbidden discovery calls cannot produce passing rows',async t=>{
  for(const resource of [true,false]){
    const dir=await mkdtemp(path.join(os.tmpdir(),'harbor-diagnostics-'));t.after(()=>rm(dir,{recursive:true,force:true}));
    const adapter={probe:async()=>baseline,run:async(req,{onEvent})=>{
      onEvent({type:'ready',inventory:baseline,startupMs:1});
      if(resource)onEvent({type:'resources',hostUsedGiB:20,workerRssBytes:1,gpus:null});
      return {status:'finished',events:[{type:'tool-start',name:'search_tools',schemaValid:true}],result:{finalResponse:'{"status":"blocked","reason":"unavailable"}',modelReported:'fixture-model'}};
    }};
    const d=await createDiagnostics({dataDir:dir,adapter});await d.start({tasks:['unavailable'],variants:[{id:'all',toolMode:'all'}],repetitions:1,maxHostUsedGiB:resource?1:null});const s=await d.wait(),row=s.campaign.trials[0];assert.equal(row.grade.completed,false);assert.equal(row.eligible,!resource);if(resource)assert.equal(row.status,'resource-limit');await d.close();
  }
});
test('two controllers cannot run into the same result directory',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'harbor-diagnostics-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let entered;const ready=new Promise(r=>entered=r);
  const adapter={probe:async()=>baseline,run:async(req,{signal})=>{entered();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return {status:'cancelled',events:[]};}};
  const one=await createDiagnostics({dataDir:dir,adapter}),two=await createDiagnostics({dataDir:dir,adapter});
  const plan={tasks:['lookup'],variants:[{id:'all',toolMode:'all'}],repetitions:1};await one.start(plan);await ready;await assert.rejects(two.start(plan),/instance/);one.cancel();await one.wait();await one.close();await two.close();
});

test('Windows ownership lock recovers confirmed-dead owners and preserves live or unknown owners',{skip:process.platform!=='win32'},async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'harbor-diagnostics-lock-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'campaign.lock');
  await writeFile(file,JSON.stringify({pid:2147483647,host:os.hostname(),token:'dead-fixture'}));
  const recovered=await claimCampaignLock(dir);assert(recovered.recovered);const owned=JSON.parse(await readFile(file,'utf8'));assert.equal(owned.pid,process.pid);
  await assert.rejects(claimCampaignLock(dir),/Another diagnostic instance/);assert.equal(JSON.parse(await readFile(file,'utf8')).token,owned.token);await recovered.close();await assert.rejects(access(file));
  await writeFile(file,'not-json');await assert.rejects(claimCampaignLock(dir),/Cannot verify/);assert.equal(await readFile(file,'utf8'),'not-json');
  await writeFile(file,'');await assert.rejects(claimCampaignLock(dir),/Cannot verify/);assert.equal(await readFile(file,'utf8'),'');
});

test('a RAM or GPU limit ends the entire campaign and cleans up before another trial can start',async t=>{
  for(const kind of ['ram','gpu'])for(const reject of [false,true])for(const repetitions of [1,3]){
    const dir=await mkdtemp(path.join(os.tmpdir(),'harbor-resource-stop-'));t.after(()=>rm(dir,{recursive:true,force:true}));
    let runs=0,closed=0;
    const inventory={...baseline,hardware:{...baseline.hardware,gpus:[{name:'fixture',usedMiB:1}]}};
    const adapter={probe:async()=>inventory,run:async(req,{signal,onEvent})=>{
      runs++;onEvent({type:'ready',inventory,startupMs:1});
      onEvent({type:'resources',hostUsedGiB:kind==='ram'?20:0,workerRssBytes:1,gpus:[{usedMiB:kind==='gpu'?200:1}]});
      assert.equal(signal.aborted,true);
      if(reject)throw new Error('Adapter aborted after resource sample');
      return {status:'cancelled',events:[]};
    }};
    const d=await createDiagnostics({dataDir:dir,adapter,taskFactory:(id,nonce)=>({...createTask(id,nonce),close:async()=>{closed++;}})});t.after(()=>d.close());
    await d.start({tasks:['lookup'],variants:[{id:'all',toolMode:'all'}],repetitions,maxHostUsedGiB:kind==='ram'?1:null,maxGpuUsedMiB:kind==='gpu'?100:null});
    const s=await d.wait();assert.equal(s.campaign.status,'stopped');assert.equal(s.campaign.stopReason,'resource-limit');
    assert.equal(s.campaign.plannedTrials,repetitions);assert.equal(s.campaign.trials.length,1);assert.equal(runs,1);assert.equal(closed,1);
    assert.equal(s.campaign.trials[0].status,'resource-limit');assert.equal(s.campaign.trials[0].eligible,false);
    assert.equal(JSON.parse(await readFile(path.join(dir,'latest.json'),'utf8')).stopReason,'resource-limit');
    await d.close();
  }
});
test('500 MB available-memory floor blocks startup and aborts an active campaign with budgets disabled',async t=>{
  for(const initial of [500_000_000,499_999_999,501_000_000]){
    const dir=await mkdtemp(path.join(os.tmpdir(),'harbor-emergency-memory-'));t.after(()=>rm(dir,{recursive:true,force:true}));
    let available=initial,runs=0;
    const adapter={probe:async()=>baseline,run:async(req,{signal,onEvent})=>{
      runs++;onEvent({type:'ready',inventory:baseline,startupMs:1});available=499_000_000;
      await new Promise(resolve=>signal.aborted?resolve():signal.addEventListener('abort',resolve,{once:true}));
      return {status:'cancelled',events:[]};
    }};
    const d=await createDiagnostics({dataDir:dir,adapter,memoryReader:()=>available});t.after(()=>d.close());
    await d.start({tasks:['lookup'],variants:[{id:'all',toolMode:'all'}],repetitions:2,maxHostUsedGiB:null,maxGpuUsedMiB:null});
    const s=await d.wait();assert.equal(s.campaign.status,'stopped');assert.equal(s.campaign.stopReason,'resource-limit');
    assert.equal(s.campaign.resourceLimit,'500 MB available system memory emergency floor');
    assert.equal(runs,initial>500_000_000?1:0);assert.equal(s.campaign.trials.length,runs);
    if(runs){assert.equal(s.campaign.trials[0].status,'resource-limit');assert.equal(s.campaign.trials[0].eligible,false);}
    await d.close();
  }
});

test('harness selection records OpenClaw identity and preserves unknown resource readings',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'harbor-harness-selection-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const open={...baseline,harness:'OpenClaw',reasoning:'off'};let home,closed=0;
  const fake={probe:async()=>open,close:async()=>{closed++;},run:async(req,{onEvent})=>{home=req.home;onEvent({type:'ready',inventory:open});onEvent({type:'resources',hostUsedGiB:1,workerRssBytes:null,hostCpuPercent:null,gpus:[]});return {status:'finished',events:[],result:{finalResponse:'{}',modelReported:open.model}};}};
  const d=await createDiagnostics({dataDir:dir,adapter:{probe:async()=>baseline},adapters:{openclaw:fake}});t.after(()=>d.close());
  await assert.rejects(d.probe({harness:'invalid'}),/Choose/);
  await d.start({harness:'openclaw',tasks:['no-tool'],variants:[{id:'all',toolMode:'all'}],repetitions:1});
  const s=await d.wait();assert.equal(s.harness,'openclaw');assert.equal(s.campaign.inventory.harness,'OpenClaw');
  assert(s.campaign.trials[0].harnessId.startsWith('OpenClaw:'));assert(home.endsWith('openclaw-home'));
  assert.equal(s.campaign.trials[0].resources.peakWorkerRssBytes,null);assert.equal(s.campaign.trials[0].resources.meanHostCpuPercent,null);
  await d.probe({harness:'hermes'});assert.equal(d.snapshot().inventory.harness,'Hermes');await d.close();assert.equal(closed,1);
});
