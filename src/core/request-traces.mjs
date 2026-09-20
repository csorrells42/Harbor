import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile, mkdir, rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {performance} from 'node:perf_hooks';

export const TRACE_DEFAULTS = Object.freeze({mode:'metadata', maxEvents:1000, maxBytes:4*1024*1024, retentionMinutes:60, payloadBytes:8192});
const secretKey = /authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|private[-_]?key/i;
const outcomes = new Set(['success','invalid-arguments','search-failure','upstream-failure','timeout','cancelled','unavailable','error']);
const metadataFields = new Set(['kind','sessionId','clientName','clientVersion','profileId','profileRevision','deliveryMode','tool','serverId','internal','association']);

export function validateTraceSettings(input) {
  if(!input || typeof input !== 'object' || Array.isArray(input))throw new Error('Trace settings are required');
  const result = {...TRACE_DEFAULTS,...Object.fromEntries(Object.entries(input).filter(([key])=>Object.hasOwn(TRACE_DEFAULTS,key)))};
  if(!['off','metadata','payload'].includes(result.mode))throw new Error('Choose off, metadata or payload capture');
  for(const [key,min,max] of [['maxEvents',100,10000],['maxBytes',65536,32*1024*1024],['retentionMinutes',1,1440],['payloadBytes',256,65536]]) {
    if(!Number.isInteger(result[key]) || result[key]<min || result[key]>max)throw new Error(`Invalid trace setting: ${key} (${min}–${max})`);
  }
  return result;
}

export function traceOutcome(error, signal, kind='') {
  if(signal?.aborted || error?.name==='AbortError')return 'cancelled';
  if(outcomes.has(error?.harborOutcome))return error.harborOutcome;
  if(error?.code===-32001 || /timed?\s*out|timeout/i.test(error?.message??''))return 'timeout';
  if(error?.code===-32602)return 'invalid-arguments';
  return kind==='discovery'?'search-failure':kind==='upstream'?'upstream-failure':'error';
}

