'use strict';
// Actual main, shell, preloads and Companion, with a synthetic authenticated
// website. No live account, game write or download is used by this check.
const electron=require('electron'),{app,session}=electron;
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),Module=require('node:module');
const root=path.resolve(process.argv[2]||path.join(__dirname,'..'));
const directory=path.resolve(process.argv[3]||path.join(__dirname,'../../desktop-app-verification'));
fs.mkdirSync(directory,{recursive:true});
app.setPath('userData',path.join(directory,'profile'));
app.disableHardwareAcceleration();
if(process.env.CHARTSHUB_TEST_NO_SANDBOX==='1')app.commandLine.appendSwitch('no-sandbox');
let desktop,host,user=null,finished=false;
const passed=[],errors=[],buttonMotionRelays=[],editMenus=[],delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fail=error=>{console.error(error.stack||error);fs.writeFileSync(path.join(directory,'failure.txt'),String(error.stack||error));app.exit(1);};
process.on('unhandledRejection',fail);
process.on('uncaughtException',fail);
async function waitFor(check,label){const end=Date.now()+15000;while(Date.now()<end){if(await check()){console.log('Verified: '+label);return;}await delay(40);}throw Error('Timed out: '+label);}
app.on('web-contents-created',(_event,contents)=>{
 contents.on('preload-error',(_event,file,error)=>console.error('Preload error:',file,error.message));
 contents.on('console-message',details=>{if(details.level==='error')console.error('Renderer:',details.message);});
});
function HiddenWindow(options){
 const window=new electron.BrowserWindow({...options,show:false});
 window.show=()=>{};window.showInactive=()=>{};window.focus=()=>{};
 return window;
}
const originalLoad=Module._load;
Module._load=function(name,parent,isMain){
 const result=originalLoad.apply(this,arguments);
 if(!parent?.filename.startsWith(root))return result;
 if(name==='electron')return {...result,BrowserWindow:HiddenWindow,Menu:{
  setApplicationMenu:(...args)=>result.Menu.setApplicationMenu(...args),
  buildFromTemplate(template){
   const menu=result.Menu.buildFromTemplate(template),popup=menu.popup.bind(menu);
   menu.popup=options=>{if(template.some(item=>['Paste','Coller'].includes(item.label)))editMenus.push({menu,options});return popup(options);};
   return menu;
  }
 }};
 if(name==='./desktop/controller.cjs')return {...result,createDesktopShell(options){desktop=result.createDesktopShell(options);return desktop;}};
 if(name==='./companion/host.cjs')return {...result,async createCompanionHost(options){
  host=await result.createCompanionHost({...options,cloneHeroCandidates:[],cloneHeroProcessProbe:async()=>({running:false,startedAt:null}),catalogueClient:{load:async()=>({items:[],demo:false,warning:null,revision:'test'}),artwork:async()=>null}});
  const setButtonMotion=host.setButtonMotion;
  host.setButtonMotion=value=>{buttonMotionRelays.push({...value});return setButtonMotion.call(host,value);};
  return host;
 }};
 return result;
};
const page=`<!doctype html><html lang="fr" data-theme="dark"><head><meta charset="utf-8"><style>:root{--blue:#91d6c4}body{margin:0;background:#151719;color:#eef1f2;font:16px system-ui}.theme-topbar{padding:16px;display:flex;gap:12px}main{padding:36px}input{font:inherit;padding:12px;border-radius:8px;width:65%}button{font:inherit}</style></head><body><div class="theme-topbar"></div><main><h1>Catalogue de vérification</h1><p>Page locale de test de l’application intégrée.</p><input id="search" placeholder="Rechercher une chart"><div style="height:1200px"></div></main></body></html>`;
app.whenReady().then(()=>{
 const catalogue=session.fromPartition('persist:chartshub');
 catalogue.protocol.handle('https',request=>new URL(request.url).pathname==='/api/auth/me'
  ?Response.json({user}):new Response(page,{headers:{'Content-Type':'text/html; charset=utf-8'}}));
});
electron.dialog.showErrorBox=(title,message)=>{errors.push(title+': '+message);console.error('Native error:',title,message);};
electron.dialog.showMessageBox=async()=>({response:0});
require(path.join(root,'main.js'));

