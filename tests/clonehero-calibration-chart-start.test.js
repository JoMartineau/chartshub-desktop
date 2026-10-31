'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createTelemetryModel } = require('../companion/clonehero-telemetry-model.cjs');
const c = require('../companion/clonehero-telemetry-contract.cjs');
const game = { version:'1.1.0.6142', runtimeBackend:'il2cpp', gameAssemblySha256:'a'.repeat(64), metadataSha256:'b'.repeat(64) };
const provider = { id:'chartshub.clonehero.il2cpp', version:'0.1.0' };
const metadata = { chartId:'c'.repeat(64), instrument:'Guitar', difficulty:'Expert' };
const clock = (positionSeconds = 0, speed = 1) => ({ positionSeconds, durationSeconds:120, speed });
function fixture(phase = 'menu') {
    let sequence = 0, attemptId = 'menu-attempt';
    const model = createTelemetryModel({ now:() => 1000 });
    const frame = (type, data = {}, extra = {}) => ({ schema:c.SCHEMA, provider, game, sessionId:'session-one', attemptId, playerId:0, sequence:sequence++, type, data, ...extra });
    const send = (type, data, extra) => model.ingest(frame(type, data, extra));
    send('hello', { capabilities:Object.fromEntries(c.CAPABILITIES.map(key => [key,true])), coverage:'since-connect', state:{phase} });
    return { model, frame, send, setAttempt:value => { attemptId = value; }, hit:() => send('hit', {offsetMs:-4}) };
}
function startChart(f, id = 'chart-one') {
    f.setAttempt(id);
    f.send('reset', {reason:'song',state:{phase:'loading'}});
    f.send('state', {phase:'playing',metadata,clock:clock(-2)});
}

for (const stage of ['audio','video']) test(`${stage} can be armed before the chart and waits for the first real hit through loading and preroll`, () => {
    for (const phase of ['idle','menu','loading','results']) {
        const f = fixture(phase);
        f.model.startCalibration(stage,13,'gameplay');
        assert.equal(f.model.snapshot().calibration.trial.incomplete,false);
        startChart(f);
        f.send('heartbeat');
        f.send('state',{phase:'playing',metadata,clock:clock(0,.75)});
        let trial = f.model.snapshot().calibration.trial;
        assert.equal(trial.incomplete,false,'starting the chart must not interrupt an empty trial');
        assert.equal(trial.state,'waiting-hit');
        assert.equal(trial.sampleCount,0,'clock and state updates never invent measurements');
        assert.equal(trial.meanOffsetMs,null);
        assert.throws(() => f.model.finishCalibration(),/continus/);
        f.hit();
        assert.equal(f.model.snapshot().calibration.trial.state,'collecting');
        for(let i = 1; i < 29; i++) f.hit();
        assert.throws(() => f.model.finishCalibration(),/continus/);
        f.hit(); f.model.finishCalibration();
        const result = f.model.snapshot().calibration.trials[0];
        assert.equal(result.stage,stage); assert.equal(result.settingMs,13);
        assert.equal(result.sampleCount,30); assert.equal(result.meanOffsetMs,-4);
    }
});

test('the R32 state-free song reset accepts an early hit before the next throttled state without assuming speed', () => {
    const f = fixture(); f.model.startCalibration('audio',13,'gameplay');
    assert.equal(f.model.snapshot().calibration.trial.state,'waiting-chart');
    f.setAttempt('early-hit-chart'); f.send('reset',{reason:'song'}); f.hit();
    assert.equal(f.model.snapshot().calibration.trial.incomplete,false);
    assert.equal(f.model.snapshot().calibration.trial.sampleCount,1);
    f.send('state',{phase:'playing',metadata,clock:clock(1,.75)});
    for(let i = 1; i < 30; i++) f.hit();
    f.model.finishCalibration(); assert.equal(f.model.snapshot().calibration.trials[0].sampleCount,30);
});

