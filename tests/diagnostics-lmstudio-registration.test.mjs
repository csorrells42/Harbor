import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {registerDiagnosticPlugin} from '../src/diagnostics/lmstudio-registration.mjs';
async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'native-registration-'));t.after(()=>rm(dir,{recursive:true,force:true}));return {configFile:path.join(dir,'mcp.json'),bridgeFile:path.join(dir,'bridge.mjs'),gateway:'http://127.0.0.1:123/mcp',nodeExecutable:process.execPath};}
test('native MCP registration preserves existing and concurrently added server entries',async t=>{
 const options=await fixture(t),existing={command:'user-command',env:{SECRET:'private-fixture'}};await writeFile(options.configFile,JSON.stringify({mcpServers:{existing},other:{setting:true}}));
 const lease=await registerDiagnosticPlugin(options);let cfg=JSON.parse(await readFile(options.configFile,'utf8'));assert.deepEqual(cfg.mcpServers.existing,existing);assert.equal(Object.keys(cfg.mcpServers).length,2);assert.deepEqual(cfg.mcpServers[lease.id.slice(4)].args,[options.bridgeFile,options.gateway]);cfg.mcpServers.concurrent={url:'https://example.test/mcp'};await writeFile(options.configFile,JSON.stringify(cfg));
 await lease.close();await lease.close();cfg=JSON.parse(await readFile(options.configFile,'utf8'));assert.deepEqual(cfg,{mcpServers:{existing,concurrent:{url:'https://example.test/mcp'}},other:{setting:true}});
});
test('native MCP registration preserves an externally edited owned entry',async t=>{
 const options=await fixture(t),lease=await registerDiagnosticPlugin(options),cfg=JSON.parse(await readFile(options.configFile,'utf8'));cfg.mcpServers[lease.id.slice(4)].command='changed';await writeFile(options.configFile,JSON.stringify(cfg));await assert.rejects(lease.close(),/preserved/);assert.deepEqual(JSON.parse(await readFile(options.configFile,'utf8')),cfg);
});
test('native MCP registration rejects malformed configuration without changing it',async t=>{
 const options=await fixture(t);for(const text of ['broken','[]','{"mcpServers":[]}']){await writeFile(options.configFile,text);await assert.rejects(registerDiagnosticPlugin(options));assert.equal(await readFile(options.configFile,'utf8'),text);}
});

test('native registration waits for its exact synchronized entry and supports cancellation',async t=>{
 const options=await fixture(t),lease=await registerDiagnosticPlugin(options);
 await assert.rejects(lease.waitReady({timeoutMs:25}),/not synchronized/);
 const sync=path.join(path.dirname(options.configFile),'.internal');await mkdir(sync);
 await writeFile(path.join(sync,'last-synced-mcp-state.json'),'{');
 await assert.rejects(lease.waitReady({timeoutMs:25}),/not synchronized/);
 const controller=new AbortController();controller.abort();await assert.rejects(lease.waitReady({signal:controller.signal}),{name:'AbortError'});
 await writeFile(path.join(sync,'last-synced-mcp-state.json'),await readFile(options.configFile));
 await lease.waitReady({timeoutMs:100});
 await lease.close();
});
