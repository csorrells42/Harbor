// This detached Node host keeps PowerShell outside the supervisor's own
// automatic child cleanup. Its only job is to relay readiness and stay alive
// until the native Windows job owner has acknowledged an empty job.
import { spawn } from 'node:child_process';
process.stdout.on('error',()=>{});
process.stderr.on('error',()=>{});
const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',process.argv[2]],{
  stdio:['pipe','pipe','pipe'],windowsHide:true,
});
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.on('error',error=>{process.stderr.write(error.message);process.exitCode=1;});
child.on('close',code=>{process.exitCode=code??1;});
