import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const require=(condition,message)=>{if(!condition)throw Error(message);};
const safePath=value=>typeof value==='string'&&value.startsWith('node_modules/')&&value.split('/').every(part=>part&&!['.','..'].includes(part)&&!/[\\\x00-\x1f:<>"|?*]/.test(part)&&!/[. ]$/.test(part)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
async function realDirectory(directory){
 const resolved=path.resolve(directory),parent=path.dirname(resolved);if(parent!==resolved)await realDirectory(parent);
 const info=await fs.lstat(resolved);require(info.isDirectory()&&!info.isSymbolicLink(),'Package patch directories cannot contain links');
}
async function regularBytes(file){
 await realDirectory(path.dirname(file));const info=await fs.lstat(file);require(info.isFile()&&!info.isSymbolicLink()&&info.size<=4*1024**2,'Patch input must be a bounded regular file');return fs.readFile(file);
}

export async function applyNpmPatches(directory,group,{manifest}={}){
 require(['general-local','browser-docs','search'].includes(group),'Unknown npm patch group');
 const bytes=manifest?Buffer.from(JSON.stringify(manifest)):await fs.readFile(new URL('./npm-patches.windows-x64.json',import.meta.url));
 const input=JSON.parse(bytes);require(input.schemaVersion===1&&Array.isArray(input.patches)&&input.patches.length<=32,'Invalid npm patch manifest');
 const root=path.resolve(directory);await realDirectory(root);const plans=[],seen=new Set();
 // Validate every selected input and output before modifying any file.
 for(const patch of input.patches){
  require(['general-local','browser-docs','search'].includes(patch.group),'Invalid patch group');
  if(patch.group!==group)continue;
  require(typeof patch.id==='string'&&/^[-a-z0-9]+$/.test(patch.id)&&!seen.has(patch.file),'Invalid or duplicate patch');seen.add(patch.file);
  require(safePath(patch.file)&&safePath(patch.packageJson)&&path.posix.dirname(patch.packageJson)!=='node_modules'&&patch.file.startsWith(path.posix.dirname(patch.packageJson)+'/'),'Unsafe package patch path');
  require([patch.beforeSha256,patch.afterSha256].every(value=>/^[a-f0-9]{64}$/.test(value)),'Patch digests required');
  require(Array.isArray(patch.edits)&&patch.edits.length>0&&patch.edits.length<=16,'Bounded patch edits required');
  const metadata=JSON.parse(await regularBytes(path.join(root,patch.packageJson)));
  require(metadata.name===patch.packageName&&metadata.version===patch.version,`Package patch version mismatch: ${patch.id}`);
  const file=path.join(root,patch.file),original=await regularBytes(file),before=digest(original);
  require(before===patch.beforeSha256||before===patch.afterSha256,`Package patch source drift: ${patch.id}`);
  let content=original.toString('utf8');
  if(before!==patch.afterSha256){
   for(const edit of patch.edits){
    require(typeof edit.before==='string'&&edit.before.length>0&&edit.before.length<=65536&&typeof edit.after==='string'&&edit.after.length<=65536,'Invalid package edit');
    require(content.split(edit.before).length===2,`Package patch anchor is not unique: ${patch.id}`);content=content.replace(edit.before,()=>edit.after);
   }
   require(digest(Buffer.from(content))===patch.afterSha256,`Package patch output differs: ${patch.id}`);
  }
  plans.push({patch,file,original,content,alreadyApplied:before===patch.afterSha256});
 }
 for(const plan of plans){
  require(digest(await regularBytes(plan.file))===digest(plan.original),'Package file changed during patch validation');
  if(!plan.alreadyApplied)await fs.writeFile(plan.file,plan.content,'utf8');
  require(digest(await regularBytes(plan.file))===plan.patch.afterSha256,'Patched file verification failed');
 }
 return {manifestSha256:digest(bytes),group,patches:plans.map(({patch,alreadyApplied})=>({id:patch.id,packageName:patch.packageName,version:patch.version,file:patch.file,beforeSha256:patch.beforeSha256,afterSha256:patch.afterSha256,alreadyApplied}))};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 require(process.argv.length===4,'Usage: node apply-npm-patches.mjs <staged-package-group> <group-id>');
 console.log(JSON.stringify(await applyNpmPatches(process.argv[2],process.argv[3])));
}
