import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { fork } from 'node:child_process';
import { request as httpRequest } from 'node:http';

async function networkFixture(t, env = {}) {
  const child = fork(fileURLToPath(new URL('./fixtures/network.mjs', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, ...env } });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.send('close');
    const kill = setTimeout(() => child.kill(), 2000);
    await exited; clearTimeout(kill);
  });
  const { port } = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`Fixture exited: ${code}`))); });
  return { child, port };
}

test('HTTP and legacy SSE upstreams aggregate through real SDK transports', async t => {
  const { hub } = await setup(t);
  const { child, port } = await networkFixture(t);
  for (const transport of ['http', 'sse']) {
    await hub.saveServer({ id: transport, transport, url: `http://127.0.0.1:${port}/${transport === 'http' ? 'mcp' : 'sse'}` });
    await hub.startServer(transport);
  }
  const { client } = await connect(t, hub, 'network-consumer');
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 2);
  assert.equal(new Set(tools.map(t => t.name)).size, 2);
  for (const tool of tools) assert.equal((await client.callTool({ name: tool.name, arguments: { text: 'network' } })).content[0].text, `network:${child.pid}`);
});
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

test('all tool pages are namespaced without collisions and change notifications reach clients', async t => {
  const { hub } = await setup(t);
  for (const id of ['a', 'a__b']) {
    await hub.saveServer({ ...fixtureConfig(id), env: { PAGINATED: '1' } });
    await hub.startServer(id);
  }
  const { client } = await connect(t, hub, 'change-listener');
  let changes = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changes++; });
  let tools = (await client.listTools()).tools;
  assert.equal(tools.length, 6);
  assert.equal(new Set(tools.map(t => t.name)).size, 6);
  for (const tool of tools) assert.match(tool.name, /^[A-Za-z0-9_-]{1,64}$/);
  const echo = hub.snapshot().tools.find(t => t.serverId === 'a' && t.originalName === 'echo');
  await client.callTool({ name: echo.name, arguments: { change: true } });
  await eventually(() => hub.snapshot().tools.length === 7 && changes > 0);
  assert.equal((await client.listTools()).tools.length, 7);
  await hub.restartServer('a');
  assert.equal(hub.snapshot().tools.find(t => t.serverId === 'a' && t.originalName === 'echo').name, echo.name);
});

async function connect(t, hub, name) {
  const client = new Client({ name, version: '1.2.3' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(hub.endpoint));
  t.after(async () => { await transport.terminateSession().catch(() => {}); await client.close(); });
  await client.connect(transport);
  return { client, transport };
}

test('two real HTTP MCP clients share one child and receive correctly routed concurrent results', async t => {
  const { hub, dir } = await setup(t);
  await hub.saveServer({ ...fixtureConfig(), cwd: dir });
  await hub.startServer('fixture');
  const a = await connect(t, hub, 'client-a');
  const b = await connect(t, hub, 'client-b');
  await eventually(() => hub.snapshot().clients.length === 2);
  assert.deepEqual(hub.snapshot().clients.map(c => c.name).sort(), ['client-a', 'client-b']);
  const tools = await a.client.listTools();
  assert.equal(tools.tools.length, 1);
  const name = tools.tools[0].name;
  const results = await Promise.all([
    a.client.callTool({ name, arguments: { text: 'slow', delay: 120 } }),
    b.client.callTool({ name, arguments: { text: 'fast' } })
  ]);
  const [slow, fast] = results.map(r => JSON.parse(r.content[0].text));
  assert.equal(slow.text, 'slow'); assert.equal(fast.text, 'fast');
  assert.equal(slow.pid, fast.pid); assert.equal(slow.count, 2); assert.equal(fast.count, 1);
  assert.equal(slow.env, 'real env'); assert.equal(slow.cwd.toLowerCase(), dir.toLowerCase());
  await a.transport.terminateSession(); await a.client.close();
  await eventually(() => hub.snapshot().clients.length === 1);
  await hub.restartServer('fixture');
  const restarted = JSON.parse((await b.client.callTool({ name, arguments: { text: 'after restart' } })).content[0].text);
  assert.notEqual(restarted.pid, slow.pid); assert.equal(restarted.count, 1);
  await hub.stopServer('fixture');
  assert.deepEqual((await b.client.listTools()).tools, []);
  await assert.rejects(b.client.callTool({ name, arguments: {} }), /Unknown tool|not available/i);
});

const fixturePath = fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url));
const fixtureConfig = (id = 'fixture') => ({ id, name: id, transport: 'stdio', runtime: 'native', command: process.execPath, args: [fixturePath], env: { HARBOR_TEST: 'real env' }, autoStart: false, autoRestart: false });
async function eventually(check, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(r => setTimeout(r, 30)); }
  assert.fail('Condition did not become true before timeout');
}

