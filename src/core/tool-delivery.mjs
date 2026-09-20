import {createToolRouter} from './tool-router.mjs';
import {createSemanticWorker} from './semantic-worker.mjs';
import {SEARCH_DEFAULTS,deliveryMethods} from './delivery-options.js';
import {traceOutcome} from './request-traces.mjs';

const publicTool=({serverId,originalName,...tool})=>tool;
const json=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const fastModes=['bm25','regex','code'];
const escapeRegex=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function namesFrom(result){
  if(result.isError)throw new Error(result.content?.find(c=>c.type==='text')?.text||'Search failed');
  const found=[];
  function walk(value){if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object'){if(typeof value.name==='string')found.push(value.name);else Object.values(value).forEach(walk);}}
  if(result.structuredContent)walk(result.structuredContent);
  for(const item of result.content??[])if(item.type==='text'){
    try{walk(JSON.parse(item.text));}catch{const start=item.text.indexOf('[');if(start>=0)try{walk(JSON.parse(item.text.slice(start)));}catch{}}
  }
  return [...new Set(found)];
}
export function createToolDelivery({endpoint,catalogToken,log,traces,tools,callRaw,settings:initial,retainCredentials=()=>()=>{}}){
  const trace=(metadata,operation,options)=>traces?traces.run(metadata,operation,options):operation();
  let fast=createToolRouter({endpoint,catalogToken,log}),semantic=createSemanticWorker();
  let settings={...SEARCH_DEFAULTS,...initial};
  const fastKey=(mode,s)=>`${mode}:${s.searchLimit}`;
  const select=()=>{const methods=deliveryMethods(settings);fast.select(methods.filter(m=>fastModes.includes(m)).map(m=>fastKey(m,settings)));semantic.select(methods.some(m=>m.startsWith('portkey-')));};
  select();
  async function search(args,options){
    if(typeof args.query!=='string'||!args.query.trim()){const error=new Error('query must be nonempty text');error.harborOutcome='invalid-arguments';throw error;}
    const current={...settings},methods=deliveryMethods(current),catalog=tools();
    const releaseCredentials=retainCredentials(current);
    try{
    const results=await Promise.allSettled(methods.map(async mode=>{
      if(mode==='all')throw new Error('All tools cannot be combined in Hybrid');
      if(mode.startsWith('portkey-'))return (await semantic.request({op:'search',mode,settings:current,tools:catalog,query:args.query},options)).tools.map(t=>t.name);
      const params=mode==='code'?{name:'search',arguments:{query:args.query,detail:'full',limit:current.searchLimit}}:mode==='regex'?{name:'search_tools',arguments:{pattern:args.pattern??args.query.trim().split(/\s+/).map(escapeRegex).join('|')}}:{name:'search_tools',arguments:{query:args.query}};
      return namesFrom(await fast.call(fastKey(mode,current),params,options));
    }));
    const live=new Map(tools().map(t=>[t.name,t])),matches=new Map(),warnings=[];
    results.forEach((result,i)=>{
      if(result.status==='rejected'){warnings.push({method:methods[i],message:result.reason.message});return;}
      result.value.forEach((name,rank)=>{if(!live.has(name))return;let match=matches.get(name);if(!match){match={...publicTool(live.get(name)),matchedBy:[],sourceRanks:{},rankScore:0};matches.set(name,match);}if(!match.matchedBy.includes(methods[i])){match.matchedBy.push(methods[i]);match.sourceRanks[methods[i]]=rank+1;match.rankScore+=1/(60+rank+1);}});
    });
    const ranked=[...matches.values()].sort((a,b)=>b.rankScore-a.rankScore||a.name.localeCompare(b.name));
    traces?.annotate({discovery:{methods,failedMethods:warnings.map(w=>w.method),candidateCount:ranked.length,candidates:ranked.slice(0,100).map((t,index)=>({name:t.name,rank:index+1,score:t.rankScore,sourceRanks:t.sourceRanks}))}});
    if(warnings.length===methods.length)throw new Error(warnings.map(w=>`${w.method}: ${w.message}`).join('; '));
    return json({tools:ranked.map(({rankScore,sourceRanks,...t})=>t),methods,warnings});
    }finally{releaseCredentials();}
  }
  return {
    async prepare(next){const release=retainCredentials(next);try{for(const mode of deliveryMethods(next)){if(fastModes.includes(mode))await fast.prepare(fastKey(mode,next));else if(mode.startsWith('portkey-'))await semantic.request({op:'prepare',mode,settings:next});}}finally{release();}},
    configure(next){settings={...SEARCH_DEFAULTS,...next};select();},
    async list(params){
      if(fastModes.includes(settings.toolMode))return fast.list(fastKey(settings.toolMode,settings),params);
      const advertised=[{name:'search_tools',description:'Find relevant tools. Returns exact names and full input schemas. Hybrid combines selected search methods and removes duplicates. Use call_tool with a returned name and arguments matching its schema.',inputSchema:{type:'object',properties:{query:{type:'string',description:'Describe the action you need.'},pattern:{type:'string',description:'Optional regular expression for the regex method.'}},required:['query'],additionalProperties:false}},{name:'call_tool',description:'Invoke a tool returned by search_tools using its exact name and input schema.',inputSchema:{type:'object',properties:{name:{type:'string'},arguments:{type:'object',additionalProperties:true}},required:['name','arguments'],additionalProperties:false}}];
      if(deliveryMethods(settings).includes('code'))advertised.push(...(await fast.list(fastKey('code',settings))).tools.filter(t=>t.name!=='search'));
      return {tools:advertised};
    },
    async call(params,options){
      if(fastModes.includes(settings.toolMode)){
        const discovery=['search','search_tools','get_schema'].includes(params.name);
        return trace({kind:discovery?'discovery':'delivery',tool:params.name},async()=>{
          const result=await fast.call(fastKey(settings.toolMode,settings),params,options);
          if(discovery&&!result.isError){const names=namesFrom(result);traces?.annotate({discovery:{methods:[settings.toolMode],candidateCount:names.length,candidates:names.slice(0,100).map((name,index)=>({name,rank:index+1}))}});}
          return result;
        },{payload:params.arguments,signal:options?.signal});
      }
      try{
        const args=params.arguments??{};
        if(params.name==='search_tools')return await trace({kind:'discovery',tool:params.name},()=>search(args,options),{payload:args,signal:options?.signal});
        if(params.name==='call_tool'){
          if(typeof args.name!=='string'||!args.arguments||typeof args.arguments!=='object'||Array.isArray(args.arguments)){const error=new Error('Supply name and an arguments object matching the discovered schema.');error.harborOutcome='invalid-arguments';throw error;}
          return await callRaw({name:args.name,arguments:args.arguments},options);
        }
        if(['get_schema','execute'].includes(params.name)&&deliveryMethods(settings).includes('code'))return await fast.call(fastKey('code',settings),params,options);
        throw new Error(`Unknown tool: ${params.name}. Search first, then use call_tool.`);
      }catch(error){traces?.annotate({outcome:traceOutcome(error,options?.signal,params.name==='search_tools'?'discovery':'upstream')});return {...json({error:error.message}),isError:true};}
    },
    async suspend(){await Promise.all([fast.close(),semantic.close()]);fast=createToolRouter({endpoint,catalogToken,log});semantic=createSemanticWorker();select();},
    async close(){await Promise.all([fast.close(),semantic.close()]);}
  };
}
