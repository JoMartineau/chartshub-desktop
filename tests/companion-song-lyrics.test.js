'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), { createHash } = require('node:crypto');
const { parseSongLyrics, MAX_BYTES } = require('../companion/song-lyrics-parser.cjs');
const { createSongVisuals } = require('../companion/song-visuals.cjs');
const { prepareVisualMedia } = require('../companion/library-media.cjs');
const { captureBundleSnapshot } = require('../companion/chart-bundle.cjs');
const { createLocalOverlayServer } = require('../companion/stream-server.cjs');
const { WebSocket } = require('ws');
const { validCommand } = require('../companion/security.cjs');
// Owned synthetic chart words describe this fixture; no copied song lyrics.
const chart = (events = '0 = E "phrase_start"\n192 = E "lyric Test"\n384 = E "lyric mar-"\n576 = E "lyric ker"\n768 = E "phrase_end"\n1152 = E "phrase_start"\n1152 = E "lyric Next_marker"\n1536 = E "phrase_end"', tempo = '0 = B 120000\n384 = B 60000') => Buffer.from('[Song]\n{\nResolution = 192\nOffset = 2\n}\n[SyncTrack]\n{\n'+tempo+'\n}\n[Events]\n{\n'+events+'\n}\n[ExpertSingle]\n{\n0 = N 0 0\n}\n');
function variable(value) { const bytes = [value & 127]; while (value = Math.floor(value / 128)) bytes.unshift((value & 127) | 128); return bytes; }
const meta = (delta, type, value) => { const data = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.from([...variable(delta),255,type,...variable(data.length),...data]); };
const note = (delta, kind, value, velocity = 100) => Buffer.from([...variable(delta),kind,value,velocity]);
function midi({ overlap = false, duplicate = false, textType = 5, tempo = true } = {}) {
  const track = parts => { const data=Buffer.concat(parts), header=Buffer.alloc(8);header.write('MTrk');header.writeUInt32BE(data.length,4);return Buffer.concat([header,data]); };
  const header=Buffer.from('4d546864000000060001000201e0','hex');
  return Buffer.concat([header,track([meta(0,3,'TEMPO'),...(tempo?[meta(0,81,Buffer.from([7,161,32])),meta(480,81,Buffer.from([15,66,64]))]:[]),meta(0,47,'')]),track([
    meta(0,3,'PART VOCALS'),note(0,144,105),...(overlap?[note(120,144,106)]:[]),meta(0,textType,'Test'),...(duplicate?[meta(0,5,'Test')]:[]),meta(480,textType,'marker#'),note(480,128,105,0),...(overlap?[note(0,128,106,0)]:[]),meta(0,47,'')
  ])]);
}
test('chart lyric phrases use tempo changes, plain text markup, and chart time without audio offset', () => {
  assert.deepEqual(parseSongLyrics(chart(),'chart'), { lines: [{startSeconds:0,endSeconds:3,text:'Test marker'},{startSeconds:5,endSeconds:7,text:'Next marker'}],reason:null });
});
test('MIDI PART VOCALS supports lyric/text meta events, phrase markers, tempo changes, and duplicate identical syllables', () => {
  for(const textType of [1,5]) for(const duplicate of [false,true]) assert.deepEqual(parseSongLyrics(midi({textType,duplicate}),'midi'),{lines:[{startSeconds:0,endSeconds:1.5,text:'Test marker'}],reason:null});
  assert.equal(parseSongLyrics(midi({tempo:false}),'midi').lines[0].endSeconds,1);
});
test('MIDI malformed lengths, truncated notes, SMPTE/type0, overlapping phrases and conflicting lyrics fail transparent', () => {
  const good=midi();for(const bytes of [good.subarray(0,20),good.subarray(0,good.length-1)])assert.equal(parseSongLyrics(bytes,'midi').lines.length,0);
  const smpte=Buffer.from(good);smpte.writeUInt16BE(0xe728,12);assert.equal(parseSongLyrics(smpte,'midi').reason,'unsupported');
  const type0=Buffer.from(good);type0.writeUInt16BE(0,8);assert.equal(parseSongLyrics(type0,'midi').reason,'unsupported');
  assert.equal(parseSongLyrics(midi({overlap:true}),'midi').reason,'ambiguous');
  const conflict=chart('0 = E "phrase_start"\n0 = E "lyric First"\n0 = E "lyric Other"\n192 = E "phrase_end"');assert.equal(parseSongLyrics(conflict,'chart').reason,'ambiguous');
});
test('nonvocal 105/106 instrument notes never invalidate otherwise valid vocal lyrics', () => {
  const good=midi(), foreign=Buffer.concat([meta(0,3,'PART GUITAR'),note(0,144,105),note(0,144,105),note(0,128,106,0),meta(0,47,'')]),header=Buffer.alloc(8);header.write('MTrk');header.writeUInt32BE(foreign.length,4);
  const combined=Buffer.concat([good,header,foreign]);combined.writeUInt16BE(3,10);
  assert.deepEqual(parseSongLyrics(combined,'midi'),parseSongLyrics(good,'midi'));
});
test('missing lyrics and unsafe/incomplete chart timing never invent lines', () => {
  assert.equal(parseSongLyrics(chart(''),'chart').reason,'missing');
  for(const bytes of [chart('192 = E "lyric Orphan"'),chart('0 = E "phrase_start"\n192 = E "lyric Unclosed"'),chart(undefined,'0 = B 0'),Buffer.from('[Song]\n{\nResolution = 0\n}\n[Events]\n{\n0 = E "phrase_start"\n0 = E "lyric Test"\n192 = E "phrase_end"\n}')])assert.equal(parseSongLyrics(bytes,'chart').lines.length,0);
  assert.equal(parseSongLyrics(Buffer.alloc(MAX_BYTES+1),'chart').reason,'unsupported');assert.equal(parseSongLyrics(Buffer.from(''),'sng').reason,'unsupported');
});
test('markup is plain text with syllable joins, literal hyphens, spaces and no executable formatting', () => {
  const result=parseSongLyrics(chart('0 = E "phrase_start"\n0 = E "lyric <color=red>Syn-</color>"\n48 = E "lyric thetic="\n96 = E "lyric marker#"\n144 = E "lyric +"\n192 = E "lyric test_name^"\n384 = E "phrase_end"'),'chart');
  assert.equal(result.lines[0].text,'Synthetic-marker test name');assert.equal(result.reason,null);
});
async function service(t,{lines=parseSongLyrics(chart(),'chart').lines,rows=1}={}) {
  let now=1000, revision=1; const metadata={title:'Synthetic chart',artist:'Fixture group',charter:'Fixture author'};
  const document={rootKey:'fixture-root',revision,items:Array.from({length:rows},(_,i)=>({id:String(i+1).repeat(64),...metadata}))};
  const library={status:()=>({status:'ready'}),matchingSnapshot:()=>document,resolveVisualSong:async()=>({rootKey:document.rootKey,revision:document.revision,lyrics:{lines,reason:null},privatePath:'never public'})};
  const s=createSongVisuals({library,now:()=>now});t.after(()=>s.stop());s.setEnabled(true);
  const input={live:true,phase:'playing',song:metadata,clock:{positionSeconds:.5,durationSeconds:20,speed:1}};
  await s.update(input);return {s,input,advance:seconds=>{now+=seconds*1000;},document};
}
test('current/next lyrics follow speed, pause, seek, instrumental gaps, end and reset',async t=>{
  const f=await service(t);assert.deepEqual(f.s.lyricsSnapshot(),{current:'Test marker',next:'Next marker'});
  await f.s.update({...f.input,clock:{positionSeconds:4,durationSeconds:20,speed:.75}});assert.equal(f.s.lyricsSnapshot(),null,'instrumental gap is transparent');
  f.advance(2);assert.equal(f.s.lyricsSnapshot().current,'Next marker','chart advances at native .75 speed');
  await f.s.update({...f.input,phase:'paused',clock:{positionSeconds:5,durationSeconds:20,speed:1.5}});f.advance(30);assert.equal(f.s.lyricsSnapshot().current,'Next marker');
  await f.s.update({...f.input,clock:{positionSeconds:.1,durationSeconds:20,speed:1.5}});assert.equal(f.s.lyricsSnapshot().current,'Test marker','backward seek restores correct phrase');
  await f.s.update({...f.input,phase:'results'});assert.equal(f.s.lyricsSnapshot(),null);
  await f.s.update(f.input);assert.equal(f.s.lyricsSnapshot().current,'Test marker');f.s.stop();assert.equal(f.s.lyricsSnapshot(),null);
});
test('legacy speedless clocks, stale clocks, missing files and ambiguous versions stay transparent',async t=>{
  const f=await service(t);f.advance(3);await f.s.update(f.input);assert.equal(f.s.lyricsSnapshot(),null,'same heartbeat cannot refresh clock');
  await f.s.update({...f.input,clock:{positionSeconds:.1,durationSeconds:20}});assert.equal(f.s.lyricsSnapshot(),null);
  await f.s.update({...f.input,live:false});assert.equal(f.s.lyricsSnapshot(),null);
  const ambiguous=await service(t,{rows:2});assert.equal(ambiguous.s.snapshot().state,'ambiguous');assert.equal(ambiguous.s.lyricsSnapshot(),null);
  const choice=ambiguous.s.snapshot();await ambiguous.s.select({id:choice.candidates[0].id,selectionKey:choice.selectionKey});assert.ok(ambiguous.s.lyricsSnapshot());
  ambiguous.document.revision++;await ambiguous.s.update({...ambiguous.input,song:{...ambiguous.input.song,title:'Different'}});assert.equal(ambiguous.s.lyricsSnapshot(),null);
});
test('phrase timer publishes lyric changes and expiration without requiring another game event',async t=>{
  let now=0,changes=0;const metadata={title:'Synthetic chart',artist:'Fixture group',charter:'Fixture author'},document={rootKey:'root',revision:1,items:[{id:'a'.repeat(64),...metadata}]};
  const s=createSongVisuals({now:()=>now,onChange:()=>changes++,library:{status:()=>({status:'ready'}),matchingSnapshot:()=>document,resolveVisualSong:async()=>({rootKey:'root',revision:1,lyrics:{lines:parseSongLyrics(chart(),'chart').lines}})}});t.after(()=>s.stop());s.setEnabled(true);await s.update({live:true,phase:'playing',song:metadata,clock:{positionSeconds:2.9,durationSeconds:20,speed:1}});
  await new Promise(r=>setTimeout(r,120));const before=changes;now=200;await new Promise(r=>setTimeout(r,120));assert.ok(changes>before);assert.equal(s.lyricsSnapshot(),null);
});
test('sealed chart reads require scanned notes identity and never return filesystem plans as lyrics',async t=>{
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'chartshub-lyrics-'))),root=path.join(base,'Songs'),folder=path.join(root,'Fixture');await fs.mkdir(folder,{recursive:true});
  t.after(async()=>{assert.equal(path.dirname(base),path.resolve(os.tmpdir()));assert.ok(path.basename(base).startsWith('chartshub-lyrics-'));await fs.rm(base,{recursive:true,force:true});});
  await fs.writeFile(path.join(folder,'notes.chart'),chart());const relativePath='Fixture/notes.chart',item={relativePath,format:'chart',id:createHash('sha256').update(relativePath).digest('hex')};
  item.cleanupSnapshot=await captureBundleSnapshot({rootPath:root,relativePath,format:'chart'});const plan=await prepareVisualMedia({root,item});assert.equal(plan.lyrics.lines.length,2);assert.equal(JSON.stringify(plan.lyrics).includes(base),false);
  await fs.appendFile(path.join(folder,'notes.chart'),'\n');await assert.rejects(prepareVisualMedia({root,item}));
  await assert.rejects(prepareVisualMedia({root,item:{...item,relativePath:'../private/notes.chart'}}));
});
test('lyrics widget is optional, shares appearance controls and accepts only strict next-line config',async()=>{
  const api=Object.assign({},await import('../companion/dist/widgets/core/index.js'),await import('../companion/dist/widgets/engine/WidgetRenderer.js'));
  const w=api.createGameplayWidgets().find(w=>w.type==='song.lyrics');assert.deepEqual(w.visibility,{game:false,stream:false});
  w.visibility={game:true,stream:true};w.style={...w.style,fontSize:36,colorMode:'custom',color:'#ff00ff'};
  const state={gameplay:{state:'playing',isChartActive:true},nowPlaying:null,serviceHealth:{},widgets:{instances:[w]},lyrics:{current:'Test marker',next:'Next marker'}};
  const renderer=new api.WidgetRenderer(api.createDefaultRegistry());assert.deepEqual(renderer.renderWidgetModels(state)[0].lines,['Test marker']);w.config={showNextLine:true};const model=renderer.renderWidgetModels(state,'stream')[0];assert.deepEqual(model.lines,['Test marker','Next marker']);assert.equal(model.style.fontSize,36);assert.equal(model.style.color,'#ff00ff');
  state.lyrics=null;assert.deepEqual(renderer.renderWidgetModels(state),[]);state.lyrics={current:'Test marker',next:null};state.gameplay.state='results';assert.deepEqual(renderer.renderWidgetModels(state),[]);
  assert.equal(validCommand('widget.lyrics',{revision:0,id:w.id,config:{showNextLine:true}},[w.id]),true);
  for(const config of [{showNextLine:'true'},{showNextLine:true,path:'private'},null])assert.equal(validCommand('widget.lyrics',{revision:0,id:w.id,config},[w.id]),false);
});
test('OBS receives only bounded current+next text, no full transcript, path, private clock or arbitrary configuration',async t=>{
  const token='ca'.repeat(32),server=createLocalOverlayServer({root:path.resolve(__dirname,'../companion'),token});t.after(()=>server.stop());
  server.publish({gameplay:{state:'playing',isChartActive:true},lyrics:{current:'Test marker',next:'Next marker',lines:['SECRET'],path:'PRIVATE'},widgets:{instances:[]}});await server.start(0);
  const origin=new URL(server.status().url).origin,socket=new WebSocket(origin.replace('http:','ws:')+'/events?token='+token,{origin});t.after(()=>socket.terminate());
  const projected=await new Promise((resolve,reject)=>{socket.once('message',bytes=>resolve(JSON.parse(bytes).state));socket.once('error',reject);});
  assert.deepEqual(projected.lyrics,{current:'Test marker',next:'Next marker'});assert.equal(JSON.stringify(projected).includes('SECRET'),false);assert.equal(JSON.stringify(projected).includes('PRIVATE'),false);
  const next=new Promise(resolve=>socket.once('message',bytes=>resolve(JSON.parse(bytes).state)));server.publish({...projected,gameplay:{state:'menu',isChartActive:false}});assert.equal((await next).lyrics,null);
});

