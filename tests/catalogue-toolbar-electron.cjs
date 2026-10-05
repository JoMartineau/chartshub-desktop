'use strict';
// Real Electron shell/preload and website CSS/settings, with synthetic local content.
// Usage: electron tests/catalogue-toolbar-electron.cjs <site-sources> <new-output-directory>
// No production account, network request, game service or installed-app profile is used.
const electron=require('electron'),{app,BrowserWindow,ipcMain,session}=electron;
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Module,createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),site=path.resolve(process.argv[2]||'');
const output=path.resolve(process.argv[3]||'');
if(!process.argv[2]||!process.argv[3]||fs.existsSync(output))throw Error('Supply website sources and a NEW isolated output directory.');
fs.mkdirSync(output,{recursive:true});app.setPath('userData',path.join(output,'profile'));
app.disableHardwareAcceleration();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const errors=[],passed=[],measurements=[];let shell,finished=false;
const fail=error=>{console.error(error.stack||error);fs.writeFileSync(path.join(output,'failure.txt'),String(error.stack||error));app.exit(1);};
process.on('unhandledRejection',fail);process.on('uncaughtException',fail);
const timeout=setTimeout(()=>fail(Error('Toolbar validation timed out')),60000);timeout.unref();
const original=fs.readFileSync(path.join(site,'index.html'),'utf8');
const hero=original.match(/<section class="hero"[\s\S]*?<\/section>/)?.[0];assert.ok(hero);
const links=['Catalogue','Découverte et outils','Classement','Mon Hub','Messages','Soumissions et suivi','Modération','Administration','Compte'];
const page=`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/account-status.css"><script src="/settings.js" defer></script></head><body><div class="site-shell"><header class="topbar" data-shared-navigation-header><a class="brand" href="#top"><img src="/assets/icon.svg" width="37" height="37" class="brand-mark" alt=""><span>Charts<span class="brand-accent">Hub</span><span class="brand-domain">.ca</span></span></a><nav class="topnav">${links.map((name,i)=>`<a class="nav-link${i?'':' active'}" href="#top">${name}</a>`).join('')}</nav><div class="top-actions"><button class="button button-ghost" type="button">Notifications</button><select aria-label="Langue"><option>FR</option></select><button class="menu-toggle" type="button" aria-label="Ouvrir le menu"><span></span><span></span><span></span></button></div></header><main id="top">${hero}<section class="content"><h2>Catalogue de vérification locale</h2>${'<p>Contenu de test pour vérifier le défilement.</p>'.repeat(45)}</section></main></div></body></html>`;
const CSP="default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://static.enchor.us; media-src 'self' blob:; connect-src 'self' https://challenges.cloudflare.com https://static.enchor.us; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const allowed=new Set(['styles.css','account-status.css','settings.js','assets/ui-bloom.js','assets/ui-bloom.css','assets/icon.svg']);
const mime={'.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml'};
let baseline=false;
async function configure(partition){
 const ses=session.fromPartition(partition);
 ses.setPermissionRequestHandler((_web,_permission,callback)=>callback(false));
 await ses.protocol.handle('https',request=>{
  const u=new URL(request.url);
  if(u.hostname==='fonts.googleapis.com')return new Response('',{headers:{'Content-Type':'text/css'}});
  if(u.origin!=='https://chartshub.ca')return new Response('No network in test',{status:403});
  if(u.pathname==='/api/auth/me')return Response.json({user:{id:'toolbar-fixture',username:'CompteDeTest',emailVerified:true,staffRole:'administrator',preferences:{theme:'dark',accent:'green',language:'fr'}}});
  if(u.pathname==='/api/desktop-release')return Response.json({available:false});
  if(u.pathname==='/'||u.pathname==='/index.html')return new Response(page,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':CSP}});
  const relative=u.pathname.slice(1);
  if(!allowed.has(relative))return new Response('Not found',{status:404});
  let bytes=fs.readFileSync(path.join(site,relative));
  if(baseline&&relative==='account-status.css')bytes=Buffer.from(bytes.toString().replace('html[data-desktop-app="true"][data-desktop-layout="tabbed"]:not([data-desktop-guest-view="true"]) .theme-topbar{top:0}',''));
  return new Response(bytes,{headers:{'Content-Type':mime[path.extname(relative)]||'text/plain'}});
 });
 await ses.protocol.handle('http',()=>new Response('No HTTP network in test',{status:403}));
 return ses;
}
async function waitFor(check,label){const end=Date.now()+8000;while(Date.now()<end){if(await check())return;await delay(30);}throw Error('Timed out: '+label);}
async function ready(web){
 await waitFor(()=>web.executeJavaScript("!!document.querySelector('#ch-bloom-open') && !!document.querySelector('#active-account-link') && document.querySelector('#active-account-link').textContent.includes('CompteDeTest')"),'website controls');
 await delay(100);
}
const bounds=web=>web.executeJavaScript(`(()=>{const bar=document.querySelector('.theme-topbar'),header=document.querySelector('.topbar'),brand=header.querySelector('.brand');const b=bar.getBoundingClientRect(),h=header.getBoundingClientRect(),r=brand.getBoundingClientRect();return {barTop:b.top,barBottom:b.bottom,barHeight:b.height,headerTop:h.top,brandTop:r.top,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,layout:document.documentElement.dataset.desktopLayout,theme:document.documentElement.dataset.theme};})()`);
function checkTop(data,expected=0){assert.equal(Math.round(data.barTop),expected);assert.ok(data.headerTop>=data.barBottom-1,'utility bar must not cover the site header');assert.ok(data.brandTop>=data.barBottom-1,'logo must not be covered');assert.equal(data.overflow,false);}
function watch(web){web.on('preload-error',(_event,_file,error)=>errors.push(error.message));web.on('console-message',details=>{if(details.level==='error')errors.push(details.message);});}
app.whenReady().then(async()=>{
 const ses=await configure('toolbar-tabbed');
 // Load the real controller, suppressing only window visibility during the test.
 const controller=path.join(root,'desktop/controller.cjs'),loaded=new Module(controller,module),normal=createRequire(controller);
 loaded.filename=controller;loaded.paths=Module._nodeModulePaths(path.dirname(controller));
 loaded.require=name=>name==='electron'?{...electron,BrowserWindow:class extends BrowserWindow{constructor(options){super({...options,show:false});}}}:normal(name);
 loaded._compile(fs.readFileSync(controller,'utf8'),controller);
 shell=loaded.exports.createDesktopShell({cataloguePreferences:{session:ses,preload:path.join(root,'preload.js'),additionalArguments:['--chartshub-tabbed'],contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false}});
 await shell.ready;const web=shell.catalogueView.webContents;watch(web);
 const {windowTheme}=require('../window-theme.js');
 ipcMain.handle('chartshub:theme',(_event,value)=>{const theme=windowTheme(value);if(theme)shell.setTheme(theme);return theme;});
 ipcMain.handle('chartshub:folder',()=>({ok:true,folderName:'Dossier de test'}));
 ipcMain.handle('chartshub:download-state',()=>({revision:0,operation:null,items:[]}));
 ipcMain.handle('chartshub:fullscreen',()=>false);
 ipcMain.handle('chartshub:account-changed',()=>null);
 shell.window.setContentSize(1400,950);
 baseline=true;await web.loadURL('https://chartshub.ca/');await ready(web);
 const before=await bounds(web);assert.equal(Math.round(before.barTop),36);assert.ok(before.headerTop<before.barBottom);measurements.push({mode:'before',...before});
 fs.writeFileSync(path.join(output,'before.png'),(await shell.window.capturePage()).toPNG());
 baseline=false;await web.loadURL('https://chartshub.ca/');await ready(web);await delay(150);
 for(const width of [1400,1024,720]){
  console.log("CHECK WIDTH",width);
  shell.window.setContentSize(width,950);await web.executeJavaScript('scrollTo({top:0,left:0,behavior:"instant"}); true');await delay(150);
  const data=await bounds(web);checkTop(data);assert.equal(data.layout,'tabbed');assert.equal(data.theme,'dark');
  assert.equal(shell.catalogueView.getBounds().y,108,'native shell must retain ownership of tab height');
  measurements.push({mode:'tabbed',...data});passed.push('tabbed '+width+'px: no extra gap, overlap or horizontal overflow');
  if(width===1400)fs.writeFileSync(path.join(output,'after.png'),(await shell.window.capturePage()).toPNG());
  await web.executeJavaScript('scrollTo({top:400,left:0,behavior:"instant"}); true');await delay(80);assert.equal(Math.round((await bounds(web)).barTop),0);
 }
 shell.window.setContentSize(1400,950);await web.executeJavaScript('scrollTo({top:0,left:0,behavior:"instant"}); true');web.setZoomFactor(1.25);await delay(150);checkTop(await bounds(web));web.setZoomFactor(1);passed.push('125% zoom keeps the toolbar in flow');
 console.log("CHECK FULLSCREEN");shell.window.setFullScreen(true);await delay(350);await web.executeJavaScript('scrollTo({top:0,left:0,behavior:"instant"}); true');checkTop(await bounds(web));shell.window.setFullScreen(false);await delay(200);passed.push('fullscreen retains correct catalogue-relative position');
 // Released client fallback: same native preload with only new metadata removed.
 const oldPreload=path.join(output,'released-preload.cjs');fs.writeFileSync(oldPreload,fs.readFileSync(path.join(root,'preload.js'),'utf8').replace("  layout:tabbed?'tabbed':'legacy',",'').replace(/version:'[0-9.]+',/,"version:'0.14.0',"));
 for(const mode of ['released-tabbed','legacy','browser']){
  console.log('CHECK MODE',mode);
  const local=await configure('toolbar-'+mode);
  const win=new BrowserWindow({width:1400,height:950,show:false,webPreferences:{session:local,...(mode==='browser'?{}:{preload:mode==='released-tabbed'?oldPreload:path.join(root,'preload.js'),additionalArguments:mode==='released-tabbed'?['--chartshub-tabbed']:[]}),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false}});
  watch(win.webContents);await win.loadURL('https://chartshub.ca/');await ready(win.webContents);
  const data=await bounds(win.webContents);checkTop(data,mode==='legacy'?36:0);measurements.push({mode,...data});
  passed.push(mode+': expected offset without logo overlap');win.destroy();
 }
 assert.deepEqual(errors,[]);await shell.dispose();shell.window.destroy();finished=true;clearTimeout(timeout);
 const result={passed,measurements,errors,scope:'Real Electron shell/preload + website styles/settings; synthetic account/content, no production network.'};
 fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));app.exit(0);
}).catch(fail);
