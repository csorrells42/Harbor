import path from 'node:path';
import {spawn} from 'node:child_process';
const [root,id,stage]=process.argv.slice(2),node=path.join(root,'runtimes/node/node.exe'),uv=path.join(root,'runtimes/uv/uv.exe'),python=path.join(root,'runtimes/python/python.exe'),npm=path.join(root,'runtimes/node/node_modules/npm/bin/npm-cli.js');
const run=(command,args)=>new Promise((resolve,reject)=>{const child=spawn(command,args,{cwd:stage,windowsHide:true,stdio:'inherit',env:{...process.env,PATH:path.join(root,'runtimes/node')+path.delimiter+process.env.PATH}});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`Build failed: ${code}`)));});
if(id==='fastmcp-lock')await run(uv,['pip','compile','--python',python,'--upgrade','requirements.in','--output-file','requirements.txt']);
else if(id==='fastmcp-tools')await run(uv,['pip','install','--python',python,'--target',path.join(stage,'python'),'-r','requirements.txt','--no-cache']);
else if(id==='portkey-tools'){
  await run(node,[npm,'ci','--no-audit','--no-fund']);
  await run(node,[npm,'run','build']);
  await run(node,[npm,'prune','--omit=dev','--ignore-scripts','--no-audit','--no-fund']);
}else throw new Error('Unknown tool delivery component');
