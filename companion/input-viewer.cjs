'use strict';
const path=require('node:path'),{pathToFileURL}=require('node:url');
const {assetPath}=require('./security.cjs');
const CHANNEL='companion:input-viewer',PAGE='chartshub-companion://app/ui/input-viewer.html',TITLE='ChartsHub — Input Viewer';
const empty=value=>value==null||(typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===0);
function trusted(event,window){return !!window&&!window.isDestroyed()&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame&&event.senderFrame.url===PAGE;}
/** No operating-system input hooks or game integration. Input polling belongs
 * only to the owned local renderer after its explicit Start button. */
async function createInputViewer({root,active=()=>true,language=()=> 'fr',onChange=()=>{},electron=require('electron')}){
 const {BrowserWindow,session,ipcMain,net}=electron,ses=session.fromPartition('persist:chartshub-input-viewer');
 let window=null,opening=null,disposed=false,phase='stopped',revocation=null;
 const alive=()=>!disposed&&active()===true;
 const status=()=>({available:alive(),open:!!window&&!window.isDestroyed(),phase,title:TITLE,language:language()==='en'?'en':'fr'});
 const notify=()=>{if(window&&!window.isDestroyed())window.webContents.send(CHANNEL+':state',status());onChange();};
 ses.setPermissionCheckHandler(()=>false);ses.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
 await ses.protocol.handle('chartshub-companion',request=>{const file=assetPath(root,request.url);return file&&request.method==='GET'?net.fetch(pathToFileURL(file).href):new Response('Not found',{status:404});});
 function stop(closeWindow=true){phase='stopped';if(revocation)clearInterval(revocation);revocation=null;notify();if(closeWindow&&window&&!window.isDestroyed())window.destroy();}
 ipcMain.handle(CHANNEL,(event,command,payload)=>{
  if(!alive()||!trusted(event,window)||!['snapshot','start','stop'].includes(command)||!empty(payload))return{ok:false};
  if(command==='start'){phase='running';if(!revocation){revocation=setInterval(()=>{if(!alive())stop(true);},100);revocation.unref?.();}notify();}else if(command==='stop')stop(false);
  return{ok:true,state:status()};
 });
 async function open(){
  if(!alive())return null;if(opening)return opening;
  if(window&&!window.isDestroyed()){window.setAlwaysOnTop(true,'screen-saver');window.show();window.focus();return window;}
  const task=(async()=>{
   const next=new BrowserWindow({width:1000,height:850,minWidth:520,minHeight:260,show:false,transparent:true,alwaysOnTop:true,backgroundColor:'#00000000',title:TITLE,autoHideMenuBar:true,webPreferences:{session:ses,preload:path.join(root,'input-viewer-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false,additionalArguments:['--chartshub-input-viewer-language='+status().language]}});
   window=next;phase='stopped';next.setMenuBarVisibility(false);next.webContents.setWindowOpenHandler(()=>({action:'deny'}));
   next.webContents.on('will-navigate',(event,url)=>{if(url!==PAGE)event.preventDefault();});next.webContents.on('will-redirect',event=>event.preventDefault());next.webContents.on('will-attach-webview',event=>event.preventDefault());
   next.webContents.on('render-process-gone',()=>stop(true));
   next.webContents.on('did-start-loading',()=>{phase='stopped';if(revocation)clearInterval(revocation);revocation=null;onChange();});
   next.once('closed',()=>{if(window===next){window=null;phase='stopped';if(revocation)clearInterval(revocation);revocation=null;onChange();}});
   try{await next.loadURL(PAGE);if(!alive()||window!==next){if(!next.isDestroyed())next.destroy();return null;}next.setAlwaysOnTop(true,'screen-saver');next.show();next.focus();notify();return next;}
   catch(error){if(!next.isDestroyed())next.destroy();throw error;}
  })();opening=task;try{return await task;}finally{if(opening===task)opening=null;}
 }
 async function dispose(){if(disposed)return;disposed=true;stop(true);ipcMain.removeHandler(CHANNEL);await opening?.catch(()=>{});await ses.protocol.unhandle('chartshub-companion');}
 return{open,stop,dispose,status,getWindow:()=>window};
}
module.exports={createInputViewer,trusted,PAGE,TITLE,CHANNEL};
