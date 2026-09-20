import {createHash} from 'node:crypto';
import {DEFAULT_SETTINGS, validateSettings} from '../core/settings.mjs';
import {CONFORMANCE_TASKS,WORKLOAD_TASKS} from './workload-catalog.js';
import {validateCatalogVariant} from './catalog-options.js';

export const TASK_IDS=[...CONFORMANCE_TASKS,...WORKLOAD_TASKS].map(task=>task.id);
export const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const DEFAULT_PLAN=Object.freeze({harness:'hermes',repetitions:3, seed:18431, maxTrialSeconds:120, maxCampaignSeconds:1800, maxTurns:12, maxHostUsedGiB:null, maxGpuUsedMiB:null, tasks:CONFORMANCE_TASKS.map(task=>task.id), variants:[{id:'all',toolMode:'all'},{id:'bm25',toolMode:'bm25'},{id:'regex',toolMode:'regex'},{id:'code',toolMode:'code'},{id:'semantic',toolMode:'portkey-local'},{id:'hybrid',toolMode:'hybrid',hybridModes:['bm25','portkey-local']}]});
export function validatePlan(input={}) {
  const p={...structuredClone(DEFAULT_PLAN),...input};
  if(!['hermes','openclaw','lmstudio'].includes(p.harness))throw new Error('Choose Hermes, OpenClaw or LM Studio');
  p.overlapProviders??=false;if(typeof p.overlapProviders!=='boolean')throw new Error('Equivalent fixture providers must be enabled or disabled');
  for(const [key,min,max] of [['repetitions',1,30],['seed',0,2147483647],['maxTrialSeconds',10,1800],['maxCampaignSeconds',10,86400],['maxTurns',1,100]])if(!Number.isInteger(p[key])||p[key]<min||p[key]>max)throw new Error(`${key} must be ${min}–${max}`);
  for(const key of ['maxHostUsedGiB','maxGpuUsedMiB'])if(p[key]!==null&&(!Number.isFinite(p[key])||p[key]<=0))throw new Error(`${key} must be positive or null`);
  if(!Array.isArray(p.tasks)||!p.tasks.length||p.tasks.some(x=>!TASK_IDS.includes(x))||new Set(p.tasks).size!==p.tasks.length)throw new Error('Select unique supported tasks');
  if(!Array.isArray(p.variants)||!p.variants.length||p.variants.length>24)throw new Error('Select 1–24 variants');
  const allowed=new Set(['id','toolMode','hybridModes','searchLimit','semanticMinScore','portkeyLocalModel','catalog']);
  p.variants=p.variants.map(v=>{
    if(!v||typeof v.id!=='string'||!/^[-\w]{1,60}$/.test(v.id)||Object.keys(v).some(k=>!allowed.has(k)))throw new Error('Invalid variant fields or ID');
    const {catalog,...delivery}=v,settings=validateSettings({...DEFAULT_SETTINGS,...delivery}),catalogOptions=validateCatalogVariant(catalog);
    if(catalogOptions.provider==='alternate'&&!p.overlapProviders)throw new Error('Alternate provider requires the equivalent-provider fixture');
    if([settings.toolMode,...(settings.toolMode==='hybrid'?settings.hybridModes:[])].some(m=>['portkey-api','portkey-workers'].includes(m)))throw new Error('This adapter supports local delivery methods only');
    return {id:v.id,settings,catalog:catalogOptions};
  });
  if(new Set(p.variants.map(v=>v.id)).size!==p.variants.length)throw new Error('Variant IDs must be unique');
  if(p.tasks.length*p.variants.length*p.repetitions>600)throw new Error('Campaign limit is 600 trials');
  return p;
}
export function schedule(plan) {
  let state=plan.seed>>>0;
  const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  const rows=[];
  for(let repetition=0;repetition<plan.repetitions;repetition++) {
    const block=plan.tasks.flatMap(task=>plan.variants.map(variant=>({task,variant,repetition,nonce:hash([plan.seed,task,repetition]).slice(0,12)})));
    for(let i=block.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[block[i],block[j]]=[block[j],block[i]];}
    rows.push(...block);
  }
  return rows;
}
