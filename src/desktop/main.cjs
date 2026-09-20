const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, clipboard, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
let hub, window, tray, maintenance, diagnosticsPromise, advicePromise, quitting = false, shutdownStarted = false;
let authWrites=Promise.resolve();
app.setName('MCP Harbor');
const portableCandidate = process.env.HARBOR_PORTABLE_ROOT || (app.isPackaged ? path.dirname(process.execPath) : undefined);
const portableRoot = portableCandidate && fs.existsSync(path.join(portableCandidate,'portable.json')) ? path.resolve(portableCandidate) : undefined;
if (process.env.HARBOR_PORTABLE_ROOT && !portableRoot) throw new Error('Harbor Portable marker missing; refusing to use installed profile');
if (portableRoot) {
  process.env.HARBOR_PORTABLE_ROOT=portableRoot;
  for (const directory of ['data','data/cache','data/logs','data/temp']) fs.mkdirSync(path.join(portableRoot,directory),{recursive:true});
  app.setPath('userData',path.join(portableRoot,'data'));
  app.setPath('sessionData',path.join(portableRoot,'data/cache'));
  app.setPath('logs',path.join(portableRoot,'data/logs'));
  process.env.TEMP=process.env.TMP=path.join(portableRoot,'data/temp');
} else if (process.env.HARBOR_DATA_DIR) app.setPath('userData', path.resolve(process.env.HARBOR_DATA_DIR));
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else {
  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    const timer = setTimeout(() => { quitting = true; app.exit(0); }, portableRoot ? 330000 : 12000);
    Promise.resolve().then(async () => {
      const adviceClose=advicePromise?.then(value=>value.close());adviceClose?.catch(()=>{});
      // A failed cleanup must not strand the remaining owned services.
      for (const close of [() => authWrites, () => maintenance?.close(), async () => (await diagnosticsPromise)?.close(), () => adviceClose, () => hub?.close()]) {
        try { await close(); } catch (error) { console.error(error); }
      }
    }).catch(error => console.error(error)).finally(() => {
      clearTimeout(timer); quitting = true;
      try { tray?.destroy(); } catch (error) { console.error(error); }
      app.quit();
    });
  });
  app.whenReady().then(start).catch(error => {
    console.error(error);
    dialog.showErrorBox('MCP Harbor could not start', `${error.message}\n\nIf the port is busy, close the other hub or set HARBOR_PORT. Your saved configuration has not been replaced.`);
    app.quit();
  });
}
function refreshTray() { tray?.setContextMenu(Menu.buildFromTemplate([{label:'Open MCP Harbor',click:showWindow},{label:hub.endpoint,enabled:false},{type:'separator'},{label:'Quit and stop servers',click:()=>app.quit()}])); }
function showWindow() { if (window) { window.show(); if (window.isMinimized()) window.restore(); window.focus(); } }
async function start() {
  const portable = portableRoot ? await (await import('../core/portable.mjs')).initializePortable(portableRoot) : undefined;
  if(portableRoot && fs.existsSync(path.join(portableRoot,'maintenance.json'))) maintenance=await (await import('../core/maintenance.mjs')).createMaintenance({root:portableRoot,isPaused:()=>hub?.snapshot().maintenanceReady===true});
  const { createHub } = await import('../core/hub.mjs');
  const { connectionInfo } = await import('./policy.mjs');
  const { formatClientConfiguration } = await import('../core/client-config.js');
  const port = process.env.HARBOR_PORT === undefined ? undefined : Number(process.env.HARBOR_PORT);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error('HARBOR_PORT must be an integer between 0 and 65535');
  const configPath = path.join(app.getPath('userData'), 'servers.json');
  const settingsPath = path.join(app.getPath('userData'), 'harbor-settings.json');
  const {createGatewayAuthentication,generateGatewayKey}=await import('../core/gateway-auth.mjs');
  const authentication=await createGatewayAuthentication({dataDir:app.getPath('userData'),defaultEnabled:true});
  hub = await createHub({configPath, settingsPath, authentication, ...(port === undefined ? {} : {port})});
  const {createDeliverySettings}=await import('../core/delivery-credentials.mjs');
  const saveDelivery=createDeliverySettings({dataDir:app.getPath('userData'),portableRoot,getSettings:()=>hub.getSettings(),updateSettings:settings=>hub.patchSettings(settings,'delivery'),retainReplaced:file=>hub.getProfiles().profiles.some(profile=>Object.values(profile.delivery).includes(file))||hub.getProfiles().runtimes.length>0});
  const getDiagnostics=()=>diagnosticsPromise??=(import('../diagnostics/service.mjs').then(({createDiagnostics})=>createDiagnostics({dataDir:path.join(app.getPath('userData'),'diagnostics')})).catch(error=>{diagnosticsPromise=undefined;throw error;}));
  const getAdvice=()=>advicePromise??=(async()=>{
    const {createAdviceReviews}=await import('../diagnostics/advice.mjs');
    const {createAdviceHistory}=await import('../diagnostics/advice-history.mjs');
    const history=await createAdviceHistory(path.join(app.getPath('userData'),'advice-history.json'));
    const reviews=createAdviceReviews({refreshEvidence:async id=>(await getDiagnostics()).reviewEvidence(id),getProfile:id=>hub.getProfile(id),getCatalog:profile=>hub.getAdviceCatalog(profile.id),saveProfile:(input,options)=>hub.saveAdviceProfile(input,options),saveReceipt:receipt=>history.append(receipt)});
    return {...reviews,history:()=>history.snapshot(),clearHistory:()=>history.clear(),async close(){await reviews.close();await history.close();}};
  })().catch(error=>{advicePromise=undefined;throw error;});
  const entry = path.resolve(__dirname, '../ui/index.html');
  const entryUrl = pathToFileURL(entry).href;
  const bridgePath = app.isPackaged ? path.join(process.resourcesPath, 'bridge.mjs') : path.resolve(__dirname, '../bridge.mjs');
  const describeConnection=()=>connectionInfo({endpoint:hub.endpoint,endpoints:hub.snapshot().endpoints,settings:hub.getSettings(),settingsPath,configPath,bridgePath,platform:process.platform,version:app.getVersion(),nodePath:portable?.node,portableRoot,authentication:authentication.status()});
  const protectionStatus=()=>({...authentication.status(),loopbackOnly:!hub.getSettings().networkEnabled});
  const actions = {
    getProfiles:()=>hub.getProfiles(),
    saveProfile:(input,options)=>hub.saveProfile(input,options),
    removeProfile:(id,options)=>hub.removeProfile(id,options),
    disconnectProfile:id=>hub.disconnectProfile(id),
    saveProfileDelivery:(id,revision,input)=>hub.saveProfileDelivery(id,revision,input),
    profileConnectionInfo:id=>{
      hub.getProfile(id);const info=describeConnection(),endpoint=hub.endpoint+'/profiles/'+id;
      return connectionInfo({...info,endpoint,endpoints:{network:info.networkEndpoints.map(url=>url+'/profiles/'+id)},bridgePath,nodePath:portable?.node,authentication:authentication.status()});
    },
    testProfileConnection:async id=>{
      const profile=hub.getProfile(id),endpoint=hub.endpoint+'/profiles/'+id;
      const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
      const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const client=new Client({name:'Harbor profile connection test',version:app.getVersion()}),key=authentication.status().enabled?authentication.key():undefined;
      const transport=new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:key?{Authorization:'Bearer '+key}:{},signal:AbortSignal.timeout(90000)}});
      try{
        await client.connect(transport);const capabilities=client.getServerCapabilities(),options={timeout:60000};
        const [tools,resources,templates,prompts]=await Promise.all([capabilities.tools?client.listTools({},options):{tools:[]},capabilities.resources?client.listResources({},options):{resources:[]},capabilities.resources?client.listResourceTemplates({},options):{resourceTemplates:[]},capabilities.prompts?client.listPrompts({},options):{prompts:[]}]);
        return {profileId:id,revision:profile.revision,server:client.getServerVersion(),toolCount:tools.tools.length,resourceCount:resources.resources.length,templateCount:templates.resourceTemplates.length,promptCount:prompts.prompts.length,listingErrors:[resources,templates,prompts].flatMap(result=>result._meta?.['harbor/listingErrors']??[]),capabilities};
      }
      finally{await transport.terminateSession().catch(()=>{});await client.close().catch(()=>{});}
    },
    traceSnapshot:options=>hub.traceSnapshot(options),
    updateTraceSettings:input=>hub.updateTraceSettings(input),
    clearTraces:()=>hub.clearTraces(),
    previewTraceExport:()=>hub.previewTraceExport(),
    saveTraceExport:async token=>{
      const text=hub.traceExport(token);
      const result=await dialog.showSaveDialog(window,{title:'Save inspected Harbor trace bundle',defaultPath:'harbor-traces-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json',filters:[{name:'JSON diagnostic bundle',extensions:['json']}],properties:['showOverwriteConfirmation']});
      if(result.canceled||!result.filePath)return {saved:false};
      await fs.promises.writeFile(result.filePath,text,{mode:0o600});
      return {saved:true,name:path.basename(result.filePath)};
    },
    getGatewayAuth:protectionStatus,
    generateGatewayKey:()=>generateGatewayKey(),
    updateGatewayAuth:input=>{
      if(shutdownStarted)throw new Error('Harbor is shutting down.');
      const job=hub.updateGatewayAuth(input).then(result=>{refreshTray();return result;});
      authWrites=job.catch(()=>{});return job;
    },
    copyGatewayKey:()=>{const key=authentication.key();if(!key)throw new Error('No gateway API key has been saved.');clipboard.writeText(key);return true;},
    copyConnectionConfiguration:({format,endpoint,profileId,client='lmstudio'}={})=>{
      const info=describeConnection();
      if(profileId)hub.getProfile(profileId);
      const endpoints=[info.endpoint,...info.networkEndpoints].map(url=>url+(profileId?'/profiles/'+profileId:''));
      if(!['http','stdio'].includes(format)||!endpoints.includes(endpoint))throw new Error('Choose an active Harbor endpoint and configuration format.');
      const key=authentication.status().enabled?authentication.key():undefined;
      const config=format==='http'?{mcpServers:{harbor:{url:endpoint,...(key?{headers:{Authorization:'Bearer '+key}}:{})}}}:{mcpServers:{harbor:{command:portable?.node??'node',args:[bridgePath,endpoint],...(key?{env:{HARBOR_API_KEY:key}}:{})}}};
      clipboard.writeText(formatClientConfiguration(config,client));return true;
    },
    updateDeliverySettings: input=>saveDelivery(input),
    diagnosticsProbe:async input=> (await getDiagnostics()).probe(input),
    diagnosticsSnapshot:async()=> (await getDiagnostics()).snapshot(),
    diagnosticsInspectTrial:async input=> (await getDiagnostics()).inspectTrial(input),
    diagnosticsListCampaigns:async input=> (await getDiagnostics()).listCampaigns(input),
    diagnosticsInspectCampaign:async id=> (await getDiagnostics()).inspectCampaign(id),
    diagnosticsSaveCampaign:async id=>{
      const text=await (await getDiagnostics()).exportCampaign(id);
      const result=await dialog.showSaveDialog(window,{title:'Save Harbor campaign evidence',defaultPath:'harbor-campaign-'+id+'.json',filters:[{name:'JSON campaign evidence',extensions:['json']}],properties:['showOverwriteConfirmation']});
      if(result.canceled||!result.filePath)return {saved:false};
      await fs.promises.writeFile(result.filePath,text,{mode:0o600});
      return {saved:true,name:path.basename(result.filePath),bytes:Buffer.byteLength(text)};
    },
    diagnosticsStart:async plan=> (await getDiagnostics()).start(plan),
    diagnosticsCancel:async()=> (await getDiagnostics()).cancel(),
    adviceInspect:async id=>(await getAdvice()).inspect(id),
    advicePreview:async input=>(await getAdvice()).preview(input),
    adviceApply:async token=>(await getAdvice()).apply(token),
    adviceHistory:async()=>(await getAdvice()).history(),
    adviceClearHistory:async()=>(await getAdvice()).clearHistory(),
    snapshot: () => ({...hub.snapshot(),maintenanceInfo:maintenance?.snapshot()}),
    enterMaintenance: () => hub.enterMaintenance(),
    leaveMaintenance: () => {if(maintenance?.snapshot().busy)throw new Error('Wait for maintenance to finish');return hub.leaveMaintenance();},
    updateComponent: (id,options) => {if(!maintenance)throw new Error('Maintenance recipes are available in Harbor Portable');return maintenance.start(id,options);},
    rollbackComponent: id => {if(!maintenance)throw new Error('Maintenance recipes are available in Harbor Portable');return maintenance.rollback(id);},
    getSettings: () => hub.getSettings(),
    updateSettings: async settings => {const result=await hub.patchSettings(settings);refreshTray();return result;},
    saveServer: config => hub.saveServer(config),
    setServerStartup: (id,enabled) => hub.setServerStartup(id,enabled),
    removeServer: id => hub.removeServer(id),
    startServer: id => hub.startServer(id),
    stopServer: id => hub.stopServer(id),
    restartServer: id => hub.restartServer(id),
    importConfig: config => hub.importConfig(config),
    connectionInfo: describeConnection,
    copy: text => { if(typeof text!=='string'||text.length>1000000)throw new Error('Invalid clipboard text');clipboard.writeText(text);return true; },
    chooseDirectory: async () => {const result=await dialog.showOpenDialog(window,{properties:['openDirectory']});return result.canceled?null:result.filePaths[0];}
  };
  for (const [name,handler] of Object.entries(actions)) ipcMain.handle(`harbor:${name}`, (event,...args) => {
    if(event.sender!==window?.webContents || event.senderFrame!==event.sender.mainFrame || event.senderFrame.url!==entryUrl)throw new Error('Untrusted window');
    return handler(...args);
  });
  window = new BrowserWindow({width:1280,height:860,minWidth:940,minHeight:640,show:false,title:'MCP Harbor',backgroundColor:'#0f1011',autoHideMenuBar:true,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  window.on('close', event=>{if(!quitting){event.preventDefault();window.hide();}});
  // Render an offline tray mark directly as pixels; no font or icon downloads.
  const size=32,pixels=Buffer.alloc(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const i=(y*size+x)*4;const ink=((x>=7&&x<=10)||(x>=21&&x<=24)||(y>=14&&y<=17&&x>=7&&x<=24))&&y>=6&&y<=25;
    pixels[i]=ink?248:35;pixels[i+1]=ink?248:27;pixels[i+2]=ink?247:25;pixels[i+3]=255;
  }
  tray = new Tray(nativeImage.createFromBitmap(pixels,{width:size,height:size,scaleFactor:1}));
  tray.setToolTip('MCP Harbor — local MCP gateway');
  refreshTray();
  tray.on('click',showWindow);
  await window.loadFile(entry);showWindow();
}
