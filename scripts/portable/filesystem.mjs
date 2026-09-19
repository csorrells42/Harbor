// Discover accessible drive roots on each host; no original-machine drive list.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.HARBOR_PORTABLE_ROOT;
if(!root)throw new Error('Harbor Portable root is required');
const entry=path.join(root,'packages/general-local/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js');
const drives=process.platform==='win32'?Array.from({length:26},(_,i)=>`${String.fromCharCode(65+i)}:/`).filter(p=>{try{return fs.statSync(p).isDirectory();}catch{return false;}}):['/'];
process.argv=[process.execPath,entry,...drives];
await import(pathToFileURL(entry).href);
