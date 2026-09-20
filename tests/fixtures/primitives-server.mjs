import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {SSEServerTransport} from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import {ListResourcesRequestSchema,ListResourceTemplatesRequestSchema,ReadResourceRequestSchema,ListPromptsRequestSchema,GetPromptRequestSchema,SubscribeRequestSchema,UnsubscribeRequestSchema,ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {setTimeout as delay} from 'node:timers/promises';
function createFixture(){
const mode=process.argv[2],resources=mode!=='tools',subscribable=mode!=='no-subscribe';
const state={subscribes:0,unsubscribes:0,cancelled:0,reads:0,prompts:0};let slowSubscribe=false;
const server=new Server({name:'primitives fixture',version:'1'},{capabilities:{tools:{listChanged:true},...(resources?{resources:{listChanged:true,subscribe:subscribable},prompts:{listChanged:true}}:{})}});
const uri='fixture://same/path?q=%25#fragment';
async function work(request,extra){
  const slow=request.params?.uri?.includes('slow')||request.params?.arguments?.slow;
  if(request.params?._meta?.progressToken!==undefined)await extra.sendNotification({method:'notifications/progress',params:{progressToken:request.params._meta.progressToken,progress:1,total:2,message:'fixture started '+(request.params.uri??'tool/prompt')}});
  if(slow)try{await delay(1000,undefined,{signal:extra.signal});}catch{state.cancelled++;throw Error('fixture cancelled');}
  if(request.params?._meta?.progressToken!==undefined)await extra.sendNotification({method:'notifications/progress',params:{progressToken:request.params._meta.progressToken,progress:2,total:2,message:'fixture done'}});
}
server.setRequestHandler(ListToolsRequestSchema,()=>({tools:[{name:'control',inputSchema:{type:'object',properties:{action:{type:'string'}}}}]}));
server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
  const action=request.params.arguments?.action;
  if(action==='notify'){
    await server.sendResourceListChanged();await server.sendPromptListChanged();await server.sendResourceUpdated({uri});
  }
  if(action==='slow-subscribe')slowSubscribe=true;
  if(action==='link')return {content:[{type:'resource_link',name:'link',uri},{type:'resource',resource:{uri,text:'embedded'}}]};
  if(action==='sampling'){try{await server.createMessage({messages:[],maxTokens:1});}catch(error){return {content:[{type:'text',text:error.message}]};}}
  await work(request,extra);
  return {content:[{type:'text',text:JSON.stringify({...state,pid:process.pid,clientCapabilities:server.getClientCapabilities()})}]};
});
if(resources){
  server.setRequestHandler(ListResourcesRequestSchema,request=>mode==='malformed'?{resources:[{uri:42,name:'invalid'}]}:mode==='loop'?{resources:[{uri,name:'same'}],nextCursor:'repeat'}:request.params?.cursor?{resources:[{uri:'fixture://second',name:'second'}]}:{resources:[{uri,name:'same'}],nextCursor:'page2'});
  server.setRequestHandler(ListResourceTemplatesRequestSchema,()=>({resourceTemplates:[{name:'template',uriTemplate:'fixture://items/{+path}{?query}'}]}));
  server.setRequestHandler(ReadResourceRequestSchema,async(request,extra)=>{
    state.reads++;await work(request,extra);
    if(request.params.uri==='fixture://invalid')return {contents:[{uri:99,text:'invalid'}]};
    if(request.params.uri==='fixture://oversize')return {contents:[{uri,text:'x'.repeat(4*1024*1024)}]};
    return {contents:[{uri:request.params.uri,text:JSON.stringify({uri:request.params.uri,pid:process.pid})},{uri:'fixture://related',blob:'aGVsbG8=',mimeType:'text/plain'}]};
  });
  server.setRequestHandler(ListPromptsRequestSchema,()=>({prompts:[{name:'same prompt',description:'Prompt from fixture',arguments:[{name:'slow',required:false}]}]}));
  server.setRequestHandler(GetPromptRequestSchema,async(request,extra)=>{state.prompts++;await work(request,extra);return {description:'same prompt',messages:[{role:'user',content:{type:'resource',resource:{uri,text:'prompt resource'}}},{role:'assistant',content:{type:'text',text:String(process.pid)}}]};});
  server.setRequestHandler(SubscribeRequestSchema,async(request,extra)=>{state.subscribes++;if(slowSubscribe)try{await delay(1000,undefined,{signal:extra.signal});}catch{state.cancelled++;throw Error('subscription cancelled');}return {};});
  server.setRequestHandler(UnsubscribeRequestSchema,()=>{state.unsubscribes++;return {};});
}
return server;
}
if(process.env.PRIMITIVES_PORT){
  const app=express(),sessions=new Map();app.use(express.json());
  app.all('/mcp',async(req,res)=>{
    let transport=sessions.get(req.headers['mcp-session-id']);
    if(!transport){if(req.method!=='POST'||req.body?.method!=='initialize'){res.status(404).end();return;}transport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>crypto.randomUUID(),onsessioninitialized:id=>sessions.set(id,transport)});await createFixture().connect(transport);}
    await transport.handleRequest(req,res,req.body);
  });
  app.get('/sse',async(req,res)=>{const transport=new SSEServerTransport('/messages',res);sessions.set(transport.sessionId,transport);await createFixture().connect(transport);});
  app.post('/messages',async(req,res)=>{const transport=sessions.get(req.query.sessionId);if(!transport){res.status(404).end();return;}await transport.handlePostMessage(req,res,req.body);});
  app.listen(Number(process.env.PRIMITIVES_PORT),'127.0.0.1');
}else await createFixture().connect(new StdioServerTransport());
