import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('installed Python verifies GGUF bytes and live model properties without activating models or exporting secrets',{skip:!process.env.HARBOR_TEST_INSTALLED_HERMES,timeout:30000},async()=>{
  const python=path.join(process.env.LOCALAPPDATA,'hermes/hermes-agent/venv/Scripts/python.exe');
  const result=await promisify(execFile)(python,['-B',fileURLToPath(new URL('./diagnostics-model-identity.py',import.meta.url))],{windowsHide:true,timeout:25000});
  console.log(result.stdout+result.stderr);
});
