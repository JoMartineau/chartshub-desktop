'use strict';
const {app,BrowserWindow,ipcMain,dialog,Menu,shell,session,nativeTheme,Notification}=require('electron');
const path=require('node:path');
const {registerCompanionScheme,createCompanionHost}=require('./companion/host.cjs');
const {createDesktopShell}=require('./desktop/controller.cjs');
const {createDownloadNotifications}=require('./desktop/download-notifications.cjs');
const {createCloneHeroProcessProbe}=require('./companion/clonehero-process.cjs');
registerCompanionScheme();
const profileIndex=process.argv.indexOf('--companion-profile');
if(profileIndex>=0&&process.argv[profileIndex+1])app.setPath('userData',path.resolve(process.argv[profileIndex+1]));
let desktop,web,companionHostPromise,closing=false,allowClose=false,companionAvailable=false,companionLanguage='en';
let loadCatalogue=()=>{},canOpenCompanion=async()=>false;
let notificationBroker=null;
let songRequestSharing=null;
let requestedTab=process.argv.includes('--companion')?'companion':'catalogue';
const focusWindow=()=>{if(win&&!win.isDestroyed()){if(win.isMinimized())win.restore();win.show();win.focus();}};
const openCompanion=async()=>{
 if(!desktop||closing)return;
 await desktop.ready;
 if(closing)return;
 if(!await canOpenCompanion()){if(!closing&&requestedTab==='companion')await selectTab('catalogue');return;}
 if(closing||requestedTab!=='companion')return;
 if(!companionHostPromise)companionHostPromise=createCompanionHost({sharingClient:songRequestSharing,isCatalogueAvailable:()=>companionAvailable&&!closing,authorizeCatalogue:()=>canOpenCompanion(),downloadNotifications:{capture:()=>notificationBroker?.capture(),track:(...args)=>notificationBroker?.trackCompanion(...args),observe:value=>notificationBroker?.observeCompanion(value)},embedded:{ownerWindow:win,attachView:view=>desktop.attachCompanion(view),activate:()=>{if(!closing&&companionAvailable&&requestedTab==='companion'){desktop.showTab('companion');focusWindow();}}}}).catch(error=>{companionHostPromise=null;throw error;});
 const host=await companionHostPromise;
 host.setLanguage?.(companionLanguage);
 if(closing||!companionAvailable||requestedTab!=='companion')return;
 return host.open();
};
const showCompanion=()=>void selectTab('companion').catch(()=>dialog.showErrorBox('ChartsHub Companion','Le Companion ne peut pas démarrer. Vérifiez que la distribution est complète.'));
async function selectTab(tab){
 if(closing||!['catalogue','companion'].includes(tab))return;
 requestedTab=tab;
 if(tab==='companion')return openCompanion();
 if(!desktop)return;
 await desktop.ready;
 if(closing||requestedTab!==tab)return;
 desktop.showTab('catalogue');loadCatalogue();focusWindow();
}
const {ORIGIN,endpointValid,downloadChart}=require('./download');
const {applicationMenu,canPreviewVisitor}=require('./app-menu');
const {batchValid,downloadBatch}=require('./batch-download');
const {folderPreferences}=require('./download-folder');
const {windowTheme}=require('./window-theme');
const {createAccountBoundDownloads}=require('./download-state');
let win,job=null,guest=null;
function trusted(url){try{const u=new URL(url);return u.origin===ORIGIN&&!u.username&&!u.password;}catch{return false;}}
function allowedSender(event){return !closing&&win&&!win.isDestroyed()&&web&&!web.isDestroyed()&&event.sender===web&&event.senderFrame===web.mainFrame&&trusted(event.senderFrame.url);}
async function external(url){
 try{const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password)return;
 const {response}=await dialog.showMessageBox(win,{type:'question',buttons:['Annuler','Ouvrir dans le navigateur'],defaultId:0,cancelId:0,message:'Ouvrir ce lien externe ?',detail:u.href});if(response===1)await shell.openExternal(u.href);
 }catch{}
}
if(!app.requestSingleInstanceLock())app.quit();
else{
 app.on('second-instance',(_event,argv)=>{requestedTab=argv.includes('--companion')?'companion':'catalogue';if(desktop)void selectTab(requestedTab).catch(()=>dialog.showErrorBox('ChartsHub','Cet onglet ne peut pas être ouvert.'));});
 app.whenReady().then(()=>{
  const ses=session.fromPartition('persist:chartshub');
  ses.setPermissionRequestHandler((_web,permission,callback)=>callback(false));
  ses.setPermissionCheckHandler(()=>false);
  ses.on('will-download',(event)=>event.preventDefault());
  desktop=createDesktopShell({cataloguePreferences:{session:ses,preload:path.join(__dirname,'preload.js'),additionalArguments:['--chartshub-tabbed'],contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,backgroundThrottling:false},onSelectTab:selectTab});
  win=desktop.window;web=desktop.catalogueView.webContents;
  if(process.platform==='win32')app.setAppUserModelId?.('ca.chartshub.desktop');
  notificationBroker=createDownloadNotifications({fetcher:(url,options)=>ses.fetch(url,options),probeGame:createCloneHeroProcessProbe(),language:()=>companionLanguage,
   showNative:(options,onClick)=>{if(process.platform!=='win32'||!Notification?.isSupported())return;const notice=new Notification({...options,icon:path.join(__dirname,'icon.ico')});notice.on('click',onClick);notice.on('failed',()=>{});notice.show();},
   openCentre:async current=>{if(!current()||closing)return;await selectTab('catalogue');if(current()&&!closing&&web&&!web.isDestroyed())await web.loadURL(ORIGIN+'/index.html?notifications=1');}
  });
  web.setWindowOpenHandler(({url})=>{if(trusted(url))void web.loadURL(url).catch(()=>{});else void external(url);return {action:'deny'};});
  web.on('will-navigate',(event,url)=>{if(!trusted(url)){event.preventDefault();void external(url);}});
  web.on('will-redirect',(event,url)=>{if(!trusted(url))event.preventDefault();});
  web.on('will-attach-webview',event=>event.preventDefault());
  let catalogueStarted=false;
  const load=route=>{catalogueStarted=true;return web.loadURL(ORIGIN+route).catch(()=>{if(!closing&&!win.isDestroyed())return dialog.showMessageBox(win,{type:'error',message:'Connexion à ChartsHub impossible.',detail:'Vérifiez votre connexion Internet, puis utilisez Ctrl+R (ou Cmd+R sur Mac).'});});};
  loadCatalogue=()=>{if(!catalogueStarted)void load('/');};
  Menu.setApplicationMenu(null);
  win.setMenuBarVisibility(false);
  const readAccount=async()=>{
   const response=await ses.fetch(ORIGIN+'/api/auth/me',{credentials:'include',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(5000)});
   if(response.status===401)return null;
   if(!response.ok)throw Error('Le compte ne peut pas être vérifié.');
   const data=await response.json();if(!Object.hasOwn(data,'user'))throw Error('Réponse du compte invalide.');return data.user;
  };
  const catalogueAlive=()=>win&&!win.isDestroyed()&&web&&!web.isDestroyed();
  const downloads=createAccountBoundDownloads({readAccount,cancel:()=>job?.abort(),publish:snapshot=>{if(catalogueAlive()&&trusted(web.getURL()))web.send('chartshub:download-state',snapshot);}});
  let accountRevision=0;
  songRequestSharing=require('./desktop/song-request-sharing.cjs').createSongRequestSharing({fetcher:(url,options)=>ses.fetch(url,options),readAccount,generation:()=>accountRevision});
  const syncCatalogueAccess=()=>{if(companionHostPromise)void companionHostPromise.then(host=>host.setCatalogueAvailable(companionAvailable&&!closing)).catch(()=>{});};
  const refreshAccount=async()=>{
   const revision=accountRevision,result=await downloads.refresh();
   if(!closing&&revision===accountRevision){notificationBroker.setAccount(result.ok?result.user:null);companionAvailable=result.ok&&Boolean(result.user);desktop.setCompanionAvailable(companionAvailable);syncCatalogueAccess();}
   return result;
  };
  const invalidateAccount=()=>{accountRevision++;notificationBroker.invalidate();companionAvailable=false;desktop.setCompanionAvailable(false);syncCatalogueAccess();downloads.invalidate();};
  canOpenCompanion=async()=>{await refreshAccount();return companionAvailable&&!closing;};
  const reportProgress=(token,data)=>{if(!downloads.progress(token,data))return;if(catalogueAlive()){if(trusted(web.getURL()))web.send('chartshub:progress',data);win.setProgressBar(data.percent/100);}};
  ipcMain.handle('chartshub:download-state',async event=>{if(!allowedSender(event))return null;await refreshAccount();return allowedSender(event)?downloads.snapshot():null;});
  const folders=folderPreferences(app.getPath('userData'));
  let reportSaving=false;
  ipcMain.handle('chartshub:save-checker-report',async(event,payload)=>{
   if(!allowedSender(event)||reportSaving)return {ok:false,error:'Export indisponible.'};reportSaving=true;
   const revision=adminRevision;
   try{return await require('./chart-checker-report').saveCheckerReport({payload,authorized:()=>allowedSender(event)&&revision===adminRevision,choose:()=>dialog.showSaveDialog(win,{title:'Enregistrer le rapport Chart Checker',defaultPath:path.join(app.getPath('downloads'),'chartshub-chart-checker.json'),filters:[{name:'Rapport JSON',extensions:['json']}],properties:['showOverwriteConfirmation']})});}
   catch(error){return {ok:false,error:error.message};}finally{reportSaving=false;}
  });
  async function chooseFolder(kind,force=false){
   const saved=await folders.get(kind);if(saved&&!force)return saved;
   const choice=await dialog.showOpenDialog(win,{title:kind==='review'?'Dossier de vérification':'Dossier d’exportation des charts',defaultPath:saved||app.getPath('downloads'),properties:['openDirectory','createDirectory']});
   return choice.canceled?null:folders.set(kind,choice.filePaths[0]);
  }
  ipcMain.handle('chartshub:folder',async(event,change)=>{
   if(!allowedSender(event)||typeof change!=='boolean')return {ok:false};
   if(job&&change)return {ok:false,error:'Attendez la fin du téléchargement pour changer le dossier.'};
   try{const directory=change?await chooseFolder('catalogue',true):await folders.get('catalogue');return {ok:!!directory,folderName:directory?path.basename(directory):'',cancelled:change&&!directory};}catch(error){return {ok:false,error:error.message};}
  });
  ipcMain.handle('chartshub:theme',(event,value)=>{
   if(!allowedSender(event))return;
   const theme=windowTheme(value);if(!theme)return;
   nativeTheme.themeSource=theme.mode;
   desktop.setTheme(theme);
   return theme;
  });
  ipcMain.handle('chartshub:fullscreen',(event,toggle)=>{
   if(!allowedSender(event)||typeof toggle!=='boolean')return;
   if(toggle)win.setFullScreen(!win.isFullScreen());
   return win.isFullScreen();
  });
  for(const eventName of ['enter-full-screen','leave-full-screen'])win.on(eventName,()=>{if(catalogueAlive())web.send('chartshub:fullscreen-state',win.isFullScreen());});
  const administrator=async()=>{
   const result=await refreshAccount();return result.ok&&canPreviewVisitor(result.user);
  };
  let adminAllowed=false,adminCheck=null,adminRevision=0;
  const refreshAdministrator=()=>{if(adminCheck)return adminCheck;const current=adminRevision;adminCheck=administrator().then(value=>{if(current===adminRevision)adminAllowed=value;}).finally(()=>{adminCheck=null;if(current!==adminRevision)void refreshAdministrator();});return adminCheck;};
  const resetAdministrator=()=>{invalidateAccount();adminAllowed=false;adminRevision++;void refreshAdministrator();};
  // Navigating between ChartsHub pages does not change the authenticated identity.
  // Keep Companion visible while the current session is revalidated in the background.
  // Cookie/account mutations still revoke access immediately.
  const beginNavigationRevalidation=()=>{adminAllowed=false;adminRevision++;};
  const finishNavigationRevalidation=()=>{void refreshAdministrator();};
  web.on('did-start-navigation',(_event,_url,inPlace,mainFrame)=>{if(mainFrame&&!inPlace)beginNavigationRevalidation();});
  web.on('did-finish-load',finishNavigationRevalidation);
  ses.cookies.on('changed',(_event,cookie)=>{if(cookie.name==='chartshub_session'&&cookie.domain.replace(/^\./,'')===new URL(ORIGIN).hostname)resetAdministrator();});
  ipcMain.handle('chartshub:account-changed',event=>{if(allowedSender(event)){beginNavigationRevalidation();void refreshAdministrator();}});
  ipcMain.handle('chartshub:language',(event,value)=>{
   if(!allowedSender(event)||!['fr','en'].includes(value))return false;
   companionLanguage=value;
   if(companionHostPromise)void companionHostPromise.then(host=>host.setLanguage(value)).catch(()=>{});
   return true;
  });
  const openGuest=async()=>{
   if(!await administrator()||closing||!win||win.isDestroyed())return;
   if(guest&&!guest.isDestroyed()){guest.focus();return;}
   const guestSession=session.fromPartition('guest-'+require('node:crypto').randomUUID());
   guestSession.setPermissionRequestHandler((_web,_permission,callback)=>callback(false));
   guestSession.setPermissionCheckHandler(()=>false);
   guestSession.webRequest.onBeforeSendHeaders((details,callback)=>{
    const headers={...details.requestHeaders};for(const key of Object.keys(headers))if(['cookie','authorization'].includes(key.toLowerCase()))delete headers[key];
    const u=new URL(details.url);const cancel=u.origin===ORIGIN&&u.pathname.startsWith('/api/auth/')&&!['GET','HEAD','OPTIONS'].includes(details.method);
    callback({cancel,requestHeaders:headers});
   });
   guestSession.webRequest.onHeadersReceived((details,callback)=>{
    const headers={...details.responseHeaders};for(const key of Object.keys(headers))if(key.toLowerCase()==='set-cookie')delete headers[key];callback({responseHeaders:headers});
   });
   guestSession.on('will-download',event=>event.preventDefault());
   guest=new BrowserWindow({width:1400,height:950,minWidth:720,minHeight:560,title:'ChartsHub — Visiteur',icon:path.join(__dirname,process.platform==='win32'?'icon.ico':'icon.png'),webPreferences:{session:guestSession,preload:path.join(__dirname,'guest-preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,webviewTag:false}});
   guest.setMenuBarVisibility(false);
   guest.webContents.setWindowOpenHandler(()=>({action:'deny'}));
   guest.webContents.on('will-navigate',(event,url)=>{if(!trusted(url))event.preventDefault();});
   guest.webContents.on('will-redirect',(event,url)=>{if(!trusted(url))event.preventDefault();});
   guest.webContents.on('will-attach-webview',event=>event.preventDefault());
   guest.on('closed',()=>{guest=null;void guestSession.clearStorageData();if(win&&!win.isDestroyed())win.focus();});
   void guest.loadURL(ORIGIN+'/').catch(()=>{if(guest&&!guest.isDestroyed())guest.close();});
  };
  win.on('closed',()=>{if(guest&&!guest.isDestroyed())guest.close();});
  ipcMain.handle('chartshub:close-guest',event=>{
   if(guest&&!guest.isDestroyed()&&event.sender===guest.webContents&&event.senderFrame===guest.webContents.mainFrame&&trusted(event.senderFrame.url))guest.close();
  });
  ipcMain.handle('chartshub:menu',async(event,language)=>{
   if(!allowedSender(event)||!['fr','en'].includes(language))return;
   void refreshAdministrator();
   Menu.buildFromTemplate(applicationMenu({language,load,companion:companionAvailable?showCompanion:undefined,visitorPreview:adminAllowed?()=>void openGuest():undefined,web,close:()=>win.close(),cancel:()=>job?.abort(),downloading:Boolean(job),toggleFullscreen:()=>win.setFullScreen(!win.isFullScreen())})).popup({window:win});
  });
  web.on('before-input-event',(event,input)=>{
   if(input.type!=='keyDown')return;
   const key=input.key.toLowerCase(),command=process.platform==='darwin'?input.meta:input.control;
   if(key==='f5'||(command&&key==='r')){event.preventDefault();web.reload();}
   else if(command&&['+','=','-','0'].includes(key)){event.preventDefault();const level=key==='0'?0:Math.max(-2,Math.min(3,web.getZoomLevel()+(key==='-'?-.5:.5)));web.setZoomLevel(level);}
  });
  ipcMain.handle('chartshub:download-batch',async(event,endpoints)=>{
   if(!allowedSender(event)||!batchValid(endpoints))return {ok:false,error:'Sélection non autorisée.'};
   if(job)return {ok:false,error:'Un téléchargement est déjà en cours.'};
   const controller=new AbortController();job=controller;
   let result,token,notificationScope;
   try{
    const account=await refreshAccount();if(!account.ok)throw Error('Le compte ne peut pas être vérifié. Réessayez.');
    controller.signal.throwIfAborted();if(!allowedSender(event))throw Error('La page a changé. Réessayez.');
    token=downloads.begin(endpoints,'batch');
    notificationScope=notificationBroker.capture();
    const directory=await chooseFolder('catalogue');
    if(!directory)return result={ok:false,cancelled:true,results:[]};
    if(!allowedSender(event))throw Error('La page a changé. Réessayez.');
    result=await downloadBatch({endpoints,directory,fetcher:(url,options)=>ses.fetch(url,options),signal:controller.signal,progress:data=>reportProgress(token,data)});
    await refreshAccount();return downloads.current(token)?result:{ok:false,cancelled:true,results:[]};
   }catch(error){return result={ok:false,error:error.message,cancelled:controller.signal.aborted};}
   finally{downloads.finish(token,result);notificationBroker.finishNative(notificationScope,endpoints,result);job=null;if(win&&!win.isDestroyed())win.setProgressBar(-1);}
  });
  ipcMain.handle('chartshub:download',async(event,endpoint)=>{
   if(!allowedSender(event)||!endpointValid(endpoint))return {ok:false,error:'Demande non autorisée.'};
   if(job)return {ok:false,error:'Un téléchargement est déjà en cours.'};
   const controller=new AbortController();job=controller;
   let outcome,token,notificationScope;
   try{
    const account=await refreshAccount();if(!account.ok)throw Error('Le compte ne peut pas être vérifié. Réessayez.');
    controller.signal.throwIfAborted();if(!allowedSender(event))throw Error('La page a changé. Réessayez.');
    token=downloads.begin([endpoint],'single');
    notificationScope=notificationBroker.capture();
    const directory=await chooseFolder(endpoint.includes('/admin/')?'review':'catalogue');
    if(!directory)return outcome={ok:false,cancelled:true};
    if(!allowedSender(event))throw Error('La page a changé. Réessayez.');
    const result=await downloadChart({endpoint,directory,fetcher:(url,options)=>ses.fetch(url,options),signal:controller.signal,progress:data=>reportProgress(token,{...data,endpoint,itemPercent:data.percent})});
    await refreshAccount();if(!downloads.current(token))return outcome={ok:false,cancelled:true};
    // Only a path produced by this download operation is passed to the OS.
    shell.showItemInFolder(result.destination);
    return outcome={ok:true,folderName:result.folderName,files:result.files};
   }catch(error){return outcome=controller.signal.aborted?{ok:false,cancelled:true}:{ok:false,error:error.message};}
   finally{downloads.finish(token,outcome);notificationBroker.finishNative(notificationScope,[endpoint],outcome);job=null;if(win&&!win.isDestroyed())win.setProgressBar(-1);}
  });
  ipcMain.handle('chartshub:cancel',event=>{if(allowedSender(event))job?.abort();});
  const finishClose=async()=>{
   closing=true;
   notificationBroker?.invalidate();
   try{if(companionHostPromise)await (await companionHostPromise).dispose();}
   catch(error){console.error('Companion shutdown:',error.message);}
   finally{await notificationBroker?.dispose();await desktop.dispose();allowClose=true;if(!win.isDestroyed())win.close();}
  };
  let closePrompt=false;
  win.on('close',event=>{
   if(allowClose)return;
   event.preventDefault();if(closing||closePrompt)return;
   if(!job){void finishClose();return;}
   closePrompt=true;
   void dialog.showMessageBox(win,{type:'question',buttons:['Continuer le téléchargement','Annuler et quitter'],defaultId:0,cancelId:0,message:'Un téléchargement est en cours.'}).then(async({response})=>{
    if(response!==1)return;
    job?.abort();
    await new Promise(resolve=>{const wait=setInterval(()=>{if(!job){clearInterval(wait);resolve();}},100);});
    await finishClose();
   }).catch(error=>console.error('Window shutdown:',error.message)).finally(()=>{closePrompt=false;});
  });
  app.on('before-quit',event=>{if(!allowClose&&win&&!win.isDestroyed()){event.preventDefault();win.close();}});
  void selectTab(requestedTab).catch(()=>dialog.showErrorBox('ChartsHub','Cet onglet ne peut pas être ouvert.'));
 });
 app.on('window-all-closed',()=>app.quit());
}
