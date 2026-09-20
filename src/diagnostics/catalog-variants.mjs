import {createHash} from 'node:crypto';
import {CATALOG_VARIANT_VERSION,CONCISE_DESCRIPTIONS,FIXTURE_WORKFLOWS,ALTERNATIVE_WORKFLOWS,validateCatalogVariant} from './catalog-options.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicTool=({serverId,originalName,...tool})=>tool;
// Traverse schema positions only: a property NAMED description/title remains
// an actual property, and enum/const/examples values are never rewritten.
export function validationSchema(schema){
  if(typeof schema==='boolean')return schema;
  if(!schema||typeof schema!=='object'||Array.isArray(schema))throw new Error('Invalid fixture input schema');
  const result=structuredClone(schema);
  for(const key of ['title','description','examples','$comment'])delete result[key];
  for(const key of ['properties','patternProperties','$defs','definitions','dependentSchemas'])if(result[key])for(const name of Object.keys(result[key]))result[key][name]=validationSchema(result[key][name]);
  for(const key of ['allOf','anyOf','oneOf','prefixItems'])if(result[key])result[key]=result[key].map(validationSchema);
  for(const key of ['additionalProperties','additionalItems','unevaluatedProperties','unevaluatedItems','contains','not','if','then','else','propertyNames'])if(Object.hasOwn(result,key))result[key]=validationSchema(result[key]);
  if(Object.hasOwn(result,'items'))result.items=Array.isArray(result.items)?result.items.map(validationSchema):validationSchema(result.items);
  if(result.dependencies)for(const key of Object.keys(result.dependencies))if(!Array.isArray(result.dependencies[key]))result.dependencies[key]=validationSchema(result.dependencies[key]);
  return result;
}
export function createCatalogVariant(task,input,{overlapProviders=false}={}){
  const options=validateCatalogVariant(input),original=structuredClone(task.upstreams.tools());
  if(options.provider==='alternate'&&!overlapProviders)throw new Error('Alternate provider requires the equivalent-provider fixture');
  if(!Object.hasOwn(FIXTURE_WORKFLOWS,task.id))throw new Error('Fixture workflow is not declared');
  if(new Set(original.map(tool=>tool.name)).size!==original.length)throw new Error('Fixture catalog contains duplicate names');
  const aliases=new Map(),base=[...original];
  if(overlapProviders)for(const tool of original){const alias={...structuredClone(tool),serverId:tool.serverId+'_alternate',name:tool.serverId+'_alternate__'+tool.originalName};if(original.some(value=>value.name===alias.name))throw new Error('Fixture provider collision');aliases.set(alias.serverId,tool.serverId);base.push(alias);}
  const originalNames=new Set(original.map(tool=>tool.name)),workflow=FIXTURE_WORKFLOWS[task.id];
  if(workflow.some(name=>!originalNames.has(name)))throw new Error('Declared workflow is incomplete in the fixture catalog');
  const capability=tool=>(aliases.get(tool.serverId)??tool.serverId)+'__'+tool.originalName;
  let selected=base.filter(tool=>(options.provider==='all'||(options.provider==='alternate')===aliases.has(tool.serverId))&&(options.subset==='all'||workflow.includes(capability(tool))));
  const changedDescriptions=[];
  selected=selected.map(tool=>{
    const result=structuredClone(tool);
    if(options.descriptions==='concise'&&CONCISE_DESCRIPTIONS[tool.originalName]){result.description=CONCISE_DESCRIPTIONS[tool.originalName];if(result.description!==tool.description)changedDescriptions.push(tool.name);}
    if(options.schemaAnnotations==='minimal')result.inputSchema=validationSchema(tool.inputSchema);
    if(JSON.stringify(validationSchema(result.inputSchema))!==JSON.stringify(validationSchema(tool.inputSchema)))throw new Error('Catalog transformation changed an invocation contract');
    return result;
  });
  if(options.order!=='source')selected.sort((a,b)=>(a.name<b.name?-1:a.name>b.name?1:0)*(options.order==='name-asc'?1:-1));
  const retained=new Set(selected.map(capability));if(workflow.some(name=>!retained.has(name)))throw new Error('Catalog variant removes a required workflow capability');
  const selectedNames=new Set(selected.map(tool=>tool.name)),selectedServers=new Set(selected.map(tool=>tool.serverId));
  const baseCatalog=base.map(publicTool),catalog=selected.map(publicTool),groups=(task.relevantToolNames??[]).map(name=>base.filter(tool=>capability(tool)===name).map(tool=>tool.name));
  const metadata={version:CATALOG_VARIANT_VERSION,options,overlapProviders,workflowPreserved:true,
    curation:options.subset==='workflow'?'Fixture-declared complete workflow; not learned retrieval or a general recommendation':'No task-aware curation',
    providers:overlapProviders?'Primary and equivalent alternate fixture routes share the same synthetic backend; no external-provider performance claim':'One fixture provider',
    ordering:'Catalog order only; a search method may rank returned results independently',
    baseCatalogFingerprint:hash(baseCatalog),catalogFingerprint:hash(catalog),filteredTools:base.filter(tool=>!selectedNames.has(tool.name)).map(tool=>tool.name),changedDescriptions,
    workflowToolNames:[...workflow],relevantCapabilityGroups:groups,
    validWorkflows:[workflow,...(ALTERNATIVE_WORKFLOWS[task.id]??[])].map(names=>names.map(name=>base.filter(tool=>capability(tool)===name).map(tool=>tool.name)))};
  return {catalog,baseCatalog,metadata,relevantToolNames:groups.flat(),
    upstreams:{tools:()=>structuredClone(selected),get:serverId=>selectedServers.has(serverId)?task.upstreams.get(aliases.get(serverId)??serverId):undefined}
  };
}
