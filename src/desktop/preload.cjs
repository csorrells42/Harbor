const { contextBridge, ipcRenderer } = require('electron');
const api = {};
api.diagnosticsInspectTrial=input=>ipcRenderer.invoke('harbor:diagnosticsInspectTrial',input);
for(const method of ['adviceInspect','advicePreview','adviceApply','adviceHistory','adviceClearHistory'])api[method]=(...args)=>ipcRenderer.invoke(`harbor:${method}`,...args);
for(const method of ['diagnosticsListCampaigns','diagnosticsInspectCampaign','diagnosticsSaveCampaign'])api[method]=(...args)=>ipcRenderer.invoke(`harbor:${method}`,...args);
for(const method of ['getProfiles','saveProfile','removeProfile','disconnectProfile','saveProfileDelivery','profileConnectionInfo','testProfileConnection'])api[method]=(...args)=>ipcRenderer.invoke(`harbor:${method}`,...args);
for(const method of ['traceSnapshot','updateTraceSettings','clearTraces','previewTraceExport','saveTraceExport','getGatewayAuth','generateGatewayKey','updateGatewayAuth','copyGatewayKey','copyConnectionConfiguration','updateDeliverySettings','diagnosticsProbe','diagnosticsSnapshot','diagnosticsStart','diagnosticsCancel','snapshot','getSettings','updateSettings','saveServer','setServerStartup','removeServer','startServer','stopServer','restartServer','importConfig','connectionInfo','copy','chooseDirectory','enterMaintenance','leaveMaintenance','updateComponent','rollbackComponent']) {
  api[method]=(...args)=>ipcRenderer.invoke(`harbor:${method}`,...args);
}
contextBridge.exposeInMainWorld('harbor', Object.freeze(api));