test('native stdio starts a real MCP child, discovers tools, logs stderr and restarts cleanly', async t => {
  const { hub } = await setup(t);
  await hub.saveServer(fixtureConfig());
  await hub.startServer('fixture');
  let state = hub.snapshot();
  assert.equal(state.servers[0].status, 'running');
  assert.ok(state.servers[0].pid > 0);
  const firstPid = state.servers[0].pid;
  assert.equal(state.tools[0].originalName, 'echo');
  assert.equal(state.tools[0].serverId, 'fixture');
  assert.match(state.tools[0].name, /^fixture/);
  assert.ok(state.logs.some(l => l.message.includes('fixture booted')));
  await hub.restartServer('fixture');
  assert.notEqual(hub.snapshot().servers[0].pid, firstPid);
  await hub.stopServer('fixture');
  assert.equal(hub.snapshot().servers[0].status, 'stopped');
  assert.equal(hub.snapshot().tools.length, 0);
  assert.throws(() => process.kill(firstPid, 0));
});

async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'harbor-core-'));
  const { createHub } = await import('../src/core/hub.mjs');
  const hub = await createHub({ configPath: join(dir, 'config.json'), port: 0, ...options });
  t.after(async () => { await hub.close(); await rm(dir, { recursive: true, force: true }); });
  return { hub, dir, createHub };
}

test('unexpected child exit clears tools and autoRestart reconnects without killing downstream sessions', async t => {
  const { hub } = await setup(t);
  await hub.saveServer({ ...fixtureConfig(), autoRestart: true });
  await hub.startServer('fixture');
  const { client } = await connect(t, hub, 'survivor');
  const name = (await client.listTools()).tools[0].name;
  const pid = hub.snapshot().servers[0].pid;
  process.kill(pid);
  await eventually(() => hub.snapshot().servers[0].status === 'error');
  assert.equal(hub.snapshot().tools.length, 0);
  await eventually(() => hub.snapshot().servers[0].status === 'running' && hub.snapshot().servers[0].pid !== pid);
  assert.equal(JSON.parse((await client.callTool({ name, arguments: { text: 'recovered' } })).content[0].text).text, 'recovered');
  await hub.stopServer('fixture');
  await new Promise(r => setTimeout(r, 900));
  assert.equal(hub.snapshot().servers[0].status, 'stopped');
});

test('autostart returns before server initialization and contains failed launches', async t => {
  const { hub, dir, createHub } = await setup(t);
  await hub.saveServer({ ...fixtureConfig(), autoStart: true });
  await hub.saveServer({ ...fixtureConfig('broken'), command: join(dir, 'missing-executable'), autoStart: true });
  await hub.close();
  const reopened = await createHub({ configPath: join(dir, 'config.json'), port: 0 });
  t.after(() => reopened.close());
  assert.notEqual(reopened.snapshot().servers.find(s => s.id === 'fixture').status, 'running');
  await eventually(() => reopened.snapshot().servers.find(s => s.id === 'fixture').status === 'running');
  await eventually(() => reopened.snapshot().servers.find(s => s.id === 'broken').status === 'error');
  assert.match(reopened.snapshot().servers.find(s => s.id === 'broken').error, /ENOENT|spawn/i);
  assert.ok(reopened.snapshot().logs.some(l => l.serverId === 'broken' && l.level === 'error'));
  await assert.rejects(reopened.startServer('not-present'), /Unknown server/);
  const { client } = await connect(t, reopened, 'healthy-consumer');
  assert.equal((await client.listTools()).tools.length, 1);
});

