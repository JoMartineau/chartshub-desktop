'use strict';
const {app,BrowserWindow,ipcMain,dialog,Menu,shell,session,nativeTheme,Notification}=require('electron');
const path=require('node:path');
const {registerCompanionScheme,createCompanionHost}=require('./companion/host.cjs');
const {createDesktopShell}=require('./desktop/controller.cjs');
const {attachEditContextMenu}=require('./desktop/edit-context-menu.cjs');
const {createDownloadNotifications}=require('./desktop/download-notifications.cjs');
const {createDownloadCompletion}=require('./desktop/download-completion.cjs');
const {createCloneHeroProcessProbe}=require('./companion/clonehero-process.cjs');
const {runtime:localeRuntime,pair:localePair,createLanguagePreferences}=require('./desktop/language.cjs');
registerCompanionScheme();
const profileIndex=process.argv.indexOf('--companion-profile');
if(profileIndex>=0&&process.argv[profileIndex+1])app.setPath('userData',path.resolve(process.argv[profileIndex+1]));
let desktop,web,companionHostPromise,closing=false,allowClose=false,companionAvailable=false,companionLanguage='en';
let loadCatalogue=()=>{},canOpenCompanion=async()=>false;
let notificationBroker=null,languagePreferences;
async function applyLanguage(value){
 const locale=localeRuntime.canonicalize(value);if(!locale||closing||!languagePreferences)return false;
 if(!await languagePreferences.set(locale))return false;
 if(closing||companionLanguage===locale)return true;
 companionLanguage=locale;desktop?.setLanguage?.(locale);
 activeCompanionHost?.setLanguage(locale);
 if(web&&!web.isDestroyed()&&trusted(web.getURL()))web.send('chartshub:language-state',locale);
 return true;
}
let reportDownloadCompletion;
let songRequestSharing=null;
let activeCompanionHost=null,maintenance=null,updater=null,maintenanceLocked=false,pendingUpdate=false;
let backupModule=null,backupEngine=null,backupReady=Promise.resolve(),pendingBackupId=null;
let buttonMotion={economy:false};
let cataloguePalette=null,paletteIpc=null;
const startupTab=argv=>argv.includes('--companion')?'companion':'catalogue';
let requestedTab=startupTab(process.argv);
const focusWindow=()=>{if(win&&!win.isDestroyed()){if(win.isMinimized())win.restore();win.show();win.focus();}};
const openCompanion=async()=>{
 if(!desktop||closing)return;
 await desktop.ready;
 await backupReady;
 if(closing)return;
 // Restore the Catalogue's own persistent appearance through its normal page
 // lifecycle, including when the app was launched directly on Companion.
 loadCatalogue();
 if(!await canOpenCompanion()){if(!closing&&requestedTab==='companion')await selectTab('catalogue');return;}
 if(closing||requestedTab!=='companion')return;
 if(!companionHostPromise)companionHostPromise=createCompanionHost({initialLanguage:companionLanguage,saveLanguage:applyLanguage,sharingClient:songRequestSharing,isCatalogueAvailable:()=>companionAvailable&&!closing,authorizeCatalogue:()=>canOpenCompanion(),reportDownloadCompletion,downloadNotifications:{capture:()=>notificationBroker?.capture(),track:(...args)=>notificationBroker?.trackCompanion(...args),observe:value=>notificationBroker?.observeCompanion(value)},embedded:{ownerWindow:win,attachView:view=>desktop.attachCompanion(view),activate:()=>{if(!closing&&companionAvailable&&requestedTab==='companion'){desktop.showTab('companion');focusWindow();}}}}).catch(error=>{companionHostPromise=null;throw error;});
 const host=await companionHostPromise;
 activeCompanionHost=host;
 desktop.setLanguage?.(companionLanguage);
 host.setLanguage?.(companionLanguage);
 host.setButtonMotion?.(buttonMotion);
 if(cataloguePalette)host.setUIPalette?.(cataloguePalette);
 if(closing||!companionAvailable||requestedTab!=='companion')return;
 return host.open();
};
const showCompanion=()=>void selectTab('companion').catch(error=>dialog.showErrorBox(companionLanguage==='fr'?'ChartsHub — Tableau de bord':'ChartsHub — Dashboard',error?.code==='BACKUP_RECOVERY_REQUIRED'?(companionLanguage==='fr'?'Une restauration interrompue demande une vérification manuelle. Les fichiers et leurs sauvegardes ont été conservés.':'An interrupted restore requires manual review. Files and backups have been preserved.'):(companionLanguage==='fr'?'Le Tableau de bord ne peut pas démarrer. Vérifiez que la distribution est complète.':'The Dashboard cannot start. Check that the distribution is complete.')));
async function selectTab(tab){
 if(closing||!['catalogue','companion'].includes(tab))return;
 requestedTab=tab;
 if(tab==='companion')return openCompanion();
 if(!desktop)return;
 await desktop.ready;
 if(closing||requestedTab!==tab)return;
 desktop.showTab('catalogue');loadCatalogue();focusWindow();
}
const {ORIGIN,endpointValid,downloadChart,songFolderName}=require('./download');
const {normalizeEnchorDownloadRequest,enchorIdentity,downloadEnchor}=require('./enchor-download');
const {applicationMenu,canPreviewVisitor}=require('./app-menu');
const {batchValid,normalizeBatch,downloadBatch}=require('./batch-download');
const {folderPreferences}=require('./download-folder');
const {windowTheme}=require('./window-theme');
const {createAccountBoundDownloads}=require('./download-state');
let win,job=null,publicDownloadJob=null,guest=null;
function trusted(url){try{const u=new URL(url);return u.origin===ORIGIN&&!u.username&&!u.password;}catch{return false;}}
function allowedSender(event){return !closing&&!maintenanceLocked&&win&&!win.isDestroyed()&&web&&!web.isDestroyed()&&event.sender===web&&event.senderFrame===web.mainFrame&&trusted(event.senderFrame.url);}
function resumeUIPalette(){if(!closing&&!maintenanceLocked&&win&&!win.isDestroyed()&&web&&!web.isDestroyed()&&trusted(web.getURL()))web.send('chartshub:ui-palette-resume');}
async function external(url){
 try{const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password)return;
 const {response}=await dialog.showMessageBox(win,{type:'question',buttons:['Annuler','Ouvrir dans le navigateur'],defaultId:0,cancelId:0,message:'Ouvrir ce lien externe ?',detail:u.href});if(response===1)await shell.openExternal(u.href);
 }catch{}
}
if(!app.requestSingleInstanceLock())app.quit();
else{
 app.on('second-instance',(_event,argv)=>{requestedTab=startupTab(argv);if(desktop)void selectTab(requestedTab).catch(()=>dialog.showErrorBox('ChartsHub','Cet onglet ne peut pas être ouvert.'));});
 app.whenReady().then(async()=>{
  languagePreferences=createLanguagePreferences({filename:path.join(app.getPath('userData'),'language.json'),preferredLanguages:()=>app.getPreferredSystemLanguages?.()||[app.getLocale?.()||'en']});
  companionLanguage=await languagePreferences.load();
  const ses=session.fromPartition('persist:chartshub');
  const rhythmVersePreload=ses.registerPreloadScript({
   type:'frame',filePath:path.join(__dirname,'desktop/rhythmverse-catalogue-preload.cjs')
  });
  reportDownloadCompletion=createDownloadCompletion((url,options)=>ses.fetch(url,options));
  ses.setPermissionRequestHandler((_web,permission,callback)=>callback(false));
  ses.setPermissionCheckHandler(()=>false);
  ses.on('will-download',(event)=>event.preventDefault());
  const catalogueArguments=['--chartshub-tabbed','--chartshub-desktop-language='+companionLanguage];
  if(languagePreferences.hasSaved())catalogueArguments.push('--chartshub-desktop-language-saved');
  desktop=createDesktopShell({cataloguePreferences:{session:ses,preload:path.join(__dirname,'preload.js'),additionalArguments:catalogueArguments,contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,backgroundThrottling:false},onSelectTab:selectTab,isMaintenanceLocked:()=>maintenanceLocked,onButtonMotion:value=>{buttonMotion={...value};if(companionHostPromise&&!closing)void companionHostPromise.then(host=>host.setButtonMotion?.(buttonMotion)).catch(()=>{});}});
  win=desktop.window;web=desktop.catalogueView.webContents;
  desktop.setLanguage?.(companionLanguage);
  attachEditContextMenu({contents:web,ownerWindow:win,buildMenu:template=>Menu.buildFromTemplate(template),language:()=>companionLanguage,isAllowed:()=>!closing&&trusted(web.getURL())});
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
  const load=route=>{
   catalogueStarted=true;
   // The shell handles main-frame errors and ignores cancelled navigation.
   return web.loadURL(ORIGIN+route).catch(()=>{});
  };
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
  const downloads=createAccountBoundDownloads({readAccount,cancel:()=>{if(job!==publicDownloadJob)job?.abort();},publish:snapshot=>{if(catalogueAlive()&&trusted(web.getURL()))web.send('chartshub:download-state',snapshot);}});
  const completedForQuickImport=require('./desktop/quick-import-download-completion.cjs').createQuickImportDownloadCompletion({
   getHost:()=>activeCompanionHost,isAvailable:()=>!closing&&!maintenanceLocked&&companionAvailable
  });
  const noteCompletedDownload=(endpoint,result,event,token,signal)=>completedForQuickImport({endpoint,result,authorized:!signal.aborted&&allowedSender(event)&&downloads.current(token)});
  let accountRevision=0;
  songRequestSharing=require('./desktop/song-request-sharing.cjs').createSongRequestSharing({fetcher:(url,options)=>ses.fetch(url,options),readAccount,generation:()=>accountRevision});
  let reminderDownload=false;
  const productionInstall=app.isPackaged===true;
  updater=require('./desktop/update-service.cjs').createUpdateService({currentVersion:require('./package.json').version,platform:process.platform,arch:process.arch,packaged:productionInstall,
   applicationDirectory:path.dirname(process.execPath),dataDirectory:app.getPath('userData'),
   busyReasons:()=>[...(job?['chart_downloads']:[]),...(backupModule?.getState().busy?['configuration_busy']:[]),...(activeCompanionHost?.maintenanceStatus?.().busyReasons??[])],
   openExternal:url=>shell.openExternal(url),launchHelper:require('./desktop/update-launcher.cjs').launchWindowsHelper,
   onChange:state=>{
    maintenance?.publish();
    if(reminderDownload&&!job&&!closing&&!win.isDestroyed()){
     const progress=state.progress;
     win.setProgressBar(state.status==='downloading'?(progress?progress.receivedBytes/progress.totalBytes:2):-1);
    }
   }
  });
  maintenance=require('./desktop/maintenance-ipc.cjs').createMaintenanceIpc({ipcMain,updater,dialog,
   getContents:()=>activeCompanionHost?.getPanelContents(),getOwner:()=>win,isAvailable:()=>companionAvailable&&!closing&&!win.isDestroyed(),language:()=>companionLanguage,
   beginInstall:async(isCurrent,kind='update')=>{
    if(maintenanceLocked||closing||job||!(kind==='rollback'?updater.snapshot().canRollback:updater.snapshot().canInstall))throw Object.assign(Error('Busy'),{code:'UPDATE_OPERATIONS_ACTIVE'});
    maintenanceLocked=true;activeCompanionHost?.setMaintenanceLocked(true);
    try{
     if(kind==='rollback')await updater.stageRollback();else await updater.stageInstallation();
     if(closing||!companionAvailable||!isCurrent()||job||activeCompanionHost?.maintenanceStatus().busyReasons.length)throw Object.assign(Error('Busy'),{code:'UPDATE_OPERATIONS_ACTIVE'});
     pendingUpdate=true;win.close();
    }catch(error){await updater.cancelInstallation();maintenanceLocked=false;activeCompanionHost?.setMaintenanceLocked(false);resumeUIPalette();throw error;}
   }
  });
  void updater.loadPreviousResult();
  const {createUpdateReminders,updateReminderPreferences}=require('./desktop/update-reminders.cjs');
  const updateWindowCurrent=()=>!closing&&!win.isDestroyed();
  const canPromptUpdate=()=>updateWindowCurrent()&&!maintenanceLocked&&!job&&!maintenance.isConfirming()&&!win.isMinimized?.();
  const updateText=(fr,en,values)=>localePair(companionLanguage,fr,en,values);
  const updateNotice=(message,type='info')=>dialog.showMessageBox(win,{type,title:'ChartsHub',message,noLink:true});
  const updateReminders=createUpdateReminders({
   updater,preferences:updateReminderPreferences(app.getPath('userData')),canPrompt:canPromptUpdate,
   show:async state=>{
    const answer=await dialog.showMessageBox(win,{
     type:'info',title:'ChartsHub',buttons:[updateText('Mettre à jour','Update'),updateText('Plus tard','Later')],
     defaultId:1,cancelId:1,noLink:true,
     message:updateText('Une mise à jour de ChartsHub est disponible.','A ChartsHub update is available.'),
     detail:updateText("Version {latestVersion} · installée {installedVersion}", "Version {latestVersion} · installed {installedVersion}", { latestVersion: state.latestVersion, installedVersion: state.currentVersion })
    });
    return answer.response===0;
   },
   onAccept:async state=>{
    try{
     if(!state.installSupported||!companionAvailable){await updater.openRelease();return;}
     if(state.status==='available'){
      reminderDownload=true;
      try{await updater.download();}
      finally{reminderDownload=false;if(!job&&updateWindowCurrent())win.setProgressBar(-1);}
     }
     if(!updateWindowCurrent())return;
     const result=await maintenance.confirmInstall(()=>updateWindowCurrent()&&companionAvailable);
     if(!result.ok&&updateWindowCurrent())await updateNotice(updateText('La mise à jour est téléchargée. Terminez les opérations en cours, puis ouvrez Application → Mises à jour.','The update is downloaded. Finish any active operations, then open Application → Updates.'));
    }catch{
     if(updateWindowCurrent())await updateNotice(updateText('La mise à jour n’a pas pu être terminée. Réessayez depuis Application → Mises à jour.','The update could not finish. Try again from Application → Updates.'),'warning');
    }
   },
   onManualResult:failed=>updateNotice(failed?updateText('La vérification a échoué. Réessayez plus tard.','The update check failed. Try again later.'):updateText('ChartsHub est à jour.','ChartsHub is up to date.'),failed?'warning':'info')
  });
  if(productionInstall)updateReminders.start();
  win.once('closed',()=>updateReminders.dispose());
  const profileDirectory=path.join(app.getPath('userData'),'companion');
  backupReady=require('./desktop/config-backup.cjs').createConfigBackup({directory:profileDirectory,version:require('./package.json').version,onChange:()=>maintenance?.publish()}).then(engine=>{
   backupEngine=engine;
   backupModule=require('./desktop/config-backup-ipc.cjs').createConfigBackupIpc({engine,getPanel:()=>win,dialog,protectedDirectories:[app.getPath('userData'),path.dirname(process.execPath)],language:()=>companionLanguage,publish:()=>maintenance?.publish(),
    beforeExport:async()=>{
     if(maintenanceLocked||closing||!companionAvailable)throw Object.assign(Error('Unavailable'),{code:'BACKUP_BUSY'});
     maintenanceLocked=true;activeCompanionHost?.setMaintenanceLocked(true);
     const release=()=>{maintenanceLocked=false;activeCompanionHost?.setMaintenanceLocked(false);resumeUIPalette();};
     try{await activeCompanionHost?.flushPortableConfiguration();await desktop.flushPortableConfiguration();return release;}catch(error){release();throw error;}
    },
    beginApply:async id=>{
     backupEngine.assertPreview(id);
     if(maintenanceLocked||closing||!companionAvailable||job||activeCompanionHost?.maintenanceStatus().busyReasons.length||['checking','downloading','staging'].includes(updater.snapshot().status))throw Object.assign(Error('Busy'),{code:'BACKUP_BUSY'});
     maintenanceLocked=true;activeCompanionHost?.setMaintenanceLocked(true);pendingBackupId=id;win.close();return {ok:true};
    }
   });
   maintenance.setBackupModule(backupModule);return engine;
  });
  void backupReady.catch(()=>{});
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
  const rhythmVerseDownloadError=error=>typeof error?.code==='string'&&error.code.startsWith('RV_ARCHIVE_')?error.message:'Le chart n’a pas pu être téléchargé ou extrait. Essayez depuis la fiche RhythmVerse.';
  const rhythmVerseCatalogue=require('./desktop/rhythmverse-catalogue.cjs').createRhythmVerseCatalogue({
   ipcMain,contents:web,allowedSender,openExternal:url=>shell.openExternal(url),
   nativeArchiveSupport:require('./desktop/rhythmverse-archive.cjs').canUseNativeRhythmVerseArchives(),
   download:async(record,current,{format,includeVideo})=>{
    if(job)return {ok:false,error:'Un téléchargement est déjà en cours.'};
    const controller=new AbortController();job=publicDownloadJob=controller;
    try{
     let directory,outputPath;
     if(format==='folder'){
      directory=await chooseFolder('catalogue');
      if(!directory)return {ok:false,cancelled:true};
     }else{
      const choice=await dialog.showSaveDialog(win,{title:'Enregistrer la chart en '+format.toUpperCase(),defaultPath:path.join(app.getPath('downloads'),songFolderName(record)+'.'+format),filters:[{name:format.toUpperCase(),extensions:[format]}],properties:['showOverwriteConfirmation','createDirectory']});
      if(choice.canceled||!choice.filePath)return {ok:false,cancelled:true};
      outputPath=choice.filePath;
     }
     if(!current())return {ok:false,cancelled:true};
     controller.signal.throwIfAborted();
     win.setProgressBar(2);
     const {installRhythmVerseChart}=require('./desktop/rhythmverse-install.cjs');
     const destination=await installRhythmVerseChart({record,directory,outputPath,format,includeVideo,signal:controller.signal});
     controller.signal.throwIfAborted();
     const folderName=path.basename(destination);
     if(format!=='folder'){
      if(current())shell.showItemInFolder(destination);
      return {ok:true,format,folderName};
     }
     const openFailed=!current()||await shell.openPath(destination).then(Boolean,()=>true);
     return {ok:true,format,folderName,...(openFailed?{openFailed:true}:{})};
    }catch(error){
     if(controller.signal.aborted)return {ok:false,cancelled:true};
     return {ok:false,error:rhythmVerseDownloadError(error)};
    }finally{job=publicDownloadJob=null;if(!win.isDestroyed())win.setProgressBar(-1);}
   }
  });
  ipcMain.handle('chartshub:theme',(event,value)=>{
   if(!allowedSender(event))return;
   const theme=windowTheme(value);if(!theme)return;
   nativeTheme.themeSource=theme.mode;
   desktop.setTheme(theme);
   return theme;
  });
  paletteIpc=require('./desktop/ui-palette.cjs').createUIPaletteIpc({ipcMain,allowedSender,onPalette:palette=>{
   cataloguePalette=palette;
   const theme=windowTheme({mode:palette.mode,accent:palette.colors.accent});
   nativeTheme.themeSource=theme.mode;desktop.setTheme(theme);desktop.setUIPalette(palette);
   activeCompanionHost?.setUIPalette(palette);
   return theme;
  }});
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
   const locale=localeRuntime.canonicalize(value);
   if(!allowedSender(event)||!locale)return false;
   return applyLanguage(locale);
  });
  ipcMain.handle('chartshub:language-current',event=>allowedSender(event)?{language:companionLanguage,saved:languagePreferences.hasSaved()}:null);
  ipcMain.handle('chartshub:toolbar-labels',event=>allowedSender(event)?{
   application:localePair(companionLanguage,'Application','Application'),
   enterFullscreen:localePair(companionLanguage,'Plein écran','Full screen'),
   exitFullscreen:localePair(companionLanguage,'Quitter le plein écran','Exit full screen'),
  }:null);
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
   const guestWindow=guest;
   attachEditContextMenu({contents:guestWindow.webContents,ownerWindow:guestWindow,buildMenu:template=>Menu.buildFromTemplate(template),language:()=>companionLanguage,isAllowed:()=>!closing&&trusted(guestWindow.webContents.getURL())});
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
  ipcMain.handle('chartshub:menu',async event=>{
   if(!allowedSender(event))return;
   void refreshAdministrator();
   Menu.buildFromTemplate(applicationMenu({language:companionLanguage,load,companion:companionAvailable?showCompanion:undefined,visitorPreview:adminAllowed?()=>void openGuest():undefined,web,close:()=>win.close(),cancel:()=>job?.abort(),downloading:Boolean(job),manualUpdate:()=>void updateReminders.checkManually(),toggleFullscreen:()=>win.setFullScreen(!win.isFullScreen())})).popup({window:win});
  });
  web.on('before-input-event',(event,input)=>{
   if(input.type!=='keyDown')return;
   const key=input.key.toLowerCase(),command=process.platform==='darwin'?input.meta:input.control;
   if(key==='f5'||(command&&key==='r')){event.preventDefault();web.reload();}
   else if(command&&['+','=','-','0'].includes(key)){event.preventDefault();const level=key==='0'?0:Math.max(-2,Math.min(3,web.getZoomLevel()+(key==='-'?-.5:.5)));web.setZoomLevel(level);}
  });
  ipcMain.handle('chartshub:download-batch',async(event,endpoints,includeVideo=true)=>{
   if(!allowedSender(event)||typeof includeVideo!=='boolean'||!batchValid(endpoints))return {ok:false,error:'Sélection non autorisée.'};
   if(job)return {ok:false,error:'Un téléchargement est déjà en cours.'};
   const items=normalizeBatch(endpoints),identities=items.map(item=>item.endpoint),requests=items.map(item=>item.request||item.endpoint);
   const rhythmVerseIds=items.filter(item=>item.rhythmVerseId).map(item=>item.rhythmVerseId);
   const rhythmVerseDownloads=rhythmVerseIds.length?rhythmVerseCatalogue?.authorizeDownloads(event,rhythmVerseIds):null;
   if(rhythmVerseIds.length&&!rhythmVerseDownloads)return {ok:false,error:'Une chart RhythmVerse sélectionnée n’est plus disponible. Relancez la recherche.'};
   const controller=new AbortController();job=controller;
   const completedFolders=[];
   let result,token,notificationScope;
   try{
    const account=await refreshAccount();if(!account.ok)throw Error('Le compte ne peut pas être vérifié. Réessayez.');
    controller.signal.throwIfAborted();if(!allowedSender(event))throw Error('La page a changé. Réessayez.');
    token=downloads.begin(identities,'batch');
    notificationScope=notificationBroker.capture();
    const directory=await chooseFolder('catalogue');
    if(!directory)return result={ok:false,cancelled:true,results:[]};
    controller.signal.throwIfAborted();
    if(!allowedSender(event)||rhythmVerseDownloads&&!rhythmVerseDownloads.current())throw Error('La page a changé. Réessayez.');
    const downloadRhythmVerse=rhythmVerseDownloads?async({id,directory,includeVideo,signal,progress})=>{
     if(!rhythmVerseDownloads.current())throw Error('La page a changé. Réessayez.');
     progress({percent:0,message:'Téléchargement et extraction RhythmVerse…'});
     try{
      const {installRhythmVerseChart}=require('./desktop/rhythmverse-install.cjs');
      const destination=await installRhythmVerseChart({record:rhythmVerseDownloads.get(id),directory,format:'folder',includeVideo,signal});
      return {folderName:path.basename(destination),destination,format:'folder'};
     }catch(error){throw Error(rhythmVerseDownloadError(error));}
    }:undefined;
    result=await downloadBatch({endpoints:requests,directory,includeVideo,fetcher:(url,options)=>ses.fetch(url,options),signal:controller.signal,progress:data=>reportProgress(token,data),onDownloaded:value=>completedFolders.push(value),reportDownloadCompletion,downloadRhythmVerse});
    await refreshAccount();
    if(!downloads.current(token))return {ok:false,cancelled:true,results:[]};
    for(const value of completedFolders)noteCompletedDownload(value.endpoint,value.result,event,token,controller.signal);
    return result;
   }catch(error){return result={ok:false,error:error.message,cancelled:controller.signal.aborted};}
   finally{downloads.finish(token,result);notificationBroker.finishNative(notificationScope,identities,result);job=null;if(win&&!win.isDestroyed())win.setProgressBar(-1);}
  });
  ipcMain.handle('chartshub:download',async(event,endpoint,includeVideo=true)=>{
   if(!allowedSender(event)||!endpointValid(endpoint)||typeof includeVideo!=='boolean')return {ok:false,error:'Demande non autorisée.'};
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
    const result=await downloadChart({endpoint,directory,includeVideo:endpoint.includes('/admin/')||includeVideo,fetcher:(url,options)=>ses.fetch(url,options),signal:controller.signal,progress:data=>reportProgress(token,{...data,endpoint,itemPercent:data.percent})});
    void reportDownloadCompletion(endpoint);
    await refreshAccount();if(!downloads.current(token))return outcome={ok:false,cancelled:true};
    noteCompletedDownload(endpoint,result,event,token,controller.signal);
    // Only a path produced by this download operation is passed to the OS.
    shell.showItemInFolder(result.destination);
    return outcome={ok:true,folderName:result.folderName,files:result.files};
   }catch(error){return outcome=controller.signal.aborted?{ok:false,cancelled:true}:{ok:false,error:error.message};}
   finally{downloads.finish(token,outcome);notificationBroker.finishNative(notificationScope,[endpoint],outcome);job=null;if(win&&!win.isDestroyed())win.setProgressBar(-1);}
  });
  ipcMain.handle('chartshub:download-enchor',async(event,payload)=>{
   if(!allowedSender(event))return {ok:false,error:'Demande non autorisée.'};
   let intent;try{intent=normalizeEnchorDownloadRequest(payload);}catch{return {ok:false,error:'Demande ChorusEncore invalide.'};}
   if(job)return {ok:false,error:'Un téléchargement est déjà en cours.'};
   const {request,format,includeVideo}=intent;
   const endpoint=enchorIdentity(request.md5),controller=new AbortController();job=controller;
   let outcome,token;
   try{
    const account=await refreshAccount();if(!account.ok)throw Error('Le compte ne peut pas être vérifié. Réessayez.');
    controller.signal.throwIfAborted();if(!allowedSender(event))throw Error('La page a changé. Réessayez.');
    token=downloads.begin([endpoint],'single');
    let directory,outputPath;
    if(format==='folder'){directory=await chooseFolder('catalogue');if(!directory)return outcome={ok:false,cancelled:true};}
    else{
     const choice=await dialog.showSaveDialog(win,{title:'Enregistrer la chart en '+format.toUpperCase(),defaultPath:path.join(app.getPath('downloads'),songFolderName(request)+'.'+format),filters:[{name:format.toUpperCase(),extensions:[format]}],properties:['showOverwriteConfirmation','createDirectory']});
     if(choice.canceled||!choice.filePath)return outcome={ok:false,cancelled:true};outputPath=choice.filePath;
    }
    controller.signal.throwIfAborted();
    if(!allowedSender(event))throw Error('La page a changé. Réessayez.');
    const result=await downloadEnchor({request,directory,outputPath,format,includeVideo,overwriteConfirmed:format!=='folder',fetcher:(url,options)=>ses.fetch(url,options),signal:controller.signal,progress:data=>reportProgress(token,{...data,endpoint,itemPercent:data.percent})});
    controller.signal.throwIfAborted();
    await refreshAccount();if(!downloads.current(token))return outcome={ok:false,cancelled:true};
    noteCompletedDownload(endpoint,result,event,token,controller.signal);
    shell.showItemInFolder(result.destination);
    return outcome={ok:true,folderName:result.folderName,fileName:result.fileName,files:result.files,format:result.format,output:format};
   }catch(error){return outcome=controller.signal.aborted?{ok:false,cancelled:true}:{ok:false,error:error.message};}
   finally{downloads.finish(token,outcome);job=null;if(win&&!win.isDestroyed())win.setProgressBar(-1);}
  });
  ipcMain.handle('chartshub:cancel',event=>{if(allowedSender(event))job?.abort();});
  const finishClose=async()=>{
   closing=true;
   rhythmVerseCatalogue?.dispose();
   if(rhythmVersePreload)ses.unregisterPreloadScript(rhythmVersePreload);
   notificationBroker?.invalidate();
   let shutdownSucceeded=true;
   try{if(companionHostPromise)await (await companionHostPromise).dispose();}
   catch(error){shutdownSucceeded=false;console.error('Companion shutdown:',error.message);}
   finally{
    try{await languagePreferences?.flush();await notificationBroker?.dispose();await desktop.dispose();}catch(error){shutdownSucceeded=false;console.error('Desktop shutdown:',error.message);}
    if(pendingUpdate){try{if(!shutdownSucceeded)throw Error('Normal shutdown failed');await updater.authorizeInstallation();}catch{await updater.cancelInstallation();}}
    if(pendingBackupId){
     try{if(!shutdownSucceeded)throw Error('Normal shutdown failed');await backupEngine.apply(pendingBackupId,{quiesced:true});}
     catch{dialog.showErrorBox('ChartsHub',companionLanguage==='fr'?'La restauration n’a pas pu être terminée. Les fichiers et leurs sauvegardes ont été conservés.':'The restore could not finish. Files and their backups have been preserved.');}
     app.relaunch();
    }
    paletteIpc?.dispose();maintenance?.dispose();updater?.dispose();allowClose=true;if(!win.isDestroyed())win.close();
   }
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
