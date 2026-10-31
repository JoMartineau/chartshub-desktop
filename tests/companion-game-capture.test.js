const test = require('node:test'), assert = require('node:assert/strict'), { EventEmitter } = require('node:events'), path = require('node:path');
const { createGameCapture, validCrop, validSignal, candidates, captureRequestAllowed, PAGES, TITLES } = require('../companion/game-capture.cjs');
const { validCommand } = require('../companion/security.cjs');
const root = path.resolve(__dirname, '../companion');
function fixture() {
  const windows = [], handlers = new Map(), requests = [], ses = new EventEmitter();
  const forbiddenThumbnail = { get thumbnail(){ throw Error('Window thumbnails must not be read'); } };
  let sources = [Object.assign(Object.create(forbiddenThumbnail), { id:'window:42:0',name:'Clone Hero' }),
    Object.assign(Object.create(forbiddenThumbnail), { id:'window:77:0',name:'Private fixture window' })];
  Object.assign(ses, { setPermissionCheckHandler(fn){this.check=fn;}, setPermissionRequestHandler(fn){this.permission=fn;},
    setDisplayMediaRequestHandler(fn){this.display=fn;}, protocol:{async handle(){},async unhandle(){}} });
  class Contents extends EventEmitter {
    constructor(){super();this.mainFrame={url:''};this.sent=[];this.dead=false;}
    isDestroyed(){return this.dead;}
    send(...value){this.sent.push(value);}
    setWindowOpenHandler(fn){this.open=fn;}
  }
  class Window extends EventEmitter {
    constructor(options){super();this.options=options;this.webContents=new Contents();this.dead=false;windows.push(this);}
    isDestroyed(){return this.dead;}
    async loadURL(url){this.webContents.mainFrame.url=url;}
    setMenuBarVisibility(){}
    setContentSize(width,height){this.contentSize=[width,height];}
    show(){this.shown=true;}
    focus(){}
    destroy(){if(this.dead)return;this.dead=true;this.webContents.dead=true;this.emit('closed');}
  }
  const electron={BrowserWindow:Window,session:{fromPartition(name){assert.equal(name,'chartshub-game-capture');return ses;}},
    desktopCapturer:{async getSources(options){assert.deepEqual(options.thumbnailSize,{width:0,height:0});requests.push(options);return sources;}},
    ipcMain:{handle(name,fn){handlers.set(name,fn);},removeHandler(name){handlers.delete(name);}},net:{fetch(){throw Error('No remote fetch');}}};
  const event = window => ({sender:window.webContents,senderFrame:window.webContents.mainFrame});
  const call = (window,command,payload) => handlers.get('companion:game-capture')(event(window),command,payload);
  const request = window => ({frame:window.webContents.mainFrame,securityOrigin:'chartshub-companion://app',userGesture:true,videoRequested:true,audioRequested:false});
  return {windows,requests,ses,electron,event,call,request,handlers,setSources:value=>{sources=value;}};
}
test('capture accepts bounded normalized crops and window-only Clone Hero candidates',()=>{
  assert.equal(validCrop({x:.2,y:.1,width:.3,height:.8}),true);
  for(const r of [{x:0,y:0,width:0,height:1},{x:.9,y:0,width:.2,height:1},{x:NaN,y:0,width:1,height:1},{x:0,y:0,width:1,height:1,source:'screen:0:0'}]) assert.equal(validCrop(r),false);
  assert.deepEqual(candidates([{id:'window:1:0',name:'Clone Hero'},{id:'window:2:1',name:'Clone Hero'},{id:'screen:0:0',name:'Clone Hero'},{id:'window:3:0',name:'Personal email'}]).map(s=>s.id),['window:1:0']);
  assert.equal(validCommand('gameCapture.open',{},[]),true);
  assert.equal(validCommand('gameCapture.open',{source:'screen:0:0'},[]),false);
});
test('capture request needs the owned main frame, selection, video only and user activation',()=>{
  const f=fixture(), contents={mainFrame:{url:PAGES.controller},isDestroyed:()=>false};
  const request={frame:contents.mainFrame,securityOrigin:'chartshub-companion://app',userGesture:true,videoRequested:true,audioRequested:false};
  assert.equal(captureRequestAllowed(request,contents,{id:'window:42:0'},true),true);
  for(const changed of [{frame:{url:PAGES.controller}},{securityOrigin:'https://example.com'},{userGesture:false},{videoRequested:false},{audioRequested:true}]) assert.equal(captureRequestAllowed({...request,...changed},contents,{id:'window:42:0'},true),false);
  assert.equal(captureRequestAllowed(request,contents,null,true),false);
  assert.equal(captureRequestAllowed(request,contents,{id:'screen:0:0'},true),false);
  assert.equal(captureRequestAllowed(request,contents,{id:'window:42:0'},false),false);
});
test('capture stays stopped until explicit selection and start, routes only owned outputs, and stop revokes everything',async t=>{
  const f=fixture(), service=await createGameCapture({root,electron:f.electron});t.after(()=>service.dispose());
  assert.equal(service.snapshot().phase,'stopped');assert.equal(f.windows.length,0);assert.equal(f.requests.length,0);
  await service.open();const preview=f.windows[0];assert.equal(preview.options.show,false);assert.equal(preview.shown,true);
  let grant='unset';await f.ses.display(f.request(preview),v=>{grant=v;});assert.equal(grant,null);
  const listed=await f.call(preview,'list');assert.deepEqual(listed.sources,[{id:'window:42:0',name:'Clone Hero'}]);assert.ok(f.requests.every(r=>r.types.length===1&&r.types[0]==='window'));
  assert.equal((await f.call(preview,'select',{id:'screen:0:0'})).ok,false);
  assert.equal((await f.call(preview,'select',{id:'window:42:0'})).ok,true);
  assert.equal(service.snapshot().phase,'stopped');
  await f.ses.display(f.request(preview),v=>{grant=v;});assert.equal(grant.video.id,'window:42:0');assert.equal(Object.hasOwn(grant,'audio'),false);
  assert.equal((await f.call(preview,'started',{width:1920,height:1080})).ok,true);
  const rect={x:.3,y:.1,width:.3,height:.9};assert.equal((await f.call(preview,'crop',{kind:'highway',rect})).ok,true);
  assert.equal((await f.call(preview,'output',{kind:'highway'})).ok,true);const output=f.windows[1];
  assert.equal(output.options.title,TITLES.highway);assert.equal(output.options.show,false);
  assert.deepEqual(output.contentSize,[427,720]);
  assert.equal((await f.call(output,'list')).ok,false);assert.equal((await f.call(output,'select',{id:'window:42:0'})).ok,false);
  assert.equal((await f.call(preview,'output',{kind:'score'})).ok,false);
  const snapshot=(await f.call(preview,'snapshot')).state;
  assert.equal((await f.call(output,'signal',{revision:snapshot.revision,signal:{description:{type:'answer',sdp:'v=0'}}})).ok,true);
  const foreign={sender:preview.webContents,senderFrame:{url:PAGES.controller}};
  assert.equal((await f.handlers.get('companion:game-capture')(foreign,'snapshot')).ok,false);
  assert.equal(f.ses.check(output.webContents,'display-capture','chartshub-companion://app',{isMainFrame:true,requestingUrl:PAGES.highway}),false);
  assert.equal(f.ses.check(preview.webContents,'media','chartshub-companion://app',{isMainFrame:true}),false);
  await f.call(preview,'stop');assert.equal(service.snapshot().phase,'stopped');assert.equal(output.isDestroyed(),true);
  assert.equal((await f.call(preview,'snapshot')).state.selected,null);
  await f.ses.display(f.request(preview),v=>{grant=v;});assert.equal(grant,null);
  assert.equal((await f.call(output,'signal',{revision:snapshot.revision,signal:{description:{type:'answer',sdp:'v=0'}}})).ok,false);
});
test('capture refuses a disappeared source and does not rebind to another window with the same title',async t=>{
  const f=fixture(),service=await createGameCapture({root,electron:f.electron});t.after(()=>service.dispose());
  await service.open();const preview=f.windows[0];await f.call(preview,'list');await f.call(preview,'select',{id:'window:42:0'});
  f.setSources([{id:'window:99:0',name:'Clone Hero',thumbnail:{toDataURL:()=>''}}]);
  let grant;await f.ses.display(f.request(preview),v=>{grant=v;});assert.equal(grant,null);
  const value=(await f.call(preview,'snapshot')).state;assert.equal(value.phase,'stopped');assert.equal(value.selected,null);assert.equal(value.error,'window-unavailable');
});
test('signaling rejects arbitrary payloads and oversized SDP',()=>{
  assert.equal(validSignal({description:{type:'offer',sdp:'v=0'}}),true);
  assert.equal(validSignal({description:{type:'offer',sdp:'x'.repeat(65537)}}),false);
  assert.equal(validSignal({description:{type:'rollback',sdp:''}}),false);
  assert.equal(validSignal({target:'remote',description:{type:'offer',sdp:'v=0'}}),false);
  assert.equal(validSignal({candidate:{candidate:'candidate:1',sdpMid:'0',sdpMLineIndex:0,usernameFragment:null}}),true);
});
test('the owned Stop action remains available if the host becomes inactive',async t=>{
  const f=fixture();let active=true;const service=await createGameCapture({root,electron:f.electron,active:()=>active});t.after(()=>service.dispose());
  await service.open();const preview=f.windows[0];await f.call(preview,'list');await f.call(preview,'select',{id:'window:42:0'});
  active=false;assert.equal((await f.call(preview,'stop')).ok,true);assert.equal(service.snapshot().phase,'stopped');
  assert.equal((await f.call(preview,'list')).ok,false);
});
test('reloading the owned preview revokes capture and closes its outputs',async t=>{
  const f=fixture(),service=await createGameCapture({root,electron:f.electron});t.after(()=>service.dispose());
  await service.open();const preview=f.windows[0];await f.call(preview,'list');await f.call(preview,'select',{id:'window:42:0'});
  await f.ses.display(f.request(preview),()=>{});await f.call(preview,'started',{width:640,height:360});
  await f.call(preview,'crop',{kind:'score',rect:{x:0,y:0,width:.5,height:.5}});await f.call(preview,'output',{kind:'score'});
  preview.webContents.emit('did-start-loading');assert.equal(service.snapshot().phase,'stopped');assert.equal(f.windows[1].isDestroyed(),true);
});
