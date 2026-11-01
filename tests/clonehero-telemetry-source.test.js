'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {once}=require('node:events');
const {createTelemetrySource,SUPPORTED_BUILDS}=require('../companion/clonehero-telemetry-source.cjs');
const {createGameWidgetIntegrations}=require('../companion/game-widget-integrations.cjs');
const c=require('../companion/clonehero-telemetry-contract.cjs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test){for(let i=0;i<100;i++){if(test())return;await wait(10);}assert.fail('Telemetry condition timed out');}
async function fixture(t,{game=SUPPORTED_BUILDS[0],onHandshake,config,records,beforeSource=()=>{},staleMs=250,startDisabled=false,omitStartDisabled=false,onChange=()=>{},onChartEvent=()=>{}}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'chartshub-telemetry-')),connectionDirectory=path.join(directory,'connection');await fs.mkdir(connectionDirectory);
 const provider={id:'chartshub.clonehero.il2cpp',version:'0.1.0'},descriptor={schema:c.DESCRIPTOR_SCHEMA,provider,game,pipeName:'ChartsHub.CloneHero.Telemetry.11111111-1111-4111-8111-111111111111',nonce:'a'.repeat(64),sessionId:'session-1',pid:123};
 await fs.writeFile(path.join(connectionDirectory,'connection.json'),JSON.stringify(descriptor));
 if(config)await fs.writeFile(path.join(directory,'clonehero-telemetry.json'),config);
 if(records!==undefined)await fs.writeFile(path.join(directory,'clonehero-records.json'),records);
 let sequence=0;const frame=(type,data={},extra={})=>({schema:c.SCHEMA,provider,game,sessionId:'session-1',attemptId:'attempt-1',playerId:0,sequence:sequence++,type,data,...extra});
 const capabilities=Object.fromEntries(c.CAPABILITIES.map(k=>[k,true]));
 const hello=()=>frame('hello',{capabilities,coverage:'from-attempt-start',state:{phase:'playing'}});
 const peers=[],transports=[],handshakes=[],changes=[],chartEvents=[];
 const server=net.createServer(peer=>{peers.push(peer);let input='';peer.on('error',()=>{});peer.on('data',bytes=>{input+=bytes;const at=input.indexOf('\n');if(at<0)return;const handshake=JSON.parse(input.slice(0,at));input='';handshakes.push(handshake);onHandshake?.(peer,{frame,hello});});});
 const endpoint=process.platform==='win32'?'\\\\.\\pipe\\ChartsHub.Telemetry.Tests.'+require('node:crypto').randomUUID():path.join(directory,'test.sock');
 server.listen(endpoint);await once(server,'listening');
 let connects=0;
 await beforeSource({directory,recordsFile:path.join(directory,'clonehero-records.json')});
 const source=await createTelemetrySource({dataDirectory:directory,connectionDirectory,platform:'win32',pollMs:30,staleMs,...(omitStartDisabled?{}:{startDisabled}),onChange:s=>{changes.push(s);onChange(s);},onChartEvent:event=>{chartEvents.push(event);return onChartEvent(event);},connectTransport:()=>{connects++;const peer=net.createConnection(endpoint);transports.push(peer);return peer;}});
 t.after(async()=>{await source.dispose();for(const peer of peers)peer.destroy();await new Promise(resolve=>server.close(resolve));if(path.dirname(path.resolve(directory))!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('chartshub-telemetry-'))throw Error('Unexpected fixture directory');await fs.rm(directory,{recursive:true,force:true});});
 return{source,frame,hello,descriptor,directory,connectionDirectory,changes,chartEvents,peers,transports,handshakes,get connects(){return connects;}};
}
test('public default ignores a saved activation and opens no descriptor transport until explicit session opt-in',async t=>{
 const config=JSON.stringify({version:1,enabled:true,windowMs:37,goal:{kind:'minutes',target:45}}),f=await fixture(t,{omitStartDisabled:true,config,onHandshake(peer,{frame,hello}){peer.write(JSON.stringify(hello())+'\n'+JSON.stringify(frame('hit',{offsetMs:4}))+'\n');}});
 f.source.start();await wait(65);assert.equal(f.connects,0);assert.deepEqual(f.chartEvents,[]);assert.equal(f.source.snapshot().enabled,false);assert.equal(f.source.snapshot().status,'disabled');assert.equal(f.source.snapshot().settings.windowMs,37);
 await f.source.setEnabled(true);await until(()=>f.source.snapshot().timing.sampleCount===1);assert.equal(f.connects,1);assert.equal(await fs.readFile(path.join(f.directory,'clonehero-telemetry.json'),'utf8'),config,'Opt-in never writes the activation preference');
 f.source.stop();assert.equal(f.source.snapshot().enabled,false);assert.equal(f.source.snapshot().active,null);assert.equal(f.source.snapshot().timing.sampleCount,0);await wait(70);assert.equal(f.connects,1);
 const restarted=await createTelemetrySource({dataDirectory:f.directory,connectionDirectory:f.connectionDirectory,platform:'win32',connectTransport(){assert.fail('A restarted Host cannot auto-connect');}});restarted.start();assert.equal(restarted.snapshot().enabled,false);await restarted.dispose();
});
test('public session activation creates no preference file and saves visual timing preferences with enabled false',async t=>{
 const f=await fixture(t,{startDisabled:true,onHandshake(peer,{hello}){peer.write(JSON.stringify(hello())+'\n');}});await f.source.setEnabled(true);await until(()=>f.source.snapshot().connected);
 const file=path.join(f.directory,'clonehero-telemetry.json');await assert.rejects(fs.readFile(file),{code:'ENOENT'});await f.source.configure({windowMs:37,goal:{kind:'minutes',target:45}});
 assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{version:1,enabled:false,windowMs:37,goal:{kind:'minutes',target:45}});assert.equal(f.source.snapshot().enabled,true);
 await f.source.setEnabled(false);assert.equal(f.source.snapshot().status,'disabled');assert.equal(f.source.snapshot().active,null);
});
test('public stop revokes immediately while a preference write is pending and cannot be undone by its completion',async t=>{
 const f=await fixture(t,{startDisabled:true,onHandshake(peer,{hello}){peer.write(JSON.stringify(hello())+'\n');}});await f.source.setEnabled(true);await until(()=>f.source.snapshot().connected);
 let release,entered;const gate=new Promise(r=>{release=r;}),writing=new Promise(r=>{entered=r;}),rename=fs.rename.bind(fs);
 t.mock.method(fs,'rename',async(from,to)=>{if(to===path.join(f.directory,'clonehero-telemetry.json')){entered();await gate;}return rename(from,to);});
 const pending=f.source.configure({windowMs:30,goal:{kind:'songs',target:8}});await writing;await f.source.setEnabled(false);assert.equal(f.source.snapshot().enabled,false);assert.equal(f.source.snapshot().status,'disabled');release();await pending;await wait(70);assert.equal(f.connects,1);assert.equal(f.source.snapshot().enabled,false);
});
test('revocation by a connecting observer happens before any local transport opens',async t=>{
 let f;f=await fixture(t,{startDisabled:true,onChange:s=>{if(s.status==='connecting')f.source.stop();}});await f.source.setEnabled(true);await until(()=>f.changes.some(s=>s.status==='connecting'));await wait(30);assert.equal(f.connects,0);assert.equal(f.source.snapshot().status,'disabled');assert.equal(f.source.snapshot().enabled,false);
});
test('a descriptor read completing after stop cannot republish waiting or open a transport',async t=>{
 const f=await fixture(t,{startDisabled:true});let release,entered;const gate=new Promise(r=>{release=r;}),reading=new Promise(r=>{entered=r;}),open=fs.open.bind(fs),descriptor=path.join(f.connectionDirectory,'connection.json');
 t.mock.method(fs,'open',async(...args)=>{const handle=await open(...args);if(args[0]===descriptor){const read=handle.read.bind(handle);handle.read=async(...values)=>{entered();await gate;return read(...values);};}return handle;});
 await f.source.setEnabled(true);await reading;f.source.stop();release();await wait(55);assert.equal(f.connects,0);assert.equal(f.source.snapshot().status,'disabled');assert.equal(f.source.snapshot().enabled,false);
});
test('public read-only future preferences are preserved while session opt-in remains explicitly available',async t=>{
 const config=JSON.stringify({version:99,enabled:true,privateFutureSetting:'kept'}),f=await fixture(t,{startDisabled:true,config,onHandshake(peer,{hello}){peer.write(JSON.stringify(hello())+'\n');}});
 assert.equal(f.source.snapshot().canWrite,false);await f.source.setEnabled(true);await until(()=>f.source.snapshot().connected);await assert.rejects(f.source.configure({windowMs:20,goal:{kind:'songs',target:10}}));await f.source.setEnabled(false);assert.equal(await fs.readFile(path.join(f.directory,'clonehero-telemetry.json'),'utf8'),config);
});

