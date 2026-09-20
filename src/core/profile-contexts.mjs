import {randomUUID,randomBytes} from 'node:crypto';
import {createProfileRuntime} from './profile-runtime.mjs';
import {createToolDelivery} from './tool-delivery.mjs';
import {withAbortSignals} from './request-cancellation.mjs';

// Contexts hold immutable profile revisions, filtered catalogs and owned workers.
// Only public sessions are owners; internal search connections never extend life.
export function createProfileContexts({profiles,shared,endpoint,settings,log,traces,changed,callRaw,closeInternal,retainCredentials=()=>()=>{}}) {
  const contexts=new Map(),sharedContexts=new Map(),pending=new Map(),cleanups=new Set();
  const lifetime=new AbortController();let closed=false;
  const track=promise=>{cleanups.add(promise);promise.then(()=>cleanups.delete(promise),()=>cleanups.delete(promise));return promise;};
  function retire(context) {
    if(context.closing)return context.closing;
    context.retiring=true;contexts.delete(context.id);
    if(sharedContexts.get(context.key)===context)sharedContexts.delete(context.key);
    context.closing=track((async()=>{
      try {await context.router.close();}
      finally {try{await closeInternal(context);}finally{try{await context.runtime.close();}finally{context.forgetSecret?.();context.releaseCredentials();}}}
    })());
    return context.closing;
  }
  async function build(profile,key,signal) {
    const current=settings(),id=randomUUID(),token=randomBytes(32).toString('base64url');
    const effective={...current,...profile.delivery};
    const releaseCredentials=retainCredentials(effective);
    let runtime;
    try{runtime=await createProfileRuntime({profile,shared,log,changed,requestTimeoutMs:effective.requestTimeoutMs,signal});}
    catch(error){releaseCredentials();throw error;}
    const context={id,key,profile,runtime,releaseCredentials,settings:effective,authorization:Buffer.from('Bearer '+token),owners:new Set(),retiring:false};
    context.catalogPath=new URL(endpoint()).pathname+'/_harbor_profile_catalog/'+id;
    try {
      context.forgetSecret=traces?.protect?.(token);
      context.router=createToolDelivery({catalogToken:token,endpoint:new URL(context.catalogPath,endpoint()).href,log,traces,
        tools:()=>runtime.upstreams.tools(),callRaw:(params,options)=>callRaw(params,options,context),settings:effective});
      if(closed||signal.aborted)throw signal.reason??new Error('Profile gateway closed');
      // A profile deleted during startup must never leave a usable orphan route.
      profiles.get(profile.id,{forSession:true});
      contexts.set(id,context);
      if(profile.isolation==='shared')sharedContexts.set(key,context);
      return context;
    }catch(error){try{await context.router?.close();}finally{try{await runtime.close();}finally{context.forgetSecret?.();releaseCredentials();}}throw error;}
  }
  return {
    privateContext(url){for(const context of contexts.values())if(context.catalogPath===url)return context;return undefined;},
    async acquire(profileId,ownerId,{signal}={}) {
      if(closed)throw new Error('Profile gateway closed');
      const profile=profiles.get(profileId,{forSession:true});
      const key=profile.id+'@'+profile.revision+(profile.isolation==='process'?':'+ownerId:'');
      return withAbortSignals([lifetime.signal,signal],async combined=>{
      let context=sharedContexts.get(key),entry;
      try{
        if(!context){
          entry=pending.get(key);
          if(!entry){
          if(contexts.size+pending.size>=128)throw new Error('Profile context capacity reached');
          // A cancelled waiter must not cancel another client's shared catalog.
          entry={task:build(profile,key,profile.isolation==='shared'?lifetime.signal:combined),waiters:0};pending.set(key,entry);
          }
          entry.waiters++;context=await entry.task;
        }
        if(closed||combined.aborted||context.retiring)throw combined.reason??new Error('Profile context retired during initialization');
        context.runtime.acquire(ownerId);context.owners.add(ownerId);return context;
      }finally{
        if(entry&&!--entry.waiters){pending.delete(key);if(context&&!context.owners.size)await retire(context);}
      }
      });
    },
    async release(context,ownerId){
      if(!context||!context.owners.delete(ownerId))return;
      if(context.owners.size)await context.runtime.release(ownerId);else await retire(context);
    },
    snapshot:()=>[...contexts.values()].map(context=>({...context.runtime.snapshot(),contextId:context.id,ownerCount:context.owners.size})),
    async suspend(){await Promise.all([...contexts.values()].map(context=>context.router.suspend()));},
    async drain(){await Promise.allSettled([...cleanups]);},
    async close(){
      closed=true;lifetime.abort(new Error('Profile gateway closed'));
      await Promise.allSettled([...pending.values()].map(entry=>entry.task));
      await Promise.allSettled([...contexts.values()].map(retire));
      await Promise.allSettled([...cleanups]);
    }
  };
}
