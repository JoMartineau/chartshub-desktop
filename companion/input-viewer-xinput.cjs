'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn: nativeSpawn } = require('node:child_process');

const MAX_LINE_BYTES = 4096;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const slotName = subtype => ({ 6: 'Guitar', 7: 'Guitar', 8: 'Drums', 11: 'Bass guitar' })[subtype] || 'Controller';

function parseDevices(value) {
  if (!Array.isArray(value) || value.length > 4) return null;
  const slots = new Set();
  const result = [];
  for (const entry of value) {
    if (!exact(entry, ['slot', 'type', 'subtype', 'flags']) || !integer(entry.slot, 0, 3) ||
        !integer(entry.type, 0, 255) || !integer(entry.subtype, 0, 255) || !integer(entry.flags, 0, 65535) || slots.has(entry.slot)) return null;
    slots.add(entry.slot);
    result.push({ index: entry.slot, id: 'xinput:' + entry.slot, name: slotName(entry.subtype) + ' · XInput ' + (entry.slot + 1),
      type: entry.type, subtype: entry.subtype, mapping: 'standard', buttonCount: 17, axisCount: 4 });
  }
  return result;
}

/** XInput is normalized to the browser's standard layout, not a guessed fret
 * assignment. The user still explicitly maps the visible guitar/drum controls. */
function normalizeSample(value, device) {
  if (!device || !exact(value, ['event', 'selection', 'slot', 'packet', 'buttons', 'leftTrigger', 'rightTrigger', 'leftX', 'leftY', 'rightX', 'rightY']) ||
      value.event !== 'sample' || !integer(value.selection, 1, 2147483647) || value.slot !== device.index ||
      !integer(value.packet, 0, 4294967295) || !integer(value.buttons, 0, 65535) ||
      !integer(value.leftTrigger, 0, 255) || !integer(value.rightTrigger, 0, 255) ||
      ['leftX', 'leftY', 'rightX', 'rightY'].some(key => !integer(value[key], -32768, 32767))) return null;
  const button = mask => ({ pressed: (value.buttons & mask) !== 0, touched: (value.buttons & mask) !== 0, value: (value.buttons & mask) !== 0 ? 1 : 0 });
  const trigger = byte => ({ pressed: byte >= 128, touched: byte > 0, value: byte / 255 });
  const axis = number => number < 0 ? number / 32768 : number / 32767;
  return { index: device.index, id: device.id, connected: true, mapping: 'standard', timestamp: value.packet, selection: value.selection,
    buttons: [button(0x1000), button(0x2000), button(0x4000), button(0x8000), button(0x0100), button(0x0200),
      trigger(value.leftTrigger), trigger(value.rightTrigger), button(0x0020), button(0x0010), button(0x0040), button(0x0080),
      button(0x0001), button(0x0002), button(0x0004), button(0x0008), { pressed: false, touched: false, value: 0 }],
    axes: [axis(value.leftX), -axis(value.leftY), axis(value.rightX), -axis(value.rightY)] };
}

