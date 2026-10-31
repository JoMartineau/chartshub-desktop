'use strict';
const { execFile: nativeExecFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MAX_BUFFER = 16 * 1024, TIMEOUT_MS = 10000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const name = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value);
const friendly = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/(?:USB|HID|BTHENUM|BTHLEDEVICE|SWD|PCI|ROOT)\\\S+/gi, '').replace(/\b(?:VID|PID|REV|MI)_[0-9a-f]+\b/gi, '').replace(/\b(?:serial|s\/n|sn)\s*[:=#]?\s*[a-z0-9-]+\b/gi, '').replace(/\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?/gi, '').replace(/\b[0-9a-f]{12,}\b/gi, '').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
const contextName = value => name(value) && friendly(value) === value.trim() && !/(?:^|\s)(?:[a-z]:[\\/]|\\\\|\/[^\s/]+\/|file:\/\/)/i.test(value);
const optional = (value, min, max) => value === null || finite(value, min, max);
const unavailable = () => ({ audio: { status: 'unavailable', outputName: null, sampleRateHz: null, channels: null, defaultPeriodMs: null, minimumPeriodMs: null }, outputs: [], inputs: [] });
const copy = value => JSON.parse(JSON.stringify(value));

function parseProbe(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > MAX_BUFFER) return unavailable();
  let value;
  try { value = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()); } catch { return unavailable(); }
  if (!only(value, ['audio', 'outputs', 'inputs']) || !Array.isArray(value.inputs) || value.inputs.length > 32 ||
      (value.outputs !== undefined && (!Array.isArray(value.outputs) || value.outputs.length > 16 || value.outputs.some(entry => !only(entry, ['name', 'kind', 'windowsDefault']) || !name(entry.name) || entry.kind !== 'candidate' || typeof entry.windowsDefault !== 'boolean'))) ||
      !only(value.audio, ['status', 'outputName', 'sampleRateHz', 'channels', 'defaultPeriodMs', 'minimumPeriodMs'])) return unavailable();
  const a = value.audio;
  if (!['available', 'unavailable'].includes(a.status) || !(a.outputName === null || name(a.outputName)) ||
      !optional(a.sampleRateHz, 8000, 768000) || !optional(a.channels, 1, 64) ||
      !optional(a.defaultPeriodMs, 0.01, 1000) || !optional(a.minimumPeriodMs, 0.01, 1000) ||
      (a.channels !== null && !Number.isSafeInteger(a.channels)) || (a.sampleRateHz !== null && !Number.isSafeInteger(a.sampleRateHz)) ||
      value.inputs.some(entry => !only(entry, ['name', 'kind', 'category']) || !name(entry.name) || entry.kind !== 'candidate' || (entry.category !== undefined && !['input', 'usb-device', 'usb-bus', 'hid'].includes(entry.category)))) return unavailable();
  const outputName = friendly(a.outputName) || null, outputs = new Map();
  for (const entry of value.outputs || []) { const label = friendly(entry.name); if (label) outputs.set(label, { name: label, kind: 'candidate', windowsDefault: entry.windowsDefault || outputs.get(label)?.windowsDefault === true }); }
  if (outputName && !outputs.has(outputName) && outputs.size < 16) outputs.set(outputName, { name: outputName, kind: 'candidate', windowsDefault: true });
  return { audio: { ...a, outputName }, outputs: [...outputs.values()], inputs: value.inputs.map(entry => ({ name: friendly(entry.name), kind: 'candidate', ...(entry.category ? { category: entry.category } : {}) })).filter(entry => entry.name) };
}

function frameIntervalMs(frequency) { return finite(frequency, 1, 1000) ? 1000 / frequency : null; }
function readDisplays(screen, bounds, keys = new Map()) {
  try {
    const current = bounds ? screen.getDisplayMatching(bounds)?.id : null;
    return screen.getAllDisplays().slice(0, 16).flatMap((display, index) => {
      const scale = finite(display.scaleFactor, 0.25, 8) ? display.scaleFactor : 1;
      const widthPx = Math.round(display.size?.width * scale), heightPx = Math.round(display.size?.height * scale);
      if (!finite(widthPx, 1, 32768) || !finite(heightPx, 1, 32768)) return [];
      const refreshHz = frameIntervalMs(display.displayFrequency) === null ? null : display.displayFrequency;
      const identity = Number.isSafeInteger(display.id) ? display.id : 'position-' + index;
      if (!keys.has(identity) && keys.size >= 128) return [];
      if (!keys.has(identity)) keys.set(identity, 'display-' + keys.size);
      return [{ key: keys.get(identity), label: friendly(display.label) || 'Display ' + (index + 1), widthPx, heightPx, refreshHz, frameIntervalMs: frameIntervalMs(refreshHz), appDisplay: display.id === current }];
    });
  } catch { return []; }
}

// This is an explicitly confirmed description, not a claim that Windows found the game's route.
function validHardwareContext(value) {
  return only(value, ['version', 'audioOutput', 'input', 'display', 'note']) && Object.keys(value).length === 5 && value.version === 1 &&
    contextName(value.audioOutput) && contextName(value.input) && (value.note === '' || contextName(value.note)) &&
    (value.display === null || (only(value.display, ['key', 'label', 'widthPx', 'heightPx', 'refreshHz']) && Object.keys(value.display).length === 5 && /^display-\d{1,4}$/.test(value.display.key) && contextName(value.display.label) &&
      Number.isSafeInteger(value.display.widthPx) && finite(value.display.widthPx, 1, 32768) && Number.isSafeInteger(value.display.heightPx) && finite(value.display.heightPx, 1, 32768) && optional(value.display.refreshHz, 1, 1000)));
}

function createCalibrationHardware({ platform = process.platform, execFile = nativeExecFile, screen, bounds = () => null, now = Date.now, timeoutMs = TIMEOUT_MS, onChange = () => {} } = {}) {
  let value = { status: 'idle', checkedAt: null, ...unavailable(), displays: [] }, pending = null;
  const displayKeys = new Map(); // Session-local aliases; OS display identifiers never leave this map.
  function publish() { try { onChange(); } catch { /* Diagnostic publication must not affect telemetry. */ } }
  async function probe() {
    if (platform !== 'win32') return unavailable();
    let script;
    try { script = fs.readFileSync(path.join(__dirname, 'calibration-hardware-windows.ps1'), 'utf8'); } catch { return unavailable(); }
    const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return new Promise(resolve => {
      let settled = false;
      const finish = result => { if (!settled) { settled = true; clearTimeout(alarm); resolve(result); } };
      const alarm = setTimeout(() => finish(unavailable()), timeoutMs + 200);
      try {
        // Only our bundled, fixed script is encoded. No renderer value enters a command or argument.
        execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
          { windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (error, stdout) => finish(error ? unavailable() : parseProbe(stdout)));
      } catch { finish(unavailable()); }
    });
  }
  async function refresh() {
    if (!pending) {
      value = { ...value, status: 'checking' }; publish();
      pending = (async () => {
        let currentBounds = null;
        try { currentBounds = bounds(); } catch { /* Window may have closed during the request. */ }
        const displays = readDisplays(screen, currentBounds, displayKeys);
        const found = await probe();
        value = { status: 'ready', checkedAt: now(), ...found, displays };
        publish(); return copy(value);
      })().finally(() => { pending = null; });
    }
    return pending;
  }
  return { snapshot: () => copy(value), refresh };
}

module.exports = { createCalibrationHardware, parseProbe, readDisplays, frameIntervalMs, validHardwareContext };