test('loopback gateway rejects rebinding Hosts, cross-origin requests and non-MCP routes', async t => {
  const { hub, createHub, dir } = await setup(t);
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(hub.endpoint, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(hub.endpoint, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(hub.endpoint, { headers: { Origin: 'null' } })).status, 403);
  assert.equal((await fetch(hub.endpoint, { headers: { Origin: 'http://127.0.0.1.evil.example' } })).status, 403);
  assert.equal((await fetch(hub.endpoint.replace('/mcp', '/api/servers'))).status, 404);
  assert.equal((await fetch(hub.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(hub.endpoint).origin }, body: '{' })).status, 400);
  await assert.rejects(createHub({ configPath: join(dir, 'other.json'), port: 0, host: '0.0.0.0' }), /loopback/i);
  const { client } = await connect(t, hub, 'allowed-sdk');
  assert.deepEqual((await client.listTools()).tools, []);
});

test('real native child inherits the host environment and Windows cmd shims retain argv boundaries', async t => {
  const { hub, dir } = await setup(t);
  const previous = process.env.HARBOR_INHERITED_TEST;
  process.env.HARBOR_INHERITED_TEST = 'inherited-not-sdk-default';
  t.after(() => { if (previous === undefined) delete process.env.HARBOR_INHERITED_TEST; else process.env.HARBOR_INHERITED_TEST = previous; });
  const config = fixtureConfig();
  const literal = 'literal & with spaces';
  if (process.platform === 'win32') {
    const shim = join(dir, 'fixture shim.cmd');
    await writeFile(shim, `@echo off\r\nchcp 65001 >nul\r\n"${process.execPath}" "${fixturePath}" %*\r\n`);
    config.command = shim; config.args = [literal];
  } else config.args.push(literal);
  await hub.saveServer(config);
  await hub.startServer('fixture');
  const { client } = await connect(t, hub, 'inheritance-check');
  const result = JSON.parse((await client.callTool({ name: (await client.listTools()).tools[0].name, arguments: {} })).content[0].text);
  assert.equal(result.inherited, 'inherited-not-sdk-default');
  assert.deepEqual(result.argv, [literal]);
});

test('gateway bounds slow tool calls and preserves tool failures without breaking later calls', async t => {
  const { hub } = await setup(t, { toolTimeoutMs: 150 });
  await hub.saveServer(fixtureConfig()); await hub.startServer('fixture');
  const { client } = await connect(t, hub, 'timeout-client');
  const name = (await client.listTools()).tools[0].name;
  await assert.rejects(client.callTool({ name, arguments: { delay: 700 } }), /timeout|timed out/i);
  const failed = await client.callTool({ name, arguments: { fail: true } });
  assert.equal(failed.isError, true); assert.equal(failed.content[0].text, 'fixture tool rejected input');
  await assert.rejects(client.callTool({ name, arguments: { throw: true } }), /fixture protocol failure/);
  assert.equal(JSON.parse((await client.callTool({ name, arguments: { text: 'still alive' } })).content[0].text).text, 'still alive');
  assert.equal(hub.snapshot().servers[0].status, 'running');
});

test('a non-MCP child times out initialization and is reaped instead of blocking the manager', async t => {
  const { hub } = await setup(t, { requestTimeoutMs: 250 });
  await hub.saveServer({ ...fixtureConfig(), args: ['-e', 'setInterval(()=>{},1000)'] });
  const started = Date.now();
  const start = hub.startServer('fixture');
  await eventually(() => hub.snapshot().servers[0].pid > 0);
  const pid = hub.snapshot().servers[0].pid;
  await assert.rejects(start, /timeout|timed out/i);
  assert.ok(Date.now() - started < 5000, 'Initialization timeout must honor the configured deadline');
  assert.equal(hub.snapshot().servers[0].status, 'error');
  assert.throws(() => process.kill(pid, 0));
});

