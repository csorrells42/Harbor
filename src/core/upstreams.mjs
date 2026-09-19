import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import { buildLaunchSpec } from './launch.mjs';
import { withDeadline } from './deadline.mjs';
import { launchManaged, assertEndpointAvailable } from './managed-processes.mjs';
import { setTimeout as delay } from 'node:timers/promises';

function exposedName(id, name) {
  const digest = createHash('sha256').update(JSON.stringify([id, name])).digest('hex').slice(0, 16);
  return `${id.slice(0, 20)}__${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24)}__${digest}`;
}

export class Upstreams {
  constructor(configs, log, changed = () => {}, { requestTimeoutMs = 10000 } = {}) {
    this.entries = new Map(configs.map(c => [c.id, this.entry(c)]));
    this.log = log;
    this.changed = changed;
    this.requestTimeoutMs = requestTimeoutMs;
  }
  entry(config) { return { config, status: 'stopped', tools: [], queue: Promise.resolve(), desired: false, failures: 0 }; }
  get(id) { const entry = this.entries.get(id); if (!entry) throw new Error(`Unknown server id: ${id}`); return entry; }
  serial(id, fn) {
    const entry = this.get(id);
    const task = entry.queue.then(() => fn(entry));
    entry.queue = task.catch(() => {});
    return task;
  }
  async set(config) {
    const old = this.entries.get(config.id);
    if (old) { await this.stop(config.id); old.config = config; }
    else this.entries.set(config.id, this.entry(config));
  }
  setStartup(id,enabled){
    const e=this.get(id);
    e.config={...e.config,autoStart:enabled,...(!enabled?{autoRestart:false}:{})};
    if(!enabled){e.desired=false;clearTimeout(e.retry);e.retry=undefined;}
  }
  async remove(id) {
    const e = this.get(id); e.desired = false; clearTimeout(e.retry); e.retry = undefined;
    if (e.status === 'starting') e.startAbort?.abort(new Error('Startup cancelled by remove'));
    return this.serial(id, async e => {
      e.removed = true; e.desired = false;
      await this.stopEntry(e);
      this.entries.delete(id);
    });
  }
  snapshot() { return [...this.entries.values()].map(e => ({ ...e.config, status: e.status, error: e.error, toolCount: e.tools.length, pid: e.transport?.pid ?? e.owned?.[0]?.record.pid, ownership: e.config.transport === 'stdio' ? 'stdio' : e.config.managedProcesses?.length ? 'managed' : 'external', processes: (e.owned ?? []).map(p => ({ ...p.record })) })); }
  tools() { return [...this.entries.values()].flatMap(e => e.tools); }
  start(id) { return this.serial(id, e => { if (e.removed) throw new Error(`Server removed: ${id}`); e.desired = true; clearTimeout(e.retry); e.retry = undefined; return this.startEntry(e); }); }
  stop(id) {
    const e = this.get(id); e.desired = false; clearTimeout(e.retry); e.retry = undefined;
    if (e.status === 'starting') e.startAbort?.abort(new Error('Startup cancelled by stop'));
    return this.serial(id, e => { e.desired = false; return this.stopEntry(e); });
  }
  restart(id) { return this.serial(id, async e => { if (e.removed) throw new Error(`Server removed: ${id}`); e.desired = false; clearTimeout(e.retry); e.retry = undefined; await this.stopEntry(e); e.desired = true; await this.startEntry(e); }); }
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
    if (e.client === client) { e.tools = tools; this.changed(); }
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
    const client = e.client;
    e.client = undefined; e.transport = undefined;
    e.tools = []; e.status = 'stopped'; e.error = undefined;
    if (client) {
      if (client.transport?.terminateSession) await withDeadline(client.transport.terminateSession(), this.requestTimeoutMs).catch(error => this.log(e.config.id, 'warn', `Session termination: ${error.message}`));
      await client.close().catch(error => this.log(e.config.id, 'error', error.message));
    }
    await this.reapOwned(e);
    this.log(e.config.id, 'info', 'Stopped');
    this.changed();
  }
  async close() { this.closing = true; await Promise.all([...this.entries.keys()].map(id => this.stop(id))); }
}
