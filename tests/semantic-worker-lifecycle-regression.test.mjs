import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

test('a semantic worker crash during queued writes does not crash Harbor and the next request recovers',{skip:process.platform!=='win32',timeout:20000},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-semantic-pipe-'));
  try{
    await fs.mkdir(path.join(root,'runtimes/node'),{recursive:true});
    await fs.mkdir(path.join(root,'support'));
    await fs.copyFile(process.execPath,path.join(root,'runtimes/node/node.exe'));
    const script=path.join(root,'support/portkey-worker.mjs');
    // Close the read end while the parent still has several large writes pending.
    await fs.writeFile(script,'process.exit(1);');
    const moduleUrl=new URL('../src/core/semantic-worker.mjs',import.meta.url).href;
    const probe=path.join(root,'probe.mjs');
    await fs.writeFile(probe,`
      import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';
      import {createSemanticWorker} from ${JSON.stringify(moduleUrl)};
      process.env.HARBOR_TOOL_RUNTIME_ROOT=${JSON.stringify(root)};
      const worker=createSemanticWorker();
      try{
        const failed=await Promise.allSettled(Array.from({length:4},()=>worker.request({payload:'x'.repeat(500000)},{timeout:3000})));
        assert(failed.every(result=>result.status==='rejected'));
        await fs.writeFile(${JSON.stringify(script)},${JSON.stringify("import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);process.stdout.write(JSON.stringify({id:r.id,result:{value:r.value}})+'\\n');});")});
        assert.deepEqual(await worker.request({value:'recovered'},{timeout:3000}),{value:'recovered'});
      }finally{const closing=worker.close();assert.throws(()=>worker.request({value:'too late'}),/closed/);await closing;}
      console.log('parent survived and retry succeeded');
    `);
    const {stdout}=await promisify(execFile)(process.execPath,[probe],{windowsHide:true,timeout:15000});
    assert.match(stdout,/parent survived and retry succeeded/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