test('parsed literal lyric words survive Game, OBS and optional next-line rendering without changing metadata sentinels',async t=>{
  const words=['Unknown','Null','Undefined','Na'];
  const lines=parseSongLyrics(chart(words.map((word,i)=>`${i*384} = E "phrase_start"\n${i*384} = E "lyric ${word}"\n${i*384+192} = E "phrase_end"`).join('\n')),'chart').lines;
  assert.deepEqual(lines.map(line=>line.text),words);
  const api=Object.assign({},await import('../companion/dist/widgets/core/index.js'),await import('../companion/dist/widgets/engine/WidgetRenderer.js'));
  const w=api.createGameplayWidgets().find(w=>w.type==='song.lyrics'),title=api.createDefaultWidgets().find(w=>w.type==='song.title');w.visibility={game:true,stream:true};
  const renderer=new api.WidgetRenderer(api.createDefaultRegistry());
  const state={gameplay:{state:'playing',isChartActive:true},nowPlaying:{title:'Unknown'},serviceHealth:{},widgets:{instances:[w,title]},lyrics:null};
  const token='de'.repeat(32),server=createLocalOverlayServer({root:path.resolve(__dirname,'../companion'),token});t.after(()=>server.stop());await server.start(0);
  const origin=new URL(server.status().url).origin,socket=new WebSocket(origin.replace('http:','ws:')+'/events?token='+token,{origin});t.after(()=>socket.terminate());
  await new Promise((resolve,reject)=>{socket.once('message',resolve);socket.once('error',reject);});
  for(let i=0;i<lines.length;i++){
    const current=lines[i].text,next=lines[(i+1)%lines.length].text;state.lyrics={current,next};w.config={showNextLine:false};
    assert.deepEqual(renderer.renderWidgetModels(state).map(model=>({id:model.id,lines:model.lines})),[{id:w.id,lines:[current]}]);
    w.config={showNextLine:true};
    for(const destination of ['game','stream'])assert.deepEqual(renderer.renderWidgetModels(state,destination).find(model=>model.id===w.id).lines,[current,next]);
    const received=new Promise(resolve=>socket.once('message',bytes=>resolve(JSON.parse(bytes).state)));server.publish(state);const projected=await received;
    assert.deepEqual(projected.lyrics,{current,next});assert.equal(projected.nowPlaying.title,undefined,'metadata sentinel behavior stays unchanged');
    assert.deepEqual(renderer.renderWidgetModels(projected,'stream').find(model=>model.id===w.id).lines,[current,next]);
  }
  const received=new Promise(resolve=>socket.once('message',bytes=>resolve(JSON.parse(bytes).state)));server.publish({...state,lyrics:{current:'x'.repeat(600)+'\u0000',next:'Na\u0000'}});const bounded=await received;
  assert.equal(bounded.lyrics.current.length,512);assert.equal(bounded.lyrics.next,'Na');
});
