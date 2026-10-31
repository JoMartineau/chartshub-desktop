'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const contract = require('../companion/clonehero-telemetry-contract.cjs');
const { createTelemetryModel } = require('../companion/clonehero-telemetry-model.cjs');
const { publicTelemetrySnapshot } = require('../companion/clonehero-telemetry-view.cjs');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const game = { version:'1.1.0.6142', runtimeBackend:'il2cpp', gameAssemblySha256:'a'.repeat(64), metadataSha256:'b'.repeat(64) };
const provider = { id:'chartshub.clonehero.il2cpp', version:'0.1.3' };
function fixture(overrides = {}) {
    let sequence = 0, sessionId = 'session-one';
    const model = createTelemetryModel({ now:() => 1000 });
    const capabilities = { ...Object.fromEntries(contract.CAPABILITIES.map(key => [key, true])), ...overrides };
    const frame = (type, data = {}, extra = {}) => ({ schema:contract.SCHEMA, provider, game, sessionId, attemptId:'playing-chart', playerId:0, sequence:sequence++, type, data, ...extra });
    const hello = () => model.ingest(frame('hello', { capabilities, coverage:'from-attempt-start', state:{ phase:'playing', stats:{ combo:2 }, clock:{ positionSeconds:10, durationSeconds:100 } } }));
    const sample = (stage = 'audio', id = stage+'-one', extra = {}) => model.ingest(frame('calibration', { stage, offsetMs:234.9, calibrationAttemptId:id }, extra));
    const result = (stage = 'audio', settingMs = 18, id = stage+'-one', extra = {}) => model.ingest(frame('calibrationResult', { stage, settingMs, calibrationAttemptId:id }, extra));
    hello();
    return { model, frame, sample, result, hello, reconnect() { sessionId='session-two'; hello(); } };
}
test('native result accepts only declared integer absolute settings and a strict stage/id schema', () => {
    const f=fixture();
    for (const data of [
        {stage:'both',settingMs:1,calibrationAttemptId:'one'}, {stage:'audio',settingMs:1.2,calibrationAttemptId:'one'},
        {stage:'audio',settingMs:'1',calibrationAttemptId:'one'}, {stage:'audio',settingMs:Infinity,calibrationAttemptId:'one'},
        {stage:'audio',settingMs:2001,calibrationAttemptId:'one'}, {stage:'video',settingMs:-2001,calibrationAttemptId:'one'},
        {stage:'audio',settingMs:1}, {stage:'audio',settingMs:1,calibrationAttemptId:'one',rawPath:'private'},
        {stage:'audio',settingMs:1,calibrationAttemptId:'<img>'}
    ]) assert.throws(()=>contract.validateFrame(f.frame('calibrationResult',data)),error=>error.code==='INVALID_CALIBRATION_RESULT');
    for (const stage of ['audio','video']) for(const settingMs of [-2000,0,2000]) assert.equal(contract.validateFrame(f.frame('calibrationResult',{stage,settingMs,calibrationAttemptId:'one'})).data.settingMs,settingMs);
});
test('an R21 hello omitting the new capability remains compatible and cannot claim native results', () => {
    const f=fixture();const capabilities={...f.model.snapshot().capabilities};delete capabilities.calibrationResults;
    f.model.ingest(f.frame('hello',{capabilities,coverage:'since-connect'}));
    assert.equal(f.model.snapshot().capabilities.calibrationResults,false);f.sample();
    assert.throws(()=>f.result(),/non déclarés/);assert.deepEqual(f.model.snapshot().calibration.nativeResults,{audio:null,video:null});
});
test('both native capabilities are required even when the result itself has valid scalars', () => {
    for(const key of ['calibrationResults','calibrationTiming']) { const f=fixture({[key]:false});assert.throws(()=>f.result(),/non déclarés/);assert.equal(f.model.snapshot().calibration.nativeResults.audio,null); }
});
test('two native results retain separate absolute values without adding a current setting or gameplay mean', () => {
    const f=fixture();f.model.startCalibration('audio',500,'gameplay');
    for(let i=0;i<30;i++)f.model.ingest(f.frame('hit',{offsetMs:-99}));
    f.sample();f.sample();f.result('audio',18);f.sample('video');f.result('video',-27);
    const s=f.model.snapshot();assert.deepEqual(s.calibration.nativeResults,{audio:{settingMs:18,sampleCount:2,at:1000,source:'native-calibration'},video:{settingMs:-27,sampleCount:1,at:1000,source:'native-calibration'}});
    assert.equal(s.timing.meanOffsetMs,-99);assert.equal(s.timing.sampleCount,30);assert.equal(s.calibration.trial.sampleCount,30);assert.equal(s.calibration.trial.settingMs,500);
});
test('a native result with no observed samples or a mismatching stage cannot reuse a prior window', () => {
    const f=fixture();f.result();assert.equal(f.model.snapshot().calibration.nativeResults.audio,null);
    f.sample('audio','next');f.result('video',22,'next');f.result('audio',14,'next');
    assert.deepEqual(f.model.snapshot().calibration.nativeResults,{audio:null,video:null});
});
test('a result from another enclosing gameplay attempt cannot complete the observed native window', () => {
    const f=fixture();f.sample();f.result('audio',18,'audio-one',{attemptId:'other-chart'});assert.equal(f.model.snapshot().calibration.nativeResults.audio,null);
});
test('repeated result ids and transport frames never replace an accepted native value or cancel another stage', () => {
    const f=fixture();f.sample();const frame=f.frame('calibrationResult',{stage:'audio',settingMs:18,calibrationAttemptId:'audio-one'});f.model.ingest(frame);assert.equal(f.model.ingest(frame),false);
    f.sample('video');f.result('audio',1999);f.sample('audio');f.result('video',-27);
    assert.equal(f.model.snapshot().calibration.nativeResults.audio.settingMs,18);assert.equal(f.model.snapshot().calibration.nativeResults.video.settingMs,-27);
});
test('a transport gap from the local or another player retires that calibration generation', () => {
    for(const playerId of [0,1]) {const f=fixture();f.sample();f.frame('heartbeat');f.model.ingest(f.frame('heartbeat',{}, {playerId}));f.sample();f.result();assert.equal(f.model.snapshot().calibration.nativeResults.audio,null);f.sample('audio','fresh');f.result('audio',21,'fresh');assert.equal(f.model.snapshot().calibration.nativeResults.audio.settingMs,21);}
});
test('disconnect and authenticated reconnect remove previous results and pending native windows', () => {
    const f=fixture();f.sample();f.result();f.sample('video');f.model.connection('stale');assert.deepEqual(f.model.snapshot().calibration.nativeResults,{audio:null,video:null});
    f.reconnect();f.result('video',10);assert.deepEqual(f.model.snapshot().calibration.nativeResults,{audio:null,video:null});f.sample('video','new-connection');f.result('video',11,'new-connection');assert.equal(f.model.snapshot().calibration.nativeResults.video.settingMs,11);
});
test('a local game reset or change of native stage cannot resurrect the abandoned result', () => {
    const f=fixture();f.sample();f.model.ingest(f.frame('reset',{reason:'restart'}));f.result();assert.equal(f.model.snapshot().calibration.nativeResults.audio,null);
    f.sample('audio','abandoned');f.sample('video');f.result('audio',15,'abandoned');f.result('video',20);assert.equal(f.model.snapshot().calibration.nativeResults.audio,null);assert.equal(f.model.snapshot().calibration.nativeResults.video.settingMs,20);
});
test('calibration events remain outside gameplay state, history, FC, score and persistent records', () => {
    const f=fixture();f.model.ingest(f.frame('hit',{offsetMs:-5}));const before=f.model.snapshot(),records=f.model.exportRecords();
    f.sample('audio','one',{attemptId:'native-tool'});f.result('audio',-2,'one',{attemptId:'native-tool'});const after=f.model.snapshot();
    for(const key of ['active','timing','history','session','comparison','goal'])assert.deepEqual(after[key],before[key],key);
    assert.deepEqual(f.model.exportRecords(),records);assert.equal(JSON.stringify(records).includes('settingMs'),false);
});
test('OBS projection exposes neither native calibration settings nor trial ids, drafts or counts', () => {
    const f=fixture();f.model.startCalibration('audio',777,'tool');f.sample('audio','private-native-id');f.result('audio',-1369,'private-native-id');
    const projected=publicTelemetrySnapshot(f.model.snapshot());assert.equal(Object.hasOwn(projected,'calibration'),false);const text=JSON.stringify(projected);for(const sensitive of ['nativeResults','settingMs','private-native-id','calibrationAttemptId','-1369','777'])assert.equal(text.includes(sensitive),false,sensitive);
});
test('actual telemetry identifies the header as Clone Hero data while legacy controls keep their selected mode', () => {
    const source=fs.readFileSync(path.join(__dirname,'../companion/ui/panel.js'),'utf8');
    const snippet=source.slice(source.indexOf('function liveSource('),source.indexOf('async function changeSource('));
    function render(snapshot, gameplayMeasurements=true) {
        const nodes=new Map(), query=key=>{if(!nodes.has(key))nodes.set(key,{classList:{values:new Map(),toggle(name,value){this.values.set(name,value);}},dataset:{}});return nodes.get(key);};
        const controls={next:{},reset:{},state:{}},document={body:{dataset:{}}};
        vm.runInNewContext(snippet+'\nrenderSource(input);',{query,controls,document,input:snapshot,currentSnapshot:null,sourceBusy:false,api:{},gameplayMeasurements});
        return {nodes,controls,document};
    }
    for(const mode of ['mock','live']) {
        const legacy=render({cloneHero:{mode}}),actual=render({cloneHero:{mode},telemetry:{connected:true,status:'connected'}});
        assert.equal(actual.nodes.get('#source-mode-label').textContent,'MESURES CLONE HERO');assert.equal(actual.nodes.get('#source-mode-badge').classList.values.get('is-live'),true);
        assert.deepEqual(actual.controls,legacy.controls);assert.deepEqual(actual.document,legacy.document);assert.equal(actual.nodes.get('#clonehero-mode').value,legacy.nodes.get('#clonehero-mode').value);
        const publicView=render({cloneHero:{mode},telemetry:{connected:true,status:'connected'}},false);
        assert.equal(publicView.nodes.get('#source-mode-label').textContent,mode==='live'?'DIRECT CLONE HERO':'MODE DÉMO');
        for(const telemetry of [{connected:true,status:'stale'},{connected:false,status:'connected'},{connected:false,status:'unsupported'},null]) {
            const blocked=render({cloneHero:{mode},telemetry});assert.equal(blocked.nodes.get('#source-mode-label').textContent,mode==='live'?'DIRECT CLONE HERO':'MODE DÉMO');assert.equal(blocked.nodes.get('#source-mode-badge').classList.values.get('is-live'),mode==='live');
        }
    }
});
test('the actual-measurements header label follows French and English without changing demo text', () => {
    const window={ChartsHubCompanion:{initialLanguage:'fr'},dispatchEvent(){}},document={readyState:'loading',documentElement:{},addEventListener(){}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../companion/ui/localization.js'),'utf8'),{window,document,CustomEvent:class{}});
    const language=window.ChartshubCompanionLanguage;assert.equal(language.translate('MESURES CLONE HERO'),'MESURES CLONE HERO');language.apply('en');assert.equal(language.translate('MESURES CLONE HERO'),'CLONE HERO DATA');assert.equal(language.translate('MODE DÉMO'),'DEMO MODE');language.apply('fr');assert.equal(language.translate('MESURES CLONE HERO'),'MESURES CLONE HERO');
});
