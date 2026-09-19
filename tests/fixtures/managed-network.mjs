import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const app = express(); app.use(express.json());
const sessions = new Map();
const eventStreams=new Set();
let unavailable=false;
app.post('/drop-events',(req,res)=>{unavailable=req.query.unavailable==='1';for(const stream of eventStreams)stream.destroy();res.json({dropped:true});});
function sdk() {
  const server = new Server({name:'owned-fixture',version:'1.0.0'}, {capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema, async()=>{await new Promise(r=>setTimeout(r,Number(process.env.LIST_DELAY??0)));return {tools:[{name:'echo',inputSchema:{type:'object'}}]};});
  server.setRequestHandler(CallToolRequestSchema, async request=>({content:[{type:'text',text:JSON.stringify({pid:process.pid,argv:process.argv.slice(2),env:process.env.OWNED_VALUE,text:request.params.arguments?.text})}]}));
  return server;
}
app.all('/mcp', async(req,res)=>{
  if(unavailable){res.status(503).end();return;}
  if(req.method==='GET'){eventStreams.add(res);res.once('close',()=>eventStreams.delete(res));}
  const id=req.headers['mcp-session-id']; let transport=sessions.get(id);
  if(!transport) {transport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>crypto.randomUUID(),onsessioninitialized:id=>sessions.set(id,transport)});await sdk().connect(transport);}
  await transport.handleRequest(req,res,req.body);
});
app.get('/sse', async(req,res)=>{const transport=new SSEServerTransport('/messages',res);sessions.set(transport.sessionId,transport);await sdk().connect(transport);});
app.post('/messages', async(req,res)=>{await sessions.get(req.query.sessionId)?.handlePostMessage(req,res,req.body);});
if(process.env.TREE_FILE){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:process.env.DETACHED_CHILD==='1'});writeFileSync(process.env.TREE_FILE,JSON.stringify({pid:process.pid,child:child.pid}));}
if(process.env.PID_FILE)writeFileSync(process.env.PID_FILE,String(process.pid));
if(process.env.EXIT_AFTER)setTimeout(()=>process.exit(17),Number(process.env.EXIT_AFTER));
if(process.env.ROLE==='companion')setInterval(()=>{},1000);
else {await new Promise(r=>setTimeout(r,Number(process.env.DELAY??400)));app.listen(Number(process.env.PORT),'127.0.0.1');}
