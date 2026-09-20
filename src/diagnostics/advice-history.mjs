import {mkdir,open,writeFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ADVICE_FIELDS} from './advice.mjs';
import {DEFAULT_SETTINGS,validateSettings} from '../core/settings.mjs';

// Optional ordinary configuration receipts. No application files, credentials
// or complete profiles are copied. A bounded file replaces its old contents.
export async function createAdviceHistory(file){
  let receipts=[],writes=Promise.resolve();
  function validate(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.appliedAt!=='string'||!Number.isFinite(Date.parse(value.appliedAt))||typeof value.campaignId!=='string'||value.campaignId.length>64||typeof value.evidenceFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(value.evidenceFingerprint)||typeof value.profileId!=='string'||!/^[a-z][a-z0-9-]{0,39}$/.test(value.profileId)||![value.previousRevision,value.revision].every(v=>Number.isSafeInteger(v)&&v>0)||!Array.isArray(value.changes)||value.changes.length>ADVICE_FIELDS.length)throw Error('Invalid advice configuration history');
    if(new Set(value.changes.map(change=>change.field)).size!==value.changes.length||value.changes.some(change=>!ADVICE_FIELDS.includes(change.field)||JSON.stringify(change).length>2048||Object.keys(change).some(key=>!['field','before','after'].includes(key))))throw Error('Invalid advice configuration history');
    for(const change of value.changes)for(const side of ['before','after']){if(change[side]===undefined)throw Error('Invalid advice configuration history');validateSettings({...DEFAULT_SETTINGS,[change.field]:change[side]});}
    return structuredClone({appliedAt:value.appliedAt,campaignId:value.campaignId,evidenceFingerprint:value.evidenceFingerprint,profileId:value.profileId,previousRevision:value.previousRevision,revision:value.revision,changes:value.changes});
  }
  try{
    const handle=await open(file,'r');let raw;
    try{const bytes=Buffer.alloc(256*1024+1);let length=0;while(length<bytes.length){const read=await handle.read(bytes,length,bytes.length-length,null);if(!read.bytesRead)break;length+=read.bytesRead;}if(length>256*1024)throw Error('Advice configuration history exceeds its size limit');raw=JSON.parse(bytes.subarray(0,length).toString('utf8'));}finally{await handle.close();}
    if(raw.schemaVersion!==1||!Array.isArray(raw.receipts)||raw.receipts.length>50)throw Error('Invalid advice configuration history');receipts=raw.receipts.map(validate);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  function change(operation){const job=writes.then(async()=>{const next=operation(receipts),text=JSON.stringify({schemaVersion:1,receipts:next},null,2)+'\n';if(Buffer.byteLength(text)>256*1024)throw Error('Advice configuration history exceeds its size limit');await mkdir(path.dirname(file),{recursive:true});const temporary=file+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,text,{flag:'wx',mode:0o600});await rename(temporary,file);receipts=next;}finally{await unlink(temporary).catch(()=>{});}return {receipts:structuredClone(receipts),limit:50};});writes=job.catch(()=>{});return job;}
  return {snapshot:()=>({receipts:structuredClone(receipts),limit:50}),append:value=>{const captured=validate(value);return change(previous=>[captured,...previous].slice(0,50));},clear:()=>change(()=>[]),close:()=>writes};
}
