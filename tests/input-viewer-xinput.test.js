'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createXInputSource, parseDevices, normalizeSample } = require('../companion/input-viewer-xinput.cjs');

const device = (slot = 0) => ({ slot, type: 1, subtype: 7, flags: 1 });
const sample = (slot = 0, selection = 1, overrides = {}) => ({ event: 'sample', slot, selection, packet: 1,
  buttons: 0, leftTrigger: 0, rightTrigger: 0, leftX: 0, leftY: 0, rightX: 0, rightY: 0, ...overrides });

function fixture() {
  const children = [], invocations = [], devices = [], samples = [], disconnects = [], errors = [];
  const spawn = (...args) => {
    invocations.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = encoding => { child.encoding = encoding; };
    child.stdin = new EventEmitter();
    child.commands = [];
    child.stdin.write = value => { child.commands.push(JSON.parse(value)); return true; };
    child.stdin.end = value => { child.commands.push(JSON.parse(value)); child.ended = true; };
    child.kill = () => { child.killed = true; child.emit('close'); };
    child.message = value => child.stdout.emit('data', JSON.stringify(value) + '\n');
    children.push(child);
    return child;
  };
  const source = createXInputSource({ platform: 'win32', spawn, onDevices: value => devices.push(value), onSample: value => samples.push(value), onDisconnect: value => disconnects.push(value), onError: value => errors.push(value) });
  return { source, children, invocations, devices, samples, disconnects, errors };
}

