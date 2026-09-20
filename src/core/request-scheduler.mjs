// FIFO among eligible sessions, with explicit active/queued limits and no replay.
export function createRequestScheduler({maxActive=32,maxQueued=128,maxPerSession=8,queueTimeoutMs=30000}={}){
  for(const value of [maxActive,maxQueued,maxPerSession,queueTimeoutMs])if(!Number.isInteger(value)||value<1)throw new Error('Scheduler limits must be positive integers');
  let active=0,closed=false;
  const queue=[],sessions=new Map(),running=new Set();
  const failure=(message,outcome='unavailable')=>Object.assign(new Error(message),{harborOutcome:outcome});
  function detach(item){clearTimeout(item.timer);item.signal?.removeEventListener('abort',item.abort);}
  function pump(){
    if(closed)return;
    while(active<maxActive){
      const index=queue.findIndex(item=>(sessions.get(item.sessionId)??0)<maxPerSession);
      if(index<0)return;
      const item=queue.splice(index,1)[0];detach(item);
      if(item.signal?.aborted){item.reject(failure('Queued request cancelled','cancelled'));continue;}
      active++;sessions.set(item.sessionId,(sessions.get(item.sessionId)??0)+1);
      const task=Promise.resolve().then(()=>{if(closed)throw failure('Gateway scheduler closed');return item.operation();}).then(item.resolve,item.reject).finally(()=>{
        active--;const count=sessions.get(item.sessionId)-1;if(count)sessions.set(item.sessionId,count);else sessions.delete(item.sessionId);
        running.delete(task);pump();
      });
      running.add(task);
    }
  }
  return {
    snapshot:()=>({active,queued:queue.length,maxActive,maxQueued,maxPerSession,closed}),
    run(sessionId,operation,{signal}={}){
      if(closed)return Promise.reject(failure('Gateway scheduler closed'));
      if(signal?.aborted)return Promise.reject(failure('Request cancelled','cancelled'));
      if(queue.length>=maxQueued)return Promise.reject(failure('Gateway request queue is full; no call was dispatched'));
      return new Promise((resolve,reject)=>{
        const item={sessionId,operation,signal,resolve,reject};
        const remove=error=>{const index=queue.indexOf(item);if(index<0)return;queue.splice(index,1);detach(item);reject(error);};
        item.abort=()=>remove(failure('Queued request cancelled','cancelled'));
        item.timer=setTimeout(()=>remove(failure('Request expired in the queue; no call was dispatched','timeout')),queueTimeoutMs);
        signal?.addEventListener('abort',item.abort,{once:true});queue.push(item);pump();
      });
    },
    cancelSession(sessionId){
      for(const item of [...queue])if(item.sessionId===sessionId){queue.splice(queue.indexOf(item),1);detach(item);item.reject(failure('Client session closed before dispatch','cancelled'));}
    },
    async close(){
      closed=true;
      for(const item of queue.splice(0)){detach(item);item.reject(failure('Gateway closed before dispatch','cancelled'));}
      await Promise.allSettled([...running]);
    }
  };
}
