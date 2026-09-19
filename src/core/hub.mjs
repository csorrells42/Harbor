import { createGateway } from './gateway.mjs';
import { loadConfigs, persistConfigs, validateConfig } from './config.mjs';
import { Upstreams } from './upstreams.mjs';
import { dirname, join } from 'node:path';
import { loadSettings, persistSettings, validateSettings } from './settings.mjs';

export async function createHub({ configPath, settingsPath = configPath && join(dirname(configPath), 'harbor-settings.json'), port, host, toolTimeoutMs, requestTimeoutMs, authentication } = {}) {
  if (!configPath) throw new Error('configPath is required');
  if (host !== undefined && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Gateway must bind to loopback');
  let settings = await loadSettings(settingsPath);
  settings = { ...settings, ...(port === undefined ? {} : { port }), ...(toolTimeoutMs === undefined ? {} : { toolTimeoutMs }), ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }) };
  host ??= settings.networkEnabled ? settings.bindAddress : '127.0.0.1';
  let configs = await loadConfigs(configPath);
  let closed = false;
  let closePromise;
  let maintenance = false;
  let resumeIds = [];
  let writes = Promise.resolve();
  const logs = [];
  const log = (serverId, level, message) => {
    logs.push({ time: new Date().toISOString(), serverId, level, message: String(message).slice(0, 8192) });
    if (logs.length > 500) logs.shift();
  };
  const upstreams = new Upstreams(configs, log, () => gateway.changed(), { requestTimeoutMs: settings.requestTimeoutMs });
  let gateway;
  async function openGateway(next, bind) {
    const instance = await createGateway({ ...next, host: bind, upstreams, log, authentication, isOpen: () => !closed && !maintenance && gateway === instance });
    return instance;
  }
  gateway = await openGateway(settings, host);
  settings.port = gateway.port;
  for (const config of configs) if (config.autoStart) upstreams.start(config.id).catch(() => {});
  function serial(fn) {
    const task = writes.then(() => { if (closed) throw new Error('Hub is closed'); return fn(); });
    writes = task.catch(() => {});
    return task;
  }
  return {
    get endpoint() { return gateway.endpoint; },
    getSettings() { return structuredClone(settings); },
    authenticationChanged() { return serial(() => gateway.revokePublicSessions()); },
    async updateSettings(input) {
      if (closed) throw new Error('Hub is closed');
      const next = validateSettings(input);
      return serial(async () => {
        const nextHost = next.networkEnabled ? next.bindAddress : '127.0.0.1';
        let candidate;
        const changed = next.port !== settings.port || next.mcpPath !== settings.mcpPath || nextHost !== host;
        // Same-port binds may overlap. Suspend sockets, not SDK sessions or children,
        // so a failed candidate can restore the original listener and session IDs.
        const paused = changed && next.port === settings.port;
        if (paused) await gateway.pause();
        try {
          if (changed) candidate = await openGateway(next, nextHost);
          await (candidate??gateway).prepareMode(next);
          if (closed) throw new Error('Hub is closed');
          await persistSettings(settingsPath, next);
        } catch (error) {
          await candidate?.close();
          if (paused) await gateway.resume();
          throw error;
        }
        // Publish the committed listener and settings in one synchronous step.
        // Candidate HTTP requests were gated by openGateway until this point.
        const old = gateway;
        if (candidate) gateway = candidate;
        host = nextHost;
        settings = next;
        gateway.configure(next);
        upstreams.requestTimeoutMs = next.requestTimeoutMs;
        if (candidate) await old.close();
        return structuredClone(settings);
      });
    },
    snapshot() { const endpoint = gateway.endpoint, auth=authentication?.status?.(); return structuredClone({ endpoint, maintenance, authentication:{enabled:auth?.enabled===true,hasKey:auth?.hasKey===true}, settings, endpoints: gateway.endpoints, servers: upstreams.snapshot(), tools: upstreams.tools(), clients: gateway.clients(), logs }); },
    enterMaintenance() {return serial(async()=>{
      if(maintenance)return;
      maintenance=true;
      await gateway.suspendDelivery();
      resumeIds=upstreams.snapshot().filter(s=>s.status==='running'||s.status==='starting').map(s=>s.id);
      await Promise.all(upstreams.snapshot().map(s=>upstreams.stop(s.id)));
      log('','info','Maintenance mode: owned servers stopped and gateway tool calls paused');
    });},
    leaveMaintenance() {return serial(async()=>{
      if(!maintenance)return;
      maintenance=false;
      const currentIds=new Set(configs.map(config=>config.id));
      const restarting=resumeIds.filter(id=>currentIds.has(id));
      resumeIds=[];
      // One removed or invalid entry must not prevent the remaining servers
      // from resuming, including failures thrown before start returns a promise.
      const results=await Promise.allSettled(restarting.map(id=>Promise.resolve().then(()=>upstreams.start(id))));
      for(const r of results)if(r.status==='rejected')log('','error',r.reason.message);
    });},
    async startServer(id) { if (closed) throw new Error('Hub is closed'); if(maintenance)throw new Error('Exit maintenance mode before starting servers'); await upstreams.start(id); },
    async stopServer(id) { if (closed) throw new Error('Hub is closed'); await upstreams.stop(id); },
    async restartServer(id) { if (closed) throw new Error('Hub is closed'); if(maintenance)throw new Error('Exit maintenance mode before restarting servers'); await upstreams.restart(id); },
    setServerStartup(id,enabled){return serial(async()=>{
      if(typeof enabled!=='boolean')throw new Error('Startup selection must be a boolean');
      const existing=configs.find(c=>c.id===id);if(!existing)throw new Error('Unknown server id');
      const config={...existing,autoStart:enabled,...(!enabled?{autoRestart:false}:{})};
      const next=configs.map(c=>c.id===id?config:c);
      await persistConfigs(configPath,next);configs=next;upstreams.setStartup(id,enabled);
      if(!enabled)resumeIds=resumeIds.filter(current=>current!==id);
      else if(maintenance&&!resumeIds.includes(id))resumeIds.push(id);
      return structuredClone(config);
    });},
    saveServer(input) { return serial(async () => {
      const config = validateConfig(input);
      const next = configs.some(c => c.id === config.id) ? configs.map(c => c.id === config.id ? config : c) : [...configs, config];
      await persistConfigs(configPath, next);
      configs = next;
      await upstreams.set(config);
      return structuredClone(config);
    }); },
    removeServer(id) { return serial(async () => {
      if (!configs.some(c => c.id === id)) throw new Error('Unknown server id');
      const next = configs.filter(c => c.id !== id);
      await persistConfigs(configPath, next);
      configs = next;
      await upstreams.remove(id);
      resumeIds=resumeIds.filter(current=>current!==id);
    }); },
    importConfig(input) { return serial(async () => {
      if (!input?.mcpServers || typeof input.mcpServers !== 'object' || Array.isArray(input.mcpServers)) throw new Error('mcpServers must be an object');
      const incoming = Object.entries(input.mcpServers).map(([id, config]) => validateConfig({ ...config, id }));
      for (const config of incoming) if (configs.some(c => c.id === config.id)) throw new Error(`Import collision: ${config.id} already exists`);
      const next = [...configs, ...incoming];
      await persistConfigs(configPath, next);
      configs = next;
      for (const config of incoming) await upstreams.set(config);
      return structuredClone(incoming);
    }); },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => { await writes; await upstreams.close(); await gateway.close(); })();
      return closePromise;
    }
  };
}
