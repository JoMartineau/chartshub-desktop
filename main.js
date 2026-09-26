'use strict';
const {app,BrowserWindow,ipcMain,dialog,Menu,shell,session,nativeTheme}=require('electron');
const path=require('node:path');
const {ORIGIN,endpointValid,downloadChart}=require('./download');
const {applicationMenu}=require('./app-menu');
let win,job=null;
function trusted(url){try{const u=new URL(url);return u.origin===ORIGIN&&!u.username&&!u.password;}catch{return false;}}
function allowedSender(event){return win&&!win.isDestroyed()&&event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame&&trusted(event.senderFrame.url);}
async function external(url){
 try{const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password)return;
 const {response}=await dialog.showMessageBox(win,{type:'question',buttons:['Annuler','Ouvrir dans le navigateur'],defaultId:0,cancelId:0,message:'Ouvrir ce lien externe ?',detail:u.href});if(response===1)await shell.openExternal(u.href);
 }catch{}
}
if(!app.requestSingleInstanceLock())app.quit();
else{
 app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
 app.whenReady().then(()=>{
  const ses=session.fromPartition('persist:chartshub');
  ses.setPermissionRequestHandler((_web,permission,callback)=>callback(false));
  ses.setPermissionCheckHandler(()=>false);
  ses.on('will-download',(event)=>event.preventDefault());
  win=new BrowserWindow({width:1400,height:950,minWidth:720,minHeight:560,title:'ChartsHub',...(process.platform==='win32'?{titleBarStyle:'hidden',titleBarOverlay:{color:'#090e19',symbolColor:'#eef3ff',height:32}}:{}),backgroundColor:'#090e19',icon:path.join(__dirname,process.platform==='win32'?'icon.ico':'icon.png'),webPreferences:{session:ses,preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false}});
  win.webContents.setWindowOpenHandler(({url})=>{if(trusted(url))win.loadURL(url);else void external(url);return {action:'deny'};});
  win.webContents.on('will-navigate',(event,url)=>{if(!trusted(url)){event.preventDefault();void external(url);}});
  win.webContents.on('will-redirect',(event,url)=>{if(!trusted(url))event.preventDefault();});
  win.webContents.on('will-attach-webview',event=>event.preventDefault());
  const load=route=>win.loadURL(ORIGIN+route).catch(()=>dialog.showMessageBox(win,{type:'error',message:'Connexion à ChartsHub impossible.',detail:'Vérifiez votre connexion Internet, puis utilisez Ctrl+R (ou Cmd+R sur Mac).'}));
  Menu.setApplicationMenu(null);
  win.setMenuBarVisibility(false);
  ipcMain.handle('chartshub:theme',(event,mode)=>{
   if(!allowedSender(event)||!['light','dark'].includes(mode))return;
   nativeTheme.themeSource=mode;
   const color=mode==='light'?'#f4f7fb':'#090e19';
   win.setBackgroundColor(color);
   if(process.platform==='win32')win.setTitleBarOverlay({color,symbolColor:mode==='light'?'#17263e':'#eef3ff',height:32});
  });
  ipcMain.handle('chartshub:menu',(event,language)=>{
   if(!allowedSender(event)||!['fr','en'].includes(language))return;
   Menu.buildFromTemplate(applicationMenu({language,load,web:win.webContents,close:()=>win.close(),cancel:()=>job?.abort(),downloading:Boolean(job),toggleFullscreen:()=>win.setFullScreen(!win.isFullScreen())})).popup({window:win});
  });
  win.webContents.on('before-input-event',(event,input)=>{
   if(input.type!=='keyDown')return;
   const key=input.key.toLowerCase(),command=process.platform==='darwin'?input.meta:input.control;
   if(key==='f5'||(command&&key==='r')){event.preventDefault();win.webContents.reload();}
   else if(key==='f11'){event.preventDefault();win.setFullScreen(!win.isFullScreen());}
   else if(command&&['+','=','-','0'].includes(key)){event.preventDefault();const level=key==='0'?0:Math.max(-2,Math.min(3,win.webContents.getZoomLevel()+(key==='-'?-.5:.5)));win.webContents.setZoomLevel(level);}
  });
  ipcMain.handle('chartshub:download',async(event,endpoint)=>{
   if(!allowedSender(event)||!endpointValid(endpoint))return {ok:false,error:'Demande non autorisée.'};
   if(job)return {ok:false,error:'Un téléchargement est déjà en cours.'};
   const controller=new AbortController();job=controller;
   const timer=setTimeout(()=>controller.abort(),3600000);
   try{
    const choice=await dialog.showOpenDialog(win,{title:endpoint.includes('/admin/')?'Choisir le dossier de vérification':'Choisir votre dossier de charts',properties:['openDirectory','createDirectory']});
    if(choice.canceled)return {ok:false,cancelled:true};
    if(!allowedSender(event))throw Error('La page a changé. Réessayez.');
    const result=await downloadChart({endpoint,directory:choice.filePaths[0],fetcher:(url,options)=>ses.fetch(url,options),signal:controller.signal,progress:data=>{if(allowedSender(event))event.sender.send('chartshub:progress',data);if(win&&!win.isDestroyed())win.setProgressBar(data.percent/100);}});
    // Only a path produced by this download operation is passed to the OS.
    shell.showItemInFolder(result.destination);
    return {ok:true,folderName:result.folderName,files:result.files};
   }catch(error){return controller.signal.aborted?{ok:false,cancelled:true}:{ok:false,error:error.message};}
   finally{clearTimeout(timer);job=null;if(win&&!win.isDestroyed())win.setProgressBar(-1);}
  });
  ipcMain.handle('chartshub:cancel',event=>{if(allowedSender(event))job?.abort();});
  win.on('close',event=>{if(job){event.preventDefault();dialog.showMessageBox(win,{type:'question',buttons:['Continuer le téléchargement','Annuler et quitter'],defaultId:0,cancelId:0,message:'Un téléchargement est en cours.'}).then(({response})=>{if(response===1){job?.abort();const wait=setInterval(()=>{if(!job){clearInterval(wait);win.close();}},100);}});}});
  void load('/');
 });
 app.on('window-all-closed',()=>app.quit());
}
