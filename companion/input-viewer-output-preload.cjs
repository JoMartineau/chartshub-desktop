'use strict';
const {contextBridge,ipcRenderer}=require('electron');
if(location.href==='chartshub-companion://app/ui/input-viewer-output.html'&&process.isMainFrame!==false){
 contextBridge.exposeInMainWorld('ChartsHubInputViewerOutput',Object.freeze({
  language:process.argv.some(value=>value==='--chartshub-input-viewer-language=en')?'en':'fr',
  snapshot:()=>ipcRenderer.invoke('companion:input-viewer:output-snapshot',{})
 }));
}
