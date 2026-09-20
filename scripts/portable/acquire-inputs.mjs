import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const digestPattern=/^[a-f0-9]{64}$/;
const check=(ok,message)=>{if(!ok)throw new Error(message);};
const roles=new Set(['application','runtime','server','browser','model','patch','license','build-tool']);
function publicUrl(value,{redirect=false}={}) {
  check(typeof value==='string','Input URL is required');
  const url=new URL(value);
  check(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&(redirect||!url.search),'Inputs require credential-free public HTTPS URLs');
  check(!url.hostname.includes(':')&&!/^\d+(\.\d+){3}$/.test(url.hostname)&&url.hostname.includes('.')&&!/(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname),'Inputs require public hostnames');
  if(!redirect)check(!/(^|\/)(latest|main|master|HEAD)(\/|$)/i.test(url.pathname),'Pin an immutable version or revision, not a moving reference');
  return url.href;
}
export function validateInputs(input) {
  check(input?.schemaVersion===1,'Unsupported acquisition manifest version');
  check(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(input.release??''),'Invalid release ID');
  check(Array.isArray(input.artifacts)&&input.artifacts.length>0&&input.artifacts.length<=256,'Expected 1–256 declared artifacts');
  const ids=new Set(),hashSizes=new Map();
  const artifacts=input.artifacts.map(item=>{
    check(/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id??'')&&!ids.has(item.id),'Invalid or duplicate artifact ID');ids.add(item.id);
    check(roles.has(item.role),'Invalid artifact role');
    check(typeof item.version==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,99}$/.test(item.version),'Explicit artifact version is required');
    check(digestPattern.test(item.sha256??''),'Artifact requires recorded SHA-256');
    check(Number.isSafeInteger(item.bytes)&&item.bytes>0&&item.bytes<=8*1024**3,'Artifact requires exact bounded byte size');
    check(!hashSizes.has(item.sha256)||hashSizes.get(item.sha256)===item.bytes,'One digest cannot declare different sizes');hashSizes.set(item.sha256,item.bytes);
    check(['build','runtime','both'].includes(item.usage),'Declare build/runtime usage');
    check(typeof item.license==='string'&&item.license.length>0&&item.license.length<=200,'Declare license or NOASSERTION');
    return {id:item.id,role:item.role,version:item.version,usage:item.usage,url:publicUrl(item.url),bytes:item.bytes,sha256:item.sha256,license:item.license};
  });
  return {schemaVersion:1,release:input.release,artifacts};
}
async function realDirectory(directory,{create=false}={}) {
  directory=path.resolve(directory);
  const parent=path.dirname(directory);
  if(parent!==directory)await realDirectory(parent);
  let info;
  try{info=await fs.lstat(directory);}catch(error){if(error.code!=='ENOENT'||!create)throw error;await fs.mkdir(directory);info=await fs.lstat(directory);}
  check(info.isDirectory()&&!info.isSymbolicLink(),'Acquisition cache cannot use links or non-directories');
}
async function hashFile(file,artifact) {
  const before=await fs.lstat(file);
  check(before.isFile()&&!before.isSymbolicLink(),'Cached input must be a regular file');
  check(before.size===artifact.bytes,'Cached input size mismatch');
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(file))hash.update(chunk);
  const after=await fs.lstat(file);
  check(after.isFile()&&!after.isSymbolicLink()&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs&&before.ino===after.ino,'Cached input changed during verification');
  check(hash.digest('hex')===artifact.sha256,'Cached input checksum mismatch');
}
async function responseFor(url,fetchImpl,signal) {
  for(let redirects=0;redirects<=5;redirects++) {
    const response=await fetchImpl(url,{redirect:'manual',signal,headers:{'User-Agent':'Harbor-Portable-Acquisition/1'}});
    if([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();
      check(redirects<5,'Too many input download redirects');
      const location=response.headers.get('location');check(location,'Input redirect has no location');
      url=publicUrl(new URL(location,url).href,{redirect:true});continue;
    }
    check(response.ok,`Input download failed with HTTP ${response.status}`);
    return response;
  }
}
export async function acquireInputs(input,cacheRoot,{offline=false,fetchImpl=fetch,signal}={}) {
  const plan=validateInputs(input);
  cacheRoot=path.resolve(cacheRoot);await realDirectory(cacheRoot,{create:true});
  const lockPath=path.join(cacheRoot,'.acquire.lock');
  const lock=await fs.open(lockPath,'wx');
  try {
    await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
    const artifacts=[];
    for(const artifact of plan.artifacts) {
      signal?.throwIfAborted();
      const file=path.join(cacheRoot,artifact.sha256+'.blob');
      let present=true;try{await fs.lstat(file);}catch(error){if(error.code!=='ENOENT')throw error;present=false;}
      if(present) {await hashFile(file,artifact);artifacts.push({...artifact,file:path.basename(file),acquired:'verified-cache'});continue;}
      check(!offline,`Offline input missing: ${artifact.id}`);
      const temp=path.join(cacheRoot,`${artifact.sha256}.${randomUUID()}.part`);
      let handle;
      try {
        const timeout=AbortSignal.timeout(300000),downloadSignal=signal?AbortSignal.any([signal,timeout]):timeout;
        const response=await responseFor(artifact.url,fetchImpl,downloadSignal);
        const contentLength=response.headers.get('content-length');
        if(contentLength!==null)check(Number(contentLength)===artifact.bytes,'Input Content-Length does not match declared size');
        check(response.body,'Input download has no body');
        handle=await fs.open(temp,'wx');const hash=createHash('sha256');let bytes=0;
        for await(const chunk of response.body) {
          downloadSignal.throwIfAborted();bytes+=chunk.length;
          check(bytes<=artifact.bytes,'Input exceeded declared byte size');hash.update(chunk);
          let offset=0;while(offset<chunk.length){const result=await handle.write(chunk,offset,chunk.length-offset);check(result.bytesWritten>0,'Input cache write made no progress');offset+=result.bytesWritten;}
        }
        check(bytes===artifact.bytes,'Input download was truncated');
        check(hash.digest('hex')===artifact.sha256,'Downloaded input checksum mismatch');
        await handle.sync();await handle.close();handle=null;
        // A hard link publishes fully verified bytes atomically and refuses replacement.
        await fs.link(temp,file);await fs.unlink(temp);
        artifacts.push({...artifact,file:path.basename(file),acquired:'downloaded-and-verified'});
      } finally {await handle?.close();await fs.unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    }
    return {schemaVersion:1,kind:'verified-build-inputs',release:plan.release,verifiedAt:new Date().toISOString(),offline,planSha256:createHash('sha256').update(JSON.stringify(plan)).digest('hex'),artifacts,
      declaredBytes:artifacts.reduce((sum,item)=>sum+item.bytes,0),uniqueCacheBytes:[...new Map(artifacts.map(item=>[item.sha256,item.bytes])).values()].reduce((a,b)=>a+b,0),
      coverage:'Verified acquisition bytes only; no extraction, execution, redistribution clearance, assembled payload or clean-runtime acceptance is implied.'};
  } finally {await lock.close();await fs.unlink(lockPath);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [planFile,cacheRoot,receiptFile,...options]=process.argv.slice(2);
    check(planFile&&cacheRoot&&receiptFile&&options.every(value=>value==='--offline')&&options.length<=1,'Usage: node acquire-inputs.mjs <manifest.json> <cache-directory> <new-receipt.json> [--offline]');
    const plan=JSON.parse(await fs.readFile(planFile,'utf8'));validateInputs(plan);
    const output=await fs.open(receiptFile,'wx');
    try {const result=await acquireInputs(plan,cacheRoot,{offline:options.includes('--offline')});await output.writeFile(JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({release:result.release,artifacts:result.artifacts.length,uniqueCacheBytes:result.uniqueCacheBytes,verified:true}));}
    catch(error){await output.writeFile(JSON.stringify({schemaVersion:1,status:'failed',error:error.message})+'\n');throw error;}
    finally {await output.close();}
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
