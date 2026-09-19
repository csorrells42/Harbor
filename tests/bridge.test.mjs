import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

test('bridge reconnects notification streams and deletes its session on stdin close',async t=>{
  let streams=0,deleted=false;
  const server=createServer(async(req,res)=>{
    if(req.method==='DELETE'){deleted=true;res.writeHead(200).end();return;}
    if(req.method==='GET'){
      streams++;res.writeHead(200,{'content-type':'text/event-stream'});
      res.write('data: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed',params:{stream:streams}})+'\n\n');
      if(streams===1)res.end();return;
    }
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
    if(body.method==='initialize'){res.writeHead(200,{'content-type':'application/json','mcp-session-id':'notifications'});res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}}));}
    else res.writeHead(202).end();
  }).listen(0,'127.0.0.1');
  await once(server,'listening');
  const child=spawn(process.execPath,['src/bridge.mjs',`http://127.0.0.1:${server.address().port}/mcp`],{stdio:['pipe','pipe','pipe']});
  t.after(()=>{child.kill();server.closeAllConnections();server.close();});
  let finish; const reconnected=new Promise(r=>finish=r);
  createInterface({input:child.stdout}).on('line',line=>{
    const msg=JSON.parse(line);
    if(msg.id===1)child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    if(msg.params?.stream===2)finish();
  });
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'})+'\n');
  let timer;
  try {await Promise.race([reconnected,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Notification stream was not reconnected')),4000);})]);}
  finally{clearTimeout(timer);}
  const closed=once(child,'exit');child.stdin.end();await closed;
  assert.equal(deleted,true);
});

test('bridge rejects invalid JSON-RPC locally and stays alive for subsequent valid messages', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    if (body?.method === 'ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }));
    } else if (body?.method === 'fail') res.writeHead(503).end();
    else res.writeHead(202).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const child = spawn(process.execPath, ['src/bridge.mjs', `http://127.0.0.1:${server.address().port}/mcp`], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  t.after(async () => {
    child.kill(); await exited; lines.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  async function send(raw) {
    let timer;
    try {
      child.stdin.write(raw + '\n');
      const response = await Promise.race([
        iterator.next(),
        exited.then(() => { throw new Error(`Bridge exited: ${stderr}`); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Bridge did not answer: ${stderr}`)), 3000); })
      ]);
      assert.equal(response.done, false, `Bridge stdout closed: ${stderr}`);
      return JSON.parse(response.value);
    } finally { clearTimeout(timer); }
  }
  const invalid = [
    'null', 'false', '1', '"text"', '[]', '[{"jsonrpc":"2.0","id":1,"method":"ping"}]', '{}',
    '{"jsonrpc":"1.0","id":4,"method":"ping"}',
    '{"jsonrpc":"2.0","id":4}', '{"jsonrpc":"2.0","method":4}',
    '{"jsonrpc":"2.0","id":{},"method":"ping"}',
    '{"jsonrpc":"2.0","id":true,"method":"ping"}',
    '{"jsonrpc":"2.0","method":"ping","params":null}',
    '{"jsonrpc":"2.0","method":"ping","params":"bad"}',
    '{"jsonrpc":"2.0","id":4,"method":"ping","result":{}}',
    '{"jsonrpc":"2.0","result":{}}',
    '{"jsonrpc":"2.0","id":4,"result":{},"error":{"code":-1,"message":"bad"}}',
    '{"jsonrpc":"2.0","id":4,"error":null}',
    '{"jsonrpc":"2.0","id":4,"error":{"code":"bad","message":"bad"}}',
    '{"jsonrpc":"2.0","id":4,"error":{"code":-1,"message":4}}'
  ];
  for (const raw of invalid) {
    const response = await send(raw);
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.error?.code, -32600, raw);
    const id = JSON.parse(raw)?.id;
    assert.equal(response.id, typeof id === 'string' || typeof id === 'number' ? id : null);
  }
  const parseError = await send('{');
  assert.equal(parseError.error.code, -32700); assert.equal(parseError.id, null);
  assert.deepEqual(requests, [], 'Invalid input must not reach the HTTP endpoint');
  // A transparent bridge must still relay notifications and downstream replies.
  const valid = [
    { jsonrpc: '2.0', method: 'notifications/test', params: {} },
    { jsonrpc: '2.0', id: 'server-request', result: {} },
    { jsonrpc: '2.0', id: 'server-error', error: { code: -32601, message: 'Not found' } },
    { jsonrpc: '2.0', id: 0, method: 'ping', params: [] }
  ];
  for (const message of valid.slice(0, -1)) child.stdin.write(JSON.stringify(message) + '\n');
  assert.deepEqual(await send(JSON.stringify(valid.at(-1))), { jsonrpc: '2.0', id: 0, result: {} });
  // HTTP operations are concurrent; the reply need not arrive last.
  const deadline = Date.now() + 3000;
  while (requests.length < valid.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(requests.map(JSON.stringify).sort(), valid.map(JSON.stringify).sort());
  assert.equal((await send('{"jsonrpc":"2.0","id":"failure","method":"fail"}')).error.code, -32000);
  assert.deepEqual(await send('{"jsonrpc":"2.0","id":"after","method":"ping"}'), { jsonrpc: '2.0', id: 'after', result: {} });
  assert.equal(stderr, '');
});

// Real HTTP fixture: verifies the standalone adapter's wire transport.
test('stdio bridge negotiates a session and relays concurrent JSON/SSE responses', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(405).end(); return; }
    if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
    let raw=''; for await (const chunk of req) raw += chunk;
    const body=JSON.parse(raw); requests.push({ body, headers:req.headers });
    if(body.method === 'initialize') {
      res.writeHead(200, {'content-type':'application/json','mcp-session-id':'fixture-session'});
      res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}}));
    } else if (body.id === undefined) {res.writeHead(202).end();}
    else if(body.method === 'tools/list') {
      res.writeHead(200, {'content-type':'text/event-stream'});
      res.write('event: message\r\ndata: '+JSON.stringify({jsonrpc:'2.0',id:body.id,result:{tools:[]}})+'\r\n\r\n'); res.end();
    } else {res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:body.params.arguments.text}]}}));}
  }).listen(0,'127.0.0.1');
  await once(server,'listening');
  const child=spawn(process.execPath,['src/bridge.mjs',`http://127.0.0.1:${server.address().port}/mcp`],{stdio:['pipe','pipe','pipe']});
  t.after(async()=>{child.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  let stderr='';child.stderr.on('data',c=>stderr+=c);
  const messages=[]; const pending=new Map();
  createInterface({input:child.stdout}).on('line',line=>{const msg=JSON.parse(line);messages.push(msg);pending.get(msg.id)?.(msg);});
  async function send(id,method,params={}) {
    const response=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Bridge did not answer: ${stderr}`)),5000);pending.set(id,m=>{clearTimeout(timer);resolve(m);});});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return response;
  }
  assert.equal((await send(1,'initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}})).result.serverInfo.name,'fixture');
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const [tools,first,second]=await Promise.all([send(2,'tools/list'),send(3,'tools/call',{name:'echo',arguments:{text:'one'}}),send(4,'tools/call',{name:'echo',arguments:{text:'two'}})]);
  assert.deepEqual(tools.result.tools,[]);
  assert.equal(first.result.content[0].text,'one');assert.equal(second.result.content[0].text,'two');
  assert.ok(requests.filter(r=>r.body.method!=='initialize').every(r=>r.headers['mcp-session-id']==='fixture-session'));
  assert.ok(requests.filter(r=>r.body.method!=='initialize').every(r=>r.headers['mcp-protocol-version']==='2025-03-26'));
});
