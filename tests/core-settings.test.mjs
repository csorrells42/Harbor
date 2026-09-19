import {SEARCH_DEFAULTS} from '../src/core/delivery-options.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, mkdir, readdir, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import os, { tmpdir, networkInterfaces, hostname } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHub } from '../src/core/hub.mjs';

async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'harbor-settings-'));
  const configPath = join(dir, 'config.json');
  const hub = await createHub({ configPath, port: 0, ...options });
  t.after(async () => { await hub.close(); await rm(dir, { recursive: true, force: true }); });
  return { hub, dir, configPath, settingsPath: options.settingsPath ?? join(dir, 'harbor-settings.json') };
}
async function connect(t, endpoint, headers = {}) {
  const client = new Client({ name: 'settings-test', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers }, reconnectionOptions: { maxRetries: 0 } });
  t.after(() => client.close());
  await client.connect(transport);
  return { client, transport };
}
async function listen(host = '127.0.0.1', port = 0) {
  const server = createServer((req, res) => res.end());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return server;
}
async function closeServer(server) { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
async function freePort() { const server = await listen(); const port = server.address().port; await closeServer(server); return port; }
async function status(endpoint, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request(endpoint, { headers, method, agent: false }, res => { res.resume(); resolve({ status: res.statusCode, headers: res.headers }); });
    req.on('error', reject); req.end();
  });
}
const fixture = fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url));
async function child(hub) {
  await hub.saveServer({ id: 'fixture', command: process.execPath, args: [fixture] });
  await hub.startServer('fixture');
  return hub.snapshot().servers[0].pid;
}
async function echo(client, args = {}) {
  const name = (await client.listTools()).tools[0].name;
  return JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
}

test('applying a new port and MCP path moves real SDK clients without restarting the shared child', async t => {
  const { hub, configPath, settingsPath } = await setup(t);
  const pid = await child(hub);
  const old = hub.endpoint;
  const first = await connect(t, old);
  assert.equal((await echo(first.client)).count, 1);
  const next = { ...hub.getSettings(), port: await freePort(), mcpPath: '/custom/mcp' };
  await hub.updateSettings(next);
  assert.equal(hub.endpoint, `http://127.0.0.1:${next.port}/custom/mcp`);
  assert.equal(hub.snapshot().endpoint, hub.endpoint);
  assert.equal(hub.snapshot().endpoints.local, hub.endpoint);
  await assert.rejects(status(old));
  assert.equal((await status(hub.endpoint.replace('/custom/mcp', '/mcp'))).status, 404);
  const second = await connect(t, hub.endpoint);
  assert.equal(second.client.getServerVersion().version, '0.2.0');
  const result = await echo(second.client);
  assert.equal(result.pid, pid); assert.equal(result.count, 2);
  assert.equal(hub.snapshot().servers[0].status, 'running');
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), next);
  await hub.close();
  const reopened = await createHub({ configPath });
  t.after(() => reopened.close());
  assert.equal(reopened.endpoint, `http://127.0.0.1:${next.port}/custom/mcp`);
  assert.deepEqual((await (await connect(t, reopened.endpoint)).client.listTools()).tools, []);
});

test('inactive saved bind survives interface disappearance while active unavailable binds still reject', async t => {
  const { hub, configPath, settingsPath } = await setup(t);
  let interfaces = { vpn: [{ address: '192.0.2.10', family: 'IPv4', internal: false }] };
  const original = os.networkInterfaces;
  t.after(() => { os.networkInterfaces = original; syncBuiltinESMExports(); });
  os.networkInterfaces = () => interfaces;
  syncBuiltinESMExports();
  const saved = { ...hub.getSettings(), bindAddress: '192.0.2.10' };
  await hub.updateSettings(saved);
  await hub.close();
  interfaces = {};
  const reopened = await createHub({ configPath });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.getSettings(), saved);
  assert.equal(new URL(reopened.endpoint).hostname, '127.0.0.1');
  await connect(t, reopened.endpoint);
  await reopened.updateSettings({ ...saved, toolTimeoutMs: 5000 });
  assert.equal(reopened.getSettings().bindAddress, saved.bindAddress);
  const bytes = await readFile(settingsPath, 'utf8');
  await assert.rejects(reopened.updateSettings({ ...reopened.getSettings(), networkEnabled: true }), /bindAddress/);
  assert.equal(await readFile(settingsPath, 'utf8'), bytes);
  await connect(t, reopened.endpoint);
});

