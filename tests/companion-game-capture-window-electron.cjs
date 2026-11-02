'use strict';
// Real Electron window-capture pipeline, restricted to this fixture's own window.
// No desktopCapturer enumeration, user window, game, microphone or sound.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const electron=require('electron'),{app,BrowserWindow,protocol}=electron;
const {createGameCapture}=require('../companion/game-capture.cjs');
const output=process.argv.find(a=>a.startsWith('--fixture-output='));
if(!output)throw Error('Explicit fixture output required');
const directory=path.join(path.resolve(output.slice('--fixture-output='.length)),'window-'+randomUUID().slice(0,8));
app.setPath('userData',path.join(directory,'profile'));app.setPath('sessionData',path.join(directory,'session'));
app.on('window-all-closed',()=>{});
protocol.registerSchemesAsPrivileged([{scheme:'chartshub-companion',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
let service,target,controller,done=false;const checks=[],errors=[],permissionRequests=[],displayRequests=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const run=(code,gesture=false)=>controller.webContents.executeJavaScript(code,gesture);
async function until(fn,label){const end=Date.now()+18000;while(Date.now()<end){if(await fn())return;await delay(60);}throw Error('Timed out: '+label);}
async function finish(error){if(done)return;done=true;clearTimeout(deadline);if(error)console.error(error.stack||error);await service?.dispose().catch(()=>{});if(target&&!target.isDestroyed())target.destroy();await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'report.json'),JSON.stringify({result:error?'failed':'passed',checks,errors,permissionRequests,displayRequests,error:error?String(error.stack||error):null,realElectronGetDisplayMedia:true,onlyOwnedSyntheticWindow:true,realWindowsEnumerated:false,realGameCaptured:false,audioCaptured:false},null,2));console.log(JSON.stringify({directory,result:error?'failed':'passed',checks:checks.length}));app.exit(error?1:0);}
const deadline=setTimeout(()=>void finish(Error('Owned capture test timed out')),60000);
process.on('uncaughtException',e=>void finish(e));process.on('unhandledRejection',e=>void finish(e));
app.whenReady().then(async()=>{
 await fs.mkdir(directory,{recursive:true});
 target=new BrowserWindow({width:640,height:400,show:true,title:'Clone Hero — Owned capture fixture',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 await target.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><meta charset="utf-8"><title>Clone Hero — Owned capture fixture</title><style>body{margin:0;background:#15994b;color:white;font:32px sans-serif}div{background:#d69a21;padding:35px}</style><div>Signal de démonstration</div><p>Fenêtre synthétique ChartsHub</p>'));
 // getMediaSourceId uses :1 for an Electron tab; :0 explicitly exercises the
 // OS window capturer using this owned HWND, like desktopCapturer window rows.
 const source={id:target.getMediaSourceId().replace(/:1$/,':0'),name:'Clone Hero — Owned capture fixture'};
 const sessionProxy={fromPartition(name){const ses=electron.session.fromPartition(name);for(const key of ['setPermissionRequestHandler','setDisplayMediaRequestHandler']){const original=ses[key].bind(ses);ses[key]=fn=>original(fn&&((...args)=>{if(key==='setPermissionRequestHandler')permissionRequests.push({permission:args[1],mediaTypes:args[3].mediaTypes});else displayRequests.push({origin:args[0].securityOrigin,gesture:args[0].userGesture,video:args[0].videoRequested,audio:args[0].audioRequested});return fn(...args);}));}return ses;}};
 service=await createGameCapture({root:path.resolve(__dirname,'../companion'),electron:{...electron,session:sessionProxy,desktopCapturer:{async getSources(options){assert.deepEqual(options.thumbnailSize,{width:0,height:0});return[source];}}}});
 await service.open();controller=BrowserWindow.getAllWindows().find(w=>w!==target);controller.webContents.on('console-message',(_event,details)=>{if(details.level==='error')errors.push(details.message);});
 await until(()=>run('document.getElementById("source").options.length===2'),'owned source').catch(async e=>{console.log('Preview state '+JSON.stringify(await run('({url:location.href,status:document.getElementById("status").textContent,source:document.getElementById("source").innerHTML,api:!!window.ChartsHubGameCapture})')));throw e;});
 await run(`document.getElementById('source').value=${JSON.stringify(source.id)};document.getElementById('source').dispatchEvent(new Event('change'));`);
 await until(()=>run('!document.getElementById("start").disabled'),'selected source');
 assert.equal(service.snapshot().phase,'stopped');checks.push('Explicit selection does not start capture');
 await run(`const originalMedia=navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getDisplayMedia=async(...a)=>{try{return await originalMedia(...a);}catch(e){window.fixtureFailure={name:e.name,message:e.message};throw e;}};document.getElementById("start").click();`,true);
 await until(()=>service.snapshot().phase==='capturing','actual getDisplayMedia starts').catch(async e=>{console.log('Media state '+JSON.stringify(await run('({failure:window.fixtureFailure,status:document.getElementById("status").textContent,ready:document.getElementById("game").readyState,width:document.getElementById("game").videoWidth,state:null})')));throw e;});
 const pixels=await run(`(()=>{const v=document.getElementById('game'),c=document.createElement('canvas');c.width=32;c.height=18;const x=c.getContext('2d');x.drawImage(v,0,0,32,18);return{width:v.videoWidth,height:v.videoHeight,bright:Array.from(x.getImageData(0,0,32,18).data).some((n,i)=>i%4!==3&&n>80),status:document.getElementById('status').textContent};})()`);
 assert(pixels.width>0&&pixels.height>0);assert.equal(pixels.bright,true,JSON.stringify(pixels));checks.push('Actual captured owned-window frames contain visible pixels');
 assert(displayRequests.length===1&&displayRequests[0].gesture&&displayRequests[0].video&&!displayRequests[0].audio);checks.push('Real permission preflight and origin retain user-activated video-only grant');
 await fs.writeFile(path.join(directory,'owned-preview-fr.png'),(await controller.webContents.capturePage()).toPNG());
 await run('window.ChartsHubGameCapture.command("crop",{kind:"score",rect:{x:0,y:0,width:1,height:0.5}})');await run('document.getElementById("open-score").click();',true);
 await until(()=>BrowserWindow.getAllWindows().length===3,'cropped output');const cropped=BrowserWindow.getAllWindows().find(w=>w!==target&&w!==controller);
 await until(()=>cropped.webContents.executeJavaScript('document.getElementById("output").videoWidth>0'),'real cropped video');
 const visible=await cropped.webContents.executeJavaScript(`(()=>{const v=document.getElementById('output'),c=document.createElement('canvas');c.width=16;c.height=9;const x=c.getContext('2d');x.drawImage(v,0,0,16,9);return Array.from(x.getImageData(0,0,16,9).data).some((n,i)=>i%4!==3&&n>80);})()`);assert.equal(visible,true);await fs.writeFile(path.join(directory,'owned-score-output.png'),(await cropped.webContents.capturePage()).toPNG());checks.push('Actual captured pixels reach the cropped OBS window over local WebRTC');
 await run('document.getElementById("stop").click();',true);await until(()=>service.snapshot().phase==='stopped','explicit stop');assert.equal(await run('document.getElementById("game").srcObject===null'),true);checks.push('Stop revokes actual video tracks');
 assert.deepEqual(errors,[]);await finish();
}).catch(error=>void finish(error));