function trackRecords(t,file){
 const calls=[];let active=true;
 for(const method of ['lstat','open','rename','unlink','writeFile']){
  const original=fs[method].bind(fs);
  t.mock.method(fs,method,async(...args)=>{if(active&&args.some(value=>typeof value==='string'&&(value===file||value.startsWith(file+'.'))))calls.push(method);return original(...args);});
 }
 return{calls,stop(){active=false;return [...calls];}};
}
function completedAttempt(peer,{frame,hello}){
 peer.write([hello(),frame('state',{phase:'playing',metadata:{chartId:'c'.repeat(64),title:'Synthetic completed chart',instrument:'Guitar',difficulty:'Expert'}}),
  frame('hit',{offsetMs:3}),frame('attemptEnd',{completed:true,state:{phase:'results',stats:{score:200,combo:10,notesHit:10,notesTotal:10,misses:0,overstrums:0}}})].map(value=>JSON.stringify(value)+'\n').join(''));
}
for(const feature of ['accuracy','lyrics'])for(const existing of [false,true])test(`public ${feature}-only accepted attemptEnd never reads or writes ${existing?'an existing':'an absent'} records file`,async t=>{
 const records=JSON.stringify({version:1,bestScores:[[JSON.stringify(['c'.repeat(64),'Guitar','Expert']),999]]});let tracked;
 const f=await fixture(t,{startDisabled:true,...(existing?{records}:{}),beforeSource:({recordsFile})=>{tracked=trackRecords(t,recordsFile);},onHandshake:completedAttempt});
 assert.deepEqual(tracked.calls,[],'Public construction must not inspect a legacy history file');
 const controller=createGameWidgetIntegrations({telemetry:f.source,getContext:()=>({active:true,lifecycle:1}),platform:'win32'});t.after(()=>controller.dispose());
 await controller.configure({revision:controller.status().revision,accuracy:feature==='accuracy',lyrics:feature==='lyrics'});
 await until(()=>f.source.snapshot().phase==='results'&&f.source.snapshot().history.length===1);
 assert.equal(f.source.snapshot().connected,true,'The result must be accepted, not rejected by a transport guard');
 assert.equal(f.source.snapshot().comparison.bestScore,null,'No old private best score is loaded');
 assert.deepEqual(controller.readings().history,[],'Historical results never leave the public projection');
 controller.dispose();await f.source.dispose();assert.deepEqual(tracked.stop(),[],'Accepted results, stop and dispose must perform zero records-path I/O');
 const file=path.join(f.directory,'clonehero-records.json');if(existing)assert.equal(await fs.readFile(file,'utf8'),records,'Former private records remain byte-identical');else await assert.rejects(fs.readFile(file),{code:'ENOENT'});
});
test('explicit legacy private mode retains record loading and accepted-result persistence',async t=>{
 const key=JSON.stringify(['c'.repeat(64),'Guitar','Expert']),records=JSON.stringify({version:1,bestScores:[[key,100]]});let tracked;
 const f=await fixture(t,{startDisabled:false,records,beforeSource:({recordsFile})=>{tracked=trackRecords(t,recordsFile);},onHandshake:completedAttempt});
 assert(tracked.calls.includes('open'),'Private mode still loads its old records');f.source.start();await until(()=>f.source.snapshot().phase==='results');
 assert.equal(f.source.snapshot().comparison.bestScore,100);await f.source.dispose();assert(tracked.stop().includes('rename'),'Private mode still commits completed records atomically');
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,'clonehero-records.json'),'utf8')),{version:1,bestScores:[[key,200]]});
});
test('real local transport authenticates once, joins split UTF-8 frames, and receives canonical signed timing',async t=>{
 const f=await fixture(t,{onHandshake(peer,{frame,hello}){const a=Buffer.from(JSON.stringify(hello())+'\n'),b=Buffer.from(JSON.stringify(frame('state',{phase:'playing',metadata:{title:'Écho fictif'},clock:{positionSeconds:-2,durationSeconds:180},stats:{combo:3}}))+'\n'+JSON.stringify(frame('hit',{offsetMs:-51.012345}))+'\n');peer.write(a.subarray(0,35));peer.write(a.subarray(35));const split=b.indexOf(Buffer.from('É'))+1;peer.write(b.subarray(0,split));setTimeout(()=>peer.write(b.subarray(split)),5);}});
 f.source.start();await until(()=>f.source.snapshot().timing.sampleCount===1);
 assert.deepEqual(f.handshakes,[{schema:'chartshub.clonehero.handshake.v1',nonce:f.descriptor.nonce}]);
 const s=f.source.snapshot();assert.equal(s.active.metadata.title,'Écho fictif');assert.equal(s.active.clock.positionSeconds,-2);assert.equal(s.timing.lastOffsetMs,-51.012345);assert.equal(s.active.stats.combo,3);
 assert.equal(JSON.stringify(s).includes(f.descriptor.nonce),false);assert.equal(JSON.stringify(s).includes(f.descriptor.game.gameAssemblySha256),false);
});
test('a build not in the explicit validated allowlist never opens a transport',async t=>{
 const f=await fixture(t,{game:{...SUPPORTED_BUILDS[0],version:'9.9.9'}});f.source.start();await until(()=>f.source.snapshot().status==='unsupported');assert.equal(f.connects,0);assert.equal(f.source.snapshot().reason,'UNVALIDATED_GAME_BUILD');
});
test('identity spoofing and a hit before hello fail closed',async t=>{
 for(const mode of ['identity','hello']){const f=await fixture(t,{onHandshake(peer,{frame,hello}){peer.write(JSON.stringify(mode==='hello'?frame('hit',{offsetMs:4}):{...hello(),sessionId:'different-session'})+'\n');}});f.source.start();await until(()=>f.changes.some(s=>s.status==='error'));assert.equal(f.source.snapshot().connected,false);assert.equal(f.source.snapshot().timing.sampleCount,0);await f.source.dispose();}
});
test('a stale producer hides old values, and repeated duplicate frames do not keep it alive',async t=>{
 let interval;const f=await fixture(t,{staleMs:120,onHandshake(peer,{frame,hello}){const h=frame('hit',{offsetMs:5});peer.write(JSON.stringify({...hello(),sequence:0})+'\n');peer.write(JSON.stringify({...h,sequence:1})+'\n');interval=setInterval(()=>peer.write(JSON.stringify({...h,sequence:1})+'\n'),15);peer.once('close',()=>clearInterval(interval));}});t.after(()=>clearInterval(interval));f.source.start();await until(()=>f.changes.some(s=>s.status==='stale'));const stale=f.changes.find(s=>s.status==='stale');assert.equal(stale.timing.lastOffsetMs,null);assert.equal(stale.active,null);
});
test('oversized NDJSON closes the producer without accepting truncated data',async t=>{
 const f=await fixture(t,{onHandshake(peer){peer.write('x'.repeat(c.MAX_FRAME_BYTES+1));}});f.source.start();await until(()=>f.changes.some(s=>s.reason==='INVALID_TELEMETRY'));assert.equal(f.source.snapshot().timing.sampleCount,0);
});
test('stopping, enabling and saving settings are serialized and survive restart',async t=>{
 const f=await fixture(t,{onHandshake(peer,{hello}){peer.write(JSON.stringify(hello())+'\n');}});f.source.start();await until(()=>f.source.snapshot().connected);await Promise.all([f.source.setEnabled(false),f.source.configure({windowMs:37,goal:{kind:'minutes',target:45}})]);assert.equal(f.source.snapshot().status,'disabled');await wait(80);assert.equal(f.connects,1);
 const file=path.join(f.directory,'clonehero-telemetry.json'),stored=JSON.parse(await fs.readFile(file,'utf8'));assert.deepEqual(stored,{version:1,enabled:false,windowMs:37,goal:{kind:'minutes',target:45}});
 await f.source.setEnabled(true);await until(()=>f.source.snapshot().connected);assert.equal(f.connects,2);assert.equal(f.source.snapshot().timing.windowMs,37);
});
test('future settings are preserved read-only and cannot start a connection',async t=>{
 const original=JSON.stringify({version:99,enabled:true,privateFutureSetting:'kept'}),f=await fixture(t,{config:original});f.source.start();await wait(60);assert.equal(f.connects,0);assert.equal(f.source.snapshot().canWrite,false);assert.equal(f.source.snapshot().enabled,false);await assert.rejects(f.source.setEnabled(true));assert.equal(await fs.readFile(path.join(f.directory,'clonehero-telemetry.json'),'utf8'),original);
});
test('missing or removed descriptor is waiting and never discloses its path',async t=>{
 const f=await fixture(t);await fs.unlink(path.join(f.connectionDirectory,'connection.json'));f.source.start();await until(()=>f.changes.some(s=>s.reason==='PROVIDER_NOT_RUNNING'));assert.equal(f.connects,0);assert.equal(JSON.stringify(f.source.snapshot()).includes(f.directory),false);
});
test('contradictory cross-frame counters close the real local transport without recording an impossible result',async t=>{
 const f=await fixture(t,{onHandshake(peer,{frame,hello}){peer.write([hello(),frame('state',{phase:'playing',metadata:{chartId:'c'.repeat(64),instrument:'Guitar',difficulty:'Expert'},stats:{notesHit:1,notesTotal:1}}),frame('state',{phase:'playing',stats:{notesHit:2}}),frame('attemptEnd',{completed:true,state:{phase:'results',stats:{score:200}}})].map(value=>JSON.stringify(value)+'\n').join(''));}});f.source.start();await until(()=>f.changes.some(value=>value.reason==='INVALID_TELEMETRY'));const failed=f.changes.find(value=>value.reason==='INVALID_TELEMETRY');assert.equal(failed.connected,false);assert.equal(failed.active,null);assert.equal(failed.history.length,0);assert.equal(failed.session.completedSongs,0);assert.equal(failed.session.fullCombos,0);await assert.rejects(fs.readFile(path.join(f.directory,'clonehero-records.json')),error=>error.code==='ENOENT');
});

