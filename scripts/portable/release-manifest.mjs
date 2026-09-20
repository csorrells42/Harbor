import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const roles = new Set(['application', 'runtime', 'server', 'browser', 'model', 'support', 'license']);
const roots = new Set(['application', 'runtimes', 'packages', 'support', 'third-party', 'docs']);
const rootFiles = new Set(['Start Harbor.cmd', 'Start Harbor.vbs', 'HARBOR-MANUAL.pdf', 'LICENSE', 'LICENSING.md', 'THIRD-PARTY-NOTICES.txt']);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

// This is a payload inventory, never a dump of the live profile or maintenance recipes.
export function validatePayloadPath(value) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 1024, 'Invalid payload path');
  const parts = value.split('/');
  requireValue(parts.every(part => part && part !== '.' && part !== '..' &&
    !/[\\:<>"|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'Non-portable payload path');
  requireValue(roots.has(parts[0]) || (parts.length === 1 && rootFiles.has(value)), 'Path is outside declared release payload areas');
  requireValue(!parts.some(part => /^(?:data|\.git|\.env(?:\..*)?|credentials(?:\..*)?|auth|\.npmrc|\.pypirc)$/i.test(part) || /\.(?:key|pem)$/i.test(part)), 'Profile or credential path is not a release input');
  return value;
}

function cleanSource(source) {
  requireValue(source && /^[a-f0-9]{40}$/.test(source.revision), 'Source requires a full Git revision');
  requireValue(typeof source.repository === 'string', 'Source requires a repository URL');
  const url = new URL(source.repository);
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'Source URL must be public HTTPS without credentials or query parameters');
  return {repository: url.href, revision: source.revision};
}

function cleanAcquisition(value) {
  if (value == null) return null;
  requireValue(value.type === 'archive' && typeof value.url === 'string' && hashPattern.test(value.sha256), 'Acquisition requires an archive URL and SHA-256');
  const url = new URL(value.url);
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'Archive URL must be public HTTPS without credentials or query parameters');
  return {type: 'archive', url: url.href, sha256: value.sha256};
}

export function validatePlan(plan) {
  requireValue(plan?.schemaVersion === 1, 'Unsupported release plan version');
  requireValue(typeof plan.release === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(plan.release), 'Invalid release identifier');
  requireValue(Array.isArray(plan.components) && plan.components.length > 0 && plan.components.length <= 256, 'Plan requires 1–256 components');
  const ids = new Set(), selected = [];
  const components = plan.components.map(component => {
    requireValue(component && /^[a-z0-9][a-z0-9-]{0,63}$/.test(component.id) && !ids.has(component.id), 'Invalid or duplicate component ID');
    ids.add(component.id);
    requireValue(roles.has(component.role), 'Invalid component role');
    requireValue(component.version === null || (typeof component.version === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,99}$/.test(component.version)), 'Component version must be explicit or null');
    requireValue(Array.isArray(component.paths) && component.paths.length > 0 && component.paths.length <= 256, 'Component requires payload paths');
    const paths = component.paths.map(validatePayloadPath).sort(compare);
    for (const value of paths) {
      const lower = value.toLowerCase();
      requireValue(!selected.some(other => lower === other || lower.startsWith(other + '/') || other.startsWith(lower + '/')), 'Overlapping component paths');
      selected.push(lower);
    }
    return {id: component.id, role: component.role, version: component.version,
      acquisition: cleanAcquisition(component.acquisition), paths};
  }).sort((a, b) => compare(a.id, b.id));
  return {schemaVersion: 1, release: plan.release, source: cleanSource(plan.source), components};
}

async function safeStat(root, relative) {
  let current = root;
  let info = await fs.lstat(current);
  requireValue(info.isDirectory() && !info.isSymbolicLink(), 'Payload root must be a real directory');
  const realRoot = await fs.realpath(root);
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    info = await fs.lstat(current);
    requireValue(!info.isSymbolicLink(), 'Payload links are not supported');
    const real = await fs.realpath(current);
    const diff = path.relative(realRoot, real);
    requireValue(diff !== '..' && !diff.startsWith('..' + path.sep) && !path.isAbsolute(diff), 'Payload escapes its root');
  }
  return info;
}

