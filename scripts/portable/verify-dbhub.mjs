import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=path.resolve(process.argv[2]),stage=path.resolve(process.argv[3]||path.join(root,'packages/dbhub')),endpoint=process.argv[4];
const require=createRequire(path.join(root,'packages/general-local/package.json'));
const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
const {StreamableHTTPClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')));
const {portableEnvironment}=await import(pathToFileURL(path.join(root,'support/portable.mjs')));
const folder=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor DBHub acceptance '));
const database=endpoint?path.join(root,'data/workspace/harbor.sqlite'):path.join(folder,'database with spaces.sqlite');
const table=`harbor_acceptance_${Date.now()}`;
const report={at:new Date().toISOString(),stage,database,endpoint,checks:[]};
let client,transport,errors='';
const connect=async()=>{
  client=new Client({name:'Harbor DBHub acceptance',version:'1'});
  transport=endpoint?new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:process.env.HARBOR_API_KEY?{Authorization:'Bearer '+process.env.HARBOR_API_KEY}:{}}}):new StdioClientTransport({command:path.join(root,'runtimes/node/node.exe'),args:[path.join(stage,'dist/index.js'),'--transport','stdio','--dsn',`sqlite:///${database.replaceAll('\\','/')}`],cwd:folder,env:portableEnvironment(root,process.env),stderr:'pipe'});
  transport.stderr?.on('data',c=>errors=(errors+c).slice(-6000));await client.connect(transport,{timeout:60000});
  return (await client.listTools()).tools.filter(t=>!endpoint||t.name.startsWith('dbhub__'));
};
let tools;
const call=async(name,args)=>{const tool=tools.find(t=>endpoint?t.name.startsWith(`dbhub__${name}__`):t.name===name);assert(tool,`Missing ${name}`);const result=await client.callTool({name:tool.name,arguments:args},undefined,{timeout:60000});assert(!result.isError,JSON.stringify(result));return JSON.stringify(result);};
try{
  tools=await connect();report.tools=tools.map(t=>t.name);assert.equal(tools.length,2);
  await call('execute_sql',{sql:`CREATE TABLE ${table}(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO ${table} VALUES (1,'Harbor DBHub verified')`});
  assert.match(await call('execute_sql',{sql:`SELECT * FROM ${table}`}),/Harbor DBHub verified/);
  assert.match(await call('search_objects',{object_type:'table',pattern:table,detail_level:'names'}),new RegExp(table));
  report.checks.push('Created a SQLite table, inserted and queried data, and discovered its schema through MCP.');
  await client.close();tools=await connect();
  assert.match(await call('execute_sql',{sql:`SELECT value FROM ${table}`}),/Harbor DBHub verified/);
  const value=execFileSync(path.join(root,'runtimes/python/python.exe'),['-c','import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute("SELECT value FROM " + sys.argv[2]).fetchone()[0]); c.close()',database,table],{encoding:'utf8',windowsHide:true}).trim();assert.equal(value,'Harbor DBHub verified');
  report.checks.push(endpoint?'Persisted data survived a fresh gateway client and independent SQLite readback.':'Persisted data survived a DBHub process restart and independent SQLite readback.');
  await call('execute_sql',{sql:`DROP TABLE ${table}`});report.success=true;
}catch(error){report.error=error.stack;report.stderr=errors;process.exitCode=1;}
finally{await client?.close();await fs.writeFile(path.join(folder,'acceptance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
