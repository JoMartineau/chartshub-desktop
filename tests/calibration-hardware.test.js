'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createCalibrationHardware, parseProbe, readDisplays, frameIntervalMs, validHardwareContext } = require('../companion/calibration-hardware.cjs');
const { validCommand, trustedCatalogueWidgetCommand, trustedFiltersWidgetCommand } = require('../companion/security.cjs');
const { createTelemetryModel } = require('../companion/clonehero-telemetry-model.cjs');
const { publicTelemetrySnapshot } = require('../companion/clonehero-telemetry-view.cjs');
const c = require('../companion/clonehero-telemetry-contract.cjs');
const metadata = () => ({ audio: { status:'available',outputName:'USB Speakers',sampleRateHz:48000,channels:2,defaultPeriodMs:10,minimumPeriodMs:3 }, outputs:[{name:'USB Speakers',kind:'candidate',windowsDefault:true}], inputs:[{name:'Guitar Controller',kind:'candidate'}] });
const display = { id:99,label:'Test Display',size:{width:1920,height:1080},scaleFactor:1,displayFrequency:144 };
const screen = {getAllDisplays:()=>[display],getDisplayMatching:()=>display};
const context = () => ({version:1,audioOutput:'USB Speakers',input:'Guitar Controller',display:{key:'display-0',label:'Test Display',widthPx:1920,heightPx:1080,refreshHz:144},note:'USB · Game mode'});

test('probe response accepts bounded metadata and discards malformed, oversized and extra fields', () => {
    const valid=metadata(); assert.deepEqual(parseProbe(JSON.stringify(valid)),valid);
    for(const value of ['invalid','x'.repeat(16385),JSON.stringify({...valid,path:'private'}),JSON.stringify({...valid,audio:{...valid.audio,latency:10}}),JSON.stringify({...valid,inputs:Array(33).fill(valid.inputs[0])}),JSON.stringify({...valid,audio:{...valid.audio,channels:1.5}}),JSON.stringify({...valid,audio:{...valid.audio,sampleRateHz:1}}),JSON.stringify({...valid,audio:{...valid.audio,minimumPeriodMs:-1}}),JSON.stringify({...valid,inputs:[{name:'x',kind:'used-by-game'}]})]) {
        const result=parseProbe(value); assert.equal(result.audio.status,'unavailable'); assert.deepEqual(result.inputs,[]);
    }
    assert.equal(parseProbe(JSON.stringify({...valid,audio:{...valid.audio,outputName:'Speakers serial: PRIVATE123'}})).audio.outputName,'Speakers');
});

test('display metadata labels only the app display and computes refresh interval without physical latency', () => {
    const [d]=readDisplays(screen,{x:0,y:0,width:800,height:600});
    assert.equal(d.key,'display-0');assert.equal(d.appDisplay,true);assert.equal(d.widthPx,1920);assert.equal(d.refreshHz,144);assert.equal(d.frameIntervalMs,1000/144);
    assert.equal(Object.hasOwn(d,'id'),false);assert.equal(Object.hasOwn(d,'latencyMs'),false);
    assert.equal(frameIntervalMs(60),1000/60);for(const invalid of [0,NaN,Infinity,-1,'144',1001])assert.equal(frameIntervalMs(invalid),null);
    assert.deepEqual(readDisplays({getAllDisplays(){throw Error('unavailable');}}),[]);
    assert.equal(readDisplays({getAllDisplays:()=>[{...display,label:'Screen serial: SECRET'}]})[0].label,'Screen');
    assert.equal(readDisplays({getAllDisplays:()=>[{...display,scaleFactor:1.25}]})[0].widthPx,2400);
    const keys=new Map();const original=readDisplays(screen,null,keys)[0];const reordered=readDisplays({getAllDisplays:()=>[{...display,id:100},display]},null,keys);assert.equal(reordered[1].key,original.key);assert.notEqual(reordered[0].key,original.key);
});

test('diagnostic performs no startup work and refreshes on request with fixed bounded hidden arguments', async () => {
    const calls=[];let callback;
    const service=createCalibrationHardware({platform:'win32',screen,now:()=>123,bounds:()=>({x:0,y:0,width:1,height:1}),execFile:(...args)=>{calls.push(args);callback=args[3];}});
    assert.equal(calls.length,0);assert.equal(service.snapshot().status,'idle');
    const first=service.refresh(),second=service.refresh();assert.equal(calls.length,1);assert.equal(service.snapshot().status,'checking');
    const [executable,args,options]=calls[0];assert.match(executable,/powershell\.exe$/);assert.deepEqual(args.slice(0,5),['-NoLogo','-NoProfile','-NonInteractive','-STA','-EncodedCommand']);
    assert.equal(Buffer.from(args[5],'base64').toString('utf16le'),fs.readFileSync(path.join(__dirname,'../companion/calibration-hardware-windows.ps1'),'utf8'));
    assert.equal(options.windowsHide,true);assert.equal(options.timeout,10000);assert.equal(options.maxBuffer,16384);
    callback(null,JSON.stringify(metadata()));await Promise.all([first,second]);
    const snapshot=service.snapshot();assert.equal(snapshot.checkedAt,123);assert.equal(snapshot.audio.outputName,'USB Speakers');assert.equal(snapshot.displays.length,1);
    snapshot.audio.outputName='mutated';assert.equal(service.snapshot().audio.outputName,'USB Speakers');
    const next=service.refresh();assert.equal(calls.length,2);callback(Error('denied'),'private failure');await next;assert.equal(service.snapshot().audio.status,'unavailable');
});

