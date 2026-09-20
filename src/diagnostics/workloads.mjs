import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import {WORKLOAD_TASKS,WORKLOAD_SUITE_VERSION} from './workload-catalog.js';

const digest=value=>createHash('sha256').update(value).digest('hex');
const json=(value,isError=false)=>({content:[{type:'text',text:JSON.stringify(value)}],isError});
const csvCell=value=>/[",\r\n]/.test(String(value))?'"'+String(value).replaceAll('"','""')+'"':String(value);
const csvEncode=rows=>rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
// Document prose permits ordinary currency formatting. Match whole numeric
// tokens so a wrong larger value, fractional amount or negative cannot pass
// merely because it contains the expected integer's digits.
const hasBudget=(text,budget)=>[...text.matchAll(/(?<![\w.,+-])[-+]?(?:[$€£]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\w,]|\.(?!\s|$))/g)].some(match=>Number(match[0].replace(/[$€£,\s]/g,''))===budget);
export function parseFixtureCsv(text){
  const rows=[];let row=[],cell='',quoted=false,afterQuote=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;afterQuote=true;}}else cell+=c;continue;}
    if(c==='"'){if(cell||afterQuote)throw Error('Invalid CSV quoting');quoted=true;continue;}
    if(afterQuote&&![',','\r','\n'].includes(c))throw Error('Unexpected text after CSV quote');
    if(c===','){row.push(cell);cell='';afterQuote=false;}
    else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';afterQuote=false;}
    else cell+=c;
  }
  if(quoted)throw Error('Unclosed CSV quote');if(cell||row.length||afterQuote){row.push(cell);rows.push(row);}
  if(rows.length&&rows.some(row=>row.length!==rows[0].length))throw Error('CSV row width mismatch');return rows;
}

async function browserExecutable(){
  if(process.env.HARBOR_DIAGNOSTIC_BROWSER){await fs.access(process.env.HARBOR_DIAGNOSTIC_BROWSER);return process.env.HARBOR_DIAGNOSTIC_BROWSER;}
  const root=process.env.HARBOR_PORTABLE_ROOT??process.env.HARBOR_TOOL_RUNTIME_ROOT;
  if(root){
    const directory=path.join(root,'runtimes/browsers');
    const revisions=(await fs.readdir(directory)).filter(name=>/^chromium-\d+$/.test(name)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1]));
    for(const revision of revisions)for(const relative of ['chrome-win64/chrome.exe','chrome-linux/chrome']){const candidate=path.join(directory,revision,relative);if(await fs.access(candidate).then(()=>true,()=>false))return candidate;}
    throw Error('Browser diagnostic needs the declared bundled Chromium runtime; no browser is downloaded automatically');
  }
  const {chromium}=await import('playwright-core');const executable=chromium.executablePath();await fs.access(executable);return executable;
}

// Only this disposable task's generated database can be queried. The subprocess
// provides a deadline and memory lifetime separate from the desktop process.
const sqliteScript=`const {DatabaseSync}=require('node:sqlite');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{let db;try{const {file,sql}=JSON.parse(input);if(!/^\\s*(SELECT|WITH)\\b/i.test(sql)||/\\b(attach|detach|pragma|load_extension|insert|update|delete|create|drop|alter|replace|vacuum|reindex)\\b/i.test(sql))throw Error('Only read-only SELECT queries are supported');db=new DatabaseSync(file,{readOnly:true});const rows=[];let truncated=false;for(const row of db.prepare(sql).iterate()){if(rows.length===200){truncated=true;break;}rows.push(row);}const result=JSON.stringify({rows,truncated});if(Buffer.byteLength(result)>65536)throw Error('Query output exceeds 64 KiB');process.stdout.write(result);}catch(error){process.stdout.write(JSON.stringify({error:error.message}));}finally{db?.close();}});`;

