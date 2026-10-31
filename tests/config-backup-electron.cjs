'use strict';
// Actual app export, native-file selection, preview, authorized close/apply and
// relaunch request. Every file/account/network response is a disposable fixture.
require('./setup.cjs');
const electron=require('electron'),{app,session}=electron,fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),Module=require('node:module');
if(process.env.NODE_PATH)Module._initPaths();
const root=path.resolve(__dirname,'..'),directory=path.resolve(process.argv[2]||'');
if(!process.argv[2]||directory===root||!path.basename(directory).startsWith('config-backup-'))throw Error('Provide a disposable config-backup-* output directory');
fs.mkdirSync(directory,{recursive:true});app.setPath('userData',path.join(directory,'profile'));app.disableHardwareAcceleration();
if(process.env.CHARTSHUB_TEST_NO_SANDBOX==='1')app.commandLine.appendSwitch('no-sandbox');
const data=path.join(app.getPath('userData'),'companion'),settings=path.join(data,'settings.json');
let desktop,host,backupFile=path.join(directory,'factory.json'),relaunches=0,quitRequested=false,failing=false;
const passed=[],errors=[],delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.relaunch=()=>{relaunches++;};app.quit=()=>{quitRequested=true;};
async function waitFor(check,label){const until=Date.now()+20000;while(Date.now()<until){if(await check()){passed.push(label);return;}await delay(30);}throw Error('Timed out: '+label);}
async function fail(error){if(failing)return;failing=true;console.error(error.stack||error);fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({error:String(error.stack||error),passed,errors,relaunches,quitRequested},null,2));try{await host?.dispose();await desktop?.dispose();}catch{}app.exit(1);}
process.on('unhandledRejection',fail);process.on('uncaughtException',fail);setTimeout(()=>fail(Error('Native configuration backup fixture timed out')),120000).unref();
const originalLoad=Module._load;
Module._load=function(name,parent){
 const result=originalLoad.apply(this,arguments);if(!parent?.filename.startsWith(root))return result;
 if(name==='electron')return {...result,BrowserWindow:function(options){const win=new result.BrowserWindow({...options,show:false});win.show=win.showInactive=win.focus=()=>{};return win;}};
 if(name==='./desktop/controller.cjs')return {...result,createDesktopShell(options){desktop=result.createDesktopShell(options);return desktop;}};
 if(name==='./companion/clonehero-process.cjs')return {...result,createCloneHeroProcessProbe:()=>async()=>({running:false,sessions:[]})};
 if(name==='./companion/host.cjs')return {...result,async createCompanionHost(options){host=await result.createCompanionHost({...options,cloneHeroCandidates:[],cloneHeroProcessProbe:async()=>({running:false,sessions:[]}),catalogueClient:{load:async()=>({items:[],demo:false,revision:'backup-fixture'}),artwork:async()=>null}});return host;}};
 return result;
};
const page='<!doctype html><html lang="fr" data-theme="dark"><head><meta charset="utf-8"><style>:root{--blue:#4ebcff}</style></head><body><div class="theme-topbar"></div><p>Configuration backup fixture</p></body></html>';
app.whenReady().then(()=>session.fromPartition('persist:chartshub').protocol.handle('https',request=>new URL(request.url).pathname==='/api/auth/me'?Response.json({user:{id:'disposable-backup-member',emailVerified:false,staffRole:null}}):new Response(page,{headers:{'Content-Type':'text/html; charset=utf-8'}})));
electron.dialog.showErrorBox=(title,message)=>errors.push({title,message});
electron.dialog.showSaveDialog=async()=>({canceled:false,filePath:backupFile});
electron.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[backupFile]});
electron.dialog.showMessageBox=async(_owner,options)=>{assert.ok(options.message.includes('Restaurer')||options.message.includes('Restore'));return {response:0};};
require('../main.js');
app.whenReady().then(async()=>{
 await waitFor(()=>desktop,'desktop constructed');await desktop.ready;const frame=desktop.window.webContents;
 await waitFor(async()=>(await frame.executeJavaScript('window.chartsHubShell.getState()')).companionAvailable,'normal fixture account authorized');
 await frame.executeJavaScript('window.chartsHubShell.selectTab("companion")');await waitFor(()=>host?.getPanelContents()&&!host.getPanelContents().isLoading(),'canonical Companion ready');
 const local=host.getPanelContents(),maintenance=(action,payload)=>local.executeJavaScript(`window.ChartsHubMaintenance.invoke(${JSON.stringify(action)}${payload===undefined?'':','+JSON.stringify(payload)})`);
 const command=async(name,payload)=>{const result=await local.executeJavaScript(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify({...payload,revision:host.snapshot().editor.revision})})`);assert.equal(result.ok,true,JSON.stringify(result));};
 assert.equal(host.snapshot().state.widgets.instances.length,13);assert.equal((await maintenance('backup.export')).ok,true);
 const factory=JSON.parse(fs.readFileSync(backupFile,'utf8'));assert.equal(factory.groups.overlay.widgets.length,13);assert.equal(factory.sourceVersion,require('../package.json').version);passed.push('actual thirteen-widget factory exports through native selection');
 await command('widget.accuracy',{id:'gameplay-accuracy',config:{fields:['lastOffsetMs','meanOffsetMs'],showTitle:false,showCoverage:false}});
 await command('widget.lyrics',{id:'song-lyrics',config:{showNextLine:true}});
 await command('widget.layout',{destination:'game',items:[{id:'gameplay-accuracy',x:385,y:522,width:450,height:110}]});
 await command('widget.layout',{destination:'stream',items:[{id:'gameplay-accuracy',x:31,y:43,width:300,height:140}]});
 fs.writeFileSync(path.join(data,'accounts.json'),'PRIVATE_ACCOUNT_FIXTURE');
 backupFile=path.join(directory,'thirteen-with-public-config.json');assert.equal((await maintenance('backup.export')).ok,true);
 const exported=JSON.parse(fs.readFileSync(backupFile,'utf8'));assert.equal(JSON.stringify(exported).includes('PRIVATE_ACCOUNT_FIXTURE'),false);assert.equal(exported.groups.overlay.widgets.length,13);
 const expectedAccuracy=exported.groups.overlay.widgets.find(w=>w.id==='gameplay-accuracy'),expectedLyrics=exported.groups.overlay.widgets.find(w=>w.id==='song-lyrics');
 assert.deepEqual(expectedAccuracy.config,{fields:['lastOffsetMs','meanOffsetMs'],showTitle:false,showCoverage:false});assert.deepEqual(expectedLyrics.config,{showNextLine:true});passed.push('native export preserves public Accuracy/lyrics options and separate layouts');
 await command('widget.accuracy',{id:'gameplay-accuracy',config:{}});await command('widget.lyrics',{id:'song-lyrics',config:{showNextLine:false}});
 await command('widget.layout',{destination:'game',items:[{id:'gameplay-accuracy',x:10,y:20,width:400,height:184}]});
 const preview=await maintenance('backup.preview');assert.equal(preview.ok,true,JSON.stringify(preview));assert.equal(preview.preview.groups.find(g=>g.key==='overlay').count,13);
 assert.equal(JSON.stringify(preview).includes(directory),false);passed.push('native-selected preview exposes only the bounded category summary');
 const apply=maintenance('backup.apply',{id:preview.preview.id}).catch(error=>({rendererClosed:String(error.message)}));
 await waitFor(()=>relaunches===1,'authorized close completes restoration and requests relaunch');await apply;
 assert.deepEqual(errors,[]);const restored=JSON.parse(fs.readFileSync(settings,'utf8'));
 assert.equal(restored.widgets.length,13);assert.deepEqual(restored.widgets.find(w=>w.id==='gameplay-accuracy'),expectedAccuracy);assert.deepEqual(restored.widgets.find(w=>w.id==='song-lyrics'),expectedLyrics);
 assert.deepEqual(restored.stream.layout,exported.groups.overlay.stream.layout);assert.equal(fs.readFileSync(path.join(data,'accounts.json'),'utf8'),'PRIVATE_ACCOUNT_FIXTURE');
 assert.equal(fs.existsSync(path.join(data,'.configuration-import.lock')),false);assert.equal(fs.readdirSync(path.join(data,'.configuration-pending')).length,0);passed.push('actual shutdown/apply restores all widgets and keeps private files unchanged');
 const {validateSettings}=await import('../companion/dist/storage/SettingsRepository.js'),{ensureGameplayDocument}=await import('../companion/dist/widgets/core/index.js');
 assert.deepEqual(ensureGameplayDocument(validateSettings(restored)),restored);passed.push('restored thirteen-widget document is ready for the next native startup');
 const report={result:'CONFIG_BACKUP_NATIVE_OK',passed,relaunches,quitRequested,isolatedProfile:app.getPath('userData')};fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));app.exit(0);
}).catch(fail);