test('main-only chart events require accepted playing state and completed result, with one opaque ID per attempt',async t=>{
 const f=await fixture(t,{startDisabled:true,onHandshake(peer,{frame,hello}){
  const handshake=hello(),playing=frame('state',{phase:'playing'});
  peer.write([handshake,playing,playing,frame('state',{phase:'paused'}),frame('state',{phase:'playing'}),frame('attemptEnd',{completed:true,state:{phase:'results'}}),frame('attemptEnd',{completed:true,state:{phase:'results'}}),frame('state',{phase:'playing'})].map(value=>JSON.stringify(value)+'\n').join(''));
 }});
 await f.source.setEnabled(true);await until(()=>f.chartEvents.length===2);
 assert.deepEqual(f.chartEvents.map(event=>event.type),['start','end']);assert.equal(f.chartEvents[0].id,f.chartEvents[1].id);
 const expected='chart-'+require('node:crypto').createHash('sha256').update(JSON.stringify(['session-1','attempt-1',0])).digest('hex');assert.equal(f.chartEvents[0].id,expected);
 for(const event of f.chartEvents){assert.deepEqual(Object.keys(event).sort(),['id','type']);assert(Object.isFrozen(event));assert.match(event.id,/^[A-Za-z0-9:_-]{1,128}$/);}
 assert(!JSON.stringify(f.source.snapshot()).includes(expected));assert(!JSON.stringify(f.chartEvents).includes('attempt-1'));assert(!JSON.stringify(f.chartEvents).includes(f.descriptor.nonce));
});

