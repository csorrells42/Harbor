import fs from 'node:fs/promises';
import path from 'node:path';
const [stage,source,destination]=process.argv.slice(2);
const root=path.resolve(stage),inside=p=>{const result=path.resolve(root,p);if(!result.startsWith(root+path.sep))throw new Error('Build output escapes staging');return result;};
const from=inside(source),to=inside(destination);await fs.access(from);
// A fresh source clone has no generated runtime directory. Refuse to overwrite
// an unexpected directory so a recipe cannot accidentally publish stale jars.
await fs.mkdir(to,{recursive:false});await fs.cp(from,to,{recursive:true});
console.log('Built runtime copied into the verified staging tree');
