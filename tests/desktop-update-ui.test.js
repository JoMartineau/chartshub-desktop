'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createDocument,tick}=require('./floating-panel-dom.cjs');
const state=changes=>({status:'idle',currentVersion:'0.14.27',latestVersion:null,notes:'',releaseUrl:null,progress:null,installSupported:true,canCheck:true,canDownload:false,canInstall:false,busyReasons:[],error:null,...changes});
async function fixture(t,initial=state()){
 const {UpdatesControls}=await import('../companion/dist/settings/UpdatesControls.js'),doc=createDocument(),root=doc.createElement('section');
 root.replaceChildren=(...nodes)=>{root.textContent='';root.append(...nodes);};let snapshot=initial,listener;const calls=[];
 const controls=new UpdatesControls({root,bridge:{getState:async()=>({updater:snapshot}),subscribe:fn=>{listener=fn;return()=>{listener=null;};},invoke:action=>new Promise(resolve=>calls.push({action,resolve}))}});t.after(()=>controls.dispose());await tick();
 return {root,doc,controls,calls,button:name=>root.querySelectorAll('button').find(b=>b.dataset.updateAction===name),push:patch=>{snapshot=state({...snapshot,...patch});listener?.({updater:snapshot});}};
}
test('updates never check network or install automatically and actions follow backend capabilities',async t=>{
 const ui=await fixture(t);assert.equal(ui.calls.length,0);assert.equal(ui.button('check').disabled,false);assert.equal(ui.button('download').disabled,true);assert.equal(ui.button('install').disabled,true);ui.button('install').click();assert.equal(ui.calls.length,0);
 ui.button('check').click();assert.equal(ui.calls[0].action,'update.check');ui.push({status:'available',latestVersion:'0.14.28',canCheck:true,canDownload:true,releaseUrl:'https://github.com/JoMartineau/chartshub-desktop/releases/tag/v0.14.28'});ui.calls[0].resolve({ok:true});await tick();assert.equal(ui.button('download').disabled,false);assert.equal(ui.button('install').disabled,true);
});
test('release notes stay literal text and FR/EN busy hints reflect incompatible operations',async t=>{
 const ui=await fixture(t,state({status:'ready',notes:'<img src=x onerror=unsafe()>',latestVersion:'0.14.28',canInstall:false,busyReasons:['library_scanning','requests_active']}));ui.controls.update({language:'fr'});assert(ui.root.textContent.includes('<img src=x onerror=unsafe()>'));assert.equal(ui.root.querySelectorAll('img').length,0);assert(ui.root.textContent.includes('l’analyse de la bibliothèque'));assert.equal(ui.button('install').disabled,true);
 ui.controls.update({language:'en'});assert(ui.root.textContent.includes('the library scan'));ui.push({canInstall:true,busyReasons:[]});assert.equal(ui.button('install').disabled,false);ui.button('install').click();assert.equal(ui.calls[0].action,'update.install');
});
test('cancellation remains available during an outstanding check and unsupported OS is honest',async t=>{
 const ui=await fixture(t);ui.button('check').click();ui.push({status:'checking',canCheck:false});assert.equal(ui.button('cancel').hidden,false);ui.button('cancel').click();assert.deepEqual(ui.calls.map(c=>c.action),['update.check','update.cancel']);ui.calls[1].resolve({ok:true});ui.calls[0].resolve({ok:false,error:'UPDATE_CANCELLED'});await tick();
 const manual=await fixture(t,state({status:'available',installSupported:false,canDownload:true,latestVersion:'0.14.28'}));assert.equal(manual.button('install').hidden,true);assert.equal(manual.button('download').textContent,'Official download');assert(manual.root.textContent.includes('Install on this system using the official download'));
});
test('disposal ignores late action results and release events',async t=>{
 const ui=await fixture(t);ui.button('check').click();ui.controls.dispose();const before=ui.doc.writes;ui.calls[0].resolve({ok:false,error:'UPDATE_FAILED'});ui.push({status:'error'});await tick();assert.equal(ui.doc.writes,before);
});
