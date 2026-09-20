import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';

test('measured advice requires review and explicit apply, shows uncertainty and preserves committed success on history refresh failure',{timeout:45000},async t=>{
  const server=createServer(async(req,res)=>{
    if(req.url==='/'){res.end('<html><head><link rel="stylesheet" href="/styles.css"></head><body style="padding:24px"><main></main><script type="module">import {createMeasuredAdvice} from "/measured-advice.js";document.querySelector("main").append(createMeasuredAdvice({api:window.harbor}).root)</script></body></html>');return;}
    const name=req.url.slice(1);if(!['styles.css','measured-advice.js'].includes(name)){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'text/css');res.end(await readFile(new URL('../src/ui/'+name,import.meta.url)));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1200,height:980}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.addInitScript(()=>{
    window.calls=[];window.ready=false;window.historyFails=false;
    const report=()=>({status:window.ready?'ready':'insufficient',reasons:[window.ready?'Paired fixture evidence supports a candidate.':'Identity is incomplete; no recommendation.'],setup:{harness:'Explicit UI fixture',model:'Fixture, not model-quality evidence',provider:'fixture',reasoning:'medium'},observations:80,taskIds:['document','database'],scope:'Synthetic tasks on a fixed setup; transfer requires validation.',comparison:{configurations:[{id:'all',eligible:40,trials:40,verifiedCompletion:.2,completion95:[.1,.35],adherence:.2,successMedianMs:100,successP95Ms:200},{id:'bm25',eligible:40,trials:40,verifiedCompletion:1,completion95:[.91,1],adherence:1,successMedianMs:200,successP95Ms:300}]}});
    window.harbor={
      diagnosticsListCampaigns:async()=>({page:0,pages:1,total:1,items:[{id:'fixture',status:'finished',trials:80,model:'Explicit UI fixture'}]}),
      getProfiles:async()=>({profiles:[{id:'coding',name:'Coding',revision:1}]}),
      adviceInspect:async id=>{window.calls.push(['inspect',id]);return report();},
      advicePreview:async input=>{window.calls.push(['preview',input]);return {token:'opaque-review',profileId:'coding',profileRevision:1,retainHistory:input.retainHistory,expiresAt:Date.now()+300000,changes:[{field:'toolMode',before:'all',after:'bm25'}]};},
      adviceApply:async token=>{window.calls.push(['apply',token]);return {profileId:'coding',revision:2,applied:true,retainedHistory:true,sessionPolicy:'Reconnect to use revision 2.'};},
      adviceHistory:async()=>{if(window.historyFails)throw Error('fixture refresh failure');return {receipts:[],limit:50};},
      adviceClearHistory:async()=>({receipts:[],limit:50})
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);assert.deepEqual(await page.evaluate(()=>window.calls),[]);
  await page.getByText('Measured configuration advice',{exact:true}).click();await page.getByRole('button',{name:'Load saved evidence',exact:true}).click();
  await page.getByRole('button',{name:'Check this campaign',exact:true}).click();await expect(page.getByRole('heading',{name:'Not enough evidence'})).toBeVisible();await expect(page.getByRole('button',{name:'Review profile change'})).toBeDisabled();
  await page.evaluate(()=>window.ready=true);await page.getByRole('button',{name:'Check this campaign',exact:true}).click();await expect(page.getByRole('heading',{name:'Measured improvement found'})).toBeVisible();await expect(page.getByText('95% completion interval',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Apply reviewed change'})).toBeDisabled();await expect(page.getByLabel('Retain previous delivery values')).not.toBeChecked();
  await page.getByRole('button',{name:'Review profile change'}).click();await expect(page.getByLabel('Reviewed profile change')).toContainText('toolMode: all → bm25');assert(!await page.evaluate(()=>window.calls.some(call=>call[0]==='apply')));
  await page.getByLabel('Retain previous delivery values').check();await expect(page.getByRole('button',{name:'Apply reviewed change'})).toBeDisabled();await page.getByRole('button',{name:'Review profile change'}).click();
  if(process.env.HARBOR_PHASE2_EVIDENCE){await mkdir(process.env.HARBOR_PHASE2_EVIDENCE,{recursive:true});await page.screenshot({path:path.join(process.env.HARBOR_PHASE2_EVIDENCE,'measured-advice-review-fixture.png'),fullPage:true});}
  await page.evaluate(()=>window.historyFails=true);await page.getByRole('button',{name:'Apply reviewed change'}).click();await expect(page.getByLabel('Measured advice status')).toContainText('Saved coding, revision 2');await expect(page.getByLabel('Measured advice status')).toContainText('could not be refreshed');
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(call=>call[0]==='apply')),[['apply','opaque-review']]);await expect(page.getByRole('button',{name:'Apply reviewed change'})).toBeDisabled();assert.deepEqual(errors,[]);
});
