'use strict';
const {revealWorkspace,registerFixtureMaintenance}=require('./workspace-input.cjs');
registerFixtureMaintenance();
// Real renderer, IPC and worker; only disposable fixture pickers/dialogs/bin are mocked.
const {app,dialog,shell}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {registerCompanionScheme,createCompanionHost}=require('../companion/host.cjs');
const output=path.resolve(process.argv[2]),directory=path.join(output,'bad-songs-'+randomUUID()),songs=path.join(directory,'Songs'),filename=path.join(directory,'badsongs.txt');
app.setPath('userData',path.join(directory,'electron-profile'));app.disableHardwareAcceleration();registerCompanionScheme();
const original={picker:dialog.showOpenDialog,confirm:dialog.showMessageBox,trash:shell.trashItem},passed=[],recycled=[],errors=[];
let host,panel,action='cancel',confirmations=0,lastWait='',failing=false,scrollLayout=null;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),evaluate=code=>panel.webContents.executeJavaScript(code);
const command=(name,payload)=>evaluate(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`);
async function waitFor(check,label,timeout=20000){lastWait=label;const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(35);}throw Error('Timed out: '+label);}
async function click(selector){
    await revealWorkspace(panel, selector);
  await waitFor(()=>evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return !!n&&!n.disabled&&!n.hidden})()`),selector);
  panel.focus();panel.webContents.focus();
  const point=await evaluate(`(async()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'center',behavior:'instant'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=n.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)},hit=document.elementFromPoint(p.x,p.y);if(!r.width||!r.height||!(hit===n||n.contains(hit)))throw Error('Bad songs control covered');return p})()`);
  for(const type of ['mouseMove','mouseDown','mouseUp'])panel.webContents.sendInputEvent({type,...point,...(type==='mouseMove'?{}:{button:'left',clickCount:1})});await delay(45);
}
async function capture(name){await fs.writeFile(path.join(directory,name+'.png'),(await panel.webContents.capturePage()).toPNG());}
async function importReport(){await click('#library-bad-songs-import');await waitFor(()=>evaluate(`document.querySelector('#library-bad-songs').getAttribute('aria-busy')==='false'&&!document.querySelector('#library-bad-songs-plan').hidden&&document.querySelectorAll('.library-bad-song-check').length>=2`),'reported charts ready');}
async function fail(error){if(failing)return;failing=true;let scrollState=null;try{if(panel&&!panel.isDestroyed()){await capture('failure');scrollState=await evaluate(`(()=>{const n=document.querySelector('#library-bad-songs-list'),r=n?.getBoundingClientRect();return{scrollTop:n?.scrollTop,scrollHeight:n?.scrollHeight,clientHeight:n?.clientHeight,page:document.scrollingElement.scrollTop,rect:r?{top:r.top,bottom:r.bottom}:null,wheels:window.__badSongsWheels??[]}})()`);}}catch{}await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'verification.json'),JSON.stringify({ok:false,error:String(error.stack||error),lastWait,passed,recycled,confirmations,errors,scrollLayout,scrollState},null,2));console.error(error);try{await host?.dispose();}catch{}app.exit(1);}
setTimeout(()=>void fail(Error('Bad songs Electron verification timed out')),150000).unref();
app.whenReady().then(async()=>{
  const originalFiles=new Map();
  for(const name of ['A','B']){const folder=path.join(songs,name);await fs.mkdir(folder,{recursive:true});for(const [file,content]of Object.entries({'notes.chart':'broken raw note bytes','song.ini':'[song]\nname=Example\nartist=Band\ncharter=Creator\n'})){const full=path.join(folder,file);await fs.writeFile(full,content);originalFiles.set(full,content);}}
  const report='ERROR: These folders have corrupt (or broken) notes.mid or notes.chart files!\n'+['A','B'].map(name=>path.join(songs,name)).join('\n')+'\n\nWarning: Unsupported video platform\n'+Array.from({length:65},(_,index)=>path.join(songs,'warning-'+index)).join('\n')+'\n';await fs.writeFile(filename,report);
  dialog.showOpenDialog=async(_owner,options)=>({canceled:false,filePaths:[options.title.includes('badsongs.txt')?filename:songs]});
  dialog.showMessageBox=async(_owner,options)=>{confirmations++;assert.equal(options.defaultId,0);assert.equal(options.cancelId,0);assert.ok(options.detail.includes(path.join(songs,'A')));assert.equal(options.detail.includes(path.join(songs,'B')),false);if(action==='change-report')await fs.appendFile(filename,'\n');return{response:action==='cancel'?0:1};};
  shell.trashItem=async target=>{assert.equal(path.relative(songs,target),'A');assert.equal((await fs.lstat(target)).isSymbolicLink(),false);const bin=path.join(directory,'fake-bin');await fs.mkdir(bin,{recursive:true});await fs.rename(target,path.join(bin,'A'));recycled.push('A');};
  host=await createCompanionHost({dataDirectory:path.join(directory,'profile'),cloneHeroCandidates:[],cloneHeroProcessProbe:async()=>({running:false,sessions:[]}),
    catalogueClient:{async load(){return{items:[],revision:'bad-songs-fixture',demo:false};},async artwork(){throw Error('No fixture network');}},downloadWorker:{async run(){throw Error('No fixture downloads');},async discard(){},async resolveCompleted(){return null;}}});
  panel=await host.open();panel.setSize(1250,1000);panel.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});
  await waitFor(()=>evaluate(`!!window.ChartsHubCompanion&&!!document.querySelector('#library-bad-songs-import')`),'Companion ready');
  assert.equal((await command('library.settings',{watch:false,refreshOnStart:false})).ok,true);await click('#library-choose-root');await waitFor(()=>host.snapshot().library.status==='ready','scan ready');
  const lastScanAt=host.snapshot().library.lastScanAt,revision=host.snapshot().library.revision;
  await click('#library-bad-songs > summary');await importReport();
  assert.equal(await evaluate(`document.querySelectorAll('.library-bad-song-check:checked').length`),0);assert.equal(await evaluate(`document.querySelectorAll('.library-bad-song-check:not(:disabled)').length`),2);assert.equal(await evaluate(`document.querySelector('#library-bad-songs-recycle').disabled`),true);
  assert.match(await evaluate(`document.querySelector('#library-bad-songs-status').textContent`),/Report from|Rapport du/);passed.push('real report import renders raw corrupt notes, timestamp and reasons, excludes warnings and starts with no selection');
  // Native focus restoration can move the page. Complete it before framing
  // the report list and recording the coordinates used for the real wheel.
  panel.focus();panel.webContents.focus();
  await evaluate(`(async()=>{const n=document.querySelector('#library-bad-songs-list');n.focus({preventScroll:true});n.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
    // Native wheel hit-testing must use the compositor's committed scroll.
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    window.__badSongsWheels=[];window.__badSongsWheelListener=event=>window.__badSongsWheels.push({trusted:event.isTrusted,inside:n.contains(event.target),deltaY:event.deltaY});
    document.addEventListener('wheel',window.__badSongsWheelListener,{capture:true,passive:true});
  })()`);
  // Flush the compositor before measuring the native wheel target. Route the
  // event directly to this renderer, as the real edit-menu fixture does.
  await panel.webContents.capturePage();
  const layout=scrollLayout=await evaluate(`(()=>{const n=document.querySelector('#library-bad-songs-list'),r=n.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);return{x,y,inside:!!hit&&n.contains(hit),focused:document.activeElement===n,viewport:{width:innerWidth,height:innerHeight},navBottom:document.querySelector('.app-header').getBoundingClientRect().bottom,rect:{top:r.top,bottom:r.bottom},scrollTop:n.scrollTop,scrollHeight:n.scrollHeight,clientHeight:n.clientHeight,page:document.scrollingElement.scrollTop,contain:getComputedStyle(n).overscrollBehaviorY}})()`);
  assert.equal(layout.contain,'contain');assert.equal(layout.inside,true,'native wheel point hits the report list');assert.ok(layout.clientHeight>0&&layout.scrollHeight>layout.clientHeight,'the report list is scrollable');
  assert.equal(layout.focused,true,'native report list owns keyboard focus before framing the wheel');assert.ok(layout.x>=0&&layout.x<layout.viewport.width&&layout.y>=layout.navBottom&&layout.y<layout.viewport.height,'wheel point is inside the viewport below sticky navigation');
  assert.equal(panel.webContents.debugger.isAttached(),false,'the wheel fixture owns its isolated debugger');panel.webContents.debugger.attach('1.3');
  try{
    await panel.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:layout.x,y:layout.y});
    await panel.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',x:layout.x,y:layout.y,deltaY:350,deltaX:0});
    await waitFor(()=>evaluate(`document.querySelector('#library-bad-songs-list').scrollTop>${layout.scrollTop}`),'internal report scrolling');
    assert.equal(await evaluate(`window.__badSongsWheels.some(event=>event.trusted&&event.inside&&event.deltaY>0)`),true,'a real downward wheel reaches the report list');
    assert.equal(await evaluate('document.scrollingElement.scrollTop'),layout.page);
  }finally{if(panel.webContents.debugger.isAttached())panel.webContents.debugger.detach();}
  await evaluate(`document.removeEventListener('wheel',window.__badSongsWheelListener,{capture:true})`);passed.push('native wheel scrolling moves the report list without moving the complete page');
  await evaluate(`document.querySelector('#library-bad-songs-list').scrollTop=0`);const firstSelector='.library-bad-song[data-severity="error"] .library-bad-song-check';await click(firstSelector);await capture('selected-error');
  await click('#library-bad-songs-recycle');await waitFor(()=>confirmations===1&&evaluate(`document.querySelector('#library-bad-songs').getAttribute('aria-busy')==='false'`),'cancelled confirmation');assert.deepEqual(recycled,[]);assert.equal(host.snapshot().library.revision,revision);passed.push('native confirmation defaults to Cancel, names the selected full path and cancellation keeps every fixture file');
  action='change-report';await click('#library-bad-songs-recycle');await waitFor(()=>confirmations===2&&evaluate(`document.querySelector('#library-bad-songs').getAttribute('aria-busy')==='false'`),'changed report blocked');assert.deepEqual(recycled,[]);for(const [file,bytes]of originalFiles)assert.equal(await fs.readFile(file,'utf8'),bytes);passed.push('a report modified during the native dialog prevents all recycling');
  await importReport();await click(firstSelector);action='accept';await click('#library-bad-songs-recycle');await waitFor(()=>recycled.length===1&&evaluate(`document.querySelector('#library-bad-songs').getAttribute('aria-busy')==='false'`),'selected chart recycled');
  assert.deepEqual(recycled,['A']);assert.equal(host.snapshot().library.revision,revision+1);assert.equal(host.snapshot().library.lastScanAt,lastScanAt);assert.equal(host.snapshot().library.cleanupRefreshPending,true);for(const [file,bytes]of originalFiles)if(path.basename(path.dirname(file))==='B')assert.equal(await fs.readFile(file,'utf8'),bytes);passed.push('accepted confirmation moves one selected fixture into the fake bin, preserves the unchecked chart and defers the final scan');
  host.setLanguage('en');await waitFor(()=>evaluate(`document.documentElement.lang==='en'`),'English UI');assert.match(await evaluate(`document.querySelector('#library-bad-songs-status').textContent`),/Recycle Bin/);assert.equal(await evaluate(`document.querySelectorAll('.library-bad-song-check:checked').length`),0);await capture('cleanup-success');passed.push('English status keeps the remaining report usable with no automatic rescan or preselection');
  assert.deepEqual(errors,[]);await fs.writeFile(path.join(directory,'verification.json'),JSON.stringify({ok:true,passed,recycled,confirmations,errors,fixtureOnly:true,nativeTrashUsed:false,providerRequests:0},null,2));await host.dispose();host=null;
  dialog.showOpenDialog=original.picker;dialog.showMessageBox=original.confirm;shell.trashItem=original.trash;console.log(JSON.stringify({ok:true,checks:passed.length,directory}));app.exit(0);
}).catch(fail);
