'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../preload.js'),'utf8');
function preload({tabbed=false,origin='https://chartshub.ca',isMainFrame=true}={}){
 const exposed=new Map(),events=[];
 vm.runInNewContext(source,{
  process:{isMainFrame,argv:tabbed?['electron','--chartshub-tabbed']:['electron'],platform:'win32'},
  location:{origin},window:{addEventListener:(name,handler)=>events.push({name,handler})},
  require:name=>{assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(name,api)=>exposed.set(name,api)},ipcRenderer:{}};}
 });
 return {exposed,events};
}
test('trusted catalogue preload exposes explicit tabbed or legacy layout before DOM readiness',()=>{
 for(const tabbed of [false,true]){
  const f=preload({tabbed}),api=f.exposed.get('ChartsHubDesktop');
  assert.equal(api.layout,tabbed?'tabbed':'legacy');
  assert.equal(f.events.length,1);assert.equal(f.events[0].name,'DOMContentLoaded');
  assert.equal(typeof api.download,'function');
 }
});
test('layout metadata does not expose a new capability or relax main-frame and origin checks',()=>{
 for(const options of [{isMainFrame:false},{origin:'https://example.com'},{origin:'http://chartshub.ca'},{origin:'https://chartshub.ca.evil.test'}])assert.equal(preload(options).exposed.size,0);
 const api=preload({tabbed:true}).exposed.get('ChartsHubDesktop');
 assert.equal(api.ipcRenderer,undefined);assert.equal(api.send,undefined);assert.equal(api.invoke,undefined);
});
