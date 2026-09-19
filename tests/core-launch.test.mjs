import test from 'node:test';
import assert from 'node:assert/strict';

// Pure launch-spec checks are configuration checks; actual native .cmd and WSL
// execution are exercised separately, never simulated by a successful fake child.
test('launch specs preserve argv and environment and keep Linux cwd inside WSL', async () => {
  const { buildLaunchSpec } = await import('../src/core/launch.mjs');
  const inherited = { PATH: 'base-path', HARBOR_INHERITED: 'keep', TEMP: 'temp' };
  const native = buildLaunchSpec({ runtime: 'native', command: 'npx.cmd', args: ['some package', 'a&b'], cwd: 'C:/work space', env: { OVERRIDE: 'yes' } }, { platform: 'win32', env: inherited });
  assert.equal(native.command, 'npx.cmd');
  assert.deepEqual(native.args, ['some package', 'a&b']);
  assert.equal(native.cwd, 'C:/work space');
  assert.deepEqual(native.env, { ...inherited, OVERRIDE: 'yes' });
  const wsl = buildLaunchSpec({ runtime: 'wsl', command: '/usr/bin/node', args: ['/home/user/a file.mjs', 'literal;$(no)'], cwd: '/home/user/project space', distro: 'Ubuntu', env: { TOKEN: 'a b=$x' } }, { platform: 'win32', env: inherited });
  assert.equal(wsl.command, 'wsl.exe');
  assert.deepEqual(wsl.args, ['--distribution', 'Ubuntu', '--cd', '/home/user/project space', '--exec', 'env', 'TOKEN=a b=$x', '/usr/bin/node', '/home/user/a file.mjs', 'literal;$(no)']);
  assert.equal(wsl.cwd, undefined);
  assert.deepEqual(wsl.env, inherited);
  assert.throws(() => buildLaunchSpec({ runtime: 'wsl', command: 'node', args: [], env: {} }, { platform: 'linux', env: {} }), /Windows/i);
});
