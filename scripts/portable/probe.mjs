import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=process.env.HARBOR_PORTABLE_ROOT||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {portableEnvironment}=await import(pathToFileURL(path.join(root,'support/portable.mjs')).href);
const environment=portableEnvironment(root,{...process.env,HARBOR_PORTABLE_ROOT:root});
const require=createRequire(path.join(root,'packages/general-local/package.json'));
const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
const configs=JSON.parse(await fs.readFile(path.join(root,'catalog.json'),'utf8')).servers;
const id=process.argv[2],stage=process.argv[3],group=process.argv[4];
const selected=configs.filter(c=>c.id===id||(id==='general-local'&&['memory','filesystem','sequential-thinking','desktop-commander'].includes(c.id))||(id==='browser-docs'&&['playwright','context7'].includes(c.id)));
if(!selected.length)throw new Error(`No probe for ${id}`);
const expand=v=>{
  if(typeof v==='string'){
    if(stage&&group)v=v.replaceAll('${HARBOR_ROOT}/packages/'+group,stage.replaceAll('\\','/'));
    return v.replaceAll('${HARBOR_ROOT}',root.replaceAll('\\','/'));
  }
  if(Array.isArray(v))return v.map(expand);
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,value])=>[k,expand(value)]));return v;
};
for(const saved of selected){
  const c=expand(saved);if(c.transport!=='stdio')throw new Error('This probe supports bundled stdio servers');
  if(stage&&group==='general-local'&&c.id==='filesystem')c.args=[path.join(stage,'node_modules/@modelcontextprotocol/server-filesystem/dist/index.js'),path.join(root,'data/workspace')];
  if(stage&&group==='github'&&c.id==='github')c.env.HARBOR_GITHUB_SERVER=path.join(stage,'github-mcp-server.exe');
  const client=new Client({name:'Harbor Portable component acceptance',version:'1'});
  const transport=new StdioClientTransport({command:c.command,args:c.args,cwd:c.cwd,env:{...environment,...c.env},stderr:'pipe'});
  let errors='';transport.stderr.on('data',chunk=>{errors=(errors+chunk.toString()).slice(-6000);});
  try{await client.connect(transport,{timeout:60000});const listed=await client.listTools();if(!listed.tools.length)throw new Error('No tools discovered');console.log(`${c.id}: ${listed.tools.length} tools`);}
  catch(error){throw new Error(`${c.id}: ${error.message}\n${errors}`);}
  finally{await client.close();}
}
