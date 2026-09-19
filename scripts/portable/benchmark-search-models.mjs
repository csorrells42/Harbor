// Isolated, read-only catalog benchmark. Does not change Harbor settings or call
// upstream tools. --import instruments only these disposable search workers.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {LOCAL_MODELS,SEARCH_DEFAULTS} from '../../src/core/delivery-options.js';
const idleOnly=process.argv.includes('--idle'),rounds=idleOnly?1:3;
const root=path.resolve(process.argv[2]),out=path.resolve('evidence/portable/search-model-resources'+(idleOnly?'-idle':'')+'.json');
const client=new Client({name:'Read-only search resource benchmark',version:'1'});
let catalog;
try{await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:37373/mcp/_harbor_catalog')));catalog=(await client.listTools()).tools.map(t=>({...t,serverId:t.name.split('__')[0]}));}finally{await client.close();}
const cases=[
  ['Show the files and subfolders inside a directory',/__(list_directory|directory_tree)__/],
  ['Read the text saved in a file',/__(read_file|read_text_file)__/],
  ['Save this text as a new file',/__write_file__/],
  ['Rename a file or move it into another folder',/__move_file__/],
  ['Combine several PDFs into one document',/^pdf-tools__.*merge_/],
  ['Split one PDF into separate documents',/^pdf-tools__.*split_/],
  ['Turn my Typst source into a PDF',/^typst-mcp__doc_(compile|source_to_pdf)__/],
  ['Capture an image of the current browser page',/^playwright__browser_take_screenshot__/],
  ['Open a website in the browser',/^playwright__browser_navigate__/],
  ['Run a SQL query against my database',/^dbhub__execute_sql__/],
  ['Find a function definition in source code',/^serena__find_symbol__/],
  ['Find files whose names match a pattern',/^(filesystem__search_files|serena__find_file|desktop-commander__start_search)__/]
];
for(const [,expected] of cases)if(!catalog.some(t=>expected.test(t.name)))throw new Error(`Expected tool absent: ${expected}`);
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'Harbor search benchmark ')),preload=path.join(directory,'telemetry.mjs');
await fs.writeFile(preload,`const write=process.stdout.write.bind(process.stdout);process.stdout.write=(chunk,...args)=>{let value;try{value=JSON.parse(String(chunk));}catch{}if(value?.id){const r=process.resourceUsage();value._telemetry={rss:process.memoryUsage().rss,peakRss:r.maxRSS*1024,cpu:process.cpuUsage(),time:performance.now()};return write(JSON.stringify(value)+'\\n',...args);}return write(chunk,...args);};`);
const size=async dir=>{let bytes=0;for(const e of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())bytes+=await size(file);else if(e.isFile())bytes+=(await fs.stat(file)).size;}return bytes;};
const results=[],median=items=>[...items].sort((a,b)=>a-b)[Math.floor(items.length/2)];
const deltaCpu=(a,b)=>((b.cpu.user+b.cpu.system)-(a.cpu.user+a.cpu.system))/1000;
try{
  for(let round=0;round<rounds;round++)for(let offset=0;offset<LOCAL_MODELS.length;offset++){
    const model=LOCAL_MODELS[(offset+round)%LOCAL_MODELS.length],settings={...SEARCH_DEFAULTS,portkeyLocalModel:model};
    const started=performance.now(),child=spawn(path.join(root,'runtimes/node/node.exe'),['--import',pathToFileURL(preload).href,path.join(root,'support/portkey-worker.mjs'),root],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let id=0;const pending=new Map();child.stderr.resume();
    createInterface({input:child.stdout}).on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}const entry=pending.get(value.id);if(!entry)return;pending.delete(value.id);value.error?entry.reject(new Error(value.error)):entry.resolve(value);});
    child.on('error',error=>{for(const p of pending.values())p.reject(error);pending.clear();});child.on('exit',()=>{for(const p of pending.values())p.reject(new Error('Worker exited'));pending.clear();});
    const request=op=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{child.kill();reject(new Error('Benchmark request timed out'));},120000);pending.set(n,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});child.stdin.write(JSON.stringify({id:n,mode:'portkey-local',settings,...op})+'\n');});
    try{
      const prepared=await request({op:'prepare'}),initStart=performance.now();
      const indexed=await request({op:'search',tools:catalog,query:'Find a tool for working with documents'});
      const firstMs=performance.now()-started,indexMs=performance.now()-initStart,warm=[];
      let previous=indexed._telemetry;
      for(const [query,expected] of cases){
        const t=performance.now(),reply=await request({op:'search',tools:catalog,query}),elapsed=performance.now()-t;
        warm.push({query,elapsedMs:elapsed,cpuMs:deltaCpu(previous,reply._telemetry),found:reply.result.tools.some(t=>expected.test(t.name)),top:reply.result.tools.map(t=>({name:t.name,score:t.score}))});previous=reply._telemetry;
      }
      let idle;
      if(idleOnly){await new Promise(r=>setTimeout(r,1500));const start=await request({op:'prepare'}),t=performance.now();await new Promise(r=>setTimeout(r,2500));const end=await request({op:'prepare'});idle={elapsedMs:performance.now()-t,cpuMs:deltaCpu(start._telemetry,end._telemetry),rss:end._telemetry.rss};}
      results.push({model,round,idle,baselineRss:prepared._telemetry.rss,loadedRss:previous.rss,peakRss:previous.peakRss,firstMs,indexMs,indexCpuMs:deltaCpu(prepared._telemetry,indexed._telemetry),warm});
      console.log(JSON.stringify({model,round,idle,firstMs:Math.round(firstMs),ramMiB:Math.round(previous.rss/1048576),peakMiB:Math.round(previous.peakRss/1048576),warmMedianMs:Math.round(median(warm.map(x=>x.elapsedMs))*10)/10,retrieval:warm.filter(x=>x.found).length+'/'+warm.length}));
    }finally{if(child.exitCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill();});}
  }
  const summary=[];
  for(const model of LOCAL_MODELS){const runs=results.filter(r=>r.model===model),warm=runs.flatMap(r=>r.warm),times=warm.map(r=>r.elapsedMs).sort((a,b)=>a-b);summary.push({model,modelBytes:await size(path.join(root,'runtimes/embedding-models',model)),loadedRssMedian:median(runs.map(r=>r.loadedRss)),peakRssMax:Math.max(...runs.map(r=>r.peakRss)),firstMsMedian:median(runs.map(r=>r.firstMs)),indexCpuMsMedian:median(runs.map(r=>r.indexCpuMs)),warmMsMedian:median(times),warmMsP95:times[Math.ceil(times.length*.95)-1],warmCpuMsMean:warm.reduce((sum,r)=>sum+r.cpuMs,0)/warm.length,hits:warm.filter(r=>r.found).length,queries:warm.length});}
  const report={observedAt:new Date().toISOString(),rounds,idleOnly,hardware:{cpu:os.cpus()[0].model,logicalProcessors:os.cpus().length,totalMemory:os.totalmem()},catalogTools:catalog.length,catalogHash:createHash('sha256').update(JSON.stringify(catalog)).digest('hex'),method:`${rounds} fresh processes per model, rotating order; ${catalog.length}-tool live catalog; model cache already on disk, OS cache not flushed; 12 different searches per process after initial index; top5/minimum score0.25; process RSS/OS peak working set and CPU time from Node; no upstream tools invoked and no live settings changed.`,summary,results};
  await fs.writeFile(out,JSON.stringify(report,null,2));console.log('REPORT '+out);console.log(JSON.stringify(summary));
}finally{await fs.rm(directory,{recursive:true,force:true});}
