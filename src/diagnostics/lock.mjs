import {readFile,writeFile,open,unlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {hostname} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';

export async function claimCampaignLock(root) {
  const file=path.join(root,'campaign.lock'),token=randomUUID();
  if(process.platform!=='win32'){
    let handle;try{handle=await open(file,'wx');}catch(e){if(e.code==='EEXIST')throw new Error('Another diagnostic instance owns this directory. Automatic lock recovery is currently Windows-only.');throw e;}
    await handle.writeFile(JSON.stringify({pid:process.pid,host:hostname(),token}));
    return {async close(){await handle.close();await unlink(file);}};
  }
  const contents=await readFile(new URL('./campaign-lock.ps1',import.meta.url));
  const script=path.join(root,`campaign-lock-${createHash('sha256').update(contents).digest('hex')}.ps1`);
  try{await writeFile(script,contents,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
  const shell=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  async function operation(mode){
    let stdout;try{({stdout}=await promisify(execFile)(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-LockPath',file,'-OwnerPid',String(process.pid),'-OwnerHost',hostname(),'-Token',token,'-Mode',mode],{windowsHide:true,timeout:15000,maxBuffer:20000}));}
    catch(e){try{const message=JSON.parse(e.stdout).error;if(message)throw new Error(message);}catch(parsed){if(parsed instanceof SyntaxError)throw new Error('Diagnostic ownership check failed. Retry after other instances exit.');throw parsed;}}
    const result=JSON.parse(stdout);if(result.error)throw new Error(result.error);return result;
  }
  const claimed=await operation('claim');let closed=false;
  return {recovered:claimed.recovered,async close(){if(!closed){await operation('release');closed=true;}}};
}
