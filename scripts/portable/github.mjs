import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
const root=process.env.HARBOR_PORTABLE_ROOT;
if(!root)throw new Error('Harbor Portable root is required');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(GH_|GITHUB_)/i.test(key)));
env.GH_CONFIG_DIR=path.join(root,'data/auth/gh');
const gh=path.join(root,'runtimes/gh/gh.exe');
let token;
try{
  const result=await promisify(execFile)(gh,['auth','token','--hostname','github.com'],{env,windowsHide:true,timeout:15000,maxBuffer:16384});
  token=result.stdout.trim();if(!token||/\s/.test(token))throw new Error();
}catch{console.error('GitHub needs sign-in. Run the bundled GitHub account setup before starting this server.');process.exit(1);}
const child=spawn(process.env.HARBOR_GITHUB_SERVER||path.join(root,'packages/github/github-mcp-server.exe'),['stdio'],{env:{...env,GITHUB_PERSONAL_ACCESS_TOKEN:token},windowsHide:true,stdio:['pipe','pipe','pipe']});
token=undefined;child.stderr.resume();child.stdin.on('error',()=>{});process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);
child.on('error',()=>{console.error('GitHub server could not start.');process.exitCode=1;});
let timer;process.stdin.on('end',()=>{timer=setTimeout(()=>child.kill(),1000);});child.on('close',code=>{clearTimeout(timer);process.exitCode=code??1;});
