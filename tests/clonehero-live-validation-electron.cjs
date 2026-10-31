'use strict';
// User-assisted real connector validation. Temporary Companion profile only.
// No game launch, Song scan, login, network catalogue, raw judgments or IPC secret logging.
const {app}=require('electron'),fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const outputArg=process.argv.find(v=>v.startsWith('--live-output='));if(!outputArg)throw Error('Explicit live validation output required');
const resumeArg=process.argv.find(v=>v.startsWith('--resume-settings='));
const directory=path.join(path.resolve(outputArg.slice('--live-output='.length)),'live-'+randomUUID());
app.setPath('userData',path.join(directory,'electron-profile'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const {registerFixtureMaintenance,revealWorkspace}=require('./workspace-input.cjs');registerFixtureMaintenance();
const {registerCompanionScheme,createCompanionHost}=require('../companion/host.cjs');registerCompanionScheme();
let host,panel,timer,deadline,finished=false,maximumSampleCount=0,lastWritten='',lastSnapshot=null,writeBusy=false,diagnosticWriteErrors=0;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<200;i++){if(await fn())return;await delay(50);}throw Error('Not ready: '+label);}
function projection(){const snapshot=host.snapshot(),value=snapshot.telemetry;maximumSampleCount=Math.max(maximumSampleCount,value?.timing?.sampleCount||0);return{checkedAt:new Date().toISOString(),status:value?.status,connected:value?.connected,reason:value?.reason,gameVersion:value?.gameVersion,capabilities:value?.capabilities,phase:value?.phase,timing:value?.timing,combo:value?.active?.stats?.combo,clock:value?.active?.clock,maximumSampleCount,overlayEnabled:snapshot.overlayEnabled,enabledGameWidgets:snapshot.state.widgets.instances.filter(w=>w.enabled&&w.visibility.game).map(w=>w.type),source:'Actual local connector; no synthetic game frames',temporaryProfile:true,gameLaunchedByThisTool:false,rawJudgmentsRecorded:false,descriptorOrSecretRecorded:false};}
async function write(){if(finished||!host||writeBusy)return;const status=projection();lastSnapshot=status;const stable=JSON.stringify({...status,checkedAt:null});if(stable===lastWritten)return;writeBusy=true;const temporary=path.join(directory,'status-'+randomUUID()+'.tmp');try{await fs.writeFile(temporary,JSON.stringify({...status,diagnosticWriteErrors},null,2)+'\n',{flag:'wx'});await fs.rename(temporary,path.join(directory,'status.json'));lastWritten=stable;console.log(JSON.stringify({status:status.status,connected:status.connected,samples:status.timing?.sampleCount,maximumSampleCount}));}catch{diagnosticWriteErrors++;if(diagnosticWriteErrors===1)console.error('Diagnostic snapshot unavailable; live widgets remain active.');}finally{writeBusy=false;await fs.unlink(temporary).catch(()=>{});}}
async function finish(reason,error){if(finished)return;finished=true;clearInterval(timer);clearTimeout(deadline);if(host)await host.dispose();await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'finished.json'),JSON.stringify({reason,error:error?String(error.message||error):null,lastSnapshot,maximumSampleCount,gameLaunched:false,temporaryProfile:true},null,2)+'\n');app.exit(error?1:0);}
app.whenReady().then(async()=>{
 await fs.mkdir(directory,{recursive:true});
 if(resumeArg){
  const source=path.resolve(resumeArg.slice('--resume-settings='.length)),allowed=path.resolve(outputArg.slice('--live-output='.length));
  if(!source.startsWith(allowed+path.sep)||path.basename(source)!=='settings.json')throw Error('Only the prior temporary validation layout can be resumed');
  const info=await fs.lstat(source);if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw Error('Invalid temporary layout');
  const saved=JSON.parse(await fs.readFile(source,'utf8'));if(!Array.isArray(saved.widgets))throw Error('Missing temporary widget layout');
  for(const widget of saved.widgets)if(widget.type==='gameplay.accuracy')widget.style={...widget.style,fontSize:16};
  await fs.mkdir(path.join(directory,'companion'),{recursive:true});await fs.writeFile(path.join(directory,'companion/settings.json'),JSON.stringify(saved,null,2)+'\n',{flag:'wx'});
 }
 host=await createCompanionHost({gameplayMeasurements:true,dataDirectory:path.join(directory,'companion'),cloneHeroCandidates:[],cloneHeroProcessProbe:async()=>({running:false,sessions:[]}),isCatalogueAvailable:()=>false,authorizeCatalogue:async()=>false,catalogueClient:{async load(){return{items:[],revision:'live-validation-no-catalogue',demo:false};},async artwork(){return null;}}});
 host.setLanguage('fr');panel=await host.open();panel.setTitle('ChartsHub — Essai Accuracy');panel.setSize(1280,900);
 await until(()=>panel.webContents.executeJavaScript("!!window.ChartsHubCompanion&&!!document.querySelector('#performance-controls .performance-status')"),'Accuracy controls');
 const command=async(name,payload={})=>{const result=await panel.webContents.executeJavaScript(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`);if(result?.ok!==true)throw Error('Unable to enable validation widget: '+name);};
 await command('telemetry.widgets');
 for(const widget of host.snapshot().state.widgets.instances.filter(w=>['gameplay.accuracy','gameplay.combo','gameplay.progress'].includes(w.type)))await command('widget.visibility',{revision:host.snapshot().editor.revision,id:widget.id,game:true,stream:true,gameplayVisibility:['playing','paused']});
 await revealWorkspace(panel,'#preview-stream-tab');
 const point=await panel.webContents.executeJavaScript("(async()=>{const n=document.querySelector('#preview-stream-tab');n.scrollIntoView({block:'center',behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),p={x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)},h=document.elementFromPoint(p.x,p.y);if(!h||!(h===n||n.contains(h)))throw Error('Preview tab is covered');return p;})()");
 panel.webContents.focus();for(const type of ['mouseMove','mouseDown','mouseUp'])panel.webContents.sendInputEvent({type,...point,...(type==='mouseMove'?{}:{button:'left',clickCount:1})});
 await host.setOverlay(true);
 await panel.webContents.executeJavaScript("(()=>{const notice=document.createElement('p');notice.textContent='Fenêtre d’essai Accuracy. Aucun dossier Songs n’est chargé ici. Vous pouvez fermer cette fenêtre pour terminer l’essai.';notice.className='helper-text';document.querySelector('#performance-panel').prepend(notice);})()");
 panel.on('close',event=>{event.preventDefault();void finish('user-closed');});panel.show();panel.focus();
 await write();timer=setInterval(()=>{void write().catch(()=>{diagnosticWriteErrors++;});},1000);deadline=setTimeout(()=>{void finish('one-hour-limit');},60*60*1000);
 console.log(JSON.stringify({state:'LIVE_VALIDATION_WINDOW_READY',directory,pid:process.pid,gameLaunched:false,temporaryProfile:true}));
}).catch(error=>finish('startup-error',error).catch(()=>app.exit(1)));
