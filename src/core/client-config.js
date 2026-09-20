export const CONNECTION_CLIENTS = Object.freeze([
  ['lmstudio', 'LM Studio'], ['hermes', 'Hermes'], ['openclaw', 'OpenClaw'],
  ['opencode', 'OpenCode (v2)'], ['opencode-v1', 'OpenCode (v1)'],
  ['openhands', 'OpenHands'], ['goose', 'Goose'], ['interpreter', 'Open Interpreter'],
  ['openwebui', 'Open WebUI'], ['letta', 'Letta'], ['anythingllm', 'AnythingLLM'],
  ['general', 'General / another MCP client'],
]);

const GUIDES = {
  lmstudio: ['mcp.json (JSON)', 'https://lmstudio.ai/docs/app/mcp'],
  hermes: ['config.yaml (YAML)', 'https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/'],
  openclaw: ['openclaw.json (JSON)', null],
  opencode: ['opencode.jsonc (v2 JSON)', 'https://opencode.ai/v2/docs/mcp-servers'],
  'opencode-v1': ['opencode.json (v1 JSON)', 'https://opencode.ai/docs/mcp-servers'],
  openhands: ['config.toml (TOML)', 'https://docs.openhands.dev/openhands/usage/settings/mcp-settings'],
  goose: ['config.yaml (YAML)', 'https://github.com/block/goose'],
  interpreter: ['config.toml (TOML)', 'https://www.openinterpreter.com/docs/terminal/mcp'],
  openwebui: ['Connection form values', 'https://docs.openwebui.com/features/extensibility/mcp/'],
  letta: ['Create MCP server request (JSON)', 'https://docs.letta.com/api/python/resources/mcp_servers/methods/create'],
  anythingllm: ['anythingllm_mcp_servers.json (JSON)', 'https://docs.anythingllm.com/mcp-compatibility/overview'],
  general: ['Common MCP configuration (JSON)', 'https://modelcontextprotocol.io/docs/develop/connect-remote-servers'],
};

export function clientConnectionHelp(client) {
  const guide = GUIDES[client];
  if (!Object.hasOwn(GUIDES, client)) throw new Error('Choose a supported client.');
  return {caption: guide[0], documentation: guide[1], formats: client === 'openwebui' ? ['http'] : ['http', 'stdio']};
}

// Shared by redacted previews and the desktop-only credential export.
// JSON-quoted scalars/inline collections are valid YAML, including Windows paths.
const yamlEntry = (root, entry) => `${root}:\n  harbor:\n` + Object.entries(entry)
  .map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`).join('\n') + '\n';
const tomlValue = value => Array.isArray(value) ? `[${value.map(tomlValue).join(', ')}]`
  : value && typeof value === 'object' ? `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${tomlValue(item)}`).join(', ')} }`
  : JSON.stringify(value);
const tomlSection = (section, entry) => `[${section}]\n` + Object.entries(entry)
  .map(([key, value]) => `${key} = ${tomlValue(value)}`).join('\n') + '\n';
