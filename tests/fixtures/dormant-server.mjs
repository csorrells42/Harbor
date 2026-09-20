import {readFile,appendFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const file=process.argv[2],config=JSON.parse(await readFile(file,'utf8'));
await appendFile(config.events,JSON.stringify({kind:'start',pid:process.pid})+'\n');
if(config.failStart)process.exit(17);
if(config.startDelay)await delay(config.startDelay);
const server=new Server({name:'dormant-fixture',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,()=>({tools:[{name:'write',description:'Append one synthetic event',inputSchema:{type:'object',properties:{value:{type:config.numeric?'number':'string'}},required:['value'],additionalProperties:false}}]}));
server.setRequestHandler(CallToolRequestSchema,async request=>{
  await appendFile(config.events,JSON.stringify({kind:'call',pid:process.pid,value:request.params.arguments.value})+'\n');
  if(config.callDelay)await delay(config.callDelay);
  return {content:[{type:'text',text:JSON.stringify({pid:process.pid,value:request.params.arguments.value})}]};
});
await server.connect(new StdioServerTransport());
