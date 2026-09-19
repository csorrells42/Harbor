import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const desktop = await import('../src/desktop/policy.mjs').catch(()=>({}));
test('sandbox preload exposes settings methods through the explicit IPC allowlist',async()=>{
  const calls=[];let api;
  vm.runInNewContext(await readFile('src/desktop/preload.cjs','utf8'),{require:name=>{assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(key,value)=>{assert.equal(key,'harbor');api=value;}},ipcRenderer:{invoke:(...args)=>{calls.push(args);return Promise.resolve('forwarded');}}};}});
  assert.equal(typeof api.getSettings,'function');assert.equal(typeof api.updateSettings,'function');
  await api.getSettings();await api.updateSettings({port:4000});
  assert.deepEqual(calls,[['harbor:getSettings'],['harbor:updateSettings',{port:4000}]]);
});
test('connection information exposes active bind, network endpoints and settings location',()=>{
  const settings={port:38777,networkEnabled:true,bindAddress:'0.0.0.0',mcpPath:'/tools',requestTimeoutMs:60000,toolTimeoutMs:120000,allowedOrigins:[]};
  const endpoints={local:'http://127.0.0.1:38777/tools',network:['http://192.168.1.9:38777/tools'],bindAddress:'0.0.0.0'};
  const info=desktop.connectionInfo({endpoint:endpoints.local,endpoints,settings,settingsPath:'C:/Data/harbor-settings.json',configPath:'C:/Data/servers.json',bridgePath:'C:/App/bridge.mjs',platform:'win32',version:'0.2.0'});
  assert.deepEqual(info.networkEndpoints,endpoints.network);
  assert.equal(info.bindAddress,'0.0.0.0');assert.deepEqual(info.settings,settings);
  assert.equal(info.settingsPath,'C:/Data/harbor-settings.json');assert.equal(info.version,'0.2.0');
  assert.equal(info.httpConfig.mcpServers.harbor.url,endpoints.local);
  settings.port=12345;endpoints.network.push('http://unexpected');
  assert.equal(info.settings.port,38777);assert.equal(info.networkEndpoints.length,1);
});

test('desktop exports HTTP and dependency-free stdio connection configurations',()=>{
  assert.equal(typeof desktop.connectionInfo,'function','connectionInfo is implemented');
  const info=desktop.connectionInfo({endpoint:'http://127.0.0.1:37373/mcp',configPath:'C:/Data/config.json',bridgePath:'C:/Program Files/MCP Harbor/bridge.mjs',platform:'win32'});
  assert.deepEqual(info.httpConfig,{mcpServers:{harbor:{url:'http://127.0.0.1:37373/mcp'}}});
  assert.deepEqual(info.stdioConfig,{mcpServers:{harbor:{command:'node',args:['C:/Program Files/MCP Harbor/bridge.mjs','http://127.0.0.1:37373/mcp']}}});
  assert.equal(info.configPath,'C:/Data/config.json');
});
