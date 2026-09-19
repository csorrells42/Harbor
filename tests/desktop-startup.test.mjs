import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Module, createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';

const mainPath = fileURLToPath(new URL('../src/desktop/main.cjs', import.meta.url));
const source = await readFile(mainPath, 'utf8');
const fixture = fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url));
const require = createRequire(import.meta.url);

async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for desktop lifecycle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function status(endpoint) {
  return new Promise((resolve, reject) => {
    const req = request(endpoint, { agent: false }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }

// Execute unchanged main code with only Electron/host lifecycle boundaries replaced.
// Real dynamic imports create a real hub, listener and auto-started SDK child.
async function desktop(t, { failure = 'BrowserWindow', closeMode, destroyFails = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'harbor-desktop-startup-'));
  await writeFile(path.join(dir, 'servers.json'), JSON.stringify({ version: 1, servers: [{ id: 'fixture', command: process.execPath, args: [fixture], autoStart: true }] }));
  const events = [], errors = [], handlers = new Map(), timers = new Set();
  let runtime, startup, exited = false, closeCalls = 0, originalClose, pid;
  const app = new EventEmitter();
  Object.assign(app, {
    setName() {}, setPath() {}, requestSingleInstanceLock: () => true,
    getPath: () => dir, getVersion: () => '0.2.0',
    whenReady: () => ({ then: start => ({ catch: handle => { startup = Promise.resolve().then(start).catch(handle); return startup; } }) }),
    quit() {
      let prevented = false;
      app.emit('before-quit', { preventDefault() { prevented = true; } });
      if (!prevented) { events.push('exit'); exited = true; }
    },
    exit(code) { events.push(`forced:${code}`); exited = true; }
  });
  function captureHub() {
    if (originalClose) return;
    originalClose = runtime.hub.close.bind(runtime.hub);
    runtime.hub.close = () => {
      closeCalls++; events.push('close');
      if (closeMode === 'hang') return new Promise(() => {});
      if (closeMode === 'throw') throw new Error('close failed synchronously');
      return originalClose().then(() => events.push('closed'));
    };
  }
  class BrowserWindow extends EventEmitter {
    constructor() {
      super(); captureHub();
      if (failure === 'BrowserWindow') throw new Error('BrowserWindow failed');
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: pathToFileURL(path.resolve(path.dirname(mainPath), '../ui/index.html')).href },
        setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {} }
      });
    }
    async loadFile() {
      await until(() => runtime.hub.snapshot().servers[0].status === 'running');
      pid = runtime.hub.snapshot().servers[0].pid;
      assert.ok(alive(pid));
      if (failure === 'loadFile') throw new Error('loadFile failed');
    }
    show() {} isMinimized() { return false; } focus() {} hide() {}
  }
  class Tray extends EventEmitter {
    constructor() { super(); if (failure === 'Tray') throw new Error('Tray failed'); }
    setToolTip() {} setContextMenu() {}
    destroy() { events.push('tray-destroy'); if (destroyFails) throw new Error('tray destroy failed'); }
  }
  const electron = { app, BrowserWindow, Tray, Menu: { buildFromTemplate: value => value }, nativeImage: { createFromBitmap() {} }, ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, clipboard: { writeText: text => events.push(['clipboard', text]) }, dialog: { showErrorBox: (_title, message) => errors.push(message), showOpenDialog: async () => ({ canceled: true }) } };
  const localSetTimeout = (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer; };
  const compiled = new Module(mainPath);
  compiled.filename = mainPath;
  compiled._compile(`module.exports = (require, process, console, setTimeout, clearTimeout) => {\n${source}\nreturn { get hub() { return hub; }, get window() { return window; }, set maintenance(value) { maintenance=value; }, set diagnosticsPromise(value) { diagnosticsPromise=value; } };\n};`, mainPath);
  runtime = compiled.exports(name => name === 'electron' ? electron : require(name), { env: { HARBOR_DATA_DIR: dir, HARBOR_PORT: '0' }, platform: process.platform }, { error: error => errors.push(error.message) }, localSetTimeout, timer => timers.delete(timer));
  t.after(async () => { if (runtime.hub) await (originalClose ?? runtime.hub.close.bind(runtime.hub))(); await rm(dir, { recursive: true, force: true }); });
  await startup;
  return { runtime, app, events, errors, handlers, timers, get exited() { return exited; }, get closeCalls() { return closeCalls; }, get pid() { return pid; } };
}

