'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

// Run the actual host orchestration with controlled adapters, without Electron,
// native windows, user sessions, network access or any Songs filesystem writes.
const source=fs.readFileSync(path.join(__dirname,'../companion/host.cjs'),'utf8');
const start=source.indexOf('  async function refreshSongRequestShare()');
const end=source.indexOf('  catalogue =',start);
assert.ok(start>=0&&end>start,'The share orchestration must remain identifiable');
const declarations=source.split(/\r?\n/).filter(line=>/^  let songRequestShare\w*\s*=/.test(line)).join('\n');
const accountStart=source.indexOf('  function setCatalogueAvailable(enabled)');
const accountEnd=source.indexOf('  async function requireCatalogueAuthorization(',accountStart);
assert.ok(accountStart>=0&&accountEnd>accountStart,'The account access lifecycle must remain identifiable');
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture({status,publish,remove,prepare}={}){
 const calls=[],rules={maxDurationMinutes:null,instrument:'all',difficulty:'all'},scope={rootKey:'a'.repeat(64),revision:1};
 const sharingClient={capture:async()=>({userId:'opaque-test-owner',generation:1}),status:status??(async()=>({url:null,count:0,updatedAt:null})),
  publish:async(...args)=>{calls.push('PUT');return publish?publish(...args):{url:'https://chartshub.test/new',count:1,updatedAt:'2026-10-10T00:00:00.000Z'};},
  remove:async(...args)=>{calls.push('DELETE');return remove?remove(...args):{url:null,count:0,updatedAt:null};}};
 const library={matchingSnapshot:()=>scope,requestLibraryForSharing:prepare??(async()=>({songs:[{id:'b'.repeat(64),title:'Synthetic song',artist:'Synthetic artist',charter:'Synthetic charter'}],...scope,unavailableCount:0}))};
 const songRequests={snapshot:()=>({rules:structuredClone(rules)})};
 const create=new vm.Script(`(function(sharingClient,library,songRequests){
  let disposing=false,stopTask=null,hostActive=true,lifecycleRevision=0;
  const publishPanel=()=>{};
  let catalogueAccess=true,catalogueWidgetTicket=0,catalogueWidgetEnabled=false,catalogueWidget=null,catalogueWidgetLoad=null;
  const unregisterCatalogueShortcut=()=>{},registerCatalogueShortcut=()=>{};
  ${declarations}
  ${source.slice(start,end)}
  ${source.slice(accountStart,accountEnd)}
  return {refresh:refreshSongRequestShare,change:changeSongRequestShare,available:setCatalogueAvailable,state:()=>structuredClone(songRequestShare),close:()=>{disposing=true;hostActive=false;lifecycleRevision++;}};
 })`,{filename:'companion/host.cjs share orchestration'}).runInNewContext({structuredClone});
 return {host:create(sharingClient,library,songRequests),calls,scope,rules};
}

test('an old status response cannot overwrite a successful explicit removal',async()=>{
 const status=deferred(),f=fixture({status:()=>status.promise});const refreshing=f.host.refresh();
 assert.equal((await f.host.change(true)).ok,true);assert.equal(f.host.state().url,null);
 status.resolve({url:'https://chartshub.test/revoked',count:3,updatedAt:'2026-10-09T00:00:00.000Z'});await refreshing;
 assert.equal(f.host.state().url,null);assert.equal(f.host.state().count,0);assert.deepEqual(f.calls,['DELETE']);
});

test('an old status response cannot overwrite a successful explicit publication',async()=>{
 const status=deferred(),f=fixture({status:()=>status.promise});const refreshing=f.host.refresh();
 assert.equal((await f.host.change()).ok,true);assert.equal(f.host.state().url,'https://chartshub.test/new');
 status.resolve({url:'https://chartshub.test/old',count:99,updatedAt:'2026-10-09T00:00:00.000Z'});await refreshing;
 assert.equal(f.host.state().url,'https://chartshub.test/new');assert.equal(f.host.state().count,1);assert.deepEqual(f.calls,['PUT']);
});

test('closing during local preparation never sends a remote publication request',async()=>{
 const prepared=deferred(),entered=deferred(),f=fixture({prepare:()=>{entered.resolve();return prepared.promise;}});
 const publishing=f.host.change();await entered.promise;f.host.close();prepared.resolve({songs:[],...f.scope,unavailableCount:0});
 assert.equal((await publishing).ok,false);assert.deepEqual(f.calls,[]);assert.equal(f.host.state().busy,false);
});

test('changing scan revision or session rules during preparation prevents publication',async()=>{
 for(const change of ['revision','rules']){
  const prepared=deferred(),entered=deferred(),f=fixture({prepare:()=>{entered.resolve();return prepared.promise;}});
  const before={...f.scope},publishing=f.host.change();await entered.promise;
  if(change==='revision')f.scope.revision++;else f.rules.instrument='guitar';
  prepared.resolve({songs:[],...before,unavailableCount:0});assert.equal((await publishing).ok,false);assert.deepEqual(f.calls,[]);
 }
});

test('account invalidation removes cached share capabilities and ignores the old account status response',async()=>{
 const old=deferred();let reads=0;
 const f=fixture({status:()=>++reads===1?old.promise:Promise.resolve({url:'https://chartshub.test/new-owner',count:5,updatedAt:'2026-10-10T00:00:00.000Z'})});
 await f.host.change();assert.equal(f.host.state().url,'https://chartshub.test/new');
 const refreshing=f.host.refresh();f.host.available(false);assert.equal(f.host.state().url,null);assert.equal(f.host.state().count,0);
 f.host.available(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.host.state().url,'https://chartshub.test/new-owner');
 old.resolve({url:'https://chartshub.test/old-owner',count:9,updatedAt:'2026-10-09T00:00:00.000Z'});await refreshing;
 assert.equal(f.host.state().url,'https://chartshub.test/new-owner');assert.equal(f.host.state().error,null);
});

test('an old publishing failure cannot overwrite the revalidated account share state',async()=>{
 const network=deferred(),entered=deferred(),f=fixture({publish:()=>{entered.resolve();return network.promise;},status:async()=>({url:'https://chartshub.test/new-owner',count:5,updatedAt:'2026-10-10T00:00:00.000Z'})});
 const publishing=f.host.change();await entered.promise;f.host.available(false);f.host.available(true);await new Promise(resolve=>setImmediate(resolve));
 network.reject(Error('The old account request failed'));assert.equal((await publishing).ok,false);
 assert.equal(f.host.state().url,'https://chartshub.test/new-owner');assert.equal(f.host.state().error,null);assert.equal(f.host.state().busy,false);
});
