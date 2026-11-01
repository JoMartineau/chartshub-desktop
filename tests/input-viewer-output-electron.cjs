'use strict';
// Real editor/preloads/output renderer with synthetic Windows/browser controls.
// Every window and profile belongs to this disposable fixture; no hardware read.
const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const output=process.argv.find(value=>value.startsWith('--fixture-output='));
if(!output)throw Error('Explicit disposable output required');
const directory=path.join(path.resolve(output.slice(17)),'output-'+randomUUID());
app.setPath('userData',path.join(directory,'profile'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const archiveArg=process.argv.find(value=>value.startsWith('--fixture-asar=')),archive=archiveArg?path.resolve(archiveArg.slice(15)):null;
const root=archive?path.join(archive,'companion'):path.resolve(__dirname,'../companion');
require(path.join(root,'host.cjs')).registerCompanionScheme();
const {createInputViewer,OUTPUT_PAGE}=require(path.join(root,'input-viewer.cjs'));
const {createLocalOverlayServer}=require(path.join(root,'stream-server.cjs'));
const checks=[],errors=[],externalRequests=[],sources=[];
let service,editor,game,rogue,obs,server,ownedLoopbackOrigin=null,localObsRequestCount=0,actualLocalObsServerAndBrowser=false,finished=false;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const evaluate=source=>editor.webContents.executeJavaScript(source);
async function until(action,name){const end=Date.now()+10000;while(Date.now()<end){if(await action())return;await delay(15);}throw Error('Timed out: '+name);}
async function check(name,action){await action();checks.push(name);console.log('PASS '+name);}
const change=(id,value)=>evaluate(`(()=>{const n=document.getElementById(${JSON.stringify(id)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const stored=()=>evaluate("JSON.parse(localStorage.getItem('chartshub:input-viewer-config-v2'))");
const native=()=>sources[sources.length-1];
function factory(callbacks){const value={callbacks,running:false,selected:null,selection:0,starts:0,stops:0,
 start(){this.running=true;this.starts++;queueMicrotask(()=>{if(this.running)callbacks.onDevices([{index:0,id:'xinput:0',name:'Synthetic guitar',type:1,subtype:7,mapping:'standard',buttonCount:17,axisCount:4}]);});return true;},
 select(index){this.selected=index;this.selection++;callbacks.onSample(null);return true;},getSelection(){return this.selection;},stop(){this.running=false;this.selected=null;this.stops++;callbacks.onSample(null);callbacks.onDevices([]);},dispose(){this.stop();}};sources.push(value);return value;}
function sample(down,selection=native().selection){return{index:0,id:'xinput:0',connected:true,selection,mapping:'standard',timestamp:1,buttons:Array.from({length:17},(_,i)=>({pressed:i===0&&down,value:i===0&&down?1:0})),axes:[0,0,0,0]};}
app.on('session-created',value=>value.webRequest.onBeforeRequest((details,callback)=>{const external=/^(https?|wss?):/i.test(details.url);let owned=false;try{owned=external&&ownedLoopbackOrigin!==null&&new URL(details.url).origin===ownedLoopbackOrigin;}catch{}if(owned)localObsRequestCount++;else if(external)externalRequests.push(details.url);callback({cancel:external&&!owned});}));
class PassiveWindow extends BrowserWindow{
 constructor(options){super(options);this.fixtureOptions=options;this.fixtureMouse=[];this.webContents.on('console-message',(_event,value)=>{if(value.level==='error')errors.push(value.message);});}
 show(){this.showInactive();}focus(){}setIgnoreMouseEvents(value,options){this.fixtureMouse.push({value,options});return super.setIgnoreMouseEvents(value,options);}
}
const electron={...require('electron'),BrowserWindow:PassiveWindow};
const deadline=setTimeout(()=>void finish(Error('Output fixture timed out')),90000);
async function finish(error){if(finished)return;finished=true;clearTimeout(deadline);if(error)console.error(error.stack||error);try{rogue?.destroy();obs?.destroy();await server?.stop();await service?.dispose();assert.equal(BrowserWindow.getAllWindows().length,0);}catch(cleanup){error ||= cleanup;}await fs.mkdir(directory,{recursive:true});
 const report={result:error?'failed':'passed',checks,errors,externalRequests,error:error?String(error.stack||error):null,archive,loadedFromAsar:!!archive,productRoot:archive||path.dirname(root),actualDirectorAndPreloads:true,actualOutputRenderer:true,actualLocalObsServerAndBrowser,localObsRequestCount,defaultRendererSecurity:true,syntheticWindowsTransport:true,syntheticGamepads:true,realInputRead:false,realDevicesRead:false,realGameRead:false,realProfileRead:false,electron:process.versions.electron,chrome:process.versions.chrome};
 await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({directory,result:report.result,checks:checks.length}));app.exit(error?1:0);}
process.on('uncaughtException',error=>void finish(error));process.on('unhandledRejection',error=>void finish(error));
app.whenReady().then(async()=>{
 await fs.mkdir(directory,{recursive:true});service=await createInputViewer({root,electron,xinputFactory:factory});editor=await service.open();
 await until(()=>evaluate("document.getElementById('element').options.length===8"),'editor');
 await check('The opaque movable editor prominently explains mapping and focuses the visible mapping action',async()=>{
  assert.equal(editor.fixtureOptions.transparent,false);assert.equal(editor.fixtureOptions.frame,true);assert.equal(editor.isAlwaysOnTop(),false);assert.equal(editor.isResizable(),true);assert.equal(editor.isMovable(),true);
  assert.match(await evaluate("document.getElementById('mapping-guide').textContent"),/1.*Démarrer.*2.*Choisir.*3.*Associer/);
  assert.equal(await evaluate("document.getElementById('mapping-count').textContent"),'0/8 touches associées');
  await evaluate("document.getElementById('configure-mapping').click()");assert.equal(await evaluate('document.activeElement.id'),'learn');
  await change('kind','button');await change('index','0');await change('color','#d43ba5');
  assert.equal(await evaluate("document.getElementById('mapping-count').textContent"),'1/8 touches associées');
 });
 const saved=await stored();await delay(50);await service.dispose();
 service=await createInputViewer({root,electron,xinputFactory:factory});
 await check('Opening output first restores saved mappings and colors through a hidden editor without starting reads',async()=>{
  game=await service.showOutput({editing:true});editor=service.getWindow();assert(game);assert.equal(editor.isVisible(),false);assert.equal(service.status().phase,'stopped');assert.equal(native().starts,0);
  assert.deepEqual(await stored(),saved);const value=service.snapshotOutput();assert.equal(value.config.controls[0].color,'#d43ba5');assert.equal(value.config.controls[0].mapping,undefined);assert.equal(value.config.source,undefined);assert.equal(value.config.deadzone,undefined);
 });
 await check('The compact transparent output moves independently and exposes only a read-only owned-frame bridge',async()=>{
  assert.equal(game.fixtureOptions.transparent,true);assert.equal(game.fixtureOptions.frame,false);assert(game.getBounds().width<=500);assert.equal(game.isMovable(),true);assert.equal(game.isResizable(),true);
  const bounds=game.getBounds();game.setBounds({...bounds,x:bounds.x+25,y:bounds.y+20});assert.equal(game.getBounds().x,bounds.x+25);
  await until(()=>game.webContents.executeJavaScript("document.body.classList.contains('positioning')"),'position handle');
  assert.equal(await game.webContents.executeJavaScript("Object.isFrozen(window.ChartsHubInputViewerOutput)&&Object.keys(window.ChartsHubInputViewerOutput).sort().join(',')"),'language,snapshot');
  assert.equal(await game.webContents.executeJavaScript('typeof window.ChartsHubInputViewer'),'undefined');
  const preferences=game.webContents.getLastWebPreferences();assert.equal(preferences.contextIsolation,true);assert.equal(preferences.sandbox,true);assert.equal(preferences.nodeIntegration,false);
 });
 await service.open();await evaluate("Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[]});document.getElementById('start').click()");
 await until(()=>service.status().phase==='running','start');await until(()=>evaluate("Array.from(document.getElementById('device').options).some(option=>option.value==='windows:0')"),'Windows option');await change('device','windows:0');await until(()=>native().selected===0,'selection');await delay(20);
 await check('Native samples animate the actual separate output while the editor is hidden, without exposing mappings',async()=>{
  editor.hide();native().callbacks.onSample(sample(true));assert.equal(service.snapshotOutput().pressed.fret0,true);
  await until(()=>game.webContents.executeJavaScript("document.getElementById('output').dataset.active==='fret0'"),'game output native press');
  assert.equal(JSON.stringify(service.snapshotOutput()).includes('xinput'),false);assert.equal(service.snapshotOutput().config.controls[0].mapping,undefined);
  native().callbacks.onSample(sample(false));await until(()=>game.webContents.executeJavaScript("document.getElementById('output').dataset.active===''"),'native release');
 });
 await check('The actual token-protected localhost OBS page loads without a preload and animates the same native press and release',async()=>{
  server=createLocalOverlayServer({root,token:'c'.repeat(64),inputViewer:{snapshot:()=>service.snapshotOutput()}});await server.start(0);const url=server.status().inputViewerUrl;ownedLoopbackOrigin=new URL(url).origin;
  obs=new BrowserWindow({show:false,width:800,height:320,webPreferences:{session:session.fromPartition('fixture-input-output-obs-'+randomUUID()),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false}});
  obs.webContents.on('console-message',(_event,value)=>{if(value.level==='error')errors.push(value.message);});await obs.loadURL(url);obs.showInactive();
  await until(()=>obs.webContents.executeJavaScript("document.getElementById('output').dataset.active!==undefined"),'OBS module graph and state polling');
  assert.equal(await obs.webContents.executeJavaScript('typeof window.ChartsHubInputViewerOutput'),'undefined');assert.equal(await obs.webContents.executeJavaScript('typeof window.ChartsHubInputViewer'),'undefined');
  native().callbacks.onSample(sample(true));await until(()=>obs.webContents.executeJavaScript("document.getElementById('output').dataset.active==='fret0'"),'OBS actual native press');
  native().callbacks.onSample(sample(false));await until(()=>obs.webContents.executeJavaScript("document.getElementById('output').dataset.active===''"),'OBS actual native release');
  for(let i=0;i<3;i++){assert.equal(await obs.webContents.executeJavaScript("getComputedStyle(document.getElementById('position-handle')).display"),'none');await delay(40);}
  assert.equal(await obs.webContents.executeJavaScript("getComputedStyle(document.body).paddingTop"),'0px');
  assert(localObsRequestCount>=8,'Output document, full ESM graph and state requests must reach the owned local server');actualLocalObsServerAndBrowser=true;
  await fs.writeFile(path.join(directory,'obs-output.png'),(await obs.webContents.capturePage()).toPNG());obs.destroy();obs=null;await server.stop();server=null;
 });
 await check('Locking enables pointer pass-through and positioning restores drag mode without resetting bounds or topmost preference',async()=>{
  const bounds=game.getBounds(),canvasBounds=await game.webContents.executeJavaScript("(()=>{const r=document.getElementById('output').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};})()");await service.showOutput({editing:false,alwaysOnTop:false});assert.equal(game.isAlwaysOnTop(),false);assert.equal(game.fixtureMouse.at(-1).value,true);
  await until(()=>game.webContents.executeJavaScript("!document.body.classList.contains('positioning')"),'locked output');
  assert.deepEqual(await game.webContents.executeJavaScript("(()=>{const r=document.getElementById('output').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};})()"),canvasBounds,'Locking must not shift or rescale the positioned controls');
  await service.showOutput({editing:true});assert.equal(game.isAlwaysOnTop(),false);assert.equal(game.fixtureMouse.at(-1).value,false);assert.deepEqual(game.getBounds(),bounds);
  await service.showOutput({editing:true,alwaysOnTop:true});assert.equal(game.isAlwaysOnTop(),true);await until(()=>game.webContents.executeJavaScript("document.body.classList.contains('positioning')"),'editable output');
 });
 await check('An unowned output frame cannot read snapshots or modify the owned controller',async()=>{
  rogue=new BrowserWindow({show:false,webPreferences:{session:game.webContents.session,preload:path.join(root,'input-viewer-output-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});await rogue.loadURL(OUTPUT_PAGE);
  assert.deepEqual(await rogue.webContents.executeJavaScript('window.ChartsHubInputViewerOutput.snapshot()'),{ok:false});assert.equal(await rogue.webContents.executeJavaScript('typeof window.ChartsHubInputViewerOutput.command'),'undefined');rogue.destroy();rogue=null;
  native().callbacks.onSample(sample(true,native().selection+10));assert.equal(service.snapshotOutput().pressed.fret0,false);
 });
 await service.open();await evaluate("document.getElementById('stop').click()");await until(()=>service.status().phase==='stopped','stop native');
 await check('Browser control output accepts only the selected active lease and rejects stale or unknown pressed maps',async()=>{
  await evaluate("window.fixtureDown=false;Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[{index:0,id:'SYNTHETIC OUTPUT',connected:true,buttons:[{pressed:window.fixtureDown,value:window.fixtureDown?1:0}],axes:[]}]});document.getElementById('start').click()");
  await until(()=>evaluate("Array.from(document.getElementById('device').options).some(option=>option.value==='0')"),'browser controller');await change('device','0');await delay(30);
  const lease=await evaluate('window.ChartsHubInputViewer.selectController(null)');
  assert.equal((await evaluate(`window.ChartsHubInputViewer.publishPressed({run:${lease.run},selection:${lease.selection},pressed:{unknown:true}})`)).ok,false);
  // Re-select through the product UI so its publisher obtains the newest lease.
  await change('device','0');await evaluate('window.fixtureDown=true');await until(()=>service.snapshotOutput().pressed.fret0===true,'browser output');
  assert.equal((await evaluate(`window.ChartsHubInputViewer.publishPressed({run:${lease.run},selection:${lease.selection},pressed:{fret0:false}})`)).ok,false);
  await evaluate('window.fixtureDown=false');await until(()=>service.snapshotOutput().pressed.fret0===false,'browser release');
 });
 await check('Closing the editor stops reading, clears held output and hides the game surface without losing saved setup',async()=>{
  await evaluate('window.fixtureDown=true');await until(()=>service.snapshotOutput().pressed.fret0===true,'held before close');await evaluate("document.getElementById('close-editor').click()");
  await until(()=>editor.isDestroyed(),'editor closes');assert.equal(service.status().phase,'stopped');assert.equal(native().running,false);assert.equal(game.isVisible(),false);assert(Object.values(service.snapshotOutput().pressed).every(value=>value===false));
 });
 await service.dispose();service=await createInputViewer({root,electron,xinputFactory:factory,language:()=> 'en'});editor=await service.open();await until(()=>evaluate("document.getElementById('element').options.length===8"),'English editor');
 await check('English setup steps, mapping count and separate-output action remain understandable after restoring settings',async()=>{
  assert.match(await evaluate("document.getElementById('mapping-guide').textContent"),/Start.*Choose.*Map/);assert.equal(await evaluate("document.getElementById('mapping-count').textContent"),'1/8 controls mapped');assert.equal(await evaluate("document.getElementById('show-output').textContent"),'Show over game');assert.equal(await evaluate("document.getElementById('close-editor').textContent"),'Close');
  await evaluate("document.getElementById('configure-mapping').click()");assert.equal(await evaluate('document.activeElement.id'),'learn');await fs.writeFile(path.join(directory,'editor-en.png'),(await editor.webContents.capturePage()).toPNG());assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
 });
 await finish();
}).catch(error=>void finish(error));
