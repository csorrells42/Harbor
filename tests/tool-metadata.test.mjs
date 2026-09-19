import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Upstreams } from '../src/core/upstreams.mjs';
import { createGateway } from '../src/core/gateway.mjs';

test('gateway preserves upstream descriptions, schemas, annotations and call routing', async () => {
  const upstreams=new Upstreams([{id:'custom'}],()=>{});
  const tool={name:'save',description:'Description owned by the upstream',inputSchema:{type:'object',properties:{value:{type:'string'}}},annotations:{readOnlyHint:false}};
  const calls=[];
  const fake={getServerCapabilities:()=>({tools:{}}),listTools:async()=>({tools:[tool]}),callTool:async request=>{calls.push(request);return {content:[{type:'text',text:'saved'}]};}};
  const entry=upstreams.get('custom');entry.client=fake;entry.status='running';await upstreams.refresh(entry,fake);
  const gateway=await createGateway({host:'127.0.0.1',port:0,upstreams,log:()=>{},toolTimeoutMs:1000});
  const client=new Client({name:'upstream metadata contract',version:'1'});
  const transport=new StreamableHTTPClientTransport(new URL(gateway.endpoint));
  try {
    await client.connect(transport);
    assert.match(client.getInstructions(),/^Tools are namespaced by server\. Clients share each upstream process and its mutable state\./);
    const {tools}=await client.listTools();assert.equal(tools.length,1);
    assert.equal(tools[0].description,tool.description);
    assert.deepEqual(tools[0].inputSchema,tool.inputSchema);
    assert.deepEqual(tools[0].annotations,tool.annotations);
    assert.equal(tools[0].serverId,undefined);
    await client.callTool({name:tools[0].name,arguments:{value:'sample'}});
    assert.deepEqual(calls,[{name:'save',arguments:{value:'sample'}}]);
  } finally {await transport.terminateSession().catch(()=>{});await client.close();await gateway.close();}
});