test('synchronous hub cleanup failure cannot prevent bounded desktop shutdown', async t => {
  const d = await desktop(t, { closeMode: 'throw' });
  await until(() => d.exited);
  assert.equal(d.closeCalls, 1);
  assert.deepEqual(d.events, ['close', 'exit']);
  assert.equal(d.timers.size, 0);
  assert.ok(d.errors.includes('close failed synchronously'));
});

test('tray destruction failure cannot strand startup shutdown after real child cleanup', async t => {
  const d = await desktop(t, { failure: 'loadFile', destroyFails: true });
  await until(() => d.events.includes('tray-destroy'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(d.exited, true);
  assert.equal(d.closeCalls, 1);
  assert.equal(alive(d.pid), false);
  await assert.rejects(status(d.runtime.hub.endpoint));
  assert.equal(d.timers.size, 0);
  assert.ok(d.errors.includes('tray destroy failed'));
});

for (const failure of ['BrowserWindow', 'Tray', 'loadFile']) {
  test(`${failure} startup failure closes the created hub before desktop exit`, async t => {
    const d = await desktop(t, { failure });
    await until(() => d.exited);
    assert.equal(d.closeCalls, 1);
    assert.deepEqual(d.events, ['close', 'closed', ...(failure === 'loadFile' ? ['tray-destroy'] : []), 'exit']);
    assert.equal(d.runtime.hub.snapshot().servers[0].status, 'stopped');
    if (d.pid) assert.equal(alive(d.pid), false);
    await assert.rejects(status(d.runtime.hub.endpoint));
    assert.equal(d.timers.size, 0);
    assert.ok(d.errors.some(error => error.includes(`${failure} failed`)));
  });
}

test('startup shutdown has a 12-second fallback and repeated quit does not duplicate cleanup', async t => {
  const d = await desktop(t, { closeMode: 'hang' });
  await until(() => d.closeCalls === 1);
  assert.equal(d.closeCalls, 1);
  assert.equal(d.exited, false);
  d.app.quit(); d.app.quit();
  assert.equal(d.closeCalls, 1);
  assert.equal(d.timers.size, 1);
  const [timer] = d.timers;
  assert.equal(timer.ms, 12000);
  d.timers.delete(timer); timer.fn();
  assert.equal(d.exited, true);
  assert.deepEqual(d.events, ['close', 'forced:0']);
});

test('every desktop IPC handler rejects foreign windows, subframes and navigated main frames', async t => {
  const d = await desktop(t, { failure: null });
  const sender = d.runtime.window.webContents;
  const senderFrame = sender.mainFrame;
  const entry = senderFrame.url;
  for (const handler of d.handlers.values()) {
    assert.throws(() => handler({ sender: { mainFrame: senderFrame }, senderFrame }), /Untrusted window/);
    assert.throws(() => handler({ sender, senderFrame: { url: entry } }), /Untrusted window/);
    senderFrame.url = 'https://untrusted.example/';
    try { assert.throws(() => handler({ sender, senderFrame }), /Untrusted window/); }
    finally { senderFrame.url = entry; }
  }
  assert.equal(d.handlers.has('harbor:execute'), false);
  assert.deepEqual(d.handlers.get('harbor:getSettings')({ sender, senderFrame }), d.runtime.hub.getSettings());
  assert.deepEqual(d.events, []);
  assert.ok(alive(d.pid));
  d.app.quit();
  await until(() => d.exited);
  assert.equal(alive(d.pid), false);
});

for (const failed of ['maintenance','diagnostics']) {
  test(`${failed} shutdown failure still closes the remaining services and real upstream child`, async t => {
    const d=await desktop(t,{failure:null}),closed=[];
    d.runtime.maintenance={async close(){closed.push('maintenance');if(failed==='maintenance')throw Error('maintenance close failed');}};
    d.runtime.diagnosticsPromise=Promise.resolve({async close(){closed.push('diagnostics');if(failed==='diagnostics')throw Error('diagnostics close failed');}});
    d.app.quit();await until(()=>d.exited);
    assert.deepEqual(closed,['maintenance','diagnostics']);
    assert.equal(d.closeCalls,1);assert.equal(alive(d.pid),false);
    await assert.rejects(status(d.runtime.hub.endpoint));
    assert.equal(d.timers.size,0);assert(d.errors.includes(`${failed} close failed`));
  });
}