test('before the first hit a new chart, restart, seek and speed choice remain preparation', () => {
    const f = fixture(); f.model.startCalibration('audio',13,'gameplay');
    startChart(f);
    for (const reason of ['restart','seek','song']) {
        f.setAttempt('pre-hit-'+reason);
        f.send('reset',{reason,state:{phase:'playing',metadata,clock:clock(0,.5)}});
        assert.equal(f.model.snapshot().calibration.trial.incomplete,false);
    }
    for(let i = 0; i < 30; i++) f.hit();
    f.model.finishCalibration(); assert.equal(f.model.snapshot().calibration.trials[0].sampleCount,30);
});

test('after the first hit every real discontinuity retires the trial and later hits cannot contaminate it', () => {
    const mutations = {
        restart:f => f.send('reset',{reason:'restart',state:{phase:'playing',metadata,clock:clock()}}),
        seek:f => f.send('reset',{reason:'seek',state:{phase:'playing',metadata,clock:clock(50)}}),
        attempt:f => { f.setAttempt('another-attempt'); f.hit(); },
        chart:f => f.send('state',{phase:'playing',metadata:{...metadata,chartId:'d'.repeat(64)},clock:clock(1)}),
        instrument:f => f.send('state',{phase:'playing',metadata:{...metadata,instrument:'Bass'},clock:clock(1)}),
        difficulty:f => f.send('state',{phase:'playing',metadata:{...metadata,difficulty:'Hard'},clock:clock(1)}),
        speed:f => f.send('state',{phase:'playing',clock:clock(1,.75)}),
        backwardClock:f => { f.send('state',{phase:'playing',clock:clock(20)}); f.send('state',{phase:'playing',clock:clock(2)}); },
        gap:f => { f.frame('heartbeat'); f.send('heartbeat'); },
        disconnect:f => f.model.connection('stale')
    };
    for (const [name,mutate] of Object.entries(mutations)) {
        const f = fixture(); f.model.startCalibration('video',13,'gameplay'); startChart(f); f.hit();
        mutate(f);
        let trial = f.model.snapshot().calibration.trial;
        assert.equal(trial.incomplete,true,name);
        assert.equal(trial.state,'interrupted',name);
        if (name !== 'disconnect') for(let i = 0; i < 35; i++) f.hit();
        trial = f.model.snapshot().calibration.trial;
        assert.equal(trial.sampleCount,1,name+' does not mix a later segment');
        assert.throws(() => f.model.finishCalibration(),/continus/,name);
        assert.deepEqual(f.model.snapshot().calibration.trials,[],name);
    }
});

test('foreign, duplicate, native calibration and menu hits cannot start the armed gameplay trial', () => {
    const f = fixture(); f.model.startCalibration('audio',13,'gameplay');
    f.send('hit',{offsetMs:100},{playerId:1});
    f.send('calibration',{stage:'audio',offsetMs:100,calibrationAttemptId:'native-one'});
    f.hit(); f.hit();
    assert.equal(f.model.snapshot().calibration.trial.sampleCount,0);
    startChart(f);
    const hit = f.frame('hit',{offsetMs:-4}); f.model.ingest(hit); f.model.ingest(hit);
    assert.equal(f.model.snapshot().calibration.trial.sampleCount,1);
});

test('known speed and chart identity survive temporarily missing state fields during a measured segment', () => {
    for (const changed of [ {phase:'playing',clock:clock(2,.75)}, {phase:'playing',metadata:{...metadata,chartId:'d'.repeat(64)}} ]) {
        const f = fixture(); f.model.startCalibration('audio',13,'gameplay'); startChart(f); f.hit();
        f.send('state',{phase:'playing',metadata:{title:'Cosmetic update'},clock:{positionSeconds:1,durationSeconds:120}});
        f.send('state',changed);
        assert.equal(f.model.snapshot().calibration.trial.incomplete,true);
        assert.equal(f.model.snapshot().calibration.trial.sampleCount,1);
    }
});

test('native tool trials still invalidate on chart reset before their first native sample', () => {
    const f = fixture(); f.model.startCalibration('audio',13,'tool'); startChart(f);
    assert.equal(f.model.snapshot().calibration.trial.incomplete,true);
    for(let i = 0; i < 30; i++) f.send('calibration',{stage:'audio',offsetMs:-4,calibrationAttemptId:'native-one'});
    assert.equal(f.model.snapshot().calibration.trial.sampleCount,0);
    assert.throws(() => f.model.finishCalibration(),/continus/);
});