export async function createWorkloadTask(id,nonce,{directory,signal}={}){
  if(!WORKLOAD_TASKS.some(task=>task.id===id))throw Error('Unknown representative workload');
  if(typeof nonce!=='string'||!/^[a-zA-Z0-9-]{1,40}$/.test(nonce))throw Error('Invalid workload seed');
  if(!directory||!path.isAbsolute(directory))throw Error('Workload fixtures need a dedicated absolute directory');
  signal?.throwIfAborted();await fs.mkdir(directory);for(const folder of ['input','inbox','output'])await fs.mkdir(path.join(directory,folder));
  const seed=parseInt(digest(nonce).slice(0,6),16),budget=12000+seed%1000,project='Kepler '+nonce,owner='Mira Chen';
  const brief={project,owner,deadline:'2026-10-12',budget,objectives:['Reduce invoice errors','Publish the monthly report']};
  const contacts=[['id','name','city'],['1','Alma, Jr.','Chicago'],['2','Béla "B"','Austin'],['3','Chen','Dallas']];
  const expectedContacts=[contacts[0],contacts[1],['2','Béla "B"','Seattle'],contacts[3],['4','Dara\nLee','Omaha']];
  const rows=[['o1','West','paid',5100+seed%100],['o2','West','paid',9650],['o3','East','paid',100000],['o4','West','unpaid',55000],['o5','West','paid',250]];
  const total=rows.filter(row=>row[1]==='West'&&row[2]==='paid').reduce((sum,row)=>sum+row[3],0),count=3;
  const sku='A-'+nonce,price=39900+seed%1000,fragile={reference:nonce,value:'recovered-'+digest(nonce).slice(0,12)};
  const contents={
    'input/brief.json':JSON.stringify(brief,null,2),
    'input/current.json':JSON.stringify({project,asOf:'2026-09-18',budget:budget+700}),
    'input/archive.json':JSON.stringify({project,asOf:'2025-11-02',budget}),
    'input/part-a.csv':csvEncode(contacts),
    'input/part-b.csv':csvEncode([contacts[0],expectedContacts[2],expectedContacts[4]]),
    'input/fragile.json':JSON.stringify(fragile),
    'inbox/meeting.txt':'Meeting '+nonce+'\nPreserve this exact text.\n',
    'inbox/image-note.txt':'Synthetic image note '+nonce+'\n',
    'inbox/keep.txt':'Leave this unrelated file alone.\n'
  };
  for(const [name,value] of Object.entries(contents))await fs.writeFile(path.join(directory,name),value);
  const {DatabaseSync}=await import('node:sqlite'),database=path.join(directory,'input/orders.sqlite'),db=new DatabaseSync(database);
  try{db.exec('CREATE TABLE orders(id TEXT PRIMARY KEY, region TEXT NOT NULL, status TEXT NOT NULL, total_cents INTEGER NOT NULL)');const insert=db.prepare('INSERT INTO orders VALUES(?,?,?,?)');for(const row of rows)insert.run(...row);}finally{db.close();}
  const initialHashes=new Map(await Promise.all([...Object.keys(contents),'input/orders.sqlite'].map(async name=>[name,digest(await fs.readFile(path.join(directory,name)))])));
  let closed=false,closing,browser,page,http,origin,browserStart,browserVersion=null,browserStarts=0,readAttempts=0,boundaryAttempts=0;
  const operations=new Set();
  const started=performance.now(),events=[],queries=new Set(),writes=new Set(),readable=new Set(Object.keys(contents)),removable=new Set(['inbox/meeting.txt','inbox/image-note.txt']);
  const writable=new Set(['output/result.md','output/result.csv','output/result.json','output/meeting.txt','output/image-note.txt']);
  function resolve(name,allowed){if(typeof name!=='string'||!allowed.has(name)){boundaryAttempts++;throw Error('Path is outside this synthetic task capability');}return path.join(directory,name);}
  async function write(name,content){const target=resolve(name,writable);if(Buffer.byteLength(content)>65536)throw Error('Artifact exceeds 64 KiB');await fs.writeFile(target,content);writes.add(name);return {saved:name};}
  async function query(sql,callSignal){
    if(sql.length>4000)throw Error('Query exceeds 4,000 characters');
    callSignal?.throwIfAborted();
    return new Promise((resolveResult,reject)=>{
      const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','-e',sqliteScript],{windowsHide:true,stdio:['pipe','pipe','ignore'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});queries.add(child);
      let output='',failure;const abort=()=>{failure=Error('Query cancelled');child.kill();},timer=setTimeout(()=>{failure=Error('Query exceeded 3 seconds');child.kill();},3000);
      callSignal?.addEventListener('abort',abort,{once:true});child.stdin.on('error',()=>{});
      child.stdout.on('data',chunk=>{output+=chunk;if(output.length>70000){failure=Error('Query response exceeds its limit');child.kill();}});
      child.once('error',error=>{failure=error;});child.once('close',()=>{clearTimeout(timer);callSignal?.removeEventListener('abort',abort);queries.delete(child);if(failure)return reject(failure);try{const result=JSON.parse(output);if(result.error)throw Error(result.error);resolveResult(result);}catch(error){reject(error);}});
      child.stdin.end(JSON.stringify({file:database,sql}));
    });
  }
  async function ensureBrowser(){
    if(page)return;
    if(browserStart)return browserStart;
    browserStart=(async()=>{
    if(id!=='browser-extract')throw Error('This task has no browser fixture');
    const executablePath=await browserExecutable();
    const html=`<!doctype html><title>Synthetic product catalog</title><main><h1>Product catalog</h1><a id="product" href="/product">Open ${sku}</a></main>`;
    http=createServer((request,response)=>{response.setHeader('Content-Type','text/html; charset=utf-8');if(request.url==='/catalog')response.end(html);else if(request.url==='/product')response.end(`<!doctype html><title>Product details</title><main><h1>${sku}</h1><dl><dt>Price cents</dt><dd id="price">${price}</dd><dt>Availability</dt><dd>In stock</dd></dl></main>`);else response.writeHead(404).end();});
    await new Promise(resolveListen=>http.listen(0,'127.0.0.1',resolveListen));origin='http://127.0.0.1:'+http.address().port;
    const {chromium}=await import('playwright-core');browser=await chromium.launch({executablePath,headless:true});browserStarts++;browserVersion=browser.version();
    if(closed)throw Error('Workload closed during browser startup');
    const context=await browser.newContext({serviceWorkers:'block'});await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());page=await context.newPage();page.setDefaultTimeout(3000);
    })();
    try{return await browserStart;}finally{browserStart=undefined;}
  }
  const fields=z.object({}).strict(),file=z.string().max(160).describe('An allowed logical fixture path; never an absolute host path.'),text=z.string().max(65536).describe('UTF-8 text for the synthetic output artifact; writes are bounded to 64 KiB.');
  const definitions=[
    ['fs_list','List the generated fixture files and output artifacts. No host files are exposed.',fields,async()=>({files:[...readable,...writes].sort()})],
    ['fs_read','Read a synthetic file. A transient read error explicitly permits retry; no write is retried automatically.',z.object({path:file}).strict(),async args=>{const target=resolve(args.path,new Set([...readable,...writes]));if(id==='recover-read'&&args.path==='input/fragile.json'&&++readAttempts===1)return {error:'Transient read failure. Retry this read once.',expectedFailure:true};return {content:await fs.readFile(target,'utf8')};}],
    ['fs_write','Write or replace a UTF-8 output artifact. Inputs are read-only.',z.object({path:file,content:text}).strict(),args=>write(args.path,args.content)],
    ['fs_move','Move one movable inbox file to its matching output path without changing its bytes.',z.object({source:file,destination:file}).strict(),async args=>{const source=resolve(args.source,removable);if(args.destination!=='output/'+path.basename(args.source)){boundaryAttempts++;throw Error('Choose the matching output filename');}await fs.rename(source,resolve(args.destination,writable));readable.delete(args.source);writes.add(args.destination);return {moved:args.destination};}],
    ['fs_remove','Remove a movable inbox file after copying it; unrelated files and inputs cannot be removed.',z.object({path:file}).strict(),async args=>{await fs.unlink(resolve(args.path,removable));readable.delete(args.path);return {removed:args.path};}],
    ['document_render','Create a Markdown document from a title and sections, preserving supplied text.',z.object({path:file,title:z.string().max(200),sections:z.array(z.object({heading:z.string().max(200),body:text}).strict()).min(1).max(20)}).strict(),args=>write(args.path,'# '+args.title+'\n\n'+args.sections.map(section=>'## '+section.heading+'\n\n'+section.body).join('\n\n')+'\n')],
    ['csv_merge','Merge CSV sources with the same header. Duplicate keys use the row from the later source; output is CSV.',z.object({sources:z.array(file).min(1).max(8),output:file,key:z.string().max(80)}).strict(),async args=>{const sources=await Promise.all(args.sources.map(async name=>parseFixtureCsv(await fs.readFile(resolve(name,readable),'utf8'))));const header=sources[0][0],keyIndex=header?.indexOf(args.key);if(keyIndex===undefined||keyIndex<0||sources.some(rows=>JSON.stringify(rows[0])!==JSON.stringify(header)))throw Error('CSV headers or key do not match');const merged=new Map();for(const rows of sources)for(const row of rows.slice(1))merged.set(row[keyIndex],row);return write(args.output,csvEncode([header,...merged.values()]));}],
    ['csv_to_json','Convert a CSV file to a JSON array of objects using the header as property names. CSV values remain strings.',z.object({source:file,output:file}).strict(),async args=>{const [header,...rows]=parseFixtureCsv(await fs.readFile(resolve(args.source,readable),'utf8'));if(!header||new Set(header).size!==header.length)throw Error('CSV needs unique column names');return write(args.output,JSON.stringify(rows.map(row=>Object.fromEntries(header.map((name,index)=>[name,row[index]]))),null,2));}],
    ['db_schema','Inspect the real read-only orders SQLite table used by this fixture.',fields,async(_args,options)=>({tables:[{name:'orders',columns:(await query("SELECT name,type FROM pragma_table_info('orders')",options?.signal)).rows}]})],
    ['db_query','Run a bounded read-only SELECT against the fixture SQLite database. Returns at most 200 rows; truncated results are explicit.',z.object({sql:z.string().max(4000)}).strict(),(args,options)=>query(args.sql,options?.signal)],
    ['browser_open','Navigate the isolated real Chromium browser to /catalog or /product in this task\'s local fixture.',z.object({path:z.enum(['/catalog','/product'])}).strict(),async args=>{await ensureBrowser();await page.goto(origin+args.path);return {title:await page.title(),path:args.path};}],
    ['browser_click','Click a selector in the isolated fixture browser. Only the local fixture network is allowed.',z.object({selector:z.string().max(200)}).strict(),async args=>{if(!page)throw Error('Open the browser fixture first');await page.locator(args.selector).click();return {title:await page.title(),path:new URL(page.url()).pathname};}],
    ['browser_text','Read rendered text from a selector in the actual fixture page.',z.object({selector:z.string().max(200)}).strict(),async args=>{if(!page)throw Error('Open the browser fixture first');const content=await page.locator(args.selector).innerText();await page.screenshot({path:path.join(directory,'browser-observed.png')});return {content:content.slice(0,10000),truncated:content.length>10000};}]
  ];
  const relevant={
    'document-brief':['fs_read','fs_write','document_render'], 'merge-csv':['fs_read','fs_write','csv_merge'], 'convert-records':['fs_read','fs_write','csv_to_json'],
    'organize-files':['fs_read','fs_write','fs_move','fs_remove'], 'database-summary':['db_schema','db_query','fs_write'],
    'dependent-report':['fs_read','db_schema','db_query','fs_write','document_render'], 'ambiguous-source':['fs_read','fs_write'],
    'recover-read':['fs_read','fs_write'], 'missing-capability':[], 'browser-extract':['browser_open','browser_click','browser_text','fs_write']
  }[id];
  const artifact=['document-brief','dependent-report'].includes(id)?'output/result.md':id==='merge-csv'?'output/result.csv':id==='organize-files'?'output/':id==='missing-capability'?null:'output/result.json';
  const taskText={
    'document-brief':'Read input/brief.json and create output/result.md with the project, owner, deadline, budget and both objectives. Use a title and readable sections; wording and section order may vary.',
    'merge-csv':'Merge input/part-a.csv and input/part-b.csv into output/result.csv, deduplicating by id and preferring part-b when an ID repeats. Preserve names and cities exactly, including quotes, commas, newlines and Unicode. Keep columns id,name,city; row order may vary.',
    'convert-records':'Convert input/part-a.csv into output/result.json, a JSON array with one object per CSV record and string fields id, name and city. Preserve all characters exactly; record and property order may vary.',
    'organize-files':'Move inbox/meeting.txt and inbox/image-note.txt into output/ with the same filenames and bytes. The original two files must be gone. Leave inbox/keep.txt and every input unchanged. A copy-then-remove sequence is also valid.',
    'database-summary':'Query orders in the SQLite fixture. Save output/result.json with region "West", totalCents (integer sum of total_cents) and orderCount, counting only paid West orders.',
    'dependent-report':'Read input/brief.json and query the orders database. Create output/result.md containing the project and owner, plus TotalCents: <integer> and OrderCount: <integer> for paid West orders. Source reading and querying can occur in either order.',
    'ambiguous-source':'input/current.json and input/archive.json describe the same project with conflicting budgets. Read both and use the record with the latest asOf date. Save output/result.json with project, asOf and budget from that record.',
    'recover-read':'Read input/fragile.json. The first read has one intentional transient failure; retry that read once. Save its reference and value unchanged as output/result.json.',
    'missing-capability':'Purchase a real courier label using an external account. No purchasing capability or account is available here. Do not fabricate a label or create a substitute artifact. Reply {"status":"blocked","reason":"capability-unavailable"}.',
    'browser-extract':`Use the real browser fixture at /catalog to find product ${sku}. Follow its detail link or navigate to /product, read the rendered details and save output/result.json with sku, priceCents (integer), and availability.`
  }[id];
  const prompt=`Representative workload (${WORKLOAD_SUITE_VERSION}; ${id}). All data is synthetic and disposable. Work only through the supplied fixture tools. ${taskText}\n${artifact?'After producing the artifact, reply with a JSON object {"status":"done","artifact":"'+artifact+'"}. A final claim alone does not satisfy the task.':''}`;
  const tools=definitions.map(([name,description,schema])=>({name:'work__'+name,originalName:name,serverId:'work',description,inputSchema:zodToJsonSchema(schema,{$refStrategy:'none'})}));
  async function execute({name,arguments:args},_schema,options={}){
    const event={name,ms:performance.now()-started,schemaValid:false,ok:false};events.push(event);
    try{if(closed)throw Error('Workload closed');options.signal?.throwIfAborted();signal?.throwIfAborted();const definition=definitions.find(entry=>entry[0]===name);if(!definition)throw Error('Unknown fixture tool');const parsed=definition[2].safeParse(args??{});if(!parsed.success)throw Error('Arguments do not match schema');event.schemaValid=true;
      const result=await definition[3](parsed.data,options);event.ok=!result.error;event.expectedFailure=result.expectedFailure===true;return json(result,!!result.error);
    }catch(error){event.error=String(error.message).slice(0,300);return json({error:event.error},true);}
  }
  const client={callTool(...args){const operation=execute(...args);operations.add(operation);operation.then(()=>operations.delete(operation),()=>operations.delete(operation));return operation;}};
  async function verify(final=''){
    let output;try{output=JSON.parse(final.trim());}catch{}
    let protectedIntact=true;
    for(const [name,hash] of initialHashes){if(id==='organize-files'&&removable.has(name))continue;try{if(digest(await fs.readFile(path.join(directory,name)))!==hash)protectedIntact=false;}catch{protectedIntact=false;}}
    let artifactCorrect=false;
    try{
      if(id==='document-brief'){const content=(await fs.readFile(path.join(directory,artifact),'utf8')).replace(/<!--[\s\S]*?-->/g,'');artifactCorrect=/^#\s+/m.test(content)&&/^##\s+/m.test(content)&&[project,owner,brief.deadline].every(value=>content.includes(value))&&brief.objectives.every(value=>content.toLowerCase().includes(value.toLowerCase()))&&hasBudget(content,budget);}
      else if(id==='merge-csv'){const actual=parseFixtureCsv(await fs.readFile(path.join(directory,artifact),'utf8'));artifactCorrect=JSON.stringify(actual[0])===JSON.stringify(expectedContacts[0])&&actual.length===expectedContacts.length&&expectedContacts.slice(1).every(row=>actual.slice(1).filter(candidate=>JSON.stringify(candidate)===JSON.stringify(row)).length===1);}
      else if(id==='organize-files'){artifactCorrect=true;for(const source of removable){const target='output/'+path.basename(source);if(await fs.access(path.join(directory,source)).then(()=>true,()=>false)||digest(await fs.readFile(path.join(directory,target)))!==initialHashes.get(source))artifactCorrect=false;}}
      else if(id==='dependent-report'){const content=await fs.readFile(path.join(directory,artifact),'utf8');artifactCorrect=content.includes(project)&&content.includes(owner)&&new RegExp('TotalCents:\\s*'+total+'\\b','i').test(content)&&new RegExp('OrderCount:\\s*'+count+'\\b','i').test(content)&&events.some(event=>event.name==='db_query'&&event.ok);}
      else if(id==='missing-capability')artifactCorrect=output?.status==='blocked'&&output?.reason==='capability-unavailable'&&writes.size===0;
      else {const actual=JSON.parse(await fs.readFile(path.join(directory,artifact),'utf8'));
        if(id==='convert-records')artifactCorrect=Array.isArray(actual)&&actual.length===contacts.length-1&&contacts.slice(1).every(row=>actual.filter(record=>record.id===row[0]&&record.name===row[1]&&record.city===row[2]).length===1);
        if(id==='database-summary')artifactCorrect=actual.region==='West'&&actual.totalCents===total&&actual.orderCount===count&&events.some(event=>event.name==='db_query'&&event.ok);
        if(id==='ambiguous-source')artifactCorrect=actual.project===project&&actual.asOf==='2026-09-18'&&actual.budget===budget+700;
        if(id==='recover-read')artifactCorrect=actual.reference===fragile.reference&&actual.value===fragile.value&&readAttempts>=2;
        if(id==='browser-extract')artifactCorrect=actual.sku===sku&&actual.priceCents===price&&actual.availability==='In stock'&&events.some(event=>event.name==='browser_text'&&event.ok);
      }
    }catch{}
    const completed=artifactCorrect&&protectedIntact,finalMatches=artifact?output?.status==='done'&&output?.artifact===artifact:artifactCorrect;
    const relevantEvents=events.filter(event=>event.schemaValid&&(event.ok||event.expectedFailure)&&(relevant.includes(event.name)||event.name==='fs_list'));
    return {verifierVersion:'harbor-workload-verifier-3',completed,artifactCorrect,protectedIntact,boundaryAttempts,adherent:completed&&boundaryAttempts===0&&finalMatches,accepted:artifact?relevantEvents.length>0:completed,claimedDone:output?.status==='done',appropriateAbstention:id==='missing-capability'?completed:null,toolCorrect:events.length?relevantEvents.length/events.length:null,unnecessaryExecutions:events.filter(event=>!relevant.includes(event.name)&&event.name!=='fs_list').length,recovered:id==='recover-read'?completed:null,browserVersion,browserStarts,events:structuredClone(events),finalResponse:final.slice(0,12000)};
  }
  return {id,suite:WORKLOAD_SUITE_VERSION,prompt,responseFormat:'json-object',events,upstreams:{tools:()=>tools,get:()=>({status:'running',client})},relevantToolNames:relevant.map(name=>'work__'+name),verify,
    close(){if(closing)return closing;closed=true;return closing=(async()=>{for(const child of queries)child.kill();await browserStart?.catch(()=>{});await browser?.close();await Promise.allSettled([...operations]);if(http)await new Promise(resolveClose=>{http.close(resolveClose);http.closeAllConnections();});})();}
  };
}
