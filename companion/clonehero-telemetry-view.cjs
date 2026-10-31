'use strict';
const { CAPABILITIES, PHASES } = require('./clonehero-telemetry-contract.cjs');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
const text = value => typeof value === 'string' && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
function timing(value) {
    const v = object(value) ? value : {};
    return {
        lastOffsetMs: number(v.lastOffsetMs, -10000, 10000), meanOffsetMs: number(v.meanOffsetMs, -10000, 10000),
        meanAbsoluteOffsetMs: number(v.meanAbsoluteOffsetMs, 0, 10000), standardDeviationMs: number(v.standardDeviationMs, 0, 10000),
        withinWindowPercent: number(v.withinWindowPercent, 0, 100), windowMs: number(v.windowMs, 1, 200) ?? 20,
        sampleCount: number(v.sampleCount, 0, Number.MAX_SAFE_INTEGER) ?? 0,
        coverage: ['complete', 'since-connect', 'incomplete'].includes(v.coverage) ? v.coverage : 'incomplete'
    };
}
/** OBS receives measurements only. Provider identifiers, paths and calibration drafts stay in main. */
function publicTelemetrySnapshot(value, language = 'fr') {
    if (!object(value))
        return null;
    const capabilities = Object.fromEntries(CAPABILITIES.map(key => [key, value.capabilities?.[key] === true]));
    const connected = value.connected === true && value.status === 'connected';
    let active = null;
    if (connected && object(value.active)) {
        const source = value.active, metadata = {};
        for (const key of ['title', 'artist', 'charter', 'instrument', 'difficulty']) {
            const clean = text(source.metadata?.[key]);
            if (clean)
                metadata[key] = clean;
        }
        const stats = {};
        for (const key of ['score', 'combo', 'misses', 'overstrums', 'notesHit', 'notesTotal']) {
            const capability = ['notesHit', 'notesTotal'].includes(key) ? 'attemptResults' : key;
            stats[key] = capabilities[capability] ? number(source.stats?.[key], 0, key === 'score' ? 1e12 : 1e7) : null;
        }
        const clock = source.clock;
        active = { metadata, stats, ended: source.ended === true, completed: typeof source.completed === 'boolean' ? source.completed : null,
            coverage: ['complete','since-connect','incomplete'].includes(source.coverage) ? source.coverage : 'incomplete', clock: capabilities.clock && object(clock)
                && number(clock.positionSeconds, -60, 86400) !== null && number(clock.durationSeconds, 0, 86400) !== null
                ? { positionSeconds: clock.positionSeconds, durationSeconds: clock.durationSeconds,
                    ...(number(clock.speed, .01, 10) !== null ? { speed: clock.speed } : {}) } : null };
    }
    const comparison = {}, session = {};
    for (const key of ['bestScore', 'personalBestScore', 'currentScore'])
        comparison[key] = number(value.comparison?.[key], 0, 1e12);
    comparison.delta = number(value.comparison?.delta, -1e12, 1e12);
    const bestAttempt = value.comparison?.bestAttempt;
    comparison.bestAttempt = object(bestAttempt) && ['notesHit','notesTotal','misses','overstrums'].every(key => number(bestAttempt[key],0,1e7) !== null)
        ? Object.fromEntries(['notesHit','notesTotal','misses','overstrums'].map(key=>[key,bestAttempt[key]])) : null;
    for (const key of ['completedSongs', 'fullCombos', 'bestCombo', 'durationSeconds'])
        session[key] = number(value.session?.[key], 0, 1e12) ?? 0;
    const goal = value.goal;
    return {
        connected, status: ['disabled', 'waiting', 'connecting', 'connected', 'unsupported', 'stale', 'error'].includes(value.status) ? value.status : 'error',
        language: language === 'en' ? 'en' : 'fr', gameVersion: text(value.gameVersion), capabilities,
        phase: connected && PHASES.includes(value.phase) ? value.phase : 'idle', active,
        hasChartIdentity: !!(active && capabilities.songIdentity && (value.hasChartIdentity === true || (value.active.metadata?.chartId && value.active.metadata?.instrument && value.active.metadata?.difficulty))),
        timing: timing(connected && capabilities.hitTiming ? value.timing : null), comparison, session,
        goal: { kind: ['songs', 'fc', 'minutes'].includes(goal?.kind) ? goal.kind : 'songs', target: number(goal?.target, 1, 10000) ?? 10,
            value: number(goal?.value, 0, 1e12) ?? 0, percent: number(goal?.percent, 0, 100) ?? 0 },
        history: (Array.isArray(value.history) ? value.history : []).slice(0, 5).filter(object).map(item => ({
            title: text(item.title), artist: text(item.artist), score: number(item.score, 0, 1e12), fullCombo: item.coverage === 'complete' && typeof item.completed === 'boolean' ? item.completed && typeof item.fullCombo === 'boolean' ? item.fullCombo : item.completed === false ? false : null : null,
            completed: item.completed === true && item.coverage === 'complete', coverage: ['complete','since-connect','incomplete'].includes(item.coverage) ? item.coverage : 'incomplete', meanAbsoluteOffsetMs: number(item.meanAbsoluteOffsetMs, 0, 10000), sampleCount: number(item.sampleCount, 0, Number.MAX_SAFE_INTEGER) ?? 0,
            at: number(item.at, 0, Number.MAX_SAFE_INTEGER) ?? 0
        }))
    };
}
/** Real telemetry supplies real phase; demonstration song names never label a live attempt. */
function telemetryStateView(base, telemetry, { language = 'fr', liveMetadata = false } = {}) {
    const performance = publicTelemetrySnapshot(telemetry, language);
    if (!performance)
        return base;
    if (!performance.connected)
        return { ...base, performance };
    const phase = performance.phase, active = phase === 'playing' || phase === 'paused';
    const metadata = performance.active?.metadata;
    const nowPlaying = active ? metadata?.title ? { ...metadata } : liveMetadata ? base.nowPlaying : null : null;
    return { ...base, performance, gameplay: { ...base.gameplay, state: phase, isChartActive: active }, nowPlaying };
}
module.exports = { publicTelemetrySnapshot, telemetryStateView };
