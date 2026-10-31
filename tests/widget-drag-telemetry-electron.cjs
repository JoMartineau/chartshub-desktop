'use strict';
// Real renderer, host, IPC and accepted telemetry pipe. All game data/profile paths are disposable.
const {app,BrowserWindow}=require('electron'),fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
if(process.env.NODE_PATH)require('node:module').Module._initPaths();
const {registerFixtureMaintenance,revealWorkspace}=require('./workspace-input.cjs'),disposeMaintenance=registerFixtureMaintenance();
const arg=process.argv.find(value=>value.startsWith('--fixture-output='));if(!arg)throw Error('Explicit disposable output required');
const output=path.resolve(arg.slice('--fixture-output='.length)),directory=path.join(output,'widget-drag-live-'+randomUUID());
app.setPath('userData',path.join(directory,'electron-profile'));process.env.LOCALAPPDATA=path.join(directory,'local-app-data');app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const {createCompanionHost,registerCompanionScheme}=require('../companion/host.cjs'),contract=require('../companion/clonehero-telemetry-contract.cjs'),{SUPPORTED_BUILDS}=require('../companion/clonehero-telemetry-source.cjs');registerCompanionScheme();
const provider={id:'chartshub.clonehero.il2cpp',version:'0.1.0'},game=SUPPORTED_BUILDS[0],sessionId='after-chart-fixture',capabilities=Object.fromEntries(contract.CAPABILITIES.map(key=>[key,true]));
const checks=[],errors=[],evidence=[],peers=[];let stressMetrics=null,freshMeasurements=null,stressTimer=null,stressSent=0;let host,panel,server,peer,timer,sequence=0,attemptId='attempt-one',finished=false;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),evaluate=source=>panel.webContents.executeJavaScript(source);
const id='gameplay-combo',revision=()=>host.snapshot().editor.revision;
const widget=()=>host.snapshot().state.widgets.instances.find(value=>value.id===id);
const geometry=destination=>destination==='game'?{x:widget().position.x,y:widget().position.y,width:widget().size.width,height:widget().size.height}:structuredClone(host.snapshot().state.stream.layout.find(value=>value.id===id));
async function until(check,label,timeout=10000){const until=Date.now()+timeout;while(Date.now()<until){if(await check())return;await delay(25);}throw Error('Timed out: '+label);}
function send(type,data={}){assert(peer&&!peer.destroyed);peer.write(JSON.stringify({schema:contract.SCHEMA,provider,game,sessionId,attemptId,playerId:0,sequence:sequence++,type,data})+'\n');}
async function command(name,payload={}){const result=await evaluate('window.ChartsHubCompanion.command('+JSON.stringify(name)+','+JSON.stringify(payload)+')');assert.equal(result.ok,true,JSON.stringify(result));return result;}
async function savedSettings(predicate,label){let stored;await until(async()=>{try{stored=JSON.parse(await fs.readFile(path.join(directory,'companion/settings.json'),'utf8'));return predicate(stored);}catch{return false;}},label);return stored;}
function mouse(type,point,modifiers=[]){panel.webContents.sendInputEvent({type,...point,modifiers,...(type==='mouseMove'?{}:{button:'left',clickCount:1})});}
async function click(selector){await revealWorkspace(panel,selector);const point=await evaluate(`(async()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled||n.closest('[inert]'))throw Error('Unavailable control '+${JSON.stringify(selector)});n.scrollIntoView({block:'center',behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),p={x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)},h=document.elementFromPoint(p.x,p.y);if(!(h===n||n.contains(h)))throw Error('Covered control '+${JSON.stringify(selector)});return p;})()`);panel.focus();panel.webContents.focus();mouse('mouseMove',point);mouse('mouseDown',point);mouse('mouseUp',point);await delay(70);}
async function builderReady(){await until(()=>evaluate("document.querySelector('#builder-canvas').getAttribute('aria-busy')!=='true'&&!document.querySelector('#widget-settings').inert"),'builder and settings interactive');}
async function move(destination,phase){
 await click('#preview-'+destination+'-tab');await click('#builder-list [data-select-widget-id="'+id+'"]');
 await revealWorkspace(panel,'.preview-card');await evaluate("new Promise(r=>{document.querySelector('.preview-card').scrollIntoView({block:'start',behavior:'instant'});requestAnimationFrame(()=>requestAnimationFrame(r));})");await delay(50);
 const rect=await evaluate("document.querySelector('#builder-canvas').getBoundingClientRect().toJSON()"),before=geometry(destination),other=geometry(destination==='game'?'stream':'game'),rev=revision(),scale=rect.width/1280;
 const start={x:Math.round(rect.left+(before.x+before.width/2)*scale),y:Math.round(rect.top+(before.y+before.height/2)*scale)},end={x:Math.round(start.x+40*scale),y:Math.round(start.y+24*scale)};
 const hit=await evaluate(`(()=>{const h=document.elementFromPoint(${start.x},${start.y});return{box:h?.closest('[data-builder-widget-id]')?.dataset.builderWidgetId,viewport:{width:innerWidth,height:innerHeight}}})()`);assert.equal(hit.box,id,'Actual drag starts on selected widget');assert(start.x>0&&start.y>0&&end.x<hit.viewport.width&&end.y<hit.viewport.height);
 panel.focus();panel.webContents.focus();mouse('mouseMove',start);mouse('mouseDown',start);for(let step=1;step<=100;step++){mouse('mouseMove',{x:Math.round(start.x+(end.x-start.x)*step/100),y:Math.round(start.y+(end.y-start.y)*step/100)},['leftButtonDown']);await delay(20);}mouse('mouseUp',end);
 await until(()=>revision()===rev+1,'one '+phase+' '+destination+' drag persisted');await builderReady();
 const after=geometry(destination);assert.equal(after.x-before.x,40);assert.equal(after.y-before.y,24);assert.deepEqual(geometry(destination==='game'?'stream':'game'),other,'Other destination remains independent');
 const stored=await savedSettings(settings=>{const entry=destination==='game'?settings.widgets.find(value=>value.id===id):settings.stream.layout.find(value=>value.id===id);return(destination==='game'?entry.position.x:entry.x)===after.x&&(destination==='game'?entry.position.y:entry.y)===after.y;},'updated '+phase+' '+destination+' layout reaches durable settings'),saved=destination==='game'?stored.widgets.find(value=>value.id===id):stored.stream.layout.find(value=>value.id===id);
 assert.equal(destination==='game'?saved.position.x:saved.x,after.x);assert.equal(destination==='game'?saved.position.y:saved.y,after.y);evidence.push({phase,destination,before,after,revisionBefore:rev,revisionAfter:revision()});
}
async function check(name,action){await action();checks.push(name);console.log('PASS '+name);}
async function controls(phase){
 await check('Widget visibility and text size remain editable during '+phase,async()=>{
  await builderReady();const originalPhases=structuredClone(widget().gameplayVisibility),previousStream=widget().visibility.stream;await click('#stream-widget-visibility input[data-stream-widget-id="'+id+'"]');await until(()=>widget().visibility.stream===!previousStream,'native OBS checkbox persisted');assert.deepEqual(widget().gameplayVisibility,originalPhases,'OBS toggle preserves existing menu/results visibility');
  await click('#stream-widget-visibility input[data-stream-widget-id="'+id+'"]');await until(()=>widget().visibility.stream===previousStream,'native OBS checkbox restored');
  const previous=widget().enabled;await click('#widget-settings input[data-widget-id="'+id+'"]');await until(()=>widget().enabled===!previous,'native checkbox persisted');
  await click('#widget-settings input[data-widget-id="'+id+'"]');await until(()=>widget().enabled===previous,'native checkbox restored');
  const before=widget().style.fontSize;await click('#widget-settings [data-widget-font-increase="'+id+'"]');await until(()=>widget().style.fontSize===before+2,'native font size persisted');await builderReady();
  const saved=await savedSettings(settings=>{const entry=settings.widgets.find(value=>value.id===id);return entry.enabled===previous&&entry.visibility.stream===previousStream&&entry.style.fontSize===before+2;},'updated '+phase+' controls reach durable settings'),stored=saved.widgets.find(value=>value.id===id);assert.equal(stored.enabled,previous);assert.equal(stored.visibility.stream,previousStream);assert.equal(stored.style.fontSize,before+2);assert.deepEqual(stored.gameplayVisibility,originalPhases);
 });
 if(!await evaluate("document.querySelector('#builder-toggle').getAttribute('aria-pressed')==='true'"))await click('#builder-toggle');
 for(const destination of ['game','stream'])await check('Native '+destination+' widget drag remains editable during '+phase,()=>move(destination,phase));
}
const deadline=setTimeout(()=>void finish(Error('End-of-chart widget fixture exceeded100seconds')),100000);
async function finish(error){if(finished)return;finished=true;clearTimeout(deadline);clearInterval(timer);clearInterval(stressTimer);if(error)console.error(error.stack||error);
 try{if(error&&panel&&!panel.isDestroyed())await fs.writeFile(path.join(directory,'failure.png'),(await panel.webContents.capturePage()).toPNG());for(const socket of peers)socket.destroy();if(server?.listening)await new Promise(resolve=>server.close(resolve));if(host)await host.dispose();assert.equal(BrowserWindow.getAllWindows().length,0);disposeMaintenance();}catch(failure){error=error||failure;}
 await fs.mkdir(directory,{recursive:true});const report={result:error?'failed':'passed',checks,evidence,errors,stressMetrics,stressSent,freshMeasurements,error:error?String(error.stack||error):null,syntheticTelemetry:true,actualHostAndIpc:true,actualWindowsNamedPipe:true,realGameRead:false,realUserProfileRead:false};await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({directory,result:report.result,checks:checks.length}));if(error)app.exit(1);else app.quit();}
