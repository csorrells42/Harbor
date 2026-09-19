import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
if (process.env.TREE_PID_FILE) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  await writeFile(process.env.TREE_PID_FILE, String(child.pid));
}
const server = new Server({ name: 'harbor-real-fixture', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
const tools = (process.env.PAGINATED ? ['echo', 'a'.repeat(60), 'b__echo'] : ['echo']).map(name => ({ name, description: 'Real child echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }));
server.setRequestHandler(ListToolsRequestSchema, async request => {
  const index = Number(request.params?.cursor ?? 0);
  return { tools: tools.slice(index, index + 1), ...(index + 1 < tools.length ? { nextCursor: String(index + 1) } : {}) };
});
let count = 0;
server.setRequestHandler(CallToolRequestSchema, async request => {
  const args = request.params.arguments ?? {};
  if (args.fail) return { isError: true, content: [{ type: 'text', text: 'fixture tool rejected input' }] };
  if (args.throw) throw new Error('fixture protocol failure');
  if (args.change) {
    tools.push({ name: 'new_tool', inputSchema: { type: 'object' } });
    await server.sendToolListChanged();
  }
  if (args.delay) await new Promise(r => setTimeout(r, args.delay));
  return { content: [{ type: 'text', text: JSON.stringify({ text: args.text, count: ++count, pid: process.pid, env: process.env.HARBOR_TEST, inherited: process.env.HARBOR_INHERITED_TEST, argv: process.argv.slice(2), cwd: process.cwd() }) }] };
});
console.error('fixture booted');
await server.connect(new StdioServerTransport());
