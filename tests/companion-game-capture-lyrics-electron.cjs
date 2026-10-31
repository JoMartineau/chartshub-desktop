'use strict';
// Synthetic canvas video only. No real window list, screen capture, game or connector.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const electron=require('electron'),{app,BrowserWindow,protocol}=electron;
const archiveArgument=process.argv.find(value=>value.startsWith('--fixture-asar='));
const productRoot=archiveArgument?path.resolve(archiveArgument.slice('--fixture-asar='.length)):path.resolve(__dirname,'..');
if(archiveArgument&&!productRoot.endsWith('.asar'))throw Error('An actual ASAR archive is required');
const {createGameCapture,TITLES}=require(path.join(productRoot,'companion/game-capture.cjs'));
const arg=process.argv.find(value=>value.startsWith('--fixture-output='));
if(!arg){console.error('Explicit fixture output required');app.exit(1);}
const directory=path.join(path.resolve(arg.slice('--fixture-output='.length)),'l-'+randomUUID().slice(0,8));fs.mkdirSync(directory,{recursive:true});
app.setPath('userData',path.join(directory,'profile'));app.setPath('sessionData',path.join(directory,'session'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
protocol.registerSchemesAsPrivileged([{scheme:'chartshub-companion',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
let service,controller,lang='fr',displayHandler,finished=false;const checks=[],errors=[],externalRequests=[],sourceRequests=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),run=(code,gesture=false)=>controller.webContents.executeJavaScript(code,gesture);
async function until(fn,label){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await delay(40);}throw Error('Timed out: '+label);}
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
async function finish(error){if(finished)return;finished=true;clearTimeout(deadline);if(error)console.error(error.stack||error);try{await service?.dispose();assert.equal(BrowserWindow.getAllWindows().length,0);}catch(failure){error=error||failure;}await fsp.writeFile(path.join(directory,'report.json'),JSON.stringify({result:error?'failed':'passed',checks,errors,externalRequests,error:error?String(error.stack||error):null,sourceRequests:sourceRequests.length,loadedFromAsar:!!archiveArgument,productRoot,actualCaptureServiceAndIpc:true,actualLocalWebRTC:true,realGameRead:false,realWindowCaptured:false,realWindowsEnumerated:false,connectorLoaded:false,audioCaptured:false,isolatedProfile:true},null,2)+'\n');console.log(JSON.stringify({directory,result:error?'failed':'passed',checks:checks.length}));app.exit(error?1:0);}
const deadline=setTimeout(()=>void finish(Error('Synthetic lyrics crop fixture timed out')),75000);process.on('uncaughtException',error=>void finish(error));process.on('unhandledRejection',error=>void finish(error));
app.whenReady().then(async()=>{
 const sessionProxy={fromPartition(name){const ses=electron.session.fromPartition(name);ses.setDisplayMediaRequestHandler=fn=>{displayHandler=fn;};ses.webRequest.onBeforeRequest((details,callback)=>{const u=new URL(details.url),allowed=['chartshub-companion:','file:','blob:'].includes(u.protocol);if(!allowed)externalRequests.push(details.url);callback({cancel:!allowed});});return ses;}};
 const source={id:'window:42:0',name:'Clone Hero — Synthetic fixture',get thumbnail(){throw Error('No pre-start image reads');}};
 service=await createGameCapture({root:path.join(productRoot,'companion'),language:()=>lang,electron:{...electron,session:sessionProxy,desktopCapturer:{async getSources(options){assert.deepEqual(options.thumbnailSize,{width:0,height:0});sourceRequests.push(options);return[source];}}}});
 await service.open();controller=BrowserWindow.getAllWindows()[0];controller.webContents.on('console-message',(_event,details)=>{if(details.level==='error')errors.push(details.message);});
 await until(()=>run('document.getElementById("source").options.length===2'),'fake window list');
 await check('Capture opens stopped and offers an independent lyrics region and disabled output',async()=>{
  assert.equal(service.snapshot().phase,'stopped');assert.equal(await run('document.getElementById("source").value'),'');assert.equal(await run('document.getElementById("region").options.length'),3);assert.equal(await run('document.getElementById("open-lyrics").disabled'),true);assert.match(await run('document.getElementById("intro").textContent'),/ni connecteur ni horloge/);
 });
 await check('Explicit selected-window start grants video only and uses the synthetic canvas',async()=>{
  await run('document.getElementById("source").value="window:42:0";document.getElementById("source").dispatchEvent(new Event("change"));');await until(()=>run('!document.getElementById("start").disabled'),'selected source');
  await run(`navigator.mediaDevices.getDisplayMedia=async options=>{if(options.audio!==false)throw Error('Audio requested');await new Promise(resolve=>window.fixtureStartGrant=resolve);const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const ctx=canvas.getContext('2d');let n=0;window.fixtureTimer=setInterval(()=>{ctx.fillStyle='#203648';ctx.fillRect(0,0,640,360);ctx.fillStyle='#16c779';ctx.fillRect(170,25,150,260);ctx.fillStyle='#ffd660';ctx.fillRect(340,25,230,120);ctx.fillStyle='#8d45d8';ctx.fillRect(20,295,600,60);ctx.fillStyle='white';ctx.font='20px sans-serif';ctx.fillText('PAROLES EXEMPLE '+n++,45,330);},33);return canvas.captureStream(30);};document.getElementById('start').click();`,true);
  let grant;await displayHandler({frame:controller.webContents.mainFrame,securityOrigin:'chartshub-companion://app',userGesture:true,videoRequested:true,audioRequested:false},value=>{grant=value;});assert.equal(grant.video.id,source.id);assert.equal(Object.hasOwn(grant,'audio'),false);await run('window.fixtureStartGrant();');await until(()=>service.snapshot().phase==='capturing','explicit capture');
 });
 async function draw(kind,a,b){await run(`(()=>{document.getElementById('region').value=${JSON.stringify(kind)};const canvas=document.getElementById('selection'),r=canvas.getBoundingClientRect();canvas.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:1,clientX:r.left+r.width*${a[0]},clientY:r.top+r.height*${a[1]}}));canvas.dispatchEvent(new PointerEvent('pointerup',{button:0,pointerId:1,clientX:r.left+r.width*${b[0]},clientY:r.top+r.height*${b[1]}}));})();`);await until(()=>run(`!document.getElementById('open-${kind}').disabled`),'crop '+kind);}
 await check('Three drawn regions retain separate coordinates through validated production IPC',async()=>{
  await run('void(document.getElementById("selection").setPointerCapture=()=>{});');await draw('highway',[.25,.05],[.52,.75]);await draw('score',[.52,.05],[.9,.4]);await draw('lyrics',[.03,.8],[.98,.98]);
  const value=await run('window.ChartsHubGameCapture.command("snapshot")');assert.deepEqual(Object.keys(value.state.crops),['highway','score','lyrics']);assert(value.state.crops.highway.y<.1);assert(value.state.crops.score.y<.1);assert(value.state.crops.lyrics.y>.79);
  const invalid=await run('window.ChartsHubGameCapture.command("crop",{kind:"lyrics",rect:{x:0.9,y:0,width:0.5,height:1}})');assert.equal(invalid.ok,false);
 });
 let outputs;
 await check('All three owned output windows receive real synthetic video over local WebRTC',async()=>{
  await run('document.getElementById("open-highway").click();document.getElementById("open-score").click();document.getElementById("open-lyrics").click();',true);await until(()=>BrowserWindow.getAllWindows().length===4,'three outputs');outputs=BrowserWindow.getAllWindows().filter(w=>w!==controller);await until(()=>outputs.every(w=>Object.values(TITLES).includes(w.getTitle())),'output titles');
  assert.deepEqual(outputs.map(w=>w.getTitle()).sort(),Object.values(TITLES).sort());
  for(const output of outputs){await until(()=>output.webContents.executeJavaScript('document.getElementById("output").videoWidth>0'),'video '+output.getTitle());const image=await output.webContents.capturePage();assert(image.toBitmap().some((value,index)=>index%4!==3&&value>80),'Visible synthetic video pixels');const kind=Object.keys(TITLES).find(k=>TITLES[k]===output.getTitle());await fsp.writeFile(path.join(directory,kind+'.png'),image.toPNG());}
  await fsp.writeFile(path.join(directory,'preview-fr.png'),(await controller.webContents.capturePage()).toPNG());
 });
 await check('Editing only lyrics leaves highway and score unchanged and resizes only the lyrics output',async()=>{
  const before=(await run('window.ChartsHubGameCapture.command("snapshot")')).state,oldSizes=outputs.filter(w=>w.getTitle()!==TITLES.lyrics).map(w=>w.getContentSize());
  const result=await run('window.ChartsHubGameCapture.command("crop",{kind:"lyrics",rect:{x:0.1,y:0.82,width:0.8,height:0.15}})');assert.equal(result.ok,true);const after=(await run('window.ChartsHubGameCapture.command("snapshot")')).state;
  assert.deepEqual(after.crops.highway,before.crops.highway);assert.deepEqual(after.crops.score,before.crops.score);assert.notDeepEqual(after.crops.lyrics,before.crops.lyrics);assert.deepEqual(outputs.filter(w=>w.getTitle()!==TITLES.lyrics).map(w=>w.getContentSize()),oldSizes);
 });
 await check('Closing and reopening lyrics preserves other output windows and the active crop',async()=>{
  const lyrics=outputs.find(w=>w.getTitle()===TITLES.lyrics);lyrics.close();await until(()=>BrowserWindow.getAllWindows().length===3,'lyrics closed');assert.equal(service.snapshot().phase,'capturing');await run('document.getElementById("open-lyrics").click();',true);await until(()=>BrowserWindow.getAllWindows().length===4,'lyrics reopened');
  const reopened=BrowserWindow.getAllWindows().find(w=>w.getTitle()===TITLES.lyrics);await until(()=>reopened.webContents.executeJavaScript('document.getElementById("output").videoWidth>0'),'reopened lyrics video');
 });
 await check('English instructions and three buttons fit the minimum controller width',async()=>{
  lang='en';await run('window.ChartsHubGameCapture.command("crop",{kind:"lyrics",rect:{x:0.1,y:0.82,width:0.8,height:0.15}})');controller.setSize(650,740);await delay(100);assert.equal(await run('document.documentElement.scrollWidth>innerWidth+1'),false);assert.match(await run('document.getElementById("heading").textContent'),/lyrics/);assert.match(await run('document.getElementById("instructions").textContent'),/remain an image without transparency or text extraction/);await fsp.writeFile(path.join(directory,'preview-en-min.png'),(await controller.webContents.capturePage()).toPNG());
 });
 await check('Stop revokes all outputs, synthetic tracks and transient regions without any game or network request',async()=>{
  await run('document.getElementById("stop").click();',true);await until(()=>service.snapshot().phase==='stopped'&&BrowserWindow.getAllWindows().length===1,'all outputs stopped');assert.equal(await run('document.getElementById("game").srcObject===null'),true);const value=(await run('window.ChartsHubGameCapture.command("snapshot")')).state;assert.deepEqual(value.crops,{highway:null,score:null,lyrics:null});assert.equal(value.selected,null);assert(sourceRequests.every(r=>r.types.length===1&&r.types[0]==='window'));assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
 });
 await finish();
}).catch(error=>void finish(error));
