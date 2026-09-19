import { createServer } from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces, hostname } from 'node:os';
import { urlHost } from './settings.mjs';
import {createToolDelivery} from './tool-delivery.mjs';
const gatewayInstructions = 'Tools are namespaced by server. Clients share each upstream process and its mutable state. When discovery tools are advertised, search for relevant tools and obtain their schemas before invoking them. Code Mode uses Python to compose existing tool calls.';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, isInitializeRequest, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export async function createGateway({ host, port, upstreams, log, toolTimeoutMs, toolMode='all', mcpPath = '/mcp', networkEnabled = false, allowedOrigins = [], isOpen = () => true, authentication, ...deliverySettings }) {
  const sessions = new Map(), liveSessions = new Set();
  const catalogToken = randomBytes(32).toString('base64url');
  const catalogAuthorization = Buffer.from('Bearer '+catalogToken);
  let authenticationRevision = 0;
  const isInternal = (header,catalogOnly) => {
    if(!catalogOnly||typeof header!=='string')return false;
    const supplied=Buffer.from(header);
    return supplied.length===catalogAuthorization.length&&timingSafeEqual(supplied,catalogAuthorization);
  };
  const accepts = (header,internal) => {
    if(internal||!authentication)return true;
    try{return authentication.accepts(header)===true;}catch{return false;}
  };
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
    if (req.url !== mcpPath && req.url !== catalogPath) { res.writeHead(404); res.end(); return; }
    const catalogOnly=req.url===catalogPath;
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
    const internal = isInternal(req.headers.authorization,catalogOnly);
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
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
    if (closing || !http.listening || !isOpen()) { res.writeHead(503); res.end('Gateway unavailable'); return; }
    // Credentials can change while a POST body is still arriving.
    if(!accepts(req.headers.authorization,internal)||(!internal&&requestRevision!==authenticationRevision)){unauthorized(res);return;}
    const id = req.headers['mcp-session-id'];
    let session = sessions.get(id), created = false;
    if (!session && !id && req.method === 'POST' && isInitializeRequest(body)) {
      const server = new Server({ name: 'mcp-harbor', version: '0.2.0' }, { capabilities: { tools: { listChanged: true } }, instructions: gatewayInstructions });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: async sessionId => {
        if(session.revoked||(!internal&&requestRevision!==authenticationRevision)){await server.close();return;}
        sessions.set(sessionId,session);
      } });
      session = { server, transport, info: undefined, catalogOnly, internal, revoked:false };liveSessions.add(session);created=true;
      server.oninitialized = () => {
        const info = server.getClientVersion();
        session.info = { id: transport.sessionId, name: info?.name ?? 'Unknown client', version: info?.version ?? '', connectedAt: new Date().toISOString() };
      };
      server.onclose = () => {sessions.delete(transport.sessionId);liveSessions.delete(session);};
      server.onerror = error => log('', 'error', `Client session: ${error.message}`);
      server.setRequestHandler(ListToolsRequestSchema, async request => catalogOnly||toolMode==='all' ? ({ tools: upstreams.tools().map(({ serverId, originalName, ...tool }) => tool) }) : router.list(request.params));
      server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        if(!catalogOnly&&toolMode!=='all')return router.call(request.params,{timeout:toolTimeoutMs,signal:extra.signal});
        return callRaw(request.params,{signal:extra.signal});
      });
      try{await server.connect(transport);}catch(error){liveSessions.delete(session);await server.close().catch(()=>{});throw error;}
      if (closing || !http.listening || !isOpen()) { await server.close(); res.writeHead(503); res.end(); return; }
    }
    if (!session || session.catalogOnly!==catalogOnly || session.internal!==internal || session.revoked) { res.writeHead(id ? 404 : 400); res.end(JSON.stringify({ error: 'Invalid or missing MCP session' })); return; }
    if(!accepts(req.headers.authorization,internal)||(!internal&&requestRevision!==authenticationRevision)){
      if(created)await session.server.close();unauthorized(res);return;
    }
    try{await session.transport.handleRequest(req, res, body);}
    finally{if(created&&!session.transport.sessionId)await session.server.close();}
  }
  async function callRaw(params,options={}){
        const tool = upstreams.tools().find(t => t.name === params.name);
        if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
        const e = upstreams.get(tool.serverId);
        if (!e.client || e.status !== 'running') throw new McpError(ErrorCode.InternalError, 'Upstream not available');
        try {
          return await e.client.callTool({ name: tool.originalName, arguments: params.arguments ?? {} }, undefined, { timeout: toolTimeoutMs, signal: options.signal });
        } catch (error) {
          log(tool.serverId, 'error', `Tool ${tool.originalName}: ${error.message}`);
          throw new McpError(ErrorCode.InternalError, `Upstream tool call failed: ${error.message}`);
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
  router=createToolDelivery({catalogToken,endpoint:`${endpoint}/_harbor_catalog`,log,tools:()=>upstreams.tools(),callRaw,settings:{...deliverySettings,toolMode}});
  return {
    endpoint,
    port,
    get endpoints() { return { local: endpoint, network: networkEnabled ? [...new Set(addresses())].map(address => `http://${formatHost(address)}:${port}${mcpPath}`) : [], bindAddress: host }; },
    pause, resume,
    async revokePublicSessions(){
      authenticationRevision++;
      const revoked=[...liveSessions].filter(s=>!s.internal);
      for(const session of revoked){session.revoked=true;sessions.delete(session.transport.sessionId);}
      await Promise.all(revoked.map(s=>s.server.close().catch(()=>log('','warn','A revoked client session did not close cleanly'))));
    },
    suspendDelivery:()=>router.suspend(),
    prepareMode:mode=>router.prepare(mode),
    configure(settings) { const changed=true;toolMode=settings.toolMode;router.configure(settings);toolTimeoutMs = settings.toolTimeoutMs; allowedOrigins = [...settings.allowedOrigins]; networkEnabled = settings.networkEnabled;if(changed)for(const s of sessions.values())if(!s.catalogOnly)s.server.sendToolListChanged().catch(error=>log('','warn',error.message)); },
    clients: () => [...sessions.values()].flatMap(s => s.info&&!s.catalogOnly ? [s.info] : []),
    changed() { for (const s of sessions.values()) s.server.sendToolListChanged().catch(error => log('', 'warn', error.message)); },
    async close() {
      closing = true;
      await router.close();
      await Promise.all([...liveSessions].map(s => s.server.close().catch(() => {})));
      sessions.clear();liveSessions.clear();
      await pause();
    }
  };
}
