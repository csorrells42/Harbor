import { createServer } from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces, hostname } from 'node:os';
import { urlHost } from './settings.mjs';
import {createToolDelivery} from './tool-delivery.mjs';
import {traceOutcome} from './request-traces.mjs';
import {createProfileContexts} from './profile-contexts.mjs';
import {createRequestScheduler} from './request-scheduler.mjs';
import {withAbortSignals} from './request-cancellation.mjs';
import {parseReference,mapToolResult,compatibleResult} from './mcp-primitives.mjs';
const gatewayInstructions = 'Tools are namespaced by server. Clients share each upstream process and its mutable state. When discovery tools are advertised, search for relevant tools and obtain their schemas before invoking them. Code Mode uses Python to compose existing tool calls.';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema, isInitializeRequest, McpError, ErrorCode, SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

export async function createGateway({ host, port, upstreams, log, toolTimeoutMs, toolMode='all', mcpPath = '/mcp', networkEnabled = false, allowedOrigins = [], isOpen = () => true, isPublicOpen = () => true, authentication, traces, profiles, retainCredentials, maxSessions=128, sessionIdleMs=900000, sessionSweepMs=10000, schedulerLimits, ...deliverySettings }) {
  const trace=(metadata,operation,options)=>traces?traces.run(metadata,operation,options):operation();
  const sessions = new Map(), liveSessions = new Set();
  const publicQueue=createRequestScheduler(schedulerLimits),internalQueue=createRequestScheduler(schedulerLimits);
  const initializationLifetime=new AbortController(),cleanupTasks=new Set(),initializations=new Set();
  let profileContexts,initializing=0;
  const cleanup=promise=>{cleanupTasks.add(promise);promise.then(()=>cleanupTasks.delete(promise),()=>{cleanupTasks.delete(promise);log('','warn','Profile cleanup failed');});return promise;};
  const sendChanged=(session,kind)=>{if(!session.revoked&&session.capabilities[kind])session.server[{tools:'sendToolListChanged',resources:'sendResourceListChanged',prompts:'sendPromptListChanged'}[kind]]().catch(error=>log('','warn',error.message));};
  const notifyChanged=()=>{for(const session of sessions.values())for(const kind of ['tools','resources','prompts'])sendChanged(session,kind);};
  const catalogToken = randomBytes(32).toString('base64url');
  const catalogAuthorization = Buffer.from('Bearer '+catalogToken);
  const forgetCatalog=traces?.protect?.(catalogToken);
  let authenticationRevision = 0;
  const isInternal = (header,catalogOnly,context) => {
    if(!catalogOnly||typeof header!=='string')return false;
    const supplied=Buffer.from(header);
    const expected=context?.authorization??catalogAuthorization;
    return supplied.length===expected.length&&timingSafeEqual(supplied,expected);
  };
  const accepts = (header,internal) => {
    if(internal||!authentication)return true;
    try{return authentication.accepts(header)===true;}catch{return false;}
  };
  const publicUnavailable=(internal,res)=>{if(internal||isPublicOpen())return false;res.writeHead(503);res.end('Gateway protections are changing; retry shortly');return true;};
  const unauthorized = res => {res.writeHead(401,{'Content-Type':'application/json','WWW-Authenticate':'Bearer realm="Harbor"','Cache-Control':'no-store'});res.end(JSON.stringify({error:'Unauthorized'}));};
  const catalogPath=`${mcpPath}/_harbor_catalog`;
  let router;
  let closing = false;
  const formatHost = urlHost;
  const addresses = () => Object.values(networkInterfaces()).flat().filter(i => !i.internal && !i.address.startsWith('fe80:') && !i.address.includes('%') && (formatHost(host) === '[::]' || (host === '0.0.0.0' && i.family === 'IPv4') || formatHost(i.address) === formatHost(host))).map(i => i.address);
  const http = createServer((req, res) => {
    handle(req, res).catch(error => {
      log('', 'error', `Gateway request: ${error.message}`);
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: 'Invalid MCP request' }));
    });
  });
  async function handle(req, res) {
    if (closing || !http.listening || !isOpen()) { res.writeHead(503); res.end('Gateway unavailable'); return; }
    const authorities = new Set(['127.0.0.1', 'localhost', '[::1]', ...(!['0.0.0.0', '[::]'].includes(formatHost(host)) ? [formatHost(host)] : []), ...(networkEnabled ? [...addresses().map(formatHost), hostname().toLowerCase()] : [])].flatMap(h => port === 80 ? [h, `${h}:80`] : [`${h}:${port}`]));
    const authority = req.headers.host?.toLowerCase();
    let allowed = typeof authority === 'string' && authorities.has(authority);
    if (req.headers.origin !== undefined) {
      try {
        const origin = new URL(req.headers.origin);
        allowed &&= allowedOrigins.includes(req.headers.origin) || (origin.protocol === 'http:' && authorities.has(origin.host.toLowerCase()) && req.headers.origin === origin.origin);
      } catch { allowed = false; }
    }
    if (!allowed) { res.writeHead(403); res.end('Allowed Host and Origin required'); return; }
    const scopedCatalog=profileContexts?.privateContext(req.url);
    const prefix=mcpPath+'/profiles/';
    const profileId=req.url.startsWith(prefix)?req.url.slice(prefix.length):undefined;
    let validProfile=false;
    if(profileId&&/^[a-z][a-z0-9-]{0,39}$/.test(profileId))try{profiles?.get(profileId);validProfile=!!profiles;}catch{}
    if (req.url !== mcpPath && req.url !== catalogPath && !scopedCatalog && !validProfile) { res.writeHead(404); res.end(); return; }
    const catalogOnly=req.url===catalogPath||!!scopedCatalog;
    if (req.headers.origin !== undefined) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version');
    }
    if (req.method === 'OPTIONS') {
      const methods = ['GET', 'POST', 'DELETE'];
      const headers = ['accept', 'authorization', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
      const requested = req.headers['access-control-request-headers']?.toLowerCase().split(',').map(h => h.trim()) ?? [];
      if (!req.headers.origin || !methods.includes(req.headers['access-control-request-method']) || requested.some(h => !headers.includes(h))) { res.writeHead(403); res.end(); return; }
      res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
      res.setHeader('Access-Control-Allow-Headers', headers.join(', '));
      res.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
      res.writeHead(204); res.end(); return;
    }
    const internal = isInternal(req.headers.authorization,catalogOnly,scopedCatalog);
    if(scopedCatalog&&!internal){unauthorized(res);return;}
    if(publicUnavailable(internal,res))return;
    const requestRevision = authenticationRevision;
    if(!accepts(req.headers.authorization,internal)){unauthorized(res);return;}
    let body;
    if (req.method === 'POST') {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
      if(!accepts(req.headers.authorization,internal)||(!internal&&requestRevision!==authenticationRevision)){unauthorized(res);return;}
      if(publicUnavailable(internal,res))return;
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
    if (closing || !http.listening || !isOpen()) { res.writeHead(503); res.end('Gateway unavailable'); return; }
    // Credentials can change while a POST body is still arriving.
    if(!accepts(req.headers.authorization,internal)||(!internal&&requestRevision!==authenticationRevision)){unauthorized(res);return;}
    const id = req.headers['mcp-session-id'];
    let session = sessions.get(id), created = false;
    if (!session && !id && req.method === 'POST' && isInitializeRequest(body)) {
      const count=[...liveSessions].filter(value=>value.internal===internal).length;
      if(count+initializing>=(internal?512:maxSessions)){res.writeHead(429);res.end('Session capacity reached');return;}
      initializing++;
      const ownerId=randomUUID(),disconnected=new AbortController();
      const initialization={controller:disconnected,internal,profileId};initializations.add(initialization);
      const cancelInitialization=()=>{if(!res.writableEnded)disconnected.abort(new Error('Client disconnected during initialization'));};
      res.once('close',cancelInitialization);
      let scope=scopedCatalog;
      try {
        if(validProfile)scope=await withAbortSignals([initializationLifetime.signal,disconnected.signal],signal=>profileContexts.acquire(profileId,ownerId,{signal}));
        if(closing||disconnected.signal.aborted||!isOpen()||(!internal&&(!isPublicOpen()||requestRevision!==authenticationRevision))) {
          if(validProfile)await profileContexts.release(scope,ownerId);
          res.writeHead(503);res.end('Gateway unavailable');return;
        }
      const instructions=scope?.profile.isolation==='process'?gatewayInstructions.replace('Clients share each upstream process and its mutable state.','This session owns separate native upstream processes. Configured files, credentials and external services can still be shared.'):gatewayInstructions;
      const enabled=kind=>!scope||scope.profile.capabilities.includes(kind);
      const primitives=(scope?.runtime.upstreams??upstreams).mcp;
      const capabilities={...(enabled('tools')?{tools:{listChanged:true}}:{}),...(!catalogOnly&&primitives&&enabled('resources')?{resources:{listChanged:true,subscribe:true}}:{}),...(!catalogOnly&&primitives&&enabled('prompts')?{prompts:{listChanged:true}}:{})};
      const server = new Server({ name: 'mcp-harbor', version: '0.2.0' }, { capabilities, instructions });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: async sessionId => {
        if(session.revoked||(!internal&&(!isPublicOpen()||requestRevision!==authenticationRevision))){await server.close();return;}
        sessions.set(sessionId,session);
      } });
      const sessionLifetime=new AbortController();
      const protocolVersion=SUPPORTED_PROTOCOL_VERSIONS.includes(body.params.protocolVersion)?body.params.protocolVersion:LATEST_PROTOCOL_VERSION;
      session = { server, transport, capabilities, protocolVersion, info: undefined, catalogOnly, internal, revoked:false,scope,ownerId,route:req.url,lastActivity:Date.now(),pending:0 };liveSessions.add(session);created=true;
      server.oninitialized = () => {
        const info = server.getClientVersion();
        session.info = { id: transport.sessionId, name: info?.name ?? 'Unknown client', version: info?.version ?? '', connectedAt: new Date().toISOString(),profileId:scope?.profile.id??'default',profileRevision:scope?.profile.revision??0,isolation:scope?.profile.isolation??'shared' };
      };
      server.onclose = () => {
        sessionLifetime.abort(new Error('Client session closed'));session.unlisten?.();
        if(primitives)cleanup(primitives.release(ownerId));
        sessions.delete(transport.sessionId);liveSessions.delete(session);
        (internal?internalQueue:publicQueue).cancelSession(ownerId);
        if(validProfile)cleanup(profileContexts.release(scope,ownerId));
      };
      server.onerror = error => log('', 'error', `Client session: ${error.message}`);
      const checkDispatch=()=>{if(closing||!isOpen()||session.revoked||scope?.retiring||(!internal&&!isPublicOpen()))throw new McpError(ErrorCode.InternalError,'Gateway unavailable');};
      const currentSettings=()=>scope?.settings??{...deliverySettings,toolMode,toolTimeoutMs};
      const currentUpstreams=()=>scope?.runtime.upstreams??upstreams;
      const traceContext=()=>{const current=currentSettings();return {sessionId:transport.sessionId,clientName:session.info?.name,clientVersion:session.info?.version,profileId:scope?.profile.id??'default',profileRevision:scope?.profile.revision??0,deliveryMode:catalogOnly?'all':current.toolMode,delivery:{mode:catalogOnly?'all':current.toolMode,hybridModes:current.hybridModes,searchLimit:current.searchLimit,semanticMinScore:current.semanticMinScore,localModel:current.portkeyLocalModel,apiModel:current.portkeyApiModel,workersModel:current.portkeyWorkersModel},internal,association:'unknown'};};
      const dispatch=(metadata,operation,options)=>trace({...traceContext(),...metadata},async()=>{
        session.pending++;session.lastActivity=Date.now();
        try{return compatibleResult(metadata.kind,await (internal?internalQueue:publicQueue).run(ownerId,()=>{checkDispatch();return operation();},options),session.protocolVersion);}
        finally{session.pending--;session.lastActivity=Date.now();}
      },options);
      const withRequestOptions=(request,extra,operation)=>withAbortSignals([extra.signal,sessionLifetime.signal],signal=>operation({timeout:currentSettings().toolTimeoutMs,signal,...(request.params?._meta?.progressToken!==undefined?{onprogress:progress=>{
        if(!sessionLifetime.signal.aborted&&!extra.signal.aborted&&!session.revoked)extra.sendNotification({method:'notifications/progress',params:{...progress,progressToken:request.params._meta.progressToken}}).catch(()=>{});
      }}:{})}));
      server.fallbackRequestHandler=async request=>{
        if(request.method==='tools/list'&&!capabilities.tools)return {tools:[]};
        if(request.method.startsWith('tools/')&&!capabilities.tools)throw new McpError(ErrorCode.InvalidParams,'Tools are disabled in this profile');
        throw new McpError(ErrorCode.MethodNotFound,`Harbor does not expose ${request.method} in this session; inspect its negotiated capabilities`);
      };
      if(capabilities.tools)server.setRequestHandler(ListToolsRequestSchema, async (request,extra) => dispatch({kind:'tools/list'},async()=>{
        if(scope&&!scope.profile.capabilities.includes('tools'))return {tools:[]};
        return catalogOnly||currentSettings().toolMode==='all'?{tools:currentUpstreams().tools().map(({serverId,originalName,...tool})=>tool)}:(scope?.router??router).list(request.params);
      },{signal:extra.signal}));
      if(capabilities.tools)server.setRequestHandler(CallToolRequestSchema, (request, extra) => withRequestOptions(request,extra,options=>
        dispatch({kind:'tools/call',tool:request.params.name},async()=>{
          if(scope&&!scope.profile.capabilities.includes('tools'))throw new McpError(ErrorCode.InvalidParams,'Tools are disabled in this profile');
          if(!catalogOnly&&currentSettings().toolMode!=='all')return (scope?.router??router).call(request.params,options);
          return callRaw(request.params,options,scope);
        },{payload:request.params.arguments,signal:options.signal})
      ));
      for(const [schema,kind,field] of [[ListResourcesRequestSchema,'resources','resources'],[ListResourceTemplatesRequestSchema,'templates','resources'],[ListPromptsRequestSchema,'prompts','prompts']])if(capabilities[field])server.setRequestHandler(schema,(request,extra)=>withRequestOptions(request,extra,options=>
        dispatch({kind:request.method},()=>{
          if(request.params?.cursor!==undefined)throw new McpError(ErrorCode.InvalidParams,'Harbor returns a bounded combined catalog without cursors; refresh without a cursor');
          return primitives.list(kind,options);
        },{signal:options.signal})
      ));
      for(const [schema,kind] of [[ReadResourceRequestSchema,'read'],[GetPromptRequestSchema,'prompt'],[SubscribeRequestSchema,'subscribe'],[UnsubscribeRequestSchema,'unsubscribe']])if(capabilities[kind==='prompt'?'prompts':'resources'])server.setRequestHandler(schema,(request,extra)=>withRequestOptions(request,extra,options=>
        dispatch({kind:request.method},async()=>{
          const {serverId,value}=parseReference(kind==='prompt'?request.params.name:request.params.uri,kind==='prompt'?'prompt':'resource');
          if(kind==='read')return primitives.read(serverId,value,options);
          if(kind==='prompt')return primitives.prompt(serverId,value,request.params.arguments,options);
          if(kind==='unsubscribe')return primitives.unsubscribe(serverId,value,ownerId);
          return primitives.subscribe(serverId,value,ownerId,uri=>{if(!session.revoked&&!sessionLifetime.signal.aborted)server.sendResourceUpdated({uri}).catch(()=>{});},options);
        },{signal:options.signal})
      ));
      if(!catalogOnly&&primitives)session.unlisten=primitives.listen(event=>{
        if(event.kind==='reset'){sendChanged(session,'resources');sendChanged(session,'prompts');}
        else if(event.kind==='resources'||event.kind==='prompts')sendChanged(session,event.kind);
      });
      try{await server.connect(transport);}catch(error){liveSessions.delete(session);await server.close().catch(()=>{});throw error;}
      if (closing || !http.listening || !isOpen()) { await server.close(); res.writeHead(503); res.end(); return; }
      } catch(error) {if(validProfile&&scope)await profileContexts.release(scope,ownerId);throw error;}
      finally {initializing--;initializations.delete(initialization);res.off('close',cancelInitialization);}
    }
    if (!session || session.route!==req.url || session.catalogOnly!==catalogOnly || session.internal!==internal || session.revoked) { res.writeHead(id ? 404 : 400); res.end(JSON.stringify({ error: 'Invalid or missing MCP session' })); return; }
    if(!created&&req.headers['mcp-protocol-version']!==undefined&&req.headers['mcp-protocol-version']!==session.protocolVersion){res.writeHead(400);res.end('MCP-Protocol-Version must match this session negotiation');return;}
    if(!accepts(req.headers.authorization,internal)||(!internal&&requestRevision!==authenticationRevision)){
      if(created)await session.server.close();unauthorized(res);return;
    }
    if(publicUnavailable(internal,res)){if(created)await session.server.close();return;}
    session.lastActivity=Date.now();
    try{await session.transport.handleRequest(req, res, body);}
    finally{if(created&&!session.transport.sessionId)await session.server.close();}
  }
  async function callRaw(params,options={},scope){
        const view=scope?.runtime.upstreams??upstreams;
        const tool = view.tools().find(t => t.name === params.name);
        if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
        const e = view.get(tool.serverId);
        if (!view.invoke&&(!e.client || e.status !== 'running')) throw new McpError(ErrorCode.InternalError, 'Upstream not available');
        try {
          const result=await trace({kind:'upstream',tool:tool.originalName,serverId:tool.serverId},()=>view.invoke?view.invoke(tool,params.arguments??{},{timeout:scope?.settings.toolTimeoutMs??toolTimeoutMs,...options}):e.client.callTool({ name: tool.originalName, arguments: params.arguments ?? {} }, undefined, { timeout: scope?.settings.toolTimeoutMs??toolTimeoutMs, ...options }),{payload:params.arguments,signal:options.signal});
          return mapToolResult(tool.serverId,result);
        } catch (error) {
          log(tool.serverId, 'error', `Tool ${tool.originalName}: ${error.message}`);
          const wrapped=new McpError(ErrorCode.InternalError, `Upstream tool call failed: ${error.message}`);
          wrapped.harborOutcome=traceOutcome(error,options.signal,'upstream');throw wrapped;
        }
  }
  async function resume() {
    await new Promise((resolve, reject) => {
      const failed = error => { http.off('listening', ready); reject(error); };
      const ready = () => { http.off('error', failed); resolve(); };
      http.once('error', failed); http.once('listening', ready); http.listen(port, host);
    });
    port = http.address().port;
  }
  async function pause() { await new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }); }
  await resume();
  const localHost = host === '0.0.0.0' ? '127.0.0.1' : formatHost(host) === '[::]' ? '::1' : host;
  const endpoint = `http://${formatHost(localHost)}:${port}${mcpPath}`;
  router=createToolDelivery({catalogToken,endpoint:`${endpoint}/_harbor_catalog`,log,traces,tools:()=>upstreams.tools(),callRaw,settings:{...deliverySettings,toolMode},retainCredentials});
  profileContexts=createProfileContexts({profiles,shared:upstreams,endpoint:()=>endpoint,settings:()=>({...deliverySettings,toolMode,toolTimeoutMs}),log,traces,changed:notifyChanged,callRaw,retainCredentials,
    closeInternal:context=>Promise.all([...liveSessions].filter(session=>session.scope===context&&session.internal).map(session=>session.server.close().catch(()=>{})))});
  const expiry=setInterval(()=>{
    const now=Date.now();
    for(const session of liveSessions)if(!session.internal&&!session.pending&&now-session.lastActivity>(session.scope?.profile.sessionIdleMinutes?session.scope.profile.sessionIdleMinutes*60000:sessionIdleMs)){
      session.revoked=true;cleanup(session.server.close());
    }
  },sessionSweepMs);expiry.unref();
  async function revokeSelected(predicate){
    const revoked=[...liveSessions].filter(predicate);
    for(const session of revoked){session.revoked=true;sessions.delete(session.transport.sessionId);}
    await Promise.all(revoked.map(session=>session.server.close().catch(()=>log('','warn','A revoked client session did not close cleanly'))));
    await Promise.allSettled([...cleanupTasks]);await profileContexts.drain();
  }
  return {
    endpoint,
    port,
    get endpoints() { return { local: endpoint, network: networkEnabled ? [...new Set(addresses())].map(address => `http://${formatHost(address)}:${port}${mcpPath}`) : [], bindAddress: host }; },
    pause, resume,
    async revokePublicSessions(){
      authenticationRevision++;
      for(const pending of initializations)if(!pending.internal)pending.controller.abort(new Error('Gateway credentials changed during initialization'));
      await revokeSelected(session=>!session.internal);
    },
    revokeProfileSessions:async id=>{for(const pending of initializations)if(pending.profileId===id)pending.controller.abort(new Error('Profile disconnected during initialization'));await revokeSelected(session=>!session.internal&&session.scope?.profile.id===id);},
    profileRuntimes:()=>profileContexts.snapshot(),
    admission:()=>({public:publicQueue.snapshot(),internal:internalQueue.snapshot(),sessions:liveSessions.size,initializing,maxSessions}),
    suspendDelivery:async()=>{for(const pending of initializations)if(pending.profileId)pending.controller.abort(new Error('Profile suspended during initialization'));await revokeSelected(session=>!session.internal&&!!session.scope);await router.suspend();await profileContexts.suspend();},
    prepareMode:mode=>router.prepare(mode),
    configure(settings) { Object.assign(deliverySettings,settings);toolMode=settings.toolMode;router.configure(settings);toolTimeoutMs = settings.toolTimeoutMs; allowedOrigins = [...settings.allowedOrigins]; networkEnabled = settings.networkEnabled;for(const s of sessions.values())if(!s.catalogOnly)sendChanged(s,'tools'); },
    clients: () => [...sessions.values()].flatMap(s => s.info&&!s.catalogOnly ? [s.info] : []),
    changed:notifyChanged,
    async close() {
      closing = true;
      clearInterval(expiry);initializationLifetime.abort(new Error('Gateway closing'));
      await Promise.all([...liveSessions].map(s => s.server.close().catch(() => {})));
      await Promise.all([router.close(),profileContexts.close()]);
      await Promise.all([publicQueue.close(),internalQueue.close()]);
      await Promise.allSettled([...cleanupTasks]);forgetCatalog?.();
      sessions.clear();liveSessions.clear();
      await pause();
    }
  };
}
