'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const ORIGIN='https://chartshub.ca',endpoint='/api/admin/charts/12345678-1234-1234-1234-123456789012/privatechart12/download-manifest';
const settle=()=>new Promise(r=>setImmediate(r));
async function desktop(){
 const ipc=new Map(),events=[];let win,web,user={id:'staff-a',emailVerified:true,staffRole:'moderator'},transfer,resolveDownload,shown=0;
 const session=new EventEmitter();Object.assign(session,{setPermissionRequestHandler(){},setPermissionCheckHandler(){},cookies:new EventEmitter(),fetch:async()=>Response.json({user})});
 const contents=()=>Object.assign(new EventEmitter(),{mainFrame:{url:ORIGIN+'/'},getURL:()=>ORIGIN+'/',isDestroyed:()=>false,setWindowOpenHandler(){},send:(name,data)=>events.push({name,data}),loadURL:()=>Promise.resolve()});
 class Window extends EventEmitter{constructor(){super();win=this;this.webContents=contents();}setMenuBarVisibility(){}isDestroyed(){return false;}loadURL(){return Promise.resolve();}setProgressBar(){}isMinimized(){return false;}restore(){}show(){}focus(){} }
 const createDesktopShell=()=>({window:new Window(),catalogueView:{webContents:web=contents()},ready:Promise.resolve(),showTab(){},setCompanionAvailable(){},setTheme(){},dispose(){}});
 const electron={BrowserWindow:Window,app:Object.assign(new EventEmitter(),{requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),getPath:()=>'/exports'}),session:{fromPartition:()=>session},ipcMain:{handle:(name,fn)=>ipc.set(name,fn)},Menu:{setApplicationMenu(){}},shell:{showItemInFolder:()=>shown++},dialog:{},nativeTheme:{}};
 const localRequire=name=>name==='electron'?electron:name==='./desktop/controller.cjs'?{createDesktopShell}:name==='./companion/host.cjs'?{registerCompanionScheme(){},createCompanionHost(){throw Error('Companion should remain lazy in catalogue mode');}}:name==='./download'?{ORIGIN,endpointValid:()=>true,downloadChart:options=>{transfer=options;return new Promise(r=>{resolveDownload=r;});}}:name==='./download-folder'?{folderPreferences:()=>({get:async()=>'/exports'})}:require(name.startsWith('./')?path.join(__dirname,'..',name):name);
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),{require:localRequire,process,URL,AbortController,AbortSignal,__dirname:path.join(__dirname,'..'),setInterval,clearInterval});await settle();
 const event=()=>({sender:web,senderFrame:web.mainFrame});
 return {ipc,events,session,get transfer(){return transfer;},get shown(){return shown;},win,web,setUser:next=>{user=next;},invoke:(name,...args)=>ipc.get('chartshub:'+name)(event(),...args),finish:()=>resolveDownload({destination:'/exports/private',folderName:'Private chart',files:4})};
}
test('Electron clears private history on session-cookie changes and suppresses late progress/results',async()=>{
 const d=await desktop(),pending=d.invoke('download',endpoint);await settle();assert.ok(d.transfer);d.transfer.progress({percent:20,message:'Private chart'});
 assert.equal((await d.invoke('download-state')).items.length,1);
 d.setUser({id:'member-b',emailVerified:true,staffRole:null});d.session.cookies.emit('changed',{}, {name:'chartshub_session',domain:'chartshub.ca'});await settle();
 assert.equal(d.transfer.signal.aborted,true);assert.equal((await d.invoke('download-state')).items.length,0);
 const count=d.events.filter(e=>e.name==='chartshub:progress').length;d.transfer.progress({percent:90,message:'Old private result'});assert.equal(d.events.filter(e=>e.name==='chartshub:progress').length,count);
 d.finish();const result=await pending;assert.equal(result.cancelled,true);assert.equal(d.shown,0);assert.equal((await d.invoke('download-state')).items.length,0);
});
test('Electron keeps a transfer on navigation by the same account and returns its finished folder',async()=>{
 const d=await desktop(),pending=d.invoke('download',endpoint);await settle();
 d.web.emit('did-start-navigation',{},ORIGIN+'/admin-verifications.html',false,true);
 d.web.emit('did-finish-load');await settle();assert.equal(d.transfer.signal.aborted,false);d.finish();
 const result=await pending;assert.equal(result.ok,true);assert.equal(d.shown,1);assert.equal((await d.invoke('download-state')).items[0].status,'complete');
});
test('Electron revalidates a snapshot against an expired session even without a renderer event',async()=>{
 const d=await desktop(),pending=d.invoke('download',endpoint);await settle();d.finish();await pending;
 d.setUser(null);assert.equal((await d.invoke('download-state')).items.length,0);
});
