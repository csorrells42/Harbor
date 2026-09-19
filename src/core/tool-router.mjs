import path from 'node:path';
import {access} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {portableEnvironment} from './portable.mjs';

export function createToolRouter({endpoint,catalogToken,log}) {
  const workers=new Map();
  const active=new Map();let selected=[];
  let closed=false;
  async function worker(mode) {
    if(closed)throw new Error('Tool discovery is closed');
    const [kind,limit='5']=mode.split(':');
    if(!['bm25','regex','code'].includes(kind))throw new Error('Unknown tool discovery mode');
    if(workers.has(mode))return workers.get(mode);
    const pending=(async()=>{
      const root=process.env.HARBOR_TOOL_RUNTIME_ROOT||process.env.HARBOR_PORTABLE_ROOT;
      if(!root)throw new Error('FastMCP needs the bundled Harbor Portable runtime.');
      const command=path.join(root,'runtimes/python/python.exe'),script=path.join(root,'support/fastmcp-gateway.py');
      const site=path.join(process.env.HARBOR_FASTMCP_PACKAGE||path.join(root,'packages/fastmcp-tools'),'python');
      await access(script);await access(path.join(site,'fastmcp'));
      const client=new Client({name:'Harbor tool discovery',version:'1'});
      const env={...portableEnvironment(root,process.env),PYTHONPATH:[path.join(root,'support/python-site'),site].join(path.delimiter),MONTY_BIN:path.join(site,'bin/monty.exe'),FASTMCP_CHECK_FOR_UPDATES:'off',DO_NOT_TRACK:'1',HARBOR_CATALOG_TOKEN:catalogToken??''};
      const transport=new StdioClientTransport({command,args:[script,endpoint,kind,limit],cwd:path.join(root,'data/workspace'),env,stderr:'pipe'});
      transport.stderr?.on('data',data=>log('','debug',`FastMCP: ${(catalogToken?data.toString().replaceAll(catalogToken,'[redacted]'):data.toString()).slice(-2000)}`));
      try {await client.connect(transport,{timeout:60000});}
      catch(error){await client.close().catch(()=>{});throw new Error(`FastMCP ${mode} could not start: ${error.message}`);}
      client.onclose=()=>{if(workers.get(mode)===pending)workers.delete(mode);};
      if(closed){await client.close();throw new Error('Tool discovery is closed');}
      return client;
    })();
    workers.set(mode,pending);
    try{return await pending;}catch(error){if(workers.get(mode)===pending)workers.delete(mode);throw error;}
  }
  function retire(){for(const [mode,pending] of workers)if(!selected.includes(mode)&&!active.get(mode))void pending.then(async client=>{if(!selected.includes(mode)&&!active.get(mode)&&workers.get(mode)===pending){workers.delete(mode);await client.close();}}).catch(()=>{});}
  async function use(mode,fn){active.set(mode,(active.get(mode)||0)+1);try{return await fn(await worker(mode));}finally{active.set(mode,active.get(mode)-1);retire();}}
  return {
    select(modes){selected=modes;retire();},
    prepare:async mode=>{if(mode!=='all')await worker(mode);},
    list:(mode,params)=>use(mode,client=>client.listTools(params,{timeout:60000})),
    call:(mode,params,options)=>use(mode,client=>client.callTool(params,undefined,options)),
    async close(){closed=true;await Promise.all([...workers.values()].map(async p=>{try{await (await p).close();}catch{}}));workers.clear();}
  };
}