test('explicit network opt-in rebinds the same port and advertises only reachable interface addresses', async t => {
  const { hub, configPath } = await setup(t);
  const pid = await child(hub);
  const original = hub.endpoint;
  const ip = Object.values(networkInterfaces()).flat().find(i => !i.internal && i.family === 'IPv4').address;
  const lan = original.replace('127.0.0.1', ip);
  await assert.rejects(status(lan));
  await hub.updateSettings({ ...hub.getSettings(), networkEnabled: true });
  assert.equal(hub.endpoint, original);
  assert.equal(hub.snapshot().endpoints.bindAddress, '0.0.0.0');
  assert.ok(hub.snapshot().endpoints.network.includes(lan));
  for (const endpoint of hub.snapshot().endpoints.network) {
    assert.notEqual(new URL(endpoint).hostname, '0.0.0.0');
    const { client } = await connect(t, endpoint);
    assert.equal((await echo(client)).pid, pid);
  }
  assert.equal((await status(lan, { Host: `evil.example:${hub.getSettings().port}` })).status, 403);
  assert.equal((await status(lan, { Host: `${ip}:1` })).status, 403);
  assert.equal((await status(lan, { Origin: 'https://arbitrary.example' })).status, 403);
  assert.equal((await status(lan.replace('/mcp', '/api/servers'))).status, 404);
  await hub.close();
  const reopened = await createHub({ configPath });
  t.after(() => reopened.close());
  assert.equal(reopened.snapshot().endpoints.bindAddress, '0.0.0.0');
  await connect(t, lan);
  await reopened.updateSettings({ ...reopened.getSettings(), networkEnabled: false });
  assert.deepEqual(reopened.snapshot().endpoints.network, []);
  await assert.rejects(status(lan));
  await connect(t, reopened.endpoint);
});

test('wildcard Host and Origin policy tracks interface changes without restarting live SDK sessions', async t => {
  const { hub } = await setup(t);
  let address = '192.0.2.10';
  const original = os.networkInterfaces;
  t.after(() => { os.networkInterfaces = original; syncBuiltinESMExports(); });
  os.networkInterfaces = () => ({ lan: [{ address, family: 'IPv4', internal: false }] });
  syncBuiltinESMExports();
  await hub.updateSettings({ ...hub.getSettings(), networkEnabled: true });
  const { client, transport } = await connect(t, hub.endpoint);
  const session = transport.sessionId;
  const authority = ip => `${ip}:${hub.getSettings().port}`;
  assert.equal((await status(hub.endpoint, { Host: authority(address) })).status, 400);
  address = '192.0.2.20';
  // Use a real loopback HTTP request with explicit Host, not a real NIC mutation.
  assert.equal((await status(hub.endpoint, { Host: authority(address), Origin: `http://${authority(address)}` })).status, 400);
  assert.equal((await status(hub.endpoint, { Host: authority('192.0.2.10') })).status, 403);
  assert.equal((await status(hub.endpoint, { Origin: `http://${authority('192.0.2.10')}` })).status, 403);
  assert.equal((await status(hub.endpoint, { Host: authority('evil.example') })).status, 403);
  assert.deepEqual((await client.listTools()).tools, []);
  assert.equal(transport.sessionId, session);
});

test('wildcard snapshots refresh advertised addresses after network changes and unchanged settings reapply', async t => {
  const { hub } = await setup(t);
  let addresses = ['192.0.2.10'];
  const original = os.networkInterfaces;
  t.after(() => { os.networkInterfaces = original; syncBuiltinESMExports(); });
  os.networkInterfaces = () => ({ lan: addresses.map(address => ({ address, family: 'IPv4', internal: false })) });
  syncBuiltinESMExports();
  await hub.updateSettings({ ...hub.getSettings(), networkEnabled: true });
  const endpoints = () => addresses.map(address => hub.endpoint.replace('127.0.0.1', address));
  assert.deepEqual(hub.snapshot().endpoints.network, endpoints());
  addresses = ['192.0.2.20'];
  assert.deepEqual(hub.snapshot().endpoints.network, endpoints());
  addresses = ['192.0.2.30'];
  await hub.updateSettings(hub.getSettings());
  assert.deepEqual(hub.snapshot().endpoints.network, endpoints());
  addresses = [];
  assert.deepEqual(hub.snapshot().endpoints.network, []);
  await connect(t, hub.endpoint);
});

