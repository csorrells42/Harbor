// Runs outside the MCP transport. stdin is the ownership lease; EOF reaps
// the job/process group. Only control records go to stdout; child logs use stderr.
import { spawn } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
const emit = value => process.stdout.write(JSON.stringify(value)+'\n');
const lines=createInterface({input:process.stdin});
let child, guardian, guardianReady=false, stopping=false, launched=false;
async function stop() {
  if(stopping)return;stopping=true;
  if(guardian){if(guardianReady)process.exit(0);return;}
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
 [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr job,int type,IntPtr info,uint size,IntPtr returned);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 public static void Lease(int pid,string completionPath) {
  IntPtr supervisor=OpenProcess(0x100000,false,pid);
  if(supervisor==IntPtr.Zero) throw new Exception("Cannot observe ownership supervisor");
  IntPtr job=IntPtr.Zero;
  // Observe a process handle, not the parent's pipes: abrupt termination must
  // release the same owned tree as a graceful end of its stdin lease.
  try {
   job=Own(pid);Console.Out.WriteLine("ready");Console.Out.Flush();
   if(WaitForSingleObject(supervisor,0xffffffff)!=0) throw new Exception("Cannot wait for ownership supervisor");
  }
  finally {
   try {if(job!=IntPtr.Zero)Reap(job,completionPath);}
   catch(Exception error) {System.IO.File.WriteAllText(completionPath+".error",error.Message);throw;}
   finally {if(job!=IntPtr.Zero)CloseHandle(job);CloseHandle(supervisor);}
  }
 }
 public static void Reap(IntPtr job,string completionPath) {
  if(!TerminateJobObject(job,1)) throw new Exception("Cannot terminate owned job");
  IntPtr info=Marshal.AllocHGlobal(48);
  try {
   DateTime deadline=DateTime.UtcNow.AddSeconds(12);
   while(true) {
    if(!QueryInformationJobObject(job,1,info,48,IntPtr.Zero)) throw new Exception("Cannot confirm owned job cleanup");
    // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.ActiveProcesses follows four
    // LARGE_INTEGER fields and two DWORD fields, on both Windows ABIs.
    if(Marshal.ReadInt32(info,40)==0) {
     // Keep the receipt in this invocation: killing the supervisor closes the
     // PowerShell host's pipes and can interrupt subsequent script statements.
     System.IO.File.WriteAllText(completionPath,"reaped"); return;
    }
    if(DateTime.UtcNow>=deadline) throw new Exception("Owned job cleanup timed out");
    System.Threading.Thread.Sleep(20);
   }
  } finally {Marshal.FreeHGlobal(info);}
 }
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
[HarborJob]::Lease(${process.pid},$env:HARBOR_MANAGED_COMPLETION_PATH)`;
   guardian=spawn(process.execPath,[fileURLToPath(new URL('./managed-windows-guardian.mjs',import.meta.url)),script],{env:{...process.env,HARBOR_MANAGED_COMPLETION_PATH:spec.completionPath},stdio:['pipe','pipe','pipe'],windowsHide:true,detached:true});
   guardian.stderr.pipe(process.stderr);
   await new Promise((resolve,reject)=>{guardian.once('error',reject);guardian.once('exit',code=>reject(new Error(`Ownership guardian exited (${code})`)));guardian.stdout.once('data',()=>resolve());});
   guardian.on('exit',()=>process.exit(0));
   guardianReady=true;
   if(stopping){process.exit(0);return;}
  }
  if(stopping)return;
  child=crossSpawn(spec.command,spec.args??[],{cwd:spec.cwd||undefined,env:{...process.env,...spec.env},stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true,detached:process.platform!=='win32'});
  child.stdout.pipe(process.stderr);child.stderr.pipe(process.stderr);
  child.once('error',error=>{emit({error:error.message});stop();});
  child.once('spawn',()=>emit({pid:child.pid,supervisorPid:process.pid}));
  child.once('exit',(code,signal)=>{emit({exit:code,signal});stop();});
 }catch(error){emit({error:error.message});await stop();}
});
