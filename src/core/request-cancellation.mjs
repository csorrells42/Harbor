// A request owns its links to the session/startup lifetimes. Dispose those
// links when it settles. A composite AbortSignal.any passed into SDK listeners
// can otherwise retain closed sessions in Node's persistent signal set.
export async function withAbortSignals(signals,operation){
  const controller=new AbortController(),links=[];
  try{
    for(const signal of new Set(signals.filter(Boolean))){
      if(signal.aborted){controller.abort(signal.reason);break;}
      const abort=()=>controller.abort(signal.reason);
      signal.addEventListener('abort',abort,{once:true});links.push([signal,abort]);
    }
    controller.signal.throwIfAborted();
    return await operation(controller.signal);
  }finally{
    for(const [signal,abort] of links)signal.removeEventListener('abort',abort);
  }
}