test('timeout-only changes apply to existing SDK sessions and future child discovery without restarting healthy children', async t => {
  const { hub } = await setup(t);
  const pid = await child(hub);
  const { client, transport } = await connect(t, hub.endpoint);
  const session = transport.sessionId;
  await hub.updateSettings({ ...hub.getSettings(), toolTimeoutMs: 1000, requestTimeoutMs: 1000 });
  await assert.rejects(echo(client, { delay: 1600 }), /timeout|timed out/i);
  assert.equal(transport.sessionId, session);
  assert.equal((await echo(client, { text: 'healthy' })).pid, pid);
  const script = (await readFile(fixture, 'utf8')).replace('const index =', 'await new Promise(r => setTimeout(r, 4000)); const index =');
  await hub.saveServer({ id: 'slow-discovery', command: process.execPath, args: ['--input-type=module', '-e', script], cwd: fileURLToPath(new URL('../', import.meta.url)) });
  // startServer also awaits child cleanup; verify the deadline independently of that latency.
  await assert.rejects(hub.startServer('slow-discovery'), error => {
    assert.match(error.message, /timeout|timed out/i);
    assert.ok((error.code === -32001 && error.data?.timeout === 1000) || error.message === 'Operation timed out after 1000 ms', 'new discovery must use the configured 1000 ms deadline');
    return true;
  });
  assert.equal(hub.snapshot().servers.find(s => s.id === 'fixture').pid, pid);
});

test('explicit browser origins get validated MCP preflights and real SDK responses without weakening Host checks', async t => {
  const { hub } = await setup(t);
  const origin = 'https://client.example';
  const headers = { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,mcp-session-id,mcp-protocol-version,last-event-id,accept' };
  assert.equal((await status(hub.endpoint, headers, 'OPTIONS')).status, 403);
  await hub.updateSettings({ ...hub.getSettings(), allowedOrigins: [origin] });
  const preflight = await status(hub.endpoint, headers, 'OPTIONS');
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], origin);
  assert.match(preflight.headers['access-control-allow-methods'], /POST/);
  assert.match(preflight.headers['access-control-allow-headers'], /mcp-session-id/i);
  assert.match(preflight.headers.vary, /Origin/i);
  assert.equal((await status(hub.endpoint, { ...headers, 'Access-Control-Request-Method': 'PUT' }, 'OPTIONS')).status, 403);
  assert.equal((await status(hub.endpoint, { ...headers, 'Access-Control-Request-Headers': 'x-unsafe' }, 'OPTIONS')).status, 403);
  assert.equal((await status(hub.endpoint, { ...headers, Host: 'evil.example' }, 'OPTIONS')).status, 403);
  const actual = await status(hub.endpoint, { Origin: origin });
  assert.equal(actual.headers['access-control-allow-origin'], origin);
  assert.match(actual.headers['access-control-expose-headers'], /mcp-session-id/i);
  const { client } = await connect(t, hub.endpoint, { Origin: origin });
  assert.deepEqual((await client.listTools()).tools, []);
  await hub.updateSettings({ ...hub.getSettings(), allowedOrigins: [] });
  assert.equal((await status(hub.endpoint, { Origin: origin })).status, 403);
  assert.equal((await status(hub.endpoint, { Origin: 'null' })).status, 403);
});

test('shutdown rejects HTTP work while child cleanup is pending and settings updates cannot resurrect a listener', async t => {
  const { hub, settingsPath } = await setup(t);
  await child(hub);
  const { client } = await connect(t, hub.endpoint);
  const tool = (await client.listTools()).tools[0].name;
  const pending = client.callTool({ name: tool, arguments: { delay: 1600 } }).catch(() => {});
  // An established HTTP request proves the child is busy before close starts.
  await new Promise(r => setTimeout(r, 60));
  const closing = hub.close();
  const response = await status(hub.endpoint).catch(() => ({ status: 503 }));
  assert.equal(response.status, 503);
  await assert.rejects(hub.updateSettings(hub.getSettings()), /closed/i);
  await Promise.all([closing, hub.close(), pending]);
  await assert.rejects(status(hub.endpoint));
  await assert.rejects(readFile(settingsPath), { code: 'ENOENT' });
});