test('hello, reset, hits, pauses, menus, heartbeats and other local players do not infer chart events',async t=>{
 const f=await fixture(t,{startDisabled:true,onHandshake(peer,{frame,hello}){peer.write([hello(),frame('state',{phase:'loading'}),frame('hit',{offsetMs:1}),frame('state',{phase:'paused'}),frame('state',{phase:'menu'}),frame('reset',{reason:'seek',state:{phase:'playing'}}),frame('heartbeat'),frame('state',{phase:'playing'},{playerId:1}),frame('attemptEnd',{completed:true,state:{phase:'results'}},{playerId:1}),frame('state',{phase:'idle'})].map(value=>JSON.stringify(value)+'\n').join(''));}});
 await f.source.setEnabled(true);await until(()=>f.source.snapshot().connected&&f.source.snapshot().phase==='idle');assert.deepEqual(f.chartEvents,[]);
});

test('abandoned attempts and a later contradictory completed replay cannot emit a confirmed chart end',async t=>{
 const f=await fixture(t,{startDisabled:true,onHandshake(peer,{frame,hello}){peer.write([hello(),frame('state',{phase:'playing'}),frame('attemptEnd',{completed:false,state:{phase:'results'}}),frame('attemptEnd',{completed:true,state:{phase:'results'}})].map(value=>JSON.stringify(value)+'\n').join(''));}});
 await f.source.setEnabled(true);await until(()=>f.source.snapshot().active?.ended===true);assert.equal(f.source.snapshot().active.completed,false);assert.deepEqual(f.chartEvents.map(event=>event.type),['start']);
});

