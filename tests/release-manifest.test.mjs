import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {captureManifest, verifyManifest, validatePlan, validatePayloadPath} from '../scripts/portable/release-manifest.mjs';

const source = {repository: 'https://github.com/csorrells42/Harbor', revision: '1'.repeat(40)};
const makePlan = () => ({schemaVersion: 1, release: '0.2.0-fixture', source,
  components: [{id: 'harbor', role: 'application', version: '0.2.0', acquisition: null, paths: ['application/current']}]});
const cli = fileURLToPath(new URL('../scripts/portable/release-manifest.mjs', import.meta.url));

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-manifest-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const root = path.join(dir, 'Original payload');
  await fs.mkdir(path.join(root, 'application/current/empty'), {recursive: true});
  await fs.writeFile(path.join(root, 'application/current/app.bin'), 'real fixture bytes');
  return {dir, root};
}

test('deterministic inventory verifies after relocation with spaces and Unicode', async t => {
  const {dir, root} = await fixture(t);
  const manifest = await captureManifest(root, makePlan());
  assert.deepEqual(await captureManifest(root, makePlan()), manifest);
  assert.equal(manifest.files, 1);
  assert.equal(manifest.bytes, 18);
  assert.equal(manifest.components[0].entries.find(e => e.type === 'file').sha256,
    createHash('sha256').update('real fixture bytes').digest('hex'));
  assert.deepEqual(manifest.unresolvedAcquisitions, ['harbor']);
  const moved = path.join(dir, 'Relocated ü payload');
  await fs.rename(root, moved);
  assert.equal((await verifyManifest(moved, manifest)).ok, true);
  assert(!JSON.stringify(manifest).includes(dir));
});

for (const mutation of ['modify', 'add', 'remove', 'remove-empty']) {
  test(`verification detects ${mutation} within a selected payload`, async t => {
    const {root} = await fixture(t);
    const manifest = await captureManifest(root, makePlan());
    const file = path.join(root, 'application/current/app.bin');
    if (mutation === 'modify') await fs.writeFile(file, 'changed');
    if (mutation === 'add') await fs.writeFile(path.join(root, 'application/current/new.bin'), 'new');
    if (mutation === 'remove') await fs.unlink(file);
    if (mutation === 'remove-empty') await fs.rmdir(path.join(root, 'application/current/empty'));
    const result = await verifyManifest(root, manifest);
    assert.equal(result.ok, false);
    assert.equal(result.differenceCount, 1);
    assert.equal(result.differences[0].status, mutation === 'add' ? 'unexpected' : mutation === 'modify' ? 'changed' : 'missing');
  });
}

test('missing selected root and altered manifest metadata fail verification', async t => {
  const {root} = await fixture(t);
  const manifest = await captureManifest(root, makePlan());
  const changed = structuredClone(manifest);
  changed.components[0].version = '9.9.9';
  await assert.rejects(verifyManifest(root, changed), /checksum/);
  await fs.rename(path.join(root, 'application/current'), path.join(root, 'application/moved'));
  await assert.rejects(verifyManifest(root, manifest), {code: 'ENOENT'});
});

test('large mismatch reports are bounded', async t => {
  const {root} = await fixture(t);
  const manifest = await captureManifest(root, makePlan());
  for (let i = 0; i < 55; i++) await fs.writeFile(path.join(root, `application/current/extra-${i}.bin`), 'extra');
  const result = await verifyManifest(root, manifest);
  assert.equal(result.ok, false);
  assert.equal(result.differenceCount, 55);
  assert.equal(result.differences.length, 50);
  assert.equal(result.differencesTruncated, true);
});

test('profile stays outside capture; explicitly including secrets fails closed', async t => {
  const {root} = await fixture(t);
  await fs.mkdir(path.join(root, 'data/auth'), {recursive: true});
  await fs.writeFile(path.join(root, 'data/auth/gateway.json'), '{"key":"DO-NOT-EXPORT"}');
  const manifest = await captureManifest(root, makePlan());
  assert(!JSON.stringify(manifest).includes('DO-NOT-EXPORT'));
  assert(!JSON.stringify(manifest).includes('gateway.json'));
  await fs.writeFile(path.join(root, 'application/current/.env'), 'SECRET');
  await assert.rejects(captureManifest(root, makePlan()), /credential path/);
});

test('unsafe, ambiguous and Windows-specific paths are rejected', () => {
  for (const value of ['../data', '/application', 'C:/secret', 'application/../data', 'application\\app',
    'application//app', 'application/app:stream', 'application/NUL.txt', 'application/dir.',
    'application/dir ', 'application/secret.key', 'application/.git/config', 'data/auth/gateway.json', 'catalog.json']) {
    assert.throws(() => validatePayloadPath(value));
  }
  assert.equal(validatePayloadPath('runtimes/model ü/weights.bin'), 'runtimes/model ü/weights.bin');
  const plan = makePlan();
  plan.components.push({...plan.components[0], id: 'other', paths: ['APPLICATION/current/app.bin']});
  assert.throws(() => validatePlan(plan));
  plan.components[1].paths = ['application/current/app.bin'];
  assert.throws(() => validatePlan(plan), /Overlapping/);
});

test('metadata allowlist discards arbitrary input and rejects credential URLs', () => {
  const plan = makePlan();
  plan.secret = 'DO-NOT-EXPORT';
  plan.components[0].environment = {KEY: 'DO-NOT-EXPORT'};
  assert(!JSON.stringify(validatePlan(plan)).includes('DO-NOT-EXPORT'));
  plan.components[0].acquisition = {type: 'archive', url: 'https://example.org/payload.zip', sha256: 'a'.repeat(64)};
  assert.equal(validatePlan(plan).components[0].acquisition.sha256, 'a'.repeat(64));
  for (const url of ['https://user:secret@example.org/file', 'https://example.org/file?key=secret', 'file:///local/file']) {
    plan.components[0].acquisition.url = url;
    assert.throws(() => validatePlan(plan));
  }
});

test('junctions or symlinks inside selected payloads are rejected', async t => {
  const {dir, root} = await fixture(t);
  const outside = path.join(dir, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.txt'), 'private');
  await fs.symlink(outside, path.join(root, 'application/current/link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(captureManifest(root, makePlan()), /links/);
  const plan = makePlan();
  plan.components[0].paths = ['application/current/link/private.txt'];
  await assert.rejects(captureManifest(root, plan), /links/);
});

test('CLI captures, verifies, returns failure for corruption and preserves existing output', async t => {
  const {dir, root} = await fixture(t);
  const plan = path.join(dir, 'plan.json'), output = path.join(dir, 'manifest.json');
  await fs.writeFile(plan, JSON.stringify(makePlan()));
  const run = args => spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8', windowsHide: true});
  assert.equal(run(['capture', root, plan, output]).status, 0);
  const original = await fs.readFile(output, 'utf8');
  assert.equal(run(['capture', root, plan, output]).status, 1);
  assert.equal(await fs.readFile(output, 'utf8'), original);
  assert.equal(run(['verify', root, output]).status, 0);
  assert.equal(run(['capture', root, plan, path.join(root, 'manifest.json')]).status, 1);
  await fs.writeFile(path.join(root, 'application/current/app.bin'), 'corrupted');
  assert.equal(run(['verify', root, output]).status, 1);
  await fs.writeFile(plan, '{"SECRET-CONTENT": INVALID}');
  const malformed = run(['capture', root, plan, output]);
  assert.equal(malformed.status, 1);
  assert(!malformed.stderr.includes('SECRET-CONTENT'));
});