export async function createRequestTraces({settingsPath, secrets=()=>[], now=Date.now}={}) {
  let settings={...TRACE_DEFAULTS}, records=[], bytes=0, evicted=0, generation=0, sequence=0, writes=Promise.resolve(), preview;
  const context = new AsyncLocalStorage();
  const protectedValues=new Set();
  if(settingsPath)try {
    settings=validateTraceSettings(JSON.parse(await readFile(settingsPath,'utf8')));
    // Payload collection requires an explicit choice each application launch.
    if(settings.mode==='payload')settings.mode='metadata';
  }catch(error){if(error.code!=='ENOENT')throw error;}

  function redactText(input, limit=4096) {
    let value=String(input);
    for(const secret of [...secrets(),...protectedValues].filter(s=>typeof s==='string'&&s.length).sort((a,b)=>b.length-a.length))value=value.replaceAll(secret,'[redacted]');
    value=value.replace(/\bBearer\s+[^\s"'<>]+/gi,'Bearer [redacted]')
      .replace(/((?:password|passwd|secret|token|api[-_]?key|authorization|cookie)["']?\s*[=:]\s*["']?)[^\s,;"'<>]+/gi,'$1[redacted]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[redacted]@');
    return value.length>limit?value.slice(0,limit)+'…[truncated]':value;
  }
  function sanitize(value, budget=settings.payloadBytes) {
    let remaining=budget, visited=0;
    const seen=new WeakSet();
    function walk(item,depth=0) {
      if(remaining<=0 || ++visited>1024)return '[truncated]';
      if(item===null || typeof item==='boolean' || typeof item==='number'){remaining-=8;return item;}
      if(typeof item==='string') {const clean=redactText(item,Math.min(remaining,8192));remaining-=Buffer.byteLength(clean);return clean;}
      if(typeof item!=='object')return undefined;
      if(depth>=8 || seen.has(item))return '[truncated]';
      seen.add(item);
      if(Array.isArray(item))return item.slice(0,100).map(child=>walk(child,depth+1));
      const output={};
      for(const [key,child] of Object.entries(item).slice(0,100)) {
        if(remaining<=0){output.truncated=true;break;}
        const safeKey=redactText(key,128);remaining-=Buffer.byteLength(safeKey);
        // Binary blobs add size without explaining a call; do not export them.
        Object.defineProperty(output,safeKey,{enumerable:true,configurable:true,writable:true,value:secretKey.test(key)?'[redacted]':key==='data'&&typeof child==='string'?'[binary omitted]':walk(child,depth+1)});
      }
      return output;
    }
    const clean=walk(value);
    if(Buffer.byteLength(JSON.stringify(clean)??'')>budget)return {truncated:true,reason:'Payload exceeds capture budget after redaction'};
    return clean;
  }
  function prune() {
    const cutoff=now()-settings.retentionMinutes*60000;
    while(records.length&&(records.length>settings.maxEvents || bytes>settings.maxBytes || records[0].created<cutoff)) {
      bytes-=records.shift().bytes;evicted++;
    }
  }
  function append(record) {
    const serialized=JSON.stringify(record), size=Buffer.byteLength(serialized);
    if(size>settings.maxBytes){evicted++;return;}
    records.push({value:JSON.parse(serialized),bytes:size,created:now()});bytes+=size;prune();
  }
  function publicMetadata(input) {
    return Object.fromEntries(Object.entries(input).filter(([key])=>metadataFields.has(key)).map(([key,value])=>[key,typeof value==='string'?redactText(value,256):typeof value==='number'||typeof value==='boolean'?value:null]));
  }
  function snapshot({limit=200,sessionId,requestId}={}) {
    prune();
    limit=Math.max(1,Math.min(200,Number(limit)||200));
    let selected=records.map(record=>record.value);
    if(sessionId)selected=selected.filter(record=>record.sessionId===sessionId);
    if(requestId)selected=selected.filter(record=>record.requestId===requestId);
    return {settings:{...settings},events:structuredClone(selected.slice(-limit)),total:records.length,matching:selected.length,bytes,evicted,generation};
  }
  return {
    protect(value){protectedValues.add(value);return ()=>protectedValues.delete(value);},
    redactText,
    snapshot,
    current:()=>context.getStore()?.record,
    annotate(fields) {
      const record=context.getStore()?.record;
      if(!record)return;
      if(outcomes.has(fields.outcome))record.outcome=fields.outcome;
      if(fields.discovery)record.discovery=sanitize(fields.discovery,16384);
    },
    async run(input, operation, {payload,signal}={}) {
      if(settings.mode==='off')return operation();
      const parent=context.getStore()?.record, id=randomUUID(), epoch=generation;
      const record={id,requestId:parent?.requestId??id,parentId:parent?.id??null,sequence:++sequence,time:new Date(now()).toISOString(),
        ...publicMetadata({...parent,...input}),association:parent?'observed-nesting':input.association??'unknown',
        status:'running',outcome:null,payloadCaptured:false};
      if(input.delivery)record.delivery=sanitize(input.delivery,4096);
      const payloadEnabled=settings.mode==='payload';
      if(payloadEnabled&&payload!==undefined){record.input=sanitize(payload);record.payloadCaptured=true;}
      const start=performance.now();
      // Store a separate start event; the completion event never grows the start
      // record in place, so retention and memory accounting stay exact.
      append({...record});
      return context.run({record},async()=>{
        try {
          const result=await operation();
          record.outcome??=result?.isError?(input.kind==='discovery'?'search-failure':'upstream-failure'):'success';
          if(payloadEnabled&&settings.mode==='payload'){record.output=sanitize(result);record.payloadCaptured=true;}
          return result;
        }catch(error){record.outcome=traceOutcome(error,signal,input.kind);throw error;}
        finally {
          record.status='completed';record.completedAt=new Date(now()).toISOString();record.durationMs=Math.round((performance.now()-start)*1000)/1000;
          if(record.outcome==='timeout'||record.outcome==='cancelled')record.mutationOutcome='unknown; not automatically retried';
          if(epoch===generation&&settings.mode!=='off')append(record);
        }
      });
    },
    update(input) {
      const next=validateTraceSettings(input);
      const job=writes.then(async()=>{
        if(settingsPath){await mkdir(dirname(settingsPath),{recursive:true});const temp=settingsPath+'.tmp';await writeFile(temp,JSON.stringify(next)+'\n',{mode:0o600});await rename(temp,settingsPath);}
        settings=next;preview=undefined;prune();return {...settings};
      });writes=job.catch(()=>{});return job;
    },
    clear() {records=[];bytes=0;evicted=0;generation++;preview=undefined;return snapshot();},
    previewExport() {
      prune();
      const bundle={schemaVersion:1,exportedAt:new Date(now()).toISOString(),settings:{...settings},coverage:'Observed Harbor requests; discovery-to-invocation association is unknown unless explicitly linked.',
        redaction:'Known credentials and conventional secret fields are redacted. Arbitrary tool content may contain other sensitive data. Inspect before sharing.',
        total:records.length,evicted,events:records.map(record=>record.value)};
      const text=JSON.stringify(bundle,null,2), token=randomUUID();
      preview={token,text,expires:now()+300000};
      return {token,bytes:Buffer.byteLength(text),events:records.length,payloadEvents:records.filter(r=>r.value.payloadCaptured).length,text};
    },
    exportPreview(token) {
      if(!preview || preview.token!==token || preview.expires<now())throw new Error('Preview expired; preview the trace export again');
      return preview.text;
    },
    async close(){await writes;records=[];bytes=0;preview=undefined;generation++;settings={...settings,mode:'off'};}
  };
}
