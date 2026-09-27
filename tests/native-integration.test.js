'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('local application menu opens immediately while administrator authorization is pending',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),match=source.match(/ipcMain\.handle\('chartshub:menu',(async[\s\S]*?)\n  \}\);/);assert.ok(match);let opened=0,checks=0;
 const c={allowedSender:()=>true,refreshAdministrator:()=>{checks++;return new Promise(()=>{});},adminAllowed:false,Menu:{buildFromTemplate:options=>({popup(){opened++;assert.equal(options.visitorPreview,undefined);}})},applicationMenu:options=>options,win:{webContents:{},close(){},setFullScreen(){},isFullScreen(){return false;}},load(){},job:null,openGuest(){}};vm.createContext(c);vm.runInContext('handler='+match[1]+'\n}',c);await c.handler({},'en');assert.equal(opened,1);assert.equal(checks,1);
 c.allowedSender=()=>false;await c.handler({},'en');assert.equal(opened,1,'untrusted IPC never opens the application menu');
});
test('native guest exposes only a return action and reserves the measured banner height',()=>{
 let ready,exposed,resize;const calls=[],styles=new Map();
 const make=()=>({style:{},children:[],events:{},append(...nodes){this.children.push(...nodes);},addEventListener(name,fn){this.events[name]=fn;},getBoundingClientRect:()=>({height:79.2})});
 const document={documentElement:{lang:'fr',style:{setProperty:(key,value)=>styles.set(key,value)}},body:{prepend(){}},createElement:make};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../guest-preload.js'),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(name,value)=>{exposed={name,value};}},ipcRenderer:{invoke:channel=>calls.push(channel)}}),process:{isMainFrame:true},location:{origin:'https://chartshub.ca'},window:{addEventListener:(name,fn)=>{if(name==='DOMContentLoaded')ready=fn;}},document,MutationObserver:class{observe(){}},ResizeObserver:class{constructor(fn){resize=fn;}observe(){}}});
 assert.equal(exposed.name,'ChartsHubGuestView');assert.deepEqual(Object.keys(exposed.value),['returnToAccount']);exposed.value.returnToAccount();assert.deepEqual(calls,['chartshub:close-guest']);ready();resize();assert.equal(styles.get('--chartshub-guest-banner-height'),'80px');
});

test('download snapshots remain restricted to the trusted main renderer IPC sender',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),match=source.match(/ipcMain\.handle\('chartshub:download-state',(event=>[^;]+)\);/);assert.ok(match);let reads=0;const c={allowedSender:()=>false,downloads:{snapshot(){reads++;return {revision:1};}}};vm.createContext(c);vm.runInContext('handler='+match[1],c);assert.equal(c.handler({}),null);assert.equal(reads,0);c.allowedSender=()=>true;assert.equal(c.handler({}).revision,1);assert.equal(reads,1);
});
