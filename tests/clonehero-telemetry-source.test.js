'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {once}=require('node:events');
const {createTelemetrySource,SUPPORTED_BUILDS}=require('../companion/clonehero-telemetry-source.cjs');
const c=require('../companion/clonehero-telemetry-contract.cjs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test){for(let i=0;i<100;i++){if(test())return;await wait(10);}assert.fail('Telemetry condition timed out');}
async function fixture(t,{game=SUPPORTED_BUILDS[0],onHandshake,config,staleMs=250}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'chartshub-telemetry-')),connectionDirectory=path.join(directory,'connection');await fs.mkdir(connectionDirectory);
 const provider={id:'chartshub.clonehero.il2cpp',version:'0.1.0'},descriptor={schema:c.DESCRIPTOR_SCHEMA,provider,game,pipeName:'ChartsHub.CloneHero.Telemetry.11111111-1111-4111-8111-111111111111',nonce:'a'.repeat(64),sessionId:'session-1',pid:123};
 await fs.writeFile(path.join(connectionDirectory,'connection.json'),JSON.stringify(descriptor));
 if(config)await fs.writeFile(path.join(directory,'clonehero-telemetry.json'),config);
 let sequence=0;const frame=(type,data={},extra={})=>({schema:c.SCHEMA,provider,game,sessionId:'session-1',attemptId:'attempt-1',playerId:0,sequence:sequence++,type,data,...extra});
 const capabilities=Object.fromEntries(c.CAPABILITIES.map(k=>[k,true]));
 const hello=()=>frame('hello',{capabilities,coverage:'from-attempt-start',state:{phase:'playing'}});
 const peers=[],handshakes=[],changes=[];
 const server=net.createServer(peer=>{peers.push(peer);let input='';peer.on('error',()=>{});peer.on('data',bytes=>{input+=bytes;const at=input.indexOf('\n');if(at<0)return;const handshake=JSON.parse(input.slice(0,at));input='';handshakes.push(handshake);onHandshake?.(peer,{frame,hello});});});
 const endpoint=process.platform==='win32'?'\\\\.\\pipe\\ChartsHub.Telemetry.Tests.'+require('node:crypto').randomUUID():path.join(directory,'test.sock');
 server.listen(endpoint);await once(server,'listening');
 let connects=0;
 const source=await createTelemetrySource({dataDirectory:directory,connectionDirectory,platform:'win32',pollMs:30,staleMs,onChange:s=>changes.push(s),connectTransport:()=>{connects++;return net.createConnection(endpoint);}});
 t.after(async()=>{await source.dispose();for(const peer of peers)peer.destroy();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
 return{source,frame,hello,descriptor,directory,connectionDirectory,changes,peers,handshakes,get connects(){return connects;}};
}
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
