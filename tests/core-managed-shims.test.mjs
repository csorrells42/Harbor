import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchManaged } from '../src/core/managed-processes.mjs';

async function eventually(fn) {
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,30));}
  assert.fail('Fixture did not report argv');
}
test('Windows npm-style shim preserves literal metacharacter argv without injection', {skip:process.platform!=='win32'}, async t=>{
  const dir=await mkdtemp(join(tmpdir(),'harbor-shim-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const bin=join(dir,'node_modules','.bin');await mkdir(bin,{recursive:true});
  const output=join(dir,'argv.json');const sentinel=join(dir,'INJECTED');
  const script=join(dir,'capture.cjs');
  await writeFile(script,'require("node:fs").writeFileSync(process.env.ARGV_FILE,JSON.stringify(process.argv.slice(2)));setInterval(()=>{},1000)');
  const shim=join(bin,'literal.cmd');
  // This fixture embeds UTF-8 literal paths; cmd otherwise reads the OEM page.
  await writeFile(shim,`@ECHO off\r\nchcp 65001 >nul\r\n"${process.execPath}" "${script}" %*\r\n`);
  const args=['a b','','quote"inside','trailing\\','a&b','x|y','<input>','(paren)','caret^value','%HARBOR_LITERAL%','!HARBOR_LITERAL!','$(not-a-shell)',`" & echo INJECTED > "${sentinel}" & rem "`];
  const owned=launchManaged({command:shim,args,env:{ARGV_FILE:output,HARBOR_LITERAL:'MUST_NOT_EXPAND'}},()=>{},()=>{});
  try {
    await owned.ready;await eventually(()=>readFile(output).then(()=>true,()=>false));
    assert.deepEqual(JSON.parse(await readFile(output,'utf8')),args);
    await assert.rejects(readFile(sentinel),{code:'ENOENT'});
  } finally {await owned.close();}
});

test('Windows managed npm/npx .cmd shims launch under ownership', {skip:process.platform!=='win32'}, async()=>{
  for(const command of ['npm.cmd','npx.cmd']) {
    let output='';
    const owned=launchManaged({command,args:['--version']},line=>output+=line,()=>{});
    try {await owned.ready;await eventually(()=>/\d+\.\d+\.\d+/.test(output));}
    finally {await owned.close();}
    assert.match(output,/\d+\.\d+\.\d+/);
  }
});
