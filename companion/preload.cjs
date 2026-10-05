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
// Only the main Companion panel gets this narrow bridge, never an overlay or catalogue.
if (location.href === 'chartshub-companion://app/ui/index.html' && process.isMainFrame !== false) {
  contextBridge.exposeInMainWorld('ChartsHubUIBloom', Object.freeze({
    read: () => ipcRenderer.invoke('chartshub-ui-bloom:read'),
    save: settings => ipcRenderer.invoke('chartshub-ui-bloom:save', settings)
  }));
  let requested = false;
  ipcRenderer.on('chartshub-ui-bloom:ready', () => {
    if (requested) return;
    requested = true;
    const mount = () => {
      if (document.getElementById('ch-bloom-module')) return;
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = 'chartshub-companion://app/ui/ui-bloom.css';
      const script = document.createElement('script');
      script.id = 'ch-bloom-module'; script.type = 'module'; script.src = 'chartshub-companion://app/ui/ui-bloom.js';
      document.head.append(css, script);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
  });
}
