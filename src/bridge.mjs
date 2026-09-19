#!/usr/bin/env node
// Standalone stdio → Streamable HTTP bridge. Node 20+; no npm dependencies.
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
let apiKey=process.env.HARBOR_API_KEY;
if(!apiKey&&process.env.HARBOR_API_KEY_FILE){try{apiKey=(await readFile(process.env.HARBOR_API_KEY_FILE,'utf8')).trim();}catch{throw new Error('Could not read the Harbor API key file');}}
if(apiKey&&!/^[-A-Za-z0-9._~+/]+=*$/.test(apiKey))throw new Error('Invalid Harbor API key format');
const endpoint = process.argv[2] || 'http://127.0.0.1:37373/mcp';
const url = new URL(endpoint);
if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Expected an HTTP MCP URL');
let session, protocol, shuttingDown = false, eventController;
const activeControllers = new Set();
const output = message => process.stdout.write(JSON.stringify(message) + '\n');
const validId = id => id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
function validMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') return false;
  const hasId = Object.hasOwn(message, 'id'), hasResult = Object.hasOwn(message, 'result'), hasError = Object.hasOwn(message, 'error');
  if (hasId && !validId(message.id)) return false;
  if (Object.hasOwn(message, 'method')) {
    return typeof message.method === 'string' && !hasResult && !hasError
      && (!Object.hasOwn(message, 'params') || (message.params !== null && typeof message.params === 'object'));
  }
  if (!hasId || hasResult === hasError) return false;
  return hasResult || (message.error !== null && typeof message.error === 'object' && !Array.isArray(message.error)
    && Number.isInteger(message.error.code) && typeof message.error.message === 'string');
}
const headers = () => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(apiKey?{Authorization:'Bearer '+apiKey}:{}), ...(session ? {'mcp-session-id':session} : {}), ...(protocol ? {'mcp-protocol-version':protocol} : {}) });
function accept(message) {
  if (message?.result?.protocolVersion) protocol = message.result.protocolVersion;
  output(message);
}
// Early exits still own the HTTP body. Release it so a rejected or unsupported
// request cannot retain a connection until the bridge process exits.
async function discardResponse(response) {
  try { await response.body?.cancel(); } catch {}
}
async function consume(response) {
  if (response.status === 202 || response.status === 204) { await discardResponse(response); return; }
  if(response.status===401||response.status===403){await discardResponse(response);throw new Error('Harbor authentication failed. Copy a current client configuration from This Server and reconnect.');}
  if (!response.ok) throw new Error(`Hub returned HTTP ${response.status}: ${(await response.text()).slice(0,400)}`);
  session = response.headers.get('mcp-session-id') || session;
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer=''; let data=[];
    function line(value) {
      if (!value) { if(data.length) {accept(JSON.parse(data.join('\n'))); data=[];} }
      else if(value.startsWith('data:')) data.push(value.slice(5).replace(/^ /,''));
    }
    for (;;) {
      const {done,value}=await reader.read(); if(done)break;
      buffer += decoder.decode(value,{stream:true});
      let end; while((end=buffer.indexOf('\n'))!==-1){line(buffer.slice(0,end).replace(/\r$/,''));buffer=buffer.slice(end+1);}
    }
    if(buffer)line(buffer.replace(/\r$/,''));line('');
  } else { const text=await response.text(); if(text.trim())accept(JSON.parse(text)); }
}
async function events() {
  eventController = new AbortController();
  let delay=250;
  while(!shuttingDown) {
    try {
      const response=await fetch(url,{headers:headers(),signal:eventController.signal});
      if(response.status===405 || response.status===404 || response.status===401 || response.status===403) { await discardResponse(response); return; }
      await consume(response);
    } catch(error) {
      if(shuttingDown || error.name==='AbortError')return;
      process.stderr.write(`Harbor notification stream: ${error.message}\n`);
    }
    if(shuttingDown)return;
    await new Promise(resolve=>{const timer=setTimeout(resolve,delay);timer.unref();});
    delay=Math.min(delay*2,10000);
  }
}
async function send(message) {
  const controller=new AbortController();activeControllers.add(controller);
  const timeout=setTimeout(()=>controller.abort(),300000);
  try {
    await consume(await fetch(url,{method:'POST',headers:headers(),body:JSON.stringify(message),signal:controller.signal}));
    if(message.method==='notifications/initialized'&&!eventController)void events();
  } catch(error) {
    if(message.id!==undefined)output({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:`MCP Harbor: ${error.message}. Ensure the desktop hub is running at ${endpoint}.`}});
    else process.stderr.write(`MCP Harbor: ${error.message}\n`);
  } finally {clearTimeout(timeout);activeControllers.delete(controller);}
}
async function close() {
  if(shuttingDown)return;shuttingDown=true;eventController?.abort();
  for(const controller of activeControllers)controller.abort();
  if(session)try{await fetch(url,{method:'DELETE',headers:headers(),signal:AbortSignal.timeout(2000)});}catch{}
  process.exit(0);
}
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',line=>{
  if(!line.trim())return;
  let message;
  try{message=JSON.parse(line);}catch{output({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}});return;}
  if(!validMessage(message)){
    output({jsonrpc:'2.0',id:validId(message?.id)?message.id:null,error:{code:-32600,message:'Invalid JSON-RPC message'}});return;
  }
  void send(message).catch(error=>process.stderr.write(`MCP Harbor: ${error.message}\n`));
});
input.on('close',()=>void close());
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
