// Actual file operations over MCP; used for initial acceptance and maintenance.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=path.resolve(process.argv[2]),stage=path.resolve(process.argv[3]||path.join(root,'packages/pdf-tools'));
const require=createRequire(path.join(root,'packages/general-local/package.json'));
const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
const {StreamableHTTPClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')));
const {portableEnvironment}=await import(pathToFileURL(path.join(root,'support/portable.mjs')));
const env=portableEnvironment(root,{...process.env});
env.PYTHONPATH=path.join(root,'support/python-site')+path.delimiter+path.join(stage,'python');env.PDF_TEMP_DIR=path.join(root,'data/temp/pdf-tools');
env.FASTMCP_CHECK_FOR_UPDATES='off';
const client=new Client({name:'Harbor PDF acceptance',version:'1'});
const transport=process.argv[4]?new StreamableHTTPClientTransport(new URL(process.argv[4]),{requestInit:{headers:process.env.HARBOR_API_KEY?{Authorization:'Bearer '+process.env.HARBOR_API_KEY}:{}}}):new StdioClientTransport({command:path.join(root,'runtimes/python/python.exe'),args:['-m','mcp_pdf.server'],cwd:root,env,stderr:'pipe'});
let stderr='';transport.stderr?.on('data',c=>stderr=(stderr+c).slice(-8000));
const folder=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor PDF acceptance '));
const report={at:new Date().toISOString(),folder,checks:[]};
try{
  await client.connect(transport,{timeout:60000});
  const tools=(await client.listTools()).tools.filter(t=>!process.argv[4]||t.name.startsWith('pdf-tools__'));report.toolCount=tools.length;
  async function call(suffix,args){
    const namespaces={markdown_to_pdf:'imageprocessing',pdf_to_markdown:'imageprocessing',merge_pdfs:'documentassembly',reorder_pdf_pages:'documentassembly',split_pdf:'documentassembly',extract_text:'textextraction',convert_to_images:'pdfutilities',create_form_pdf:'formmanagement',fill_form_pdf:'formmanagement',extract_form_data:'formmanagement'};
    const original=`${namespaces[suffix]}__${suffix}`;
    const digest=createHash('sha256').update(JSON.stringify(['pdf-tools',original])).digest('hex').slice(0,16);
    const tool=tools.find(t=>process.argv[4]?t.name.endsWith('__'+digest):t.name===original);assert(tool,`Missing ${suffix}`);
    const result=await client.callTool({name:tool.name,arguments:args},undefined,{timeout:120000});
    assert(!result.isError,JSON.stringify(result));
    const value=result.structuredContent??JSON.parse(result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'));
    assert(!value.error&&value.success!==false,JSON.stringify(value));return value;
  }
  const one=path.join(folder,'one.pdf'),two=path.join(folder,'two.pdf'),merged=path.join(folder,'merged.pdf'),reordered=path.join(folder,'reordered.pdf');
  await call('markdown_to_pdf',{markdown_text:'# Harbor PDF acceptance\n\nALPHA document.\n\n| Item | Value |\n|---|---|\n| Tools | Working |',output_path:one});
  await call('markdown_to_pdf',{markdown_text:'# Second document\n\nBETA document.',output_path:two});
  for(const file of [one,two])assert.equal((await fs.readFile(file)).subarray(0,5).toString(),'%PDF-');
  report.checks.push('Markdown with a table converted to PDF through bundled Pandoc and Typst, outside Harbor.');
  report.merge=await call('merge_pdfs',{pdf_paths:JSON.stringify([one,two]),output_path:merged});
  report.reorder=await call('reorder_pdf_pages',{pdf_path:merged,page_order:JSON.stringify([2,1]),output_path:reordered});
  report.split=await call('split_pdf',{pdf_path:merged,split_method:'pages'});
  report.text=await call('extract_text',{pdf_path:merged});assert.match(JSON.stringify(report.text),/ALPHA/);assert.match(JSON.stringify(report.text),/BETA/);
  report.markdown=await call('pdf_to_markdown',{pdf_path:merged,output_directory:folder,output_filename:'roundtrip.md',include_images:false,include_vectors:false});
  report.images=await call('convert_to_images',{pdf_path:merged,pages:'1',dpi:100,output_prefix:'preview'});
  const form=path.join(folder,'form.pdf'),filled=path.join(folder,'filled.pdf');
  report.form=await call('create_form_pdf',{output_path:form,fields:JSON.stringify([{name:'project',type:'text',label:'Project'}])});
  report.filled=await call('fill_form_pdf',{input_path:form,output_path:filled,form_data:JSON.stringify({project:'Harbor'})});
  report.formData=await call('extract_form_data',{pdf_path:filled});assert.match(JSON.stringify(report.formData),/Harbor/);
  report.checks.push('Created, filled and read back a PDF form.');
  report.checks.push('Merged, split and reordered PDFs; extracted both text markers; converted PDF to Markdown and PNG.');
  report.files=(await fs.readdir(folder)).sort();
  assert(report.files.includes('roundtrip.md'));assert(report.files.some(n=>n.endsWith('.png')));
  const pages=file=>JSON.parse(execFileSync(path.join(root,'runtimes/python/python.exe'),['-c','import pymupdf,json,sys; d=pymupdf.open(sys.argv[1]); print(json.dumps([p.get_text() for p in d]))',file],{env,encoding:'utf8',windowsHide:true}));
  const mergedPages=pages(merged),reorderedPages=pages(reordered);
  assert.equal(mergedPages.length,2);assert.match(mergedPages[0],/ALPHA/);assert.match(mergedPages[1],/BETA/);
  assert.equal(reorderedPages.length,2);assert.match(reorderedPages[0],/BETA/);assert.match(reorderedPages[1],/ALPHA/);
  assert.match(await fs.readFile(path.join(folder,'roundtrip.md'),'utf8'),/ALPHA/);
  report.checks.push('Independent PDF parser confirmed the merged page count and reordered text sequence.');
  report.success=true;
}catch(error){report.error=error.stack;report.stderr=stderr;process.exitCode=1;}
finally{await client.close();await fs.writeFile(path.join(folder,'acceptance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
