import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createAdviceHistory} from '../src/diagnostics/advice-history.mjs';

test('optional receipts are bounded, exclude full profiles, reload and clear without backups',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor advice history ')),file=path.join(root,'history.json');
  t.after(async()=>{assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});});
  const history=await createAdviceHistory(file);await assert.rejects(fs.access(file));
  const receipt={appliedAt:new Date().toISOString(),campaignId:'campaign',evidenceFingerprint:'a'.repeat(64),profileId:'coding',previousRevision:1,revision:2,changes:[{field:'toolMode',before:'all',after:'bm25'}],secret:'not retained'};
  for(let i=0;i<52;i++)await history.append({...receipt,previousRevision:i+1,revision:i+2});
  assert.equal(history.snapshot().receipts.length,50);assert.equal(history.snapshot().receipts[0].revision,53);
  assert.equal(history.snapshot().receipts[0].secret,undefined);assert.deepEqual(await fs.readdir(root),['history.json']);
  const reloaded=await createAdviceHistory(file);assert.deepEqual(reloaded.snapshot(),history.snapshot());
  assert.throws(()=>history.append({...receipt,changes:[{field:'portkeyApiKeyFile',before:'secret',after:'other'}]}),/Invalid/);
  await history.clear();assert.equal((await createAdviceHistory(file)).snapshot().receipts.length,0);await history.close();
});

test('malformed existing receipt files are rejected without replacement',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor invalid history ')),file=path.join(root,'history.json');
  t.after(async()=>{assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});});
  for(const content of ['not json',JSON.stringify({schemaVersion:1,receipts:[{}]}),'x'.repeat(256*1024+1)]){await fs.writeFile(file,content);await assert.rejects(createAdviceHistory(file));assert.equal(await fs.readFile(file,'utf8'),content);}
});