test('occupied ports roll back settings and preserve connected child state including same-port host switches', async t => {
  const { hub, settingsPath } = await setup(t);
  const pid = await child(hub);
  const { client } = await connect(t, hub.endpoint);
  const before = hub.getSettings();
  await hub.updateSettings(before);
  const bytes = await readFile(settingsPath, 'utf8');
  const occupied = await listen();
  t.after(() => closeServer(occupied));
  await assert.rejects(hub.updateSettings({ ...before, port: occupied.address().port }), /EADDRINUSE/);
  assert.equal((await echo(client)).pid, pid);
  const ip = Object.values(networkInterfaces()).flat().find(i => !i.internal && i.family === 'IPv4').address;
  const samePort = await listen(ip, before.port);
  t.after(() => closeServer(samePort));
  await assert.rejects(hub.updateSettings({ ...before, networkEnabled: true, bindAddress: ip }), /EADDRINUSE/);
  assert.deepEqual(hub.getSettings(), before);
  assert.equal(await readFile(settingsPath, 'utf8'), bytes);
  assert.equal((await echo(client)).pid, pid);
  assert.deepEqual(hub.snapshot().endpoints.network, []);
});

test('real persistence failure releases candidate sockets and restores the old listener and session', async t => {
  const { hub, settingsPath, dir } = await setup(t);
  const pid = await child(hub);
  const { client } = await connect(t, hub.endpoint);
  const before = hub.getSettings();
  await hub.updateSettings(before);
  await rm(settingsPath); await mkdir(settingsPath);
  const port = await freePort();
  for (const patch of [{ port, mcpPath: '/candidate' }, { networkEnabled: true }, { mcpPath: '/same-port' }, { toolTimeoutMs: 1000 }]) {
    await assert.rejects(hub.updateSettings({ ...before, ...patch }), /EISDIR|EPERM|EACCES/);
    assert.deepEqual(hub.getSettings(), before);
    assert.equal((await echo(client)).pid, pid);
    assert.deepEqual(hub.snapshot().endpoints.network, []);
    assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  }
  const released = await listen('127.0.0.1', port);
  await closeServer(released);
  await rm(settingsPath, { recursive: true });
  await hub.updateSettings({ ...before, mcpPath: '/recovered' });
  assert.equal((await status(`http://127.0.0.1:${before.port}/mcp`)).status, 404);
  assert.equal((await echo((await connect(t, hub.endpoint)).client)).pid, pid);
});

test('literal IPv6 binds have connectable bracketed endpoints and inactive bind drafts remain loopback', async t => {
  const { hub } = await setup(t);
  const initial = hub.endpoint;
  const expandedLoopback = '0:0:0:0:0:0:0:1';
  await hub.updateSettings({ ...hub.getSettings(), bindAddress: expandedLoopback });
  assert.equal(hub.endpoint, initial);
  assert.equal(hub.snapshot().endpoints.bindAddress, '127.0.0.1');
  await hub.updateSettings({ ...hub.getSettings(), networkEnabled: true });
  assert.equal(new URL(hub.endpoint).hostname, '[::1]');
  assert.equal(hub.getSettings().bindAddress, expandedLoopback);
  assert.deepEqual(hub.snapshot().endpoints.network, []);
  await connect(t, hub.endpoint);
  await assert.rejects(status(initial));
  await hub.updateSettings({ ...hub.getSettings(), bindAddress: '::' });
  assert.equal(new URL(hub.endpoint).hostname, '[::1]');
  assert.ok(hub.snapshot().endpoints.network.length > 0);
  for (const endpoint of hub.snapshot().endpoints.network) await connect(t, endpoint);
  await hub.updateSettings({ ...hub.getSettings(), networkEnabled: false });
  assert.equal(hub.endpoint, initial);
  await connect(t, hub.endpoint);
});

test('queued settings mutations capture caller input and serialize complete persistent snapshots', async t => {
  const { hub, settingsPath } = await setup(t);
  const base = hub.getSettings();
  const first = { ...base, mcpPath: '/one', allowedOrigins: ['https://one.example'] };
  const second = { ...base, port: await freePort(), mcpPath: '/two' };
  const saving = hub.updateSettings(first);
  first.port = 65536; first.allowedOrigins.push('https://mutated.example');
  const third = { ...base, mcpPath: '/three' };
  const results = await Promise.all([saving, hub.updateSettings(second), hub.updateSettings(third)]);
  assert.equal(results[0].port, base.port);
  assert.deepEqual(results[0].allowedOrigins, ['https://one.example']);
  assert.deepEqual(hub.getSettings(), third);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), third);
  await assert.rejects(status(`http://127.0.0.1:${second.port}/two`));
  await connect(t, hub.endpoint);
});

