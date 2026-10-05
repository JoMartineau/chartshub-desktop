'use strict';
// Actual desktop main/shell/preloads, isolated profile and synthetic catalogue/account.
// No real login, settings, charts, downloads or production requests.
const electron=require('electron'),{app,session}=electron;
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict');
const root=path.resolve(process.argv[2]||path.join(__dirname,'..'));
const output=path.resolve(process.argv[3]||'');if(!process.argv[3]||fs.existsSync(output))throw Error('Supply a new output directory.');
fs.mkdirSync(output,{recursive:true});app.setPath('userData',path.join(output,'profile'));app.disableHardwareAcceleration();
let desktop,host,user={id:'ordinary-member',emailVerified:false,staffRole:null},accountDelay=100,failure=false,finished=false;
const observations=[],errors=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
const fail=e=>{console.error(e.stack||e);fs.writeFileSync(path.join(output,'failure.txt'),e.stack||String(e));app.exit(1);};
process.on('unhandledRejection',fail);process.on('uncaughtException',fail);
function HiddenWindow(options){const w=new electron.BrowserWindow({...options,show:false});w.show=()=>{};w.showInactive=()=>{};w.focus=()=>{};return w;}
const originalLoad=Module._load;
Module._load=function(name,parent,isMain){const result=originalLoad.apply(this,arguments);if(!parent?.filename.startsWith(root))return result;
 if(name==='electron')return {...result,BrowserWindow:HiddenWindow};
 if(name==='./desktop/controller.cjs')return {...result,createDesktopShell(options){desktop=result.createDesktopShell(options);return desktop;}};
 if(name==='./companion/host.cjs')return {...result,async createCompanionHost(options){host=await result.createCompanionHost({...options,cloneHeroCandidates:[],cloneHeroProcessProbe:async()=>({running:false,startedAt:null}),catalogueClient:{load:async()=>({items:[],demo:false,warning:null,revision:'fixture'}),artwork:async()=>null}});return host;}};
 return result;
};
app.whenReady().then(()=>{
 const ses=session.fromPartition('persist:chartshub');
 ses.protocol.handle('https',async request=>{
  const url=new URL(request.url);if(url.origin!=='https://chartshub.ca')throw Error('Unexpected remote origin');
  if(url.pathname==='/api/auth/me'){const response=user;await delay(accountDelay);return failure?new Response('',{status:503}):Response.json({user:response});}
  const html=`<!doctype html><html lang="fr" data-theme="dark"><head><meta charset="utf-8"><style>:root{--blue:#00df24}body{margin:0;background:#090e19;color:white;font:16px system-ui}.theme-topbar{padding:12px;display:flex;gap:8px}main{padding:30px}a{color:inherit;display:inline-block;padding:16px}input{padding:12px}#spacer{height:1000px}</style></head><body><div class="theme-topbar"></div><main><a id="account-link" href="/account.html">Compte</a><a id="home-link" href="/">Catalogue</a><input id="draft" placeholder="Test sans compte réel"><h1>${url.pathname==='/account.html'?'Compte':'Catalogue'}</h1><div id="spacer"></div></main><script>window.addEventListener('DOMContentLoaded',()=>{if(location.pathname==='/account.html')setTimeout(()=>window.dispatchEvent(new Event('chartshub:accountchange')),20);});</script></body></html>`;
  return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8'}});
 });
});
electron.dialog.showErrorBox=(title,message)=>errors.push({title,message});electron.dialog.showMessageBox=async()=>({response:0});
require(path.join(root,'main.js'));
async function wait(fn,label){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await delay(25);}throw Error('Timed out: '+label);}
app.whenReady().then(async()=>{
 await wait(()=>desktop,'construction');await desktop.ready;
 const frame=desktop.window.webContents,web=desktop.catalogueView.webContents;
 const run=code=>frame.executeJavaScript(code),state=()=>run('window.chartsHubShell.getState()');
 await wait(async()=>!!(await state()).companionAvailable&&!web.isLoading(),'initial authenticated page');await delay(150);
 const initial=await run(`(()=>{window.navigationSamples=[];window.sampleTabs=()=>{const c=document.querySelector('#catalogue-tab'),p=document.querySelector('#companion-tab');return {catalogue:{x:c.getBoundingClientRect().x,width:c.getBoundingClientRect().width},companion:{hidden:p.hidden,disabled:p.disabled,x:p.getBoundingClientRect().x,width:p.getBoundingClientRect().width},theme:document.documentElement.style.getPropertyValue('--accent')};};window.chartsHubShell.onState(s=>window.navigationSamples.push({...window.sampleTabs(),available:s.companionAvailable,checking:s.companionChecking===true}));return window.sampleTabs();})()`);
 for(let iteration=0;iteration<3;iteration++){
  accountDelay=iteration===1?400:100;
  await web.executeJavaScript(`document.querySelector('#account-link').click();true`);
  await wait(async()=>web.getURL()==='https://chartshub.ca/account.html'&&!web.isLoading()&&(await state()).companionAvailable,'Account '+iteration);
  await delay(accountDelay+100);
  await web.executeJavaScript(`document.querySelector('#home-link').click();true`);
  await wait(async()=>web.getURL()==='https://chartshub.ca/'&&!web.isLoading()&&(await state()).companionAvailable,'Catalogue '+iteration);
 }
 const samples=await run('window.navigationSamples');fs.writeFileSync(path.join(output,'navigation.json'),JSON.stringify({initial,samples},null,2));
 const hidden=samples.filter(s=>s.companion.hidden),shift=samples.filter(s=>Math.abs(s.catalogue.width-initial.catalogue.width)>.5||Math.abs(s.companion.x-initial.companion.x)>.5||Math.abs(s.companion.width-initial.companion.width)>.5);
 console.log(JSON.stringify({samples:samples.length,hidden: hidden.length,shift:shift.length}));
 assert.equal(hidden.length,0,'Same-account navigation must never remove/reinsert the Companion tab.');
 assert.equal(shift.length,0,'Loading spinners must not change tab widths or positions.');
 observations.push('Six real document navigations keep both tabs visible and at fixed positions.');
 await run(`window.chartsHubShell.selectTab('companion')`);
 await wait(()=>host?.getPanelContents()&&!host.getPanelContents().isLoading(),'real Companion');
 await wait(async()=>(await state()).activeTab==='companion','Companion active');
 const companion=host.getPanelContents(),viewId=companion.id;
 await companion.executeJavaScript(`document.querySelector('#library-search').value='Conserver cette recherche';true`);
 await run(`window.chartsHubShell.selectTab('catalogue')`);await web.executeJavaScript(`document.querySelector('#account-link').click();true`);
 await wait(async()=>!web.isLoading()&&(await state()).companionAvailable,'return to account');
 await run(`window.chartsHubShell.selectTab('companion')`);await wait(async()=>(await state()).activeTab==='companion','Companion restored');
 assert.equal(host.getPanelContents().id,viewId);assert.equal(await companion.executeJavaScript(`document.querySelector('#library-search').value`),'Conserver cette recherche');
 observations.push('Navigation preserves the existing Companion and its unsaved search.');
 user=null;await web.executeJavaScript(`window.dispatchEvent(new Event('chartshub:accountchange'));true`);
 await wait(async()=>!(await state()).companionAvailable&&(await state()).activeTab==='catalogue','logout revocation');
 await wait(()=>run(`document.querySelector('#companion-tab').hidden`),'logout tab hidden');
 await run(`window.chartsHubShell.selectTab('companion')`);assert.equal((await state()).activeTab,'catalogue');
 assert.equal(host.getPanelContents().id,viewId);observations.push('Confirmed logout hides and blocks Companion without destroying its profile.');
 user={id:'ordinary-member',emailVerified:false,staffRole:null};await web.executeJavaScript(`window.dispatchEvent(new Event('chartshub:accountchange'));true`);
 await wait(async()=>(await state()).companionAvailable,'sign in again');failure=true;
 await web.executeJavaScript(`window.dispatchEvent(new Event('chartshub:accountchange'));true`);
 await wait(()=>run(`document.querySelector('#companion-tab').hidden`),'failed account check hides tab');
 assert.equal((await state()).companionAvailable,false);observations.push('Account verification failures still deny access.');
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({version:require(path.join(root,'package.json')).version,observations,samples:samples.length},null,2));
 finished=true;console.log('ACCOUNT_NAVIGATION_VERIFIED');desktop.window.close();
}).catch(fail);
setTimeout(()=>{if(!finished)fail(Error('Test timeout'));},60000).unref();
