'use strict';
const contract = require('./clonehero-telemetry-contract.cjs');
const clone = v => structuredClone(v), known = (v) => typeof v === 'number' && Number.isFinite(v), emptyCaps = () => Object.fromEntries(contract.CAPABILITIES.map(k => [k, false]));
function accumulator() { return { count: 0, last: null, mean: 0, absoluteMean: 0, m2: 0, windows: new Float64Array(202) }; }
function measure(a, value) { a.count++; a.last = value; const delta = value - a.mean; a.mean += delta / a.count; a.m2 += delta * (value - a.mean); a.absoluteMean += (Math.abs(value) - a.absoluteMean) / a.count; a.windows[Math.min(201, Math.ceil(Math.abs(value)))]++; }
function metrics(a, windowMs, coverage) { let within = 0; for (let i = 0; i <= windowMs; i++)
    within += a.windows[i]; return { lastOffsetMs: a.last, meanOffsetMs: a.count ? a.mean : null, meanAbsoluteOffsetMs: a.count ? a.absoluteMean : null, standardDeviationMs: a.count ? Math.sqrt(Math.max(0, a.m2 / a.count)) : null, withinWindowPercent: a.count ? within / a.count * 100 : null, windowMs, sampleCount: a.count, coverage }; }
const emptyStats = () => ({ score: null, combo: null, misses: null, overstrums: null, notesHit: null, notesTotal: null });
function validSettings(value) { if (!contract.only(value, ['windowMs', 'goal']) || !Number.isInteger(value.windowMs) || value.windowMs < 1 || value.windowMs > 200 || !contract.only(value.goal, ['kind', 'target']) || !['songs', 'fc', 'minutes'].includes(value.goal.kind) || !Number.isInteger(value.goal.target) || value.goal.target < 1 || value.goal.target > (value.goal.kind === 'minutes' ? 1440 : 10000))
    throw Error('Réglages de mesure invalides.'); return clone(value); }