test('legacy SSE connections without an endpoint event honor the startup deadline', async t => {
  const { hub } = await setup(t, { requestTimeoutMs: 250 });
  const { port } = await networkFixture(t);
  await hub.saveServer({ id: 'hang', transport: 'sse', url: `http://127.0.0.1:${port}/hang` });
  const before = Date.now();
  await assert.rejects(hub.startServer('hang'), /timeout|timed out/i);
  assert.ok(Date.now() - before < 1200, 'Timeout must cover transport.start, not only initialize');
  assert.equal(hub.snapshot().servers[0].status, 'error');
});

test('stop cancels a pending startup and concurrent lifecycle requests leave one owned process', async t => {
  const { hub } = await setup(t);
  await hub.saveServer({ ...fixtureConfig(), args: ['-e', 'setInterval(()=>{},1000)'] });
  const starting = hub.startServer('fixture');
  const rejection = assert.rejects(starting, /cancel|stop|closed/i);
  await eventually(() => hub.snapshot().servers[0].pid > 0);
  const before = Date.now();
  await hub.stopServer('fixture'); await rejection;
  assert.ok(Date.now() - before < 4000, 'Stop must cancel initialization, not wait its 10-second deadline');
  assert.equal(hub.snapshot().servers[0].status, 'stopped');
  await hub.saveServer(fixtureConfig());
  await Promise.all([hub.startServer('fixture'), hub.startServer('fixture'), hub.restartServer('fixture')]);
  assert.equal(hub.snapshot().servers[0].status, 'running');
  assert.equal(hub.snapshot().tools.length, 1);
  const pid = hub.snapshot().servers[0].pid;
  await hub.removeServer('fixture');
  assert.deepEqual(hub.snapshot().servers, []); assert.throws(() => process.kill(pid, 0));
});

test('close rejects new work immediately and concurrent callers wait for child cleanup', async t => {
  const { hub } = await setup(t);
  await hub.saveServer(fixtureConfig()); await hub.startServer('fixture');
  const pid = hub.snapshot().servers[0].pid;
  const closing = hub.close();
  await assert.rejects(hub.startServer('fixture'), /closed/i);
  await assert.rejects(hub.saveServer(fixtureConfig('late')), /closed/i);
  await Promise.all([closing, hub.close()]);
  assert.throws(() => process.kill(pid, 0));
  await assert.rejects(fetch(hub.endpoint));
});

test('network transport loss removes stale tools and reports upstream errors', async t => {
  const { hub } = await setup(t);
  const { child, port } = await networkFixture(t);
  for (const transport of ['http', 'sse']) {
    await hub.saveServer({ id: transport, transport, url: `http://127.0.0.1:${port}/${transport === 'http' ? 'mcp' : 'sse'}` });
    await hub.startServer(transport);
  }
  child.kill();
  await eventually(() => hub.snapshot().servers.every(s => s.status === 'error'));
  assert.equal(hub.snapshot().tools.length, 0);
  assert.ok(hub.snapshot().servers.every(s => s.error));
});

test('Windows stop reaps the owned process tree, including children that ignore stdin', { skip: process.platform !== 'win32' }, async t => {
  const { hub, dir } = await setup(t);
  const pidFile = join(dir, 'grandchild.pid');
  await hub.saveServer({ ...fixtureConfig(), env: { TREE_PID_FILE: pidFile } });
  await hub.startServer('fixture');
  const childPid = Number(await readFile(pidFile, 'utf8'));
  t.after(() => { try { process.kill(childPid); } catch {} });
  await hub.stopServer('fixture');
  assert.throws(() => process.kill(childPid, 0), 'Owned grandchild must not outlive stop');
});

