// The SDK's StdioClientTransport uses cross-spawn with shell:false. That
// preserves argument boundaries and supports Windows npm/npx .cmd shims.
import { resolvePortableConfig, portableEnvironment } from './portable.mjs';
export function buildLaunchSpec(config, { platform = process.platform, env = process.env } = {}) {
  config = resolvePortableConfig(config, env.HARBOR_PORTABLE_ROOT);
  env = portableEnvironment(env.HARBOR_PORTABLE_ROOT, env);
  if (config.runtime === 'wsl') {
    if (platform !== 'win32') throw new Error('WSL runtime requires Windows');
    const args = [];
    if (config.distro) args.push('--distribution', config.distro);
    if (config.cwd) args.push('--cd', config.cwd);
    args.push('--exec', 'env', ...Object.entries(config.env ?? {}).map(([key, value]) => `${key}=${value}`), config.command, ...(config.args ?? []));
    return { command: 'wsl.exe', args, env: { ...env }, stderr: 'pipe' };
  }
  return { command: config.command, args: [...(config.args ?? [])], cwd: config.cwd || undefined, env: { ...env, ...config.env }, stderr: 'pipe' };
}
