'use strict';

// Shared display state only. Controller selection, device reading, windows and
// OBS transport belong to their existing owners, never to this broker.
const copy = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function displayConfig(config) {
  if (!config) return null;
  const trails = {};
  for (const key of ['style','enabled','durationMs','intensity','length','speedPxPerSecond','thickness','direction','fade']) trails[key] = config.trails[key];
  return {
    width: config.width, height: config.height, background: config.background,
    bloom: config.bloom, showNames: config.showNames, showCounts: config.showCounts === true, renderStyle: config.renderStyle, trails,
    controls: config.controls.map(control => ({
      id: control.id, label: control.label, color: control.color,
      x: control.x, y: control.y, width: control.width, height: control.height,
      shape: control.shape, visible: control.visible, fontSize: control.fontSize,
      trailDirection: control.trailDirection,
      palette: { idle: control.palette.idle, trail: control.palette.trail, label: control.palette.label }
    }))
  };
}

/** Re-project an already validated broker snapshot at a transport boundary.
 * Input configuration validation still belongs exclusively to the injected
 * product model; this whitelist prevents added internal fields leaking out. */
function projectOutputSnapshot(value) {
  try {
    if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !['running','stopped'].includes(value.phase)) return null;
    const config = displayConfig(value.config);
    const pressed = Object.fromEntries((config?.controls || []).filter(control => control.visible).map(control =>
      [control.id, value.phase === 'running' && object(value.pressed) && Object.hasOwn(value.pressed, control.id) && value.pressed[control.id] === true]));
    const counts = Object.fromEntries((config?.controls || []).filter(control => control.visible).map(control =>
      [control.id, object(value.counts) && Object.hasOwn(value.counts, control.id) && Number.isSafeInteger(value.counts[control.id]) && value.counts[control.id] >= 0 ? value.counts[control.id] : 0]));
    return freeze(copy({ version: 1, revision: value.revision, phase: value.phase, config, pressed, counts }));
  } catch { return null; }
}

function createInputViewerOutputState({ validateConfig, sampleControls, now = Date.now } = {}) {
  if (typeof validateConfig !== 'function' || typeof sampleControls !== 'function' || typeof now !== 'function') throw TypeError('Viewer model and clock required');
  let config = null, canonicalBytes = null, pressed = {}, running = false, revision = 0, lastInputAt = null, armed = {};
  // Session totals never enter settings, profiles or device payloads. A held
  // input after selection/reconnection must first be released before counting.
  const totals = new Map(), completions = new Set();
  const keyFor = id => config.mode + ':' + id;
  const counts = () => Object.fromEntries((config?.controls || []).filter(control => control.visible).map(control => [control.id, totals.get(keyFor(control.id)) ?? 0]));

  const emptyPressed = () => Object.fromEntries((config?.controls || []).filter(control => control.visible).map(control => [control.id, false]));
  function replacePressed(next) {
    if (JSON.stringify(next) !== JSON.stringify(pressed)) { pressed = next; revision++; }
  }
  function clear() { lastInputAt = null; armed = {}; replacePressed(emptyPressed()); }
  function expire() {
    if (lastInputAt === null) return;
    const current = now(), elapsed = current - lastInputAt;
    // A stalled renderer, disconnected source or clock rollback must never
    // leave an old held button glowing forever in a separate output window.
    if (!Number.isFinite(current) || elapsed < 0 || elapsed > 500) clear();
  }
  function snapshot() {
    expire();
    return projectOutputSnapshot({ version: 1, revision, phase: running ? 'running' : 'stopped', config, pressed, counts: counts() });
  }
  function configure(rawConfig) {
    // The injected product validator is the single authoritative config schema.
    // Both copies protect the caller and the broker even if a validator returns
    // its argument or mutates it while normalizing an older version.
    const next = copy(validateConfig(copy(rawConfig))), bytes = JSON.stringify(next);
    if (bytes.length > 16384) throw TypeError('Viewer configuration too large');
    if (bytes !== canonicalBytes) {
      config = next; canonicalBytes = bytes; lastInputAt = null; armed = {}; pressed = emptyPressed(); revision++;
    }
    return snapshot();
  }
  function setRunning(value) {
    if (typeof value !== 'boolean') throw TypeError('Running state must be boolean');
    if (running !== value) { running = value; revision++; }
    if (!running) clear();
    return snapshot();
  }
  function updatePressed(map) {
    if (!running || !config) return false;
    try {
      const ids = new Set(config.controls.map(control => control.id));
      if (!object(map) || Object.keys(map).length > ids.size || Object.entries(map).some(([id, value]) => !ids.has(id) || typeof value !== 'boolean')) {
        clear(); return false;
      }
      const current = now(); if (!Number.isFinite(current)) { clear(); return false; }
      expire();
      const next = Object.fromEntries(config.controls.filter(control => control.visible).map(control => [control.id, Object.hasOwn(map, control.id) && map[control.id] === true]));
      for (const [id, down] of Object.entries(next)) {
        if (!down) armed[id] = true;
        else if (armed[id] === true && pressed[id] !== true) {
          const key = keyFor(id), previous = totals.get(key) ?? 0;
          if (previous < Number.MAX_SAFE_INTEGER) { totals.set(key, previous + 1); revision++; }
        }
      }
      lastInputAt = current; replacePressed(next); return true;
    } catch { clear(); return false; }
  }
  function updateGamepad(sample) {
    if (!running || !config) return false;
    if (!object(sample) || sample.connected !== true) { clear(); return false; }
    try { return updatePressed(sampleControls(config, { gamepad: sample })); }
    catch { clear(); return false; }
  }

  function resetCounts() { totals.clear(); revision++; return snapshot(); }
  function confirmChartEnd(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(id) || completions.has(id)) return false;
    completions.add(id);
    // Bounded deduplication. Replays from an earlier connection must not be
    // accepted by the caller; this broker never observes menus or empty files.
    if (completions.size > 256) completions.delete(completions.values().next().value);
    if (config?.autoResetOnChartEnd !== true) return false;
    resetCounts(); return true;
  }

  return { configure, setRunning, clear, updateGamepad, updatePressed, resetCounts, confirmChartEnd, snapshot, getSource: () => config?.source ?? null, getMode: () => config?.mode ?? null, getAutoShowOnChartStart: () => config?.autoShowOnChartStart === true, getAutoResetOnChartEnd: () => config?.autoResetOnChartEnd === true };
}

module.exports = { createInputViewerOutputState, projectOutputSnapshot };