test('manual stop during restart backoff does not disable future autoRestart', async t => {
  const { hub } = await setup(t);
  await hub.saveServer({ ...fixtureConfig(), autoRestart: true }); await hub.startServer('fixture');
  process.kill(hub.snapshot().servers[0].pid);
  await eventually(() => hub.snapshot().servers[0].status === 'error');
  await hub.stopServer('fixture'); await hub.startServer('fixture');
  const pid = hub.snapshot().servers[0].pid;
  process.kill(pid);
  await eventually(() => hub.snapshot().servers[0].status === 'running' && hub.snapshot().servers[0].pid !== pid);
});

test('mutation results are isolated and disk failures leave configuration intact', async t => {
  const { hub, dir, createHub } = await setup(t);
  const imported = await hub.importConfig({ mcpServers: { imported: { command: process.execPath, args: ['-v'] } } });
  if (Array.isArray(imported)) imported[0].name = 'mutated-outside';
  assert.equal(hub.snapshot().servers[0].name, 'imported');
  await Promise.all(['a', 'b', 'c'].map(id => hub.saveServer(fixtureConfig(id))));
  assert.equal(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).servers.length, 4);
  const before = hub.snapshot().servers;
  await rm(join(dir, 'config.json')); await mkdir(join(dir, 'config.json'));
  await assert.rejects(hub.saveServer(fixtureConfig('write-fails')));
  assert.deepEqual(hub.snapshot().servers, before);
  assert.equal((await readdir(dir)).some(name => name.endsWith('.tmp')), false);
  await writeFile(join(dir, 'corrupt.json'), '{not json');
  await assert.rejects(createHub({ configPath: join(dir, 'corrupt.json'), port: 0 }), /JSON|property name/i);
  assert.equal(await readFile(join(dir, 'corrupt.json'), 'utf8'), '{not json');
});

test('an HTTP server that ignores session termination cannot block stop', async t => {
  const { hub } = await setup(t, { requestTimeoutMs: 300 });
  const { port } = await networkFixture(t, { HANG_DELETE: '1' });
  await hub.saveServer({ id: 'http', transport: 'http', url: `http://127.0.0.1:${port}/mcp` });
  await hub.startServer('http');
  const before = Date.now(); await hub.stopServer('http');
  assert.ok(Date.now() - before < 1200, 'DELETE must have a deadline');
  assert.equal(hub.snapshot().servers[0].status, 'stopped');
});

test('configuration CRUD persists only configuration and refuses invalid imports atomically', async t => {
  const { hub, dir, createHub } = await setup(t);
  assert.deepEqual(hub.snapshot().servers, []);
  const config = { id: 'alpha', name: 'Alpha', transport: 'stdio', runtime: 'native', command: process.execPath, args: ['-v'], env: { EXAMPLE: 'yes' }, autoStart: false, autoRestart: false };
  await hub.saveServer(config);
  assert.equal(hub.snapshot().servers[0].status, 'stopped');
  await hub.saveServer({ ...config, name: 'Renamed' });
  await hub.importConfig({ mcpServers: { web: { url: 'http://localhost:9876/mcp' } } });
  await assert.rejects(hub.importConfig({ mcpServers: { extra: { command: 'node' }, alpha: { command: 'node' } } }), /collision|exists/i);
  await assert.rejects(hub.saveServer({ ...config, id: 'bad id' }), /id/i);
  await assert.rejects(hub.saveServer({ ...config, args: 'bad' }), /args/i);
  const persisted = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  assert.equal(JSON.stringify(persisted).includes('status'), false);
  assert.equal(JSON.stringify(persisted).includes('Renamed'), true);
  await hub.close();
  const reopened = await createHub({ configPath: join(dir, 'config.json'), port: 0 });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.snapshot().servers.map(s => s.id), ['alpha', 'web']);
  await reopened.removeServer('alpha');
  assert.deepEqual(reopened.snapshot().servers.map(s => s.id), ['web']);
  assert.doesNotThrow(() => JSON.stringify(reopened.snapshot()));
});