test('network policy changes on the same literal host apply without replacing a healthy session', async t => {
  const { hub } = await setup(t);
  const { client, transport } = await connect(t, hub.endpoint);
  const session = transport.sessionId;
  const host = `${hostname()}:${hub.getSettings().port}`;
  assert.equal((await status(hub.endpoint, { Host: host })).status, 403);
  await hub.updateSettings({ ...hub.getSettings(), networkEnabled: true, bindAddress: '127.0.0.1' });
  assert.equal((await status(hub.endpoint, { Host: host })).status, 400);
  assert.equal(transport.sessionId, session);
  assert.deepEqual((await client.listTools()).tools, []);
  await hub.updateSettings({ ...hub.getSettings(), networkEnabled: false });
  assert.equal((await status(hub.endpoint, { Host: host })).status, 403);
});

test('close during a real atomic settings write waits for completion and reaps every candidate socket', async t => {
  const { hub, dir, settingsPath } = await setup(t);
  const oldEndpoint = hub.endpoint;
  await hub.updateSettings(hub.getSettings());
  const next = { ...hub.getSettings(), port: await freePort(), mcpPath: '/race', allowedOrigins: Array.from({ length: 3000 }, (_, i) => `https://client-${i}.example`) };
  let closing;
  // Expand Windows short-path aliases before libuv compares event paths.
  const watcher = watch(await realpath(dir), (event, name) => { if (name?.endsWith('.tmp') && !closing) closing = hub.close(); });
  t.after(() => watcher.close());
  const update = hub.updateSettings(next);
  const queued = hub.updateSettings({ ...next, mcpPath: '/queued' });
  const settled = await Promise.allSettled([update, queued]);
  assert.ok(closing, 'filesystem watcher observed the in-flight atomic write');
  await closing;
  assert.equal(settled[1].status, 'rejected');
  assert.match(settled[1].reason.message, /closed/i);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), hub.getSettings());
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await assert.rejects(status(oldEndpoint));
  await assert.rejects(status(`http://127.0.0.1:${next.port}/race`));
  const available = await listen('127.0.0.1', next.port);
  await closeServer(available);
});

test('custom settings files and explicit startup overrides never silently rewrite stored preferences', async t => {
  const { hub, dir, configPath, settingsPath } = await setup(t);
  const saved = { ...hub.getSettings(), requestTimeoutMs: 3000, toolTimeoutMs: 6000 };
  await hub.updateSettings(saved); await hub.close();
  const bytes = await readFile(settingsPath, 'utf8');
  const overridden = await createHub({ configPath, port: 0, host: '::1', requestTimeoutMs: 150, toolTimeoutMs: 200 });
  t.after(() => overridden.close());
  assert.equal(overridden.getSettings().requestTimeoutMs, 150);
  assert.equal(overridden.getSettings().toolTimeoutMs, 200);
  assert.equal(new URL(overridden.endpoint).hostname, '[::1]');
  await connect(t, overridden.endpoint);
  assert.equal(await readFile(settingsPath, 'utf8'), bytes);
  const customPath = join(dir, 'custom', 'settings.json');
  const custom = await createHub({ configPath, settingsPath: customPath, port: 0 });
  t.after(() => custom.close());
  assert.equal(custom.getSettings().requestTimeoutMs, 60000);
  await custom.updateSettings(custom.getSettings());
  assert.equal(await readFile(settingsPath, 'utf8'), bytes);
  assert.deepEqual(JSON.parse(await readFile(customPath, 'utf8')), custom.getSettings());
});

test('binding a specific local IPv4 address advertises only that socket, including alternate loopback literals', async t => {
  const { hub } = await setup(t);
  const ip = Object.values(networkInterfaces()).flat().find(i => !i.internal && i.family === 'IPv4').address;
  await hub.updateSettings({ ...hub.getSettings(), networkEnabled: true, bindAddress: ip });
  assert.equal(new URL(hub.endpoint).hostname, ip);
  assert.deepEqual(hub.snapshot().endpoints.network, [hub.endpoint]);
  await connect(t, hub.endpoint);
  await hub.updateSettings({ ...hub.getSettings(), bindAddress: '127.0.0.2' });
  assert.equal(new URL(hub.endpoint).hostname, '127.0.0.2');
  assert.deepEqual(hub.snapshot().endpoints.network, []);
  await connect(t, hub.endpoint);
});

