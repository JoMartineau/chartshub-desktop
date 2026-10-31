'use strict';
// Read-only game telemetry. Credentials and connection descriptors never cross
// the Companion/OBS projection. Unknown protocols and fields fail closed.
const SCHEMA = 'chartshub.clonehero.telemetry.v1', DESCRIPTOR_SCHEMA = 'chartshub.clonehero.connection.v1';
const MAX_FRAME_BYTES = 65536, MAX_HISTORY = 5;
const CAPABILITIES = ['hitTiming', 'combo', 'clock', 'score', 'misses', 'overstrums', 'attemptResults', 'songIdentity', 'songMetadata', 'calibrationTiming', 'calibrationResults'];
const TYPES = ['hello', 'hit', 'reset', 'state', 'attemptEnd', 'heartbeat', 'calibration', 'calibrationResult'];
const PHASES = ['idle', 'menu', 'loading', 'playing', 'paused', 'results'];
const record = v => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v, keys) => record(v) && Object.keys(v).every(k => keys.includes(k));
const id = v => typeof v === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(v);
const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const integer = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
const safeText = v => typeof v === 'string' && !/[\u0000-\u001f\u007f]/.test(v) && v.length <= 512;
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const fail = code => Object.assign(Error(code), { code });
function game(value) { if (!only(value, ['version', 'gameAssemblySha256', 'metadataSha256', 'runtimeBackend']) || !id(value.version) || !hash(value.gameAssemblySha256) || !hash(value.metadataSha256) || value.runtimeBackend !== 'il2cpp')
    throw fail('UNSUPPORTED_GAME'); return { version: value.version, gameAssemblySha256: value.gameAssemblySha256, metadataSha256: value.metadataSha256, runtimeBackend: value.runtimeBackend }; }
function provider(value) { if (!only(value, ['id', 'version']) || value.id !== 'chartshub.clonehero.il2cpp' || !id(value.version))
    throw fail('UNSUPPORTED_PROVIDER'); return { ...value }; }
function capabilities(value) { if (!only(value, CAPABILITIES) || Object.values(value).some(v => typeof v !== 'boolean'))
    throw fail('INVALID_CAPABILITIES'); return Object.fromEntries(CAPABILITIES.map(k => [k, value[k] === true])); }
function validateDescriptor(value) {
    if (!only(value, ['schema', 'provider', 'game', 'pipeName', 'nonce', 'sessionId', 'pid']) || value.schema !== DESCRIPTOR_SCHEMA || typeof value.pipeName !== 'string' || !/^ChartsHub\.CloneHero\.Telemetry\.[a-f0-9-]{36}$/.test(value.pipeName) || !hash(value.nonce) || !id(value.sessionId) || !integer(value.pid, 1, 2147483647))
        throw fail('INVALID_DESCRIPTOR');
    return { schema: DESCRIPTOR_SCHEMA, provider: provider(value.provider), game: game(value.game), pipeName: value.pipeName, nonce: value.nonce, sessionId: value.sessionId, pid: value.pid };
}
function metadata(value) {
    if (!only(value, ['chartId', 'title', 'artist', 'charter', 'instrument', 'difficulty']))
        throw fail('INVALID_METADATA');
    const clean = {};
    for (const k of ['title', 'artist', 'charter', 'instrument', 'difficulty'])
        if (value[k] !== undefined) {
            if (!safeText(value[k]) || (['instrument', 'difficulty'].includes(k) && value[k].length > 64))
                throw fail('INVALID_METADATA');
            clean[k] = value[k];
        }
    if (value.chartId !== undefined) {
        if (typeof value.chartId !== 'string' || !/^[a-f0-9]{32,64}$/.test(value.chartId))
            throw fail('INVALID_METADATA');
        clean.chartId = value.chartId;
    }
    return clean;
}
function stats(value) { if (!only(value, ['score', 'combo', 'misses', 'overstrums', 'notesHit', 'notesTotal']))
    throw fail('INVALID_STATS'); const clean = {}; for (const k of Object.keys(value)) {
    if (!integer(value[k], 0, k === 'score' ? 1e12 : 1e7))
        throw fail('INVALID_STATS');
    clean[k] = value[k];
} if (clean.notesHit !== undefined && clean.notesTotal !== undefined && clean.notesHit > clean.notesTotal)
    throw fail('INVALID_STATS'); return clean; }
function clock(value) { if (!only(value, ['positionSeconds', 'durationSeconds', 'speed']) || !finite(value.positionSeconds, -60, 86400) || !finite(value.durationSeconds, 0, 86400) || value.positionSeconds > value.durationSeconds + 5 || (value.speed !== undefined && !finite(value.speed, .01, 10)))
    throw fail('INVALID_CLOCK'); return { ...value }; }
