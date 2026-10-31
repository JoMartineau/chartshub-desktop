'use strict';
const {contextBridge,ipcRenderer}=require('electron');
if(location.href==='chartshub-companion://app/ui/input-viewer.html'&&process.isMainFrame!==false){
 const arg=process.argv.find(value=>value.startsWith('--chartshub-input-viewer-language=')),language=arg?.split('=')[1]==='en'?'en':'fr';
 contextBridge.exposeInMainWorld('ChartsHubInputViewer',Object.freeze({language,
  command:name=>['snapshot','start','stop'].includes(name)?ipcRenderer.invoke('companion:input-viewer',name,{}):Promise.reject(TypeError('Invalid viewer command')),
  subscribe:callback=>{if(typeof callback!=='function')throw TypeError('Listener required');const fn=(_event,value)=>callback(value);ipcRenderer.on('companion:input-viewer:state',fn);return()=>ipcRenderer.removeListener('companion:input-viewer:state',fn);}
 }));
}
