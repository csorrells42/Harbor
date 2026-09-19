import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const require=createRequire(import.meta.url),run=promisify(execFile);
async function until(check){const end=Date.now()+20000;while(!await check()){if(Date.now()>end)throw Error('Timed out waiting for the isolated launcher');await new Promise(r=>setTimeout(r,100));}}
async function linkRuntime(source,target){
  await fs.mkdir(target,{recursive:true});
  for(const entry of await fs.readdir(source,{withFileTypes:true})){
    const from=path.join(source,entry.name),to=path.join(target,entry.name==='electron.exe'?'MCP Harbor.exe':entry.name);
    if(entry.isDirectory())await linkRuntime(from,to);else await fs.link(from,to);
  }
}

// Uses the production portable launcher with a tiny temporary Electron app.
// Runtime hard links avoid copying an entire application for one native check.
test('portable launcher shows its native window on the first invocation',{
  skip:process.platform!=='win32'||!process.env.HARBOR_TEST_LAUNCHER_DESKTOP,timeout:40000
},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-launch-visibility-'));
  let pid;
  try{
    const support=path.join(root,'support'),runtime=path.join(root,'application/current');
    await fs.mkdir(support,{recursive:true});
    await fs.copyFile(new URL('../scripts/portable/launcher.mjs',import.meta.url),path.join(support,'launcher.mjs'));
    await fs.copyFile(new URL('../src/core/release-retention.mjs',import.meta.url),path.join(support,'release-retention.mjs'));
    await fs.writeFile(path.join(root,'maintenance.json'),JSON.stringify({retainBackups:true}));
    await linkRuntime(path.dirname(require('electron')),runtime);
    await fs.writeFile(path.join(root,'application/current.json'),JSON.stringify({path:'application/current'}));
    const appDir=path.join(runtime,'resources/app');await fs.mkdir(appDir,{recursive:true});
    await fs.writeFile(path.join(appDir,'package.json'),JSON.stringify({name:'harbor-launch-visibility-fixture',main:'main.cjs'}));
    await fs.writeFile(path.join(appDir,'main.cjs'),`
      const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
      const root=process.env.HARBOR_PORTABLE_ROOT;
      fs.writeFileSync(path.join(root,'pid.json'),JSON.stringify(process.pid));
      app.setPath('userData',path.join(root,'profile'));
      setTimeout(()=>app.exit(),25000).unref();
      app.whenReady().then(async()=>{
        const w=new BrowserWindow({show:false,width:480,height:220,title:'Harbor launcher verification'});
        await w.loadURL('data:text/html,<h2>Harbor launcher verification</h2>');w.show();w.focus();
        setTimeout(()=>fs.writeFileSync(path.join(root,'visible.json'),JSON.stringify({visible:w.isVisible(),handle:w.getNativeWindowHandle().readBigUInt64LE().toString()})),500);
        const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'finish'))){clearInterval(timer);app.quit();}},100);
      }).catch(error=>{fs.writeFileSync(path.join(root,'fixture-error.txt'),String(error));app.exit(1);});
    `);
    // Match the hidden helper used by Start Harbor.vbs, without touching the live profile.
    await run(process.execPath,[path.join(support,'launcher.mjs')],{windowsHide:true,env:{...process.env}});
    await until(()=>fs.access(path.join(root,'pid.json')).then(()=>true,()=>false));
    pid=JSON.parse(await fs.readFile(path.join(root,'pid.json'),'utf8'));
    await until(()=>fs.access(path.join(root,'visible.json')).then(()=>true,()=>false));
    const result=JSON.parse(await fs.readFile(path.join(root,'visible.json'),'utf8'));
    const command=`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class HarborVisibility{[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);}';[HarborVisibility]::IsWindowVisible([IntPtr]${result.handle})`;
    const native=await run('powershell.exe',['-NoProfile','-Command',command],{windowsHide:true});
    assert.equal(result.visible,true,'Electron reports a hidden first-launch window');
    assert.equal(native.stdout.trim(),'True','The actual native window is hidden');
  }finally{
    await fs.writeFile(path.join(root,'finish'),'done');
    if(pid)await until(()=>{try{process.kill(pid,0);return false;}catch{return true;}}).catch(()=>{try{process.kill(pid);}catch{}});
    await fs.rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250});
  }
});
