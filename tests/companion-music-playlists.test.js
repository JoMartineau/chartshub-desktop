'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { changeMusicPlaylist } = require('../companion/music-playlists.cjs');
const { createMusicPlayer } = require('../companion/music-player.cjs');
const { DEFAULT_APPEARANCE } = require('../companion/music-player-preferences.cjs');
const { validCommand, trustedCatalogueWidgetCommand, trustedFiltersWidgetCommand } = require('../companion/security.cjs');
const rootKey = 'a'.repeat(64), listId = '12345678-1234-4123-8123-123456789abc';
const items = ['Alpha','Beta','Gamma'].map((title,index) => ({ id: String(index+1).repeat(64), title, artist:'Test Artist' }));
const libraryDocument = { rootKey, revision: 1, items };
const prefs = (overrides={}) => ({ appearance:{...DEFAULT_APPEARANCE},videoEnabled:true,volume:.7,shuffle:false,playlists:[],canWrite:true,error:null,...overrides });
const playlist = (songIds=items.map(item=>item.id)) => ({ id:listId,name:'Mes chansons',rootKey,songIds });
const endEvent = player => ({ revision: player.snapshot().revision, epoch: player.snapshot().playbackEpoch });
function fixture(preferences=prefs(), resolver) {
  let document=structuredClone(libraryDocument),status='ready'; const actions=[];
  const library={status:()=>({status}),matchingSnapshot:()=>document,
    resolvePlaybackSong:async id=>resolver ? resolver(id,document) : ({...document.items.find(item=>item.id===id),rootKey:document.rootKey,revision:document.revision,media:[{name:'song.wav'}],durationMs:60000})};
  const player=createMusicPlayer({library,preferences,randomIndex:()=>0,onAction:action=>actions.push(action)});
  return {player,actions,change:next=>{document={...document,...next};if(next.status)status=next.status;}};
}
test('playlist creation, rename and individual membership changes use only current installed IDs without mutating input',()=>{
  const original=prefs(); let changed=changeMusicPlaylist(original,'create',{name:'  Mes chansons  '},libraryDocument);
  assert.equal(original.playlists.length,0);const id=changed.playlistId;assert.match(id,/^[a-f0-9-]{36}$/);assert.equal(changed.playlists[0].name,'Mes chansons');
  changed=changeMusicPlaylist({...original,playlists:changed.playlists},'add',{id,songId:items[0].id},libraryDocument);
  changed=changeMusicPlaylist({...original,playlists:changed.playlists},'add',{id,songId:items[1].id},libraryDocument);
  const before=structuredClone(changed.playlists);
  changed=changeMusicPlaylist({...original,playlists:changed.playlists},'rename',{id,name:'Concert'},libraryDocument);
  assert.equal(before[0].name,'Mes chansons');assert.equal(changed.playlists[0].name,'Concert');
  changed=changeMusicPlaylist({...original,playlists:changed.playlists},'remove',{id,songId:items[0].id},libraryDocument);
  assert.deepEqual(changed.playlists[0].songIds,[items[1].id]);
  assert.equal(changeMusicPlaylist({...original,playlists:changed.playlists},'delete',{id},libraryDocument).playlists.length,0);
});
test('foreign roots, missing IDs, duplicate names and playlist bounds are refused without changing saved copies',()=>{
  const saved=prefs({playlists:[playlist()]});const before=JSON.stringify(saved);
  for(const [action,payload,document] of [
    ['add',{id:listId,songId:'f'.repeat(64)},libraryDocument],['delete',{id:listId},{...libraryDocument,rootKey:'b'.repeat(64)}],
    ['create',{name:'MES CHANSONS'},libraryDocument],['rename',{id:listId,name:'bad\u202etext'},libraryDocument],['create',{name:'Okay'},{items:[]}]
  ]) assert.throws(()=>changeMusicPlaylist(saved,action,payload,document));
  assert.equal(JSON.stringify(saved),before);
  const many=prefs({playlists:Array.from({length:20},(_,i)=>({...playlist(),id:String(i),name:String(i)}))});
  assert.throws(()=>changeMusicPlaylist(many,'create',{name:'Too many'},libraryDocument),/20/);
  const full=playlist(Array.from({length:500},(_,i)=>String(i).padStart(64,'0')));
  assert.throws(()=>changeMusicPlaylist(prefs({playlists:[full]}),'add',{id:listId,songId:items[2].id},libraryDocument),/limite/);
});
test('explicit playlist playback follows insertion order and advances only on the current engine end event',async()=>{
  const f=fixture(prefs({playlists:[playlist([items[2].id,items[0].id])]}));
  assert.equal(f.player.snapshot().selection,null);assert.equal(f.actions.length,0);
  await f.player.playPlaylist(listId);let state=f.player.snapshot();assert.equal(state.selection.title,'Gamma');assert.equal(state.queuePosition,1);assert.equal(state.queueLength,2);
  assert.equal(state.canPrevious,false);assert.equal(state.canNext,true);
  assert.equal(f.player.report({revision:state.revision,epoch:state.playbackEpoch,playing:false,currentTime:60,duration:60,volume:.7}).ok,true);assert.equal(f.player.snapshot().selection.title,'Gamma','pause/report at the end cannot invent an ended event');
  assert.equal((await f.player.ended({...endEvent(f.player),revision:state.revision-1})).ok,false);
  await f.player.ended(endEvent(f.player));state=f.player.snapshot();assert.equal(state.selection.title,'Alpha');assert.equal(state.queuePosition,2);
  await f.player.ended(endEvent(f.player));assert.equal(f.player.snapshot().selection.title,'Alpha');assert.equal(f.player.snapshot().playing,false);assert.equal(f.player.snapshot().canNext,false);
  assert.equal((await f.player.control('next')).ok,false,'playlist never wraps without an explicit replay');
  await f.player.control('previous');assert.equal(f.player.snapshot().selection.title,'Gamma');
});
test('shuffle plays each available playlist member once and stops after exhaustion',async()=>{
  const f=fixture(prefs({shuffle:true,playlists:[playlist()]}));await f.player.playPlaylist(listId);const heard=[];
  for(let count=0;count<3;count++){const state=f.player.snapshot();heard.push(state.selection.id);await f.player.ended(endEvent(f.player));}
  assert.deepEqual([...heard].sort(),items.map(item=>item.id).sort());assert.equal(new Set(heard).size,3);assert.notDeepEqual(heard,items.map(item=>item.id));
  assert.equal(f.player.snapshot().canNext,false);assert.equal(f.player.snapshot().playing,false);
});
test('playlist snapshots are root scoped and expose missing songs as unavailable without inventing metadata or paths',async()=>{
  const saved=playlist([...items.map(item=>item.id),'f'.repeat(64)]),foreign={...playlist(),id:'87654321-4321-4123-8123-123456789abc',rootKey:'b'.repeat(64),name:'PRIVATE_OTHER_ROOT'};
  const f=fixture(prefs({playlists:[saved,foreign]})),state=f.player.snapshot();assert.equal(state.playlists.length,1);assert.equal(state.playlists[0].items.at(-1).available,false);assert.equal(state.playlists[0].items.at(-1).title,'');
  assert.doesNotMatch(JSON.stringify(state),/PRIVATE_OTHER_ROOT|rootKey|relativePath/);state.playlists[0].songIds.length=0;assert.equal(f.player.snapshot().playlists[0].songIds.length,4);
  await f.player.playPlaylist(listId);assert.equal(f.player.snapshot().queueLength,3);
});
test('changing shuffle or playlist members retains played history and applies changes only to future choices',async()=>{
  const original=prefs({playlists:[playlist()]});const f=fixture(original);await f.player.playPlaylist(listId);const revision=f.player.snapshot().revision;
  f.player.applyPreferences({...original,shuffle:true});assert.equal(f.player.snapshot().revision,revision);assert.equal(f.player.snapshot().selection.title,'Alpha');
  await f.player.control('next');assert.equal(f.player.snapshot().selection.title,'Gamma');
  f.player.applyPreferences({...original,shuffle:true,playlists:[playlist([items[0].id,items[2].id])]});assert.equal(f.player.snapshot().queueLength,2);assert.equal(f.player.snapshot().canNext,false);
  f.player.applyPreferences({...original,playlists:[]});assert.equal(f.player.snapshot().activePlaylistId,null);assert.equal(f.player.snapshot().queueLength,0);assert.equal(f.player.snapshot().selection.title,'Gamma');
});
test('library replacement or stop revokes queues and stale end events never restart audio',async()=>{
  const f=fixture(prefs({shuffle:true,playlists:[playlist()]}));await f.player.playPlaylist(listId);const previousEnd=endEvent(f.player);
  f.change({rootKey:'b'.repeat(64),revision:2,items:[]});f.player.libraryChanged();assert.equal(f.player.snapshot().queueLength,0);assert.equal(f.player.snapshot().playlists.length,0);
  assert.equal((await f.player.ended(previousEnd)).ok,false);assert.equal(f.player.snapshot().selection,null);
  const other=fixture(prefs({playlists:[playlist()]}));await other.player.playPlaylist(listId);const previous=endEvent(other.player);other.player.stop();await other.player.ended(previous);assert.equal(other.player.snapshot().selection,null);
});
test('late same-revision end events after pause, stop or a seek to the end cannot advance the playlist',async()=>{
  for(const action of ['pause','stop','seek']) {
    const f=fixture(prefs({playlists:[playlist()]}));await f.player.playPlaylist(listId);const previous=endEvent(f.player);
    await f.player.control(action,action==='seek'?60:undefined);
    assert.equal((await f.player.ended(previous)).ok,false);assert.equal(f.player.snapshot().selection.title,'Alpha');assert.equal(f.player.snapshot().queuePosition,1);
    await f.player.control('play');assert.equal((await f.player.ended(previous)).ok,false,'resume cannot reauthorize the delayed previous end');
    assert.equal((await f.player.ended(endEvent(f.player))).ok,true);assert.equal(f.player.snapshot().selection.title,'Beta');
  }
});
test('an explicit pause or stop during asynchronous preparation cannot be undone by its late completion',async()=>{
  for(const action of ['pause','stop']) {
    let release;
    const f=fixture(prefs(),(id,document)=>new Promise(resolve=>release=()=>resolve({...document.items[0],rootKey,revision:1,media:[{name:'song.wav'}]})));
    const pending=f.player.select(items[0].id);await f.player.control(action);release();await pending;
    assert.equal(f.actions.some(value=>value.action==='play'),false);assert.equal(f.player.snapshot().playing,false);
    assert.equal(action==='stop'?f.player.snapshot().selection:null,null);
  }
});
test('an earlier engine error after resume cannot cancel playlist advancement',async()=>{
  const f=fixture(prefs({playlists:[playlist()]}));await f.player.playPlaylist(listId);
  const previous={...endEvent(f.player),playing:false,currentTime:30,duration:60,volume:.7,errorCode:'playback'};
  await f.player.control('pause');await f.player.control('play');
  assert.equal(f.player.report(previous).ok,false);assert.equal(f.player.snapshot().error,null);
  assert.equal((await f.player.ended(endEvent(f.player))).ok,true);assert.equal(f.player.snapshot().selection.title,'Beta');
});
test('editing playlist membership or shuffle during preparation reconciles future choices when the current song resolves',async()=>{
  for(const shuffle of [false,true]) {
    let release,first=true;const original=prefs({playlists:[playlist()]});
    const f=fixture(original,(id,document)=>{const result={...document.items.find(item=>item.id===id),rootKey,revision:1,media:[{name:'song.wav'}]};if(!first)return result;first=false;return new Promise(resolve=>release=()=>resolve(result));});
    const loading=f.player.playPlaylist(listId);f.player.applyPreferences({...original,shuffle,playlists:[playlist([items[0].id,items[2].id])]});release();await loading;
    assert.equal(f.player.snapshot().queueLength,2);await f.player.control('next');assert.equal(f.player.snapshot().selection.title,'Gamma');assert.equal(f.player.snapshot().canNext,false);
  }
});
test('new playlist commands accept bounded opaque identities and cannot be sent from unrelated mini windows',()=>{
  const commands=[['player.playlistCreate',{name:'Concert'}],['player.playlistRename',{id:listId,name:'Live'}],['player.playlistDelete',{id:listId}],['player.playlistAdd',{id:listId,songId:items[0].id}],['player.playlistRemove',{id:listId,songId:items[0].id}],['player.playPlaylist',{id:listId}],['player.playPlaylist',{id:null}],['player.shuffle',{enabled:true}],['player.ended',{revision:1,epoch:1}]];
  for(const [command,payload] of commands){assert.equal(validCommand(command,payload,[]),true);assert.equal(validCommand(command,{...payload,path:'outside'},[]),false);assert.equal(trustedCatalogueWidgetCommand({},null,command,payload),false);assert.equal(trustedFiltersWidgetCommand({},null,command,payload),false);}
  assert.equal(validCommand('player.playlistCreate',{name:' '},[]),false);assert.equal(validCommand('player.playlistAdd',{id:listId,songId:'../outside'},[]),false);assert.equal(validCommand('player.ended',{revision:NaN},[]),false);
});
