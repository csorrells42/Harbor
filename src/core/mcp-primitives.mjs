import {McpError,ErrorCode} from '@modelcontextprotocol/sdk/types.js';

const MAX_BYTES=4*1024*1024,MAX_ITEMS=10000;
const invalid=message=>new McpError(ErrorCode.InvalidParams,message);
const prefix=id=>Buffer.from(id,'utf8').toString('hex');
function text(value){if(typeof value!=='string'||!value||value.length>16384||/[\u0000-\u001f\u007f]/.test(value))throw invalid('Invalid MCP reference');return value;}
// Preserve the upstream URI/template verbatim, including RFC 6570 expressions.
// These are opaque references: never parse/normalize the nested URI as a URL.
export const resourceReference=(id,uri)=>text(`harbor-resource://${prefix(id)}/${text(uri)}`);
export const promptReference=(id,name)=>text(`harbor/${prefix(id)}/${text(name)}`);
export function parseReference(value,kind='resource'){
  text(value);
  const match=(kind==='resource'?/^harbor-resource:\/\/([0-9a-f]+)\/(.+)$/s:/^harbor\/([0-9a-f]+)\/(.+)$/s).exec(value);
  if(!match||match[1].length>160||match[1].length%2)throw invalid(`Expected a Harbor ${kind} reference from discovery`);
  const id=Buffer.from(match[1],'hex').toString('utf8');
  if(prefix(id)!==match[1]||!id)throw invalid('Invalid server namespace');
  return {serverId:id,value:text(match[2])};
}
export function bounded(value){if(Buffer.byteLength(JSON.stringify(value),'utf8')>MAX_BYTES)throw new McpError(ErrorCode.InternalError,'Upstream MCP response exceeds the 4 MiB safety limit');return value;}
export function mapContent(id,content){
  return content.map(item=>item.type==='resource_link'?{...item,uri:resourceReference(id,item.uri)}:item.type==='resource'?{...item,resource:{...item.resource,uri:resourceReference(id,item.resource.uri)}}:item);
}
export function mapToolResult(id,result){bounded(result);return bounded({...result,...(Array.isArray(result.content)?{content:mapContent(id,result.content)}:{})});}

// SDK 1.30 defers notification handlers but consumes responses synchronously.
// A stdio chunk containing progress followed by a result can otherwise delete
// the progress handler first. Preserve frame order across a microtask boundary;
// request execution itself stays concurrent.
export function preserveMessageOrder(transport){
  const start=transport.start.bind(transport);
  transport.start=async()=>{const receive=transport.onmessage;let pending=Promise.resolve();transport.onmessage=(message,extra)=>{pending=pending.then(()=>receive?.(message,extra)).catch(error=>transport.onerror?.(error));};return start();};
  return transport;
}

export function compatibleResult(method,result,version){
  if(!version||version>='2025-11-25')return result;
  const content=item=>{
    if(item.type==='resource_link'&&version<'2025-06-18')return {type:'text',text:`${item.name}: ${item.uri}`};
    if(item.type==='audio'&&version<'2025-03-26')return {type:'text',text:`Audio (${item.mimeType}) requires MCP 2025-03-26 or newer.`};
    return item;
  };
  if(method==='tools/call'){
    const {structuredContent,...rest}=result;
    if(version<'2025-06-18')return bounded({...rest,content:[...(result.content??[]).map(content),...(structuredContent!==undefined?[{type:'text',text:JSON.stringify(structuredContent)}]:[])]});
    return result;
  }
  if(method==='prompts/get')return {...result,messages:result.messages.map(message=>({...message,content:content(message.content)}))};
  if(method==='tools/list')return {...result,tools:result.tools.map(tool=>{
    const copy={...tool};delete copy.icons;delete copy.execution;
    if(version<'2025-06-18'){delete copy.title;delete copy.outputSchema;}
    if(version<'2025-03-26')delete copy.annotations;
    return copy;
  })};
  return result;
}

