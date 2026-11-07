'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chartsHubShell', Object.freeze({
  getState: () => ipcRenderer.invoke('chartshub-shell:state'),
  localePack: code => typeof code === 'string' && code.length <= 16 ? ipcRenderer.invoke('chartshub-shell:locale-pack', code) : Promise.reject(TypeError('Invalid language')),
  selectTab: name => name === 'catalogue' || name === 'companion'
    ? ipcRenderer.invoke('chartshub-shell:select-tab', name) : Promise.reject(TypeError('Invalid tab')),
  onState: callback => {
    if (typeof callback !== 'function') throw TypeError('Invalid state listener');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('chartshub-shell:changed', listener);
    return () => ipcRenderer.removeListener('chartshub-shell:changed', listener);
  }
}));
