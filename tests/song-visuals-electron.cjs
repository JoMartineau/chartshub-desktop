'use strict';
// All Songs, media and game frames in this fixture are generated here.
// It launches no game, scans no real library and reads no user profile.
const {app,BrowserWindow}=require('electron'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {registerFixtureMaintenance,revealWorkspace}=require('./workspace-input.cjs');const disposeMaintenance=registerFixtureMaintenance();
const arg=process.argv.find(v=>v.startsWith('--fixture-output='));if(!arg)throw Error('Explicit fixture output required');
const output=path.resolve(arg.slice('--fixture-output='.length)),directory=path.join(output,'visuals-'+randomUUID());
app.setPath('userData',path.join(os.tmpdir(),'chartshub-visual-'+randomUUID()));process.env.LOCALAPPDATA=path.join(directory,'local-app-data');app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const {createCompanionHost,registerCompanionScheme}=require('../companion/host.cjs'),contract=require('../companion/clonehero-telemetry-contract.cjs'),{SUPPORTED_BUILDS}=require('../companion/clonehero-telemetry-source.cjs');registerCompanionScheme();
console.log(JSON.stringify({fixturePid:process.pid,directory,phase:'starting'}));
let host,panel,server,peer,timer,sequence=0,finishing=false;const peers=[],windows=[],checks=[],captures=[],errors=[];const deadline=setTimeout(()=>void finish(Error('Visual fixture exceeded90 seconds')),90000);
const provider={id:'chartshub.clonehero.il2cpp',version:'0.1.3'},game=SUPPORTED_BUILDS[0],sessionId='visual-fixture-session',attemptId='visual-fixture-song';
const metadata={title:'Signal de test',artist:'Groupe fictif',charter:'Charter Démo',instrument:'Guitar',difficulty:'Expert'};
const caps=Object.fromEntries(contract.CAPABILITIES.map(k=>[k,['clock','songMetadata'].includes(k)]));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(25);}throw Error('Timed out: '+label);}
const evaluate=code=>panel.webContents.executeJavaScript(code);
function send(type,data={}){assert.ok(peer&&!peer.destroyed);peer.write(JSON.stringify({schema:contract.SCHEMA,provider,game,sessionId,attemptId,playerId:0,sequence:sequence++,type,data})+'\n');}
async function command(name,payload){const r=await evaluate(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`);assert.equal(r.ok,true,JSON.stringify(r));return r;}
async function click(selector){await revealWorkspace(panel,selector);const p=await evaluate(`(async()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'center',behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),p={x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)},h=document.elementFromPoint(p.x,p.y);if(n.disabled||!h||!(h===n||n.contains(h)))throw Error('Unavailable/covered control');return p;})()`);panel.webContents.focus();for(const type of ['mouseMove','mouseDown','mouseUp'])panel.webContents.sendInputEvent({type,...p,...(type==='mouseMove'?{}:{button:'left',clickCount:1})});await delay(75);}
async function check(name,fn){await fn();checks.push({name,result:'passed'});console.log('PASS '+name);}
async function capture(name){await evaluate("document.querySelector('#song-visuals-controls').scrollIntoView({block:'center',behavior:'instant'})");await delay(150);await fs.writeFile(path.join(directory,name),(await panel.webContents.capturePage()).toPNG());captures.push(name);}
async function makeVideo(){
 const generator=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});windows.push(generator);
 await generator.loadURL('data:text/html,<canvas width="160" height="90"></canvas>');
 const data=await generator.webContents.executeJavaScript(`(async()=>{const c=document.querySelector('canvas'),ctx=c.getContext('2d'),stream=c.captureStream(10),parts=[];const r=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});r.ondataavailable=e=>parts.push(e.data);r.start();let n=0;const timer=setInterval(()=>{ctx.fillStyle=n++%2?'#25d6e8':'#876aff';ctx.fillRect(0,0,160,90);},50);await new Promise(done=>setTimeout(done,1600));const stopped=new Promise(done=>r.onstop=done);r.stop();await stopped;clearInterval(timer);stream.getTracks().forEach(t=>t.stop());const a=new Uint8Array(await new Blob(parts,{type:'video/webm'}).arrayBuffer());return Array.from(a);})()`);
 generator.destroy();return Buffer.from(data);
}
async function finish(error){
 if(finishing)return;finishing=true;clearTimeout(deadline);clearInterval(timer);let disposeResolved=false;
 try{
  for(const w of windows)if(!w.isDestroyed()){await w.loadURL('about:blank').catch(()=>{});w.close();}
  for(const p of peers)p.destroy();if(server?.listening)await new Promise(r=>server.close(r));
  if(host){let alarm;try{await Promise.race([host.dispose(),new Promise((_,reject)=>{alarm=setTimeout(()=>reject(Error('Host disposal timed out')),10000);})]);disposeResolved=true;}finally{clearTimeout(alarm);}}
  await until(()=>BrowserWindow.getAllWindows().length===0,'fixture windows closed',3000);disposeMaintenance();
 }catch(failure){error=error||failure;}
 await fs.mkdir(directory,{recursive:true});const report={result:error?'failed':'passed',pid:process.pid,checks,captures,error:error?String(error.stack||error):null,errors,disposeResolved,windowCount:BrowserWindow.getAllWindows().length,syntheticGameFrames:true,generatedMedia:true,realUserLibraryRead:false,gameLaunched:false,actualHostIpcAndHttp:true};
 await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({directory,...report}));
 for(const event of ['before-quit','will-quit','quit'])app.once(event,()=>console.log(JSON.stringify({phase:'app-'+event})));
 process.exitCode=error?1:0;if(error)app.exit(1);else app.quit();
}
process.on('uncaughtException',error=>void finish(error));process.on('unhandledRejection',error=>void finish(error));
app.whenReady().then(async()=>{
 await fs.mkdir(directory,{recursive:true});const root=path.join(directory,'Songs'),folder=path.join(root,'Signal');await fs.mkdir(folder,{recursive:true});
 await fs.writeFile(path.join(folder,'notes.chart'),'[Song]\n{\nName = "Signal de test"\nResolution = 192\n}\n[ExpertSingle]\n{\n0 = N 0 0\n}\n');
 await fs.writeFile(path.join(folder,'song.ini'),'[song]\nname=Signal de test\nartist=Groupe fictif\ncharter=Charter Démo\nvideo_start_time=0\n');
 await fs.writeFile(path.join(folder,'background.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLcoAAAAASUVORK5CYII=','base64'));await fs.writeFile(path.join(folder,'video.webm'),await makeVideo());
 const connection=path.join(process.env.LOCALAPPDATA,'ChartsHub/Telemetry/v1');await fs.mkdir(connection,{recursive:true});const descriptor={schema:contract.DESCRIPTOR_SCHEMA,provider,game,sessionId,pipeName:'ChartsHub.CloneHero.Telemetry.'+randomUUID(),nonce:'d'.repeat(64),pid:process.pid};
 server=net.createServer(socket=>{peers.push(socket);let buffer='';socket.on('error',()=>{});socket.on('data',b=>{buffer+=b.toString();if(!buffer.includes('\n'))return;const h=JSON.parse(buffer.slice(0,buffer.indexOf('\n')));assert.equal(h.nonce,descriptor.nonce);peer=socket;send('hello',{capabilities:caps,coverage:'since-connect',state:{phase:'playing',metadata,clock:{positionSeconds:.2,durationSeconds:10,speed:1}}});});});await new Promise((r,j)=>{server.once('error',j);server.listen('\\\\.\\pipe\\'+descriptor.pipeName,r);});await fs.writeFile(path.join(connection,'connection.json'),JSON.stringify(descriptor));
 host=await createCompanionHost({dataDirectory:path.join(directory,'companion'),cloneHeroCandidates:[],cloneHeroProcessProbe:async()=>({running:false,sessions:[]}),isCatalogueAvailable:()=>false,authorizeCatalogue:async()=>false,catalogueClient:{async load(){return{items:[],revision:'visual-fixture',demo:false};},async artwork(){return null;}}});panel=await host.open();panel.setSize(1280,900);panel.webContents.on('console-message',(_e,d)=>{if(d.level==='error')errors.push(d.message);});
 await until(()=>evaluate("!!document.querySelector('#song-visual-background-copy')"),'visual controls');await until(()=>host.snapshot().telemetry?.connected,'synthetic telemetry');timer=setInterval(()=>{if(peer&&!peer.destroyed)send('heartbeat');},1000);
 await host.library.selectRoot(root);await host.library.requestScan('full');await until(()=>host.library.status().status==='ready','synthetic scan');
 const free=net.createServer();await new Promise(r=>free.listen(0,'127.0.0.1',r));const port=free.address().port;await new Promise(r=>free.close(r));await command('stream.settings',{revision:host.snapshot().editor.revision,settings:{...host.snapshot().state.stream,port}});
 await check('Native Stream control creates independent background/video URLs and one exact scanned match',async()=>{await click('#stream-enabled');await until(()=>host.snapshot().stream.enabled&&host.snapshot().visuals?.state==='ready','visual media ready');const s=host.snapshot();assert.notEqual(s.stream.backgroundUrl,s.stream.videoUrl);assert.equal(s.visuals.hasBackground,true);assert.equal(s.visuals.hasVideo,true);await capture('sources-1280-fr.png');});
 const bg=new BrowserWindow({show:false,width:640,height:360,transparent:true,webPreferences:{sandbox:true,contextIsolation:true}}),vid=new BrowserWindow({show:false,width:640,height:360,transparent:true,webPreferences:{sandbox:true,contextIsolation:true}});windows.push(bg,vid);for(const w of[bg,vid])w.webContents.on('console-message',(_e,d)=>{if(d.level==='error')errors.push(d.message);});
 await check('Actual authenticated Browser source displays the reserved background only',async()=>{await bg.loadURL(host.snapshot().stream.backgroundUrl);await until(()=>bg.webContents.executeJavaScript("document.querySelector('#background').complete&&document.querySelector('#background').naturalWidth===1&&!document.querySelector('#background').hidden"),'actual background decode');assert.equal(await bg.webContents.executeJavaScript("document.querySelector('#video').hasAttribute('src')"),false);await fs.writeFile(path.join(directory,'obs-background.png'),(await bg.webContents.capturePage()).toPNG());captures.push('obs-background.png');});
 await check('Actual R3.1 position-only clock keeps video transparent and paused while the background remains visible',async()=>{
  send('state',{phase:'playing',metadata,clock:{positionSeconds:.3,durationSeconds:10}});
  await until(()=>host.snapshot().telemetry.active?.clock?.positionSeconds===.3&&!host.snapshot().visuals.clockReady,'native position-only clock');
  await vid.loadURL(host.snapshot().stream.videoUrl);await delay(600);
  assert.equal(await vid.webContents.executeJavaScript("(()=>{const v=document.querySelector('#video');return v.hidden&&v.paused&&!v.hasAttribute('src');})()"),true);
  assert.equal(await bg.webContents.executeJavaScript("document.querySelector('#background').complete&&!document.querySelector('#background').hidden"),true);
  assert.equal(host.snapshot().visuals.hasVideo,true);assert.equal(host.snapshot().visuals.clockReady,false);
 });
 await check('Actual generated WebM decodes muted and follows native pause, seek and speed',async()=>{send('state',{phase:'paused',metadata,clock:{positionSeconds:.35,durationSeconds:10,speed:1}});await until(()=>host.snapshot().telemetry.phase==='paused','native pause arrived');await vid.loadURL(host.snapshot().stream.videoUrl);await until(()=>vid.webContents.executeJavaScript("(()=>{const v=document.querySelector('#video');return v.readyState>=2&&!v.hidden&&v.paused&&Math.abs(v.currentTime-.35)<.21;})()"),'actual WebM decode and native pause');const p=await vid.webContents.executeJavaScript("(()=>{const v=document.querySelector('#video');return{muted:v.muted,volume:v.volume,paused:v.paused,time:v.currentTime};})()");assert.equal(p.muted,true);assert.equal(p.volume,0);assert.equal(p.paused,true);assert.ok(Math.abs(p.time-.35)<.21);send('state',{phase:'paused',metadata,clock:{positionSeconds:1,durationSeconds:10,speed:.75}});await until(()=>vid.webContents.executeJavaScript("Math.abs(document.querySelector('#video').currentTime-1)<.21"),'actual seek');send('state',{phase:'playing',metadata,clock:{positionSeconds:.2,durationSeconds:10,speed:.75}});await until(()=>vid.webContents.executeJavaScript("!document.querySelector('#video').paused&&document.querySelector('#video').playbackRate===.75"),'actual resume');await fs.writeFile(path.join(directory,'obs-video.png'),(await vid.webContents.capturePage()).toPNG());captures.push('obs-video.png');});
 await check('Two source cards remain usable in English and narrow layout without overflow',async()=>{host.setLanguage('en');panel.setSize(1920,1080);await until(()=>evaluate("document.querySelector('#song-visuals-controls').textContent.includes('separate sources')"),'English');await capture('sources-1920-en.png');panel.setMinimumSize(320,500);panel.setSize(390,844);await capture('sources-390-en.png');assert.equal(await evaluate("document.documentElement.scrollWidth>innerWidth+1"),false);});
 await check('Widget settings fill the main column below the preview at both desktop widths',async()=>{
  for(const [width,height]of[[1280,900],[1920,1080]]){
   panel.setSize(width,height);await revealWorkspace(panel,'#widget-settings');
   await evaluate("document.querySelector('#widget-settings').scrollIntoView({block:'center',behavior:'instant'})");await delay(150);
   const geometry=await evaluate("(()=>{const settings=document.querySelector('.settings-card').getBoundingClientRect(),preview=document.querySelector('.preview-card').getBoundingClientRect();return{settings:settings.toJSON(),preview:preview.toJSON(),columns:getComputedStyle(document.querySelector('#widget-settings')).gridTemplateColumns};})()");
   assert.ok(geometry.settings.width>=geometry.preview.width-2,'settings use the available main-column width');
   const name='widget-settings-fullwidth-'+width+'.png';await fs.writeFile(path.join(directory,name),(await panel.webContents.capturePage()).toPNG());captures.push(name);
   await fs.writeFile(path.join(directory,name+'.json'),JSON.stringify(geometry,null,2)+'\n');
  }
 });
 await check('A real decoder failure clears the previous video and reports only the bounded current generation',async()=>{
  const revision=host.library.matchingSnapshot().revision;
  await fs.unlink(path.join(folder,'video.webm'));await fs.writeFile(path.join(folder,'video.mp4'),Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from('ftypisom'),Buffer.alloc(8),Buffer.from('not a playable film')]));
  await host.library.requestScan('full');await until(()=>host.library.status().status==='ready'&&host.library.matchingSnapshot().revision>revision,'changed synthetic media scan');
  send('state',{phase:'playing',metadata,clock:{positionSeconds:.1,durationSeconds:10,speed:1}});
  await until(()=>host.snapshot().visuals.videoReason==='decoder','actual decoder report');
  await until(()=>vid.webContents.executeJavaScript("document.querySelector('#video').hidden&&!document.querySelector('#video').hasAttribute('src')&&document.querySelector('#notice').hidden"),'transparent failed video');
  assert.equal(host.snapshot().visuals.hasBackground,true);assert.equal(await bg.webContents.executeJavaScript("document.querySelector('#background').hidden"),false);
 });
 await check('Ending the actual fixture song clears both OBS sources immediately',async()=>{send('state',{phase:'menu'});await until(()=>bg.webContents.executeJavaScript("document.querySelector('#background').hidden&&!document.querySelector('#background').hasAttribute('src')"),'clear image');await until(()=>vid.webContents.executeJavaScript("document.querySelector('#video').hidden&&!document.querySelector('#video').hasAttribute('src')"),'clear video');assert.equal(host.snapshot().visuals.state,'waiting');});
 assert.deepEqual(errors,[]);await finish();
}).catch(finish);
