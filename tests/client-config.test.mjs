import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from 'js-yaml';
import {CONNECTION_CLIENTS,clientConnectionHelp,clientConnectionSteps,formatClientConfiguration as format} from '../src/core/client-config.js';
const url='http://192.168.1.20:37373/mcp/profiles/build';
const key='test: # "quoted" \\ path\nnext';
const entry={command:'C:\\Harbor ü\\node.exe',args:['C:\\Harbor ü\\bridge.mjs',url],env:{HARBOR_API_KEY:key}};
const config=value=>({mcpServers:{harbor:value}});

test('client recipes preserve paths, credentials and input; every listed client has setup steps',()=>{
  assert.equal(CONNECTION_CLIENTS.length,12);
  for(const [client] of CONNECTION_CLIENTS){
    const help=clientConnectionHelp(client);assert.ok(help.caption);
    for(const transport of help.formats){
      const input=config(transport==='http'?{url,headers:{Authorization:'Bearer '+key}}:entry),before=structuredClone(input);
      assert.ok(format(input,client).includes(url));assert.deepEqual(input,before);
      assert.equal(clientConnectionSteps(client,transport).length,4);
    }
  }
  assert.deepEqual(load(format(config(entry),'hermes')),{mcp_servers:{harbor:entry}});
  assert.deepEqual(JSON.parse(format(config(entry),'openclaw')),{mcp:{servers:{harbor:{transport:'stdio',...entry}}}});
  const goose=load(format(config(entry),'goose')).extensions.harbor;
  assert.equal(goose.cmd,entry.command);assert.deepEqual(goose.args,entry.args);assert.deepEqual(goose.envs,entry.env);assert.equal(goose.enabled,true);
});

test('HTTP client dialects carry the selected profile URL and authentication without changing transport meaning',()=>{
  const input=config({url,headers:{Authorization:'Bearer token'}});
  const v2=JSON.parse(format(input,'opencode')).mcp.servers.harbor;
  const v1=JSON.parse(format(input,'opencode-v1')).mcp.harbor;
  assert.deepEqual(v1,v2);assert.deepEqual(v2,{type:'remote',url,oauth:false,headers:{Authorization:'Bearer token'}});
  assert.deepEqual(JSON.parse(format(config(entry),'opencode')).mcp.servers.harbor,{type:'local',command:[entry.command,...entry.args],environment:entry.env});
  assert.deepEqual(JSON.parse(format(input,'anythingllm')).mcpServers.harbor,{type:'streamable',url,headers:{Authorization:'Bearer token'}});
  assert.deepEqual(JSON.parse(format(input,'letta')),{server_name:'harbor',config:{mcp_server_type:'streamable_http',server_url:url,custom_headers:{Authorization:'Bearer token'}}});
  const goose=load(format(input,'goose')).extensions.harbor;
  assert.equal(goose.type,'streamable_http');assert.equal(goose.uri,url);assert.deepEqual(goose.headers,{Authorization:'Bearer token'});
  assert.match(format(input,'openwebui'),/Auth: Bearer\nToken: token$/);assert.doesNotMatch(format(input,'openwebui'),/Token: Bearer/);
  assert.match(format(input,'openhands'),/"api_key" = "token"/);
  assert.deepEqual(JSON.parse(format(input,'general')),input);
});

test('disabled authentication exports no stale credential and unsupported selections fail explicitly',()=>{
  for(const [client] of CONNECTION_CLIENTS){
    const output=format(config({url}),client);
    assert.doesNotMatch(output,/Authorization|api_key|http_headers|custom_headers|Token:|Bearer /);
    if(clientConnectionHelp(client).formats.includes('stdio')){
      const output=format(config({command:entry.command,args:entry.args}),client);
      assert.doesNotMatch(output,/HARBOR_API_KEY|"env"|"envs"|"environment"/);
    }
  }
  assert.throws(()=>format(config(entry),'openwebui'),/Streamable HTTP/);
  for(const client of ['unknown','__proto__','constructor'])assert.throws(()=>format(config(entry),client),/supported client/);
  assert.throws(()=>format({},'general'),/unavailable/);
});
