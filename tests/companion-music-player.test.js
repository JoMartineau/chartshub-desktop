'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMusicPlayer } = require('../companion/music-player.cjs');
const { queryMusicLibrary } = require('../companion/music-library-query.cjs');
const { validCommand, trustedCatalogueWidgetCommand, trustedFiltersWidgetCommand } = require('../companion/security.cjs');
function fixture(resolve) {
  let state = 'ready', rootKey = 'root-A', revision = 1;
  const songs = ['Alpha','Beta','Gamma'].map((title,i) => ({id:String(i+1).repeat(64),title,artist:'Artist',charter:'Creator'})), actions=[];
  const library = { status: () => ({status:state}), matchingSnapshot: () => ({rootKey,revision,items:songs}),
    resolvePlaybackSong: async id => resolve ? resolve(id) : ({...songs.find(item=>item.id===id),rootKey,revision,rootPath:'PRIVATE_Songs',folderPath:'PRIVATE_FOLDER',mediaMode:'song',
      durationMs:180000,media:[{name:'song.wav',path:'PRIVATE_AUDIO'}],artwork:{path:'PRIVATE_ALBUM'},video:{path:'PRIVATE_VIDEO'}}) };
  return {library,songs,actions,change:next=>{if(next.state)state=next.state;if(next.rootKey)rootKey=next.rootKey;if(next.revision)revision=next.revision;},
    player:createMusicPlayer({library,onAction:value=>actions.push(value),respond:async(entry,request,options)=>{options.onClose();return new Response(entry.path);}})};
}
test('local player starts silent, selects explicitly and exposes audio capabilities only to its sole engine',async()=>{
  const f=fixture();assert.equal(f.player.snapshot().playing,false);assert.equal(f.player.snapshot().selection,null);assert.equal(f.actions.length,0);
  await f.player.select(f.songs[0].id);
  const panel=f.player.snapshot(),engine=f.player.snapshot({engine:true});
  assert.equal(panel.selection.title,'Alpha');assert.equal(panel.selection.durationMs,180000);assert.equal(panel.selection.mediaUrls,undefined);
  assert.doesNotMatch(JSON.stringify(panel),/PRIVATE_|rootKey|folderPath/);assert.equal(f.actions.at(-1).action,'play');
  const audio=engine.selection.mediaUrls[0].url;
  assert.equal(await (await f.player.serve(new Request(audio))).text(),'PRIVATE_AUDIO');
  const art=new URL(panel.selection.artworkUrl), guessed=audio.replace(/music-media\/[^/]+\/0/,'music-media/'+art.pathname.split('/').at(-1)+'/0');
  assert.equal((await f.player.serve(new Request(guessed))).status,404,'artwork capability cannot be reused for audio');
  assert.equal((await f.player.serve(new Request(audio+'?path=outside'))),null);
  assert.equal((await f.player.serve(new Request(audio,{method:'POST'}))).status,404);
});
test('an unsupported format leaves no audio capability and reports its cause to both player surfaces', async()=>{
  const f=fixture(async()=>{throw Object.assign(Error('Unsupported'),{code:'LIBRARY_MEDIA_UNSUPPORTED'});});
  assert.deepEqual(await f.player.select(f.songs[0].id),{ok:false,code:'unsupported'});
  for(const engine of [false,true]) { const state=f.player.snapshot({engine});assert.equal(state.selection,null);assert.equal(state.error,'unsupported');assert.equal(state.playing,false);assert.equal(state.loading,false); }
  assert.equal(f.actions.length,0);
});
test('next and previous change the same player, revoke prior capabilities and keep session choices',async()=>{
  const f=fixture();await f.player.select(f.songs[0].id);const old=f.player.snapshot({engine:true}).selection.mediaUrls[0].url;
  f.player.setWidget(true);f.player.setVideo(false);await f.player.control('next');
  assert.equal(f.player.snapshot().selection.title,'Beta');assert.equal(f.player.snapshot().widgetEnabled,true);assert.equal(f.player.snapshot().videoEnabled,false);
  assert.equal((await f.player.serve(new Request(old))).status,404);await f.player.control('previous');assert.equal(f.player.snapshot().selection.title,'Alpha');
  await f.player.control('previous');assert.equal(f.player.snapshot().selection.title,'Gamma');
});
test('only a current bounded engine report can alter playback; controls seek, pause, volume and stop together',async()=>{
  const f=fixture();await f.player.select(f.songs[0].id);const revision=f.player.snapshot().revision;
  const report={revision,epoch:f.player.snapshot().playbackEpoch,playing:true,currentTime:42,duration:180,volume:.6};assert.equal(f.player.report(report).ok,true);
  assert.equal(f.player.report({...report,revision:revision-1}).ok,false);assert.equal(f.player.report({...report,duration:Infinity}).ok,false);
  await f.player.control('seek',200);assert.equal(f.actions.at(-1).value,180);await f.player.control('pause');assert.equal(f.player.snapshot().playing,false);
  await f.player.control('volume',.2);assert.equal(f.player.snapshot().volume,.2);assert.equal((await f.player.control('volume',2)).ok,false);
  await f.player.control('stop');assert.equal(f.player.snapshot().currentTime,0);assert.equal(f.player.snapshot().selection.title,'Alpha');
  assert.equal(f.player.acceptSpectrum({revision,bands:Array(32).fill(.4)}),true);assert.equal(f.player.acceptSpectrum({revision,bands:Array(32).fill(NaN)}),false);
  f.player.setWidget(false);assert.equal(f.player.snapshot().selection.title,'Alpha','hiding widget never creates or stops a second engine');
});
test('delayed same-song reports cannot undo stop, pause, resume or seeking',async()=>{
  for(const action of ['stop','pause','resume','seek']) {
    const f=fixture();await f.player.select(f.songs[0].id);
    const previous={revision:f.player.snapshot().revision,epoch:f.player.snapshot().playbackEpoch,playing:true,currentTime:42,duration:180,volume:.6};
    assert.equal(f.player.report(previous).ok,true);
    await f.player.control(action==='resume'?'pause':action,action==='seek'?12:undefined);
    if(action==='resume') await f.player.control('play');
    const before=f.player.snapshot();assert.equal(before.revision,previous.revision);
    assert.equal(f.player.report(previous).ok,false,action+' must reject a report from the previous action');
    assert.equal(f.player.report({...previous,errorCode:'playback'}).ok,false,'a delayed error cannot cancel the current play intent');
    assert.deepEqual(f.player.snapshot(),before);
    const fresh={...previous,epoch:before.playbackEpoch,playing:action==='resume'||action==='seek',currentTime:action==='stop'?0:before.currentTime};
    assert.equal(f.player.report(fresh).ok,true,'the current engine report remains accepted');
    assert.equal(f.player.snapshot().playing,fresh.playing);assert.equal(f.player.snapshot().currentTime,fresh.currentTime);
  }
});
test('library loss clears selection and stale reports cannot restore it',async()=>{
  const f=fixture();await f.player.select(f.songs[0].id);const old=f.player.snapshot({engine:true});
  f.change({revision:2});f.player.libraryChanged();assert.equal(f.player.snapshot().selection,null);assert.equal(f.player.snapshot().error,'unavailable');
  assert.equal((await f.player.serve(new Request(old.selection.mediaUrls[0].url))).status,404);
  assert.equal(f.player.report({revision:old.revision,epoch:old.playbackEpoch,playing:true,currentTime:1,duration:180,volume:.7}).ok,false);
});
test('pending resolutions cannot overwrite a newer choice or restart after stop',async()=>{
  const pending=new Map(),f=fixture(id=>new Promise(resolve=>pending.set(id,resolve)));
  const a=f.player.select(f.songs[0].id),b=f.player.select(f.songs[1].id);
  const plan=i=>({...f.songs[i],rootKey:'root-A',revision:1,media:[{name:'song.wav'}]});
  pending.get(f.songs[1].id)(plan(1));await b;pending.get(f.songs[0].id)(plan(0));assert.equal((await a).ok,false);assert.equal(f.player.snapshot().selection.title,'Beta');
  const c=f.player.select(f.songs[2].id);f.player.stop();pending.get(f.songs[2].id)(plan(2));assert.equal((await c).ok,false);assert.equal(f.player.snapshot().selection,null);
});
test('select and stop abort active media readers',async()=>{
  const f=fixture();let signal;
  const player=createMusicPlayer({library:f.library,respond:async(entry,request,options)=>{signal=options.signal;return new Response('audio');}});
  await player.select(f.songs[0].id);await player.serve(new Request(player.snapshot({engine:true}).selection.mediaUrls[0].url));
  assert.equal(signal.aborted,false);player.stop();assert.equal(signal.aborted,true);
});
test('combined reader filters are accent insensitive, retain albums and paginate without publishing paths',()=>{
  const items=Array.from({length:116},(_,i)=>({id:String(i),title:'Été '+i,artist:i%2?'Björk':'Autre',charter:'Créateur',album:'Océan',year:'2026',audio:i%2?'present':'missing',format:'chart',relativePath:'PRIVATE_PATH'}));
  const doc={revision:7,items},result=queryMusicLibrary(doc,{query:'ete createur',filters:{artist:'bjork',album:'ocean',audio:'present'},offset:50,limit:50});
  assert.equal(result.total,58);assert.equal(result.items.length,8);assert.equal(result.revision,7);assert.equal(result.items[0].album,'Océan');assert.doesNotMatch(JSON.stringify(result),/PRIVATE|relativePath/);
  assert.equal(queryMusicLibrary(doc,{query:'',filters:{year:'1990'}}).total,0);assert.equal(doc.items[0].title,'Été 0');
  assert.throws(()=>queryMusicLibrary(doc,{query:'',filters:{rootPath:'outside'}}));assert.throws(()=>queryMusicLibrary(doc,{query:'',limit:51}));
});
test('player IPC excludes arbitrary paths, unbounded values and private reports from other mini windows',()=>{
  assert.equal(validCommand('player.select',{id:'a'.repeat(64)},[]),true);assert.equal(validCommand('player.select',{id:'../outside'},[]),false);
  assert.equal(validCommand('player.control',{action:'seek',value:NaN},[]),false);assert.equal(validCommand('player.control',{action:'play',url:'file://outside'},[]),false);
  const appearance={backgroundColor:'#0b1322',textColor:'#eaf2ff',accentColor:'#22d3ee',secondaryColor:'#a855f7',spectrumModel:'circle'};
  assert.equal(validCommand('player.appearance',{appearance},[]),true);assert.equal(validCommand('player.appearance',{appearance:{...appearance,backgroundColor:'url(file://outside)'}},[]),false);
  const filters={artist:'',charter:'',album:'',year:'',genre:'Metal',audio:'all',format:'all',instrument:'guitar',difficulty:'expert'};
  assert.equal(validCommand('player.search',{query:'',filters},[]),true);
  assert.equal(validCommand('player.search',{query:'',filters:{...filters,genre:'Metal\u0000Rock'}},[]),false);
  assert.equal(validCommand('player.search',{query:'',filters:{...filters,instrument:'invalid'}},[]),false);
  assert.equal(validCommand('player.search',{query:'',filters:{...filters,difficulty:'invalid'}},[]),false);
  assert.equal(validCommand('player.report',{revision:1,epoch:1,playing:false,currentTime:0,duration:180,volume:.5},[]),true);
  for(const command of ['player.search','player.select','player.report','player.spectrum','player.appearance']){
    assert.equal(trustedCatalogueWidgetCommand({},null,command,{}),false);assert.equal(trustedFiltersWidgetCommand({},null,command,{}),false);
  }
});
test('engine reports require an explicit bounded action epoch and reject extra fields',()=>{
  const report={revision:1,epoch:0,playing:false,currentTime:0,duration:180,volume:.5};
  assert.equal(validCommand('player.report',report,[]),true);
  assert.equal(validCommand('player.report',{...report,errorCode:'playback'},[]),true);
  const {epoch,...missing}=report;assert.equal(validCommand('player.report',missing,[]),false);
  for(const epoch of [undefined,-1,.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'0',null]) assert.equal(validCommand('player.report',{...report,epoch},[]),false);
  assert.equal(validCommand('player.report',{...report,path:'PRIVATE_PATH'},[]),false);
});
