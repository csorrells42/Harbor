import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {officeComponents,officeServer} from './office-components.mjs';
const root=path.resolve(process.argv[2]),id=process.argv[3],stage=path.resolve(process.argv[4]||path.join(root,'packages',id));
const spec=officeComponents.find(c=>c.id===id);assert(spec,'Unknown office component');
const require=createRequire(path.join(root,'packages/general-local/package.json'));
const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
const {StreamableHTTPClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')));
const {portableEnvironment,resolvePortableConfig}=await import(pathToFileURL(path.join(root,'support/portable.mjs')));
const config=resolvePortableConfig(officeServer(spec),root),env={...portableEnvironment(root,{...process.env}),...config.env};
env.PYTHONPATH=path.join(root,'support/python-site')+path.delimiter+path.join(stage,'python');
const endpoint=process.argv[5];
const client=new Client({name:`Harbor ${id} acceptance`,version:'1'});
const transport=endpoint?new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:process.env.HARBOR_API_KEY?{Authorization:'Bearer '+process.env.HARBOR_API_KEY}:{}}}):new StdioClientTransport({...config,env,stderr:'pipe'});
let errors='';transport.stderr?.on('data',c=>errors=(errors+c).slice(-5000));
const folder=await fs.mkdtemp(path.join(os.tmpdir(),`Harbor ${id} acceptance `));
const report={id,folder,at:new Date().toISOString(),checks:[]};
try{
  await client.connect(transport,{timeout:60000});
  const tools=(await client.listTools()).tools.filter(t=>!endpoint||t.name.startsWith(id+'__'));report.toolCount=tools.length;assert(tools.length);
  await fs.writeFile(path.join(folder,'tools.json'),JSON.stringify(tools,null,2));
  const call=async(name,args)=>{
    const digest=createHash('sha256').update(JSON.stringify([id,name])).digest('hex').slice(0,16);
    const tool=tools.find(t=>endpoint?t.name.endsWith('__'+digest):t.name===name);assert(tool,`Missing ${name}`);
    const result=await client.callTool({name:tool.name,arguments:args},undefined,{timeout:120000});
    assert(!result.isError,JSON.stringify(result));
    const text=result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');assert(!/^Error:/i.test(text),text);
    return text;
  };
  const python=(code,args=[])=>execFileSync(path.join(root,'runtimes/python/python.exe'),['-c',code,...args],{env,encoding:'utf8',windowsHide:true});
  if(process.env.HARBOR_LIST_ONLY){report.tools=tools.map(t=>({name:t.name,inputSchema:t.inputSchema}));}
  else if(id==='duckdb'){
    const csv=path.join(folder,'measurements.csv');await fs.writeFile(csv,'part,quantity,price\nA,2,10\nB,3,7\n');
    const result=await call('execute_query',{sql:`SELECT SUM(quantity * price) AS total FROM read_csv_auto('${csv.replaceAll('\\','/')}')`});assert.match(result,/41/);
    const db=path.join(folder,'analysis.duckdb');await call('switch_database_connection',{path:db,create_if_not_exists:true});
    await call('execute_query',{sql:'CREATE TABLE harbor_check AS SELECT 41 AS total'});
    assert.match(await call('execute_query',{sql:'SELECT total FROM harbor_check'}),/41/);
    await call('switch_database_connection',{path:':memory:'});assert((await fs.stat(db)).size>0);
    assert.equal(python('import duckdb,sys; c=duckdb.connect(sys.argv[1],read_only=True); print(c.execute("select total from harbor_check").fetchone()[0])',[db]).trim(),'41');
    report.checks.push('Queried external CSV and independently read a saved DuckDB database containing the expected total.');
  }else if(id==='excel'){
    const file=path.join(folder,'Harbor workbook.xlsx');
    await call('create_workbook',{filepath:file});await call('create_worksheet',{filepath:file,sheet_name:'Results'});
    await call('write_data_to_excel',{filepath:file,sheet_name:'Results',start_cell:'A1',data:[['Part','Quantity','Price'],['A',2,10],['B',3,7]]});
    await call('apply_formula',{filepath:file,sheet_name:'Results',cell:'D2',formula:'=B2*C2'});
    assert.match(await call('read_data_from_excel',{filepath:file,sheet_name:'Results',start_cell:'A1',end_cell:'D3'}),/Quantity/);
    const result=JSON.parse(python('import openpyxl,sys,json; w=openpyxl.load_workbook(sys.argv[1]); s=w["Results"]; print(json.dumps([s["B2"].value,s["D2"].value]))',[file]));assert.deepEqual(result,[2,'=B2*C2']);
    report.checks.push('Created a workbook, wrote a table and formula, read them through MCP and verified saved XLSX cells independently.');
  }else if(id==='word'){
    const file=path.join(folder,'Harbor report.docx'),handle=randomUUID();
    await call('create_from_markdown',{output_path:file,document_handle:handle,markdown:'# Harbor Report\n\nA **real Word document**, created locally.\n\n## Results\n\n| Tool | Status |\n|---|---|\n| Word | Working |\n\n- Editable text\n- Structured tables\n'});
    await call('save_document',{output_path:file,document_handle:handle});
    const parsed=JSON.parse(python('import zipfile,xml.etree.ElementTree as E,sys,json; z=zipfile.ZipFile(sys.argv[1]); r=E.fromstring(z.read("word/document.xml")); ns={"w":"http://schemas.openxmlformats.org/wordprocessingml/2006/main"}; print(json.dumps({"text":" ".join(x.text or "" for x in r.findall(".//w:t",ns)),"tables":len(r.findall(".//w:tbl",ns)),"styles":[x.attrib for x in r.findall(".//w:pStyle",ns)]}))',[file]));
    assert.match(parsed.text,/Harbor Report/);assert.match(parsed.text,/Working/);assert.equal(parsed.tables,1);assert(parsed.styles.length>0);
    report.checks.push('Created and saved a DOCX with headings, bold text, a table and a list; independently inspected the saved Word XML.');report.document=file;
  }else if(id==='markitdown'){
    const html=path.join(folder,'source.html');await fs.writeFile(html,'<h1>Harbor Conversion</h1><p>MARKITDOWN VERIFIED</p><table><tr><th>Part</th><th>Count</th></tr><tr><td>A</td><td>2</td></tr></table>');
    const converted=await call('convert_to_markdown',{uri:pathToFileURL(html).href});assert.match(converted,/MARKITDOWN VERIFIED/);assert.match(converted,/Harbor Conversion/);await fs.writeFile(path.join(folder,'converted.md'),converted);
    const workbook=path.join(folder,'source.xlsx');python('import openpyxl,sys; w=openpyxl.Workbook(); s=w.active; s.append(["Harbor spreadsheet", "Count"]); s.append(["Verified", 41]); w.save(sys.argv[1])',[workbook]);
    const sheet=await call('convert_to_markdown',{uri:pathToFileURL(workbook).href});assert.match(sheet,/Harbor spreadsheet/);assert.match(sheet,/41/);
    report.checks.push('Converted external HTML and XLSX tables to Markdown through MCP.');
  }
  report.success=true;
}catch(error){report.error=error.stack;report.stderr=errors;process.exitCode=1;}
finally{await client.close();await fs.writeFile(path.join(folder,'acceptance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
