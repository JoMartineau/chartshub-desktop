'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const { createSongRequestShareSync, songRequestShareKey } = require('../companion/song-request-share-sync.cjs');

// Run the actual host orchestration with controlled adapters, without Electron,
// native windows, user sessions, network access or any Songs filesystem writes.
const source=fs.readFileSync(path.join(__dirname,'../companion/host.cjs'),'utf8');
const start=source.indexOf('  function songRequestShareContext()');
const end=source.indexOf('  catalogue =',start);
assert.ok(start>=0&&end>start,'The share orchestration must remain identifiable');
const declarations=source.split(/\r?\n/).filter(line=>/^  let songRequestShare\w*\s*=/.test(line)).join('\n');
const accountStart=source.indexOf('  function setCatalogueAvailable(enabled)');
const accountEnd=source.indexOf('  async function requireCatalogueAuthorization(',accountStart);
assert.ok(accountStart>=0&&accountEnd>accountStart,'The account access lifecycle must remain identifiable');
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function clock(){let now=0,next=0;const jobs=new Map();return {
 setTimer:(fn,delay)=>{const id=++next;jobs.set(id,{fn,due:now+delay});return id;},clearTimer:id=>jobs.delete(id),
 async advance(delay){const until=now+delay;for(;;){const task=[...jobs].filter(([,value])=>value.due<=until).sort((a,b)=>a[1].due-b[1].due)[0];if(!task)break;now=task[1].due;jobs.delete(task[0]);task[1].fn();await new Promise(resolve=>setImmediate(resolve));}now=until;await new Promise(resolve=>setImmediate(resolve));}
};}
function fixture({status,publish,remove,prepare}={}){
 const calls=[],cancelled=[],rules={maxDurationMinutes:null,instrument:'all',difficulty:'all'},scope={rootKey:'a'.repeat(64),revision:1},time=clock();
 const libraryState={status:'ready',count:1,settings:{watch:false,refreshOnStart:true}},items=[{id:'b'.repeat(64),fingerprint:'original',title:'Synthetic song',artist:'Synthetic artist',charter:'Synthetic charter'}];
 let preparationCancelled=0,watched=0,visualStops=0;
 const catalogue={cancelSearch:(scope,clear)=>cancelled.push({scope,clear})};
 const sharingClient={capture:async()=>({userId:'opaque-test-owner',generation:1}),status:status??(async()=>({url:null,count:0,updatedAt:null})),
  publish:async(...args)=>{calls.push('PUT');return publish?publish(...args):{url:'https://chartshub.test/new',count:1,updatedAt:'2026-10-10T00:00:00.000Z'};},
  remove:async(...args)=>{calls.push('DELETE');return remove?remove(...args):{url:null,count:0,updatedAt:null};}};
 const library={status:()=>libraryState,matchingSnapshot:()=>({...scope,items}),
  configure:async value=>{Object.assign(libraryState.settings,value);watched++;},cancelLibrarySharing:async()=>{preparationCancelled++;},
  requestLibraryForSharing:prepare??(async()=>({songs:items.map(({fingerprint,...item})=>item),...scope,unavailableCount:0}))};
 const songRequests={snapshot:()=>({rules:structuredClone(rules)})};
 const create=new vm.Script(`(function(sharingClient,library,songRequests,catalogue,songVisuals){
  let disposing=false,stopTask=null,hostActive=true,lifecycleRevision=0;
  const publishPanel=()=>{};
  const logger={warn:()=>{}};
  let catalogueAccess=true,catalogueWidgetTicket=0,catalogueWidgetEnabled=false,catalogueWidget=null,catalogueWidgetLoad=null;
  const unregisterCatalogueShortcut=()=>{},registerCatalogueShortcut=()=>{};
  ${declarations}
  ${source.slice(start,end)}
  ${source.slice(accountStart,accountEnd)}
  return {refresh:refreshSongRequestShare,change:changeSongRequestShare,available:setCatalogueAvailable,state:()=>structuredClone(songRequestShare),changed:()=>songRequestShareSync.update(),sync:()=>songRequestShareSync.status(),
   close:()=>{disposing=true;hostActive=false;lifecycleRevision++;songRequestShareRevision++;songRequestShareController?.abort();songRequestShare.busy=false;return songRequestShareSync.pause();}};
 })`,{filename:'companion/host.cjs share orchestration'}).runInNewContext({structuredClone,AbortController,songRequestShareKey,
  createSongRequestShareSync:options=>createSongRequestShareSync({...options,...time}),shareErrorCode:require('../companion/song-request-share-contract.cjs').shareErrorCode});
 return {host:create(sharingClient,library,songRequests,catalogue,{stop(){visualStops++;}}),calls,cancelled,scope,rules,time,items,libraryState,watched:()=>watched,preparationCancelled:()=>preparationCancelled,visualStops:()=>visualStops};
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
 assert.equal(f.visualStops(),1,'account invalidation revokes the injected visual source');
 assert.deepEqual(f.cancelled,[{scope:'panel',clear:true},{scope:'widget',clear:true}]);
 f.host.available(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.host.state().url,'https://chartshub.test/new-owner');
 old.resolve({url:'https://chartshub.test/old-owner',count:9,updatedAt:'2026-10-09T00:00:00.000Z'});await refreshing;
 assert.equal(f.host.state().url,'https://chartshub.test/new-owner');assert.equal(f.host.state().error,null);
});

