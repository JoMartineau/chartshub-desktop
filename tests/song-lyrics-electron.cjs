'use strict';
// Isolated host, actual renderer/IPC/OBS browser, synthetic chart and telemetry.
// No game, production profile, real lyrics, real Songs folder or accounts.
const {app,BrowserWindow}=require('electron'),fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {registerFixtureMaintenance,revealWorkspace}=require('./workspace-input.cjs');const disposeMaintenance=registerFixtureMaintenance();
const arg=process.argv.find(v=>v.startsWith('--fixture-output='));if(!arg)throw Error('Explicit fixture output required');
const output=path.resolve(arg.slice('--fixture-output='.length)),directory=path.join(output,'lyrics-'+randomUUID());
app.setPath('userData',path.join(directory,'electron-profile'));process.env.LOCALAPPDATA=path.join(directory,'local-app-data');app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const {createCompanionHost,registerCompanionScheme}=require('../companion/host.cjs'),contract=require('../companion/clonehero-telemetry-contract.cjs'),{SUPPORTED_BUILDS}=require('../companion/clonehero-telemetry-source.cjs');registerCompanionScheme();
console.log(JSON.stringify({fixturePid:process.pid,directory,phase:'starting'}));
let host,panel,obs,server,peer,timer,sequence=0,finishing=false;const peers=[],checks=[],captures=[],errors=[];const deadline=setTimeout(()=>void finish(Error('Lyrics fixture exceeded90 seconds')),90000);
const provider={id:'chartshub.clonehero.il2cpp',version:'0.1.3'},game=SUPPORTED_BUILDS[0],sessionId='lyrics-fixture-session',attemptId='lyrics-fixture-song';
const metadata={title:'Synthetic chart',artist:'Fixture group',charter:'Fixture author',instrument:'Guitar',difficulty:'Expert'};
const caps=Object.fromEntries(contract.CAPABILITIES.map(k=>[k,['clock','songMetadata'].includes(k)]));
const delay=ms=>new Promise(r=>setTimeout(r,ms));async function until(check,label,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(25);}throw Error('Timed out: '+label);}
const evaluate=code=>panel.webContents.executeJavaScript(code),obsEval=code=>obs.webContents.executeJavaScript(code);
function send(type,data={}){assert.ok(peer&&!peer.destroyed);peer.write(JSON.stringify({schema:contract.SCHEMA,provider,game,sessionId,attemptId,playerId:0,sequence:sequence++,type,data})+'\n');}
async function command(name,payload){const r=await evaluate(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`);assert.equal(r.ok,true,JSON.stringify(r));return r;}
const revision=()=>host.snapshot().editor.revision;
async function click(selector){await revealWorkspace(panel,selector);const p=await evaluate(`(async()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'center',behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),p={x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)},h=document.elementFromPoint(p.x,p.y);if(n.disabled||!h||!(h===n||n.contains(h)))throw Error('Unavailable/covered control');return p;})()`);panel.webContents.focus();for(const type of ['mouseMove','mouseDown','mouseUp'])panel.webContents.sendInputEvent({type,...p,...(type==='mouseMove'?{}:{button:'left',clickCount:1})});await delay(75);}
async function check(name,fn){await fn();checks.push({name,result:'passed'});console.log('PASS '+name);}
async function capture(name,window=panel){await delay(100);await fs.writeFile(path.join(directory,name),(await window.webContents.capturePage()).toPNG());captures.push(name);}
const lyricNode="#game-preview [data-widget-id='song-lyrics'] .companion-widget-text",obsNode="[data-widget-id='song-lyrics'] .companion-widget-text";
async function finish(error){
 if(finishing)return;finishing=true;clearTimeout(deadline);clearInterval(timer);let disposeResolved=false;
 try{
  if(error&&panel&&!panel.isDestroyed())await capture('failure.png');
  if(obs&&!obs.isDestroyed()){await obs.loadURL('about:blank');obs.close();}
  for(const p of peers)p.destroy();if(server?.listening)await new Promise(r=>server.close(r));
  if(host){let alarm;try{await Promise.race([host.dispose(),new Promise((_,j)=>{alarm=setTimeout(()=>j(Error('Host disposal timed out')),10000);})]);disposeResolved=true;}finally{clearTimeout(alarm);}}
  await until(()=>BrowserWindow.getAllWindows().length===0,'fixture windows closed',3000);disposeMaintenance();
 }catch(failure){error=error||failure;}
 await fs.mkdir(directory,{recursive:true});const report={result:error?'failed':'passed',pid:process.pid,checks,captures,error:error?String(error.stack||error):null,errors,disposeResolved,windowCount:BrowserWindow.getAllWindows().length,syntheticChart:true,syntheticGameFrames:true,realUserProfileRead:false,realUserLibraryRead:false,gameLaunched:false,actualHostIpcAndObs:true};
 await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({directory,...report}));process.exitCode=error?1:0;if(error)app.exit(1);else app.quit();
}
process.on('uncaughtException',error=>void finish(error));process.on('unhandledRejection',error=>void finish(error));
app.whenReady().then(async()=>{
 await fs.mkdir(directory,{recursive:true});const root=path.join(directory,'Songs'),folder=path.join(root,'Fixture');await fs.mkdir(folder,{recursive:true});
 await fs.writeFile(path.join(folder,'notes.chart'),'[Song]\n{\nResolution = 192\n}\n[SyncTrack]\n{\n0 = B 120000\n}\n[Events]\n{\n0 = E "phrase_start"\n0 = E "lyric Synthetic"\n192 = E "lyric marker_one"\n1536 = E "phrase_end"\n2304 = E "phrase_start"\n2304 = E "lyric Next_marker"\n3840 = E "phrase_end"\n}\n[ExpertSingle]\n{\n0 = N 0 0\n}\n');
 await fs.writeFile(path.join(folder,'song.ini'),'[song]\nname=Synthetic chart\nartist=Fixture group\ncharter=Fixture author\n');
 const connection=path.join(process.env.LOCALAPPDATA,'ChartsHub/Telemetry/v1');await fs.mkdir(connection,{recursive:true});const descriptor={schema:contract.DESCRIPTOR_SCHEMA,provider,game,sessionId,pipeName:'ChartsHub.CloneHero.Telemetry.'+randomUUID(),nonce:'e'.repeat(64),pid:process.pid};
 server=net.createServer(socket=>{peers.push(socket);let buffer='';socket.on('error',()=>{});socket.on('data',b=>{buffer+=b.toString();if(!buffer.includes('\n'))return;const h=JSON.parse(buffer.slice(0,buffer.indexOf('\n')));assert.equal(h.nonce,descriptor.nonce);peer=socket;send('hello',{capabilities:caps,coverage:'since-connect',state:{phase:'paused',metadata,clock:{positionSeconds:1,durationSeconds:12,speed:1}}});});});await new Promise((r,j)=>{server.once('error',j);server.listen('\\\\.\\pipe\\'+descriptor.pipeName,r);});await fs.writeFile(path.join(connection,'connection.json'),JSON.stringify(descriptor));
 host=await createCompanionHost({dataDirectory:path.join(directory,'companion'),cloneHeroCandidates:[],cloneHeroProcessProbe:async()=>({running:false,sessions:[]}),isCatalogueAvailable:()=>false,authorizeCatalogue:async()=>false,catalogueClient:{async load(){return{items:[],revision:'lyrics-fixture',demo:false};},async artwork(){return null;}}});panel=await host.open();panel.setSize(1280,900);panel.webContents.on('console-message',(_e,d)=>{if(d.level==='error')errors.push(d.message);});
 await until(()=>evaluate("!!document.querySelector('[data-lyrics-next]')"),'lyrics controls');await until(()=>host.snapshot().telemetry?.connected,'synthetic telemetry');timer=setInterval(()=>{if(peer&&!peer.destroyed)send('heartbeat');},1000);
 await host.library.selectRoot(root);await host.library.requestScan('full');await until(()=>host.library.status().status==='ready','synthetic scan');
 await check('Lyrics starts hidden on both destinations and only scanned chart text becomes a visible game widget',async()=>{
  assert.deepEqual(host.snapshot().state.widgets.instances.find(w=>w.id==='song-lyrics').visibility,{game:false,stream:false});assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(lyricNode)})`),false);
  await command('widget.visibility',{revision:revision(),id:'song-lyrics',game:true,stream:true,gameplayVisibility:['playing','paused']});await until(()=>evaluate(`document.querySelector(${JSON.stringify(lyricNode)})?.textContent==='Synthetic marker one'`),'game lyrics');assert.equal(host.snapshot().visuals.hasLyrics,true);assert.equal(host.snapshot().stream.enabled,false,'game lyrics need no OBS server');
 });
 await check('Native next-line checkbox updates real game/OBS widgets and font/color stay independently configurable',async()=>{
  await click('[data-lyrics-next="song-lyrics"]');await until(()=>host.snapshot().state.widgets.instances.find(w=>w.id==='song-lyrics').config.showNextLine===true,'nextline config');await until(()=>evaluate(`document.querySelector(${JSON.stringify(lyricNode)})?.textContent==='Synthetic marker one\\nNext marker'`),'second line');
  await command('widget.fontSize',{revision:revision(),id:'song-lyrics',fontSize:32});const w=host.snapshot().state.widgets.instances.find(w=>w.id==='song-lyrics');await command('widget.appearance',{revision:revision(),id:w.id,style:{...w.style,colorMode:'custom',color:'#7cf0dd'}});
  const value=await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(lyricNode)});return{font:getComputedStyle(n.parentElement).fontSize,color:getComputedStyle(n.parentElement).color};})()`);assert.deepEqual(value,{font:'32px',color:'rgb(124, 240, 221)'});
  await revealWorkspace(panel,'#game-preview');await evaluate("document.querySelector('#game-preview').scrollIntoView({block:'center',behavior:'instant'})");await capture('lyrics-game-1280-fr.png');
 });
 const free=net.createServer();await new Promise(r=>free.listen(0,'127.0.0.1',r));const port=free.address().port;await new Promise(r=>free.close(r));await command('stream.settings',{revision:revision(),settings:{...host.snapshot().state.stream,port}});await command('stream.enabled',{enabled:true});
 obs=new BrowserWindow({show:false,width:1280,height:720,transparent:true,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});obs.webContents.on('console-message',(_e,d)=>{if(d.level==='error')errors.push(d.message);});
 await check('Actual authenticated OBS Browser source renders current+next text with independent Stream position',async()=>{
  await command('widget.layout',{revision:revision(),destination:'stream',items:[{id:'song-lyrics',x:80,y:100,width:900,height:120}]});await obs.loadURL(host.snapshot().stream.url);await until(()=>obsEval(`document.querySelector(${JSON.stringify(obsNode)})?.textContent==='Synthetic marker one\\nNext marker'`),'OBS lyrics');
  const style=await obsEval("(()=>{const n=document.querySelector('[data-widget-id=\"song-lyrics\"]');return{left:n.style.left,top:n.style.top,font:n.style.fontSize};})()");assert.deepEqual(style,{left:'80px',top:'100px',font:'32px'});assert.equal(host.snapshot().state.widgets.instances.find(w=>w.id==='song-lyrics').position.x,280);await capture('lyrics-obs-current-next.png',obs);
 });
 await check('Pause, backward seek, native speed, instrumental gaps and stale/speedless clocks stay synchronized',async()=>{
  send('state',{phase:'paused',metadata,clock:{positionSeconds:7,durationSeconds:12,speed:.75}});await until(()=>obsEval(`document.querySelector(${JSON.stringify(obsNode)})?.textContent==='Next marker'`),'seek forward');
  send('state',{phase:'paused',metadata,clock:{positionSeconds:1,durationSeconds:12,speed:1.5}});await until(()=>obsEval(`document.querySelector(${JSON.stringify(obsNode)})?.textContent==='Synthetic marker one\\nNext marker'`),'seek back');
  send('state',{phase:'playing',metadata,clock:{positionSeconds:3.9,durationSeconds:12,speed:.75}});await until(()=>obsEval(`!document.querySelector(${JSON.stringify(obsNode)})`),'gap reached by native speed');
  send('state',{phase:'paused',metadata,clock:{positionSeconds:1,durationSeconds:12}});await until(()=>host.snapshot().visuals.clockReady===false,'legacy clock');assert.equal(await obsEval(`!!document.querySelector(${JSON.stringify(obsNode)})`),false);
  send('state',{phase:'playing',metadata,clock:{positionSeconds:1,durationSeconds:12,speed:1}});await until(()=>obsEval(`!!document.querySelector(${JSON.stringify(obsNode)})`),'fresh clock');await delay(2800);await until(()=>obsEval(`!document.querySelector(${JSON.stringify(obsNode)})`),'unchanged clock expires');
 });
 await check('Narrow English controls retain usable lyrics settings without horizontal overflow',async()=>{
  host.setLanguage('en');panel.setMinimumSize(320,500);panel.setSize(390,844);await revealWorkspace(panel,'[data-lyrics-next]');await until(()=>evaluate("document.querySelector('#widget-settings').textContent.includes('Also show the next line')"),'English lyrics');await evaluate("document.querySelector('[data-lyrics-next]').scrollIntoView({block:'center',behavior:'instant'})");await capture('lyrics-controls-390-en.png');assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'),false);
 });
 await check('Literal single-word lyrics and their optional successors render in the actual Game and OBS widgets',async()=>{
  const words=['Unknown','Null','Undefined','Na'];
  await fs.writeFile(path.join(folder,'notes.chart'),'[Song]\n{\nResolution = 192\n}\n[SyncTrack]\n{\n0 = B 120000\n}\n[Events]\n{\n'+words.map((word,i)=>`${i*384} = E "phrase_start"\n${i*384} = E "lyric ${word}"\n${i*384+192} = E "phrase_end"`).join('\n')+'\n}\n[ExpertSingle]\n{\n0 = N 0 0\n}\n');
  send('state',{phase:'paused',metadata,clock:{positionSeconds:.1,durationSeconds:12,speed:1}});await host.library.requestScan('full');await until(()=>host.library.status().status==='ready'&&host.snapshot().state.lyrics?.current==='Unknown','literal chart parsed');
  for(let i=0;i<words.length;i++){
   send('state',{phase:'paused',metadata,clock:{positionSeconds:i+.1,durationSeconds:12,speed:1}});const expected=[words[i],...(words[i+1]?[words[i+1]]:[])].join('\n');
   await until(()=>evaluate(`document.querySelector(${JSON.stringify(lyricNode)})?.textContent===${JSON.stringify(expected)}`),'literal game '+words[i]);
   await until(()=>obsEval(`document.querySelector(${JSON.stringify(obsNode)})?.textContent===${JSON.stringify(expected)}`),'literal OBS '+words[i]);
   if(i===0){obs.showInactive();await delay(200);await capture('lyrics-literal-words-obs.png',obs);obs.hide();}
  }
 });
 await check('Missing chart lyrics and the menu clear both destinations without placeholders',async()=>{
  send('state',{phase:'paused',metadata,clock:{positionSeconds:1,durationSeconds:12,speed:1}});await until(()=>obsEval(`!!document.querySelector(${JSON.stringify(obsNode)})`),'restored lyrics');
  await fs.writeFile(path.join(folder,'notes.chart'),'[Song]\n{\nResolution = 192\n}\n[ExpertSingle]\n{\n0 = N 0 0\n}\n');await host.library.requestScan('full');await until(()=>host.library.status().status==='ready'&&host.snapshot().visuals.lyricsReason==='missing','missing lyrics detected');await until(()=>obsEval(`!document.querySelector(${JSON.stringify(obsNode)})`),'missing lyrics transparent');assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(lyricNode)})`),false);
  send('state',{phase:'menu'});await until(()=>host.snapshot().visuals.state==='waiting','menu clears');assert.equal(host.snapshot().state.lyrics,null);
 });
 assert.deepEqual(errors,[]);await finish();
}).catch(finish);
