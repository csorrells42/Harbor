import {spawn,execFile} from 'node:child_process';
import {createServer,request as httpRequest} from 'node:http';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const OPENCLAW_VERSION='2026.7.1-2';
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const keys=['model','temperature','top_p','top_k','min_p','seed','max_tokens','max_completion_tokens','reasoning_effort','frequency_penalty','presence_penalty','repeat_penalty','parallel_tool_calls','tool_choice'];
const execute=(file,args)=>new Promise((resolve,reject)=>execFile(file,args,{windowsHide:true,timeout:5000,maxBuffer:1048576},(e,out)=>e?reject(e):resolve(out)));
export function localEndpoint(value){
  const u=new URL(value);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.search||u.hash||u.pathname!=='/v1')throw new Error('OpenClaw diagnostics requires an IPv4 loopback /v1 model endpoint');return u;
}
async function jsonGet(url,signal,headers){
  const response=await fetch(url,{headers,signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(5000)]),redirect:'error'});
  if(!response.ok)throw new Error(`Local model inspection failed (HTTP ${response.status})`);
  let text='';for await(const chunk of response.body){text+=Buffer.from(chunk).toString();if(text.length>2*1024*1024)throw new Error('Local model inventory is too large');}return JSON.parse(text);
}
export async function inspectLoadedModel({endpoint='http://127.0.0.1:1234/v1',signal,headers,harness='OpenClaw'}={}){
  const u=localEndpoint(endpoint),data=await jsonGet(`${u.origin}/api/v1/models`,signal,headers);
  const loaded=(data.models??[]).flatMap(m=>(m.loaded_instances??[]).map(i=>({model:m,instance:i})));
  if(loaded.length!==1||loaded[0].model.type!=='llm')throw new Error(`Load exactly one language model in LM Studio before checking ${harness}`);
  const {model,instance}=loaded[0],context=instance.config?.context_length;
  if(!Number.isInteger(context)||context<4000||instance.config?.parallel!==1)throw new Error(`${harness} needs a verified context of at least 4000 tokens and one concurrent prediction`);
  if(typeof instance.id!=='string'||!instance.id)throw new Error('Loaded model instance identity is unavailable');
  return {model:instance.id,modelKey:model.key,context,endpoint,loadConfig:instance.config};
}
export async function hardware(){
  let gpus=[];try{gpus=(await execute('nvidia-smi',['--query-gpu=index,name,memory.total,memory.used,driver_version','--format=csv,noheader,nounits'])).trim().split(/\r?\n/).map(line=>{const [index,name,total,used,driver]=line.split(',').map(s=>s.trim());return {index:Number(index),name,totalMiB:Number(total),usedMiB:Number(used),driver};});}catch{}
  return {cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,ramBytes:os.totalmem(),gpus};
}
export async function verifyEmptyCatalog(gateway,signal){
  const client=new Client({name:'Harbor empty-catalog verification',version:'1'});
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL(gateway)),{signal,timeout:15000});
    const result=await client.listTools({}, {signal,timeout:15000});
    if(result.tools.length||result.nextCursor)throw new Error('Expected empty diagnostic catalog changed');
  }finally{await client.close();}
}
export function isolatedOpenClawConfig({home,proxy,model,context,gateway,observer,startedAt,maxOutputTokens=1024,emptyCatalog=false}){
  return {update:{checkOnStart:false},logging:{level:'warn',consoleLevel:'warn'},skills:{allowBundled:[],load:{watch:false}},
    models:{mode:'replace',providers:{'harbor-local':{baseUrl:proxy,apiKey:'isolated-local-fixture',api:'openai-completions',models:[{id:model,name:model,reasoning:false,input:['text'],contextWindow:context,maxTokens:maxOutputTokens}]}}},
    agents:{defaults:{workspace:path.join(home,'workspace'),skipBootstrap:true,contextTokens:context,thinkingDefault:'off',compaction:{reserveTokens:maxOutputTokens,reserveTokensFloor:0,keepRecentTokens:Math.min(2048,Math.floor(context/4)),memoryFlush:{enabled:false}},model:{primary:`harbor-local/${model}`,fallbacks:[]},models:{[`harbor-local/${model}`]:{params:{temperature:0.2,maxTokens:maxOutputTokens}}}}},
    tools:emptyCatalog?{allow:[],deny:['*']}:{allow:['bundle-mcp'],deny:['group:runtime','group:fs','group:web','group:ui','group:sessions','group:automation','group:messaging','group:memory']},
    mcp:{servers:{diagnostic:{transport:'streamable-http',url:gateway,timeout:30,connectTimeout:15}}},
    plugins:{allow:['harbor-observer'],load:{paths:[observer]},slots:{memory:'none'},entries:{'harbor-observer':{enabled:true,config:{file:path.join(home,'observations.jsonl'),startedAt}}}},
  };
}
// The local relay sees the actual serialized request. It refuses all model
// lifecycle paths and never forwards a request to a different loaded instance.
export async function createModelRelay({inference,maxTurns,onRequest=()=>{},onFirstRequest=()=>{},signal,verifyModel=inspectLoadedModel}){
  localEndpoint(inference.endpoint);let calls=0,inflight=false,first=true,limitHit=false;const sockets=new Set(),requests=new Set();
  const server=createServer(async(req,res)=>{
    const reject=(status,message)=>{if(!res.headersSent)res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:{message,type:'harbor_diagnostics'}}));};
    try{
      if(req.method==='GET'&&req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:inference.model,object:'model'}]}));return;}
      if(req.method!=='POST'||req.url!=='/v1/chat/completions'){reject(403,'Only the selected model inference route is available');return;}
      if(inflight){reject(429,'One prediction at a time');return;}
      if(calls>=maxTurns){limitHit=true;reject(429,'Diagnostic model turn limit reached');return;}
      inflight=true;
      try{
        let raw='';for await(const chunk of req){raw+=chunk.toString();if(raw.length>4*1024*1024)throw new Error('Request exceeds observation limit');}
        const body=JSON.parse(raw);
        if(body.model!==inference.model)throw new Error('Model switch rejected');
        const current=await verifyModel({endpoint:inference.endpoint,signal});
        if(digest(current)!==digest(inference))throw new Error('Loaded model settings changed');
        if(signal?.aborted)throw new Error('Trial stopped');
        calls++;onRequest(body,calls);if(first){first=false;onFirstRequest(body);}
        await new Promise((resolve,rejectPromise)=>{
          const destination=new URL(inference.endpoint+'/chat/completions');
          const outbound=httpRequest(destination,{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(raw)},signal},incoming=>{
            res.writeHead(incoming.statusCode,{'content-type':incoming.headers['content-type']??'application/json'});
            incoming.pipe(res);incoming.once('end',resolve);incoming.once('error',rejectPromise);
          });requests.add(outbound);outbound.once('close',()=>requests.delete(outbound));outbound.once('error',rejectPromise);outbound.end(raw);
        });
      }finally{inflight=false;}
    }catch(error){reject(409,error.message);}
  });
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {endpoint:`http://127.0.0.1:${server.address().port}/v1`,get calls(){return calls;},get limitHit(){return limitHit;},close:()=>new Promise(resolve=>{for(const r of requests)r.destroy();for(const s of sockets)s.destroy();server.close(resolve);})};
}
export function createOpenClawAdapter({source=path.join(process.env.APPDATA??os.homedir(),'npm/node_modules/openclaw'),endpoint='http://127.0.0.1:1234/v1',nodeExecutable=process.execPath,modelProbe=inspectLoadedModel,hardwareReader=hardware,diagnosticLog=()=>{}}={}){
  let closed=false;const operations=new Set(),controllers=new Set();
  async function installation(signal){
    const pkg=JSON.parse(await readFile(path.join(source,'package.json'),'utf8'));
    if(pkg.version!==OPENCLAW_VERSION)throw new Error(`OpenClaw ${pkg.version} needs adapter verification; supported build is ${OPENCLAW_VERSION}`);
    const files=['package.json','npm-shrinkwrap.json','openclaw.mjs'];
    // Include the installed compiled implementation, not only its version label.
    for(const entry of await readdir(path.join(source,'dist'),{withFileTypes:true}))if(entry.isFile()&&/\.(?:js|mjs|cjs|json)$/.test(entry.name))files.push('dist/'+entry.name);
    files.sort();
    const h=createHash('sha256');for(const file of files){if(signal?.aborted)throw new Error('OpenClaw inspection stopped');h.update(file);h.update(await readFile(path.join(source,file)));}
    return {revision:pkg.version,fingerprint:h.digest('hex'),fingerprintScope:'Entry point, package/shrinkwrap and top-level compiled dist files; transitive dependency bytes not attested',fingerprintedFiles:files.length};
  }
  async function probe({signal}={}){
    if(closed)throw new Error('OpenClaw adapter is closed');
    const installed=await installation(signal),model=await modelProbe({endpoint,signal}),hw=await hardwareReader();
    return {harness:'OpenClaw',...installed,runtimeVersions:{node:process.versions.node,openclaw:installed.revision},model:model.model,provider:'lmstudio',reasoning:'off',configuredContextLength:model.context,endpoint,
      modelServerIdentity:{runtimeKind:'LM Studio',endpointOwned:null},modelEvidence:{verification:'loaded-instance-settings-v1',contextLength:model.context,loadConfig:model.loadConfig,weightsFingerprint:null,serverSettingsFingerprint:null,gaps:['Model bytes and complete server defaults not attested']},hardware:hw,
      isolation:'Fresh OpenClaw state and workspace; only diagnostic MCP tools; selected loaded model through lifecycle-blocking relay',ready:true};
  }
  async function run(request,{signal,onEvent=()=>{}}={}){
    if(closed)throw new Error('OpenClaw adapter is closed');
    const controller=new AbortController();controllers.add(controller);const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const events=[],schemas=new Map(),ajv=new Ajv({strict:false,allErrors:true});let capturedBytes=0,eventsTruncated=false,child,childExited=false,relay,timer,monitor,stopping=null,resultRecord,error=null;
    const started=Date.now();
    const emit=event=>{const bytes=Buffer.byteLength(JSON.stringify(event));if(events.length>=2000||capturedBytes+bytes>8*1024*1024){eventsTruncated=true;return;}events.push(event);capturedBytes+=bytes;onEvent(event);};
    const home=path.resolve(request.home),userHome=path.resolve(process.env.OPENCLAW_STATE_DIR??path.join(os.homedir(),'.openclaw'));
    let termination=Promise.resolve();
    const stop=reason=>{if(stopping)return;stopping=reason;controller.abort();if(child?.pid&&!childExited){termination=process.platform==='win32'?execute(path.join(process.env.SystemRoot,'System32/taskkill.exe'),['/pid',String(child.pid),'/T','/F']).catch(()=>child.kill()):Promise.resolve(child.kill('SIGTERM'));}};
    const abort=()=>stop('cancelled');combined.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>stop('timeout'),request.maxTrialSeconds*1000);
    try{
      if(home===userHome||home.startsWith(userHome+path.sep))throw new Error('Diagnostic home must be outside existing OpenClaw state');
      if(combined.aborted)throw new Error('Trial stopped');
      await mkdir(home,{recursive:false});await mkdir(path.join(home,'workspace'));
      const inventory=await probe({signal:combined}),inference=await modelProbe({endpoint,signal:combined});
      // OpenClaw treats a named allowlist with no matching tools as a setup
      // failure. Verify the actual empty gateway before explicitly disabling
      // all tools for a no-capability trial; never mask a nonempty catalog.
      if(request.emptyCatalog)await verifyEmptyCatalog(request.gateway,combined);
      relay=await createModelRelay({inference,maxTurns:request.maxTurns,signal:combined,verifyModel:modelProbe,
        onRequest:(body,sequence)=>{
          if((body.tools??[]).some(tool=>!tool.function?.name?.startsWith('diagnostic__')))throw new Error('OpenClaw exposed tools outside the diagnostic server');
          const definitions=body.tools??[];for(const tool of definitions){try{schemas.set(tool.function.name,ajv.compile(tool.function.parameters));}catch{}}
          const parameters=Object.fromEntries(keys.filter(k=>Object.hasOwn(body,k)).map(k=>[k,body[k]]));
          const excluded=new Set(['messages','tools','functions','input','prompt','user','metadata','stream','stream_options','api_key','authorization','password','secret']);
          const controls=Object.fromEntries(Object.entries(body).filter(([k])=>!excluded.has(k.toLowerCase())));
          emit({type:'model-request',sequence,definitions,exactDefinitions:true,parameters,parameterFingerprint:digest(controls),exactParameters:true,source:'OpenClaw serialized HTTP request at local observation relay',ms:Date.now()-started});
        },onFirstRequest:body=>{
          if(!body.tools?.length&&!request.emptyCatalog)throw new Error('OpenClaw did not expose the diagnostic MCP tools');
          if(body.tools?.length&&request.emptyCatalog)throw new Error('Expected empty catalog changed');
          emit({type:'ready',inventory,advertisedDefinitions:body.tools??[],presentationSource:'OpenClaw first serialized model request',startupMs:Date.now()-started,controls:{memory:'off',contextFiles:'off',toolsets:request.emptyCatalog?[]:['diagnostic MCP'],emptyCatalogVerified:request.emptyCatalog===true,maxTurns:request.maxTurns,maxOutputTokens:1024,finalResponsePolicy:request.responseFormat?'harbor-final-json-1':null}});
        }});
      const observer=path.join(home,'observer');await mkdir(observer);
      await writeFile(path.join(observer,'index.cjs'),await readFile(new URL('./openclaw-observer.cjs',import.meta.url)));
      await writeFile(path.join(observer,'package.json'),JSON.stringify({name:'harbor-observer',version:'1.0.0',main:'index.cjs',openclaw:{extensions:['./index.cjs']}}));
      await writeFile(path.join(observer,'openclaw.plugin.json'),JSON.stringify({id:'harbor-observer',configSchema:{type:'object',additionalProperties:false,required:['file','startedAt'],properties:{file:{type:'string'},startedAt:{type:'number'}}}}));
      const config=isolatedOpenClawConfig({home,proxy:relay.endpoint,model:inference.model,context:inference.context,gateway:request.gateway,observer,startedAt:started,emptyCatalog:request.emptyCatalog===true});
      await writeFile(path.join(home,'openclaw.json'),JSON.stringify(config));
      if(request.responseFormat&&request.responseFormat!=='json-object')throw new Error('Unsupported final response format');
      const prompt=request.prompt+(request.responseFormat?'\n\nFinal response contract (harbor-final-json-1): Your final answer must be exactly one valid JSON object with the fields requested above. Return raw JSON only: no Markdown code fences, headings, commentary, or text before or after the object. Continue using the supplied tools normally while doing the work. This format requirement does not replace completing or verifying the requested work.':'');
      await writeFile(path.join(home,'prompt.txt'),prompt);
      if(combined.aborted)throw new Error('Trial stopped');
      const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|PATHEXT|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)));
      Object.assign(env,{ELECTRON_RUN_AS_NODE:'1',OPENCLAW_HOME:home,OPENCLAW_STATE_DIR:home,OPENCLAW_CONFIG_PATH:path.join(home,'openclaw.json'),OPENCLAW_NIX_MODE:'1',HOME:home,USERPROFILE:home,APPDATA:path.join(home,'appdata'),LOCALAPPDATA:path.join(home,'localappdata'),NO_PROXY:'127.0.0.1,localhost'});
      let output='',stderr='';
      const exit=new Promise((resolve,reject)=>{
        child=spawn(nodeExecutable,[path.join(source,'openclaw.mjs'),'agent','--local','--agent','main','--session-id',randomUUID(),'--message-file',path.join(home,'prompt.txt'),'--thinking','off','--timeout',String(Math.max(1,Math.floor(request.maxTrialSeconds))),'--json'],{cwd:home,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
        child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>4*1024*1024){eventsTruncated=true;stop('observation-limit');}});
        child.stderr.on('data',chunk=>{if(stderr.length<32768){stderr+=chunk.toString();diagnosticLog(chunk.toString());}});child.once('error',e=>{childExited=true;reject(e);});child.once('close',code=>{childExited=true;resolve(code);});
      });
      let samplePending=false;
      monitor=setInterval(async()=>{if(samplePending)return;samplePending=true;try{const hw=await hardwareReader();emit({type:'resources',ms:Date.now()-started,hostUsedGiB:(os.totalmem()-os.freemem())/2**30,workerRssBytes:null,hostCpuPercent:null,gpus:hw.gpus});}finally{samplePending=false;}},2000);
      const code=await exit;await termination;
      let observed='';try{observed=await readFile(path.join(home,'observations.jsonl'),'utf8');}catch{}
      if(observed.length>4*1024*1024){eventsTruncated=true;observed='';}
      for(const line of observed.trim().split('\n').filter(Boolean)){const e=JSON.parse(line);if(e.type==='observation-limit')eventsTruncated=true;if(e.type==='tool-start'){const validate=schemas.get(e.name);e.schemaValid=validate?!!validate(e.args):null;delete e.args;}emit(e);}
      try{
        const parsed=JSON.parse(output),meta=parsed.meta??parsed.result?.meta??{},payloads=parsed.payloads??parsed.result?.payloads??[];
        resultRecord={type:'result',finalResponse:payloads.map(p=>p.text??'').join('\n'),harnessCompleted:code===0&&relay.calls>0&&!relay.limitHit&&!payloads.some(p=>p.isError),failed:code!==0||payloads.some(p=>p.isError),interrupted:!!stopping,apiCalls:relay.calls,modelReported:meta.agentMeta?.model??inference.model,usage:meta.agentMeta?.usage??null,cost:null};emit(resultRecord);
      }catch{error=`OpenClaw did not return a valid structured result (exit ${code}); ${stderr.includes('Invalid config')?'isolated configuration rejected':'inspect the installed CLI compatibility'}`;}
      try{emit({type:'identity-end',inventory:await probe({signal:combined})});}catch{emit({type:'identity-end',inventory:null});}
      return {events,eventsTruncated,capturedBytes,status:stopping??(code===0?'finished':'infrastructure-error'),error,result:resultRecord};
    }finally{clearTimeout(timer);clearInterval(monitor);combined.removeEventListener('abort',abort);await relay?.close();controllers.delete(controller);}
  }
  return {probe,run:(...args)=>{const p=run(...args);operations.add(p);p.then(()=>operations.delete(p),()=>operations.delete(p));return p;},async close(){closed=true;for(const controller of controllers)controller.abort();await Promise.allSettled([...operations]);}};
}
