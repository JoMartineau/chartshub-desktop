'use strict';
const {contextBridge,ipcRenderer}=require('electron');
if(location.href==='chartshub-companion://app/ui/input-viewer.html'&&process.isMainFrame!==false){
 const arg=process.argv.find(value=>value.startsWith('--chartshub-input-viewer-language=')),language=['fr','en','es-MX','zh-Hans','ja','pt-BR','hi','ar','bn','ru','ur','id'].includes(arg?.split('=')[1])?arg.split('=')[1]:'fr';
 contextBridge.exposeInMainWorld('ChartsHubInputViewer',Object.freeze({language,
  command:(name,payload={})=>['snapshot','start','stop','close','showOutput','hideOutput','counterSnapshot','resetCounts'].includes(name)?ipcRenderer.invoke('companion:input-viewer',name,payload):Promise.reject(TypeError('Invalid viewer command')),
  configure:config=>ipcRenderer.invoke('companion:input-viewer','configure',{config}),
  publishPressed:value=>ipcRenderer.invoke('companion:input-viewer','pressed',value),
  selectController:index=>(index===null||(Number.isInteger(index)&&index>=0&&index<4))?ipcRenderer.invoke('companion:input-viewer','selectXInput',{index}):Promise.reject(TypeError('Invalid controller')),
  subscribeInput:callback=>{if(typeof callback!=='function')throw TypeError('Listener required');const fn=(_event,value)=>callback(value);ipcRenderer.on('companion:input-viewer:input',fn);return()=>ipcRenderer.removeListener('companion:input-viewer:input',fn);},
  subscribeDisconnect:callback=>{if(typeof callback!=='function')throw TypeError('Listener required');const fn=(_event,value)=>callback(value);ipcRenderer.on('companion:input-viewer:disconnected',fn);return()=>ipcRenderer.removeListener('companion:input-viewer:disconnected',fn);},
  subscribe:callback=>{if(typeof callback!=='function')throw TypeError('Listener required');const fn=(_event,value)=>callback(value);ipcRenderer.on('companion:input-viewer:state',fn);return()=>ipcRenderer.removeListener('companion:input-viewer:state',fn);}
 }));
}
