'use strict';
// Synthetic video only. Never enumerates or captures the user's windows or opens a game.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const electron=require('electron'),{app,BrowserWindow,protocol}=electron;
const {createGameCapture}=require('../companion/game-capture.cjs');
const directory=path.resolve(__dirname,'../outputs/game-capture-synthetic');
app.setPath('userData',path.join(app.getPath('temp'),'chartshub-capture-review-'+process.pid));
protocol.registerSchemesAsPrivileged([{scheme:'chartshub-companion',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){const end=Date.now()+15000;while(Date.now()<end){const result=await fn();if(result)return result;await delay(60);}throw Error('Timed out');}
let service;
app.whenReady().then(async()=>{
  await fs.mkdir(directory,{recursive:true});
  let displayHandler,lang='fr';const sourceRequests=[];
  const sessionProxy={fromPartition(name){const ses=electron.session.fromPartition(name);ses.setDisplayMediaRequestHandler=fn=>{displayHandler=fn;};return ses;}};
  const source={id:'window:42:0',name:'Clone Hero — Synthetic fixture',get thumbnail(){throw Error('Pre-start thumbnails forbidden');}};
  service=await createGameCapture({root:path.resolve(__dirname,'../companion'),language:()=>lang,electron:{...electron,session:sessionProxy,desktopCapturer:{async getSources(options){assert.deepEqual(options.thumbnailSize,{width:0,height:0});sourceRequests.push(options);return[source];}}}});
  await service.open();const controller=BrowserWindow.getAllWindows()[0];
  const run=(code,gesture=false)=>controller.webContents.executeJavaScript(code,gesture);
  const jsErrors=[];controller.webContents.on('console-message',(_event,...args)=>{if(args.some(a=>String(a).includes('Error')))jsErrors.push(args.map(String).join(' '));});
  await until(()=>run('document.getElementById("source").options.length===2'));
  assert.equal(service.snapshot().phase,'stopped');
  await run('document.getElementById("source").value="window:42:0";document.getElementById("source").dispatchEvent(new Event("change"));');
  await until(()=>run('!document.getElementById("start").disabled'));
  await run(`navigator.mediaDevices.getDisplayMedia=async options=>{
    if(options.audio!==false)throw Error('Audio requested');
    await new Promise(resolve=>window.fixtureStartGrant=resolve);
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const ctx=canvas.getContext('2d');let n=0;
    window.fixtureTimer=setInterval(()=>{ctx.fillStyle='#203648';ctx.fillRect(0,0,640,360);ctx.fillStyle='#16c779';ctx.fillRect(170,30,150,300);ctx.fillStyle='#ffd660';ctx.fillRect(340,30,200,120);ctx.fillStyle='white';ctx.font='24px sans-serif';ctx.fillText('SYNTHETIC '+n++,180,190);},33);
    return canvas.captureStream(30);
  };document.getElementById('start').click();`,true);
  let grant;await displayHandler({frame:controller.webContents.mainFrame,securityOrigin:'chartshub-companion://app',userGesture:true,videoRequested:true,audioRequested:false},value=>{grant=value;});
  assert.equal(grant.video.id,source.id);await run('window.fixtureStartGrant();');
  await until(()=>service.snapshot().phase==='capturing');
  const draw=async(kind,a,b)=>{
    await run(`(()=>{document.getElementById('region').value=${JSON.stringify(kind)};const canvas=document.getElementById('selection'),r=canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:1,clientX:r.left+r.width*${a[0]},clientY:r.top+r.height*${a[1]}}));
    canvas.dispatchEvent(new PointerEvent('pointerup',{button:0,pointerId:1,clientX:r.left+r.width*${b[0]},clientY:r.top+r.height*${b[1]}}));})();`);
    await until(()=>run(`!document.getElementById('open-${kind}').disabled`));
  };
  // Direct pointer capture needs an active pointer; provide a test-only no-op for synthetic events.
  await run('void(document.getElementById("selection").setPointerCapture=()=>{});');
  await draw('highway',[.25,.05],[.52,.95]);await draw('score',[.52,.05],[.9,.45]);
  await run('document.getElementById("open-highway").click();document.getElementById("open-score").click();',true);
  await until(()=>BrowserWindow.getAllWindows().length===3);
  const outputs=BrowserWindow.getAllWindows().filter(w=>w!==controller);
  for(const output of outputs){
    await until(()=>output.webContents.executeJavaScript('document.getElementById("output").videoWidth>0'));
    const image=await output.webContents.capturePage();const bitmap=image.toBitmap();assert.ok(bitmap.some((v,i)=>i%4!==3&&v>80),'output has real synthetic video pixels');
    await fs.writeFile(path.join(directory,output.getTitle().includes('Highway')?'highway.png':'score.png'),image.toPNG());
  }
  await fs.writeFile(path.join(directory,'preview-fr.png'),(await controller.webContents.capturePage()).toPNG());
  lang='en';await run('window.ChartsHubGameCapture.command("crop",{kind:"score",rect:{x:.52,y:.05,width:.38,height:.4}})');await delay(150);
  await fs.writeFile(path.join(directory,'preview-en.png'),(await controller.webContents.capturePage()).toPNG());
  await run('document.getElementById("stop").click();',true);
  await until(()=>service.snapshot().phase==='stopped'&&BrowserWindow.getAllWindows().length===1);
  assert.equal(await run('document.getElementById("game").srcObject===null'),true);
  assert.ok(sourceRequests.every(r=>r.types.length===1&&r.types[0]==='window'));
  await fs.writeFile(path.join(directory,'verification.json'),JSON.stringify({status:'SYNTHETIC_VIDEO_CROP_AND_LOCAL_WEBRTC_VERIFIED',realGameExecuted:false,realWindowsEnumerated:false,realWindowCaptured:false,isolatedProfile:true,sourceRequests:sourceRequests.length,outputs:outputs.map(w=>w.options?.title??'closed'),explicitStopVerified:true,jsErrors},null,2)+'\n');
  await service.dispose();console.log('Synthetic capture preview, two cropped WebRTC outputs and explicit stop verified.');app.exit(0);
}).catch(async error=>{console.error(error.stack);await service?.dispose().catch(()=>{});app.exit(1);});
