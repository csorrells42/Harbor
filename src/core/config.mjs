import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Server config must be an object');
  const { id } = input;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(id)) throw new Error('Invalid server id (1–40 letters, digits, _ or -)');
  const transport = input.transport ?? (input.url ? 'http' : 'stdio');
  const runtime = input.runtime ?? 'native';
  if (!['stdio', 'http', 'sse'].includes(transport)) throw new Error('Invalid transport');
  if (!['native', 'wsl'].includes(runtime)) throw new Error('Invalid runtime');
  const config = { id, name: input.name ?? id, transport, runtime, args: input.args ?? [], env: input.env ?? {}, autoStart: input.autoStart ?? false, autoRestart: input.autoRestart ?? false };
  if (typeof config.name !== 'string' || !config.name.trim()) throw new Error('Invalid name');
  if (!Array.isArray(config.args) || config.args.some(x => typeof x !== 'string' || x.includes('\0'))) throw new Error('args must be an array of strings');
  if (!config.env || Array.isArray(config.env) || typeof config.env !== 'object' || Object.entries(config.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || v.includes('\0'))) throw new Error('env must contain string values with valid environment names');
  for (const key of ['command', 'cwd', 'url', 'distro']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string' || input[key].includes('\0')) throw new Error(`Invalid ${key}`);
      config[key] = input[key];
    }
  }
  for (const key of ['autoStart', 'autoRestart']) if (typeof config[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  if (transport === 'stdio' && !config.command?.trim()) throw new Error('command is required');
  if (transport !== 'stdio') {
    let url;
    try { url = new URL(config.url); } catch { throw new Error('Valid HTTP(S) url required'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Valid HTTP(S) url without embedded credentials required');
  }
  if (input.managedProcesses !== undefined) {
    if (!Array.isArray(input.managedProcesses)) throw new Error('managedProcesses must be an array');
    if (transport === 'stdio' && input.managedProcesses.length) throw new Error('managedProcesses is only supported for HTTP/SSE, not stdio');
    config.managedProcesses = input.managedProcesses.map((spec, index) => {
      try {
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('launch specification must be an object');
        for (const key of Object.keys(spec)) {
          if (!['command', 'args', 'cwd', 'env', 'runtime', 'distro', 'gracefulStop'].includes(key)) throw new Error(`Unknown launch field ${key}`);
          if (spec[key] === null) throw new Error(`${key} cannot be null`);
        }
        const validated = validateConfig({ ...spec, id: 'launch', transport: 'stdio' });
        if (validated.runtime === 'native' && /(^|[\\/])wsl(?:\.exe)?$/i.test(validated.command)) throw new Error('Use runtime "wsl" with the Linux command, not a native wsl.exe wrapper');
        const result=Object.fromEntries(['command', 'args', 'cwd', 'env', 'runtime', 'distro'].filter(key => validated[key] !== undefined).map(key => [key, validated[key]]));
        if(spec.gracefulStop!==undefined){
          if(validated.runtime!=='native')throw new Error('gracefulStop requires a native managed process');
          const stop=spec.gracefulStop;
          if(!stop||typeof stop!=='object'||Array.isArray(stop)||Object.keys(stop).some(k=>!['command','args','cwd','env','timeoutMs'].includes(k)))throw new Error('Invalid gracefulStop command');
          const launch=validateConfig({...stop,id:'stop',transport:'stdio'});
          const timeoutMs=stop.timeoutMs??120000;
          if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>300000)throw new Error('gracefulStop timeoutMs must be 1000-300000');
          result.gracefulStop={command:launch.command,args:launch.args,cwd:launch.cwd,env:launch.env,timeoutMs};
        }
        return result;
      } catch (error) { throw new Error(`managedProcesses[${index}]: ${error.message}`); }
    });
  }
  return structuredClone(config);
}

export async function loadConfigs(path) {
  let data;
  try { data = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (data.version !== 1 || !Array.isArray(data.servers)) throw new Error('Invalid configuration file');
  const configs = data.servers.map(validateConfig);
  if (new Set(configs.map(s => s.id)).size !== configs.length) throw new Error('Duplicate server id in configuration');
  return configs;
}

export async function persistConfigs(path, configs) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ version: 1, servers: configs }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}
