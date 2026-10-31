'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { createHash } = require('node:crypto');
const { prepareVisualMedia, mediaResponse } = require('../companion/library-media.cjs');
const { captureBundleSnapshot } = require('../companion/chart-bundle.cjs');
const { createInstalledLibraryService } = require('../companion/library-service.cjs');
const { createBackgroundLibraryService } = require('../companion/library-background.cjs');
const { createSongVisuals } = require('../companion/song-visuals.cjs');
const { createLocalOverlayServer } = require('../companion/stream-server.cjs');
const { validCommand } = require('../companion/security.cjs');
const hash = v => createHash('sha256').update(v).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLcoAAAAASUVORK5CYII=', 'base64');
const mp4 = Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from('ftypisom'),Buffer.alloc(8),Buffer.from('owned synthetic container; not a playable film')]);
const chart = '[Song]\n{\nName = "Signal de test"\nResolution = 192\n}\n[ExpertSingle]\n{\n0 = N 0 0\n}\n';
const ini = '[song]\nname = Signal de test\nartist = Groupe fictif\ncharter = Charter Démo\nvideo_start_time = -1250\n';
const live = { live:true, phase:'playing', song:{title:'Signal de test',artist:'Groupe fictif',charter:'Charter Démo'}, clock:{positionSeconds:10,durationSeconds:240,speed:1} };
const pause = ms => new Promise(r=>setTimeout(r,ms));
async function until(check){for(let i=0;i<300;i++){if(await check())return;await pause(10);}throw Error('Visual fixture did not settle');}
async function fixture(t){
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'chartshub-song-visual-')),root=path.join(base,'Songs'),folder=path.join(root,'Signal'),data=path.join(base,'Profile');
  await fs.mkdir(folder,{recursive:true});await fs.mkdir(data);
  await fs.writeFile(path.join(folder,'notes.chart'),chart);await fs.writeFile(path.join(folder,'song.ini'),ini);
  const cleanup=[];
  t.after(async()=>{for(const value of cleanup)await value.stop();assert.equal(path.dirname(path.resolve(base)),path.resolve(os.tmpdir()));assert.ok(path.basename(base).startsWith('chartshub-song-visual-'));await fs.rm(base,{recursive:true,force:true});});
  const f={base,root,folder,data,cleanup,item:{id:hash('Signal/notes.chart'),relativePath:'Signal/notes.chart',format:'chart'},file:name=>path.join(folder,name)};
  f.plan=async()=>{f.item.cleanupSnapshot=await captureBundleSnapshot({rootPath:root,relativePath:f.item.relativePath,format:'chart'});return prepareVisualMedia({root,item:f.item});};return f;
}
function stub(plan, rows=[{id:'b'.repeat(64),...live.song}]){
  let document={rootKey:'root',revision:1,items:rows},status='ready',calls=0;
  return{library:{status:()=>({status}),matchingSnapshot:()=>document,resolveVisualSong:async()=>{calls++;return{...plan,rootKey:document.rootKey,revision:document.revision};}},calls:()=>calls,change:(value)=>{document={...document,...value};},status:v=>status=v};
}
async function service(t,plan,rows,options={}){const fixture=stub(plan,rows),s=createSongVisuals({library:fixture.library,...options});t.after(()=>s.stop());s.setEnabled(true);await s.update(live);return{s,...fixture};}
function request(port,url,options={}){return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:url,method:options.method||'GET',headers:{Host:`127.0.0.1:${port}`,...options.headers},agent:false},res=>{const chunks=[];res.on('data',d=>chunks.push(d));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));});req.on('error',reject);req.setTimeout(3000,()=>req.destroy(Error('HTTP timeout')));req.end(options.body);});}

