import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createGateway} from '../src/core/gateway.mjs';
import {createTask} from '../src/diagnostics/tasks.mjs';
import {createWorkloadTask} from '../src/diagnostics/workloads.mjs';
import {WORKLOAD_TASKS} from '../src/diagnostics/workload-catalog.js';
import {createCatalogVariant,validationSchema} from '../src/diagnostics/catalog-variants.mjs';
import {validatePlan} from '../src/diagnostics/plans.mjs';
import {createDiagnostics} from '../src/diagnostics/service.mjs';
import {deliveryEvidence} from '../src/diagnostics/delivery-evidence.mjs';

test('schema annotation reduction retains property names, assertions, defaults and valid/invalid argument behavior',()=>{
  const original={title:'Fixture arguments',description:'Documentation',type:'object',properties:{description:{type:'string',minLength:2,description:'A field literally named description'},title:{type:'integer',minimum:1,default:3},nested:{type:'array',items:{type:'object',properties:{value:{enum:['a','b'],description:'Choice'}},required:['value'],additionalProperties:false}}},required:['description','title'],additionalProperties:false};
  const reduced=validationSchema(original);assert(!Object.hasOwn(reduced,'description'));assert.equal(reduced.properties.description.minLength,2);assert.equal(reduced.properties.title.default,3);assert.deepEqual(reduced.required,original.required);assert.equal(reduced.additionalProperties,false);
  const ajv=new Ajv({strict:false}),before=ajv.compile(original),after=ajv.compile(reduced);
  for(const args of [{description:'ok',title:1},{description:'ok',title:2,nested:[{value:'a'}]},{description:'x',title:1},{description:'ok'},{description:'ok',title:0},{description:'ok',title:2,nested:[{value:'c'}]},{description:'ok',title:2,extra:true}])assert.equal(after(args),before(args),JSON.stringify(args));
  assert.equal(original.description,'Documentation');assert.throws(()=>validationSchema(null),/Invalid/);
});

test('catalog changes are explicit, preserve complete workflows and never mutate the source tools',async()=>{
  const task=createTask('chain','contract'),original=structuredClone(task.upstreams.tools()),variant=createCatalogVariant(task,{subset:'workflow',descriptions:'concise',schemaAnnotations:'minimal',order:'name-desc',provider:'alternate'},{overlapProviders:true});
  assert.equal(variant.baseCatalog.length,14);assert.equal(variant.catalog.length,3);assert(variant.catalog.every(tool=>tool.name.startsWith('diag_alternate__')));assert.deepEqual(variant.catalog.map(tool=>tool.name),variant.catalog.map(tool=>tool.name).sort().reverse());
  assert.deepEqual(task.upstreams.tools(),original);assert(!variant.upstreams.get('diag'));assert.equal(variant.metadata.workflowPreserved,true);assert.equal(variant.metadata.filteredTools.length,11);assert.notEqual(variant.metadata.baseCatalogFingerprint,variant.metadata.catalogFingerprint);
  for(const tool of variant.catalog){const source=original.find(value=>value.originalName===tool.name.split('__')[1]);assert.deepEqual(validationSchema(tool.inputSchema),validationSchema(source.inputSchema));}
  const evidence=deliveryEvidence({catalog:variant.catalog,baseCatalog:variant.baseCatalog,catalogVariant:variant.metadata,relevantToolNames:variant.relevantToolNames,traceBundle:{events:[],evicted:0}});assert.equal(evidence.workflowAvailable,true);assert(!evidence.observedFailureStages.includes('required-capability-unavailable'));
  assert.throws(()=>createCatalogVariant(task,{provider:'alternate'}),/equivalent-provider/);assert.throws(()=>validatePlan({variants:[{id:'x',catalog:{subset:'invented'}}]}),/Invalid catalog/);assert.throws(()=>validatePlan({overlapProviders:'yes'}),/enabled or disabled/);
});

test('every representative task retains its declared complete workflow under each fixture provider',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor catalog workflows '));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  for(const {id} of WORKLOAD_TASKS){const task=await createWorkloadTask(id,'catalog-check',{directory:path.join(root,id)});try{for(const provider of ['all','primary','alternate']){const variant=createCatalogVariant(task,{subset:'workflow',provider},{overlapProviders:true});const evidence=deliveryEvidence({catalog:variant.catalog,catalogVariant:variant.metadata,relevantToolNames:variant.relevantToolNames,traceBundle:{events:[],evicted:0}});assert.equal(evidence.workflowAvailable,true,id);}}finally{await task.close();}}
});

