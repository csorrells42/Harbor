// Verified sources: https://oraios.github.io/serena/02-usage/030_clients.html
// https://github.com/modelcontextprotocol/servers/tree/main/src/git
export function createTemplate(kind, repository, runtime = 'native') {
  if (!String(repository ?? '').trim()) throw new Error('Choose or enter a repository path first.');
  if (!['git', 'serena'].includes(kind)) throw new Error('Unknown template.');
  return parseServerForm({ id: kind, name: kind === 'git' ? 'Git' : 'Serena', transport: 'stdio', runtime,
    command: kind === 'git' ? 'uvx' : 'serena',
    args: kind === 'git' ? ['mcp-server-git', '--repository', repository] : ['start-mcp-server', '--project', repository],
    cwd: repository, env: {}, autoStart: false, autoRestart: false });
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function jsonField(value, fallback, label) {
  try { return typeof value === 'string' ? JSON.parse(value.trim() || fallback) : value ?? JSON.parse(fallback); }
  catch { throw new Error(`${label} must be valid JSON.`); }
}
export function parseImport(text) {
  const data = jsonField(text, '{}', 'Configuration');
  if (!object(data) || !object(data.mcpServers)) throw new Error('Configuration must contain an mcpServers object.');
  if (!Object.keys(data.mcpServers).length) throw new Error('Add at least one server to mcpServers.');
  return { mcpServers: Object.fromEntries(Object.entries(data.mcpServers).map(([id, config]) => {
    if (!object(config)) throw new Error(`Server ${id} must be an object.`);
    return [id, { ...config, autoStart: false, autoRestart: false,onDemand:false }];
  })) };
}

export function parseServerForm(form) {
  const activation={enabled:form.enabled!==false,onDemand:form.onDemand===true,idleMinutes:form.idleMinutes===undefined?5:Number(form.idleMinutes)};
  if(!Number.isInteger(activation.idleMinutes)||activation.idleMinutes<1||activation.idleMinutes>1440)throw new Error('Idle shutdown must be 1–1440 minutes');
  if(!activation.enabled&&(form.autoStart||activation.onDemand))throw new Error('Disable startup and on-demand eligibility before disabling this server');
  if (!['stdio', 'http', 'sse'].includes(form.transport ?? 'stdio')) throw new Error('Transport must be stdio, HTTP or SSE.');
  if (!['native', 'wsl'].includes(form.runtime ?? 'native')) throw new Error('Runtime must be native or WSL.');
  if (form.transport === 'http' || form.transport === 'sse') {
    let url;
    try { url = new URL(String(form.url ?? '').trim()); } catch { throw new Error('Enter a valid HTTP or HTTPS endpoint.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS endpoint without embedded credentials.');
  }
  const id = String(form.id ?? '');
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) throw new Error('ID must be 1–40 letters, numbers, hyphens or underscores.');
  const name = String(form.name ?? '').trim();
  if (!name) throw new Error('Name is required.');
  if (form.transport === 'http' || form.transport === 'sse') {
    const managedProcesses = jsonField(form.managedProcesses, '[]', 'Managed processes');
    if (!Array.isArray(managedProcesses)) throw new Error('Managed processes must be a JSON array.');
    for (const [index, spec] of managedProcesses.entries()) {
      const validString = value => typeof value === 'string' && !value.includes('\0');
      if (!object(spec) || Object.keys(spec).some(key => !['command','args','cwd','env','runtime','distro'].includes(key) || spec[key] === null) || !validString(spec.command) || !spec.command.trim()
        || !Array.isArray(spec.args ?? []) || (spec.args ?? []).some(value => !validString(value))
        || !object(spec.env ?? {}) || Object.entries(spec.env ?? {}).some(([key,value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !validString(value))
        || !['native','wsl'].includes(spec.runtime ?? 'native') || ['cwd','distro'].some(key => spec[key] !== undefined && !validString(spec[key]))) throw new Error(`Managed processes [${index}]: use a command, string args/env, native or wsl runtime, and optional string cwd/distro only.`);
      if ((spec.runtime ?? 'native') === 'native' && /(^|[\\/])wsl(?:\.exe)?$/i.test(spec.command)) throw new Error('Managed processes: use runtime "wsl" and the Linux command, not a native wsl.exe wrapper.');
    }
    return { id, name, transport: form.transport, runtime:'native', url:String(form.url).trim(), command:'', args:[], env:{}, cwd:'', distro:'', autoStart:form.autoStart===true, autoRestart:form.autoRestart===true,...activation, ...(form.managedProcesses !== undefined ? {managedProcesses} : {}) };
  }
  const args = jsonField(form.args, '[]', 'Arguments');
  const env = jsonField(form.env, '{}', 'Environment');
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('Arguments must be a JSON array of strings.');
  if (!object(env) || Object.values(env).some(value => typeof value !== 'string')) throw new Error('Environment must be a JSON object with string values.');
  const command = String(form.command ?? '').trim();
  if (!command && (form.transport ?? 'stdio') === 'stdio') throw new Error('Command is required for stdio.');
  return { id, name, transport: form.transport ?? 'stdio', runtime: form.runtime ?? 'native', command, args, env, cwd: String(form.cwd ?? '').trim(), url: String(form.url ?? '').trim(), distro: String(form.distro ?? '').trim(), autoStart: form.autoStart === true, autoRestart: form.autoRestart === true,...activation };
}
