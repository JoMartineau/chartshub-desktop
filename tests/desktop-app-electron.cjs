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
const passed=[],errors=[],delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
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
 if(name==='electron')return {...result,BrowserWindow:HiddenWindow};
 if(name==='./desktop/controller.cjs')return {...result,createDesktopShell(options){desktop=result.createDesktopShell(options);return desktop;}};
 if(name==='./companion/host.cjs')return {...result,async createCompanionHost(options){
  host=await result.createCompanionHost({...options,cloneHeroCandidates:[],cloneHeroProcessProbe:async()=>({running:false,startedAt:null}),catalogueClient:{load:async()=>({items:[],demo:false,warning:null,revision:'test'}),artwork:async()=>null}});return host;
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
 assert.equal(await web.executeJavaScript('window.ChartsHubDesktop.version'),'0.14.0');
 assert.equal(await web.executeJavaScript('document.querySelectorAll("[style*=drag]").length'),0,'only the shell creates the title bar');
 await web.executeJavaScript('document.querySelector("#search").value="Valeur conservée";window.scrollTo(0,200)');
 const scroll=await web.executeJavaScript('scrollY');
 await select('companion');
 await waitFor(()=>host?.getPanelContents()&&!host.getPanelContents().isLoading(),'Companion renderer');
 await waitFor(async()=>(await state()).activeTab==='companion','Companion selected');
 const local=host.getPanelContents(),id=local.id;
 assert.equal(host.getPanel(),desktop.window);
 assert.equal(electron.BrowserWindow.getAllWindows().length,1,'one main window');
 assert.equal(await local.executeJavaScript('typeof window.ChartsHubDesktop'),'undefined');
 assert.equal(await local.executeJavaScript('typeof window.ChartsHubCompanion'),'object');
 assert.equal(await web.executeJavaScript('typeof window.ChartsHubCompanion'),'undefined');
 assert.equal(await frame.executeJavaScript('typeof window.ChartsHubCompanion'),'undefined');
 assert.equal(await frame.executeJavaScript('typeof window.ChartsHubDesktop'),'undefined');
 passed.push('ordinary account opens the real local Companion in the existing window with isolated preloads');
 await local.executeJavaScript('document.querySelector("#library-search").value="Recherche conservée";window.scrollTo(0,180)');
 const localScroll=await local.executeJavaScript('scrollY');
 await select('catalogue');
 assert.equal(await web.executeJavaScript('document.querySelector("#search").value'),'Valeur conservée');
 assert.equal(await web.executeJavaScript('scrollY'),scroll);
 await select('companion');
 assert.equal(host.getPanelContents().id,id);
 assert.equal(await local.executeJavaScript('document.querySelector("#library-search").value'),'Recherche conservée');
 assert.equal(await local.executeJavaScript('scrollY'),localScroll);
 passed.push('switching tabs preserves both renderers, input values and scroll positions');
 await local.executeJavaScript('window.scrollTo(0,0)');
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
 desktop.window.close();
}).catch(fail);
setTimeout(()=>{if(!finished)fail(Error('Application integration verification timeout'));},45000).unref();