test('rejected frames cannot emit start/end callbacks, including inconsistent final counters',async t=>{
 for(const mode of ['identity','invalid-state','inconsistent-counters']){
  const f=await fixture(t,{startDisabled:true,onHandshake(peer,{frame,hello}){
   const frames=[hello()];
   if(mode==='identity')frames.push(frame('state',{phase:'playing'},{sessionId:'forged-session'}));
   if(mode==='invalid-state')frames.push(frame('state',{phase:'playing',stats:{notesHit:2,notesTotal:1}}));
   if(mode==='inconsistent-counters')frames.push(frame('state',{phase:'paused',stats:{notesHit:1,notesTotal:1}}),frame('state',{phase:'playing',stats:{notesHit:2}}),frame('attemptEnd',{completed:true,state:{phase:'results'}}));
   peer.write(frames.map(value=>JSON.stringify(value)+'\n').join(''));
  }});
  await f.source.setEnabled(true);await until(()=>f.changes.some(value=>value.reason==='INVALID_TELEMETRY'));assert.deepEqual(f.chartEvents,[]);await f.source.dispose();
 }
});

test('a reconnect cannot repeat events for the same session and attempt, while a new attempt gets a new opaque ID',async t=>{
 let handshakes=0;
 const f=await fixture(t,{startDisabled:true,onHandshake(peer,{frame,hello}){handshakes++;peer.write([hello(),frame('state',{phase:'playing'}),frame('attemptEnd',{completed:true,state:{phase:'results'}})].map(value=>JSON.stringify(value)+'\n').join(''));if(handshakes===1)peer.end();}});
 await f.source.setEnabled(true);await until(()=>handshakes===2);await until(()=>f.source.snapshot().connected);assert.deepEqual(f.chartEvents.map(event=>event.type),['start','end']);
 f.peers.at(-1).write([f.frame('state',{phase:'playing'},{attemptId:'attempt-2'}),f.frame('attemptEnd',{completed:true,state:{phase:'results'}},{attemptId:'attempt-2'})].map(value=>JSON.stringify(value)+'\n').join(''));
 await until(()=>f.chartEvents.length===4);assert.equal(f.chartEvents[2].type,'start');assert.equal(f.chartEvents[3].type,'end');assert.equal(f.chartEvents[2].id,f.chartEvents[3].id);assert.notEqual(f.chartEvents[0].id,f.chartEvents[2].id);
});