function stateData(value) { if (!only(value, ['phase', 'metadata', 'stats', 'clock']) || !PHASES.includes(value.phase))
    throw fail('INVALID_STATE'); return { phase: value.phase, ...(value.metadata === undefined ? {} : { metadata: metadata(value.metadata) }), ...(value.stats === undefined ? {} : { stats: stats(value.stats) }), ...(value.clock === undefined ? {} : { clock: clock(value.clock) }) }; }
function validateFrame(value) {
    if (!only(value, ['schema', 'provider', 'game', 'sessionId', 'attemptId', 'playerId', 'sequence', 'type', 'data']) || value.schema !== SCHEMA || !TYPES.includes(value.type) || !id(value.sessionId) || !id(value.attemptId) || !integer(value.playerId, 0, 7) || !integer(value.sequence) || !record(value.data))
        throw fail('INVALID_FRAME');
    const result = { schema: SCHEMA, provider: provider(value.provider), game: game(value.game), sessionId: value.sessionId, attemptId: value.attemptId, playerId: value.playerId, sequence: value.sequence, type: value.type, data: null };
    const d = value.data;
    if (value.type === 'hello') {
        if (!only(d, ['capabilities', 'coverage', 'state']) || !['from-attempt-start', 'since-connect'].includes(d.coverage))
            throw fail('INVALID_HELLO');
        result.data = { capabilities: capabilities(d.capabilities), coverage: d.coverage, ...(d.state === undefined ? {} : { state: stateData(d.state) }) };
    }
    if (value.type === 'hit') {
        if (!only(d, ['offsetMs', 'stats']) || !finite(d.offsetMs, -10000, 10000))
            throw fail('INVALID_HIT');
        result.data = { offsetMs: d.offsetMs, ...(d.stats === undefined ? {} : { stats: stats(d.stats) }) };
    }
    if (value.type === 'reset') {
        if (!only(d, ['reason', 'state']) || !['song', 'restart', 'seek', 'player', 'connect'].includes(d.reason))
            throw fail('INVALID_RESET');
        result.data = { reason: d.reason, ...(d.state === undefined ? {} : { state: stateData(d.state) }) };
    }
    if (value.type === 'state')
        result.data = stateData(d);
    if (value.type === 'attemptEnd') {
        if (!only(d, ['completed', 'state']) || typeof d.completed !== 'boolean')
            throw fail('INVALID_END');
        result.data = { completed: d.completed, ...(d.state === undefined ? {} : { state: stateData(d.state) }) };
    }
    if (value.type === 'heartbeat') {
        if (Object.keys(d).length)
            throw fail('INVALID_HEARTBEAT');
        result.data = {};
    }
    if (value.type === 'calibration') {
        if (!only(d, ['stage', 'offsetMs', 'calibrationAttemptId']) || !['audio', 'video'].includes(d.stage) || !finite(d.offsetMs, -10000, 10000) || !id(d.calibrationAttemptId))
            throw fail('INVALID_CALIBRATION');
        result.data = { stage: d.stage, offsetMs: d.offsetMs, calibrationAttemptId: d.calibrationAttemptId };
    }
    if (value.type === 'calibrationResult') {
        if (!only(d, ['stage', 'settingMs', 'calibrationAttemptId']) || !['audio', 'video'].includes(d.stage) || !integer(d.settingMs, -2000, 2000) || !id(d.calibrationAttemptId))
            throw fail('INVALID_CALIBRATION_RESULT');
        result.data = { stage: d.stage, settingMs: d.settingMs, calibrationAttemptId: d.calibrationAttemptId };
    }
    return result;
}
function sameIdentity(a, b) { return a.sessionId === b.sessionId && a.provider.id === b.provider.id && a.provider.version === b.provider.version && ['version', 'gameAssemblySha256', 'metadataSha256', 'runtimeBackend'].every(key => a.game[key] === b.game[key]); }
function supportedGame(value, builds) { return Array.isArray(builds) && builds.some(b => b.version === value.version && b.gameAssemblySha256 === value.gameAssemblySha256 && b.metadataSha256 === value.metadataSha256 && b.runtimeBackend === value.runtimeBackend); }
module.exports = { SCHEMA, DESCRIPTOR_SCHEMA, MAX_FRAME_BYTES, MAX_HISTORY, CAPABILITIES, TYPES, PHASES, record, only, id, finite, integer, safeText, validateDescriptor, validateFrame, sameIdentity, supportedGame };
