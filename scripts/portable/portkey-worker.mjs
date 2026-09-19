import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
const root=path.resolve(process.argv[2]),pkg=path.resolve(process.argv[3]||path.join(root,'packages/portkey-tools'));
const {env}=await import(pathToFileURL(path.join(pkg,'node_modules/@xenova/transformers/src/transformers.js')));
env.cacheDir=path.join(root,'runtimes/embedding-models');env.allowRemoteModels=false;
const {MCPToolFilter}=await import(pathToFileURL(path.join(pkg,'dist/index.js')));
const caches=new Map();
const semanticModes=['portkey-local','portkey-api','portkey-workers'];
const keyFile=async file=>{
  if(!file)throw new Error('Choose an API key file for this embedding provider.');
  const resolved=file.replaceAll('${HARBOR_ROOT}',root);
  const key=(await fs.readFile(resolved,'utf8')).trim();if(!key)throw new Error('The embedding provider key file is empty.');return key;
};
async function embedding(mode,s){
  if(mode==='portkey-local')return {provider:'local',model:s.portkeyLocalModel,quantized:true};
  const prefix=mode==='portkey-api'?'portkeyApi':'portkeyWorkers';
  if(!s[prefix+'Url']||!s[prefix+'Model'])throw new Error('Configure the embedding endpoint and model first.');
  if(mode==='portkey-workers'&&!s[prefix+'Model'].startsWith('@cf/'))throw new Error('Cloudflare embedding model names must start with @cf/.');
  return {provider:'openai',apiKey:await keyFile(s[prefix+'KeyFile']),baseURL:s[prefix+'Url'].replace(/\/$/,''),model:s[prefix+'Model'],dimensions:s[prefix+'Dimensions']};
}
async function handle(r){
  if(!semanticModes.includes(r.mode))throw new Error('Unknown semantic search method.');
  const config=await embedding(r.mode,r.settings);
  if(r.op==='prepare'){
    if(r.mode==='portkey-local')await fs.access(path.join(env.cacheDir,r.settings.portkeyLocalModel,'onnx/model_quantized.onnx'));
    return {ready:true};
  }
  const fingerprint=createHash('sha256').update(JSON.stringify([config,r.tools])).digest('hex');
  // Keep one index per selected provider: Hybrid alternates providers on each
  // query, so a single shared index re-embeds the whole catalog every time.
  // Drop unselected entries and replace changed indexes before allocating new
  // ones; at most the three supported provider indexes can remain resident.
  const selected=new Set([r.mode,...(r.settings.toolMode==='hybrid'?r.settings.hybridModes??[]:[r.settings.toolMode])]);
  for(const [mode,entry] of caches)if(!selected.has(mode)){caches.delete(mode);await entry.filter.dispose();}
  let cached=caches.get(r.mode);
  if(cached?.fingerprint!==fingerprint){
    caches.delete(r.mode);await cached?.filter.dispose();cached=undefined;
    const filter=new MCPToolFilter({embedding:config,debug:false});
    const groups=new Map();for(const tool of r.tools){const id=tool.serverId||'harbor';if(!groups.has(id))groups.set(id,{id,name:id,tools:[]});groups.get(id).tools.push({...tool,description:tool.description||tool.name});}
    try{await filter.initialize([...groups.values()]);cached={fingerprint,filter};caches.set(r.mode,cached);}catch(error){await filter.dispose();throw error;}
  }
  const result=await cached.filter.filter(r.query,{topK:r.settings.searchLimit,minScore:r.settings.semanticMinScore});
  return {tools:result.tools.map(t=>({name:t.toolName,score:t.score})),metrics:result.metrics};
}
let queue=Promise.resolve();
createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
  queue=queue.then(async()=>{let r;try{r=JSON.parse(line);const result=await handle(r);process.stdout.write(JSON.stringify({id:r.id,result})+'\n');}catch(error){const message=r?.mode==='portkey-local'||r?.op==='prepare'?error.message:'Embedding provider request failed. Check endpoint, model, credentials and provider availability.';process.stdout.write(JSON.stringify({id:r?.id,error:message})+'\n');}});
}).on('close',()=>queue.finally(()=>process.exit(0)));