test('HTTP default port remains a valid persistent port and accepts standard SDK Host formatting', async t => {
  let reservation;
  try { reservation = await listen('127.0.0.1', 80); }
  catch (error) { if (['EADDRINUSE', 'EACCES'].includes(error.code)) { t.skip('Port 80 unavailable on this host'); return; } throw error; }
  await closeServer(reservation);
  const { hub, configPath } = await setup(t);
  await hub.updateSettings({ ...hub.getSettings(), port: 80 });
  await connect(t, hub.endpoint);
  assert.equal((await status(hub.endpoint, { Origin: 'http://127.0.0.1' })).status, 400);
  await hub.close();
  const reopened = await createHub({ configPath });
  t.after(() => reopened.close());
  assert.equal(reopened.getSettings().port, 80);
  await connect(t, reopened.endpoint);
});

test('invalid full settings never change the listener or persistent state', async t => {
  const { hub, settingsPath, configPath, dir } = await setup(t);
  const before = hub.getSettings();
  await hub.updateSettings(before);
  const bytes = await readFile(settingsPath, 'utf8');
  for (const patch of [
    { port: 0 }, { port: 65536 }, { port: 1.5 }, { port: '37373' },
    { networkEnabled: 'true' }, { bindAddress: 'localhost' }, { bindAddress: 'evil.example' }, { bindAddress: '203.0.113.88', networkEnabled: true },
    { mcpPath: '/api' }, { mcpPath: '/api/servers' }, { mcpPath: '/%61pi/servers' }, { mcpPath: '/x/../api' },
    { mcpPath: '//mcp' }, { mcpPath: '/mcp?x' }, { mcpPath: '/mcp#x' }, { mcpPath: 'mcp' }, { mcpPath: '/mcp\\\\other' },
    { requestTimeoutMs: 999 }, { toolTimeoutMs: 3600001 }, { toolTimeoutMs: 1000.5 },
    { allowedOrigins: ['*'] }, { allowedOrigins: ['https://*.example.com'] }, { allowedOrigins: ['null'] }, { allowedOrigins: ['file:///'] },
    { mcpPath: '/mcp%00' }, { mcpPath: '/mcp%0a' },
    { allowedOrigins: ['https://example.com/path'] }, { allowedOrigins: ['https://user:pass@example.com'] },
    { allowedOrigins: 'https://example.com' }, { allowedOrigins: ['https://example.com/'] },
  ]) {
    await assert.rejects(hub.updateSettings({ ...before, ...patch }), undefined, JSON.stringify(patch));
    assert.deepEqual(hub.getSettings(), before);
    assert.equal(await readFile(settingsPath, 'utf8'), bytes);
  }
  await assert.rejects(hub.updateSettings({ port: before.port }));
  await assert.rejects(hub.updateSettings(null));
  assert.deepEqual((await (await connect(t, hub.endpoint)).client.listTools()).tools, []);
  const corruptPath = join(dir, 'bad-settings.json');
  await writeFile(corruptPath, '{bad');
  await assert.rejects(createHub({ configPath, settingsPath: corruptPath, port: 0 }), /JSON|property/i);
  await writeFile(corruptPath, JSON.stringify({ ...before, networkEnabled: 'yes' }));
  await assert.rejects(createHub({ configPath, settingsPath: corruptPath, port: 0 }), /networkEnabled/i);
});

test('This Server settings default to loopback and persist isolated active settings across reopen', async t => {
  const { hub, dir, configPath, settingsPath } = await setup(t);
  const defaults = { port: Number(new URL(hub.endpoint).port), networkEnabled: false, bindAddress: '0.0.0.0', mcpPath: '/mcp', requestTimeoutMs: 60000, toolTimeoutMs: 120000, allowedOrigins: [], toolMode:'all',...SEARCH_DEFAULTS };
  assert.deepEqual(hub.getSettings(), defaults);
  assert.deepEqual(hub.snapshot().settings, defaults);
  assert.deepEqual(hub.snapshot().endpoints, { local: hub.endpoint, network: [], bindAddress: '127.0.0.1' });
  await assert.rejects(readFile(settingsPath), { code: 'ENOENT' });
  const next = { ...defaults, requestTimeoutMs: 4000, toolTimeoutMs: 8000 };
  const saved = await hub.updateSettings(next);
  saved.allowedOrigins.push('https://outside.example');
  hub.getSettings().allowedOrigins.push('https://mutation.example');
  assert.deepEqual(hub.getSettings(), next);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), next);
  assert.deepEqual((await connect(t, hub.endpoint)).client ? hub.snapshot().settings : null, next);
  await hub.close();
  const reopened = await createHub({ configPath });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.getSettings(), next);
  assert.deepEqual((await (await connect(t, reopened.endpoint)).client.listTools()).tools, []);
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
});
