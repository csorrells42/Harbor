// Runs outside the MCP transport. stdin is the ownership lease; EOF reaps
// the job/process group. Only control records go to stdout; child logs use stderr.
import { spawn } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { createInterface } from 'node:readline';
const emit = value => process.stdout.write(JSON.stringify(value)+'\n');
const lines=createInterface({input:process.stdin});
let child, guardian, stopping=false, launched=false;
async function stop() {
  if(stopping)return;stopping=true;
  if(guardian){guardian.stdin.end();return;}
  if(child?.pid){try{process.kill(-child.pid,'SIGTERM');}catch{} await new Promise(r=>setTimeout(r,250));try{process.kill(-child.pid,'SIGKILL');}catch{}}
  process.exit(0);
}
lines.on('close',stop);
lines.on('line',async line=>{
 if(launched){await stop();return;}launched=true;
 try {
  const spec=JSON.parse(line);
  if(process.platform==='win32'){
   // Assign this waiting supervisor to a kill-on-close job BEFORE launching
   // user code. The guardian is outside the job, and owns its sole handle.
   const script=`$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class HarborJob {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a,string n);
 [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr i,uint l);
 [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
 [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a,bool i,int p);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
 public static IntPtr Own(int pid) {
  IntPtr job=CreateJobObject(IntPtr.Zero,null);
  int size=IntPtr.Size==8?144:112; IntPtr info=Marshal.AllocHGlobal(size);
  for(int i=0;i<size;i++) Marshal.WriteByte(info,i,0);
  Marshal.WriteInt32(info,16,0x2000);
  if(!SetInformationJobObject(job,9,info,(uint)size)) throw new Exception("Cannot set kill-on-close job");
  Marshal.FreeHGlobal(info);
  IntPtr process=OpenProcess(0x101,false,pid);
  if(!AssignProcessToJobObject(job,process)) throw new Exception("Cannot assign ownership job");
  CloseHandle(process); return job;
 }
}
'@
$job=[HarborJob]::Own(${process.pid})
try { [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null }
finally { [HarborJob]::CloseHandle($job) | Out-Null }`;
   guardian=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{stdio:['pipe','pipe','pipe'],windowsHide:true});
   guardian.stderr.pipe(process.stderr);
   await new Promise((resolve,reject)=>{guardian.once('error',reject);guardian.once('exit',code=>reject(new Error(`Ownership guardian exited (${code})`)));guardian.stdout.once('data',()=>resolve());});
   guardian.on('exit',()=>process.exit(0));
   if(stopping){guardian.stdin.end();return;}
  }
  if(stopping)return;
  child=crossSpawn(spec.command,spec.args??[],{cwd:spec.cwd||undefined,env:{...process.env,...spec.env},stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true,detached:process.platform!=='win32'});
  child.stdout.pipe(process.stderr);child.stderr.pipe(process.stderr);
  child.once('error',error=>{emit({error:error.message});stop();});
  child.once('spawn',()=>emit({pid:child.pid,supervisorPid:process.pid}));
  child.once('exit',(code,signal)=>{emit({exit:code,signal});stop();});
 }catch(error){emit({error:error.message});await stop();}
});
