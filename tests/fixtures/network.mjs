import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const sessions = new Map();
function makeServer() {
  const server = new Server({ name: 'real-network-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'network_echo', inputSchema: { type: 'object' } }] }));
  server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: 'text', text: `${request.params.arguments?.text}:${process.pid}` }] }));
  return server;
}
const http = createServer(async (req, res) => {
  try {
    if (req.url === '/hang') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': waiting\n\n'); setTimeout(() => res.end(), 1500).unref(); return; }
    if (req.url === '/sse' && req.method === 'GET') {
      const transport = new SSEServerTransport('/messages', res);
      sessions.set(transport.sessionId, transport);
      const server = makeServer();
      server.onclose = () => sessions.delete(transport.sessionId);
      await server.connect(transport);
      return;
    }
    if (req.url.startsWith('/messages')) {
      const id = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
      const transport = sessions.get(id);
      if (!transport) { res.writeHead(404); res.end(); return; }
      await transport.handlePostMessage(req, res); return;
    }
    if (req.url === '/mcp') {
      if (req.method === 'DELETE' && process.env.HANG_DELETE) { setTimeout(() => { res.writeHead(200); res.end(); }, 1600).unref(); return; }
      let transport = sessions.get(req.headers['mcp-session-id']);
      if (!transport && req.method === 'POST' && !req.headers['mcp-session-id']) {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: id => sessions.set(id, transport) });
        const server = makeServer();
        server.onclose = () => sessions.delete(transport.sessionId);
        await server.connect(transport);
      }
      if (!transport) { res.writeHead(404); res.end(); return; }
      await transport.handleRequest(req, res); return;
    }
    res.writeHead(404); res.end();
  } catch (error) { console.error(error); if (!res.headersSent) res.writeHead(500); res.end(); }
});
http.listen(0, '127.0.0.1', () => process.send?.({ port: http.address().port }));
process.on('message', async message => {
  if (message === 'close') {
    await Promise.all([...sessions.values()].map(t => t.close()));
    http.close(); http.closeAllConnections(); process.exit(0);
  }
});
