// Preload for the setup window: a narrow, explicit bridge to the main process.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshSetup', {
  install: () => ipcRenderer.invoke('kernel:install'),
  cancel: () => ipcRenderer.invoke('kernel:cancel'),
  info: () => ipcRenderer.invoke('kernel:info'),
  onStatus: (callback) =>
    ipcRenderer.on('kernel:status', (_event, status) => callback(status)),
})
