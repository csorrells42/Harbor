import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=path.resolve(process.argv[2]);
const catalog=JSON.parse(await fs.readFile(path.join(root,'catalog.json'),'utf8'));
const manifest=JSON.parse(await fs.readFile(path.join(root,'maintenance.json'),'utf8'));
const groups=[];
async function size(dir){let bytes=0,files=0;for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory()){const s=await size(file);bytes+=s.bytes;files+=s.files;}else{bytes+=(await fs.stat(file)).size;files++;}}return {bytes,files};}
for(const name of ['application','runtimes','packages','data','support'])groups.push({name,...await size(path.join(root,name))});
const components=[];
for(const c of manifest.components){
  let revision;try{revision=execFileSync(path.join(root,'runtimes/git/cmd/git.exe'),['-C',path.join(root,c.path),'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore']}).trim();}catch{}
  const packageInfo=await fs.readFile(path.join(root,c.path,'package.json'),'utf8').then(JSON.parse).catch(()=>null);
  components.push({id:c.id,path:c.path,repository:c.repository,revision,package:packageInfo?.name,version:packageInfo?.version,dependencies:packageInfo?.dependencies});
}
const report={observedAt:new Date().toISOString(),root,groups,totalBytes:groups.reduce((n,g)=>n+g.bytes,0),serverIds:catalog.servers.map(s=>s.id),components};
await fs.writeFile(path.join(root,'inventory.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({GiB:Math.round(report.totalBytes/1024**3*100)/100,servers:report.serverIds.length,groups}));