test('unavailable platform, throwing probes and an unresponsive helper remain bounded and do not affect displays', async () => {
    const unsupported=createCalibrationHardware({platform:'linux',screen,execFile(){throw Error('must not run');}});await unsupported.refresh();assert.equal(unsupported.snapshot().displays.length,1);assert.equal(unsupported.snapshot().audio.status,'unavailable');
    const throwing=createCalibrationHardware({platform:'win32',screen,execFile(){throw Error('unavailable');}});await throwing.refresh();assert.equal(throwing.snapshot().status,'ready');
    const hanging=createCalibrationHardware({platform:'win32',screen,timeoutMs:1,execFile(){}});await hanging.refresh();assert.equal(hanging.snapshot().status,'ready');assert.equal(hanging.snapshot().audio.status,'unavailable');
});

test('only bounded hardware context and parameter-free refresh enter the existing panel command path', () => {
    const base={stage:'audio',source:'gameplay',settingMs:17};assert.equal(validCommand('telemetry.calibrationStart',base,[]),true);assert.equal(validCommand('telemetry.calibrationStart',{...base,hardwareContext:context()},[]),true);
    assert.equal(validHardwareContext(context()),true);
    for(const invalid of [null,{...context(),serial:'private'},{...context(),input:'x'.repeat(121)},{...context(),audioOutput:'a\nb'},{...context(),note:'C:\\Users\\private'},{...context(),input:'Controller USB\\VID_1234&PID_5678\\PRIVATE'},{...context(),note:'serial: PRIVATE'},{...context(),display:{...context().display,refreshHz:0}},{...context(),display:{...context().display,id:999}}])assert.equal(validCommand('telemetry.calibrationStart',{...base,hardwareContext:invalid},[]),false);
    assert.equal(validCommand('telemetry.hardwareRefresh',{},[]),true);for(const invalid of [{command:'anything'},{path:'C:\\private'},[],true])assert.equal(validCommand('telemetry.hardwareRefresh',invalid,[]),false);
    assert.equal(trustedCatalogueWidgetCommand({},null,'telemetry.hardwareRefresh',{}),false);assert.equal(trustedFiltersWidgetCommand({},null,'telemetry.hardwareRefresh',{}),false);
});

test('confirmed hardware is copied into trial history without changing timing, record exports or OBS projection', () => {
    let sequence=0;const model=createTelemetryModel({now:()=>123});const send=(type,data)=>model.ingest({schema:c.SCHEMA,provider:{id:'chartshub.clonehero.il2cpp',version:'0.1.0'},game:{version:'1.1.0.6142',runtimeBackend:'il2cpp',gameAssemblySha256:'a'.repeat(64),metadataSha256:'b'.repeat(64)},sessionId:'fixture',attemptId:'chart',playerId:0,sequence:sequence++,type,data});
    send('hello',{capabilities:Object.fromEntries(c.CAPABILITIES.map(k=>[k,true])),coverage:'since-connect',state:{phase:'playing'}});
    const hardware=context();model.startCalibration('audio',17,'gameplay',hardware);hardware.audioOutput='mutated';
    for(let i=0;i<29;i++)send('hit',{offsetMs:-7});assert.throws(()=>model.finishCalibration(),/continus/);
    send('hit',{offsetMs:-7});model.finishCalibration();const s=model.snapshot();assert.deepEqual(s.calibration.trials[0].hardwareContext,context());assert.equal(s.calibration.trials[0].sampleCount,30);assert.equal(s.calibration.trials[0].meanOffsetMs,-7);assert.equal(s.calibration.trials[0].settingMs,17);
    assert.equal(JSON.stringify(model.exportRecords()).includes('USB Speakers'),false);assert.equal(JSON.stringify(publicTelemetrySnapshot(s)).includes('USB Speakers'),false);
    model.startCalibration('video',19,'gameplay');assert.equal(Object.hasOwn(model.snapshot().calibration.trial,'hardwareContext'),false);
});

test('comparison keeps legacy confirmation and rejects mismatched or half-known setups', () => {
    const source=fs.readFileSync(path.join(__dirname,'../companion/ui/gameplay-controls.js'),'utf8').replace('export class GameplayControls','class GameplayControls');
    const scope={};vm.runInNewContext(source+'\nthis.GameplayControls=GameplayControls;',scope);const matches=scope.GameplayControls.prototype.matchingHardware;
    const audio={stage:{value:'audio'}},video={stage:{value:'video'}};
    assert.equal(matches.call(audio,undefined,undefined),true);assert.equal(matches.call(audio,context(),undefined),false);assert.equal(matches.call(audio,context(),context()),true);assert.equal(matches.call(audio,context(),{...context(),note:'Bluetooth'}),false);
    assert.equal(matches.call(video,{...context(),display:null},{...context(),display:null}),false);assert.equal(matches.call(video,context(),context()),true);
});