test('an old publishing failure cannot overwrite the revalidated account share state',async()=>{
 const network=deferred(),entered=deferred(),f=fixture({publish:()=>{entered.resolve();return network.promise;},status:async()=>({url:'https://chartshub.test/new-owner',count:5,updatedAt:'2026-10-10T00:00:00.000Z'})});
 const publishing=f.host.change();await entered.promise;f.host.available(false);f.host.available(true);await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(f.cancelled,[{scope:'panel',clear:true},{scope:'widget',clear:true}]);
 network.reject(Error('The old account request failed'));assert.equal((await publishing).ok,false);
 assert.equal(f.host.state().url,'https://chartshub.test/new-owner');assert.equal(f.host.state().error,null);assert.equal(f.host.state().busy,false);
});

test('failed replacement keeps the published link and exposes only the safe actionable reason',async()=>{
 let failed=false;
 const f=fixture({publish:async()=>{if(failed)throw Object.assign(Error('private account path'),{code:'SHARE_METADATA_LIMIT'});return {url:'https://chartshub.test/previous',count:83401,updatedAt:'2026-10-10T00:00:00Z'};}});
 await f.host.change();failed=true;
 assert.equal((await f.host.change()).ok,false);assert.equal(f.host.state().url,'https://chartshub.test/previous');assert.equal(f.host.state().count,83401);
 assert.equal(f.host.state().error,'SHARE_METADATA_LIMIT');assert.equal(f.host.state().busy,false);assert.equal(f.host.state().progress,null);
});

test('account invalidation aborts an active upload signal and ignores its late completion',async()=>{
 const entered=deferred(),done=deferred();let signal;
 const f=fixture({publish:async(_payload,_account,options)=>{signal=options.signal;entered.resolve();await done.promise;return {url:'https://chartshub.test/stale',count:1,updatedAt:'2026-10-10T00:00:00Z'};}});
 const publishing=f.host.change();await entered.promise;f.host.available(false);assert.equal(signal.aborted,true);
 done.resolve();assert.equal((await publishing).ok,false);assert.equal(f.host.state().url,null);assert.equal(f.host.state().error,null);
});

test('publication enables folder detection once, updates the same link after additions and skips unchanged scans',async()=>{
 const url='https://chartshub.test/stable',f=fixture({publish:async payload=>({url,count:payload.songs.length,updatedAt:'2026-10-10T00:00:00Z'})});
 assert.equal((await f.host.change()).ok,true);assert.equal(f.watched(),1);assert.equal(f.libraryState.settings.watch,true);
 f.libraryState.settings.watch=false; // An explicit later preference remains respected.
 f.scope.revision++;f.host.changed();await f.time.advance(10000);assert.deepEqual(f.calls,['PUT']);
 f.items.push({...f.items[0],id:'c'.repeat(64),title:'Added song',fingerprint:'added'});f.scope.revision++;f.host.changed();
 await f.time.advance(1500);assert.deepEqual(f.calls,['PUT','PUT']);assert.equal(f.host.state().url,url);assert.equal(f.host.state().count,2);
 assert.equal(f.watched(),1);assert.equal(f.libraryState.settings.watch,false);
 f.rules.instrument='guitar';f.host.changed();await f.time.advance(1500);assert.equal(f.calls.length,3);
 await f.host.close();
});

