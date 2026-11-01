'use strict';
// Real renderer raster comparison with synthetic browser buttons only. A count
// of trail objects is insufficient: light must be visible outside the control.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const outputArg = process.argv.find(value => value.startsWith('--fixture-output='));
if (!outputArg) throw Error('Explicit disposable output required');
const directory = path.join(path.resolve(outputArg.slice('--fixture-output='.length)), 'afterglow-' + randomUUID());
app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const archiveArgument = process.argv.find(value => value.startsWith('--fixture-asar='));
const archive = archiveArgument ? path.resolve(archiveArgument.slice('--fixture-asar='.length)) : null;
if (archive) assert.equal(path.extname(archive).toLowerCase(), '.asar', 'Actual production ASAR required');
const root = archive ? path.join(archive, 'companion') : path.resolve(__dirname, '../companion');
const paintArg = process.argv.find(value => value.startsWith('--fixture-paint='));
const paintOverride = paintArg ? path.resolve(paintArg.slice('--fixture-paint='.length)) : null;
assert(!(archive && paintOverride), 'An archived production fixture may not override production paint');
require(path.join(root, 'host.cjs')).registerCompanionScheme();
const { createInputViewer } = require(path.join(root, 'input-viewer.cjs'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const errors = [], checks = [], externalRequests = [], evidence = {};
let service, window, finished = false, sourceStarts = 0, defaultRendererSecurity = false;
const sourceHashes = {};
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const evaluate = script => window.webContents.executeJavaScript(script);
const change = (id, value) => evaluate(`(() => {const node=document.getElementById(${JSON.stringify(id)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const checkbox = (id, value) => evaluate(`(() => {const node=document.getElementById(${JSON.stringify(id)});node.checked=${JSON.stringify(value)};node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
async function until(fn, description) { const end=Date.now()+10000; while(Date.now()<end){if(await fn())return;await delay(15);}throw Error('Timed out: '+description); }
function record(name, passed, details) { checks.push({ name, passed, details }); console.log((passed?'PASS ':'FAIL ')+name+' '+JSON.stringify(details)); }
async function snapshot(name) { return evaluate(`window.fixtureSnapshot(${JSON.stringify(name)})`); }
async function comparison(left, right) { return evaluate(`window.fixtureCompare(${JSON.stringify(left)},${JSON.stringify(right)})`); }
async function image(name) { const data=await evaluate("document.getElementById('viewer').toDataURL('image/png')");await fs.writeFile(path.join(directory,name+'.png'),Buffer.from(data.split(',')[1],'base64')); }
app.on('session-created', session => session.webRequest.onBeforeRequest((details, callback) => {const external=/^(?:https?|wss?):/.test(details.url);if(external)externalRequests.push(details.url);callback({cancel:external});}));
const deadline=setTimeout(()=>void finish(Error('Afterglow raster fixture timed out')),60000);
async function finish(error) {
 if(finished)return;finished=true;clearTimeout(deadline);
 if(error)console.error(error.stack||error);
 try{await service?.dispose();}catch(cleanup){error ||= cleanup;}
 await fs.mkdir(directory,{recursive:true});
 const failed=checks.some(check=>!check.passed);
 const report={result:error||failed?'failed':'passed',checks,evidence,errors,externalRequests,error:error?String(error.stack||error):null,sourceHashes,paintOverride,productionPaint:!paintOverride,
  archive,loadedFromAsar:!!archive,productRoot:archive||path.dirname(root),defaultRendererSecurity,
  electron:process.versions.electron,chrome:process.versions.chrome,syntheticButtons:true,actualRendererRaster:true,
  realInputRead:false,realDevicesRead:false,realGameRead:false,realProfileRead:false};
 await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({directory,result:report.result,checks:checks.length}));app.exit(error||failed?1:0);
}
process.on('uncaughtException',error=>void finish(error));process.on('unhandledRejection',error=>void finish(error));
app.whenReady().then(async()=>{
 await fs.mkdir(directory,{recursive:true});
 for(const name of ['ui/input-viewer-paint.js','ui/input-viewer-trail-paint.js','ui/input-viewer-extra-styles.js','ui/input-viewer-model.js','ui/input-viewer.js']){
  const location=name==='ui/input-viewer-paint.js'&&paintOverride?paintOverride:path.join(root,name);
  try{sourceHashes[name]=hash(await fs.readFile(location));}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 class PassiveWindow extends BrowserWindow{constructor(options){super(options);this.webContents.on('console-message',(_event,details)=>{if(details.level==='error')errors.push(details.message);});}show(){this.showInactive();}focus(){}}
 const electron={...require('electron'),BrowserWindow:PassiveWindow};
 if(paintOverride){const nativeNet=electron.net;electron.net={fetch(url,...args){const request=new URL(url);return nativeNet.fetch(request.protocol==='file:'&&path.resolve(fileURLToPath(request))===path.resolve(root,'ui/input-viewer-paint.js')?pathToFileURL(paintOverride).href:url,...args);}};}
 service=await createInputViewer({root,electron,xinputFactory:()=>({start(){sourceStarts++;return false;},select(){return false;},getSelection(){return null;},stop(){},dispose(){}})});
 window=await service.open();await until(()=>evaluate("document.getElementById('element').options.length===8"),'viewer');
 const preferences=window.webContents.getLastWebPreferences();
 defaultRendererSecurity=preferences.contextIsolation===true&&preferences.sandbox===true&&preferences.nodeIntegration===false&&preferences.webSecurity!==false;
 assert.equal(defaultRendererSecurity,true,'Use production renderer isolation and sandbox');
 await evaluate(`(() => {
  window.fixtureReads=0;window.fixtureDown=false;window.fixturePixelFrames={};
  Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>{window.fixtureReads++;return[{index:0,id:'SYNTHETIC AFTERGLOW',connected:true,buttons:[{pressed:window.fixtureDown,value:window.fixtureDown?1:0}],axes:[]}];}});
  window.fixtureSnapshot=name=>{const canvas=document.getElementById('viewer');window.fixturePixelFrames[name]={data:canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data,width:canvas.width,height:canvas.height};return{active:canvas.dataset.active,trails:Number(canvas.dataset.trailCount),at:performance.now()};};
  window.fixtureCompare=(left,right)=>{
   const a=window.fixturePixelFrames[left],b=window.fixturePixelFrames[right],config=JSON.parse(localStorage.getItem('chartshub:input-viewer-config-v2'));
   const control=config.controls.find(value=>value.id==='fret0'),sx=a.width/config.width,sy=a.height/config.height;
   // Leave a quarter-control gap to distinguish a moving tail from the small
   // bright rim immediately adjoining a pressed control.
   const roi={x:Math.ceil(control.x*sx),y:Math.max(0,Math.floor((control.y-control.height*1.5)*sy)),right:Math.floor((control.x+control.width)*sx),bottom:Math.floor((control.y-Math.max(4,control.height*.25))*sy)};
   let peakDelta=0,visiblePixels=0,energy=0;
   for(let y=roi.y;y<roi.bottom;y++)for(let x=roi.x;x<roi.right;x++){
    const offset=(y*a.width+x)*4,aa=a.data[offset+3]/255,ab=b.data[offset+3]/255;
    let delta=0;
    for(let channel=0;channel<3;channel++){const backdrop=[11,18,32][channel];delta=Math.max(delta,Math.abs(a.data[offset+channel]*aa+backdrop*(1-aa)-b.data[offset+channel]*ab-backdrop*(1-ab)));}
    peakDelta=Math.max(peakDelta,delta);energy+=delta;if(delta>=4)visiblePixels++;
   }
   return{peakDelta,visiblePixels,energy,roi};
  };
 })()`);
 await change('kind','button');await change('index','0');
 // Presentation removes the editor grid, keeping an identical transparent
 // canvas for held/idle reference frames. All actual trail settings stay default.
 await evaluate("document.getElementById('presentation').click();document.getElementById('start').click()");
 await until(()=>evaluate("Array.from(document.getElementById('device').options).some(option=>option.value==='0')"),'synthetic controller');await change('device','0');
 const defaults=await evaluate("JSON.parse(localStorage.getItem('chartshub:input-viewer-config-v2')).trails");evidence.defaults=defaults;
 await checkbox('trails',false);await delay(70);await snapshot('idle-reference');
 await evaluate('window.fixtureDown=true');await until(()=>evaluate("document.getElementById('viewer').dataset.active==='fret0'"),'held reference');await delay(60);await snapshot('held-reference');
 await checkbox('trails',true);await delay(70);evidence.held70=await snapshot('held-70');await delay(240);evidence.held310=await snapshot('held-310');await delay(290);evidence.held600=await snapshot('held-600');await image('held-default');
 evidence.outside=await comparison('held-reference','held-600');evidence.motion=await comparison('held-70','held-310');
 // At least a 16/255 colour contrast across a small visible region prevents
 // an almost transparent internal history from being mistaken for an effect.
 record('Default afterglow produces visible light outside the opaque fret',evidence.outside.peakDelta>=16&&evidence.outside.visiblePixels>=80,evidence.outside);
 record('The visible trail changes outside the same continuously held fret over two frames',evidence.motion.peakDelta>=8&&evidence.motion.visiblePixels>=40,evidence.motion);
 await evaluate('window.fixtureDown=false');await delay(90);await snapshot('released-90');await image('released-90');await delay(180);await snapshot('released-270');
 await delay(Math.max(30,defaults.durationMs+140-270));await snapshot('settled');await image('settled');
 evidence.release90=await comparison('idle-reference','released-90');evidence.release270=await comparison('idle-reference','released-270');evidence.settled=await comparison('idle-reference','settled');
 const releaseEnergy=Math.max(evidence.release90.energy,evidence.release270.energy);
 record('Released afterglow decays fully while idle controls remain unchanged',releaseEnergy>100&&evidence.settled.energy<Math.max(2,releaseEnergy*.05)&&evidence.settled.peakDelta<1,{releaseEnergy,settled:evidence.settled});
 await evaluate("document.getElementById('stop').click()");await until(()=>service.status().phase==='stopped','stopped source');
 const reads=await evaluate('window.fixtureReads'),starts=sourceStarts;
 await evaluate("document.getElementById('demo').click()");await delay(70);evidence.demo70=await snapshot('demo-70');await delay(240);evidence.demo310=await snapshot('demo-310');await image('demo-310');
 evidence.demoMotion=await comparison('demo-70','demo-310');
 record('Visual demo animates actual pixels outside a continuously held fret without reading controllers',evidence.demo70.active==='fret0'&&evidence.demo310.active==='fret0'&&evidence.demoMotion.peakDelta>=8&&evidence.demoMotion.visiblePixels>=40&&await evaluate('window.fixtureReads')===reads&&sourceStarts===starts&&service.status().phase==='stopped',evidence.demoMotion);
 await evaluate("document.getElementById('stop').click()");await delay(50);const cleared=await snapshot('stopped');
 record('Stop clears the visible animation and all transient trail state',cleared.active===''&&cleared.trails===0&&await evaluate('window.fixtureReads')===reads,cleared);
 await evaluate("window.fixtureDown=false;document.getElementById('start').click()");
 await until(()=>evaluate("Array.from(document.getElementById('device').options).some(option=>option.value==='0')"),'synthetic controller for style previews');await change('device','0');
 evidence.trailStyles=[];
 for(const style of ['soft','comet','particles','pulse','beam','pixel']){
  await evaluate('window.fixtureDown=false');await change('trail-style',style);await evaluate('window.fixtureDown=true');
  await until(()=>evaluate("document.getElementById('viewer').dataset.active==='fret0'"),'visible '+style+' input');await delay(340);
  await snapshot('style-'+style);const pixels=await comparison('held-reference','style-'+style);
  evidence.trailStyles.push({style,...pixels});await image('trail-style-'+style);
 }
 record('All six selectable trail styles visibly render beyond the control with the same synthetic input',evidence.trailStyles.every(item=>item.peakDelta>=8&&item.visiblePixels>=20),evidence.trailStyles);
 await evaluate("document.getElementById('stop').click()");
 await finish();
}).catch(error=>void finish(error));
