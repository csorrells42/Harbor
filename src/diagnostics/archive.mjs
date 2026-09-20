import {readdir,stat,realpath,open} from 'node:fs/promises';
import path from 'node:path';
import {compare} from './grading.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MiB=1024*1024;
export function createCampaignArchive(root,{liveCampaign=()=>null}={}){
  function id(value){if(typeof value!=='string'||!uuid.test(value))throw new Error('Choose a saved diagnostic campaign or trial');return value;}
  async function read(parts,limit){
    const base=await realpath(root),file=await realpath(path.join(root,...parts));
    if(!file.startsWith(base+path.sep))throw new Error('Diagnostic evidence must remain inside its data directory');
    const handle=await open(file,'r');
    try{
      const info=await handle.stat();if(!info.isFile()||info.size>limit)throw new Error(`Diagnostic file exceeds the ${limit/MiB} MiB read limit`);
      const buffer=Buffer.alloc(info.size+1);let size=0;
      while(size<buffer.length){const {bytesRead}=await handle.read(buffer,size,buffer.length-size,null);if(!bytesRead)break;size+=bytesRead;}
      if(size>info.size)throw new Error('Diagnostic evidence changed while reading; refresh and try again');
      return JSON.parse(buffer.subarray(0,size).toString('utf8'));
    }finally{await handle.close();}
  }
  async function campaign(campaignId){
    id(campaignId);const value=await read([campaignId,'campaign.json'],8*MiB);
    if(value.id!==campaignId||!Array.isArray(value.trials)||value.trials.length>600||new Set(value.trials.map(trial=>id(trial.id))).size!==value.trials.length)throw new Error('Saved campaign has invalid identity or trial records');
    const live=liveCampaign();
    if(value.status==='running'&&live?.id!==campaignId){value.status='interrupted';value.note='No active campaign owns these saved results; unfinished trials were not scored.';value.current=null;}
    return value;
  }
  async function trial({campaignId,trialId},parent){
    id(trialId);parent??=await campaign(campaignId);
    if(!parent.trials.some(value=>value.id===trialId))throw new Error('Trial does not belong to the selected saved campaign');
    const value=await read([id(campaignId),trialId,'result.json'],16*MiB);
    if(value.id!==trialId)throw new Error('Trial identity does not match its file');return value;
  }
  return {
    async list({page=0}={}){
      if(!Number.isInteger(page)||page<0||page>100000)throw new Error('Choose a valid campaign page');
      const entries=(await readdir(root,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&uuid.test(entry.name));
      if(entries.length>5000)throw new Error('More than 5,000 saved campaigns; move older campaigns to a separate archive before browsing');
      const ordered=[];for(const entry of entries){try{ordered.push({id:entry.name,updatedAt:(await stat(path.join(root,entry.name))).mtimeMs});}catch(error){if(error.code!=='ENOENT')throw error;}}
      ordered.sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id));
      const items=[];for(const entry of ordered.slice(page*25,page*25+25)){
        try{const value=await campaign(entry.id);items.push({id:value.id,createdAt:value.createdAt,status:value.status,trials:value.trials.length,plannedTrials:value.plannedTrials,suite:value.suite,model:value.inventory?.model??null});}
        catch(error){items.push({id:entry.id,status:'unreadable',error:error.message});}
      }
      return {items,page,pages:Math.max(1,Math.ceil(ordered.length/25)),total:ordered.length};
    },
    async inspect(campaignId){const value=await campaign(campaignId);return {campaign:value,results:compare(value.trials)};},
    trial,
    async export(campaignId){
      const value=await campaign(campaignId),trials=[];
      let bytes=Buffer.byteLength(JSON.stringify(value));
      for(const row of value.trials){const detail=await trial({campaignId,trialId:row.id},value);bytes+=Buffer.byteLength(JSON.stringify(detail));if(bytes>60*MiB)throw new Error('Full campaign evidence exceeds the 64 MiB export limit; inspect individual saved trial files');trials.push(detail);}
      const text=JSON.stringify({schemaVersion:1,exportedAt:new Date().toISOString(),coverage:'Saved campaign settings, compact trial summaries and complete recorded trial evidence. Interrupted or running campaigns contain completed records only. Fixture files and model messages are not included. Local paths and synthetic tool content may be present; inspect before sharing.',campaign:value,results:compare(value.trials),trials},null,2);
      if(Buffer.byteLength(text)>64*MiB)throw new Error('Full campaign evidence exceeds the 64 MiB export limit; inspect individual saved trial files');return text;
    }
  };
}