test('an already published list resumes only after the scan is ready and preserves disabled detection',async()=>{
 const url='https://chartshub.test/stable',f=fixture({status:async()=>({url,count:1,updatedAt:'2026-10-10T00:00:00Z'}),publish:async()=>({url,count:1,updatedAt:'2026-10-10T00:00:00Z'})});
 f.libraryState.status='scanning';await f.host.refresh();await f.time.advance(10000);assert.deepEqual(f.calls,[]);
 f.libraryState.status='ready';f.host.changed();await f.time.advance(1500);assert.deepEqual(f.calls,['PUT']);
 assert.equal(f.watched(),0);assert.equal(f.libraryState.settings.watch,false);await f.host.close();
});

test('withdrawal waits for an automatic upload to cancel and its late completion cannot restore the list',async()=>{
 const url='https://chartshub.test/stable',gate=deferred();let signal;
 const f=fixture({status:async()=>({url,count:1,updatedAt:'2026-10-10T00:00:00Z'}),publish:async(_payload,_account,options)=>{signal=options.signal;return gate.promise;}});
 await f.host.refresh();await f.time.advance(1500);assert.deepEqual(f.calls,['PUT']);
 const removing=f.host.change(true);assert.equal(signal.aborted,true);assert.equal(f.preparationCancelled(),1);
 assert.equal((await f.host.change()).ok,false,'cannot race another explicit action');
 gate.resolve({url,count:1,updatedAt:'2026-10-10T00:00:00Z'});assert.equal((await removing).ok,true);
 assert.deepEqual(f.calls,['PUT','DELETE']);assert.equal(f.host.state().url,null);assert.equal(f.host.sync().enabled,false);
 f.items[0].fingerprint='later';f.scope.revision++;f.host.changed();await f.time.advance(10000);assert.deepEqual(f.calls,['PUT','DELETE']);
});

test('automatic preparation is cancelled on root changes and sends only the new ready library',async()=>{
 const old=deferred(),url='https://chartshub.test/stable';let prepareCount=0;
 const f=fixture({status:async()=>({url,count:1,updatedAt:'2026-10-10T00:00:00Z'}),prepare:()=>++prepareCount===1?old.promise:Promise.resolve({songs:[{id:'c'.repeat(64),title:'New root',artist:'Artist',charter:'Charter'}],...f.scope,unavailableCount:0})});
 const previous={...f.scope};await f.host.refresh();await f.time.advance(1500);
 f.scope.rootKey='d'.repeat(64);f.scope.revision++;f.libraryState.status='scanning';f.host.changed();assert.equal(f.preparationCancelled(),1);
 old.resolve({songs:[],...previous,unavailableCount:0});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.calls,[]);
 f.libraryState.status='ready';f.host.changed();await f.time.advance(1500);assert.deepEqual(f.calls,['PUT']);await f.host.close();
});

test('an uncertain manual commit followed by reverting rules repairs the remote list automatically',async()=>{
 const url='https://chartshub.test/stable',gate=deferred(),entered=deferred();let remote='all',count=0;
 const f=fixture({publish:async payload=>{
  const selected=payload.rules.instrument;if(++count===2){entered.resolve();await gate.promise;}remote=selected;
  return {url,count:1,updatedAt:'2026-10-10T00:00:00Z'};
 }});
 assert.equal((await f.host.change()).ok,true);f.rules.instrument='guitar';
 const manual=f.host.change();await entered.promise;f.rules.instrument='all';f.host.changed();
 gate.resolve();assert.equal((await manual).ok,false);assert.equal(remote,'guitar');
 await f.time.advance(1500);assert.equal(remote,'all');assert.deepEqual(f.calls,['PUT','PUT','PUT']);await f.host.close();
});
