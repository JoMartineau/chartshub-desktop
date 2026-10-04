'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {applicationMenu}=require('../app-menu');
test('local application menu opens immediately while administrator authorization is pending',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),match=source.match(/ipcMain\.handle\('chartshub:menu',(async[\s\S]*?)\n  \}\);/);assert.ok(match);let opened=0,checks=0;
 const c={allowedSender:()=>true,refreshAdministrator:()=>{checks++;return new Promise(()=>{});},adminAllowed:false,companionAvailable:false,web:{},Menu:{buildFromTemplate:options=>({popup(){opened++;assert.equal(options.visitorPreview,undefined);assert.equal(options.companion,undefined);assert.equal(options.web,c.web);}})},applicationMenu:options=>options,win:{webContents:{},close(){},setFullScreen(){},isFullScreen(){return false;}},load(){},job:null,openGuest(){},showCompanion(){}};vm.createContext(c);vm.runInContext('handler='+match[1]+'\n}',c);await c.handler({},'en');assert.equal(opened,1);assert.equal(checks,1);
 c.allowedSender=()=>false;await c.handler({},'en');assert.equal(opened,1,'untrusted IPC never opens the application menu');
});

test('native menu offers Companion to ordinary signed-in accounts independently of administrator preview',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),match=source.match(/ipcMain\.handle\('chartshub:menu',(async[\s\S]*?)\n  \}\);/);assert.ok(match);
 let menu,opened=0,reloaded=0;
 const c={allowedSender:()=>true,refreshAdministrator:()=>new Promise(()=>{}),adminAllowed:false,companionAvailable:true,
  Menu:{buildFromTemplate:template=>({popup({window}){assert.equal(window,c.win);menu=template;}})},applicationMenu,
  web:{reload(){reloaded++;},getZoomLevel:()=>0,setZoomLevel(){}},
  win:{webContents:{reload(){assert.fail('the menu must target the catalogue view, not the shell renderer');}},close(){},setFullScreen(){},isFullScreen:()=>false},
  load(){},job:null,openGuest(){},showCompanion(){opened++;}};
 vm.createContext(c);vm.runInContext('handler='+match[1]+'\n}',c);
 await c.handler({},'en');
 const companion=menu.find(item=>item.label==='Clone Hero Companion');
 assert.ok(companion,'a signed-in ordinary account does not need administrator privileges');
 assert.equal(menu.some(item=>item.label==='View as guest'),false);
 companion.click();assert.equal(opened,1);
 menu.find(item=>item.label==='Reload').click();assert.equal(reloaded,1,'reload acts on the separate catalogue webContents');
 c.companionAvailable=false;await c.handler({},'en');
 assert.equal(menu.some(item=>item.label==='Clone Hero Companion'),false,'a guest has no Companion menu action');
 c.adminAllowed=true;await c.handler({},'en');
 assert.equal(menu.some(item=>item.label==='Clone Hero Companion'),false,'cached administrator authorization cannot replace current Companion availability');
 assert.equal(menu.some(item=>item.label==='View as guest'),true);
 c.companionAvailable=true;await c.handler({},'fr');
 assert.ok(menu.find(item=>item.label==='Clone Hero Companion'));
 assert.ok(menu.find(item=>item.label==='Voir comme visiteur'));
});
test('native guest exposes only a return action and reserves the measured banner height',()=>{
 let ready,exposed,resize;const calls=[],styles=new Map();
 const make=()=>({style:{},children:[],events:{},append(...nodes){this.children.push(...nodes);},addEventListener(name,fn){this.events[name]=fn;},getBoundingClientRect:()=>({height:79.2})});
 const document={documentElement:{lang:'fr',style:{setProperty:(key,value)=>styles.set(key,value)}},body:{prepend(){}},createElement:make};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../guest-preload.js'),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(name,value)=>{exposed={name,value};}},ipcRenderer:{invoke:channel=>calls.push(channel)}}),process:{isMainFrame:true},location:{origin:'https://chartshub.ca'},window:{addEventListener:(name,fn)=>{if(name==='DOMContentLoaded')ready=fn;}},document,MutationObserver:class{observe(){}},ResizeObserver:class{constructor(fn){resize=fn;}observe(){}}});
 assert.equal(exposed.name,'ChartsHubGuestView');assert.deepEqual(Object.keys(exposed.value),['returnToAccount']);exposed.value.returnToAccount();assert.deepEqual(calls,['chartshub:close-guest']);ready();resize();assert.equal(styles.get('--chartshub-guest-banner-height'),'80px');
});

test('download snapshots require a trusted renderer before and after account revalidation',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),match=source.match(/ipcMain\.handle\('chartshub:download-state',(async event=>\{[^\n]+\})\);/);assert.ok(match);
 let reads=0,checks=0;const c={allowedSender:()=>false,refreshAccount:async()=>{checks++;return {ok:true,user:{id:'ordinary-account'}};},downloads:{refresh:async()=>{assert.fail('snapshot revalidation must also update Companion availability through refreshAccount');},snapshot(){reads++;return {revision:1};}}};vm.createContext(c);vm.runInContext('handler='+match[1],c);
 assert.equal(await c.handler({}),null);assert.equal(checks,0);assert.equal(reads,0);
 c.allowedSender=()=>true;assert.equal((await c.handler({})).revision,1);assert.equal(reads,1);assert.equal(checks,1);
 let finishRefresh;c.refreshAccount=()=>new Promise(resolve=>{finishRefresh=resolve;});
 const pending=c.handler({});assert.equal(reads,1,'a private snapshot waits for shared account revalidation');
 c.allowedSender=()=>false;finishRefresh({ok:true,user:{id:'ordinary-account'}});
 assert.equal(await pending,null);assert.equal(reads,1,'navigation during authentication cannot receive a private snapshot');
});
