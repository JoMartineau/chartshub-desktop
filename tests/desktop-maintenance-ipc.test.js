'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {createMaintenanceIpc,STATE,COMMAND}=require('../desktop/maintenance-ipc.cjs');
function harness({consent=1}={}){
 const handlers=new Map(),frame={url:'chartshub-companion://app/ui/index.html'},contents={mainFrame:frame,isDestroyed:()=>false,isLoading:()=>false,send:()=>{}},owner={};let available=true,installed=0,calls=[];
 const updater={snapshot:()=>({canInstall:true}),check:async()=>calls.push('check'),download:async()=>calls.push('download'),cancel:()=>calls.push('cancel'),openRelease:async()=>calls.push('open')};
 const ipc=createMaintenanceIpc({ipcMain:{handle:(n,f)=>handlers.set(n,f),removeHandler:n=>handlers.delete(n)},updater,getContents:()=>contents,getOwner:()=>owner,isAvailable:()=>available,dialog:{showMessageBox:async(_owner,options)=>{calls.push(options);return {response:typeof consent==='function'?consent(()=>available=false):consent};}},beginInstall:async()=>{installed++;},language:()=> 'fr'});
 const event={sender:contents,senderFrame:frame};return {handlers,ipc,contents,event,frame,owner,updater,calls,installations:()=>installed,invoke:(action,payload,eventOverride=event)=>handlers.get(COMMAND)(eventOverride,action,payload)};
}
test('only exact active main Companion frame can read maintenance or invoke a bounded action',async()=>{
 const h=harness();assert(h.handlers.get(STATE)(h.event));assert.equal(h.handlers.get(STATE)({...h.event,senderFrame:{url:h.frame.url}}),null);
 for(const [action,payload,event] of [['update.check',{},h.event],['update.arbitrary',undefined,h.event],['update.check',undefined,{sender:{},senderFrame:h.frame}],['update.check',undefined,{sender:h.contents,senderFrame:{url:'https://chartshub.ca/'}}]])assert.equal((await h.invoke(action,payload,event)).ok,false);
 assert.equal((await h.invoke('update.check')).ok,true);assert.deepEqual(h.calls,['check']);h.ipc.dispose();assert.equal(h.handlers.size,0);
});
test('installation requires native explicit consent and a still-current authorized frame',async()=>{
 for(const consent of [0,1]){const h=harness({consent});const result=await h.invoke('update.install');assert.equal(result.ok,true);assert.equal(h.installations(),consent);const prompt=h.calls[0];assert.equal(prompt.defaultId,0);assert.equal(prompt.cancelId,0);assert.equal(prompt.noLink,true);}
 const h=harness({consent:revoke=>{revoke();return 1;}});assert.equal((await h.invoke('update.install')).ok,false);assert.equal(h.installations(),0);
});
test('incompatible operations cannot be overridden by renderer or dialog consent',async()=>{
 const h=harness();h.updater.snapshot=()=>({canInstall:false});assert.equal((await h.invoke('update.install')).ok,false);assert.equal(h.calls.length,0);assert.equal(h.installations(),0);
});
test('main shutdown authorizes helper only after successful host and shell persistence',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),start=source.indexOf('  const finishClose=async()=>{'),end=source.indexOf('  let closePrompt=',start);assert(start>0&&end>start);
 for(const failAt of [null,'host','shell']){
  const calls=[];const runtime={paletteIpc:null,closing:false,notificationBroker:{invalidate:()=>calls.push('revoke'),dispose:async()=>calls.push('notifications')},companionHostPromise:Promise.resolve({dispose:async()=>{calls.push('host');if(failAt==='host')throw Error('fixture');}}),desktop:{dispose:async()=>{calls.push('shell');if(failAt==='shell')throw Error('fixture');}},pendingUpdate:true,pendingBackupId:null,updater:{authorizeInstallation:async()=>calls.push('authorize'),cancelInstallation:async()=>calls.push('cancel'),dispose:()=>calls.push('updater-dispose')},maintenance:{dispose:()=>calls.push('ipc-dispose')},allowClose:false,win:{isDestroyed:()=>false,close:()=>calls.push('close')},console:{error:()=>{}}};
  vm.createContext(runtime);await vm.runInContext(source.slice(start,end)+';finishClose()',runtime);assert(calls.indexOf('host')<calls.indexOf('shell'));assert(calls.indexOf('shell')<calls.indexOf('close'));assert.equal(calls.includes('authorize'),failAt===null);assert.equal(calls.includes('cancel'),failAt!==null);if(!failAt)assert(calls.indexOf('authorize')>calls.indexOf('shell'));
 }
});
test('configuration apply runs after all persistence and relaunches only through the authorized close path',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),start=source.indexOf('  const finishClose=async()=>{'),end=source.indexOf('  let closePrompt=',start);
 for(const failAt of [null,'host','apply']){
  const calls=[],runtime={paletteIpc:null,closing:false,notificationBroker:{invalidate:()=>{},dispose:async()=>calls.push('notifications')},companionHostPromise:Promise.resolve({dispose:async()=>{calls.push('host');if(failAt==='host')throw Error('fixture');}}),desktop:{dispose:async()=>calls.push('shell')},pendingUpdate:false,pendingBackupId:'12345678-1234-4234-8234-123456789abc',backupEngine:{apply:async(id,options)=>{calls.push('apply');assert.equal(id,runtime.pendingBackupId);assert.equal(options.quiesced,true);assert(calls.includes('shell'));if(failAt==='apply')throw Error('fixture');}},app:{relaunch:()=>calls.push('relaunch')},dialog:{showErrorBox:()=>calls.push('error')},companionLanguage:'fr',updater:{dispose:()=>{}},maintenance:{dispose:()=>{}},allowClose:false,win:{isDestroyed:()=>false,close:()=>calls.push('close')},console:{error:()=>{}}};
  vm.createContext(runtime);await vm.runInContext(source.slice(start,end)+';finishClose()',runtime);assert.equal(calls.includes('apply'),failAt!=='host');assert.equal(calls.includes('error'),failAt!==null);assert(calls.indexOf('relaunch')>calls.indexOf('shell'));assert(calls.indexOf('relaunch')<calls.indexOf('close'));
 }
});
test('backup dispatch keeps the same trusted main-frame boundary and never exposes native file paths',async()=>{
 const h=harness(),id='12345678-1234-4234-8234-123456789abc';let guard;
 h.ipc.setBackupModule({getState:()=>({busy:false,preview:{id},error:null}),invoke:async(action,payload,current)=>{guard=current;assert.equal(action,'backup.cancel');assert.deepEqual(payload,{id});return {ok:true};},dispose:()=>{}});
 assert.equal(h.handlers.get(STATE)(h.event).backup.preview.id,id);assert.equal((await h.invoke('backup.cancel',{id})).ok,true);assert.equal(guard(),true);h.frame.url='https://chartshub.ca/';assert.equal(guard(),false);assert.equal((await h.invoke('backup.export')).ok,false);
});