test('synchronous stop inside a chart observer prevents the rest of the same accepted input batch from reviving it',async t=>{
 let f;f=await fixture(t,{startDisabled:true,onChartEvent:event=>{if(event.type==='start')f.source.stop();},onHandshake(peer,{frame,hello}){peer.write([hello(),frame('state',{phase:'playing'}),frame('attemptEnd',{completed:true,state:{phase:'results'}}),frame('state',{phase:'playing'},{attemptId:'attempt-2'})].map(value=>JSON.stringify(value)+'\n').join(''));}});
 await f.source.setEnabled(true);await until(()=>f.chartEvents.length===1);await wait(65);assert.deepEqual(f.chartEvents.map(event=>event.type),['start']);assert.equal(f.source.snapshot().enabled,false);assert.equal(f.source.snapshot().active,null);assert.equal(f.connects,1);
});

test('late data from a stopped or replaced connection generation cannot produce chart events',async t=>{
 let connections=0;
 const f=await fixture(t,{startDisabled:true,onHandshake(peer,{frame,hello}){const attemptId=++connections===1?'attempt-1':'attempt-2';peer.write([hello(),frame('state',{phase:'playing'},{attemptId})].map(value=>JSON.stringify(value)+'\n').join(''));}});
 await f.source.setEnabled(true);await until(()=>f.chartEvents.length===1);const old=f.transports[0];f.source.stop();
 const late=()=>Buffer.from(JSON.stringify(f.frame('attemptEnd',{completed:true,state:{phase:'results'}}))+'\n');old.emit('data',late());assert.equal(f.chartEvents.length,1);
 await f.source.setEnabled(true);await until(()=>f.chartEvents.length===2);old.emit('data',late());assert.deepEqual(f.chartEvents.map(event=>event.type),['start','start']);assert.notEqual(f.chartEvents[0].id,f.chartEvents[1].id);assert.equal(f.source.snapshot().phase,'playing');
 await f.source.dispose();f.transports.at(-1).emit('data',late());assert.equal(f.chartEvents.length,2);
});

