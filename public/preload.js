const { ipcRenderer, contextBridge } = require("electron")
let screenId

ipcRenderer.on('SET_SOURCE_ID', async (event, sourceId) => {
    console.log(sourceId)
    screenId = sourceId
})

contextBridge.exposeInMainWorld('electronAPI', {
    setSize: (size) => ipcRenderer.send('set-size', size),
    getScreenId: (callback) => ipcRenderer.on('SET_SOURCE_ID', callback),
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveConfig: (config) => ipcRenderer.invoke('save-config', config),
    startNgrok: () => ipcRenderer.invoke('start-ngrok'),
    stopNgrok: () => ipcRenderer.invoke('stop-ngrok'),
    ngrokStatus: () => ipcRenderer.invoke('ngrok-status'),
    onNgrokLog: (callback) => ipcRenderer.on('ngrok-log', callback),
})