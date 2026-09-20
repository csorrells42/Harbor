import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema, PromptListChangedNotificationSchema, ResourceUpdatedNotificationSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {createMcpPrimitives,preserveMessageOrder} from './mcp-primitives.mjs';
import {catalogDigest,exposedName,launchFingerprint} from './catalog-cache.mjs';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import Ajv2019 from 'ajv/dist/2019.js';
import { buildLaunchSpec } from './launch.mjs';
import { withDeadline } from './deadline.mjs';
import { launchManaged, assertEndpointAvailable } from './managed-processes.mjs';
import { setTimeout as delay } from 'node:timers/promises';

export class Upstreams {
  constructor(configs, log, changed = () => {}, { requestTimeoutMs = 10000, catalogCache, idleSweepMs=10000, now=Date.now } = {}) {
    this.catalogCache=catalogCache;this.now=now;
    this.entries = new Map(configs.map(c => [c.id, this.entry(c)]));
    this.log = log;
    this.changed = changed;
    this.requestTimeoutMs = requestTimeoutMs;
    this.mcp=createMcpPrimitives(this);
    this.idleTimer=setInterval(()=>void this.sweepIdle(),idleSweepMs);this.idleTimer.unref();
  }
  entry(config) { return { config, status: 'stopped', tools: [], cached:this.catalogCache?.get(config)?.tools??[], queue: Promise.resolve(), desired: false, failures: 0, active:0,idleUncertain:false,pins:new Set(),lastUsed:this.now(),generation:0 }; }
  get(id) { const entry = this.entries.get(id); if (!entry) throw new Error(`Unknown server id: ${id}`); return entry; }
  serial(id, fn) {
    const entry = this.get(id);
    const task = entry.queue.then(() => fn(entry));
    entry.queue = task.catch(() => {});
    return task;
  }
  async set(config) {
    const old = this.entries.get(config.id);
    if (old) { const changed=launchFingerprint(old.config)!==launchFingerprint(config);old.generation++;await this.stop(config.id); old.config = config;old.demandBlocked=false;if(changed){old.cached=[];await this.catalogCache?.invalidate(config.id);} }
    else this.entries.set(config.id, this.entry(config));
    this.changed();
  }
  setStartup(id,enabled){
    const e=this.get(id);
    e.config={...e.config,autoStart:enabled,...(!enabled?{autoRestart:false}:{})};
    if(!enabled){e.desired=false;clearTimeout(e.retry);e.retry=undefined;}
  }
  async remove(id) {
    const e = this.get(id);e.generation++;e.demandBlocked=true;e.demandAbort?.abort(new Error('Server removed')); e.desired = false; clearTimeout(e.retry); e.retry = undefined;
    if (e.status === 'starting') e.startAbort?.abort(new Error('Startup cancelled by remove'));
    return this.serial(id, async e => {
      e.removed = true; e.desired = false;
      await this.stopEntry(e);
      this.entries.delete(id);
      await this.catalogCache?.invalidate(id);
    });
  }
  snapshot() { return [...this.entries.values()].map(e => ({ ...e.config, status: e.status, error: e.error, toolCount: e.tools.length,cachedToolCount:e.cached.length,onDemandBlocked:!!e.demandBlocked,onDemandOwned:!!e.demandOwned,idleUncertain:e.idleUncertain,activeCalls:e.active,sessionPins:e.pins.size, pid: e.transport?.pid ?? e.owned?.[0]?.record.pid, ownership: e.config.transport === 'stdio' ? 'stdio' : e.config.managedProcesses?.length ? 'managed' : 'external', processes: (e.owned ?? []).map(p => ({ ...p.record })) })); }
  tools() { return [...this.entries.values()].flatMap(e => e.config.enabled===false?[]:e.status==='running'?e.tools:e.config.onDemand&&!e.demandBlocked?e.cached:[]); }
  start(id) { return this.serial(id, e => { if (e.removed||e.config.enabled===false) throw new Error(`Server removed or disabled: ${id}`);e.demandOwned=false;e.demandBlocked=false; e.desired = true; clearTimeout(e.retry); e.retry = undefined; return this.startEntry(e); }); }
  stop(id) {
    const e = this.get(id);e.generation++;e.demandBlocked=true;e.demandOwned=false;e.demandAbort?.abort(new Error('On-demand startup cancelled by Stop')); e.desired = false; clearTimeout(e.retry); e.retry = undefined;
    if (e.status === 'starting') e.startAbort?.abort(new Error('Startup cancelled by stop'));
    return this.serial(id, e => { e.desired = false; return this.stopEntry(e); });
  }
  restart(id) { const entry=this.get(id);entry.generation++;entry.demandAbort?.abort(new Error('On-demand startup cancelled by Restart'));return this.serial(id, async e => { if (e.removed||e.config.enabled===false) throw new Error(`Server removed or disabled: ${id}`);e.demandOwned=false;e.demandBlocked=false; e.desired = false; clearTimeout(e.retry); e.retry = undefined; await this.stopEntry(e); e.desired = true; await this.startEntry(e); }); }
  retainServers(ids,owner){for(const id of ids)this.entries.get(id)?.pins.add(owner);return ()=>{for(const id of ids){const e=this.entries.get(id);if(e){e.pins.delete(owner);e.lastUsed=this.now();}}};}
  async invalidateCatalogs(){for(const e of this.entries.values())e.cached=[];await this.catalogCache?.invalidate();this.changed();}
  async sweepIdle(){
    if(this.closing)return;
    await Promise.allSettled([...this.entries.values()].filter(e=>e.demandOwned&&!e.idleUncertain&&e.status==='running'&&!e.active&&!e.pins.size&&this.now()-e.lastUsed>=(e.config.idleMinutes??5)*60000).map(e=>this.serial(e.config.id,async()=>{
      if(e.demandOwned&&!e.idleUncertain&&!e.active&&!e.pins.size&&this.now()-e.lastUsed>=(e.config.idleMinutes??5)*60000){e.desired=false;await this.stopEntry(e);e.demandOwned=false;}
    })));
  }
  async invoke(tool,args={},options={}){
    const e=this.get(tool.serverId),generation=e.generation;
    if(this.closing||e.removed||e.config.enabled===false)throw new Error('Server removed, disabled or closing');
    options.signal?.throwIfAborted();e.active++;
    try{
      if(e.status!=='running'){
        if(!e.config.onDemand||e.demandBlocked)throw new Error('Upstream not available; start it explicitly');
        if(!e.demandStart){
          const abort=new AbortController();e.demandAbort=abort;
          const task=this.serial(e.config.id,async()=>{
            abort.signal.throwIfAborted();if(e.removed||e.config.enabled===false||e.demandBlocked||e.generation!==generation)throw new Error('Server changed before on-demand startup');
            if(e.status==='running')return;
            e.desired=false;e.demandOwned=true;
            const cancel=()=>e.startAbort?.abort(abort.signal.reason);abort.signal.addEventListener('abort',cancel,{once:true});
            try{await this.startEntry(e);}finally{abort.signal.removeEventListener('abort',cancel);}
          });
          e.demandStart=task;
          task.finally(()=>{if(e.demandStart===task){e.demandStart=null;e.demandAbort=null;}}).catch(()=>{});
        }
        await new Promise((resolve,reject)=>{
          const cancelled=()=>{cleanup();reject(options.signal.reason??new Error('Startup cancelled'));};
          const cleanup=()=>options.signal?.removeEventListener('abort',cancelled);
          options.signal?.addEventListener('abort',cancelled,{once:true});
          e.demandStart.then(()=>{cleanup();resolve();},error=>{cleanup();reject(error);});
          if(options.signal?.aborted)cancelled();
        });
      }
      options.signal?.throwIfAborted();
      if(this.closing||e.removed||e.config.enabled===false||e.generation!==generation||e.status!=='running')throw new Error('Server changed before invocation');
      const live=e.tools.find(value=>value.name===tool.name);
      if(!live||catalogDigest(live)!==catalogDigest(tool))throw new Error('Tool schema changed or its contract was updated; refresh discovery before invoking it. No tool was called.');
      if(e.config.onDemand){
        let valid;try{
          const dialect=live.inputSchema.$schema??'',Ajv=dialect.includes('2020-12')?Ajv2020:dialect.includes('2019-09')?Ajv2019:null;
          const validator=new AjvJsonSchemaValidator(Ajv?new Ajv({strict:false,validateFormats:false}):undefined);
          valid=validator.getValidator(live.inputSchema)(args).valid;
        }catch{throw new Error('Live tool schema could not be validated; no tool was called');}
        if(!valid)throw new Error('Arguments do not match the live tool schema; no tool was called');
      }
      try{return await e.client.callTool({name:live.originalName,arguments:args},undefined,options);}
      catch(error){
        // A timeout, cancellation or lost response cannot prove the upstream
        // operation has ended. Keep its process until an explicit ownership
        // reset; never let the idle timer terminate potentially active work.
        if(e.generation===generation){e.idleUncertain=true;this.changed();}
        throw error;
      }
    }finally{
      e.active--;e.lastUsed=this.now();
      if(!e.active&&e.demandStart){e.demandAbort?.abort(new Error('All startup callers cancelled'));await e.demandStart.catch(()=>{});}
    }
  }
  scheduleRestart(e) {
    if (this.closing || !e.desired || !e.config.autoRestart || e.retry) return;
    if (e.startedAt && Date.now() - e.startedAt > 30000) e.failures = 0;
    const delay = Math.min(30000, 500 * 2 ** Math.min(e.failures++, 6));
    this.log(e.config.id, 'warn', `Auto-restart in ${delay} ms`);
    e.retry = setTimeout(() => {
      e.retry = undefined;
      if (e.desired && !this.closing) this.start(e.config.id).catch(() => {});
    }, delay);
    e.retry.unref();
  }
  async refresh(e, client) {
    const tools = []; const seen = new Set(); const names = new Set(); let cursor;
    if (client.getServerCapabilities()?.tools) do {
      const result = await client.listTools(cursor === undefined ? {} : { cursor }, { timeout: this.requestTimeoutMs });
      for (const tool of result.tools) {
        if (names.has(tool.name)) throw new Error(`Duplicate upstream tool: ${tool.name}`);
        names.add(tool.name);
        tools.push({ ...tool, name: exposedName(e.config.id, tool.name), serverId: e.config.id, originalName: tool.name });
      }
      cursor = result.nextCursor;
      if (cursor !== undefined && seen.has(cursor)) throw new Error('Upstream tool pagination repeated a cursor');
      seen.add(cursor);
      if (seen.size > 1000 || tools.length > 10000) throw new Error('Upstream tool listing exceeds safety limit');
    } while (cursor !== undefined);
    if (e.client === client) { e.tools = tools;e.cached=structuredClone(tools);await this.catalogCache?.set(e.config,tools); this.changed(); }
  }
  async reapOwned(e) {
    const owned = e.owned ?? []; e.owned = undefined;
    await Promise.all(owned.map(p => p.close()));
    if (owned.some(p => p.record.runtime === 'wsl')) {
      // WSL localhost forwarding can outlive the Linux listener briefly. Wait
      // for release, never kill the forwarding host or bypass the next preflight.
      const deadline = Date.now() + this.requestTimeoutMs;
      while (Date.now() < deadline) {
        try { await assertEndpointAvailable(e.config.url, Math.min(500, deadline - Date.now())); return; }
        catch { await delay(100); }
      }
      this.log(e.config.id, 'warn', 'Owned Linux processes stopped, but the endpoint remains reachable; subsequent startup will refuse it');
    }
  }
  ownedFailure(e, error) {
    if (e.status === 'starting') { e.startAbort?.abort(error); return; }
    if (e.status !== 'running') return;
    e.status = 'error'; e.error = error.message; e.tools = []; this.changed();
    // Serialize cleanup ahead of any retry or user start; no overlapping trees.
    this.serial(e.config.id, async () => {
      await this.stopEntry(e);
      e.status = 'error'; e.error = error.message; this.changed(); this.scheduleRestart(e);
    }).catch(error => this.log(e.config.id, 'error', error.message));
  }
  recoverManagedConnection(e, error) {
    // A dropped event stream is not evidence that an owned application died.
    // Hide stale tools, replace the MCP session, and retain the live process tree
    // only when initialization and fresh discovery succeed within the deadline.
    const previous=e.client;
    e.client=undefined;e.transport=undefined;e.tools=[];
    e.status='starting';e.error=error.message;e.startAbort=new AbortController();
    this.changed();
    this.serial(e.config.id,async()=>{
      try{
        if(previous?.transport?.terminateSession)await withDeadline(previous.transport.terminateSession(),Math.min(5000,this.requestTimeoutMs)).catch(()=>{});
        await previous?.close();
        e.startAbort.signal.throwIfAborted();
        if(this.closing||!e.desired||e.removed)return;
        await this.startEntry(e,{managedAttempt:true,timeoutMs:this.requestTimeoutMs});
        this.log(e.config.id,'info','MCP connection recovered; owned processes retained');
      }catch(failure){
        await this.stopEntry(e);
        if(this.closing||!e.desired||e.removed)return;
        e.status='error';e.error=failure.message;this.changed();this.scheduleRestart(e);
      }
    }).catch(failure=>this.log(e.config.id,'error',failure.message));
  }
  async startManaged(e) {
    e.status = 'starting'; e.error = undefined; e.startAbort = new AbortController();
    const signal = e.startAbort.signal;
    const deadline = Date.now() + this.requestTimeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    try {
      await assertEndpointAvailable(e.config.url, Math.min(1000, remaining()), signal);
      e.owned = [];
      for (const spec of e.config.managedProcesses) {
        signal.throwIfAborted();
        const owned = launchManaged(spec, message => this.log(e.config.id, 'info', message), error => this.ownedFailure(e, error));
        e.owned.push(owned);
        await withDeadline(owned.ready, remaining(), signal);
      }
      let lastError;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        try { await this.startEntry(e, { managedAttempt: true, timeoutMs: remaining() }); return; }
        catch (error) { lastError = error; }
        await delay(Math.min(100, remaining()), undefined, { signal });
      }
      throw new Error(`Managed MCP startup timed out after ${this.requestTimeoutMs} ms: ${lastError?.message ?? 'not ready'}`);
    } catch (error) {
      error = signal.aborted ? signal.reason : error;
      await this.reapOwned(e);
      e.status = 'error'; e.error = error.message; e.tools = []; this.changed(); this.scheduleRestart(e);
      throw error;
    }
  }
  async startEntry(e, { managedAttempt = false, timeoutMs = this.requestTimeoutMs } = {}) {
    if (e.status === 'running') return;
    if (!managedAttempt && e.config.transport !== 'stdio' && e.config.managedProcesses?.length) return this.startManaged(e);
    e.status = 'starting'; e.error = undefined;
    if (!managedAttempt) e.startAbort = new AbortController();
    this.log(e.config.id, 'info', 'Starting upstream');
    const client = new Client({ name: 'mcp-harbor', version: '0.1.0' }, { capabilities: {} });
    const transport = e.config.transport === 'http' ? new StreamableHTTPClientTransport(new URL(e.config.url))
      : e.config.transport === 'sse' ? new SSEClientTransport(new URL(e.config.url))
        : new StdioClientTransport(buildLaunchSpec(e.config));
    preserveMessageOrder(transport);
    client.fallbackRequestHandler=async request=>{throw new McpError(ErrorCode.MethodNotFound,`Harbor does not support upstream ${request.method}; originating-client routing has not been enabled`);};
    // SDK Client.connect initiates close without awaiting it on handshake errors.
    // Memoize close so our lifecycle waits for that same process-reaping operation.
    const closeTransport = transport.close.bind(transport);
    let closingTransport;
    transport.close = () => closingTransport ??= closeTransport();
    e.client = client; e.transport = transport;
    transport.stderr?.on('data', chunk => this.log(e.config.id, 'info', chunk.toString().trimEnd()));
    let transportError;
    client.onerror = error => {
      transportError ??= error; this.log(e.config.id, 'error', error.message);
      if (e.client === client && e.status === 'running' && e.config.transport !== 'stdio') {
        this.mcp.reset(e.config.id);
        if (managedAttempt) { this.recoverManagedConnection(e, error); return; }
        e.client = undefined; e.transport = undefined; e.tools = [];
        e.status = 'error'; e.error = error.message; this.changed();
        // Network SDK transports may report disconnection only through onerror.
        // Stop their internal reconnect loop; the manager owns backoff/re-init.
        transport.close().catch(() => {}).finally(() => this.scheduleRestart(e));
      }
    };
    client.onclose = () => {
      if (e.client !== client) return;
      this.mcp.reset(e.config.id);
      if (managedAttempt) { if (e.status === 'running') this.recoverManagedConnection(e, new Error('Upstream disconnected unexpectedly')); return; }
      e.client = undefined; e.transport = undefined; e.tools = [];
      e.status = 'error'; e.error = 'Upstream disconnected unexpectedly';
      this.log(e.config.id, 'error', e.error); this.changed(); this.scheduleRestart(e);
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      e.refreshQueue = (e.refreshQueue ?? Promise.resolve()).then(() => {
        if (e.client === client) return this.refresh(e, client);
      }).catch(error => this.log(e.config.id, 'error', `Tool refresh failed: ${error.message}`));
    });
    for(const [schema,kind] of [[ResourceListChangedNotificationSchema,'resources'],[PromptListChangedNotificationSchema,'prompts'],[ResourceUpdatedNotificationSchema,'updated']])client.setNotificationHandler(schema,notification=>{
      if(e.client===client&&e.status==='running')this.mcp.notify({kind,serverId:e.config.id,client,uri:notification.params?.uri});
    });
    try {
      const attemptDeadline = Date.now() + timeoutMs;
      await withDeadline(client.connect(transport, { timeout: timeoutMs, signal: e.startAbort.signal }), timeoutMs, e.startAbort.signal);
      await withDeadline(this.refresh(e, client), managedAttempt ? Math.max(1, attemptDeadline - Date.now()) : timeoutMs, e.startAbort.signal);
      e.status = 'running'; e.startedAt = Date.now();
      this.log(e.config.id, 'info', `Running; ${e.tools.length} tools available`);
      this.changed();
    } catch (error) {
      error = transportError ?? error;
      e.status = managedAttempt ? 'starting' : 'error'; e.error = error.message; e.tools = [];
      this.log(e.config.id, 'error', error.message);
      e.client = undefined; e.transport = undefined;
      await transport.close().catch(() => {});
      this.changed(); if (!managedAttempt) this.scheduleRestart(e);
      throw error;
    }
  }
  async stopEntry(e) {
    this.mcp.reset(e.config.id);
    const client = e.client;
    e.client = undefined; e.transport = undefined;
    e.tools = []; e.status = 'stopped'; e.error = undefined;
    if (client) {
      if (client.transport?.terminateSession) await withDeadline(client.transport.terminateSession(), this.requestTimeoutMs).catch(error => this.log(e.config.id, 'warn', `Session termination: ${error.message}`));
      await client.close().catch(error => this.log(e.config.id, 'error', error.message));
    }
    await this.reapOwned(e);
    e.idleUncertain=false;
    this.log(e.config.id, 'info', 'Stopped');
    this.changed();
  }
  async close() { this.closing = true;clearInterval(this.idleTimer); await Promise.all([...this.entries.keys()].map(id => this.stop(id)));await this.catalogCache?.close(); }
}