test('Windows transport runs only the fixed bundled helper, hidden with no shell or renderer arguments', t => {
  const f = fixture(); t.after(() => f.source.dispose());
  assert.equal(f.source.start(), true);
  assert.equal(f.source.start(), true);
  assert.equal(f.invocations.length, 1);
  const [executable, args, options] = f.invocations[0];
  assert.match(executable, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.match(Buffer.from(args[4], 'base64').toString('utf16le'), /GetCapabilities/);
  assert.deepEqual(options, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  assert.deepEqual(f.children[0].commands, []);
});

test('enumeration never selects or publishes played input; selection requires a reported slot', t => {
  const f = fixture(); t.after(() => f.source.dispose()); f.source.start();
  const child = f.children[0]; child.message({ event: 'devices', devices: [device()] });
  assert.equal(f.devices.at(-1)[0].subtype, 7);
  assert.deepEqual(f.samples, []); assert.deepEqual(child.commands, []);
  for (const rejected of [4, -1, 0.5, '0', {}, true, 1]) assert.equal(f.source.select(rejected), false);
  assert.equal(f.source.select(0), true);
  assert.deepEqual(child.commands, [{ command: 'select', slot: 0, selection: 1 }]);
  child.message(sample()); assert.equal(f.samples.at(-1).connected, true);
});

test('normalization preserves independent buttons, trigger range and stick endpoints', () => {
  const descriptor = parseDevices([device()])[0];
  const pad = normalizeSample(sample(0, 1, { buttons: 0x1000 | 0x8000 | 0x0100 | 1 | 0x10,
    leftTrigger: 255, rightTrigger: 127, leftX: -32768, leftY: 32767, rightX: 32767, rightY: -32768 }), descriptor);
  assert.equal(pad.buttons.length, 17);
  assert.equal(pad.selection, 1);
  for (const index of [0, 3, 4, 9, 12]) assert.equal(pad.buttons[index].pressed, true);
  assert.equal(pad.buttons[1].pressed, false);
  assert.deepEqual(pad.buttons[6], { pressed: true, touched: true, value: 1 });
  assert.equal(pad.buttons[7].pressed, false); assert.equal(pad.buttons[7].value, 127 / 255);
  assert.equal(pad.buttons[16].pressed, false); // Guide is unavailable in the documented API.
  assert.deepEqual(pad.axes, [-1, -1, 1, 1]);
  assert.equal(normalizeSample(sample(0, 1, { leftX: 32768 }), descriptor), null);
});

test('changing or clearing selection rejects queued input from an earlier selection', t => {
  const f = fixture(); t.after(() => f.source.dispose()); f.source.start();
  const child = f.children[0]; child.message({ event: 'devices', devices: [device(0), device(1)] });
  f.source.select(0); child.message(sample(0, 1)); f.source.select(1);
  const count = f.samples.length; child.message(sample(0, 1, { buttons: 65535 }));
  assert.equal(f.samples.length, count);
  child.message(sample(1, 2)); assert.equal(f.samples.at(-1).index, 1);
  f.source.select(null); const clearedCount = f.samples.length;
  child.message(sample(1, 2)); assert.equal(f.samples.length, clearedCount); assert.equal(f.samples.at(-1), null);
});

test('disconnect clears pressed state and never automatically rebinds a reconnected slot', t => {
  const f = fixture(); t.after(() => f.source.dispose()); f.source.start();
  const child = f.children[0]; child.message({ event: 'devices', devices: [device()] });
  f.source.select(0); child.message(sample(0, 1, { buttons: 65535 }));
  child.message({ event: 'disconnected', slot: 0, selection: 1 }); assert.equal(f.samples.at(-1), null);
  child.message({ event: 'devices', devices: [] }); child.message({ event: 'devices', devices: [device()] });
  const count = f.samples.length; child.message(sample(0, 1)); assert.equal(f.samples.length, count);
  assert.equal(child.commands.at(-1).slot, null); assert.equal(f.errors.length, 0);
});

test('device-list revocation disarms the slot and clears stale input', t => {
  const f = fixture(); t.after(() => f.source.dispose()); f.source.start();
  const child = f.children[0]; child.message({ event: 'devices', devices: [device()] });
  f.source.select(0); child.message(sample()); child.message({ event: 'devices', devices: [] });
  assert.equal(f.samples.at(-1), null);
  assert.deepEqual(child.commands.at(-1), { command: 'select', slot: null, selection: 2 });
  assert.deepEqual(f.disconnects, [{ index: 0, selection: 1 }]);
});

test('disconnection before the first sample reports the old lease and does not silently rebind', t => {
  const f = fixture(); t.after(() => f.source.dispose());
  assert.equal(f.source.getSelection(), null); f.source.start(); assert.equal(f.source.getSelection(), 0);
  const child = f.children[0]; child.message({ event: 'devices', devices: [device()] });
  f.source.select(0); assert.equal(f.source.getSelection(), 1);
  child.message({ event: 'disconnected', slot: 0, selection: 1 });
  assert.deepEqual(f.disconnects, [{ index: 0, selection: 1 }]); assert.equal(f.source.getSelection(), 2);
  child.message({ event: 'disconnected', slot: 0, selection: 1 });
  child.message(sample(0, 1)); assert.equal(f.disconnects.length, 1); assert.equal(f.samples.at(-1), null);
  f.source.select(0); child.message(sample(0, 3));
  assert.equal(f.samples.at(-1).selection, 3); assert.equal(f.source.getSelection(), 3);
  f.source.select(null); assert.equal(f.source.getSelection(), 4); assert.equal(f.disconnects.length, 1);
  f.source.stop(); assert.equal(f.source.getSelection(), null); assert.equal(f.disconnects.length, 1);
  f.source.start(); assert.equal(f.source.getSelection(), 0);
});

test('malformed, oversized and unsolicited fields fail closed instead of reaching the renderer', t => {
  for (const invalid of [
    '{invalid}\n', 'x'.repeat(4097),
    JSON.stringify({ event: 'devices', devices: [device(), device()] }) + '\n',
    JSON.stringify({ event: 'devices', devices: [{ ...device(), serial: 'private' }] }) + '\n',
    JSON.stringify({ event: 'sample', slot: 0, selection: 1, text: 'untrusted' }) + '\n',
    JSON.stringify({ event: 'execute', command: 'other' }) + '\n'
  ]) {
    const f = fixture(); t.after(() => f.source.dispose()); f.source.start();
    const child = f.children[0]; child.stdout.emit('data', invalid);
    assert.equal(f.errors.at(-1), 'XINPUT_INVALID_DATA'); assert.equal(child.ended, true);
    assert.equal(f.samples.at(-1), null); assert.equal(f.source.select(0), false);
  }
});

test('stop/dispose terminates only its helper and ignores delayed data from an older process', t => {
  const f = fixture(); t.after(() => f.source.dispose()); f.source.start();
  const old = f.children[0]; old.message({ event: 'devices', devices: [device()] }); f.source.select(0);
  f.source.stop(); assert.equal(old.ended, true); assert.equal(f.samples.at(-1), null);
  f.source.start(); const child = f.children[1];
  const count = f.devices.length; old.message({ event: 'devices', devices: [device(3)] }); old.emit('error', Error('late'));
  assert.equal(f.devices.length, count);
  child.message({ event: 'devices', devices: [device(1)] }); assert.equal(f.devices.at(-1)[0].index, 1);
  f.source.dispose(); f.source.dispose(); assert.equal(child.ended, true); assert.equal(f.source.start(), false);
});

test('a stalled selected helper clears held input without automatically restarting', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const f = fixture(); t.after(() => f.source.dispose()); f.source.start();
  const child = f.children[0]; child.message({ event: 'devices', devices: [device()] });
  f.source.select(0); child.message(sample(0, 1, { buttons: 65535 })); t.mock.timers.tick(2000);
  assert.equal(f.errors.at(-1), 'XINPUT_SAMPLE_TIMEOUT'); assert.equal(f.samples.at(-1), null);
  assert.equal(child.ended, true); assert.equal(f.invocations.length, 1);
});

test('a helper must answer heartbeats even when no controller is selected', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const f = fixture(); t.after(() => f.source.dispose()); f.source.start();
  const child = f.children[0]; child.message({ event: 'devices', devices: [] }); t.mock.timers.tick(6000);
  assert.equal(f.errors.at(-1), 'XINPUT_SAMPLE_TIMEOUT'); assert.equal(child.ended, true);
});

test('non-Windows platforms and spawn failures do not read any inputs', () => {
  let calls = 0;
  const other = createXInputSource({ platform: 'linux', spawn: () => { calls++; } });
  assert.equal(other.start(), false); assert.equal(calls, 0); other.dispose();
  const errors = [];
  const failed = createXInputSource({ platform: 'win32', spawn: () => { throw Error('private path'); }, onError: value => errors.push(value) });
  assert.equal(failed.start(), false); assert.deepEqual(errors, ['XINPUT_START_FAILED']); failed.dispose();
});
