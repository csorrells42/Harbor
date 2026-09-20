import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const directory=process.env.HARBOR_FIXTURE_GATE_DIR;
if(!directory)throw Error('Disposable test gate directory required');
const server=new Server({name:'gated-profile-fixture',version:'1'}, {capabilities:{tools:{}}});
let count=0;
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'record',description:'Record one test operation',inputSchema:{type:'object',properties:{text:{type:'string'},wait:{type:'boolean'}}}}]}));
server.setRequestHandler(CallToolRequestSchema,async request=>{
  const args=request.params.arguments??{};
  if(args.wait){
    await fs.writeFile(path.join(directory,'entered.json'),JSON.stringify({pid:process.pid}));
    const deadline=Date.now()+20000;
    while(true){
      try{await fs.access(path.join(directory,'release'));break;}
      catch(error){if(error.code!=='ENOENT')throw error;}
      if(Date.now()>deadline)throw Error('Test gate was not released');
      await delay(10);
    }
  }
  return {content:[{type:'text',text:JSON.stringify({text:args.text,pid:process.pid,count:++count})}]};
});
await server.connect(new StdioServerTransport());
