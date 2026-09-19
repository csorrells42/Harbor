import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createGateway} from '../src/core/gateway.mjs';
import {DEFAULT_SETTINGS} from '../src/core/settings.mjs';
import {createTask} from '../src/diagnostics/tasks.mjs';

test('diagnostic fixtures run through actual local delivery modes',{skip:!process.env.HARBOR_TOOL_RUNTIME_ROOT,timeout:180000},async()=>{
  for(const toolMode of ['all','bm25','regex','code','portkey-local','hybrid']){
    const task=createTask('lookup','modes'),settings={...DEFAULT_SETTINGS,toolMode};
    const g=await createGateway({...settings,host:'127.0.0.1',port:0,upstreams:task.upstreams,log:()=>{}}),c=new Client({name:'diagnostic-mode-fixture',version:'1'});
    try{
      await g.prepareMode(settings);await c.connect(new StreamableHTTPClientTransport(new URL(g.endpoint)));
      const tools=await c.listTools();assert(tools.tools.length);
      if(toolMode!=='all'){
        const s=await c.callTool(toolMode==='code'?{name:'search',arguments:{query:'read diagnostic record',detail:'full'}}:{name:'search_tools',arguments:toolMode==='regex'?{pattern:'read_record'}:{query:'read diagnostic record'}});
        assert(!s.isError,JSON.stringify(s));assert(JSON.stringify(s).includes('diag__read_record'));
      }
      const call=async(name,args)=>{const r=await c.callTool(toolMode==='all'?{name,arguments:args}:toolMode==='code'?{name:'execute',arguments:{code:`return await call_tool(${JSON.stringify(name)}, ${JSON.stringify(args)})`}}:{name:'call_tool',arguments:{name,arguments:args}});assert(!r.isError,JSON.stringify(r));return r;};
      await call('diag__read_record',{id:'record-modes'});await call('diag__write_result',{value:'value-modes'});assert(task.verify('{"status":"done","value":"value-modes"}').completed,toolMode);
    }finally{await c.close();await g.close();}
  }
});
