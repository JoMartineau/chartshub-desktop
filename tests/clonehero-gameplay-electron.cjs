'use strict';
// Actual renderer, production IPC/host and Windows named pipe; all game data is synthetic.
// No real game, accounts, Song folders or user profile are read or changed.
const {app,BrowserWindow}=require('electron'),fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
// Isolated checkouts reuse an explicitly supplied, installed dependency tree.
if(process.env.NODE_PATH)require('node:module').Module._initPaths();
const {registerFixtureMaintenance,revealWorkspace}=require('./workspace-input.cjs');
const disposeFixtureMaintenance=registerFixtureMaintenance();
const outputArg=process.argv.find(value=>value.startsWith('--fixture-output='));if(!outputArg)throw Error('An explicit --fixture-output directory is required');
const output=path.resolve(outputArg.slice('--fixture-output='.length)),directory=path.join(output,'gameplay-'+randomUUID());
if(!directory.startsWith(output+path.sep)||path.basename(directory).slice(0,9)!=='gameplay-')throw Error('Invalid disposable fixture output');
console.log(JSON.stringify({fixturePid:process.pid,directory,phase:'starting'}));
app.setPath('userData',path.join(directory,'electron-profile'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
process.env.LOCALAPPDATA=path.join(directory,'local-app-data');
const {createCompanionHost,registerCompanionScheme}=require('../companion/host.cjs'),contract=require('../companion/clonehero-telemetry-contract.cjs'),{SUPPORTED_BUILDS}=require('../companion/clonehero-telemetry-source.cjs');
registerCompanionScheme();
const checks=[],runtimeErrors=[],consoleErrors=[],peers=[],captures=[],obsWindows=[],obsEvidence=[];let host,panel,server,timer,sequence=0,peer,finishing=false;
const deadline=setTimeout(()=>void finish(Error('Electron gameplay fixture exceeded100 seconds')),100000);
process.on('uncaughtException',error=>void finish(error));process.on('unhandledRejection',error=>void finish(error));
const provider={id:'chartshub.clonehero.il2cpp',version:'0.1.0'},game=SUPPORTED_BUILDS[0],sessionId='fixture-session';let attemptId='fixture-attempt';
const capabilities=Object.fromEntries(contract.CAPABILITIES.map(k=>[k,true]));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await delay(25);}throw Error('Timed out: '+label);}
function send(type,data={}){assert.ok(peer&&!peer.destroyed);peer.write(JSON.stringify({schema:contract.SCHEMA,provider,game,sessionId,attemptId,playerId:0,sequence:sequence++,type,data})+'\n');}
const evaluate=code=>panel.webContents.executeJavaScript(code);
async function command(name,payload={}){const r=await evaluate(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`);assert.equal(r.ok,true,JSON.stringify(r));return r;}
async function click(selector){await revealWorkspace(panel,selector);const point=await evaluate(`(async()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Unavailable native control');n.scrollIntoView({block:'center',behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),p={x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)},hit=document.elementFromPoint(p.x,p.y);if(!hit||!(hit===n||n.contains(hit)))throw Error('Covered native control');return p;})()`);panel.focus();panel.webContents.focus();for(const type of ['mouseMove','mouseDown','mouseUp'])panel.webContents.sendInputEvent({type,...point,...(type==='mouseMove'?{}:{button:'left',clickCount:1})});await delay(60);}
async function calibrationField(selector,value){await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Unavailable calibration input');n.value=${JSON.stringify(String(value))};n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));})()`);}
async function check(name,fn){await fn();checks.push({name,result:'passed'});console.log('PASS '+name);}
async function captureNativeResults(name){
 await revealWorkspace(panel,'.performance-calibration-results');
 await evaluate("new Promise(resolve=>{document.querySelector('.performance-calibration-results').scrollIntoView({block:'center',behavior:'instant'});requestAnimationFrame(()=>requestAnimationFrame(resolve));})");
 await delay(120);
 const evidence=await evaluate("(()=>{const n=document.querySelector('.performance-calibration-results'),r=n.getBoundingClientRect();return{viewport:{width:innerWidth,height:innerHeight},rect:r.toJSON(),cards:[...n.querySelectorAll('.performance-calibration-result')].map(c=>({stage:c.dataset.stage,value:c.querySelector('.performance-calibration-result-value').textContent,state:c.querySelector('.helper-text').textContent}))};})()");
 assert.ok(evidence.rect.top>=-1&&evidence.rect.bottom<=evidence.viewport.height,'both native results fit inside capture');
 assert.equal(await evaluate("document.documentElement.scrollWidth>innerWidth+1"),false,'native calibration panel fits width');
 await fs.writeFile(path.join(directory,name),(await panel.webContents.capturePage()).toPNG());
 await fs.writeFile(path.join(directory,name+'.json'),JSON.stringify(evidence,null,2)+'\n');captures.push(name);
}
async function capture(name){let evidence;if(!name.includes('failure')){await until(()=>evaluate("document.querySelector('#performance-panel')?.dataset.companionWorkspaces?.includes('stream')"),'workspace attributes before screenshot');await revealWorkspace(panel,'#performance-controls');await evaluate("new Promise(resolve=>{document.querySelector('#performance-controls').scrollIntoView({block:'start',behavior:'instant'});requestAnimationFrame(()=>requestAnimationFrame(resolve));})");await delay(300);evidence=await evaluate("({workspace:document.querySelector('#companion-app').dataset.workspace,rect:document.querySelector('.performance-metrics').getBoundingClientRect().toJSON(),viewport:{width:innerWidth,height:innerHeight},metrics:[...document.querySelectorAll('.performance-metrics dd')].map(n=>n.textContent),status:document.querySelector('.performance-status').textContent})");assert.equal(evidence.workspace,'stream');assert.ok(evidence.rect.top>=-1&&evidence.rect.bottom<=evidence.viewport.height,'six metrics must fit inside actual capture viewport');}await fs.writeFile(path.join(directory,name),(await panel.webContents.capturePage()).toPNG());if(evidence)await fs.writeFile(path.join(directory,name+'.json'),JSON.stringify(evidence,null,2)+'\n');captures.push(name);}
const cleanup=[];
async function cleanupStep(name,action,timeout=10000){
 const started=Date.now();let alarm;
 console.log(JSON.stringify({phase:'cleanup-start',name,at:new Date().toISOString()}));
 try{await Promise.race([Promise.resolve().then(action),new Promise((_,reject)=>{alarm=setTimeout(()=>reject(Error('Cleanup timed out: '+name)),timeout);})]);cleanup.push({name,result:'passed',durationMs:Date.now()-started});}
 catch(error){cleanup.push({name,result:'failed',durationMs:Date.now()-started,error:String(error.stack||error)});throw error;}
 finally{clearTimeout(alarm);console.log(JSON.stringify({phase:'cleanup-end',...cleanup.at(-1)}));}
}
async function finish(error){
 if(finishing)return;finishing=true;clearTimeout(deadline);clearInterval(timer);
 if(error&&panel&&!panel.isDestroyed())try{await cleanupStep('failure capture',()=>capture('fixture-failure.png'),1500);}catch{}
 // Own OBS windows navigate away first, allowing their WebSocket clients to close.
 // Timeouts reject: an unresolved production dispose must never count as a pass.
 for(const [index,window]of obsWindows.entries())if(!window.isDestroyed()){
  try{await cleanupStep('OBS transport and window '+index,async()=>{await window.loadURL('about:blank');await new Promise(resolve=>{window.once('closed',resolve);window.close();});},5000);}catch(failure){error=error||failure;}
 }
 if(host)try{await cleanupStep('OBS clients disconnected',()=>until(()=>host.snapshot().stream.clients===0,'zero OBS clients',3000),3500);}catch(failure){error=error||failure;}
 try{await cleanupStep('synthetic named pipe',async()=>{
  await Promise.all(peers.filter(socket=>!socket.closed).map(socket=>new Promise(resolve=>{socket.once('close',resolve);socket.destroy();})));
  if(server?.listening)await new Promise((resolve,reject)=>server.close(failure=>failure?reject(failure):resolve()));
  assert.ok(!server?.listening);assert.ok(peers.every(socket=>socket.destroyed));
 },3000);}catch(failure){error=error||failure;}
 if(host)try{await cleanupStep('host.dispose resolved',async()=>{await host.dispose();assert.ok(!host.getPanel()||host.getPanel().isDestroyed(),'host panel destroyed');assert.equal(host.snapshot().stream.enabled,false,'host stream stopped');},10000);}catch(failure){error=error||failure;}
 try{await cleanupStep('all fixture windows closed',async()=>{await until(()=>BrowserWindow.getAllWindows().length===0,'zero fixture windows',3000);disposeFixtureMaintenance();},3500);}catch(failure){error=error||failure;}
 try{
  await fs.mkdir(directory,{recursive:true});
  const report={result:error?'failed':'passed',pid:process.pid,checks,captures,obsEvidence,cleanup,error:error?String(error.stack||error):null,runtimeErrors,consoleErrors,syntheticGameMeasurements:true,realGameExecuted:false,realUserProfileRead:false,actualHostAndIpc:true,actualWindowsNamedPipe:true};
  await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({directory,result:report.result,checks:checks.length,captures,error:report.error,phase:'quit-requested'}));
 }catch(failure){console.error(failure);error=error||failure;}
 process.exitCode=error?1:0;
 for(const event of ['before-quit','will-quit','quit'])app.once(event,()=>console.log(JSON.stringify({phase:'app-'+event,at:new Date().toISOString()})));
 // Natural application quit is observed by the external runner; no forced success.
 if(error)app.exit(1);else app.quit();
}
app.whenReady().then(async()=>{
 await fs.mkdir(directory,{recursive:true});
 const connection=path.join(process.env.LOCALAPPDATA,'ChartsHub/Telemetry/v1');await fs.mkdir(connection,{recursive:true});
 const descriptor={schema:contract.DESCRIPTOR_SCHEMA,provider,game,sessionId,pipeName:'ChartsHub.CloneHero.Telemetry.'+randomUUID(),nonce:'a'.repeat(64),pid:process.pid};
 server=net.createServer(socket=>{peers.push(socket);let buffer='';socket.on('error',()=>{});socket.on('data',bytes=>{buffer+=bytes.toString();if(!buffer.includes('\n'))return;const handshake=JSON.parse(buffer.slice(0,buffer.indexOf('\n')));assert.equal(handshake.schema,'chartshub.clonehero.handshake.v1');assert.equal(handshake.nonce,descriptor.nonce);peer=socket;send('hello',{capabilities,coverage:'from-attempt-start',state:{phase:'playing',metadata:{chartId:'b'.repeat(64),title:'Signal de test',artist:'Groupe fictif',instrument:'Guitar',difficulty:'Expert'},stats:{combo:0,score:0,misses:0,overstrums:0,notesHit:0,notesTotal:40},clock:{positionSeconds:0,durationSeconds:240,speed:1}}});});});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen('\\\\.\\pipe\\'+descriptor.pipeName,resolve);});
 await fs.writeFile(path.join(connection,'connection.json'),JSON.stringify(descriptor));
 host=await createCompanionHost({dataDirectory:path.join(directory,'companion'),cloneHeroCandidates:[],cloneHeroProcessProbe:async()=>({running:false,sessions:[]}),isCatalogueAvailable:()=>false,authorizeCatalogue:async()=>false,catalogueClient:{async load(){return{items:[],revision:'fixture',demo:false};},async artwork(){return null;}}});
 panel=await host.open();panel.setSize(1280,900);panel.webContents.on('console-message',(_e,details)=>{if(details.level==='error')consoleErrors.push(details.message);});
 panel.webContents.on('render-process-gone',(_e,details)=>runtimeErrors.push(details.reason));
 await until(()=>evaluate("!!window.ChartsHubCompanion&&!!document.querySelector('#performance-controls .performance-status')"),'actual controls');
 await until(()=>host.snapshot().telemetry?.connected,'pipe connection');timer=setInterval(()=>{if(peer&&!peer.destroyed)send('heartbeat');},1000);
 await check('Seven gameplay widget types remain available through real host state',async()=>{const types=host.snapshot().state.widgets.instances.map(w=>w.type);for(const t of ['gameplay.accuracy','gameplay.combo','gameplay.fc','gameplay.progress','gameplay.comparison','session.goal','session.history'])assert.ok(types.includes(t),t);});
 await check('Actual accepted fixture frames reach six renderer timing measurements',async()=>{for(let i=0;i<40;i++)send('hit',{offsetMs:i%2?20:-20,stats:{combo:i+1,score:(i+1)*100,notesHit:i+1,notesTotal:40,misses:0,overstrums:0}});await until(()=>host.snapshot().telemetry?.timing?.sampleCount===40,'40 measurements');await revealWorkspace(panel,'#performance-panel');await until(()=>evaluate("document.querySelector('.performance-metrics').textContent.includes('40')"),'renderer samples');const t=host.snapshot().telemetry.timing;assert.ok(Math.abs(t.meanOffsetMs)<1e-10,'floating point running mean is zero within numerical tolerance');assert.equal(t.meanAbsoluteOffsetMs,20);assert.equal(t.withinWindowPercent,100);assert.equal(await evaluate("document.querySelectorAll('.performance-metrics dd').length"),6);await capture('accuracy-fixture-1280-fr.png');});
 await check('Native add widgets button enables all seven OBS elements without removing old ones',async()=>{const before=host.snapshot().state.widgets.instances.length;await click('.performance-actions button');await until(()=>host.snapshot().state.widgets.instances.filter(w=>['gameplay.accuracy','gameplay.combo','gameplay.fc','gameplay.progress','gameplay.comparison','session.goal','session.history'].includes(w.type)).every(w=>w.enabled&&w.visibility.stream),'enabled widgets');assert.equal(host.snapshot().state.widgets.instances.length,before);await click('.performance-actions button');assert.equal(host.snapshot().state.widgets.instances.length,before,'idempotent');});
 await check('Timing window changes recalculate true samples and persist actual IPC settings',async()=>{await command('telemetry.configure',{windowMs:15,goal:{kind:'minutes',target:30}});await until(()=>host.snapshot().telemetry.settings.windowMs===15,'settings');assert.equal(host.snapshot().telemetry.timing.withinWindowPercent,0);const saved=JSON.parse(await fs.readFile(path.join(directory,'companion/clonehero-telemetry.json')));assert.equal(saved.windowMs,15);});
 await check('Native calibration channel is kept separate from chart timing',async()=>{await command('telemetry.calibrationStart',{stage:'audio',settingMs:100,source:'tool'});for(let i=0;i<32;i++)send('calibration',{stage:'audio',offsetMs:5,calibrationAttemptId:'audio-fixture-one'});await until(()=>host.snapshot().telemetry.calibration.trial?.sampleCount===32,'calibration samples');await command('telemetry.calibrationFinish');assert.equal(host.snapshot().telemetry.timing.sampleCount,40);assert.equal(host.snapshot().telemetry.calibration.trials.length,1);});
 await check('Native audio/video absolute values appear separately through the real pipe and local renderer',async()=>{
  await until(()=>evaluate("document.querySelector('#source-mode-label').textContent==='MESURES CLONE HERO'&&document.querySelector('#source-mode-badge').classList.contains('is-live')"),'actual telemetry header in French');
  await click('.performance-calibration summary');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.performance-calibration-result-value')].map(n=>n.textContent)"),['—','—']);
  send('calibrationResult',{stage:'audio',settingMs:18,calibrationAttemptId:'audio-fixture-one'});
  send('calibration',{stage:'video',offsetMs:-100,calibrationAttemptId:'video-fixture-one'});
  send('calibration',{stage:'video',offsetMs:-100,calibrationAttemptId:'video-fixture-one'});
  send('calibrationResult',{stage:'video',settingMs:-27,calibrationAttemptId:'video-fixture-one'});
  await until(()=>host.snapshot().telemetry.calibration.nativeResults.video?.settingMs===-27,'native results accepted');
  await until(()=>evaluate("document.querySelector('[data-stage=audio] .performance-calibration-result-value').textContent==='18 ms'&&document.querySelector('[data-stage=video] .performance-calibration-result-value').textContent==='-27 ms'"),'separate absolute native values');
  assert.equal(host.snapshot().telemetry.calibration.nativeResults.audio.sampleCount,32);assert.equal(host.snapshot().telemetry.calibration.nativeResults.video.sampleCount,2);
  assert.equal(host.snapshot().telemetry.timing.sampleCount,40);assert.equal(host.snapshot().telemetry.calibration.trials[0].settingMs,100,'manual comparison setting is not added to the native result');
  assert.ok(await evaluate("document.querySelector('.performance-calibration').textContent.includes('pas un décalage à ajouter')"));
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-calibration-step]>h3')].map(n=>n.textContent)"),['1. Choisir le réglage','2. Choisir la méthode','3. Faire l’essai','4. Lire le résultat et comparer']);
  assert.deepEqual(await evaluate("[...document.querySelector('#calibration-method').options].map(n=>n.value)"),['native','manual','gameplay']);
  assert.equal(await evaluate("document.querySelector('#calibration-method').value"),'native');
  assert.equal(await evaluate("document.querySelector('#calibration-setting').value"),'','no assumed current game setting');
  await captureNativeResults('native-calibration-fr.png');
  host.setLanguage('en');await until(()=>evaluate("document.querySelector('[data-stage=audio] h3').textContent==='Audio delay'&&document.querySelector('#source-mode-label').textContent==='CLONE HERO DATA'&&document.querySelector('.performance-feedback').textContent==='Action completed.'"),'English native cards, telemetry header and action feedback');
  const minimum=panel.getMinimumSize();panel.setSize(Math.max(minimum[0],800),Math.max(minimum[1],750));await captureNativeResults('native-calibration-min-en.png');
 });
 await check('Native results can be reused in separate local Audio and Video drafts without changing game values',async()=>{
  await click('[data-stage=audio] .button');assert.equal(await evaluate("document.querySelector('#calibration-setting').value"),'18');
  await calibrationField('#calibration-stage','video');assert.equal(await evaluate("document.querySelector('#calibration-setting').value"),'');
  await click('[data-stage=video] .button');assert.equal(await evaluate("document.querySelector('#calibration-setting').value"),'-27');
  await calibrationField('#calibration-stage','audio');assert.equal(await evaluate("document.querySelector('#calibration-setting').value"),'18');
  assert.match(await evaluate("document.querySelector('.performance-feedback').textContent"),/No game setting was changed/);
  assert.deepEqual(Object.fromEntries(Object.entries(host.snapshot().telemetry.calibration.nativeResults).map(([key,value])=>[key,value.settingMs])),{audio:18,video:-27});
  assert.equal(host.snapshot().telemetry.calibration.trial,null);
 });
 await check('Manual Audio and Video trials route native samples, require thirty continuous measurements and filter their histories',async()=>{
  await calibrationField('#calibration-method','manual');await calibrationField('#calibration-setting','112');
  await click('#calibration-start');await until(()=>host.snapshot().telemetry.calibration.trial?.settingMs===112,'manual audio start');
  assert.equal(host.snapshot().telemetry.calibration.trial.source,'tool');
  assert.match(await evaluate("document.querySelector('.performance-feedback').textContent"),/Trial started.*No game setting was changed/);
  send('hit',{offsetMs:90});for(let i=0;i<29;i++)send('calibration',{stage:'audio',offsetMs:5,calibrationAttemptId:'manual-audio-one'});
  await until(()=>host.snapshot().telemetry.calibration.trial?.sampleCount===29,'manual native samples only');
  await until(()=>evaluate("document.querySelector('#calibration-finish').disabled"),'manual finish disabled below30');
  send('calibration',{stage:'audio',offsetMs:5,calibrationAttemptId:'manual-audio-one'});await until(()=>evaluate("!document.querySelector('#calibration-finish').disabled"),'manual finish available');
  await click('#calibration-finish');await until(()=>host.snapshot().telemetry.calibration.trial===null,'manual audio finished');
  assert.match(await evaluate("document.querySelector('.performance-feedback').textContent"),/Trial kept/);
  await calibrationField('#calibration-stage','video');assert.equal(await evaluate("document.querySelector('#calibration-setting').value"),'-27');
  assert.equal(await evaluate("document.querySelector('.performance-trials').children.length"),0,'audio trials stay out of video history');
  await calibrationField('#calibration-setting','13');await click('#calibration-start');
  send('calibration',{stage:'audio',offsetMs:100,calibrationAttemptId:'wrong-stage-one'});
  await until(()=>host.snapshot().telemetry.calibration.trial?.incomplete,'wrong native stage interrupts video trial');
  assert.equal(await evaluate("document.querySelector('#calibration-finish').disabled"),true);
  await click('#calibration-start');for(let i=0;i<30;i++)send('calibration',{stage:'video',offsetMs:-4,calibrationAttemptId:'manual-video-one'});
  await until(()=>evaluate("!document.querySelector('#calibration-finish').disabled"),'restarted video trial ready');await click('#calibration-finish');
  await until(()=>evaluate("document.querySelector('.performance-trials').children.length===1"),'video-only native history');
  assert.match(await evaluate("document.querySelector('.performance-trials').textContent"),/13\.0 ms/);
  assert.doesNotMatch(await evaluate("document.querySelector('.performance-trials').textContent"),/112\.0 ms/);
 });
 await check('In-game analysis keeps its own history, shows early/late and dispersion, and compares only after matching-condition confirmation',async()=>{
  await calibrationField('#calibration-stage','audio');assert.equal(await evaluate("document.querySelector('#calibration-setting').value"),'112');
  await calibrationField('#calibration-method','gameplay');assert.equal(await evaluate("document.querySelector('.performance-trials').children.length"),0,'native trials excluded from chart-hit history');
  await calibrationField('#calibration-setting','14');await click('#calibration-start');assert.equal(host.snapshot().telemetry.calibration.trial.source,'gameplay');
  send('calibration',{stage:'audio',offsetMs:100,calibrationAttemptId:'ignored-by-gameplay'});
  for(let i=0;i<29;i++)send('hit',{offsetMs:-8});await until(()=>host.snapshot().telemetry.calibration.trial?.sampleCount===29,'gameplay hits only');
  assert.equal(await evaluate("document.querySelector('#calibration-finish').disabled"),true);
  await until(()=>evaluate("document.querySelector('.performance-calibration-live').textContent.includes('-8.0 ms (early)')&&document.querySelector('.performance-calibration-live').textContent.includes('deviation')"),'signed actual live analysis');
  send('hit',{offsetMs:-8});await until(()=>evaluate("!document.querySelector('#calibration-finish').disabled"),'30 gameplay hits');
  await calibrationField('#calibration-stage','video');assert.equal(await evaluate("document.querySelector('#calibration-finish').disabled"),true,'cannot finish audio from video context');
  await calibrationField('#calibration-stage','audio');await click('#calibration-finish');
  await calibrationField('#calibration-setting','10');await click('#calibration-start');for(let i=0;i<30;i++)send('hit',{offsetMs:-2});
  await until(()=>evaluate("!document.querySelector('#calibration-finish').disabled"),'second gameplay trial');await click('#calibration-finish');
  await until(()=>evaluate("document.querySelector('.performance-trials').children.length===2"),'two audio gameplay histories');
  assert.equal(await evaluate("document.querySelector('#calibration-comparable').checked"),false);
  assert.doesNotMatch(await evaluate("document.querySelector('.performance-calibration-comparison').textContent"),/Change in mean absolute/);
  await click('#calibration-comparable');assert.match(await evaluate("document.querySelector('.performance-calibration-comparison').textContent"),/Before.*14\.0 ms.*-8\.0 ms[\s\S]*After.*10\.0 ms.*-2\.0 ms[\s\S]*Change in mean absolute offset : -6\.0 ms/);
  const read=await evaluate("(()=>{const n=document.querySelector('[data-calibration-step=\"4\"]');n.scrollIntoView({block:'start',behavior:'instant'});return n.textContent})()");assert.match(read,/do not calculate a new audio or video setting/);await delay(100);
  await fs.writeFile(path.join(directory,'calibration-in-game-comparison-en.png'),(await panel.webContents.capturePage()).toPNG());captures.push('calibration-in-game-comparison-en.png');
  await calibrationField('#calibration-setting','9');await click('#calibration-start');for(let i=0;i<30;i++)send('hit',{offsetMs:-1});
  await until(()=>evaluate("!document.querySelector('#calibration-finish').disabled"),'third gameplay trial');await click('#calibration-finish');
  await until(()=>evaluate("document.querySelector('.performance-trials').children.length===3&&!document.querySelector('#calibration-comparable').checked"),'new before/after pair requires fresh matching-condition confirmation');
  await calibrationField('#calibration-stage','video');assert.equal(await evaluate("document.querySelector('#calibration-setting').value"),'13');assert.equal(await evaluate("document.querySelector('.performance-trials').children.length"),0);assert.equal(await evaluate("document.querySelector('#calibration-comparable').checked"),false);
  await calibrationField('#calibration-stage','audio');await calibrationField('#calibration-method','manual');assert.equal(await evaluate("document.querySelector('.performance-trials').children.length"),2,'both native audio histories retained independently');
  assert.doesNotMatch(await evaluate("document.querySelector('.performance-trials').textContent"),/Entered setting (10|14)\.0 ms/,'chart-hit settings absent from native history');
  await calibrationField('#calibration-method','native');
 });
 await check('The real Start trial button arms Audio and Video before chart start, waits without fake samples, then retains thirty hits independently',async()=>{
  host.setLanguage('fr');panel.setSize(1280,900);
  await calibrationField('#calibration-method','gameplay');await calibrationField('#calibration-stage','audio');await calibrationField('#calibration-setting','13');
  send('state',{phase:'menu'});await until(()=>host.snapshot().telemetry.phase==='menu','synthetic menu before arm');
  await click('#calibration-start');await until(()=>evaluate("document.querySelector('.performance-calibration-trial').textContent.includes('En attente du début de la chart')"),'French waiting-for-chart state');
  assert.equal(host.snapshot().telemetry.calibration.trial.sampleCount,0);assert.equal(host.snapshot().telemetry.calibration.trial.incomplete,false);
  async function trialCapture(name){await revealWorkspace(panel,'.performance-calibration-trial');await evaluate("new Promise(resolve=>{document.querySelector('[data-calibration-step=\"3\"]').scrollIntoView({block:'start',behavior:'instant'});requestAnimationFrame(()=>requestAnimationFrame(resolve));})");await fs.writeFile(path.join(directory,name),(await panel.webContents.capturePage()).toPNG());captures.push(name);}
  await trialCapture('calibration-armed-before-chart-fr.png');
  attemptId='armed-audio-chart';send('reset',{reason:'song'});send('state',{phase:'loading'});send('state',{phase:'playing',metadata:{chartId:'b'.repeat(64),instrument:'Guitar',difficulty:'Expert'},clock:{positionSeconds:-2,durationSeconds:240,speed:1}});
  send('state',{phase:'playing',clock:{positionSeconds:0,durationSeconds:240,speed:.75}});
  await until(()=>evaluate("document.querySelector('.performance-calibration-trial').textContent.includes('Jouez : les mesures commencent')"),'first-hit waiting state after chart start');
  assert.equal(host.snapshot().telemetry.calibration.trial.sampleCount,0);assert.equal(host.snapshot().telemetry.calibration.trial.incomplete,false);
  assert.equal(await evaluate("document.querySelector('#calibration-finish').disabled&&document.querySelector('.performance-calibration-live').hidden"),true);
  assert.doesNotMatch(await evaluate("document.querySelector('.performance-calibration-trial').textContent"),/Interruption/);
  await trialCapture('calibration-chart-started-waiting-hit-fr.png');
  for(let i=0;i<29;i++)send('hit',{offsetMs:-4});await until(()=>host.snapshot().telemetry.calibration.trial?.sampleCount===29,'29 audio chart hits');
  assert.equal(await evaluate("document.querySelector('#calibration-finish').disabled"),true);
  send('hit',{offsetMs:-4});await until(()=>evaluate("!document.querySelector('#calibration-finish').disabled"),'30 audio chart hits enable Finish');
  await trialCapture('calibration-30-hits-ready-fr.png');await click('#calibration-finish');
  const audioTrial=host.snapshot().telemetry.calibration.trials.find(t=>t.stage==='audio'&&t.source==='gameplay'&&t.settingMs===13);
  assert.equal(audioTrial.sampleCount,30);assert.equal(audioTrial.meanOffsetMs,-4);
  await calibrationField('#calibration-stage','video');await calibrationField('#calibration-setting','13');send('state',{phase:'menu'});await until(()=>host.snapshot().telemetry.phase==='menu','menu before video arm');await click('#calibration-start');
  attemptId='armed-video-chart';send('reset',{reason:'song'});send('hit',{offsetMs:3});
  await until(()=>host.snapshot().telemetry.calibration.trial?.sampleCount===1,'early video hit before throttled state');
  send('state',{phase:'playing',clock:{positionSeconds:1,durationSeconds:240,speed:.5}});
  for(let i=1;i<30;i++)send('hit',{offsetMs:3});await until(()=>evaluate("!document.querySelector('#calibration-finish').disabled"),'30 independent video hits');await click('#calibration-finish');
  const trials=host.snapshot().telemetry.calibration.trials;
  assert.equal(trials.find(t=>t.stage==='video'&&t.source==='gameplay'&&t.settingMs===13).meanOffsetMs,3);
  assert.deepEqual(trials.find(t=>t.stage==='audio'&&t.source==='gameplay'&&t.settingMs===13),audioTrial);
  assert.doesNotMatch(await evaluate("document.querySelector('.performance-trials').textContent"),/-4,0 ms/,'audio values stay out of video history');
  await calibrationField('#calibration-stage','audio');await calibrationField('#calibration-setting','14');await click('#calibration-start');send('hit',{offsetMs:-4});await until(()=>host.snapshot().telemetry.calibration.trial?.sampleCount===1,'first measured hit before speed change');
  send('state',{phase:'playing',clock:{positionSeconds:2,durationSeconds:240,speed:.75}});for(let i=0;i<30;i++)send('hit',{offsetMs:100});
  await until(()=>evaluate("document.querySelector('.performance-calibration-trial').textContent.includes('Interruption : recommencez')"),'real midtrial speed change still interrupts');
  assert.equal(host.snapshot().telemetry.calibration.trial.sampleCount,1);assert.equal(await evaluate("document.querySelector('#calibration-finish').disabled"),true);
 });
 await check('English text and native minimum window retain readable controls',async()=>{host.setLanguage('en');await until(()=>evaluate("document.querySelector('#performance-controls').textContent.includes('Gameplay measurements')"),'English controls');const minimum=panel.getMinimumSize();panel.setSize(Math.max(minimum[0],800),Math.max(minimum[1],750));await revealWorkspace(panel,'#performance-panel');await delay(100);assert.equal(await evaluate("document.documentElement.scrollWidth>innerWidth+1"),false);await capture('accuracy-fixture-min-en.png');});
 await check('Seven widgets render through the real Stream preview and OBS transport at720p and1080p with five synthetic results',async()=>{
  const metadata={chartId:'b'.repeat(64),title:'Signal de test',artist:'Groupe fictif',instrument:'Guitar',difficulty:'Expert'},endStats={score:10000,combo:40,notesHit:40,notesTotal:40,misses:0,overstrums:0};
  for(let i=0;i<5;i++){attemptId='history-'+i;send('reset',{reason:'song',state:{phase:'playing',metadata:{...metadata,title:i<3?'Signal fictif '+(i+1):'Signal fictif '+(i+1)+' — '+Array(12).fill('horizon lumineux').join(' ')}}});send('hit',{offsetMs:2});send('attemptEnd',{completed:true,state:{phase:'results',stats:{...endStats,score:10000+i*1000}}});}
  attemptId='visible-current';send('reset',{reason:'song',state:{phase:'playing',metadata,stats:{...endStats,score:0,combo:0,notesHit:0},clock:{positionSeconds:30,durationSeconds:240,speed:1}}});for(let i=0;i<40;i++)send('hit',{offsetMs:i%2?20:-20,stats:{...endStats,score:(i+1)*100,combo:i+1,notesHit:i+1}});
  await until(()=>host.snapshot().telemetry.history.length===5&&host.snapshot().telemetry.timing.sampleCount===40,'synthetic five-result history');panel.setSize(1280,1000);await click('#preview-stream-tab');await until(()=>evaluate("document.querySelectorAll('#stream-preview .companion-widget').length===7"),'seven real preview widget DOM nodes');
  const preview=await evaluate("[...document.querySelectorAll('#stream-preview .companion-widget')].map(n=>({type:n.dataset.widgetType,text:n.textContent}))");assert.equal(new Set(preview.map(x=>x.type)).size,7);await fs.writeFile(path.join(directory,'stream-preview-widgets.json'),JSON.stringify(preview,null,2)+'\n');
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));await command('stream.settings',{revision:host.snapshot().editor.revision,settings:{...host.snapshot().state.stream,port}});await command('stream.enabled',{enabled:true});
  const obs=new BrowserWindow({show:false,width:1280,height:720,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});obsWindows.push(obs);obs.webContents.on('console-message',(_event,details)=>{if(details.level==='error')consoleErrors.push('OBS: '+details.message);});obs.webContents.on('render-process-gone',(_event,details)=>{if(!finishing)runtimeErrors.push('OBS: '+details.reason);});await obs.loadURL(host.snapshot().stream.url);
  const read=()=>obs.webContents.executeJavaScript(`(()=>{const canvas=document.querySelector('.stream-overlay-canvas'),cr=canvas.getBoundingClientRect();return{viewport:{width:innerWidth,height:innerHeight},canvas:cr.toJSON(),widgets:[...canvas.querySelectorAll('.companion-widget')].map(w=>{const t=w.querySelector('.companion-widget-text'),r=w.getBoundingClientRect(),tr=t.getBoundingClientRect(),raw=t.firstChild,lines=t.textContent.split('\\n');let at=0;return{type:w.dataset.widgetType,rect:r.toJSON(),textRect:tr.toJSON(),style:{whiteSpace:getComputedStyle(t).whiteSpace,fontSize:getComputedStyle(t).fontSize,lineHeight:getComputedStyle(t).lineHeight},lines:lines.map(line=>{const range=document.createRange();range.setStart(raw,at);range.setEnd(raw,at+line.length);const rects=[...range.getClientRects()].map(x=>x.toJSON());at+=line.length+1;const first=line.indexOf(" · "),second=first<0?-1:line.indexOf(" · ",first+3),prefixEnd=second>=0?second:first>=0?first:line.length,prefix=document.createRange();prefix.setStart(raw,at-line.length-1);prefix.setEnd(raw,at-line.length-1+prefixEnd);const prefixRects=[...prefix.getClientRects()].map(x=>x.toJSON());return{text:line,rects,visible:rects.every(x=>x.top>=tr.top-1&&x.bottom<=tr.bottom+1),prefixRects,prefixVisible:prefixRects.every(x=>x.left>=tr.left-1&&x.right<=tr.right+1&&x.top>=tr.top-1&&x.bottom<=tr.bottom+1)}})}})}})()`);
  for(const [width,height,language]of [[1280,720,'fr'],[1920,1080,'en']]){host.setLanguage(language);await command('stream.settings',{revision:host.snapshot().editor.revision,settings:{...host.snapshot().state.stream,canvas:{width,height,fps:60}}});obs.setContentSize(width,height);await until(async()=>await obs.webContents.executeJavaScript("document.querySelectorAll('.companion-widget').length===7"),'seven real OBS widget DOM nodes');await delay(300);const evidence=await read();obsEvidence.push(evidence);const name='obs-seven-widgets-'+width+'x'+height+'-synthetic.png';await fs.writeFile(path.join(directory,name),(await obs.webContents.capturePage()).toPNG());captures.push(name);await fs.writeFile(path.join(directory,name+'.json'),JSON.stringify(evidence,null,2)+'\n');assert.equal(evidence.widgets.length,7);for(const widget of evidence.widgets){assert.ok(widget.rect.left>=evidence.canvas.left-1&&widget.rect.right<=evidence.canvas.right+1&&widget.rect.top>=evidence.canvas.top-1&&widget.rect.bottom<=evidence.canvas.bottom+1,widget.type+' stays in logical canvas');assert.ok(widget.textRect.left>=evidence.canvas.left-1&&widget.textRect.right<=evidence.canvas.right+1&&widget.textRect.top>=evidence.canvas.top-1&&widget.textRect.bottom<=evidence.canvas.bottom+1,widget.type+' text clip remains in canvas');if(['gameplay.accuracy','session.history'].includes(widget.type)){assert.equal(widget.lines.length,6);assert.ok(widget.lines.every(line=>line.visible),widget.type+' all six lines visible');if(widget.type==='session.history')assert.ok(widget.lines.every(line=>line.prefixVisible), 'history ranks, scores and status remain visible');}}}
 });
 await check('Native Accuracy checkboxes and existing font controls produce two chosen lines in Game and actual OBS',async()=>{
  const current=()=>host.snapshot().state.widgets.instances.find(w=>w.type==='gameplay.accuracy');assert.equal(current().style.fontSize,16);
  await click('.performance-actions button:nth-child(3)');assert.equal(await evaluate("document.activeElement.id"),'widget-font-size-gameplay-accuracy');
  for(const field of ['meanAbsoluteOffsetMs','standardDeviationMs','withinWindowPercent','sampleCount','showTitle','showCoverage'])await click('[data-widget-accuracy-fields="gameplay-accuracy"] [data-accuracy-field="'+field+'"]');
  await until(()=>current().config.fields?.length===2&&!current().config.showTitle&&!current().config.showCoverage,'two selected metrics');
  await click('[data-widget-font-decrease="gameplay-accuracy"]');await until(()=>current().style.fontSize===14,'native shared font control');
  await command('widget.visibility',{revision:host.snapshot().editor.revision,id:current().id,game:true,stream:true,gameplayVisibility:['playing','paused']});
  const obs=obsWindows[0],readAccuracy=()=>obs.webContents.executeJavaScript("(()=>{const w=document.querySelector('[data-widget-type=\"gameplay.accuracy\"]'),t=w?.querySelector('.companion-widget-text');return t?{lines:t.textContent.split('\\n'),fontSize:getComputedStyle(t).fontSize}:null})()");
  await until(async()=>{const value=await readAccuracy();return value?.lines.length===2&&value.fontSize==='14px';},'compact actual OBS transport');
  const observed=await readAccuracy();assert.match(observed.lines[0],/^Last:/);assert.match(observed.lines[1],/^Mean:/);assert.ok(observed.lines.every(line=>!line.includes('Deviation')&&!line.includes('judgments')));
  await click('#preview-game-tab');await until(()=>evaluate("(()=>{const w=document.querySelector('#game-preview [data-widget-type=\"gameplay.accuracy\"]');return w?.textContent.split('\\n').length===2&&getComputedStyle(w).fontSize==='14px'})()"),'same compact Game output');
  await obs.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await delay(300);assert.equal((await readAccuracy()).lines.length,2);
  const name='obs-accuracy-two-lines-1920x1080-synthetic.png';await fs.writeFile(path.join(directory,name),(await obs.webContents.capturePage()).toPNG());captures.push(name);obsEvidence.push({kind:'accuracyChoices',...observed});
  await click('.performance-actions button:nth-child(3)');await delay(100);const controlsName='accuracy-display-controls-en.png';await fs.writeFile(path.join(directory,controlsName),(await panel.webContents.capturePage()).toPNG());captures.push(controlsName);
 });
 await check('Accuracy display choices survive one-action undo, profiles, saved settings and renderer reload without touching legacy styles',async()=>{
  const widget=()=>host.snapshot().state.widgets.instances.find(w=>w.type==='gameplay.accuracy'),config=structuredClone(widget().config),legacy=structuredClone(host.snapshot().state.widgets.instances.filter(w=>w.type.startsWith('song.'))),revision=()=>host.snapshot().editor.revision;
  const saved=await command('profile.save',{revision:revision(),profilesRevision:host.snapshot().profiles.revision,name:'Compact Accuracy fixture'});
  await command('widget.accuracy',{revision:revision(),id:widget().id,config:{fields:['sampleCount'],showTitle:false,showCoverage:false}});
  await until(()=>evaluate("document.querySelector('[data-accuracy-field=\"sampleCount\"]').disabled"),'last selected metric protected');await delay(1100);assert.equal(await evaluate("document.querySelector('[data-accuracy-field=\"sampleCount\"]').disabled"),true,'background snapshots preserve the last selected field protection');
  await command('editor.undo',null);assert.deepEqual(widget().config,config);
  await command('widget.accuracy',{revision:revision(),id:widget().id,config:{}});await command('profile.apply',{revision:revision(),profilesRevision:host.snapshot().profiles.revision,id:saved.result.id});assert.deepEqual(widget().config,config);assert.equal(widget().style.fontSize,14);assert.deepEqual(host.snapshot().state.widgets.instances.filter(w=>w.type.startsWith('song.')),legacy);
  await host.saveSettings();const stored=JSON.parse(await fs.readFile(path.join(directory,'companion/settings.json'),'utf8'));assert.deepEqual(stored.widgets.find(w=>w.type==='gameplay.accuracy').config,config);assert.equal(stored.widgets.find(w=>w.type==='gameplay.accuracy').style.fontSize,14);
  await new Promise(resolve=>{panel.webContents.once('did-finish-load',resolve);panel.webContents.reload();});await until(()=>evaluate("document.querySelector('#widget-font-size-gameplay-accuracy')?.value==='14'&&document.querySelector('[data-accuracy-field=\"lastOffsetMs\"]')?.checked&&!document.querySelector('[data-accuracy-field=\"sampleCount\"]')?.checked"),'renderer reload restores actual persisted choices');
 });
 await check('Disconnect removes live measurements rather than freezing them as current',async()=>{
  await click('.performance-calibration summary');await calibrationField('#calibration-stage','video');await calibrationField('#calibration-method','gameplay');await calibrationField('#calibration-setting','13');await click('#calibration-start');
  for(let i=0;i<30;i++)send('hit',{offsetMs:1});await until(()=>evaluate("!document.querySelector('#calibration-finish').disabled&&!document.querySelector('.performance-calibration-live').hidden"),'running analysis ready before disconnect');
  clearInterval(timer);peer.destroy();await until(()=>!host.snapshot().telemetry.connected,'disconnected');assert.equal(host.snapshot().telemetry.timing.sampleCount,0);
  await until(()=>evaluate("document.querySelector('#calibration-finish').disabled&&document.querySelector('#calibration-start').disabled&&document.querySelector('.performance-calibration-live').hidden&&document.querySelector('.performance-calibration-live').textContent===''"),'interrupted analysis cannot finish or display frozen live statistics');
  assert.match(await evaluate("document.querySelector('.performance-calibration-trial').textContent"),/Interrupted: restart this trial/);
  await until(()=>evaluate("!document.querySelector('.performance-status').textContent.includes('Connected')"),'renderer disconnect');await until(()=>evaluate("[...document.querySelectorAll('.performance-calibration-result-value')].every(n=>n.textContent==='—')&&document.querySelector('#source-mode-label').textContent==='DEMO MODE'&&!document.querySelector('#source-mode-badge').classList.contains('is-live')"),'old native values hidden and legacy badge restored');
  for(const obs of obsWindows){await until(()=>obs.webContents.executeJavaScript("[...document.querySelectorAll('.companion-widget')].every(node=>!node.dataset.widgetType.startsWith('gameplay.'))"),'OBS removes all live Gameplay widgets');assert.equal(await obs.webContents.executeJavaScript("document.querySelectorAll('[data-widget-type=\"session.history\"]').length"),1,'valid measured history remains historical');}
 });
 assert.deepEqual(runtimeErrors,[]);assert.deepEqual(consoleErrors,[]);await finish();
}).catch(error=>finish(error).catch(e=>{console.error(e);app.exit(1);}));
