import test from 'node:test';
import assert from 'node:assert/strict';
import {resourceReference,promptReference,parseReference,mapToolResult} from '../src/core/mcp-primitives.mjs';

test('reversible namespaces preserve URI/template semantics and separate server/name collisions',()=>{
  for(const id of ['one','two','mixed-case'])for(const value of ['file:///C:/folder/a%20b.txt','fixture://x/../y?q=%25#fragment','fixture://items/{+path}{?query}','https://example.test/é',resourceReference('other','nested://value')]){
    assert.deepEqual(parseReference(resourceReference(id,value)),{serverId:id,value});
    assert.deepEqual(parseReference(promptReference(id,value),'prompt'),{serverId:id,value});
  }
  assert.notEqual(resourceReference('one','file:///same'),resourceReference('two','file:///same'));
  for(const input of ['file:///not-namespaced','harbor-resource://6F6E65/test','harbor-resource://ff/test','harbor-resource://1/test','harbor-resource://6f6e65/','harbor-resource://6f6e65/a\n'])assert.throws(()=>parseReference(input));
  const expanded=resourceReference('one','fixture://items/{+path}{?query}').replace('{+path}','a/b').replace('{?query}','?query=a%20b');
  assert.equal(parseReference(expanded).value,'fixture://items/a/b?query=a%20b');
});

test('reference expansion cannot expose an unreadable overlong URI or a result exceeding the public byte limit',()=>{
  assert.throws(()=>resourceReference('one','x'.repeat(16384)),/Invalid MCP reference/);
  assert.throws(()=>promptReference('one','x'.repeat(16384)),/Invalid MCP reference/);
  const result={content:[{type:'resource_link',name:'large link',uri:'fixture://x'},{type:'text',text:''}]};
  result.content[1].text='x'.repeat(4*1024*1024-Buffer.byteLength(JSON.stringify(result))-5);
  assert(Buffer.byteLength(JSON.stringify(result))<4*1024*1024);assert.throws(()=>mapToolResult('one',result),/4 MiB/);
});
