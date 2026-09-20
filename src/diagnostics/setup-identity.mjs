import {createHash} from 'node:crypto';

function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value??null;}
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const parameterKeys=['model','temperature','top_p','top_k','min_p','seed','max_tokens','max_completion_tokens','reasoning_effort','frequency_penalty','presence_penalty','repeat_penalty','parallel_tool_calls','tool_choice'];
const runtimeKeys=['python','mcp','mcp-types','openai','httpx','httpx2','jsonschema','pydantic','PyYAML','psutil'];
function identity(inventory){
  if(!inventory)return null;
  return {harnessSource:inventory.fingerprint??null,runtimeVersions:inventory.runtimeVersions??null,model:inventory.model??null,provider:inventory.provider??null,reasoning:inventory.reasoning??null,configuredContextLength:inventory.configuredContextLength??null,endpoint:inventory.endpoint??null,modelServer:inventory.modelServerIdentity??null,modelEvidence:inventory.modelEvidence??null};
}
export function setupIdentity({baseline,ready,end,events=[],eventsTruncated=false}={}){
  const initial=identity(baseline),started=identity(ready),finished=identity(end),changedFields=[];
  for(const [phase,value] of [['start',started],['end',finished]])if(initial&&value)for(const key of Object.keys(initial))if(digest(initial[key])!==digest(value[key]))changedFields.push(`${phase}.${key}`);
  const requests=events.filter(event=>event.type==='model-request'),vectors=requests.map(event=>({parameters:Object.fromEntries(parameterKeys.map(key=>[key,event.parameters?.[key]??null])),parameterFingerprint:event.parameterFingerprint??null})),unique=[...new Map(vectors.map(value=>[digest(value),value])).values()];
  const exactRequests=requests.length>0&&requests.every((event,index)=>event.sequence===index+1&&event.exactParameters===true&&event.parameters&&typeof event.parameters==='object'&&/^[a-f0-9]{64}$/.test(event.parameterFingerprint??''))&&!eventsTruncated;
  if(exactRequests&&unique.length>1)changedFields.push('outbound.inferenceParameters');
  if(requests.some(event=>event.exactParameters&&event.parameters?.model!==initial?.model))changedFields.push('outbound.model');
  const gaps=[];
  if(!started)gaps.push('Start-of-trial setup observation missing');
  if(!finished)gaps.push('End-of-trial setup observation missing');
  if((baseline?.harness==='OpenClaw'?['node','openclaw']:baseline?.harness==='LM Studio'?['node','lmstudio']:runtimeKeys).some(key=>typeof initial?.runtimeVersions?.[key]!=='string'||!initial.runtimeVersions[key]))gaps.push('Runtime dependency versions incomplete');
  if(initial?.modelServer?.endpointOwned!==true||initial?.modelServer?.runtimeKind!=='llama.cpp'||!Number.isInteger(initial.modelServer.pid)||!Number.isFinite(initial.modelServer.startedAt))gaps.push('Model endpoint process ownership or runtime unverified');
  const evidence=initial?.modelEvidence;
  if(!/^[a-f0-9]{64}$/.test(evidence?.weightsFingerprint??''))gaps.push('Model weight identity not verified');
  if(!Number.isInteger(evidence?.contextLength)||evidence.contextLength<1)gaps.push('Effective model context limit unknown');
  if(!/^[a-f0-9]{64}$/.test(evidence?.serverSettingsFingerprint??''))gaps.push('Server inference defaults not identified');
  if(evidence?.verification!=='gguf-bytes-and-live-props-v1'||!Array.isArray(evidence.files)||!evidence.files.length||evidence.files.some(file=>!Number.isInteger(file.bytes)||file.bytes<24||!/^[a-f0-9]{64}$/.test(file.sha256??'')||!file.gguf)||!/^[a-f0-9]{64}$/.test(evidence.runtimeSha256??'')||!Number.isInteger(evidence.modelProcess?.pid)||!Number.isFinite(evidence.modelProcess?.startedAt)||evidence.gaps?.length)gaps.push('Model file/runtime provenance incomplete');
  if(!exactRequests)gaps.push('Exact outbound inference settings incompletely observed');
  if(unique.length!==1)gaps.push('No single stable outbound inference configuration');
  const complete=gaps.length===0&&changedFields.length===0;
  return {schemaVersion:1,comparisonReady:complete,drift:changedFields.length>0,changedFields,gaps,
    backendId:digest(initial),inferenceId:unique.length===1?digest({request:unique[0],defaults:evidence?.serverSettingsFingerprint??null,contextLength:evidence?.contextLength??null}):null,
    runtimeVersions:initial?.runtimeVersions??null,modelServer:initial?.modelServer??null,modelEvidence:evidence??null,
    requestedParameters:unique,requestCount:requests.length,exactRequests,
    omittedParameterMeaning:'Omitted request fields use provider/server behavior; absence is not a measured value. Server defaults and effective context require separate evidence.'};
}
