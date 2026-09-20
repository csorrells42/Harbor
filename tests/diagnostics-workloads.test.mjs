import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createWorkloadTask,parseFixtureCsv} from '../src/diagnostics/workloads.mjs';
import {WORKLOAD_TASKS} from '../src/diagnostics/workload-catalog.js';
import {validatePlan,schedule} from '../src/diagnostics/plans.mjs';

async function setup(t,id,nonce='fixture-seed'){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor workload ')),directory=path.join(root,'fixture');
  const task=await createWorkloadTask(id,nonce,{directory});t.after(async()=>{await task.close();assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const raw=(name,args={})=>task.upstreams.get().client.callTool({name,arguments:args});
  const call=async(name,args={})=>{const result=await raw(name,args);assert(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);};
  return {task,directory,raw,call,read:async file=>JSON.parse((await call('fs_read',{path:file})).content)};
}
const done=artifact=>JSON.stringify({status:'done',artifact});
const quote=value=>'"'+String(value).replaceAll('"','""')+'"';

test('a forbidden action remains an adherence failure even after a correct artifact',async t=>{
  const {task,call,raw,directory}=await setup(t,'merge-csv','permissions-contract');
  const original=await fs.readFile(path.join(directory,'input/part-a.csv'));
  const refusal=await raw('fs_remove',{path:'input/part-a.csv'});
  assert.equal(refusal.isError,true);
  assert.match(JSON.parse(refusal.content[0].text).error,/outside this synthetic task capability/);
  assert.deepEqual(await fs.readFile(path.join(directory,'input/part-a.csv')),original);
  await call('csv_merge',{sources:['input/part-a.csv','input/part-b.csv'],output:'output/result.csv',key:'id'});
  const grade=await task.verify(done('output/result.csv'));
  assert.equal(grade.completed,true);assert.equal(grade.adherent,false);assert.equal(grade.boundaryAttempts,1);
});

test('representative task planning preserves conformance defaults and matched workload seeds',()=>{
  assert.equal(validatePlan().tasks.length,6);
  const plan=validatePlan({tasks:WORKLOAD_TASKS.map(task=>task.id),variants:[{id:'all',toolMode:'all'},{id:'search',toolMode:'bm25'}],repetitions:2});
  assert.equal(schedule(plan).length,40);
  for(const task of plan.tasks)assert.equal(new Set(schedule(plan).filter(row=>row.task===task&&row.repetition===0).map(row=>row.nonce)).size,1);
});

test('document oracle accepts renderer and manual writing but rejects claims and protected-input changes',async t=>{
  for(const manual of [false,true]){
    const {task,call,read,directory}=await setup(t,'document-brief','doc-'+manual);
    assert.equal((await task.verify(done('output/result.md'))).completed,false);
    const brief=await read('input/brief.json'),body=[brief.project,brief.owner,brief.deadline,String(brief.budget),...brief.objectives].join('\n');
    if(manual)await call('fs_write',{path:'output/result.md',content:'# '+brief.project+'\n\n## Facts\n'+body});
    else await call('document_render',{path:'output/result.md',title:brief.project,sections:[{heading:'Facts',body}]});
    assert.equal((await task.verify(done('output/result.md'))).completed,true);
    await fs.writeFile(path.join(directory,'input/brief.json'),'tampered source');assert.equal((await task.verify(done('output/result.md'))).completed,false);
  }
});

test('document budget accepts currency grouping without accepting wrong signed or fractional amounts',async t=>{
  const {task,call,read}=await setup(t,'document-brief','formatted-budget');
  const brief=await read('input/brief.json'),grouped=brief.budget.toLocaleString('en-US');
  const check=async value=>{
    const content='# '+brief.project+'\n\n## Facts\n'+[brief.owner,brief.deadline,value,...brief.objectives].join('\n');
    await call('fs_write',{path:'output/result.md',content});
    return (await task.verify(done('output/result.md'))).completed;
  };
  for(const value of [String(brief.budget),grouped,'$'+grouped,'$'+grouped+'.00',grouped+'.','$'+grouped+'.00.'])assert.equal(await check(value),true,value);
  for(const value of ['-'+brief.budget,'-$'+grouped,brief.budget+'.01',brief.budget+'0',grouped+',000','0.'+brief.budget,'1,'+grouped,'<!-- '+brief.budget+' -->'])assert.equal(await check(value),false,value);
});

test('document prose accepts objective capitalization while still requiring both objectives and strict final JSON',async t=>{
  const {task,call,read}=await setup(t,'document-brief','objective-capitalization');
  const brief=await read('input/brief.json');
  const writeObjectives=async objectives=>call('document_render',{path:'output/result.md',title:brief.project,sections:[{heading:'Facts',body:[brief.owner,brief.deadline,'The budget is '+brief.budget.toLocaleString('en-US')+'.',objectives].join('\n')}]});
  await writeObjectives('The objectives are to '+brief.objectives.map(value=>value.toLowerCase()).join(' and ')+'.');
  assert.equal((await task.verify(done('output/result.md'))).completed,true);
  const fenced=await task.verify('```json\n'+done('output/result.md')+'\n```');assert.equal(fenced.completed,true);assert.equal(fenced.adherent,false);
  await writeObjectives(brief.objectives.join(' and ').toUpperCase());assert.equal((await task.verify(done('output/result.md'))).completed,true);
  await writeObjectives(brief.objectives[0].toLowerCase());assert.equal((await task.verify(done('output/result.md'))).completed,false);
  await writeObjectives('<!-- '+brief.objectives.join(' and ').toLowerCase()+' -->');assert.equal((await task.verify(done('output/result.md'))).completed,false);
});

test('CSV merge and JSON conversion preserve complex values and accept alternative sequences',async t=>{
  for(const manual of [false,true]){
    const {task,call}=await setup(t,'merge-csv','merge-'+manual);
    if(manual){
      const a=parseFixtureCsv((await call('fs_read',{path:'input/part-a.csv'})).content),b=parseFixtureCsv((await call('fs_read',{path:'input/part-b.csv'})).content),merged=new Map([...a.slice(1),...b.slice(1)].map(row=>[row[0],row]));
      const rows=[a[0],...[...merged.values()].reverse()];await call('fs_write',{path:'output/result.csv',content:rows.map(row=>row.map(quote).join(',')).join('\n')});
    }else await call('csv_merge',{sources:['input/part-a.csv','input/part-b.csv'],output:'output/result.csv',key:'id'});
    assert.equal((await task.verify(done('output/result.csv'))).completed,true);
    await call('csv_merge',{sources:['input/part-b.csv','input/part-a.csv'],output:'output/result.csv',key:'id'});
    assert.equal((await task.verify(done('output/result.csv'))).completed,false,'Wrong duplicate precedence must fail');
  }
  for(const manual of [false,true]){
    const {task,call}=await setup(t,'convert-records','convert-'+manual);
    if(manual){const [header,...rows]=parseFixtureCsv((await call('fs_read',{path:'input/part-a.csv'})).content);await call('fs_write',{path:'output/result.json',content:JSON.stringify(rows.reverse().map(row=>Object.fromEntries(header.map((key,i)=>[key,row[i]]))))});}
    else await call('csv_to_json',{source:'input/part-a.csv',output:'output/result.json'});
    assert.equal((await task.verify(done('output/result.json'))).completed,true);
  }
});

test('file oracle accepts rename or copy/remove and requires exact bytes, removal and unrelated-file preservation',async t=>{
  for(const copy of [false,true]){
    const {task,call,directory}=await setup(t,'organize-files','files-'+copy);
    for(const name of ['meeting.txt','image-note.txt'])if(copy){const {content}=await call('fs_read',{path:'inbox/'+name});await call('fs_write',{path:'output/'+name,content});await call('fs_remove',{path:'inbox/'+name});}else await call('fs_move',{source:'inbox/'+name,destination:'output/'+name});
    assert.equal((await task.verify(done('output/'))).completed,true);
    await fs.writeFile(path.join(directory,'output/meeting.txt'),'wrong bytes');assert.equal((await task.verify(done('output/'))).completed,false);
  }
});

test('SQLite and dependent-report verifiers inspect real query results, allow alternate SQL and reject wrong totals',async t=>{
  for(const id of ['database-summary','dependent-report']){
    const {task,call,read}=await setup(t,id);
    const schema=await call('db_schema');assert.deepEqual(schema.tables[0].columns.map(column=>column.name),['id','region','status','total_cents']);
    const results=await call('db_query',{sql:"SELECT total_cents FROM orders WHERE status='paid' AND region='West' ORDER BY id DESC"});
    const total=results.rows.reduce((sum,row)=>sum+row.total_cents,0),count=results.rows.length;
    const artifact=id==='database-summary'?'output/result.json':'output/result.md';
    if(id==='database-summary')await call('fs_write',{path:artifact,content:JSON.stringify({region:'West',totalCents:total,orderCount:count})});
    else {const brief=await read('input/brief.json');await call('document_render',{path:artifact,title:brief.project,sections:[{heading:'Summary',body:brief.owner+'\nTotalCents: '+total+'\nOrderCount: '+count}]});}
    assert.equal((await task.verify(done(artifact))).completed,true);
    await call('fs_write',{path:artifact,content:'{"region":"West","totalCents":0,"orderCount":3}'});assert.equal((await task.verify(done(artifact))).completed,false);
  }
});

test('source ambiguity, transient recovery and unavailable capability have independent outcomes',async t=>{
  const ambiguity=await setup(t,'ambiguous-source');const a=await ambiguity.read('input/archive.json'),b=await ambiguity.read('input/current.json');
  await ambiguity.call('fs_write',{path:'output/result.json',content:JSON.stringify(a)});assert.equal((await ambiguity.task.verify(done('output/result.json'))).completed,false);
  await ambiguity.call('fs_write',{path:'output/result.json',content:JSON.stringify(b)});assert.equal((await ambiguity.task.verify(done('output/result.json'))).completed,true);
  const recovery=await setup(t,'recover-read');const first=await recovery.raw('fs_read',{path:'input/fragile.json'});assert.equal(first.isError,true);const recovered=await recovery.call('fs_read',{path:'input/fragile.json'});await recovery.call('fs_write',{path:'output/result.json',content:recovered.content});assert.equal((await recovery.task.verify(done('output/result.json'))).recovered,true);
  const unavailable=await setup(t,'missing-capability');const blocked='{"status":"blocked","reason":"capability-unavailable"}';assert.equal((await unavailable.task.verify(blocked)).completed,true);await unavailable.call('fs_write',{path:'output/result.json',content:'{"fakeLabel":true}'});assert.equal((await unavailable.task.verify(blocked)).completed,false);
});

test('fixture paths and SQL stay within declared capabilities, and close cancels a running query',async t=>{
  const {task,raw}=await setup(t,'database-summary');
  for(const args of [{path:'../outside',content:'x'},{path:'input/brief.json',content:'x'}])assert.equal((await raw('fs_write',args)).isError,true);
  for(const sql of ["ATTACH DATABASE 'outside.db' AS outside",'DELETE FROM orders','PRAGMA query_only=OFF'])assert.equal((await raw('db_query',{sql})).isError,true);
  const running=raw('db_query',{sql:'WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM counter) SELECT sum(n) FROM counter'});
  const started=Date.now();await new Promise(resolve=>setTimeout(resolve,50));await task.close();assert.equal((await running).isError,true);assert(Date.now()-started<2000);
  assert.equal((await raw('fs_list')).isError,true);
});

test('real Chromium navigates the local fixture, renders values, saves output and leaves proof',{
  skip:!process.env.HARBOR_TEST_WORKLOAD_BROWSER,timeout:30000
},async t=>{
  const {task,call,directory}=await setup(t,'browser-extract','browser-acceptance');
  await call('browser_open',{path:'/catalog'});await call('browser_click',{selector:'#product'});const {content}=await call('browser_text',{selector:'main'});
  const sku=content.match(/A-[\w-]+/)[0],priceCents=Number(content.match(/Price cents\s+(\d+)/)[1]);
  await call('fs_write',{path:'output/result.json',content:JSON.stringify({sku,priceCents,availability:'In stock'})});
  const grade=await task.verify(done('output/result.json'));assert.equal(grade.completed,true);assert.equal(grade.browserStarts,1);assert(grade.browserVersion);
  if(process.env.HARBOR_PHASE2_EVIDENCE){await fs.mkdir(process.env.HARBOR_PHASE2_EVIDENCE,{recursive:true});await fs.copyFile(path.join(directory,'browser-observed.png'),path.join(process.env.HARBOR_PHASE2_EVIDENCE,'workload-browser.png'));}
});