async function collect(root, relative, entries, seen) {
  validatePayloadPath(relative);
  const lower = relative.toLowerCase();
  requireValue(!seen.has(lower), 'Case-colliding payload paths');
  seen.add(lower);
  const before = await safeStat(root, relative);
  const file = path.join(root, relative);
  if (before.isDirectory()) {
    const names = (await fs.readdir(file)).sort(compare);
    // Track empty directories too, so a lost empty payload root fails verification.
    entries.push({path: relative, type: 'directory'});
    for (const name of names) await collect(root, relative + '/' + name, entries, seen);
    requireValue(JSON.stringify(names) === JSON.stringify((await fs.readdir(file)).sort(compare)), 'Payload directory changed during capture');
    return;
  }
  requireValue(before.isFile(), 'Only regular payload files are supported');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const after = await safeStat(root, relative);
  requireValue(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.ino === after.ino, 'Payload file changed during capture');
  entries.push({path: relative, type: 'file', bytes: after.size, sha256: hash.digest('hex')});
}

export async function captureManifest(root, input) {
  const plan = validatePlan(input);
  root = path.resolve(root);
  const components = [], seen = new Set();
  for (const component of plan.components) {
    const entries = [];
    for (const relative of component.paths) await collect(root, relative, entries, seen);
    entries.sort((a, b) => compare(a.path, b.path));
    const files = entries.filter(entry => entry.type === 'file');
    components.push({...component, files: files.length, bytes: files.reduce((sum, entry) => sum + entry.bytes, 0), entries});
  }
  const body = {...plan, kind: 'selected-payload-inventory',
    coverage: 'Only declared paths; this is not clean-build or clean-runtime acceptance.',
    unresolvedAcquisitions: components.filter(component => !component.acquisition).map(component => component.id),
    components, files: components.reduce((sum, component) => sum + component.files, 0),
    bytes: components.reduce((sum, component) => sum + component.bytes, 0)};
  return {...body, manifestSha256: sha256(JSON.stringify(body))};
}

export async function verifyManifest(root, manifest) {
  requireValue(manifest && hashPattern.test(manifest.manifestSha256), 'Manifest requires a SHA-256');
  const {manifestSha256, ...body} = manifest;
  requireValue(sha256(JSON.stringify(body)) === manifestSha256, 'Manifest metadata checksum mismatch');
  // Reconstruct from validated, allowlisted metadata. Unknown fields cannot be
  // smuggled into a successful verification by recalculating the checksum.
  const actual = await captureManifest(root, manifest);
  const expectedEntries = new Map(manifest.components.flatMap(component => component.entries.map(entry => [entry.path, entry])));
  const actualEntries = new Map(actual.components.flatMap(component => component.entries.map(entry => [entry.path, entry])));
  const differences = [];
  let differenceCount = 0;
  for (const name of [...new Set([...expectedEntries.keys(), ...actualEntries.keys()])].sort(compare)) {
    const expected = expectedEntries.get(name), observed = actualEntries.get(name);
    if (JSON.stringify(expected) === JSON.stringify(observed)) continue;
    differenceCount++;
    if (differences.length < 50) differences.push({path: name, status: !expected ? 'unexpected' : !observed ? 'missing' : 'changed'});
  }
  return {ok: actual.manifestSha256 === manifestSha256, expectedSha256: manifestSha256,
    actualSha256: actual.manifestSha256, files: actual.files, bytes: actual.bytes,
    differenceCount, differences, differencesTruncated: differenceCount > differences.length};
}

export async function main(args) {
  const [command, root, inputFile, outputFile] = args;
  requireValue((command === 'capture' && args.length === 4) || (command === 'verify' && args.length === 3),
    'Usage: node scripts/portable/release-manifest.mjs capture <payload-root> <plan.json> <output.json> | verify <payload-root> <manifest.json>');
  const input = JSON.parse(await fs.readFile(inputFile, 'utf8'));
  if (command === 'verify') {
    const result = await verifyManifest(root, input);
    console.log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  }
  const relativeOutput = path.relative(path.resolve(root), path.resolve(outputFile));
  requireValue(relativeOutput === '..' || relativeOutput.startsWith('..' + path.sep) || path.isAbsolute(relativeOutput), 'Write manifests outside the payload root');
  const manifest = await captureManifest(root, input);
  // Never replace a prior baseline or an unrelated existing file.
  await fs.writeFile(outputFile, JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({release: manifest.release, files: manifest.files, bytes: manifest.bytes,
    manifestSha256: manifest.manifestSha256, unresolvedAcquisitions: manifest.unresolvedAcquisitions}));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) {
    // Native filesystem errors can contain personal absolute paths. Report codes
    // only; validation errors are static messages, never file contents.
    console.error(error instanceof SyntaxError ? 'Invalid JSON input' : error.code ? `Release manifest failed (${error.code})` : error.message);
    process.exitCode = 1;
  }
}
