import test from 'node:test';
import assert from 'node:assert/strict';
const helpers = await import('../src/ui/helpers.js').catch(() => ({}));

test('managed process editor rejects malformed launch fields and ignores hidden ownership for stdio',()=>{
 const form={id:'managed',name:'Managed',transport:'http',url:'http://localhost/mcp'};
 for(const managedProcesses of ['not JSON','null','{}','[null]','[{"command":"node","args":null}]','[{"command":"node","env":null}]','[{"command":"node","runtime":null}]','[{"command":"node","unknown":true}]','[{"command":"wsl.exe"}]'])assert.throws(()=>helpers.parseServerForm({...form,managedProcesses}),/Managed processes/i);
 assert.equal(helpers.parseServerForm({id:'stdio',name:'stdio',command:'node',transport:'stdio',managedProcesses:'not JSON'}).managedProcesses,undefined);
});

test('remote forms discard hidden launch fields rather than validating or persisting stale drafts', () => {
  const config=helpers.parseServerForm({id:'remote',name:'Remote',transport:'sse',url:'http://localhost:8080/sse',runtime:'wsl',args:'not JSON',env:'not JSON',command:'old-command',cwd:'/old',distro:'Ubuntu'});
  assert.deepEqual(config.args,[]);
  assert.deepEqual(config.env,{});
  assert.equal(config.runtime,'native');
  assert.equal(config.command,'');
  assert.equal(config.cwd,'');
  assert.equal(config.distro,'');
});

test('import validates the common shape and explicitly disables automatic execution', () => {
  assert.equal(typeof helpers.parseImport, 'function');
  const data=helpers.parseImport('{"mcpServers":{"git":{"command":"uvx","args":["mcp-server-git"],"autoStart":true}}}');
  assert.equal(data.mcpServers.git.autoStart,false);
  assert.equal(data.mcpServers.git.autoRestart,false);
  assert.throws(()=>helpers.parseImport('not json'),/JSON/);
  assert.throws(()=>helpers.parseImport('{"other":{}}'),/mcpServers/);
  assert.throws(()=>helpers.parseImport('{"mcpServers":{}}'),/at least one/);
  assert.throws(()=>helpers.parseImport('{"mcpServers":{"x":null}}'),/object/);
});

test('templates require a chosen repository and never opt into execution', () => {
  assert.equal(typeof helpers.createTemplate, 'function');
  assert.throws(() => helpers.createTemplate('git',''), /repository/);
  const git = helpers.createTemplate('git','C:/my repo');
  assert.deepEqual(git.args, ['mcp-server-git','--repository','C:/my repo']);
  assert.equal(git.autoStart, false);
  assert.equal(git.command, 'uvx');
  const serena = helpers.createTemplate('serena','/home/me/repo','wsl');
  assert.equal(serena.command, 'serena');
  assert.deepEqual(serena.args, ['start-mcp-server','--project','/home/me/repo']);
  assert.equal(serena.runtime, 'wsl');
  assert.equal(serena.autoRestart, false);
  assert.throws(() => helpers.createTemplate('unknown','/repo'), /Unknown/);
});

test('remote config accepts HTTP/SSE and rejects unsafe protocols and unknown runtime', () => {
  const form = {id:'remote',name:'Remote',transport:'http',url:'https://example.org/mcp'};
  assert.equal(helpers.parseServerForm(form).url, form.url);
  assert.equal(helpers.parseServerForm({...form,transport:'sse'}).transport, 'sse');
  assert.throws(() => helpers.parseServerForm({...form,url:'file:///etc/passwd'}), /HTTP/);
  assert.throws(() => helpers.parseServerForm({...form,transport:'socket'}), /Transport/);
  assert.throws(() => helpers.parseServerForm({...form,runtime:'docker'}), /Runtime/);
});

test('config form validates identifiers and preserves argument boundaries and env values', () => {
  assert.equal(typeof helpers.parseServerForm, 'function');
  const config = helpers.parseServerForm({ id: 'my-server', name: 'My server', transport: 'stdio', runtime: 'native', command: 'python', args: '["-m","a path"]', env: '{"TOKEN":"a=b"}', cwd: 'C:/repo' });
  assert.deepEqual(config.args, ['-m', 'a path']);
  assert.deepEqual(config.env, { TOKEN: 'a=b' });
  assert.equal(config.autoStart, false);
  assert.throws(() => helpers.parseServerForm({ ...config, id: 'bad id' }), /ID/);
  assert.throws(() => helpers.parseServerForm({ ...config, args: '[1]' }), /Arguments/);
  assert.throws(() => helpers.parseServerForm({ ...config, env: '[]' }), /Environment/);
  assert.throws(() => helpers.parseServerForm({ ...config, command: '' }), /Command/);
});
