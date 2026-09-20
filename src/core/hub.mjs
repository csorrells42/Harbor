import { createGateway } from './gateway.mjs';
import { loadConfigs, persistConfigs, validateConfig } from './config.mjs';
import { Upstreams } from './upstreams.mjs';
import { dirname, join } from 'node:path';
import { loadSettings, persistSettings, validateSettings } from './settings.mjs';
import {SEARCH_DEFAULTS} from './delivery-options.js';
import {createRequestTraces} from './request-traces.mjs';
import {readFile} from 'node:fs/promises';
import {createProfileStore} from './profiles.mjs';
import {createProfileCredentials} from './profile-credentials.mjs';
import {createDeliverySettings} from './delivery-credentials.mjs';
import {createCatalogCache} from './catalog-cache.mjs';
import {adviceFingerprint} from '../diagnostics/advice.mjs';

export async function createHub({ configPath, settingsPath = configPath && join(dirname(configPath), 'harbor-settings.json'), port, host, toolTimeoutMs, requestTimeoutMs, authentication, portableRoot=process.env.HARBOR_PORTABLE_ROOT } = {}) {
  if (!configPath) throw new Error('configPath is required');
  if (host !== undefined && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Gateway must bind to loopback');
  const authority=authentication?.settings?.();
  let settings = authority?validateSettings(authority):await loadSettings(settingsPath);
  if(authority)await authentication.update({enabled:authentication.status().enabled},()=>persistSettings(settingsPath,settings),{settings});
  settings = { ...settings, ...(port === undefined ? {} : { port }), ...(toolTimeoutMs === undefined ? {} : { toolTimeoutMs }), ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }) };
  host ??= settings.networkEnabled ? settings.bindAddress : '127.0.0.1';
  let configs = await loadConfigs(configPath);
  const profiles=await createProfileStore({file:join(dirname(configPath),'profiles.json'),getConfigs:()=>configs,getSettings:()=>settings});
  const traceSecrets=new Set();
  const sensitiveKey=/authorization|cookie|password|secret|token|api[-_]?key|credential/i;
  const traces=await createRequestTraces({settingsPath:join(dirname(configPath),'trace-settings.json'),secrets:()=>[
    authentication?.key?.(),...traceSecrets,
    ...Object.entries(process.env).filter(([key])=>sensitiveKey.test(key)).map(([,value])=>value),
    ...configs.flatMap(c=>Object.entries(c.env??{}).filter(([key])=>sensitiveKey.test(key)).map(([,value])=>value))
  ]});
  async function registerDeliverySecrets(next){
    for(const key of ['portkeyApiKeyFile','portkeyWorkersKeyFile'])if(next[key])try {
      const value=(await readFile(next[key].replaceAll('${HARBOR_ROOT}',portableRoot??''),'utf8')).trim();
      if(value&&value.length<=65536)traceSecrets.add(value);
    }catch(error){if(error.code!=='ENOENT')throw new Error('Could not prepare delivery credential redaction');}
  }
  await registerDeliverySecrets(settings);
  for(const profile of profiles.snapshot().profiles)await registerDeliverySecrets(profile.delivery);
  let closed = false;
  let closePromise;
  let maintenance = false;
  let maintenanceReady = false, maintenanceTransition = null, maintenanceResumes = 0;
  let resumeIds = [];
  let writes = Promise.resolve(),protectionChanges=0;
  const logs = [];
  const log = (serverId, level, message) => {
    logs.push({ time: new Date().toISOString(), serverId, level, message: traces.redactText(message,8192) });
    if (logs.length > 500) logs.shift();
  };
  const profileCredentials=createProfileCredentials({dataDir:dirname(configPath),portableRoot,
    getReferences:()=>[settings,...profiles.snapshot().profiles.map(profile=>profile.delivery)],
    onError:()=>log('','warn','Profile credential cleanup could not finish; unused files will be retried on the next cleanup')});
  const catalogCache=await createCatalogCache({file:join(dirname(configPath),'catalog-cache.json'),onError:()=>log('','warn','Cached tool discovery could not be loaded or saved; start the server to refresh its catalog')});
  await catalogCache.prune(configs);
  const upstreams = new Upstreams(configs, log, () => gateway.changed(), { requestTimeoutMs: settings.requestTimeoutMs,catalogCache });
  let gateway;
  async function openGateway(next, bind) {
    const instance = await createGateway({ ...next, host: bind, upstreams, log, authentication, traces, profiles, retainCredentials:profileCredentials.retain, isOpen: () => !closed && !maintenance, isPublicOpen: () => gateway === instance && protectionChanges===0 && authentication?.available?.()!==false });
    return instance;
  }
  gateway = await openGateway(settings, host);
  settings.port = gateway.port;
  await profileCredentials.collect();
  for (const config of configs) if (config.enabled!==false&&config.autoStart) upstreams.start(config.id).catch(() => {});
  function serial(fn) {
    const task = writes.then(() => { if (closed) throw new Error('Hub is closed'); return fn(); });
    writes = task.catch(() => {});
    return task;
  }
  // This helper runs only inside the common write queue, including protection changes.
  async function applySettings(next) {
    await registerDeliverySecrets(next);
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
    if (candidate)await old.close().catch(error=>log('','warn',`Previous gateway cleanup: ${error.message}`));
    return structuredClone(settings);
  }
  function protectedWrite(operation){
    // Close public admission before waiting behind an existing settings/config write.
    protectionChanges++;
    return serial(operation).finally(()=>{protectionChanges--;});
  }
  async function commitSettings(next){
    const release=profileCredentials.retain(next);
    try{
      if(!authentication?.update)return await applySettings(next);
      await authentication.update({enabled:authentication.status().enabled},()=>applySettings(next),{settings:next});
      return structuredClone(settings);
    }finally{release();}
  }
  async function saveProfile(input,options){
    const release=profileCredentials.retain(input.delivery);
    try{await registerDeliverySecrets(input.delivery??{});return await profiles.save(input,options);}
    finally{release();}
  }
  function adviceCatalog(profile){
    return {servers:configs.filter(config=>profile.serverIds.includes(config.id)).map(config=>({id:config.id,fingerprint:adviceFingerprint(config)})),tools:upstreams.tools().filter(tool=>profile.serverIds.includes(tool.serverId)).map(({name,description,inputSchema,outputSchema,annotations,serverId})=>({name,description,inputSchema,outputSchema,annotations,serverId}))};
  }
  return {
    get endpoint() { return gateway.endpoint; },
    getSettings() { return structuredClone(settings); },
    getProfiles(){const value=profiles.snapshot();return {...value,profiles:value.profiles.map(profile=>({...profile,endpoint:gateway.endpoint+'/profiles/'+profile.id})),defaultProfile:{...value.defaultProfile,endpoint:gateway.endpoint},runtimes:gateway.profileRuntimes(),clients:gateway.clients(),admission:gateway.admission(),servers:upstreams.snapshot().map(({id,name,transport,runtime,status})=>({id,name,transport,runtime,status}))};},
    getProfile:id=>profiles.get(id),
    getAdviceCatalog:id=>adviceCatalog(profiles.get(id)),
    saveAdviceProfile(input,{expectedRevision,expectedCatalogFingerprint}={}){
      const captured=structuredClone(input);
      return serial(async()=>{
        const current=profiles.get(captured.id);
        if(current.revision!==expectedRevision)throw new Error('The profile changed; review the change again');
        if(typeof expectedCatalogFingerprint!=='string'||adviceFingerprint(adviceCatalog(current))!==expectedCatalogFingerprint)throw new Error('The selected tool catalog changed; review the change again');
        const saved=await saveProfile(captured,{expectedRevision});
        return {...saved,adviceCatalogChanged:adviceFingerprint(adviceCatalog(saved))!==expectedCatalogFingerprint};
      });
    },
    saveProfile(input,options){const captured=structuredClone(input),capturedOptions=structuredClone(options);return serial(()=>saveProfile(captured,capturedOptions));},
    saveProfileDelivery(id,revision,input){
      const captured=structuredClone(input);
      return serial(async()=>{
        const profile=profiles.get(id);if(profile.revision!==revision)throw new Error('This profile changed; reload it before saving');
        const save=createDeliverySettings({dataDir:join(dirname(configPath),'profile-credentials',id),portableRoot,getSettings:()=>profile.delivery,
          updateSettings:delivery=>saveProfile({...profile,delivery},{expectedRevision:revision}),retainReplaced:()=>true,reserveCreated:profileCredentials.reserve});
        return save(captured);
      });
    },
    removeProfile:(id,options)=>serial(async()=>{await profiles.remove(id,options);try{await gateway.revokeProfileSessions(id);}finally{await profileCredentials.collect();}}),
    collectProfileCredentials:()=>profileCredentials.collect(),
    disconnectProfile:id=>serial(()=>gateway.revokeProfileSessions(id)),
    traceSnapshot: options=>traces.snapshot(options),
    updateTraceSettings: input=>serial(()=>traces.update(input)),
    clearTraces: ()=>traces.clear(),
    previewTraceExport: ()=>traces.previewExport(),
    traceExport: token=>traces.exportPreview(token),
    authenticationChanged() { return serial(() => gateway.revokePublicSessions()); },
    async updateSettings(input) {
      const next=validateSettings(input);
      return protectedWrite(()=>commitSettings(next));
    },
    patchSettings(input,group='advanced'){
      if(!input||typeof input!=='object'||Array.isArray(input))return Promise.reject(new Error('Settings fields are required'));
      const allowed=group==='delivery'?['toolMode',...Object.keys(SEARCH_DEFAULTS)]:['port','bindAddress','mcpPath','requestTimeoutMs','toolTimeoutMs','allowedOrigins'];
      const patch=structuredClone(Object.fromEntries(Object.entries(input).filter(([key])=>allowed.includes(key))));
      return protectedWrite(()=>commitSettings(validateSettings({...settings,...patch})));
    },
    updateGatewayAuth(input){
      if(!authentication?.update)return Promise.reject(new Error('Gateway authentication is unavailable'));
      const captured=structuredClone(input);
      if(!captured||typeof captured.enabled!=='boolean'||(Object.hasOwn(captured,'loopbackOnly')&&typeof captured.loopbackOnly!=='boolean'))return Promise.reject(new Error('Choose the gateway protections'));
      return protectedWrite(async()=>{
        await gateway.revokePublicSessions();
        try{
          const next=validateSettings({...settings,...(typeof captured.loopbackOnly==='boolean'?{networkEnabled:!captured.loopbackOnly}:{})});
          if(next.networkEnabled!==settings.networkEnabled)await authentication.update(captured,()=>applySettings(next),{settings:next});
          else await authentication.update(captured);
          return {...authentication.status(),loopbackOnly:!settings.networkEnabled};
        }finally{await gateway.revokePublicSessions();}
      });
    },
    snapshot() { const endpoint = gateway.endpoint, auth=authentication?.status?.(); return structuredClone({ endpoint, maintenance, maintenanceReady:maintenance&&maintenanceReady&&maintenanceResumes===0, maintenanceTransition:maintenanceTransition??(maintenanceResumes?'leaving':null), authentication:{enabled:auth?.enabled===true,hasKey:auth?.hasKey===true}, settings, endpoints: gateway.endpoints, servers: upstreams.snapshot(), tools: upstreams.tools(), clients: gateway.clients(), logs }); },
    enterMaintenance() {return serial(async()=>{
      if(maintenanceReady)return;
      if(!maintenance)resumeIds=upstreams.snapshot().filter(s=>s.status==='running'||s.status==='starting').map(s=>s.id);
      maintenance=true;maintenanceReady=false;maintenanceTransition='entering';
      try{
        await gateway.suspendDelivery();
        await upstreams.invalidateCatalogs();
        await Promise.all(upstreams.snapshot().map(s=>upstreams.stop(s.id)));
        maintenanceReady=true;
        log('','info','Maintenance mode: owned servers stopped and gateway tool calls paused');
      }finally{maintenanceTransition=null;}
    });},
    leaveMaintenance() {
      // Close update admission before this operation waits behind other writes.
      maintenanceReady=false;maintenanceResumes++;
      return serial(async()=>{
      // A preceding queued drain may have set readiness after resume was requested.
      maintenanceReady=false;
      if(!maintenance)return;
      maintenance=false;maintenanceTransition='leaving';
      try{
      const currentIds=new Set(configs.map(config=>config.id));
      const restarting=resumeIds.filter(id=>currentIds.has(id));
      resumeIds=[];
      // One removed or invalid entry must not prevent the remaining servers
      // from resuming, including failures thrown before start returns a promise.
      const results=await Promise.allSettled(restarting.map(id=>Promise.resolve().then(()=>upstreams.start(id))));
      for(const r of results)if(r.status==='rejected')log('','error',r.reason.message);
      }finally{maintenanceTransition=null;}
    }).finally(()=>{maintenanceResumes--;});},
    async startServer(id) { if (closed) throw new Error('Hub is closed'); if(maintenance)throw new Error('Exit maintenance mode before starting servers'); await upstreams.start(id); },
    async stopServer(id) { if (closed) throw new Error('Hub is closed'); await upstreams.stop(id); },
    async restartServer(id) { if (closed) throw new Error('Hub is closed'); if(maintenance)throw new Error('Exit maintenance mode before restarting servers'); await upstreams.restart(id); },
    setServerStartup(id,enabled){return serial(async()=>{
      if(typeof enabled!=='boolean')throw new Error('Startup selection must be a boolean');
      const existing=configs.find(c=>c.id===id);if(!existing)throw new Error('Unknown server id');
      if(enabled&&existing.enabled===false)throw new Error('Enable the server for use before selecting startup');
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
      const incoming = Object.entries(input.mcpServers).map(([id, config]) => validateConfig({ ...config, id, autoStart:false,autoRestart:false,onDemand:false }));
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
      closePromise = (async () => { await writes; await upstreams.close(); await gateway.close(); await profiles.close(); await profileCredentials.collect(); await traces.close(); })();
      return closePromise;
    }
  };
}
