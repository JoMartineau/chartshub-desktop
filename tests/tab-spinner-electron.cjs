'use strict';
// Render the real shell markup and CSS without account, IPC or network capabilities.
const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),output=path.resolve(process.argv[2]||'');
if(!process.argv[2]||fs.existsSync(output))throw Error('Supply a new output directory');
fs.mkdirSync(output,{recursive:true});app.setPath('userData',path.join(output,'profile'));app.disableHardwareAcceleration();
let win;const observations=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
const fail=err=>{console.error(err);fs.writeFileSync(path.join(output,'failure.txt'),err.stack||String(err));app.exit(1);};
process.on('unhandledRejection',fail);setTimeout(()=>fail(Error('Spinner test timeout')),20000).unref();
const source=fs.readFileSync(path.join(root,'desktop/index.html'),'utf8');
const html=source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace('href="./shell.css"','href="'+pathToFileURL(path.join(root,'desktop/shell.css')).href+'"').replace('href="shell.css"','href="'+pathToFileURL(path.join(root,'desktop/shell.css')).href+'"');
fs.writeFileSync(path.join(output,'fixture.html'),html);
app.whenReady().then(async()=>{
 const ses=session.fromPartition('spinner-layout-fixture');ses.webRequest.onBeforeRequest((d,done)=>done({cancel:!d.url.startsWith('file:')&&!d.url.startsWith('data:')}));
 win=new BrowserWindow({width:1400,height:700,show:false,webPreferences:{session:ses,nodeIntegration:false,contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}});
 await win.loadFile(path.join(output,'fixture.html'));const web=win.webContents,run=s=>web.executeJavaScript(s);
 await run(`document.querySelector('#companion-tab').hidden=false;document.querySelectorAll('.tab-spinner').forEach(s=>s.hidden=true);true`);
 const measure=()=>run(`Array.from(document.querySelectorAll('.tab')).map(t=>{const r=t.getBoundingClientRect();return {id:t.id,x:r.x,y:r.y,width:r.width,height:r.height};})`);
 for(const width of [1400,950,720]){
  win.setContentSize(width,700);await delay(50);const idle=await measure();
  for(const target of ['#catalogue-tab','#companion-tab']){
   await run(`document.querySelector('${target} .tab-spinner').hidden=false;true`);await delay(25);
   assert.deepEqual(await measure(),idle,'Spinner must reserve its existing space at '+width);
   await run(`document.querySelector('${target} .tab-spinner').hidden=true;true`);await delay(25);assert.deepEqual(await measure(),idle);
  }
  assert.equal(await run(`getComputedStyle(document.querySelector('.tab-spinner')).visibility`),'hidden');
  observations.push({width,tabs:idle});
 }
 fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({observations,network:false,accountChanges:false},null,2));
 console.log(JSON.stringify({widths:observations.map(r=>r.width),result:'SPINNER_GEOMETRY_STABLE'}));win.destroy();app.exit(0);
}).catch(fail);
