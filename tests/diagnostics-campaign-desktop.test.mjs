import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import {_electron as electron,expect} from '@playwright/test';

// Installed Hermes and the actual desktop UI, with a deterministic local model
// protocol fixture. This verifies plumbing and grading, never model quality.
test('native Diagnostics runs all six task kinds and reloads independently graded results',{
  skip:!process.env.HARBOR_TEST_INSTALLED_HERMES||!process.env.HARBOR_TEST_DIAGNOSTICS_CAMPAIGN,
  timeout:240000
},async()=>{
  const installed=path.join(process.env.LOCALAPPDATA,'hermes/hermes-agent');
  await fs.access(path.join(installed,'venv/Scripts/python.exe'));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor Diagnostics GUI '));
  const local=path.join(root,'local'),source=path.join(local,'hermes'),profile=path.join(root,'profile');
  await fs.mkdir(path.join(source,'runtimes/llamacpp'),{recursive:true});
  await fs.symlink(installed,path.join(source,'hermes-agent'),'junction');
  const model='diagnostics-desktop-protocol-fixture',requests=[],steps=new Map(),serverErrors=[],fixtureStarted=performance.now();
  const server=createServer(async(req,res)=>{
    try{
      res.setHeader('Content-Type','application/json');
      if(req.method==='GET'){res.end(JSON.stringify({data:[{id:model}]}));return;}
      let body='';for await(const chunk of req)body+=chunk;
      const request=JSON.parse(body);
      if(!request.tools?.length){res.end(JSON.stringify({id:'probe',choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));return;}
      const prompt=request.messages.find(m=>m.role==='user'&&typeof m.content==='string'&&m.content.includes('Diagnostic task.'))?.content;
      assert(prompt,'Missing diagnostic task prompt');
      const task=prompt.includes('external bank account')?'unavailable':prompt.includes('Do not call any tools.')?'no-tool':prompt.includes('unstable_read')?'recovery':prompt.includes('follow its nextId')?'chain':prompt.includes('You must never call reset_records')?'boundary':'lookup';
      const nonce=task==='no-tool'?JSON.parse(prompt.match(/Reply with exactly (\{[^\n]+\})\./)[1]).value:prompt.match(/record-([\w-]+)/)?.[1];
      const key=task+':'+nonce,step=steps.get(key)??0;steps.set(key,step+1);
      const value=task==='chain'?'joined-'+nonce:'value-'+nonce;
      const actions=task==='chain'?[
        ['read_record',{id:'record-'+nonce}],['read_next',{id:'next-'+nonce}],['write_result',{value}]
      ]:task==='recovery'?[
        ['unstable_read',{id:'record-'+nonce}],['unstable_read',{id:'record-'+nonce}],['write_result',{value}]
      ]:task==='lookup'||task==='boundary'?[
        ['read_record',{id:'record-'+nonce}],['write_result',{value}]
      ]:[];
      const action=actions[step],name=action&&request.tools.find(t=>t.function.name.endsWith('diag__'+action[0]))?.function.name;
      if(action)assert(name,'Expected diagnostic tool is not advertised');
      const final=task==='unavailable'?{status:'blocked',reason:'unavailable'}:{status:'done',value:task==='no-tool'?nonce:value};
      const message=action?{role:'assistant',content:null,tool_calls:[{id:'fixture_'+task+'_'+step,type:'function',function:{name,arguments:JSON.stringify(action[1])}}]}:{role:'assistant',content:JSON.stringify(final)};
      requests.push({task,step,tool:action?.[0]??null,stream:!!request.stream,observedMs:performance.now()-fixtureStarted});
      if(request.stream){
        res.setHeader('Content-Type','text/event-stream');
        const delta=action?{role:'assistant',tool_calls:message.tool_calls.map((call,index)=>({...call,index}))}:message;
        res.end(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model,choices:[{index:0,delta,finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model,choices:[{index:0,delta:{},finish_reason:action?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);
      }else res.end(JSON.stringify({id:'fixture',object:'chat.completion',model,choices:[{index:0,message,finish_reason:action?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));
    }catch(error){serverErrors.push(error.message);res.statusCode=500;res.end(JSON.stringify({error:'Deterministic fixture failed'}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await fs.writeFile(path.join(source,'config.yaml'),`model:\n  provider: llamacpp\n  default: ${model}\n`);
  await fs.writeFile(path.join(source,'runtimes/llamacpp/server.json'),JSON.stringify({pid:process.pid,base_url:`http://127.0.0.1:${server.address().port}/v1`,api_key:'synthetic-fixture-only'}));
  const env={...process.env,LOCALAPPDATA:local,HARBOR_DATA_DIR:profile,HARBOR_PORT:'0'};
  delete env.ELECTRON_RUN_AS_NODE;delete env.HARBOR_PORTABLE_ROOT;delete env.HERMES_HOME;
  const launch=()=>electron.launch({...(process.env.HARBOR_EXECUTABLE?{executablePath:process.env.HARBOR_EXECUTABLE,args:[]}:{args:['.']}),env});
  let app,finished;
  const quit=async()=>{
    if(!app)return;const child=app.process();
    if(child.exitCode!==null){app=undefined;return;}
    const exited=new Promise(resolve=>child.once('exit',resolve));
    await app.evaluate(({app})=>app.quit()).catch(()=>{});
    let timer;try{await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Diagnostics desktop failed to exit')),20000);})]);}finally{clearTimeout(timer);}
    app=undefined;
  };
  try{
    app=await launch();let page=await app.firstWindow();
    const rendererErrors=[];page.on('pageerror',error=>rendererErrors.push(error.message));
    await expect(page.locator('#gateway-status')).toContainText('Gateway online');
    await page.getByRole('button',{name:'Diagnostics',exact:true}).click();
    await expect(page.getByRole('button',{name:'Check Hermes',exact:true})).toBeVisible();
    await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    await page.getByRole('button',{name:'Check Hermes',exact:true}).click();
    await expect(page.locator('.diag-status')).toContainText('ready to run',{timeout:30000});
    await expect(page.locator('.diagnostics')).toContainText(model);
    await page.getByRole('button',{name:'Continue to tasks',exact:true}).click();await page.getByRole('button',{name:'Continue to delivery',exact:true}).click();
    for(const label of ['BM25 search','Regex search','Code Mode','Local semantic search','Hybrid search'])await page.getByLabel('Test '+label,{exact:true}).uncheck();
    await expect(page.getByLabel('Test All tools',{exact:true})).toBeChecked();
    await page.getByRole('button',{name:'Continue to limits',exact:true}).click();await page.getByText('Advanced limits and repeatability',{exact:true}).click();
    await page.getByLabel('Repetitions per task and configuration',{exact:true}).fill('1');
    await page.getByLabel('Seconds per trial (including harness startup)',{exact:true}).fill('45');
    await page.getByLabel('Campaign time limit in seconds',{exact:true}).fill('180');
    await page.getByLabel('Maximum model turns',{exact:true}).fill('6');
    await page.getByRole('button',{name:'Review campaign',exact:true}).click();await expect(page.getByLabel('Campaign review')).toContainText('Planned trials: 6');
    await page.getByRole('button',{name:'Start campaign',exact:true}).click();
    await expect.poll(async()=>{
      const snapshot=await page.evaluate(()=>window.harbor.diagnosticsSnapshot());
      return snapshot.campaign&&!snapshot.running?snapshot.campaign.status:'pending';
    },{timeout:190000,message:'All six GUI campaign trials must finish'}).toBe('finished');
    finished=await page.evaluate(()=>window.harbor.diagnosticsSnapshot());
    assert.equal(finished.campaign.plannedTrials,6);assert.equal(finished.campaign.trials.length,6);
    assert.deepEqual(finished.campaign.trials.map(t=>t.task).sort(),['boundary','chain','lookup','no-tool','recovery','unavailable']);
    for(const trial of finished.campaign.trials){
      assert.equal(trial.configId,'all');assert.equal(trial.status,'finished',JSON.stringify(trial));
      assert.equal(trial.eligible,true,JSON.stringify(trial));assert.equal(trial.grade.completed,true,JSON.stringify(trial));assert.equal(trial.grade.adherent,true,JSON.stringify(trial));
      assert.equal(trial.usage,null);assert.equal(trial.cost,null);
      assert.equal(trial.controls.memory,'off');assert.equal(trial.controls.contextFiles,'off');
      if(['no-tool','unavailable'].includes(trial.task))assert.equal(trial.toolAttempts,0);
      else assert.equal(trial.argumentCorrectness,1);
      const saved=JSON.parse(await fs.readFile(path.join(profile,'diagnostics',finished.campaign.id,trial.id,'result.json'),'utf8'));
      const {trace,deliveryEvidence,...savedSummary}=saved,{deliveryObservation,...summaryFields}=trial;
      assert.deepEqual(savedSummary,summaryFields);assert(trace.events.length>0);
      assert.equal(deliveryEvidence.perModelRequestPresentation.length,requests.filter(request=>request.task===trial.task).length);
      assert(deliveryEvidence.perModelRequestPresentation.every(request=>request.exactDefinitions));
      assert.equal(deliveryObservation.modelRequestCount,deliveryEvidence.perModelRequestPresentation.length);
    }
    const summary=finished.results.configurations[0];
    assert.equal(summary.eligible,6);assert.equal(summary.verifiedCompletion,1);assert.equal(summary.adherence,1);assert.equal(summary.falseCompletionClaims,0);
    assert.equal(finished.results.recommendation.winner,null);
    assert.deepEqual(serverErrors,[]);assert.deepEqual(rendererErrors,[]);
    await expect(page.locator('.diagnostics')).toContainText('finished: 6 / 6 trials');
    await expect(page.locator('.diag-table')).toContainText('6 / 6');
    await page.getByRole('button',{name:'Inspect all / chain / repetition 1',exact:true}).click();
    await expect(page.getByLabel('Trial evidence')).toContainText('trial evidence');
    await expect(page.getByLabel('Trial evidence')).toContainText('catalogFingerprint');
    const latest=JSON.parse(await fs.readFile(path.join(profile,'diagnostics/latest.json'),'utf8'));assert.deepEqual(latest,finished.campaign);
    await quit();app=await launch();page=await app.firstWindow();
    await page.getByRole('button',{name:'Diagnostics',exact:true}).click();
    await expect(page.locator('.diagnostics')).toContainText('finished: 6 / 6 trials');
    const reloaded=await page.evaluate(()=>window.harbor.diagnosticsSnapshot());
    assert.deepEqual(reloaded.campaign,finished.campaign);assert.deepEqual(reloaded.results,finished.results);
    if(process.env.HARBOR_DIAGNOSTICS_CAMPAIGN_EVIDENCE){
      const evidence=path.resolve(process.env.HARBOR_DIAGNOSTICS_CAMPAIGN_EVIDENCE);await fs.mkdir(evidence,{recursive:true});
      await page.getByRole('heading',{name:'Trials',exact:true}).scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(evidence,'diagnostics-campaign-desktop.png'),fullPage:true});
      await fs.writeFile(path.join(evidence,'diagnostics-campaign-desktop.json'),JSON.stringify({kind:'Installed Hermes with deterministic local protocol fixture; not model quality',packaged:!!process.env.HARBOR_EXECUTABLE,campaign:finished.campaign,results:finished.results,fixtureRequests:requests,reloaded:true},null,2));
    }
    console.log(JSON.stringify({kind:'Deterministic protocol fixture',trials:6,eligible:summary.eligible,verifiedCompletion:summary.verifiedCompletion,modelQualityClaim:false,reloaded:true,toolDispatches:requests.filter(r=>r.tool).length}));
  }catch(error){
    // Preserve the synthetic campaign before its isolated profile is removed.
    // No request bodies, authorization headers or real model traffic are saved.
    const evidence=process.env.HARBOR_DIAGNOSTICS_CAMPAIGN_EVIDENCE??process.env.HARBOR_PHASE2_EVIDENCE;
    if(evidence)try{
      await fs.mkdir(evidence,{recursive:true});
      const trials=[];
      for(const trial of finished?.campaign?.trials??[]){
        const saved=JSON.parse(await fs.readFile(path.join(profile,'diagnostics',finished.campaign.id,trial.id,'result.json'),'utf8'));
        trials.push({id:trial.id,status:saved.status,elapsedMs:saved.elapsedMs,startupMs:saved.startupMs,grade:saved.grade,setupIdentity:saved.setupIdentity,deliveryObservation:trial.deliveryObservation});
      }
      await fs.writeFile(path.join(evidence,'diagnostics-campaign-failure.json'),JSON.stringify({kind:'Deterministic protocol fixture failure; not model quality',error:error.message,campaign:finished?.campaign??null,fixtureRequests:requests,serverErrors,trials},null,2),{flag:'wx'});
    }catch(evidenceError){console.error('Could not preserve Diagnostics fixture failure evidence:',evidenceError.message);}
    throw error;
  }finally{
    await quit();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    await fs.unlink(path.join(source,'hermes-agent'));
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
