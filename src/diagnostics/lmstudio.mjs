import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {inspectLoadedModel,hardware,localEndpoint} from './openclaw.mjs';
import {registerDiagnosticPlugin} from './lmstudio-registration.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_BYTES=8*1024*1024;

// Bound the entire stream, including discarded reasoning. SSE frames can span
// arbitrary UTF-8 chunks; never save the raw stream or hidden reasoning.
export async function consumeNativeStream(body,onEvent,{maxBytes=MAX_BYTES}={}){
  const decoder=new TextDecoder();let buffer='',bytes=0;
  const frames=()=>{let match;while((match=/\r?\n\r?\n/.exec(buffer))){
    const frame=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);
    const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(data){const event=JSON.parse(data);if(!event||typeof event.type!=='string')throw new Error('Invalid LM Studio stream event');onEvent(event);}
  }};
  for await(const chunk of body){bytes+=chunk.byteLength;if(bytes>maxBytes)throw new Error('LM Studio observation limit exceeded');buffer+=decoder.decode(chunk,{stream:true});frames();}
  buffer+=decoder.decode();frames();if(buffer.trim())throw new Error('Incomplete LM Studio stream frame');return bytes;
}
async function installedVersion(){
  try{const file=path.join(process.env.LOCALAPPDATA??'', 'Programs','LM Studio','resources','app','package.json');const p=JSON.parse(await readFile(file,'utf8'));return typeof p.version==='string'?p.version:null;}catch{return null;}
}
export function createLmStudioAdapter({endpoint='http://127.0.0.1:1234/v1',apiToken=process.env.LM_STUDIO_API_TOKEN,modelProbe=inspectLoadedModel,hardwareReader=hardware,versionReader=installedVersion,registerPlugin=registerDiagnosticPlugin,configFile=path.join(os.homedir(),'.lmstudio','mcp.json')}={}){
  const origin=localEndpoint(endpoint).origin,headers=apiToken?{Authorization:`Bearer ${apiToken}`}:{},operations=new Set(),controllers=new Set();let closed=false,running=false;
  async function probe({signal}={}){
    if(closed)throw new Error('LM Studio adapter is closed');
    const model=await modelProbe({endpoint,signal,headers,harness:'LM Studio'}),version=await versionReader(),hw=await hardwareReader();
    return {harness:'LM Studio',revision:version??'unverified',fingerprint:digest({adapter:'lmstudio-native-mcp-v1',version}),runtimeVersions:{node:process.version,lmstudio:version},model:model.model,provider:'LM Studio native MCP',reasoning:'server default (not attested)',configuredContextLength:model.context,endpoint,
      modelServerIdentity:{runtimeKind:'LM Studio',endpointOwned:null},modelEvidence:{verification:'loaded-instance-settings-v1',contextLength:model.context,loadConfig:model.loadConfig,weightsFingerprint:null,serverSettingsFingerprint:null,gaps:['Model bytes, complete defaults and internal per-turn requests are not attested']},hardware:hw,
      isolation:'Fresh native API chat; store=false; one temporary configured Harbor MCP; no inherited conversation or configured plugins',ready:true,
      limitations:['Enable Require Authentication and Allow calling servers from mcp.json in LM Studio Server Settings; supply LM_STUDIO_API_TOKEN with configured-server permission. Native API requires 0.4.0 or newer; permissions verified on 0.4.21+2.','Native API does not attest internal per-turn tool definitions or inference settings.','After an interrupted native request, generation cancellation is unconfirmed; the campaign stops before another trial.']};
  }
  async function run(request,{signal,onEvent=()=>{}}={}){
    if(closed||running)throw new Error(closed?'LM Studio adapter is closed':'LM Studio diagnostic request already running');
    if(!Number.isInteger(request.maxTurns)||request.maxTurns<1||!Number.isFinite(request.maxTrialSeconds)||request.maxTrialSeconds<=0)throw new Error('Invalid LM Studio trial limits');
    const gateway=new URL(request.gateway);if(gateway.protocol!=='http:'||gateway.hostname!=='127.0.0.1'||gateway.username||gateway.password||gateway.search||gateway.hash)throw new Error('LM Studio trials require a private loopback MCP gateway');
    if(request.responseFormat&&request.responseFormat!=='json-object')throw new Error('Unsupported final response format');
    running=true;const controller=new AbortController();controllers.add(controller);
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal,events=[],schemas=new Map(),ajv=new Ajv({strict:false});
    let capturedBytes=0,eventsTruncated=false,status='finished',error=null,result=null,submitted=false,ended=false,calls=0,ready=false,monitor,sampling=false,registration,streamError=null,cleanupFailed=false;
    const pending=[];
    const started=Date.now(),emit=event=>{const bytes=Buffer.byteLength(JSON.stringify(event));if(events.length>=2000||capturedBytes+bytes>MAX_BYTES){eventsTruncated=true;stop('observation-limit');return;}events.push(event);capturedBytes+=bytes;onEvent(event);};
    const stop=reason=>{if(status==='finished')status=reason;controller.abort();};
    const abort=()=>{if(status==='finished')status='cancelled';};combined.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>stop('timeout'),request.maxTrialSeconds*1000);
    const owned=provider=>provider?.type==='plugin'&&provider.plugin_id===registration?.id;
    try{
      combined.throwIfAborted();const inventory=await probe({signal:combined});
      const client=new Client({name:'Harbor native LM Studio diagnostic preflight',version:'1'});let definitions=[];
      try{
        await client.connect(new StreamableHTTPClientTransport(gateway),{signal:combined,timeout:15000});let cursor;const seen=new Set();
        do{const page=await client.listTools(cursor?{cursor}:{},{signal:combined,timeout:15000});definitions.push(...page.tools);cursor=page.nextCursor;if(definitions.length>10000||cursor&&seen.has(cursor)||Buffer.byteLength(JSON.stringify(definitions))>MAX_BYTES)throw new Error('Diagnostic MCP catalog exceeds observation limit');seen.add(cursor);}while(cursor);
      }finally{await client.close();}
      if(request.emptyCatalog===true&&definitions.length||request.emptyCatalog!==true&&!definitions.length)throw new Error('Diagnostic MCP catalog does not match the selected task');
      for(const tool of definitions)schemas.set(tool.name,ajv.compile(tool.inputSchema));
      const before=await modelProbe({endpoint,signal:combined,headers,harness:'LM Studio'});
      if(before.model!==inventory.model||digest(before.loadConfig)!==digest(inventory.modelEvidence.loadConfig))throw new Error('Loaded model changed before the native request');
      const input=request.prompt+(request.responseFormat?'\n\nFinal response contract (harbor-final-json-1): Your final answer must be exactly one valid JSON object with the fields requested above. Return raw JSON only: no Markdown code fences, headings, commentary, or text before or after the object. Continue using the supplied tools normally while doing the work. This format requirement does not replace completing or verifying the requested work.':'');
      const home=path.resolve(request.home);await mkdir(home,{recursive:true});const bridgeFile=path.join(home,'native-mcp-bridge.mjs');await writeFile(bridgeFile,await readFile(new URL('../bridge.mjs',import.meta.url)));
      registration=await registerPlugin({configFile,bridgeFile,gateway:gateway.href});
      await registration.waitReady?.({signal:combined});
      const body={model:inventory.model,input,integrations:[{type:'plugin',id:registration.id}],stream:true,store:false,temperature:0.2,max_output_tokens:1024};
      combined.throwIfAborted();submitted=true;
      const response=await fetch(`${origin}/api/v1/chat`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body),signal:combined,redirect:'error'});
      if(!response.ok){await response.body?.cancel();ended=true;throw new Error(`LM Studio native MCP request rejected (HTTP ${response.status}). Check server authentication and Allow calling servers from mcp.json; LM Studio 0.4.0 or newer is required.`);}
      if(!response.headers.get('content-type')?.includes('text/event-stream')){await response.body?.cancel();throw new Error('LM Studio did not return a native event stream');}
      monitor=setInterval(async()=>{if(sampling||combined.aborted)return;sampling=true;try{const hw=await hardwareReader();if(!combined.aborted&&!ended)emit({type:'resources',ms:Date.now()-started,hostUsedGiB:(os.totalmem()-os.freemem())/2**30,workerRssBytes:null,hostCpuPercent:null,gpus:hw.gpus});}catch{}finally{sampling=false;}},2000);
      await consumeNativeStream(response.body,event=>{
        if(ended)throw new Error('Native stream continued after chat.end');
        if(event.type==='model_load.start'){stop('model-drift');throw new Error('LM Studio attempted model loading during a trial');}
        if(event.type==='chat.start'){
          if(ready||event.model_instance_id!==inventory.model)throw new Error('LM Studio native model identity mismatch');ready=true;
          emit({type:'ready',inventory,startupMs:Date.now()-started,controls:{memory:'fresh chat; store=false',toolsets:['temporary configured Harbor MCP'],maxTurns:request.maxTurns,turnLimitPolicy:'Abort on observed prompt-processing start above limit',maxOutputTokens:1024,finalResponsePolicy:request.responseFormat?'harbor-final-json-1':null,exactInternalRequests:false,emptyCatalogVerified:request.emptyCatalog===true}});
          emit({type:'native-request',parameters:{model:body.model,temperature:body.temperature,max_output_tokens:body.max_output_tokens,store:false},source:'LM Studio native API request; internal model requests unknown'});
        }else if(event.type==='prompt_processing.start'){calls++;if(calls>request.maxTurns){stop('iteration-limit');throw new Error('Native model turn limit reached');}}
        else if(event.type==='tool_call.start'){
          // 0.4.21 emits anonymous boundaries and can interleave tool calls.
          // Attribute attempts from complete arguments/failure events instead.
          if(event.provider_info!==undefined&&!owned(event.provider_info))throw new Error('LM Studio exposed a tool outside this Harbor trial');
        }else if(event.type==='tool_call.arguments'||event.type==='tool_call.success'){
          if(!owned(event.provider_info))throw new Error('LM Studio exposed a tool outside this Harbor trial');
          const validate=schemas.get(event.tool),schemaValid=validate?!!validate(event.arguments):false;
          if(event.type==='tool_call.arguments'){
            if(pending.length>=2000)throw new Error('LM Studio observation limit exceeded');
            pending.push({name:event.tool});emit({type:'tool-start',name:event.tool,ms:Date.now()-started,schemaValid});
          }else{
            const index=pending.findIndex(p=>p.name===event.tool);if(index<0)throw new Error('LM Studio tool success has no attributable arguments');
            pending.splice(index,1);emit({type:'tool-end',name:event.tool,ms:Date.now()-started});
          }
        }else if(event.type==='tool_call.failure'){
          const meta=event.metadata??{};if(meta.provider_info&&!owned(meta.provider_info))throw new Error('Foreign tool failure in native trial');
          const index=pending.findIndex(p=>p.name===meta.tool_name);
          if(index>=0)pending.splice(index,1);else emit({type:'tool-start',name:meta.tool_name??'unknown',schemaValid:false,ms:Date.now()-started});
          emit({type:'tool-error',name:meta.tool_name??'unknown',category:meta.type??'unknown',ms:Date.now()-started});
        }else if(event.type==='error'){streamError=String(event.error?.type??'unknown').slice(0,80);error=`LM Studio native stream error (${streamError}). Check Allow calling servers from mcp.json and retry once the temporary MCP is available.`;status='infrastructure-error';}
        else if(event.type==='chat.end'){
          if(pending.length)throw new Error('LM Studio native result has unfinished tool calls');
          const value=event.result;if(!ready||value?.model_instance_id!==inventory.model||!Array.isArray(value.output))throw new Error('LM Studio native result identity or structure is invalid');
          for(const item of value.output)if(item.type==='tool_call'&&!owned(item.provider_info))throw new Error('Foreign tool in native result');
          const outputCalls=value.output.filter(item=>item.type==='tool_call'||item.type==='invalid_tool_call');
          if(outputCalls.length!==events.filter(e=>e.type==='tool-start').length)throw new Error('Native tool stream and final result disagree');
          ended=true;result={finalResponse:value.output.filter(item=>item.type==='message').map(item=>item.content??'').join('\n'),harnessCompleted:!streamError,failed:false,interrupted:false,apiCalls:calls||null,modelReported:value.model_instance_id,usage:Object.fromEntries(['input_tokens','total_output_tokens','reasoning_output_tokens'].filter(k=>Number.isFinite(value.stats?.[k])).map(k=>[k,value.stats[k]])),cost:null};
        }
      });
      if(!ended)throw new Error('LM Studio stream ended without a final result');
      emit({type:'identity-end',inventory:await probe({signal:combined})});
    }catch(e){if(status==='finished')status='infrastructure-error';error=combined.aborted?`LM Studio trial ${status}`:e.message;if(/observation limit/.test(e.message)){eventsTruncated=true;status='observation-limit';}}
    finally{clearTimeout(timer);clearInterval(monitor);combined.removeEventListener('abort',abort);controller.abort();controllers.delete(controller);running=false;try{await registration?.close();}catch{cleanupFailed=true;status='infrastructure-error';error='Temporary LM Studio MCP cleanup failed; inspect mcp.json before restarting';}}
    // Closing an HTTP stream is not proof that the separate LM Studio process
    // has stopped inference. Never automatically queue another trial after it.
    return {events,eventsTruncated,capturedBytes,status,error,result,cleanupFailed,cancellationUnconfirmed:submitted&&!ended};
  }
  return {probe,run:(...args)=>{const p=run(...args);operations.add(p);p.then(()=>operations.delete(p),()=>operations.delete(p));return p;},async close(){closed=true;for(const c of controllers)c.abort();await Promise.allSettled([...operations]);}};
}
