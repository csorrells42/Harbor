import {Upstreams} from './upstreams.mjs';

// A profile runtime owns either a filtered view or private native child processes.
// It never treats a separate process as filesystem/account isolation.
export async function createProfileRuntime({profile,shared,log=()=>{},changed=()=>{},requestTimeoutMs=60000,signal}){
  const snapshot=structuredClone(profile),allowed=new Set(snapshot.serverIds),owners=new Set(),pins=new Map();
  let closed=false,closing,owned;
  if(signal?.aborted)throw signal.reason??new Error('Profile startup cancelled');
  const configs=[...allowed].flatMap(id=>{try{return [structuredClone(shared.get(id).config)];}catch{return [];}});
  if(snapshot.isolation==='process'){
    if(configs.some(config=>config.transport!=='stdio'||config.runtime!=='native'))throw new Error('Per-session process isolation is only supported for native stdio servers');
    owned=new Upstreams(configs.map(config=>({...config,autoStart:false})),log,changed,{requestTimeoutMs});
  }
  const backend=owned??shared;
  const close=()=>{
    if(closing)return closing;
    closed=true;owners.clear();for(const release of pins.values())release();pins.clear();
    closing=owned?owned.close():Promise.resolve();
    return closing;
  };
  const abort=()=>void close().catch(()=>{});
  signal?.addEventListener('abort',abort,{once:true});
  try{
    if(owned){
      // Wait for all starts to settle before cleanup; a late success must not
      // survive a sibling's startup failure.
      const starts=await Promise.allSettled(configs.filter(config=>config.enabled!==false).map(config=>owned.start(config.id).catch(error=>{void close().catch(()=>{});throw error;})));
      const failed=starts.find(result=>result.status==='rejected');
      if(failed)throw failed.reason;
    }
    if(signal?.aborted||closed)throw signal?.reason??new Error('Profile startup cancelled');
  }catch(error){await close();throw error;}
  finally{signal?.removeEventListener('abort',abort);}
  return {
    profile:snapshot,
    upstreams:{
      mcp:backend.mcp?{
        list(kind,options){if(closed||!snapshot.capabilities.includes(kind==='prompts'?'prompts':'resources'))throw new Error('Capability is outside this live profile');return backend.mcp.list(kind,{...options,serverIds:allowed});},
        read(id,...args){if(closed||!snapshot.capabilities.includes('resources')||!allowed.has(id))throw new Error('Resource is outside this live profile');return backend.mcp.read(id,...args);},
        prompt(id,...args){if(closed||!snapshot.capabilities.includes('prompts')||!allowed.has(id))throw new Error('Prompt is outside this live profile');return backend.mcp.prompt(id,...args);},
        subscribe(id,...args){if(closed||!snapshot.capabilities.includes('resources')||!allowed.has(id))throw new Error('Resource is outside this live profile');return backend.mcp.subscribe(id,...args);},
        unsubscribe(id,...args){if(closed||!allowed.has(id))throw new Error('Resource is outside this live profile');return backend.mcp.unsubscribe(id,...args);},
        release:owner=>backend.mcp.release(owner),
        listen:listener=>backend.mcp.listen(event=>{if(!closed&&allowed.has(event.serverId))listener(event);})
      }:undefined,
      tools:()=>closed||!snapshot.capabilities.includes('tools')?[]:backend.tools().filter(tool=>allowed.has(tool.serverId)),
      get(id){if(closed||!allowed.has(id))throw new Error('Server is outside this live profile');return backend.get(id);},
      invoke(tool,args,options){if(closed||!snapshot.capabilities.includes('tools')||!allowed.has(tool.serverId))throw new Error('Tool is outside this live profile');return backend.invoke(tool,args,options);},
      snapshot:()=>backend.snapshot().filter(server=>allowed.has(server.id))
    },
    acquire(ownerId){
      if(closed)throw new Error('Profile runtime is closed');
      if(owners.has(ownerId))throw new Error('Duplicate profile session owner');
      if(owned&&owners.size)throw new Error('An isolated process runtime belongs to exactly one public session');
      owners.add(ownerId);
      if(!owned&&backend.retainServers)pins.set(ownerId,backend.retainServers(allowed,ownerId));
    },
    async release(ownerId){if(!owners.delete(ownerId))return;pins.get(ownerId)?.();pins.delete(ownerId);if(!owners.size)await close();},
    snapshot:()=>({profileId:snapshot.id,revision:snapshot.revision,isolation:snapshot.isolation,owners:[...owners],closed,servers:backend.snapshot().filter(server=>allowed.has(server.id))}),
    close
  };
}