process.on('uncaughtException',error=>void finish(error));process.on('unhandledRejection',error=>void finish(error));
app.whenReady().then(async()=>{
 await fs.mkdir(directory,{recursive:true});const connection=path.join(process.env.LOCALAPPDATA,'ChartsHub/Telemetry/v1');await fs.mkdir(connection,{recursive:true});
 const descriptor={schema:contract.DESCRIPTOR_SCHEMA,provider,game,sessionId,pipeName:'ChartsHub.CloneHero.Telemetry.'+randomUUID(),nonce:'a'.repeat(64),pid:process.pid};
 server=net.createServer(socket=>{peers.push(socket);let buffer='';socket.on('error',()=>{});socket.on('data',bytes=>{buffer+=bytes.toString();if(!buffer.includes('\n'))return;const handshake=JSON.parse(buffer.slice(0,buffer.indexOf('\n')));assert.equal(handshake.nonce,descriptor.nonce);peer=socket;send('hello',{capabilities,coverage:'from-attempt-start',state:{phase:'playing',metadata:{chartId:'a'.repeat(64),title:'Signal fictif',artist:'Groupe Exemple',instrument:'Guitar',difficulty:'Expert'},stats:{combo:0,score:0,misses:0,overstrums:0,notesHit:0,notesTotal:40},clock:{positionSeconds:0,durationSeconds:30,speed:1}}});});});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen('\\\\.\\pipe\\'+descriptor.pipeName,resolve);});await fs.writeFile(path.join(connection,'connection.json'),JSON.stringify(descriptor));
 host=await createCompanionHost({gameplayMeasurements:true,dataDirectory:path.join(directory,'companion'),cloneHeroCandidates:[],cloneHeroProcessProbe:async()=>({running:false,sessions:[]}),isCatalogueAvailable:()=>false,authorizeCatalogue:async()=>false,catalogueClient:{async load(){return{items:[],revision:'fixture',demo:false};},async artwork(){return null;}}});panel=await host.open();panel.setContentSize(1280,900);panel.webContents.on('console-message',(_event,details)=>{if(details.level==='error')errors.push(details.message);});panel.webContents.on('render-process-gone',(_event,details)=>{if(!finished)errors.push(details.reason);});
 await until(()=>host.snapshot().telemetry?.connected,'real fixture telemetry connection');timer=setInterval(()=>{if(peer&&!peer.destroyed)send('heartbeat');},1000);
 await until(()=>evaluate("!!document.querySelector('#widget-settings input[data-widget-id=\"gameplay-combo\"]')"),'real widget controls');await command('telemetry.widgets');
 const layout=host.snapshot().state.widgets.instances.map(value=>({id:value.id,...(value.id===id?{x:96,y:160,width:240,height:90}:{x:1000,y:560,width:160,height:48})}));for(const destination of ['game','stream'])await command('widget.layout',{revision:revision(),destination,items:layout});

 await evaluate(`(()=>{window.stressProbe={ticks:0,maxLag:0,mutations:0,rendererUpdates:0,start:performance.now()};let last=performance.now();setInterval(()=>{const now=performance.now();window.stressProbe.ticks++;window.stressProbe.maxLag=Math.max(window.stressProbe.maxLag,now-last-20);last=now;},20);new MutationObserver(records=>window.stressProbe.mutations+=records.length).observe(document.querySelector('#companion-app'),{subtree:true,childList:true,attributes:true,characterData:true});window.ChartshubCompanionLanguage&&Object.defineProperty(window.stressProbe,'language',{get:()=>window.ChartshubCompanionLanguage.get()});return true;})()`);
 stressTimer=setInterval(()=>{if(!peer||peer.destroyed)return;for(let n=0;n<10;n++){send('hit',{offsetMs:(stressSent%31)-15});stressSent++;}send('state',{phase:'playing',clock:{positionSeconds:stressSent/600,durationSeconds:3600,speed:1}});},16);
 try{for(const language of ['fr','en']){host.setLanguage(language);await controls(language+'-continuous-high-rate');}}
 finally{clearInterval(stressTimer);stressTimer=null;}
 await until(()=>host.snapshot().telemetry.timing.sampleCount===stressSent,'all high-rate hit frames accepted without loss');
 const latest=host.snapshot().telemetry,formattedCount=new Intl.NumberFormat('en').format(stressSent),seconds=Math.floor(stressSent/600),expectedClock=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} / 1:00:00`;
 assert.equal(latest.timing.lastOffsetMs,((stressSent-1)%31)-15);assert.equal(latest.active.clock.positionSeconds,stressSent/600);
 await until(()=>evaluate(`document.querySelector('#stream-preview [data-widget-type="gameplay.accuracy"]').textContent.includes(${JSON.stringify(formattedCount+' judgments')})&&document.querySelector('#stream-preview [data-widget-type="gameplay.progress"]').textContent.includes(${JSON.stringify(expectedClock)})`),'released preview shows latest accepted judgment count and clock');
 freshMeasurements={allHitsAccepted:true,acceptedSampleCount:latest.timing.sampleCount,positionSeconds:latest.active.clock.positionSeconds,expectedClock,preview:await evaluate("({accuracy:document.querySelector('#stream-preview [data-widget-type=\"gameplay.accuracy\"]').textContent,progress:document.querySelector('#stream-preview [data-widget-type=\"gameplay.progress\"]').textContent})")};
 stressMetrics=await evaluate('({...window.stressProbe,elapsed:performance.now()-window.stressProbe.start})');
 assert.equal(host.snapshot().telemetry.connected,true,'High-rate provider remains connected');
 assert(stressSent>=500,'The stress fixture produced a sustained high-rate sample stream');
 assert(stressMetrics.maxLag<500,'A held drag must not stall the renderer for half a second');
 assert(stressMetrics.ticks>=stressMetrics.elapsed/20*.6,'The renderer keeps servicing its input/event loop under sustained telemetry');
 assert(stressMetrics.mutations/stressMetrics.elapsed*1000<20000,'Live measurements do not rebuild unrelated panels on every tick');
 console.log(JSON.stringify({stressMetrics,stressSent}));
 await check('Paused chart keeps its measured widgets and editable OBS layout',async()=>{
  send('state',{phase:'paused'});await until(()=>host.snapshot().telemetry.phase==='paused','paused chart phase');
  await until(()=>evaluate("document.querySelectorAll('#stream-preview [data-widget-type^=\"gameplay.\"]').length===5"),'five paused widgets remain available');
  await move('stream','paused');
 });
 await check('Confirmed results retain their measured values and session history',async()=>{
  send('attemptEnd',{completed:true,state:{phase:'results',stats:{combo:40,score:4000,misses:0,overstrums:0,notesHit:40,notesTotal:40}}});
  await until(()=>host.snapshot().telemetry.phase==='results','confirmed result phase');
  await until(()=>evaluate("document.querySelectorAll('#stream-preview [data-widget-type^=\"gameplay.\"]').length===5"),'five result widgets remain available');
  assert(host.snapshot().telemetry.history.length>0);
 });
 for(const phase of ['idle','menu','loading'])await check('No live measurement widgets or demo data appear during '+phase,async()=>{
  const count=host.snapshot().telemetry.timing.sampleCount;send('state',{phase});await until(()=>host.snapshot().telemetry.phase===phase,'empty '+phase+' phase');
  await until(()=>evaluate("document.querySelectorAll('#stream-preview [data-widget-type^=\"gameplay.\"]').length===0"),'no stale live widgets during '+phase);
  assert.equal(host.snapshot().telemetry.timing.sampleCount,count,'last attempt is retained as history, never fabricated or incremented');
  const value=await evaluate("({rows:[...document.querySelectorAll('#builder-list [data-select-widget-id^=\"gameplay-\"]')].map(n=>n.textContent),history:!!document.querySelector('#stream-preview [data-widget-type=\"session.history\"]')})");
  assert.equal(value.rows.length,5);assert(value.rows.every(label=>/hidden/.test(label)));assert.equal(value.history,true);
  for(const language of ['fr','en']){
   host.setLanguage(language);const expected=language==='fr'?'Aucune chart en cours · dernières mesures conservées.':'No chart in progress · previous measurements retained.';
   await until(()=>evaluate('document.querySelector(".performance-metrics").nextElementSibling.textContent==='+JSON.stringify(expected)),'clear historical metrics label in '+language);
  }
  await fs.writeFile(path.join(directory,'no-chart-'+phase+'.png'),(await panel.webContents.capturePage()).toPNG());
 });
 await check('Provider disconnection cannot resurrect live measurement widgets',async()=>{
  await fs.unlink(path.join(connection,'connection.json'));for(const socket of peers)socket.destroy();
  await until(()=>!host.snapshot().telemetry.connected,'provider disconnected');
  await until(()=>evaluate("document.querySelectorAll('#stream-preview [data-widget-type^=\"gameplay.\"]').length===0"),'disconnected live widgets remain absent');
  assert(host.snapshot().telemetry.history.length>0,'completed attempts stay explicitly historical');
 });
 assert.deepEqual(errors,[]);await finish();
}).catch(error=>void finish(error));