app.whenReady().then(async()=>{
 await waitFor(()=>desktop,'desktop construction');await desktop.ready;
 const frame=desktop.window.webContents,web=desktop.catalogueView.webContents;
 const branding=await frame.executeJavaScript(`(async()=>{const images=Array.from(document.querySelectorAll('.titlebar .brand-mark,.appnav .brand-mark'));await Promise.all(images.map(image=>image.decode()));return {title:document.title,names:Array.from(document.querySelectorAll('.brand-name'),node=>node.textContent),images:images.map(image=>({width:image.naturalWidth,height:image.naturalHeight,path:new URL(image.currentSrc).pathname.split('/').pop(),renderedHeight:image.getBoundingClientRect().height}))}})()`);
 assert.equal(branding.title,'ChartsHub.ca');assert.equal(desktop.window.getTitle(),'ChartsHub.ca');assert.deepEqual(branding.names,['ChartsHub.ca','ChartsHub.ca']);assert.equal(branding.images.length,2);assert.ok(branding.images.every(image=>image.path==='icon.png'&&image.width>0&&image.height>0));assert.deepEqual(branding.images.map(image=>image.renderedHeight),[18,37]);
 passed.push('title bar and header load the bundled ChartsHub logo and website name');
 const state=()=>frame.executeJavaScript('window.chartsHubShell.getState()');
 const select=tab=>frame.executeJavaScript(`window.chartsHubShell.selectTab(${JSON.stringify(tab)})`);
 await waitFor(()=>web.getURL()==='https://chartshub.ca/'&&!web.isLoading(),'catalogue load');
 await waitFor(()=>web.executeJavaScript('Boolean(window.ChartsHubDesktop)'),'catalogue preload');
 assert.equal((await state()).companionAvailable,false);
 await select('companion');assert.equal(host,undefined);assert.equal((await state()).activeTab,'catalogue');
 assert.equal(await frame.executeJavaScript('document.querySelector("#companion-tab").hidden'),true);
 passed.push('guest sees only Catalogue and cannot open Companion');
 user={id:'ordinary-member',emailVerified:false,staffRole:null};
 await web.executeJavaScript('window.dispatchEvent(new Event("chartshub:accountchange"))');
 await waitFor(async()=>(await state()).companionAvailable,'ordinary member authorisation');
 await waitFor(()=>frame.executeJavaScript('!document.querySelector("#companion-tab").hidden'),'member tab visible');
 assert.equal(await web.executeJavaScript('window.ChartsHubDesktop.version'),require(path.join(root,'package.json')).version);
 assert.equal(await web.executeJavaScript('document.querySelectorAll("[style*=drag]").length'),0,'only the shell creates the title bar');
 const {verifyNativeEditContextMenu}=require('./edit-context-menu-electron.cjs');
 let editingWindowState=null;
 async function verifyEditInput(contents,selector){
  // Windows may discard trusted context-menu input for a hidden HWND. Show
  // only this isolated fixture off screen, without relying on HiddenWindow's
  // intentionally neutralized show/focus methods. Keep it rendering until
  // closing: hiding midway can suspend native dialog-close animation frames.
  const window=desktop.window;
  if(!editingWindowState)editingWindowState={bounds:window.getBounds(),visible:window.isVisible()};
  window.setBounds({...editingWindowState.bounds,x:-20000,y:-20000});
  electron.BrowserWindow.prototype.showInactive.call(window);
  electron.BrowserWindow.prototype.focus.call(window);
  await delay(100);
  await verifyNativeEditContextMenu({contents,ownerWindow:window,selector,menus:editMenus,clipboard:electron.clipboard,waitFor,delay});
 }
 await verifyEditInput(web,'#search');
 await web.executeJavaScript('document.querySelector("#search").value="Valeur conservée";window.scrollTo({top:200,behavior:"instant"});true');
 const scroll=await web.executeJavaScript('scrollY');
 await select('companion');
 await waitFor(()=>host?.getPanelContents()&&!host.getPanelContents().isLoading(),'Companion renderer');
 await waitFor(async()=>(await state()).activeTab==='companion','Companion selected');
 const local=host.getPanelContents(),id=local.id;
 // Chromium queues native dialog close events with animation frames. Keep the
 // hidden shell and Companion view rendering so those events reach real handlers.
 desktop.window.webContents.setBackgroundThrottling(false);
 local.setBackgroundThrottling(false);
 assert.equal(host.getPanel(),desktop.window);
 assert.equal(electron.BrowserWindow.getAllWindows().length,1,'one main window');
 assert.equal(await local.executeJavaScript('typeof window.ChartsHubDesktop'),'undefined');
 assert.equal(await local.executeJavaScript('typeof window.ChartsHubCompanion'),'object');
 assert.equal(await web.executeJavaScript('typeof window.ChartsHubCompanion'),'undefined');
 assert.equal(await frame.executeJavaScript('typeof window.ChartsHubCompanion'),'undefined');
 assert.equal(await frame.executeJavaScript('typeof window.ChartsHubDesktop'),'undefined');
 passed.push('ordinary account opens the real local Companion in the existing window with isolated preloads');
 // Wait for the native controls and their initial snapshot before positioning a
 // right-click in the full tab view.
 await waitFor(()=>local.executeJavaScript('Boolean(window.ChartshubBloom && document.querySelector("#ch-bloom-open") && !document.querySelector("#ch-bloom-open").disabled)'),'native bloom module ready');
 await verifyEditInput(local,'#catalogue-query');
 passed.push('real right-click menus copy and paste into Companion and remote Catalogue search views');
 fs.writeFileSync(path.join(directory,'edit-menu-verification.json'),JSON.stringify({version:require(path.join(root,'package.json')).version,ok:true,fixtureOnly:true,sourceFields:['#search','#catalogue-query'],nativePopups:editMenus.length,realChromiumContextEvents:true,clipboardContainsOnlyFixtureText:true},null,2));
 // Exercise the actual native preload, ESM/CSP, disk store and saved-state restore.
 const {verifyButtonMotion}=require('./button-motion-electron.cjs');
 for(const [contents,selector] of [[frame,'#catalogue-tab'],[local,'#ch-bloom-open']]) assert.equal((await verifyButtonMotion(contents,selector)).length,13);
 passed.push('real shell and Companion buttons respect hover, press, disabled, economy and OS motion preferences');
 const stored=path.join(app.getPath('userData'),'companion','ui-bloom.json');
 if(process.env.CHARTSHUB_VERIFY_BLOOM_RESTART==='1'){
  assert.equal(await local.executeJavaScript('window.ChartshubBloom.read().color'),'#ff8000');
  assert.equal(await local.executeJavaScript('window.ChartshubBloom.read().enabled'),true);
  passed.push('a second real Electron process restores persisted native bloom');
 }
 await local.executeJavaScript('window.ChartshubBloom.open(); true');
 await waitFor(()=>local.executeJavaScript('document.querySelector("#ch-bloom-dialog").open && !document.querySelector("#ch-bloom-apply").disabled'),'bloom dialogue ready');
 assert.equal(await local.executeJavaScript(`(()=>{
  const app=document.querySelector('#companion-app'),dialog=document.querySelector('#ch-bloom-dialog'),form=document.querySelector('.ch-bloom-form');
  return app.contains(dialog)&&['theme-panel','theme-catalogue-appearance','theme-filters-appearance','theme-player-appearance','local-player-appearance'].every(id=>dialog.contains(document.getElementById(id))&&!form.contains(document.getElementById(id)))&&document.querySelectorAll('form form').length===0&&!document.querySelector('.app-header .brand');
 })()`),true,'all appearance sections retain their controller root and separate save forms');
 await local.executeJavaScript(`document.querySelector('#theme-catalogue-appearance').open=true;document.querySelector('#floating-panels-opacity').value='57';document.querySelector('#floating-panels-opacity').dispatchEvent(new Event('input'));void 0`);
 assert.equal(await local.executeJavaScript(`document.querySelector('#floating-panels-preview').style.getPropertyValue('--floating-background')`),'#15171991','centralized catalogue preview remains local');
 await local.executeJavaScript("document.querySelector('#ch-bloom-hover').value='5';document.querySelector('#ch-bloom-hover').dispatchEvent(new Event('change'));void 0");
 assert.equal(await local.executeJavaScript("document.documentElement.style.getPropertyValue('--ch-motion-hover-lift')"),'5px','hover draft previews in Companion');
 await local.executeJavaScript('document.querySelector("#ch-bloom-enabled").checked=true;document.querySelector("#ch-bloom-enabled").dispatchEvent(new Event("change"));document.querySelector("#ch-bloom-hex").value="#ff8000";document.querySelector("#ch-bloom-hex").dispatchEvent(new Event("input"));document.querySelector(".ch-bloom-form").requestSubmit();true');
 await waitFor(()=>local.executeJavaScript('window.ChartshubBloom.read().enabled && window.ChartshubBloom.read().color==="#ff8000" && !document.querySelector("#ch-bloom-apply").disabled'),'native bloom saved');
 assert.equal(JSON.parse(fs.readFileSync(stored,'utf8')).color,'#ff8000');
 assert.equal(JSON.parse(fs.readFileSync(stored,'utf8')).hoverLift,5);
 await waitFor(async()=>await frame.executeJavaScript("document.documentElement.style.getPropertyValue('--ch-motion-hover-lift')==='5px'")&&host.snapshot().buttonMotion?.hoverLift===5,'saved hover reaches shell and Companion host');
 await host.setCatalogueWidget(true);await host.setFiltersWidget(true);
 assert.equal((await local.executeJavaScript("window.ChartsHubCompanion.command('capture.player',{})")).ok,true);
 const motionWidgets=[[host.getCatalogueWidget(),'#catalogue-widget-close'],[host.getFiltersWidget(),'#filters-widget-close'],[host.getPlayerWidget(),'#local-player-widget']];
 for(const [widget,close] of motionWidgets){
  assert.ok(widget&&!widget.isDestroyed(),'all three native widgets exist');
  widget.webContents.setBackgroundThrottling(false);
  await waitFor(()=>widget.webContents.executeJavaScript("document.documentElement.style.getPropertyValue('--ch-motion-hover-lift')==='5px'"),'widget receives saved hover');
  assert.equal(await widget.webContents.executeJavaScript(`getComputedStyle(document.querySelector(${JSON.stringify(close)})).webkitAppRegion`),'no-drag','window close keeps its native hit region');
 }
 passed.push('chosen hover level persists and reaches Catalogue, Filters and Songs player through existing snapshots');
 await host.setCatalogueWidget(false);await host.setFiltersWidget(false);
 assert.equal((await local.executeJavaScript("window.ChartsHubCompanion.command('player.widget',{enabled:false})")).ok,true);
 assert.equal(await local.executeJavaScript(`['.preview-card','.settings-card','.destinations-card'].every(selector=>getComputedStyle(document.querySelector(selector)).boxShadow!=='none')&&getComputedStyle(document.querySelector('#game-preview')).boxShadow==='none'`),true,'interface bloom includes the three nested cards without affecting the overlay surface');
 await local.executeJavaScript(`document.querySelector('#theme-interface-appearance').open=false;document.querySelector('#theme-panel').open=false;document.querySelector('#theme-catalogue-appearance').open=false;document.querySelector('#theme-player-appearance').open=true;document.querySelector('#local-player-appearance').open=true;document.querySelector('#ch-bloom-dialog').scrollTop=0;void 0`);
 await delay(100);fs.writeFileSync(path.join(directory,'theme-colors-player.png'),(await desktop.window.capturePage()).toPNG());
 const bytes=fs.readFileSync(stored),relaysBeforeCancel=buttonMotionRelays.length;
 await local.executeJavaScript('document.querySelector("#ch-bloom-hex").value="#00ffff";document.querySelector("#ch-bloom-hex").dispatchEvent(new Event("input"));document.querySelector("#ch-bloom-hover").value="1";document.querySelector("#ch-bloom-hover").dispatchEvent(new Event("change"));document.querySelector("#ch-bloom-cancel").click();true');
 // Native dialog.close() clears open before its queued close handler repaints
 // the saved appearance. Verify that real restoration, not merely the flag.
 await waitFor(()=>local.executeJavaScript('!document.querySelector("#ch-bloom-dialog").open && document.documentElement.style.getPropertyValue("--ch-motion-hover-lift")==="5px"'),'bloom cancellation restores saved hover');
 assert.equal(await local.executeJavaScript("document.documentElement.style.getPropertyValue('--ch-motion-hover-lift')"),'5px','Cancel restores saved hover');
 assert.ok(fs.readFileSync(stored).equals(bytes),'Cancel does not persist the preview');
 assert.equal(buttonMotionRelays.length,relaysBeforeCancel,'preview and Cancel never relay a draft to the native host');
 assert.equal(host.snapshot().buttonMotion.hoverLift,5,'the host retains the saved hover');
 assert.equal(await frame.executeJavaScript("document.documentElement.style.getPropertyValue('--ch-motion-hover-lift')"),'5px','the shell retains the saved hover');
 assert.equal(await local.executeJavaScript('window.ChartshubBloom.read().color'),'#ff8000');
 // A close notification from the preceding modal may arrive after it reopened.
 // Deliver that notification against the real controls and native saved state.
 await local.executeJavaScript('window.ChartshubBloom.open(); true');
 await waitFor(()=>local.executeJavaScript('document.querySelector("#ch-bloom-dialog").open && !document.querySelector("#ch-bloom-apply").disabled'),'reopened theme ready');
 assert.deepEqual(await local.executeJavaScript(`(()=>{
  document.querySelector('#theme-interface-appearance').open=true;
  const dialog=document.querySelector('#ch-bloom-dialog'),hex=document.querySelector('#ch-bloom-hex');
  hex.value='#00ffff';hex.dispatchEvent(new Event('input'));hex.focus();
  const focusBefore=document.activeElement===hex;
  const before=document.documentElement.style.getPropertyValue('--ch-bloom-shadow');
  dialog.dispatchEvent(new Event('close'));
  return {open:dialog.open,value:hex.value,previewRetained:document.documentElement.style.getPropertyValue('--ch-bloom-shadow')===before,focusBefore,focusRetained:document.activeElement===hex,saved:window.ChartshubBloom.read().color};
 })()`),{open:true,value:'#00ffff',previewRetained:true,focusBefore:true,focusRetained:true,saved:'#ff8000'});
 assert.ok(fs.readFileSync(stored).equals(bytes),'a stale close does not persist a new preview');
 await local.executeJavaScript('document.querySelector("#ch-bloom-cancel").click(); true');
 await waitFor(()=>local.executeJavaScript('!document.querySelector("#ch-bloom-dialog").open && document.documentElement.style.getPropertyValue("--ch-bloom-shadow").includes("255, 128, 0")'),'normal close restores the saved theme').catch(async error=>{
  const diagnostic=await local.executeJavaScript(`({open:document.querySelector('#ch-bloom-dialog').open,shadow:document.documentElement.style.getPropertyValue('--ch-bloom-shadow'),activeElement:document.activeElement?.id||document.activeElement?.tagName||null})`);
  throw new Error(error.message+'; dialog state: '+JSON.stringify(diagnostic),{cause:error});
 });
 local.reload();
 await waitFor(()=>!local.isLoading(),'Companion reload');
 await waitFor(()=>local.executeJavaScript('Boolean(window.ChartshubBloom && window.ChartshubBloom.read().enabled && window.ChartshubBloom.read().color==="#ff8000")'),'reload restores native bloom');
 assert.equal(await local.executeJavaScript("window.ChartshubBloom.read().hoverLift"),5,'reload restores saved hover');
 passed.push('centralized appearance sections remain independent; native bloom covers nested cards, saves and cancels with real disk IO and survives renderer reload');

 await local.executeJavaScript('document.querySelector("#library-search").value="Recherche conservée";window.scrollTo({top:180,behavior:"instant"});true');
 const localScroll=await local.executeJavaScript('scrollY');
 await select('catalogue');
 assert.equal(await web.executeJavaScript('document.querySelector("#search").value'),'Valeur conservée');
 assert.equal(await web.executeJavaScript('scrollY'),scroll);
 await select('companion');
 assert.equal(host.getPanelContents().id,id);
 assert.equal(await local.executeJavaScript('document.querySelector("#library-search").value'),'Recherche conservée');
 assert.equal(await local.executeJavaScript('scrollY'),localScroll);
 passed.push('switching tabs preserves both renderers, input values and scroll positions');
 await local.executeJavaScript('window.scrollTo({top:0,behavior:"instant"});true');
 await delay(150);
 fs.writeFileSync(path.join(directory,'companion.png'),(await desktop.window.capturePage()).toPNG());
 user=null;await web.executeJavaScript('window.dispatchEvent(new Event("chartshub:accountchange"))');
 await waitFor(async()=>!(await state()).companionAvailable&&(await state()).activeTab==='catalogue','logout hides Companion');
 assert.equal(host.getPanelContents().id,id,'logout hides the local tab without losing settings');
 await select('companion');assert.equal((await state()).activeTab,'catalogue');
 passed.push('logout immediately hides and blocks Companion');
 assert.deepEqual(errors,[]);
 desktop.window.once('closed',()=>{
  try{assert.deepEqual(errors,[]);assert.equal(local.isDestroyed(),true);assert.equal(web.isDestroyed(),true);passed.push('closing the app disposes both renderers after Companion persistence');finished=true;fs.writeFileSync(path.join(directory,'verification.json'),JSON.stringify({version:require(path.join(root,'package.json')).version,passed},null,2));console.log(JSON.stringify({passed}));}catch(error){fail(error);}
 });
 if(editingWindowState){if(!editingWindowState.visible)desktop.window.hide();desktop.window.setBounds(editingWindowState.bounds);}
 desktop.window.close();
}).catch(fail);
setTimeout(()=>{if(!finished)fail(Error('Application integration verification timeout'));},45000).unref();
