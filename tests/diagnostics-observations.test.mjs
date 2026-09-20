import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createDiagnostics} from '../src/diagnostics/service.mjs';
import {createHermesAdapter} from '../src/diagnostics/hermes.mjs';
const baseline={harness:'Hermes',revision:'synthetic-adapter',fingerprint:'synthetic-source',model:'synthetic-model',provider:'fixture',reasoning:'none',hardware:{logicalCpus:1,ramBytes:1024,gpus:null}};

test('campaign summaries stay compact while saved trial inspection retains real gateway observations',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor trial observations '));
  const adapter={probe:async()=>baseline,run:async(request,{onEvent})=>{
    const client=new Client({name:'Synthetic diagnostic adapter',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(request.gateway));
    try{
      await client.connect(transport);const tools=(await client.listTools()).tools;
      onEvent({type:'ready',inventory:baseline,advertisedDefinitions:tools});
      const id=request.prompt.match(/record-[0-9a-f]+/)[0];
      const value=JSON.parse((await client.callTool({name:'diag__read_record',arguments:{id}})).content[0].text).value;
      await client.callTool({name:'diag__write_result',arguments:{value}});
      return {status:'finished',events:[{type:'tool-start',schemaValid:true},{type:'tool-start',schemaValid:true}],result:{finalResponse:JSON.stringify({status:'done',value}),modelReported:baseline.model}};
    }finally{await transport.terminateSession().catch(()=>{});await client.close();}
  }};
  const diagnostics=await createDiagnostics({dataDir:dir,adapter});t.after(async()=>{await diagnostics.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  await diagnostics.start({tasks:['lookup'],variants:[{id:'all',toolMode:'all'}],repetitions:1});const result=await diagnostics.wait(),trial=result.campaign.trials[0];
  assert.equal(trial.grade.completed,true);assert(!Object.hasOwn(trial,'trace'));assert(!Object.hasOwn(trial,'deliveryEvidence'));assert.equal(trial.deliveryObservation.upstreamExecutions,2);
  const details=await diagnostics.inspectTrial({campaignId:result.campaign.id,trialId:trial.id});
  assert.equal(details.deliveryEvidence.catalog.length,7);assert.equal(details.deliveryEvidence.initialPresentation.definitions.length,7);
  assert.equal(details.deliveryEvidence.perModelRequestPresentation,null,'An uninstrumented synthetic adapter cannot imply per-request visibility');
  assert(details.trace.events.some(event=>event.kind==='upstream'&&event.status==='completed'));assert.equal(details.trace.settings.maxBytes,256*1024);
  await assert.rejects(diagnostics.inspectTrial({campaignId:'../../outside',trialId:trial.id}),/Choose/);
});

test('adapter event budget stays bounded and preserves an explicit terminal result with loss marked',async t=>{
  const script="process.stdin.resume();process.stdin.on('end',()=>{for(let i=0;i<2010;i++)console.log(JSON.stringify({type:'model-request',sequence:i,definitions:[]}));console.log(JSON.stringify({type:'result',finalResponse:'fixture result'}));});";
  const adapter=createHermesAdapter({spawnProcess:(_python,_args,options)=>spawn(process.execPath,['-e',script],options)});t.after(()=>adapter.close());
  const result=await adapter.run({maxTrialSeconds:10});assert.equal(result.eventsTruncated,true);assert.equal(result.events.length,2000);assert.equal(result.result.finalResponse,'fixture result');assert(result.capturedBytes<=8*1024*1024);
});
