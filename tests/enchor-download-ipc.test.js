'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const ORIGIN='https://chartshub.ca',md5='0123456789abcdef0123456789abcdef',payload={md5,title:'Song',artist:'Band'};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function desktop(){
 const ipc=new Map(),events=[],shown=[];let win,web,user={id:'member-a',emailVerified:true,staffRole:null},transfer,resolveDownload,calls=0;
 const session=Object.assign(new EventEmitter(),{setPermissionRequestHandler(){},setPermissionCheckHandler(){},cookies:new EventEmitter(),fetch:async()=>Response.json({user})});
 const contents=()=>Object.assign(new EventEmitter(),{mainFrame:{url:ORIGIN+'/'},getURL:()=>ORIGIN+'/',isDestroyed:()=>false,setWindowOpenHandler(){},send:(name,data)=>events.push({name,data}),loadURL:()=>Promise.resolve()});
 class Window extends EventEmitter{constructor(){super();win=this;this.webContents=contents();}setMenuBarVisibility(){}isDestroyed(){return false;}loadURL(){return Promise.resolve();}setProgressBar(){}isMinimized(){return false;}restore(){}show(){}focus(){} }
 const createDesktopShell=()=>({window:new Window(),catalogueView:{webContents:web=contents()},ready:Promise.resolve(),showTab(){},setCompanionAvailable(){},setTheme(){},dispose(){}});
 const electron={BrowserWindow:Window,app:Object.assign(new EventEmitter(),{requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),getPath:()=>'/exports'}),session:{fromPartition:()=>session},ipcMain:{handle:(name,fn)=>ipc.set(name,fn)},Menu:{setApplicationMenu(){}},shell:{showItemInFolder:value=>shown.push(value)},dialog:{},nativeTheme:{}};
 const localRequire=name=>name==='electron'?electron:name==='./desktop/controller.cjs'?{createDesktopShell}:name==='./companion/host.cjs'?{registerCompanionScheme(){},createCompanionHost(){throw Error('Companion remains lazy');}}:name==='./enchor-download'?{...require('../enchor-download'),downloadEnchor:options=>{transfer=options;calls++;return new Promise(resolve=>{resolveDownload=resolve;});}}:name==='./batch-download'?{...require('../batch-download'),downloadBatch:options=>{transfer=options;calls++;return new Promise(resolve=>{resolveDownload=resolve;});}}:name==='./download-folder'?{folderPreferences:()=>({get:async()=>'/exports'})}:require(name.startsWith('./')?path.join(__dirname,'..',name):name);
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),{require:localRequire,process,URL,AbortController,AbortSignal,__dirname:path.join(__dirname,'..'),setInterval,clearInterval});await settle();
 const event=()=>({sender:web,senderFrame:web.mainFrame});
 return {ipc,events,session,shown,win,web,get calls(){return calls;},get transfer(){return transfer;},setUser:next=>{user=next;},invoke:(name,...args)=>ipc.get('chartshub:'+name)(event(),...args),finish:()=>resolveDownload({destination:'/exports/Band - Song/Band - Song.sng',folderName:'Band - Song',fileName:'Band - Song.sng',files:3,format:'sng'}),finishBatch:()=>resolveDownload({ok:true,cancelled:transfer.signal.aborted,results:require('../batch-download').normalizeBatch(transfer.endpoints).map(item=>({endpoint:item.endpoint,ok:true,folderName:'Saved',files:3}))})};
}
test('native external imports require the active ChartsHub main frame and a hash-only download destination',async()=>{
 const d=await desktop(),handler=d.ipc.get('chartshub:download-enchor');
 for(const event of [{sender:d.web,senderFrame:{...d.web.mainFrame}},{sender:{},senderFrame:d.web.mainFrame}])assert.equal((await handler(event,payload)).ok,false);
 for(const value of [{...payload,url:'https://evil.test/a.sng'},{...payload,md5:'invalid'},null])assert.equal((await d.invoke('download-enchor',value)).ok,false);
 assert.equal(d.calls,0);
 const pending=d.invoke('download-enchor',payload);await settle();assert.equal(d.calls,1);assert.equal(d.transfer.directory,'/exports');assert.deepEqual(d.transfer.request,payload);
 assert.equal((await d.invoke('download-enchor',payload)).ok,false,'only one native job is allowed');
 d.transfer.progress({percent:35,message:'External chart'});const state=await d.invoke('download-state');assert.equal(state.items[0].endpoint,'enchor:'+md5);assert.equal(state.items[0].percent,35);
 d.finish();const result=await pending;assert.equal(result.ok,true);assert.equal(result.fileName,'Band - Song.sng');assert.equal(result.format,'sng');assert.deepEqual(d.shown,['/exports/Band - Song/Band - Song.sng']);assert.equal((await d.invoke('download-state')).items[0].status,'complete');
});
test('account switches cancel external imports and suppress old progress and completed paths',async()=>{
 const d=await desktop(),pending=d.invoke('download-enchor',payload);await settle();assert.ok(d.transfer);d.transfer.progress({percent:15,message:'Downloading'});
 d.setUser({id:'member-b',emailVerified:true,staffRole:null});d.session.cookies.emit('changed',{}, {name:'chartshub_session',domain:'chartshub.ca'});await settle();
 assert.equal(d.transfer.signal.aborted,true);assert.equal((await d.invoke('download-state')).items.length,0);
 const before=d.events.filter(item=>item.name==='chartshub:progress').length;d.transfer.progress({percent:95,message:'Old result'});assert.equal(d.events.filter(item=>item.name==='chartshub:progress').length,before);
 d.finish();assert.equal((await pending).cancelled,true);assert.equal(d.shown.length,0);
});
test('ordinary navigation preserves the external job and the shared cancel button interrupts it',async()=>{
 const d=await desktop(),pending=d.invoke('download-enchor',payload);await settle();d.web.emit('did-start-navigation',{},ORIGIN+'/leaderboard.html',false,true);d.web.emit('did-finish-load');await settle();assert.equal(d.transfer.signal.aborted,false);
 await d.invoke('cancel');assert.equal(d.transfer.signal.aborted,true);d.finish();assert.equal((await pending).cancelled,true);assert.equal(d.shown.length,0);
});
test('the existing batch IPC accepts native and external entries while its state retains only validated stable identities',async()=>{
 const endpoint='/api/charts/12345678-1234-1234-1234-123456789012/chartabcdef1/download-manifest',d=await desktop();
 for(const values of [[payload,{...payload,url:'https://evil.test/sng'}],[endpoint,endpoint],['https://evil.test/sng']])assert.equal((await d.invoke('download-batch',values)).ok,false);
 assert.equal(d.calls,0);
 const pending=d.invoke('download-batch',[endpoint,payload]);await settle();assert.equal(d.calls,1);assert.deepEqual(d.transfer.endpoints,[endpoint,payload]);assert.equal(d.transfer.directory,'/exports');
 const state=await d.invoke('download-state');assert.deepEqual(Array.from(state.operation.endpoints),[endpoint,'enchor:'+md5]);
 d.transfer.progress({endpoint:'enchor:'+md5,itemPercent:50,percent:75,message:'External'});assert.equal((await d.invoke('download-state')).items.find(item=>item.endpoint==='enchor:'+md5).percent,50);
 assert.equal((await d.invoke('download-enchor',payload)).ok,false);
 d.finishBatch();assert.equal((await pending).ok,true);assert.equal((await d.invoke('download-state')).items.every(item=>item.status==='complete'),true);
});