test('real gateway lists transformed schemas, dispatches equivalent provider routes and rejects filtered originals',async t=>{
  const task=createTask('lookup','routes'),variant=createCatalogVariant(task,{subset:'workflow',provider:'alternate',schemaAnnotations:'minimal'},{overlapProviders:true});
  const gateway=await createGateway({host:'127.0.0.1',port:0,upstreams:variant.upstreams,log:()=>{},toolMode:'all'});t.after(()=>gateway.close());
  const client=new Client({name:'catalog-contract-test',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(gateway.endpoint));await client.connect(transport);t.after(()=>client.close());
  const tools=(await client.listTools()).tools;assert.equal(tools.length,2);assert(!tools[0].inputSchema.properties.id.description);
  const read=await client.callTool({name:'diag_alternate__read_record',arguments:{id:'record-routes'}});const value=JSON.parse(read.content[0].text).value;
  await client.callTool({name:'diag_alternate__write_result',arguments:{value}});assert.equal(task.verify(JSON.stringify({status:'done',value})).completed,true);
  await assert.rejects(client.callTool({name:'diag__reset_records',arguments:{confirm:true}}),/Unknown tool/);assert.equal(task.events.length,2);
  const bad=await client.callTool({name:'diag_alternate__write_result',arguments:{value,extra:true}});assert.equal(bad.isError,true);
});

test('fixture initialization failure is saved as an excluded inspectable trial',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor fixture setup failure '));const baseline={revision:'test',fingerprint:'test',model:'test',provider:'fixture',reasoning:'none',hardware:{gpus:null}};
  const diagnostics=await createDiagnostics({dataDir:root,adapter:{probe:async()=>baseline,run:async()=>{throw Error('Must not dispatch');}},taskFactory:async()=>{throw Error('Synthetic setup failure');}});
  t.after(async()=>{await diagnostics.close();await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  await diagnostics.start({tasks:['lookup'],variants:[{id:'all',toolMode:'all'}],repetitions:1});const snapshot=await diagnostics.wait();assert.equal(snapshot.campaign.trials.length,1);const trial=snapshot.campaign.trials[0];assert.equal(trial.eligible,false);assert.equal(trial.status,'infrastructure-error');assert.match(trial.error,/setup failure/);assert.equal((await diagnostics.inspectTrial({campaignId:snapshot.campaign.id,trialId:trial.id})).error,trial.error);
});

test('real Hybrid search indexes the transformed catalog and invokes only its selected provider',{
  skip:!process.env.HARBOR_TOOL_RUNTIME_ROOT,timeout:90000
},async t=>{
  const task=createTask('lookup','hybrid-variant'),variant=createCatalogVariant(task,{subset:'workflow',provider:'alternate',descriptions:'concise',schemaAnnotations:'minimal'},{overlapProviders:true});
  const settings={toolMode:'hybrid',hybridModes:['bm25','regex'],searchLimit:5},gateway=await createGateway({...settings,host:'127.0.0.1',port:0,upstreams:variant.upstreams,log:()=>{}});t.after(()=>gateway.close());await gateway.prepareMode(settings);
  const client=new Client({name:'hybrid-catalog-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(gateway.endpoint)));t.after(()=>client.close());
  const search=await client.callTool({name:'search_tools',arguments:{query:'read write'}}),returned=JSON.parse(search.content[0].text);assert.equal(returned.tools.length,2);assert(returned.tools.every(tool=>tool.name.startsWith('diag_alternate__')));assert(!returned.tools.find(tool=>tool.name.endsWith('read_record')).inputSchema.properties.id.description);
  const read=await client.callTool({name:'call_tool',arguments:{name:'diag_alternate__read_record',arguments:{id:'record-hybrid-variant'}}}),value=JSON.parse(read.content[0].text).value;
  await client.callTool({name:'call_tool',arguments:{name:'diag_alternate__write_result',arguments:{value}}});assert.equal(task.verify(JSON.stringify({status:'done',value})).completed,true);
  assert.equal((await client.callTool({name:'call_tool',arguments:{name:'diag__write_result',arguments:{value}}})).isError,true);assert.equal(task.events.length,2);
});