const bearerValue = entry => {
  const value = Object.entries(entry.headers ?? {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) throw new Error('This client recipe requires a Bearer API key.');
  return value.slice(7);
};

export function formatClientConfiguration(config, client = 'lmstudio') {
  const help = clientConnectionHelp(client);
  const entry = config?.mcpServers?.harbor;
  if (!entry) throw new Error('Harbor connection configuration is unavailable.');
  const http = Boolean(entry.url);
  if (!help.formats.includes(http ? 'http' : 'stdio')) throw new Error('Open WebUI uses Streamable HTTP. Choose that connection format.');
  if (client === 'hermes') return yamlEntry('mcp_servers', entry);
  if (client === 'openclaw') return JSON.stringify({mcp: {servers: {harbor: {transport: http ? 'streamable-http' : 'stdio', ...entry}}}}, null, 2);
  if (client === 'opencode' || client === 'opencode-v1') {
    const server = http ? {type: 'remote', url: entry.url, oauth: false, ...(entry.headers ? {headers: entry.headers} : {})}
      : {type: 'local', command: [entry.command, ...(entry.args ?? [])], ...(entry.env ? {environment: entry.env} : {})};
    const mcp = client === 'opencode' ? {servers: {harbor: server}} : {harbor: server};
    return JSON.stringify({$schema: 'https://opencode.ai/config.json', mcp}, null, 2);
  }
  if (client === 'openhands') {
    const token = http ? bearerValue(entry) : undefined;
    return tomlSection('mcp', http ? {shttp_servers: [{url: entry.url, ...(token !== undefined ? {api_key: token} : {})}]}
      : {stdio_servers: [{name: 'harbor', ...entry}]});
  }
  if (client === 'goose') return yamlEntry('extensions', {enabled: true, name: 'Harbor',
    ...(http ? {type: 'streamable_http', uri: entry.url, ...(entry.headers ? {headers: entry.headers} : {})}
      : {type: 'stdio', cmd: entry.command, args: entry.args ?? [], ...(entry.env ? {envs: entry.env} : {})}), timeout: 300});
  if (client === 'interpreter') return tomlSection('mcp_servers.harbor', http
    ? {url: entry.url, ...(entry.headers ? {http_headers: entry.headers} : {})} : entry);
  if (client === 'openwebui') {
    const token = bearerValue(entry);
    return ['Name: Harbor', 'Type: MCP (Streamable HTTP)', `Server URL: ${entry.url}`,
      ...(token === undefined ? ['Auth: None'] : ['Auth: Bearer', `Token: ${token}`])].join('\n');
  }
  if (client === 'letta') return JSON.stringify({server_name: 'harbor', config: http
    ? {mcp_server_type: 'streamable_http', server_url: entry.url, ...(entry.headers ? {custom_headers: entry.headers} : {})}
    : {mcp_server_type: 'stdio', ...entry}}, null, 2);
  if (client === 'anythingllm') return JSON.stringify({mcpServers: {harbor: {...(http ? {type: 'streamable'} : {}), ...entry}}}, null, 2);
  return JSON.stringify(config, null, 2);
}

export function clientConnectionSteps(client, format) {
  clientConnectionHelp(client);
  const steps = {
    lmstudio: [
      'Open LM Studio → Program → Install → Edit mcp.json.',
      'Copy configuration below. Merge harbor into the existing mcpServers object; keep your other servers.',
      'Save, enable Harbor in LM Studio, then reconnect and check that its tools appear.',
    ],
    hermes: [
      'Open config.yaml in the Hermes home or profile used by your client. CLI default: ~/.hermes/config.yaml. Hermes Desktop and HERMES_HOME overrides can use a different folder.',
      'Copy the YAML below. Merge harbor under the existing mcp_servers section; keep other settings and servers. Use spaces for indentation.',
      'Save, restart the Hermes client, and check its available tools for Harbor. Keep Harbor running.',
    ],
    openclaw: [
      'Open your active OpenClaw configuration (default: ~/.openclaw/openclaw.json). This recipe requires a version with native mcp.servers support, verified in 2026.7.1-2.',
      'Copy the JSON below. Merge harbor into mcp.servers; keep existing settings and servers. This is OpenClaw configuration, not mcporter.json.',
      'Save, run openclaw mcp doctor harbor --probe to check the connection, then reconnect your agent. Its tool policy must allow MCP tools; the minimal profile hides them.',
    ],
    opencode: [
      'For OpenCode v2, open your project opencode.jsonc or the active global configuration. For v1, choose OpenCode (v1) above instead.',
      'Copy and merge harbor under mcp.servers. Keep the other configuration sections. The HTTP recipe uses Harbor API-key authentication with OAuth disabled.',
      'Run opencode mcp list, then use /mcps in OpenCode to check Harbor is connected. Start a task that uses one of its tools.',
    ],
    'opencode-v1': [
      'For OpenCode v1, open your project opencode.json or the active global configuration. For v2, choose OpenCode (v2) above instead.',
      'Copy and merge harbor directly under mcp. Keep your other settings. The v1 layout differs from v2 mcp.servers.',
      'Run opencode mcp list and check that Harbor is connected before starting a tool-using task.',
    ],
    openhands: [
      'In OpenHands, open Settings → MCP (or Customize → MCP Servers in Agent Canvas). Add Harbor using the selected transport. If your installation uses config.toml instead, merge the snippet below into its [mcp] section.',
      format === 'http' ? 'For Streamable HTTP/SHTTP, enter the shown URL and API key. The api_key field takes the key alone, without the Bearer prefix. Append this server to any existing shttp_servers list.'
        : 'For stdio, enter the command, arguments and environment values below. Append the entry to stdio_servers; these paths must exist inside the OpenHands runtime.',
      'Save or restart as required by your installation, then create a new conversation and check its MCP tools. A Docker/remote runtime must be able to reach Harbor from that runtime, not only from your browser.',
    ],
    goose: [
      'Open Goose → Settings → Extensions → Add custom extension, or run goose configure and choose Add Extension. Choose Streamable HTTP or stdio to match below.',
      'Enter the shown values, or merge the YAML under extensions in the config.yaml used by Goose. HTTP uses uri and headers; stdio uses cmd, args and envs. Keep other extensions.',
      'Enable Harbor, start a fresh Goose session and check its extension tools. Use the Authorization header exactly as shown for an authenticated HTTP connection.',
    ],
    interpreter: [
      'For Open Interpreter versions with interpreter mcp commands, open ~/.openinterpreter/config.toml. Older versions may need an upgrade to use this recipe.',
      'Merge the [mcp_servers.harbor] section below. Use the HTTP URL and http_headers, or the stdio command, args and env. Keep other configured servers.',
      'Run interpreter mcp list, then use /mcp in the terminal interface to check loaded servers and /mcp verbose for tool details.',
    ],
    openwebui: [
      'As an Open WebUI administrator, open Settings → Admin → Integrations → External Tool Servers → Add Connection.',
      'Select MCP (Streamable HTTP), enter the Server URL below, and choose Bearer authentication with the Token value if a key is enabled. These are form values, not JSON to import into an OpenAPI connection.',
      'Save, enable the tool connection for your chat/model and check its tools. Native MCP here is HTTP only. With Docker, use an address reachable from the Open WebUI backend; localhost inside a container is not your Windows host.',
    ],
    letta: [
      'Add Harbor in the MCP server management for your Letta deployment. For SDK/API setup, the JSON below is the request body for POST /v1/mcp-servers/ on your Letta server; use your existing Letta credentials for that request.',
      'Use the shown server_name and config fields. custom_headers carries Harbor authentication for HTTP; it is separate from your Letta account/API authentication. Stdio is for a local/self-hosted Letta runtime that can launch the shown command.',
      'List or refresh the server tools and attach the tools you want to your Letta agent. Adding a server alone does not attach every tool to an existing agent. Hosted Letta must be able to reach the Harbor URL.',
    ],
    anythingllm: [
      'Open plugins/anythingllm_mcp_servers.json inside the storage directory used by your AnythingLLM installation.',
      'Merge harbor under mcpServers. For HTTP, retain type: streamable exactly; for stdio, retain command, args and env. Keep your other servers.',
      'Reload MCP servers in AnythingLLM, check Harbor and its tools in the MCP/Agent Skills screen, then use @agent in a workspace chat. Docker installations need a URL or command paths reachable from the container.',
    ],
    general: [
      'In your program, find Add MCP server or External tools. Choose Streamable HTTP for a direct connection, or stdio when the program needs a command.',
      'Use the selected Harbor endpoint. For HTTP authentication, use the shown Authorization header; if the form asks for only a token, omit the Bearer prefix. The JSON below is the common mcpServers layout; adapt the wrapper to your program.',
      'Save, reconnect, list the tools and try a harmless read. This is an MCP tool endpoint, not an OpenAI-compatible model URL or a legacy SSE endpoint. Keep Harbor running.',
    ],
  }[client];
  return [...steps, format === 'stdio'
    ? 'Stdio bridge: Node.js and the bridge file must exist at the shown paths on the client computer. For another computer, prefer Streamable HTTP with a reachable Harbor address.'
    : 'Streamable HTTP: use Local on this computer or a reachable network address on another computer. A localhost address always refers to the computer or container running the client.'];
}