function createXInputSource({ onDevices = () => {}, onSample = () => {}, onDisconnect = () => {}, onError = () => {}, spawn = nativeSpawn, platform = process.platform } = {}) {
  let current = null, disposed = false;
  const publish = (callback, value) => { try { callback(value); } catch { /* A closed viewer cannot keep input polling alive. */ } };
  const clear = () => { publish(onSample, null); publish(onDevices, []); };

  function stopRun(run, error) {
    if (current !== run) return;
    current = null;
    clearInterval(run.heartbeat);
    clearTimeout(run.startup);
    run.selected = null;
    run.buffer = '';
    // stdin EOF is also a child-side shutdown signal. Kill is a bounded fallback
    // for a stalled PowerShell/compiler, never a process-name-wide termination.
    try { run.child.stdin.end('{"command":"stop"}\n'); } catch { /* Already closed. */ }
    const killTimer = setTimeout(() => { try { run.child.kill(); } catch { /* Already closed. */ } }, 250);
    killTimer.unref?.();
    run.child.once('close', () => clearTimeout(killTimer));
    clear();
    if (error) publish(onError, error);
  }

  function send(run, message) {
    if (current !== run) return false;
    try {
      if (run.child.stdin.destroyed || run.child.stdin.writableEnded) throw Error();
      // Commands are bounded objects created here. No renderer string becomes
      // executable PowerShell or a command-line argument.
      if (!run.child.stdin.write(JSON.stringify(message) + '\n')) {
        stopRun(run, 'XINPUT_TRANSPORT_BLOCKED');
        return false;
      }
      return true;
    } catch { stopRun(run, 'XINPUT_TRANSPORT_CLOSED'); return false; }
  }

  function revokeSelection(run, index, selection) {
    if (current !== run || run.selected !== index || run.selection !== selection) return;
    // Publish the lost lease even before the first sample. Clearing alone is
    // ambiguous because an explicit selection also starts with an empty state.
    publish(onDisconnect, { index, selection });
    // A consumer may stop or deliberately select another device in its callback.
    if (current !== run || run.selected !== index || run.selection !== selection) return;
    run.selected = null;
    run.selection++;
    send(run, { command: 'select', slot: null, selection: run.selection });
    publish(onSample, null);
  }

  function line(run, source) {
    if (current !== run) return;
    let value;
    try { value = JSON.parse(source.replace(/^\uFEFF/, '')); } catch { stopRun(run, 'XINPUT_INVALID_DATA'); return; }
    run.lastMessage = Date.now();
    if (exact(value, ['event']) && value.event === 'heartbeat') return;
    if (exact(value, ['event', 'devices']) && value.event === 'devices') {
      const devices = parseDevices(value.devices);
      if (!devices) { stopRun(run, 'XINPUT_INVALID_DATA'); return; }
      clearTimeout(run.startup);
      run.ready = true;
      run.devices = devices;
      if (run.selected !== null && !devices.some(device => device.index === run.selected)) {
        revokeSelection(run, run.selected, run.selection);
      }
      if (current !== run) return;
      publish(onDevices, devices.map(device => ({ ...device })));
      return;
    }
    if (exact(value, ['event', 'slot', 'selection']) && value.event === 'disconnected' && integer(value.slot, 0, 3) && integer(value.selection, 1, 2147483647)) {
      revokeSelection(run, value.slot, value.selection);
      return;
    }
    if (value?.event === 'sample') {
      // In-flight data from a previous selection must never light a new device.
      const sample = normalizeSample(value, run.devices.find(device => device.index === value.slot));
      if (!sample) { stopRun(run, 'XINPUT_INVALID_DATA'); return; }
      if (run.selected === value.slot && run.selection === value.selection) { run.lastSample = Date.now(); publish(onSample, sample); }
      return;
    }
    stopRun(run, 'XINPUT_INVALID_DATA');
  }

  function start() {
    if (disposed || platform !== 'win32') return false;
    if (current) return true;
    let child;
    try {
      const bundledScript = fs.readFileSync(path.join(__dirname, 'input-viewer-xinput-windows.ps1'), 'utf8');
      const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      // Electron ASAR members cannot be passed to powershell -File. Encode only
      // the fixed bundled helper, never any settings, slot or renderer payload.
      child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(bundledScript, 'utf16le').toString('base64')],
        { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      if (!child?.stdin || !child?.stdout) throw Error();
    } catch { try { child?.kill(); } catch {} clear(); publish(onError, 'XINPUT_START_FAILED'); return false; }
    const run = { child, devices: [], selected: null, selection: 0, buffer: '', heartbeat: null, startup: null,
      ready: false, lastMessage: Date.now(), lastSample: Date.now() };
    current = run;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (current !== run) return;
      // Enforce a per-chunk limit too, before concatenating arbitrary data.
      if (typeof chunk !== 'string' || Buffer.byteLength(chunk, 'utf8') > MAX_LINE_BYTES * 8) { stopRun(run, 'XINPUT_INVALID_DATA'); return; }
      run.buffer += chunk;
      let newline;
      while (current === run && (newline = run.buffer.indexOf('\n')) !== -1) {
        const source = run.buffer.slice(0, newline).trim();
        run.buffer = run.buffer.slice(newline + 1);
        if (Buffer.byteLength(source, 'utf8') > MAX_LINE_BYTES || !source) { stopRun(run, 'XINPUT_INVALID_DATA'); return; }
        line(run, source);
      }
      if (current === run && Buffer.byteLength(run.buffer, 'utf8') > MAX_LINE_BYTES) stopRun(run, 'XINPUT_INVALID_DATA');
    });
    child.stdin.on('error', () => stopRun(run, 'XINPUT_TRANSPORT_CLOSED'));
    child.stdout.on('error', () => stopRun(run, 'XINPUT_TRANSPORT_CLOSED'));
    child.on('error', () => stopRun(run, 'XINPUT_START_FAILED'));
    child.on('close', () => stopRun(run, 'XINPUT_TRANSPORT_CLOSED'));
    run.heartbeat = setInterval(() => {
      if ((run.ready && Date.now() - run.lastMessage > 5000) || (run.selected !== null && Date.now() - run.lastSample > 1500)) {
        stopRun(run, 'XINPUT_SAMPLE_TIMEOUT');
        return;
      }
      send(run, { command: 'ping' });
    }, 1000);
    run.heartbeat.unref?.();
    run.startup = setTimeout(() => stopRun(run, 'XINPUT_START_TIMEOUT'), 10000);
    run.startup.unref?.();
    return true;
  }

  function select(slot) {
    const run = current;
    if (!run || !(slot === null || integer(slot, 0, 3)) || (slot !== null && !run.devices.some(device => device.index === slot))) return false;
    if (run.selection >= 2147483646) { stopRun(run, 'XINPUT_SELECTION_LIMIT'); return false; }
    run.selection++;
    run.selected = slot;
    run.lastSample = Date.now();
    publish(onSample, null);
    return send(run, { command: 'select', slot, selection: run.selection });
  }

  return { start, select, getSelection: () => current?.selection ?? null,
    stop() { if (current) stopRun(current); }, dispose() { if (disposed) return; disposed = true; if (current) stopRun(current); } };
}

module.exports = { createXInputSource, parseDevices, normalizeSample };
