'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createSongRequestDiscovery}=require('../companion/song-request-discovery.cjs');
const {createSongRequests}=require('../companion/song-requests.cjs');
const root='a'.repeat(64),songId='b'.repeat(64);
const input=(n=1)=>({platform:'twitch',eventId:'event-'+n,viewerId:'private-viewer-'+n,viewerName:'Viewer '+n,query:'Signal de test '+n});
function fixture(receive=async()=>({ok:true})){
 let context={active:true,rootKey:root,lifecycle:1},calls=0;
 const service=createSongRequestDiscovery({getContext:()=>context,receive:async(...args)=>{calls++;return receive(...args);}});
 return{service,setContext:patch=>{context={...context,...patch};},calls:()=>calls};
}
test('capturing and viewing a missing request never searches downloads or queues a chart',()=>{
 const f=fixture();assert.equal(f.service.capture(input()),true);assert.equal(f.calls(),0);
 const s=f.service.status();assert.equal(s.items[0].state,'missing');assert.equal(s.items[0].query,'Signal de test 1');
 assert.doesNotMatch(JSON.stringify(s),/private-viewer|event-1|rootKey|isCurrent/);
 assert.deepEqual(f.service.search(s.items[0].id),{query:'Signal de test 1'});assert.equal(f.calls(),0);
});
test('only active scoped requests are collected and duplicate provider events are ignored',()=>{
 const f=fixture();assert.equal(f.service.capture(input()),true);assert.equal(f.service.capture(input()),false);
 f.setContext({active:false});assert.equal(f.service.capture(input(2)),false);assert.equal(f.service.status().items.length,0);
 f.setContext({active:true,rootKey:'c'.repeat(64)});assert.equal(f.service.capture(input(3)),true);assert.equal(f.service.status().items.length,1);
});
test('the inbox is bounded, sanitised plain data and contains no claimed provider credentials',()=>{
 const f=fixture();for(let n=0;n<300;n++)f.service.capture(input(n));const s=f.service.status();assert.equal(s.items.length,20);
 const value={...input(999),viewerName:'<img>\u0000\u202e',query:'<script>demo()</script>\u0000\u202e',token:'private-token'};
 assert.equal(f.service.capture(value),true);assert.doesNotMatch(JSON.stringify(f.service.status()),/private-token|\\u0000|\\u202e/);
 assert.equal(f.service.capture({...input(9999),platform:'untrusted'}),false);
});
test('explicit confirmation queues only the chosen installed ID with the original private provider identity',async()=>{
 let received;const f=fixture(async(value,options)=>{received=value;assert.equal(options.isCurrent(),true);return{ok:true};});
 f.service.capture(input());const id=f.service.status().items[0].id;
 assert.deepEqual(await f.service.confirm(id,songId),{ok:true,code:null});assert.equal(f.calls(),1);
 assert.equal(received.viewerId,input().viewerId);assert.equal(received.songId,songId);assert.equal(received.eventId,'discovery:'+id+':1');assert.equal(received.query,undefined);
 assert.equal(f.service.status().items[0].state,'queued');await assert.rejects(f.service.confirm(id,songId),{code:'DISCOVERY_BUSY'});
});
test('a root or account lifecycle change revokes an awaited confirmation and its original guard',async()=>{
 for(const patch of [{rootKey:'c'.repeat(64)},{active:false},{lifecycle:2}]){
  let finish,guard;const f=fixture((_value,options)=>{guard=options.isCurrent;return new Promise(resolve=>{finish=resolve;});});f.service.capture(input());
  const task=f.service.confirm(f.service.status().items[0].id,songId);f.setContext(patch);assert.equal(guard(),false);f.service.update();finish({ok:true});
  await assert.rejects(task,{code:'DISCOVERY_UNAVAILABLE'});assert.deepEqual(f.service.status().items,[]);
 }
});
test('reading status alone purges the old inbox immediately after auth root or lifecycle revocation',()=>{
 for(const patch of [{active:false},{rootKey:'c'.repeat(64)},{lifecycle:2}]){const f=fixture();f.service.capture(input());assert.equal(f.service.status().items.length,1);f.setContext(patch);assert.deepEqual(f.service.status().items,[]);}
});
test('rules and library rejection remain visible without inventing a queued request',async()=>{
 const f=fixture(async()=>({ok:false,code:'duration_limit'}));f.service.capture(input());const id=f.service.status().items[0].id;
 assert.deepEqual(await f.service.confirm(id,songId),{ok:false,code:'duration_limit'});assert.equal(f.service.status().items[0].state,'missing');
 assert.equal(f.service.status().items[0].error,'duration_limit');f.service.dismiss(id);assert.deepEqual(f.service.status().items,[]);
});
test('only a verified missing request reaches the optional inbox observer after normal queue limits',async()=>{
 const captured=[];const core=createSongRequests({getLibrarySnapshot:()=>({rootKey:root,revision:1,items:[]}),searchSongs:async()=>({items:[],total:0,revision:1}),resolveSong:async()=>null,onMissingRequest:value=>{captured.push(value);return Promise.reject(Error('optional observer'));}});
 core.configure({enabled:true});
 assert.equal((await core.receive({...input(1),query:'!sr Signal de test'})).code,'not_found');
 assert.equal(captured.length,1);assert.equal(captured[0].query,'Signal de test');
 assert.equal((await core.receive({...input(1),query:'!sr Signal de test'})).code,'duplicate_event');
 await core.receive({...input(2),query:'!vote Signal de test'});await core.receive({...input(3),query:'!anotherbot'});
 core.configure({enabled:false});await core.receive({...input(4),query:'!sr Signal de test'});
 assert.equal(captured.length,1);await new Promise(resolve=>setImmediate(resolve));
});
test('natural title by artist and titre par artiste try literal matching before a bounded artist-title fallback',async()=>{
 for(const separator of ['by','par']){
  const queries=[],metadata={id:songId,title:'Signal de test',artist:'Projet fictif',charter:'Démo'};
  const core=createSongRequests({getLibrarySnapshot:()=>({rootKey:root,revision:1,items:[metadata]}),searchSongs:async({query})=>{queries.push(query);return{items:query==='Projet fictif Signal de test'?[metadata]:[],total:query==='Projet fictif Signal de test'?1:0,revision:1};},resolveSong:async()=>({...metadata,durationMs:25000,tracks:[]})});
  core.configure({enabled:true});assert.equal((await core.receive({...input(),query:`!sr Signal de test ${separator} Projet fictif`})).ok,true);
  assert.deepEqual(queries,[`Signal de test ${separator} Projet fictif`,'Projet fictif Signal de test']);
 }
});
test('a literal title containing by keeps its original result and never triggers artist rewriting',async()=>{
 const queries=[],metadata={id:songId,title:'Signal by night',artist:'Projet fictif',charter:'Démo'};
 const core=createSongRequests({getLibrarySnapshot:()=>({rootKey:root,revision:1,items:[metadata]}),searchSongs:async({query})=>{queries.push(query);return{items:[metadata],total:1,revision:1};},resolveSong:async()=>({...metadata,durationMs:25000,tracks:[]})});
 core.configure({enabled:true});assert.equal((await core.receive({...input(),query:'!sr Signal by night'})).ok,true);assert.deepEqual(queries,['Signal by night']);
});
test('a real queue allows an explicit retry after corrected rules instead of treating it as the old event',async()=>{
 const metadata={id:songId,title:'Signal de test',artist:'Projet fictif',charter:'Démo',durationMs:100000,tracks:[]};let core;
 const service=createSongRequestDiscovery({getContext:()=>({active:true,rootKey:root,lifecycle:1}),receive:(...args)=>core.receive(...args)});
 core=createSongRequests({getLibrarySnapshot:()=>({rootKey:root,revision:1,items:[metadata]}),searchSongs:async()=>({items:[],total:0,revision:1}),resolveSong:async()=>metadata});
 core.configure({enabled:true,rules:{maxDurationMinutes:1}});service.capture(input());const id=service.status().items[0].id;
 assert.equal((await service.confirm(id,songId)).code,'duration_limit');core.configure({rules:{maxDurationMinutes:null}});
 assert.equal((await service.confirm(id,songId)).ok,true);assert.equal(core.snapshot().requests.length,1);assert.equal(service.status().items[0].state,'queued');
});
