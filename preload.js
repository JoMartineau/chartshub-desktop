'use strict';
const {contextBridge,ipcRenderer}=require('electron');
if(process.isMainFrame&&location.origin==='https://chartshub.ca'){
 contextBridge.exposeInMainWorld('ChartsHubDesktop',{
  version:'0.1.0',
  download:endpoint=>ipcRenderer.invoke('chartshub:download',endpoint),
  cancel:()=>ipcRenderer.invoke('chartshub:cancel'),
  onProgress:callback=>{if(typeof callback!=='function')return ()=>{};const listener=(_event,data)=>callback(data);ipcRenderer.on('chartshub:progress',listener);return ()=>ipcRenderer.removeListener('chartshub:progress',listener);}
 });
}
