'use strict';
// Real renderer, host and IPC. Hardware is injected; this test reads no real device or game.
const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
if(process.env.NODE_PATH)require('node:module').Module._initPaths();
const {registerFixtureMaintenance,revealWorkspace}=require('./workspace-input.cjs');
const disposeMaintenance=registerFixtureMaintenance();
const outputArg=process.argv.find(value=>value.startsWith('--fixture-output='));if(!outputArg)throw Error('Explicit fixture output required');
const output=path.resolve(outputArg.slice('--fixture-output='.length)),directory=path.join(output,'calibration-hardware-'+randomUUID());
app.setPath('userData',path.join(directory,'electron-profile'));process.env.LOCALAPPDATA=path.join(directory,'local-app-data');app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const {createCompanionHost,registerCompanionScheme}=require('../companion/host.cjs');registerCompanionScheme();
let host,panel,refreshes=0;const checks=[],errors=[];
const initial={status:'idle',checkedAt:null,audio:{status:'unavailable',outputName:null,sampleRateHz:null,channels:null,defaultPeriodMs:null,minimumPeriodMs:null},inputs:[],displays:[]};
let hardware=structuredClone(initial);
const service={snapshot:()=>structuredClone(hardware),async refresh(){refreshes++;hardware={status:'ready',checkedAt:123,audio:{status:'available',outputName:'Fixture USB Speakers',sampleRateHz:48000,channels:2,defaultPeriodMs:10,minimumPeriodMs:3},inputs:[{name:'Fixture Guitar',kind:'candidate'}],displays:[{key:'display-0',label:'Fixture Display',widthPx:1920,heightPx:1080,refreshHz:144,frameIntervalMs:1000/144,appDisplay:true}]};return this.snapshot();}};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const evaluate=code=>panel.webContents.executeJavaScript(code);
async function until(fn,label){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await delay(30);}throw Error('Timed out: '+label);}
async function click(selector){await revealWorkspace(panel,selector);const point=await evaluate(`(async()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Unavailable control');n.scrollIntoView({block:'center',behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),p={x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)},hit=document.elementFromPoint(p.x,p.y);if(!hit||!(hit===n||n.contains(hit)))throw Error('Covered control');return p;})()`);panel.focus();panel.webContents.focus();for(const type of ['mouseMove','mouseDown','mouseUp'])panel.webContents.sendInputEvent({type,...point,...(type==='mouseMove'?{}:{button:'left',clickCount:1})});await delay(80);}
async function field(selector,value){await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));})()`);}
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
async function capture(filename){await revealWorkspace(panel,'.performance-calibration-hardware');await evaluate("document.querySelector('.performance-calibration-hardware').scrollIntoView({block:'start',behavior:'instant'})");await delay(100);assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'),false);await fs.writeFile(path.join(directory,filename),(await panel.webContents.capturePage()).toPNG());}
let finished=false;async function finish(error){if(finished)return;finished=true;clearTimeout(deadline);if(error)console.error(error.stack||error);try{if(host)await host.dispose();assert.equal(BrowserWindow.getAllWindows().length,0);disposeMaintenance();}catch(failure){error=error||failure;}await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'report.json'),JSON.stringify({result:error?'failed':'passed',checks,refreshes,errors,error:error?String(error.stack||error):null,realHardwareRead:false,realGameRead:false,actualHostAndIpc:true},null,2));console.log(JSON.stringify({directory,result:error?'failed':'passed',checks:checks.length}));if(error)app.exit(1);else app.quit();}
const deadline=setTimeout(()=>void finish(Error('Hardware fixture timed out')),60000);process.on('uncaughtException',error=>void finish(error));process.on('unhandledRejection',error=>void finish(error));
app.whenReady().then(async()=>{
    await fs.mkdir(directory,{recursive:true});
    host=await createCompanionHost({dataDirectory:path.join(directory,'companion'),calibrationHardwareService:service,cloneHeroCandidates:[],cloneHeroProcessProbe:async()=>({running:false,sessions:[]}),isCatalogueAvailable:()=>false,authorizeCatalogue:async()=>false,catalogueClient:{async load(){return{items:[],revision:'fixture',demo:false};},async artwork(){return null;}}});
    panel=await host.open();panel.setSize(1280,900);panel.webContents.on('console-message',(_event,details)=>{if(details.level==='error')errors.push(details.message);});
    await until(()=>evaluate("!!document.querySelector('#calibration-hardware-detect')"),'hardware controls');
    await check('No hardware is read at startup; manual setup is available',async()=>{assert.equal(refreshes,0);assert.equal(await evaluate("document.querySelector('#calibration-hardware-output').value"),'');assert.match(await evaluate("document.querySelector('.performance-calibration-hardware').textContent"),/Retard physique non mesuré/);});
    await check('Native button invokes only the bounded hardware refresh through production IPC',async()=>{
        await click('.performance-calibration > summary');await click('.performance-calibration-hardware > summary');
        await click('#calibration-hardware-detect');await until(()=>refreshes===1,'one explicit refresh');await until(()=>evaluate("document.querySelector('#calibration-hardware-output').placeholder==='Fixture USB Speakers'"),'metadata rendered');
        assert.equal(await evaluate("document.querySelector('#calibration-hardware-output').value"),'');assert.equal(await evaluate("document.querySelector('#calibration-hardware-display').value"),'');
        assert.match(await evaluate("document.querySelector('.performance-calibration-hardware').textContent"),/période moteur par défaut \(partagé\) 10,00 ms/);assert.match(await evaluate("document.querySelector('.performance-calibration-hardware').textContent"),/candidates/);
        const invalid=await evaluate("window.ChartsHubCompanion.command('telemetry.hardwareRefresh',{path:'arbitrary'})");assert.equal(invalid.ok,false);assert.equal(refreshes,1);
    });
    await check('User confirms actual output/input/display; video guidance reports refresh interval only',async()=>{
        await field('#calibration-hardware-output','Fixture USB Speakers');await field('#calibration-hardware-input','Fixture Guitar');await field('#calibration-hardware-display','display-0');await click('#calibration-hardware-confirmed');
        assert.equal(await evaluate("document.querySelector('#calibration-hardware-confirmed').checked"),true);
        await field('#calibration-stage','video');assert.match(await evaluate("document.querySelector('.performance-calibration-instructions').textContent"),/Écran confirmé.*Fixture Display/);assert.match(await evaluate("document.querySelector('.performance-calibration-hardware').textContent"),/6,94 ms/);
        await capture('hardware-fr.png');
        await field('#calibration-hardware-note','Bluetooth');assert.equal(await evaluate("document.querySelector('#calibration-hardware-confirmed').checked"),false);
    });
    await check('English labels stay accurate at minimum window width',async()=>{host.setLanguage('en');await until(()=>evaluate("document.querySelector('#calibration-hardware-detect').textContent==='Detect / refresh hardware'"),'English hardware labels');const minimum=panel.getMinimumSize();panel.setSize(Math.max(minimum[0],800),Math.max(minimum[1],750));await capture('hardware-en-min.png');assert.match(await evaluate("document.querySelector('.performance-calibration-hardware').textContent"),/Physical delay is not measured/);assert.match(await evaluate("document.querySelector('.performance-calibration-hardware').textContent"),/Windows default does not prove/);assert.deepEqual(errors,[]);});
    await finish();
}).catch(error=>void finish(error));
