import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

// A unique configured MCP is required because LM Studio intentionally rejects
// loopback URLs for ephemeral_mcp. Own only this exact entry, never other MCPs.
export async function registerDiagnosticPlugin({configFile,bridgeFile,gateway,nodeExecutable=process.execPath}){
 const name='harbor-diagnostic-'+randomUUID(),entry={command:nodeExecutable,args:[bridgeFile,gateway],env:{ELECTRON_RUN_AS_NODE:'1',HARBOR_API_KEY:'',HARBOR_API_KEY_FILE:''}};
 async function read(){try{const raw=await readFile(configFile,'utf8');return {raw,data:JSON.parse(raw)};}catch(e){if(e.code==='ENOENT')return {raw:null,data:{mcpServers:{}}};throw e;}}
 async function change(edit){const {raw,data}=await read();if(!data||Array.isArray(data)||typeof data!=='object'||data.mcpServers&&(typeof data.mcpServers!=='object'||Array.isArray(data.mcpServers)))throw new Error('LM Studio MCP configuration is not a supported object');data.mcpServers??={};edit(data.mcpServers);
  const temp=path.join(path.dirname(configFile),`.harbor-${randomUUID()}.tmp`);
  try{await writeFile(temp,JSON.stringify(data,null,2),{flag:'wx'});const current=await read();if(current.raw!==raw)throw new Error('LM Studio MCP configuration changed; retry after editing is finished');await rename(temp,configFile);}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 }
 await change(servers=>{if(Object.hasOwn(servers,name))throw new Error('Diagnostic MCP identifier already exists');servers[name]=entry;});
 let closed=false;return {id:'mcp/'+name,async waitReady({signal,timeoutMs=10000}={}){
  // LM Studio consumes mcp.json asynchronously. Its 0.4.21 synchronization
  // receipt must contain this exact lease before submitting a native chat.
  // A missing/changed receipt is an infrastructure failure, never a model score.
  const receipt=path.join(path.dirname(configFile),'.internal','last-synced-mcp-state.json'),deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
   signal?.throwIfAborted();if(closed)throw new Error('Temporary LM Studio MCP registration is closed');
   try{const state=JSON.parse(await readFile(receipt,'utf8'));if(JSON.stringify(state?.mcpServers?.[name])===JSON.stringify(entry))return;}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
   await delay(Math.min(100,Math.max(1,deadline-Date.now())),undefined,{signal});
  }
  throw new Error('LM Studio has not synchronized the temporary MCP configuration; no native request was submitted. Check LM Studio is running and supports its MCP synchronization receipt.');
 },async close(){if(closed)return;await change(servers=>{if(!Object.hasOwn(servers,name))return;if(JSON.stringify(servers[name])!==JSON.stringify(entry))throw new Error('Diagnostic MCP entry changed externally; it was preserved');delete servers[name];});closed=true;}};
}
