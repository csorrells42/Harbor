import fs from 'node:fs/promises';
import path from 'node:path';
import {officeComponents,officeServer,officeRecipe} from './office-components.mjs';
const root=path.resolve(process.argv[2]),source=process.cwd();
const copy=async(a,b)=>{await fs.mkdir(path.dirname(b),{recursive:true});await fs.cp(a,b,{recursive:true,filter:p=>!['.venv','__pycache__','.pytest_cache'].includes(path.relative(a,p).split(path.sep)[0])});};
if(process.argv.includes('--sources-only')){
  for(const c of officeComponents){await copy(path.join(source,'.harbor-build',c.source),path.join(root,'packages',c.id));await fs.appendFile(path.join(root,'packages',c.id,'.git/info/exclude'),'\n/python/\n');}
}else{
  for(const name of ['catalog.json','data/servers.json']){
    const f=path.join(root,name),value=JSON.parse(await fs.readFile(f));
    for(const c of officeComponents)if(!value.servers.some(s=>s.id===c.id))value.servers.push(officeServer(c));
    await fs.writeFile(f,JSON.stringify(value,null,2)+'\n');
  }
  const file=path.join(root,'maintenance.json'),manifest=JSON.parse(await fs.readFile(file));
  for(const c of officeComponents){manifest.components=manifest.components.filter(e=>e.id!==c.id);manifest.components.push(officeRecipe(c));}
  await fs.writeFile(file,JSON.stringify(manifest,null,2)+'\n');
  for(const f of ['office-components.mjs','verify-office-tools.mjs'])await copy(path.join(source,'scripts/portable',f),path.join(root,'support',f));
  for(const item of ['src','tests','scripts/portable'])await copy(path.join(source,item),path.join(root,'packages/harbor-source',item));
}
console.log('Office tool '+(process.argv.includes('--sources-only')?'sources copied':'configuration installed'));
