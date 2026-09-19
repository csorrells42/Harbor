const { contextBridge, ipcRenderer } = require('electron');
const api = {};
for(const method of ['getGatewayAuth','generateGatewayKey','updateGatewayAuth','copyGatewayKey','copyConnectionConfiguration','updateDeliverySettings','diagnosticsProbe','diagnosticsSnapshot','diagnosticsStart','diagnosticsCancel','snapshot','getSettings','updateSettings','saveServer','setServerStartup','removeServer','startServer','stopServer','restartServer','importConfig','connectionInfo','copy','chooseDirectory','enterMaintenance','leaveMaintenance','updateComponent','rollbackComponent']) {
  api[method]=(...args)=>ipcRenderer.invoke(`harbor:${method}`,...args);
}
contextBridge.exposeInMainWorld('harbor', Object.freeze(api));