// One instance per upstream manager, including isolated profile managers.
// Subscription reference counts therefore follow actual upstream connections.
export function createMcpPrimitives(manager){
  const subscriptions=new Map(),listeners=new Set();let queue=Promise.resolve();
  const emit=event=>{for(const listener of listeners)try{listener(event);}catch{}};
  const serial=fn=>{const task=queue.then(fn);queue=task.catch(()=>{});return task;};
  function entry(id,capability){
    const e=manager.get(id);
    if(manager.closing||e.config.enabled===false||e.status!=='running'||!e.client)throw invalid('Upstream unavailable; start this server and refresh discovery');
    if(!e.client.getServerCapabilities()?.[capability])throw invalid(`Upstream does not support ${capability}`);
    return e;
  }
  async function request(id,capability,method,params,options={}){
    options.signal?.throwIfAborted();const e=entry(id,capability),client=e.client;e.active++;
    try{const result=await client[method](params,{timeout:manager.requestTimeoutMs,...options});options.signal?.throwIfAborted();if(e.client!==client||e.status!=='running')throw invalid('Upstream changed during request; refresh discovery');return bounded(result);}
    catch(error){if(e.client===client&&(options.signal?.aborted||error.code===ErrorCode.RequestTimeout)){e.idleUncertain=true;manager.changed();}throw error;}
    finally{e.active--;e.lastUsed=manager.now();}
  }
  async function list(kind,{serverIds,signal,onprogress,timeout}={}){
    const [capability,method,field,key]=kind==='prompts'?['prompts','listPrompts','prompts','name']:kind==='templates'?['resources','listResourceTemplates','resourceTemplates','uriTemplate']:['resources','listResources','resources','uri'];
    const items=[],errors=[];
    for(const e of manager.entries.values()){
      signal?.throwIfAborted();
      if(serverIds&&!serverIds.has(e.config.id)||e.config.enabled===false||e.status!=='running'||!e.client?.getServerCapabilities()?.[capability])continue;
      const local=[],seen=new Set(),names=new Set(),client=e.client;let cursor,bytes=0;
      try{
        do{
          const page=await request(e.config.id,capability,method,cursor===undefined?{}:{cursor},{signal,onprogress,...(timeout?{timeout}:{})});
          if(e.client!==client)throw invalid('Upstream changed during discovery');
          bytes+=Buffer.byteLength(JSON.stringify(page));if(bytes>MAX_BYTES)throw invalid('Upstream listing exceeds safety limit');
          for(const item of page[field]){
            if(names.has(item[key]))throw invalid('Duplicate upstream reference');names.add(item[key]);
            local.push({...item,[key]:kind==='prompts'?promptReference(e.config.id,item[key]):resourceReference(e.config.id,item[key])});
          }
          cursor=page.nextCursor;
          if(cursor!==undefined&&seen.has(cursor))throw invalid('Upstream pagination repeated a cursor');
          seen.add(cursor);if(seen.size>1000||local.length>MAX_ITEMS)throw invalid('Upstream listing exceeds safety limit');
        }while(cursor!==undefined);
        if(items.length+local.length>MAX_ITEMS)throw invalid('Combined MCP listing exceeds safety limit');
        bounded({[field]:[...items,...local]});items.push(...local);
      }catch(error){signal?.throwIfAborted();manager.log(e.config.id,'warn',`${capability} discovery failed: ${error.message}`);errors.push({serverId:e.config.id,message:'Discovery failed; inspect Harbor Activity and retry.'});}
    }
    return bounded({[field]:items,...(errors.length?{_meta:{'harbor/listingErrors':errors}}:{})});
  }
  const keyFor=(id,uri)=>JSON.stringify([id,uri]);
  async function unsubscribeRecord(record,throwOnFailure=false){
    if(subscriptions.get(record.key)===record)subscriptions.delete(record.key);record.release();
    if(record.e.client===record.client&&record.e.status==='running'){
      try{await request(record.id,'resources','unsubscribeResource',{uri:record.uri});}
      catch(error){if(record.e.client===record.client){record.e.idleUncertain=true;manager.changed();}manager.log(record.id,'warn','Resource unsubscribe failed; upstream outcome is unknown');if(throwOnFailure)throw error;}
    }
  }
  return {
    list,
    async read(id,uri,options){const result=await request(id,'resources','readResource',{uri},options);return bounded({...result,contents:result.contents.map(content=>({...content,uri:resourceReference(id,content.uri)}))});},
    async prompt(id,name,args,options){const result=await request(id,'prompts','getPrompt',{name,...(args?{arguments:args}:{})},options);return bounded({...result,messages:result.messages.map(message=>({...message,content:mapContent(id,[message.content])[0]}))});},
    listen(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
    notify(event){
      if(event.kind==='updated'){
        const record=subscriptions.get(keyFor(event.serverId,event.uri));
        if(record?.client===event.client)for(const notify of record.owners.values())try{notify(resourceReference(event.serverId,event.uri));}catch{}
      }else emit(event);
    },
    reset(id){
      for(const record of subscriptions.values())if(record.id===id){subscriptions.delete(record.key);record.release();}
      emit({kind:'reset',serverId:id});
    },
    subscribe(id,uri,owner,notify,options={}){return serial(async()=>{
      options.signal?.throwIfAborted();const e=entry(id,'resources');
      if(!e.client.getServerCapabilities().resources.subscribe)throw invalid('This upstream does not support resource subscriptions');
      const key=keyFor(id,uri);let record=subscriptions.get(key);
      if(record&&record.client!==e.client){subscriptions.delete(key);record.release();record=undefined;}
      if(record?.owners.has(owner))return {};
      if([...subscriptions.values()].filter(value=>value.owners.has(owner)).length>=128||!record&&subscriptions.size>=2048)throw invalid('Resource subscription capacity reached');
      try{
        if(!record){
          record={key,id,uri,e,client:e.client,owners:new Map(),release:manager.retainServers([id],Symbol('resource subscription'))};subscriptions.set(key,record);
          await request(id,'resources','subscribeResource',{uri},options);
        }
        options.signal?.throwIfAborted();record.owners.set(owner,notify);return {};
      }catch(error){if(record&&!record.owners.size)await unsubscribeRecord(record);throw error;}
    });},
    unsubscribe(id,uri,owner){return serial(async()=>{const record=subscriptions.get(keyFor(id,uri));if(record?.owners.delete(owner)&&!record.owners.size)await unsubscribeRecord(record,true);return {};});},
    release(owner){return serial(async()=>{for(const record of subscriptions.values())if(record.owners.delete(owner)&&!record.owners.size)await unsubscribeRecord(record);});},
    snapshot:()=>({subscriptions:subscriptions.size,owners:[...subscriptions.values()].reduce((sum,record)=>sum+record.owners.size,0),listeners:listeners.size})
  };
}
