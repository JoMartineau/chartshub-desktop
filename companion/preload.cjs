'use strict';
const { contextBridge, ipcRenderer } = require('electron');
if (location.protocol === 'chartshub-companion:' && location.hostname === 'app') {
  contextBridge.exposeInMainWorld('ChartsHubCompanion', Object.freeze({
    getSnapshot: () => ipcRenderer.invoke('companion:snapshot'),
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Listener required');
      const handler = (_event, snapshot) => listener(snapshot);
      ipcRenderer.on('companion:changed', handler);
      return () => ipcRenderer.removeListener('companion:changed', handler);
    },
    command: (command, payload) => ipcRenderer.invoke('companion:command', command, payload)
  }));
}