test('visual media resolves reserved background and video without requiring an audio stem',async t=>{
 const f=await fixture(t);await fs.writeFile(f.file('background.png'),png);await fs.writeFile(f.file('video.mp4'),mp4);const p=await f.plan();
 assert.equal(p.background.kind,'background');assert.equal(p.video.kind,'video');assert.equal(p.videoStartTimeMs,-1250);
 const r=await mediaResponse(p.background,new Request('http://127.0.0.1/'));assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),png);
});
test('album artwork is never silently promoted to the background',async t=>{const f=await fixture(t);await fs.writeFile(f.file('album.png'),png);const p=await f.plan();assert.equal(p.background,null);assert.equal(p.backgroundUnavailable,'missing');assert.equal(p.video,null);});
test('multiple reserved visual files stay ambiguous and unsupported files stay explicit',async t=>{
 const f=await fixture(t);await fs.writeFile(f.file('background.png'),png);await fs.writeFile(f.file('background.jpg'),png);await fs.writeFile(f.file('video.avi'),mp4);
 const p=await f.plan();assert.equal(p.background,null);assert.equal(p.backgroundUnavailable,'ambiguous');assert.equal(p.video,null);assert.equal(p.videoUnavailable,'unsupported');
});
test('wrong binary magic, escaped item identity and SNG files are rejected',async t=>{
 const f=await fixture(t);await fs.writeFile(f.file('background.png'),'not an image');const p=await f.plan();assert.equal(p.background,null);assert.equal(p.backgroundUnavailable,'unsupported');
 await assert.rejects(prepareVisualMedia({root:f.root,item:{...f.item,relativePath:'../outside/notes.chart'}}));
 await assert.rejects(prepareVisualMedia({root:f.root,item:{...f.item,format:'sng'}}),e=>e.code==='LIBRARY_MEDIA_UNSUPPORTED');
});
test('visual plans are tied to the scanned bundle and changed media cannot be served',async t=>{
 const f=await fixture(t);await fs.writeFile(f.file('background.png'),png);const p=await f.plan();await fs.appendFile(f.file('background.png'),'changed');
 assert.equal((await mediaResponse(p.background,new Request('http://127.0.0.1/'))).status,404);await assert.rejects(prepareVisualMedia({root:f.root,item:f.item}));
});
test('visual media Range and HEAD responses use actual bounded file bytes',async t=>{
 const f=await fixture(t);await fs.writeFile(f.file('video.mp4'),mp4);const p=await f.plan();
 const r=await mediaResponse(p.video,new Request('http://127.0.0.1/',{headers:{Range:'bytes=4-11'}}));assert.equal(r.status,206);assert.deepEqual(Buffer.from(await r.arrayBuffer()),mp4.subarray(4,12));
 const h=await mediaResponse(p.video,new Request('http://127.0.0.1/',{method:'HEAD'}));assert.equal(h.status,200);assert.equal(h.body,null);assert.equal(h.headers.get('content-length'),String(mp4.length));
 assert.equal((await mediaResponse(p.video,new Request('http://127.0.0.1/',{headers:{Range:'bytes=999999-'}}))).status,416);
});
test('direct and worker library RPC resolve visuals only for a scanned immutable item',async t=>{
 const f=await fixture(t);await fs.writeFile(f.file('background.png'),png);
 for(const [index,create]of[createInstalledLibraryService,createBackgroundLibraryService].entries()){
  const library=create({dataDirectory:path.join(f.data,String(index))});f.cleanup.push(library);await library.load();await library.selectRoot(f.root);await library.requestScan('full');await until(()=>library.status().status==='ready');
  const id=library.matchingSnapshot().items[0]?.id;assert.ok(id);const p=await library.resolveVisualSong(id);assert.equal(p.background.kind,'background');assert.equal(p.video,null);assert.equal(p.revision,library.matchingSnapshot().revision);
  await assert.rejects(library.resolveVisualSong('f'.repeat(64)));await library.stop();
 }
});
test('only real current song metadata selects one exact charter and never mock metadata',async t=>{
 const f=await service(t,{background:{},video:null});assert.equal(f.s.snapshot().state,'ready');assert.equal(f.calls(),1);
 await f.s.update({...live,live:false});assert.equal(f.s.snapshot().state,'waiting');assert.equal(f.s.browserSnapshot().background,false);
 await f.s.update({...live,song:{...live.song,charter:'Someone else'}});assert.equal(f.s.snapshot().state,'missing');assert.equal(f.calls(),1);
});
test('duplicate charts require a current local choice, cannot use stale selection or guessed id',async t=>{
 const rows=[{id:'b'.repeat(64),...live.song},{id:'c'.repeat(64),...live.song}],f=await service(t,{background:{}},rows);
 assert.equal(f.s.snapshot().state,'ambiguous');assert.equal(f.calls(),0);const key=f.s.snapshot().selectionKey;
 assert.throws(()=>f.s.select({id:'d'.repeat(64),selectionKey:key}));await f.s.select({id:rows[1].id,selectionKey:key});assert.equal(f.calls(),1);
 f.change({revision:2});await f.s.update(live);assert.throws(()=>f.s.select({id:rows[0].id,selectionKey:key}));
});
test('missing charter requires explicit choice even for one matching title and artist',async t=>{
 const f=await service(t,{background:{}});f.s.stop();f.s.setEnabled(true);await f.s.update({...live,song:{...live.song,charter:''}});assert.equal(f.s.snapshot().state,'ambiguous');
});
test('all duplicate candidates are bounded and no private paths enter either browser or panel metadata',async t=>{
 const rows=Array.from({length:80},(_,i)=>({id:hash(String(i)),...live.song,relativePath:'private/path',rootPath:'private/root'})),f=await service(t,{background:{path:'SECRET'}},rows);
 assert.equal(f.s.snapshot().candidates.length,20);assert.equal(JSON.stringify(f.s.snapshot()).includes('private'),false);assert.equal(JSON.stringify(f.s.browserSnapshot()).includes('SECRET'),false);
});
test('late asynchronous resolution cannot revive an old song after source/root change or stop',async t=>{
 const f=stub({});let resolve;f.library.resolveVisualSong=()=>new Promise(r=>resolve=r);const s=createSongVisuals({library:f.library});t.after(()=>s.stop());s.setEnabled(true);const pending=s.update(live);await until(()=>typeof resolve==='function');s.update({...live,live:false});resolve({background:{},rootKey:'root',revision:1});await pending;assert.equal(s.browserSnapshot().background,false);
});
test('a background hard link cannot grant access to another file',async t=>{const f=await fixture(t);const outside=path.join(f.base,'outside.png');await fs.writeFile(outside,png);await fs.link(outside,f.file('background.png'));await assert.rejects(f.plan());});
test('image remains available without timing but video waits for authoritative clock',async t=>{
 const f=await service(t,{background:{},video:{},videoStartTimeMs:0});await f.s.update({...live,clock:null});assert.equal(f.s.browserSnapshot().background,true);assert.equal(f.s.browserSnapshot().video,false);assert.equal(f.s.snapshot().clockReady,false);
});
test('R3.1 position-only clock never guesses normal speed and explicit native speed enables video',async t=>{
 const f=await service(t,{background:{},video:{},videoStartTimeMs:0});
 for(const phase of ['playing','paused'])for(const speed of [undefined,null,0,NaN,Infinity,.009,10.01,'1']){
  const clock={positionSeconds:10,durationSeconds:240,...(speed===undefined?{}:{speed})};await f.s.update({...live,phase,clock});
  assert.equal(f.s.browserSnapshot().background,true);assert.equal(f.s.browserSnapshot().video,false);assert.equal(f.s.browserSnapshot().clock,null);assert.equal(f.s.snapshot().clockReady,false);
 }
 await f.s.update({...live,clock:{positionSeconds:10,durationSeconds:240,speed:.75}});
 assert.equal(f.s.snapshot().clockReady,true);assert.equal(f.s.browserSnapshot().video,true);assert.equal(f.s.browserSnapshot().clock.speed,.75);
});
test('unchanged playing clock expires, paused clock stays fixed, resumed clock and speed are honored',async t=>{
 let now=1000;const f=await service(t,{background:{},video:{},videoStartTimeMs:-1250},undefined,{now:()=>now});now+=1000;assert.equal(f.s.browserSnapshot().clock.positionSeconds,11);
 now+=2000;f.s.update(live);assert.equal(f.s.browserSnapshot().video,false,'heartbeat with same clock must not restart freshness');
 f.s.update({...live,phase:'paused',clock:{...live.clock,positionSeconds:33,speed:.8}});now+=10000;assert.equal(f.s.browserSnapshot().clock.positionSeconds,33);assert.equal(f.s.browserSnapshot().video,true);
 f.s.update({...live,clock:{...live.clock,positionSeconds:4,speed:1.5}});now+=1000;assert.equal(f.s.browserSnapshot().clock.positionSeconds,5.5);
});
test('media capabilities are revoked and active requests aborted on library change, song end or stop',async t=>{
 const calls=[];const f=await service(t,{background:{}},undefined,{respond:async(_entry,_request,options)=>{calls.push(options);return new Response('bounded');}});
 const old=f.s.browserSnapshot().generation;assert.equal((await f.s.serve('background',old,new Request('http://127.0.0.1/'))).status,200);assert.equal(calls[0].signal.aborted,false);
 f.change({revision:2});await f.s.update(live);assert.equal(calls[0].signal.aborted,true);assert.equal((await f.s.serve('background',old,new Request('http://127.0.0.1/'))).status,404);
 const next=f.s.browserSnapshot().generation;f.s.stop();assert.equal((await f.s.serve('background',next,new Request('http://127.0.0.1/'))).status,404);
});
test('IPC visual commands accept only bounded opaque selectors and two known source kinds',()=>{
 assert.equal(validCommand('visuals.copyUrl',{kind:'background'},[]),true);assert.equal(validCommand('visuals.copyUrl',{kind:'video',path:'secret'},[]),false);
 assert.equal(validCommand('visuals.select',{id:'a'.repeat(64),selectionKey:'b'.repeat(64)},[]),true);assert.equal(validCommand('visuals.select',{id:'../x',selectionKey:'b'.repeat(64)},[]),false);
});
test('HTTP sources remain authenticated, local-only, read-only and separate from widget snapshot',async t=>{
 const f=await fixture(t);await fs.writeFile(f.file('background.png'),png);await fs.writeFile(f.file('video.mp4'),mp4);const p=await f.plan(),{s}=await service(t,p);
 const token='a7'.repeat(32),server=createLocalOverlayServer({root:path.resolve(__dirname,'../companion'),token,visuals:s});f.cleanup.push(server);await server.start(0);const port=new URL(server.status().url).port,auth='?token='+token;
 assert.notEqual(server.status().backgroundUrl,server.status().videoUrl);
 for(const endpoint of ['/background','/video','/visual-state','/visual-media/background/'+s.browserSnapshot().generation]){
  assert.equal((await request(port,endpoint)).status,403);assert.equal((await request(port,endpoint+auth,{headers:{Origin:'https://foreign.invalid'}})).status,403);assert.equal((await request(port,endpoint+auth,{headers:{Referer:'https://foreign.invalid/'}})).status,403);
  assert.equal((await request(port,endpoint+auth+'&token='+token)).status,403);assert.equal((await request(port,endpoint+auth,{method:'POST'})).status,405);
 }
 const page=await request(port,'/video'+auth);assert.equal(page.status,200);assert.match(page.bytes.toString(),/autoplay muted playsinline/);assert.match(page.headers['content-security-policy'],/media-src 'self'/);assert.equal(page.headers['access-control-allow-origin'],undefined);
 const doc=JSON.parse((await request(port,'/visual-state'+auth)).bytes);assert.deepEqual(Object.keys(doc).sort(),['background','clock','generation','phase','video','videoStartTimeMs']);assert.equal(JSON.stringify(doc).includes(f.root),false);
 const route='/visual-media/video/'+doc.generation+auth,r=await request(port,route,{headers:{Range:'bytes=4-11'}});assert.equal(r.status,206);assert.deepEqual(r.bytes,mp4.subarray(4,12));
 assert.equal((await request(port,route,{method:'HEAD'})).bytes.length,0);assert.equal((await request(port,'/visual-media/video/'+'f'.repeat(64)+auth)).status,404);
 assert.equal((await request(port,'/visual-media/video/%2e%2e'+auth)).status,403);
 const diagnostic={method:'POST',headers:{Origin:`http://127.0.0.1:${port}`,'Content-Type':'application/json'},body:JSON.stringify({kind:'video',generation:doc.generation,code:'decode'})};
 assert.equal((await request(port,'/visual-error'+auth,{...diagnostic,headers:{'Content-Type':'application/json'}})).status,403);
 assert.equal((await request(port,'/visual-error'+auth,{...diagnostic,body:'x'.repeat(257)})).status,413);
 assert.equal((await request(port,'/visual-error'+auth,{...diagnostic,body:JSON.stringify({kind:'video',generation:'f'.repeat(64),code:'decode'})})).status,400);
 assert.equal((await request(port,'/visual-error'+auth,diagnostic)).status,204);assert.equal(s.snapshot().videoReason,'decoder');assert.equal(s.browserSnapshot().video,false);assert.equal(s.browserSnapshot().background,true);
 s.stop();assert.equal((await request(port,route)).status,404);
});
test('sync target separates positive and negative video offsets, pause/seek/speed and invalid timing',async()=>{
 const js=await fs.readFile(path.resolve(__dirname,'../companion/ui/song-visuals-sync.js'),'utf8'),{visualTarget}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
 const input={video:true,phase:'playing',clock:{positionSeconds:10,durationSeconds:240,speed:1.5},videoStartTimeMs:1250};assert.deepEqual(visualTarget(input,1),{seconds:12.75,hidden:false,playing:true,speed:1.5});
 assert.equal(visualTarget({...input,videoStartTimeMs:-20000},0).hidden,true);assert.equal(visualTarget({...input,phase:'paused'},1).seconds,11.25);assert.equal(visualTarget({...input,clock:{...input.clock,positionSeconds:1}},0).seconds,2.25);
 assert.equal(visualTarget({...input,clock:null}),null);assert.equal(visualTarget(input,4),null);assert.equal(visualTarget({...input,video:false}),null);
});
