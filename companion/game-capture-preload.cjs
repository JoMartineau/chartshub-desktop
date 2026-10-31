'use strict';
const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame !== false && ['chartshub-companion://app/ui/game-capture.html', 'chartshub-companion://app/ui/game-capture-output.html'].includes(location.href)) {
  const channel = 'companion:game-capture';
  const allowed = new Set(['snapshot','list','select','started','crop','output','stop','failed','ready','signal']);
  contextBridge.exposeInMainWorld('ChartsHubGameCapture', Object.freeze({
    command: (name, payload) => allowed.has(name) ? ipcRenderer.invoke(channel, name, payload) : Promise.reject(TypeError('Invalid capture command')),
    subscribe(name, callback) {
      if (!['state','stop','output-ready','output-closed','signal'].includes(name) || typeof callback !== 'function') throw TypeError('Invalid capture event');
      const listener = (_event, value) => callback(value); ipcRenderer.on(`${channel}:${name}`, listener);
      return () => ipcRenderer.removeListener(`${channel}:${name}`, listener);
    }
  }));
}