test('a stale or disconnected producer cannot infer a completed chart from menu or missing data',async t=>{
 const f=await fixture(t,{startDisabled:true,staleMs:100,onHandshake(peer,{frame,hello}){peer.write(JSON.stringify(hello())+'\n'+JSON.stringify(frame('state',{phase:'paused'}))+'\n');}});
 await f.source.setEnabled(true);await until(()=>f.changes.some(value=>value.status==='stale'));assert.deepEqual(f.chartEvents,[]);
 const old=f.transports[0];f.source.stop();old.emit('data',Buffer.from(JSON.stringify(f.frame('attemptEnd',{completed:true,state:{phase:'results'}}))+'\n'));assert.deepEqual(f.chartEvents,[]);
});

test('a throwing main-only chart observer cannot disconnect a valid transport or alter later attempts',async t=>{
 const f=await fixture(t,{startDisabled:true,onChartEvent(){throw Error('Synthetic observer failure, not a provider error');},onHandshake(peer,{frame,hello}){peer.write([hello(),frame('state',{phase:'playing'}),frame('attemptEnd',{completed:true,state:{phase:'results'}}),frame('state',{phase:'playing'},{attemptId:'attempt-2'}),frame('hit',{offsetMs:3},{attemptId:'attempt-2'})].map(value=>JSON.stringify(value)+'\n').join(''));}});
 await f.source.setEnabled(true);await until(()=>f.source.snapshot().timing.sampleCount===1);assert.equal(f.source.snapshot().connected,true);assert.deepEqual(f.chartEvents.map(event=>event.type),['start','end','start']);assert(!f.changes.some(value=>value.reason==='INVALID_TELEMETRY'));
});

test('an asynchronously rejected main-only chart observer is contained without an unhandled rejection',async t=>{
 const f=await fixture(t,{startDisabled:true,onChartEvent:async()=>{await Promise.resolve();throw Error('Synthetic asynchronous observer failure');},onHandshake(peer,{frame,hello}){peer.write([hello(),frame('state',{phase:'playing'}),frame('attemptEnd',{completed:true,state:{phase:'results'}}),frame('state',{phase:'playing'},{attemptId:'attempt-2'}),frame('hit',{offsetMs:4},{attemptId:'attempt-2'})].map(value=>JSON.stringify(value)+'\n').join(''));}});
 await f.source.setEnabled(true);await until(()=>f.source.snapshot().timing.sampleCount===1);await wait(0);
 assert.equal(f.source.snapshot().connected,true);assert.deepEqual(f.chartEvents.map(event=>event.type),['start','end','start']);assert(!f.changes.some(value=>value.reason==='INVALID_TELEMETRY'));
});