function createTelemetryModel({ now = Date.now, settings = { windowMs: 20, goal: { kind: 'songs', target: 10 } } } = {}) {
    settings = validSettings(settings);
    let status = 'disabled', reason = null, identity = null, capabilities = emptyCaps(), lastSequence = null, lastEventAt = 0, active = null, timing = accumulator(), coverage = 'since-connect';
    let startedAt = now(), completedSongs = 0, fullCombos = 0, bestCombo = 0, history = [], bestScores = new Map(), bestAttempts = new Map(), finished = new Set(), trials = [], trial = null;
    // Native calibration results are private, read-only confirmations of the
    // game's absolute setting. They never derive from gameplay timing means.
    let nativeCalibration = null, nativeResults = { audio: null, video: null }, retiredCalibrations = new Set();
    const nativeKey = data => data.stage + ':' + data.calibrationAttemptId;
    function retireNative() {
        if (nativeCalibration && retiredCalibrations.size < 2000)
            retiredCalibrations.add(nativeCalibration.key);
        nativeCalibration = null;
    }
    function clearNative() { nativeCalibration = null; nativeResults = { audio: null, video: null }; retiredCalibrations = new Set(); }
    function resetAttempt(frame, kind = 'connect') { active = { attemptId: frame.attemptId, playerId: frame.playerId, phase: 'loading', metadata: {}, stats: emptyStats(), clock: null, ended: false, completed: null, comparisonKey: null, comparisonBaseline: null }; timing = accumulator(); coverage = ['song', 'restart'].includes(kind) ? 'complete' : kind === 'seek' ? 'incomplete' : 'since-connect'; if (trial)
        trial.incomplete = true; }
    function applyStats(value) { if (!active || !value)
        return; const next = {...active.stats}; for (const k of Object.keys(value)) {
        const capability = k === 'notesHit' || k === 'notesTotal' ? 'attemptResults' : k;
        if (capabilities[capability])
            next[k] = value[k];
    } if (known(next.notesHit) && known(next.notesTotal) && next.notesHit > next.notesTotal)
        throw Object.assign(Error('Compteurs de notes contradictoires.'), {code:'INVALID_STATS'});
    active.stats = next;
    if (known(active.stats.combo))
        bestCombo = Math.max(bestCombo, active.stats.combo); }
    function applyState(value) { if (!active || !value)
        return; active.phase = value.phase; if (value.metadata) {
        const m = value.metadata;
        active.metadata = { ...(capabilities.songMetadata ? Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'chartId')) : {}), ...(capabilities.songIdentity && m.chartId ? { chartId: m.chartId, ...(m.instrument ? { instrument: m.instrument } : {}), ...(m.difficulty ? { difficulty: m.difficulty } : {}) } : {}) };
        const key = chartKey();
        if (key && active.comparisonKey !== key) {
            active.comparisonKey = key;
            active.comparisonBaseline = bestScores.get(key) ?? null;
        }
    } if (value.stats)
        applyStats(value.stats); if (capabilities.clock && value.clock) {
        if (trial?.source === 'gameplay' && contract.finite(active.clock?.speed, .01, 10)
            && contract.finite(value.clock.speed, .01, 10) && active.clock.speed !== value.clock.speed)
            trial.incomplete = true;
        active.clock = { ...value.clock }; } }
    const chartKey = () => active?.metadata.chartId && active.metadata.instrument && active.metadata.difficulty ? JSON.stringify([active.metadata.chartId, active.metadata.instrument, active.metadata.difficulty]) : null;
    function ingest(raw) {
        const frame = contract.validateFrame(raw);
        if (frame.type === 'hello') {
            if (frame.playerId !== 0)
                throw Error('Le joueur local0 est requis.');
            identity = frame;
            capabilities = frame.data.capabilities;
            lastSequence = frame.sequence;
            status = 'connected';
            reason = null;
            lastEventAt = now();
            clearNative();
            resetAttempt(frame);
            coverage = frame.data.coverage === 'from-attempt-start' ? 'complete' : 'since-connect';
            applyState(frame.data.state);
            return true;
        }
        if (!identity || status !== 'connected' || !contract.sameIdentity(identity, frame))
            throw Object.assign(Error('Identité du connecteur différente.'), { code: 'IDENTITY_CHANGED' });
        if (frame.sequence <= lastSequence)
            return false;
        const gap = frame.sequence !== lastSequence + 1;
        lastSequence = frame.sequence;
        lastEventAt = now();
        if (gap) {
            retireNative();
            timing = accumulator();
            coverage = 'incomplete';
            if (active) { active.stats = emptyStats(); active.clock = null; }
            if (trial)
                trial.incomplete = true;
        }
        if (frame.playerId !== 0)
            return true;
        if (!['heartbeat', 'calibration', 'calibrationResult'].includes(frame.type) && (!active || active.attemptId !== frame.attemptId || active.playerId !== frame.playerId))
            resetAttempt(frame);
        if (frame.type === 'reset') {
            retireNative();
            resetAttempt(frame, frame.data.reason);
            applyState(frame.data.state);
        }
        if (frame.type === 'state')
            applyState(frame.data);
        if (frame.type === 'hit') {
            if (!capabilities.hitTiming)
                throw Error('Mesures de précision non déclarées.');
            if (active.ended)
                return true;
            active.phase = 'playing';
            measure(timing, frame.data.offsetMs);
            applyStats(frame.data.stats);
            if (trial && trial.source === 'gameplay')
                measure(trial.measurements, frame.data.offsetMs);
        }
        if (frame.type === 'calibration') {
            if (!capabilities.calibrationTiming)
                throw Error('Mesures de calibration non déclarées.');
            const key = nativeKey(frame.data);
            if (retiredCalibrations.has(key))
                return true;
            if (nativeCalibration && (nativeCalibration.key !== key || nativeCalibration.attemptId !== frame.attemptId))
                retireNative();
            if (!retiredCalibrations.has(key) && retiredCalibrations.size < 2000) {
                if (!nativeCalibration)
                    nativeCalibration = { key, stage: frame.data.stage, attemptId: frame.attemptId, sampleCount: 0 };
                nativeCalibration.sampleCount++;
            }
            if (trial && trial.source === 'tool' && !trial.incomplete) {
                if (trial.stage !== frame.data.stage || (trial.nativeAttemptId && trial.nativeAttemptId !== frame.data.calibrationAttemptId)) trial.incomplete = true;
                else { trial.nativeAttemptId = frame.data.calibrationAttemptId; measure(trial.measurements, frame.data.offsetMs); }
            }
        }
        if (frame.type === 'calibrationResult') {
            if (!capabilities.calibrationResults || !capabilities.calibrationTiming)
                throw Error('Résultats de calibration non déclarés.');
            const key = nativeKey(frame.data);
            if (retiredCalibrations.has(key))
                return true;
            if (nativeCalibration?.key === key && nativeCalibration.attemptId === frame.attemptId && nativeCalibration.sampleCount > 0 && !retiredCalibrations.has(key)) {
                nativeResults[frame.data.stage] = { settingMs: frame.data.settingMs, sampleCount: nativeCalibration.sampleCount, at: now(), source: 'native-calibration' };
            }
            // A result closes this observed segment even if its identity does
            // not match. A later duplicate cannot reuse old measurements.
            retireNative();
            if (retiredCalibrations.size < 2000)
                retiredCalibrations.add(key);
        }
        if (frame.type === 'attemptEnd') {
            if (!capabilities.attemptResults)
                throw Error('Résultats de partie non déclarés.');
            const key = frame.sessionId + ':' + frame.attemptId + ':' + frame.playerId;
            if (finished.has(key))
                return true;
            // Final counters must be supplied by this result. An old zero or
            // score from a previous hit is not a certified final measurement.
            active.stats = emptyStats();
            applyState(frame.data.state);
            finished.add(key);
            if (finished.size > 2000)
                finished.delete(finished.values().next().value);
            active.ended = true;
            active.completed = frame.data.completed;
            active.phase = 'results';
            const s = active.stats, completed = frame.data.completed && coverage === 'complete', fcKnown = known(s.notesHit) && known(s.notesTotal) && s.notesTotal > 0 && known(s.misses) && known(s.overstrums), fc = fcKnown && coverage === 'complete' ? completed && s.notesHit === s.notesTotal && s.misses === 0 && s.overstrums === 0 : null;
            if (completed) {
                completedSongs++;
                if (fc)
                    fullCombos++;
            }
            const currentKey = chartKey(), previous = currentKey ? bestScores.get(currentKey) : undefined;
            if (completed && currentKey && fcKnown) {
                const candidate = {notesHit:s.notesHit,notesTotal:s.notesTotal,misses:s.misses,overstrums:s.overstrums}, prior = bestAttempts.get(currentKey);
                const fraction = candidate.notesHit / candidate.notesTotal, oldFraction = prior ? prior.notesHit / prior.notesTotal : -1;
                if (!prior || fraction > oldFraction || (fraction === oldFraction && candidate.misses + candidate.overstrums < prior.misses + prior.overstrums)) bestAttempts.set(currentKey,candidate);
                if (bestAttempts.size > 2000) bestAttempts.delete(bestAttempts.keys().next().value);
            }
            if (completed && currentKey && known(s.score) && (previous === undefined || s.score > previous)) {
                bestScores.set(currentKey, s.score);
                if (bestScores.size > 2000)
                    bestScores.delete(bestScores.keys().next().value);
            }
            history.unshift({ title: active.metadata.title || null, artist: active.metadata.artist || null, score: s.score, fullCombo: fc, completed, coverage, meanAbsoluteOffsetMs: timing.count ? timing.absoluteMean : null, sampleCount: timing.count, at: now() });
            history = history.slice(0, contract.MAX_HISTORY);
        }
        return true;
    }
    function snapshot() {
        const key = chartKey(), best = active?.comparisonBaseline, s = active?.stats || emptyStats(), personalBest = key ? bestScores.get(key) : null;
        const elapsed = Math.max(0, Math.min(86400000, now() - startedAt)), progress = settings.goal.kind === 'songs' ? completedSongs : settings.goal.kind === 'fc' ? fullCombos : elapsed / 60000;
        const connected = status === 'connected';
        return {
            status, reason, connected, gameVersion:identity?.game.version || null, capabilities:{...capabilities},
            phase:connected ? active?.phase || 'idle' : 'idle',
            active:connected && active ? {metadata:clone(active.metadata),stats:{...s},clock:active.clock ? {...active.clock}:null,ended:active.ended,completed:active.completed,coverage}:null,
            timing:metrics(timing,settings.windowMs,coverage),
            comparison:{bestScore:known(best)?best:null,personalBestScore:known(personalBest)?personalBest:null,currentScore:s.score,delta:coverage==='complete'&&known(best)&&known(s.score)?s.score-best:null,bestAttempt:key&&bestAttempts.has(key)?clone(bestAttempts.get(key)):null},
            session:{completedSongs,fullCombos,bestCombo,durationSeconds:elapsed/1000},goal:{...settings.goal,value:progress,percent:Math.min(100,progress/settings.goal.target*100)},history:clone(history),
            calibration:{trial:trial?{stage:trial.stage,source:trial.source,settingMs:trial.settingMs,incomplete:trial.incomplete,...metrics(trial.measurements,settings.windowMs,trial.incomplete?'incomplete':'complete')}:null,trials:clone(trials),nativeResults:connected && capabilities.calibrationResults ? clone(nativeResults) : {audio:null,video:null}},
            settings:clone(settings),lastEventAgeMs:lastEventAt?Math.max(0,now()-lastEventAt):null
        };
    }
    function connection(next, code = null) { if (!['disabled', 'waiting', 'connecting', 'connected', 'unsupported', 'stale', 'error'].includes(next))
        throw Error('État du connecteur invalide.'); status = next; reason = code; if (next !== 'connected') {
        active = null;
        timing = accumulator();
        clearNative();
        if (trial)
            trial.incomplete = true;
    } return snapshot(); }
    function configure(value) { settings = validSettings(value); return snapshot(); }
    function startCalibration(stage, settingMs, source = 'gameplay') { if (!['audio', 'video'].includes(stage) || !['gameplay', 'tool'].includes(source) || !contract.finite(settingMs, -1000, 1000))
        throw Error('Essai de calibration invalide.'); if (status !== 'connected' || !(source === 'gameplay' ? capabilities.hitTiming : capabilities.calibrationTiming))
        throw Error('Connectez les mesures réelles avant de démarrer un essai.'); trial = { stage, source, settingMs, measurements: accumulator(), incomplete: false, startedAt: now() }; return snapshot(); }
    function finishCalibration() { if (!trial)
        throw Error('Aucun essai en cours.'); if (trial.incomplete || trial.measurements.count < 30)
        throw Error('Mesurez au moins30 jugements continus pour comparer cet essai.'); const result = { stage: trial.stage, source: trial.source, settingMs: trial.settingMs, at: now(), ...metrics(trial.measurements, settings.windowMs, 'complete') }; trials.unshift(result); trials = trials.slice(0, 6); trial = null; return snapshot(); }
    function resetSession() { startedAt = now(); completedSongs = 0; fullCombos = 0; bestCombo = active?.stats.combo || 0; history = []; bestAttempts.clear(); return snapshot(); }
    function exportRecords() { return { version: 1, bestScores: [...bestScores].slice(-2000) }; }
    function importRecords(value) { if (!contract.only(value, ['version', 'bestScores']) || value.version !== 1 || !Array.isArray(value.bestScores) || value.bestScores.length > 2000)
        throw Error('Historique local invalide.'); const next = new Map(); for (const row of value.bestScores) {
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || row[0].length > 512 || !contract.integer(row[1], 0, 1e12) || next.has(row[0]))
            throw Error('Record local invalide.');
        let parts;
        try {
            parts = JSON.parse(row[0]);
        }
        catch {
            throw Error('Identité du record invalide.');
        }
        if (!Array.isArray(parts) || parts.length !== 3 || typeof parts[0] !== 'string' || !/^[a-f0-9]{32,64}$/.test(parts[0]) || parts.slice(1).some(p => !contract.safeText(p) || !p || p.length > 64))
            throw Error('Identité du record invalide.');
        next.set(row[0], row[1]);
    } bestScores = next; }
    return { ingest, snapshot, connection, configure, startCalibration, finishCalibration, resetSession, exportRecords, importRecords };
}
module.exports = { createTelemetryModel, validSettings };
