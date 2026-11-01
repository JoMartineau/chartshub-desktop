'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { defaultSettings } = require('../companion/drum-vst-model.cjs');
class Element extends EventTarget {
  constructor(tag, document) { super(); this.tagName = tag; this.ownerDocument = document; this.children = []; this.disabled = false; this.hidden = false; this.textContent = ''; this.attributes = {}; this.value = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(key, value) { this.attributes[key] = value; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  change(value, event = 'change') { this.value = String(value); this.dispatchEvent(new Event(event)); }
}
async function fixture(command) {
  const document = { createElement: tag => new Element(tag, document) }, root = document.createElement('section');
  const { DrumVstControls } = await import('../companion/ui/drum-vst-controls.js');
  return new DrumVstControls({ root, command });
}
const snapshot = (patch = {}, language = 'fr') => ({ language, drums: {
  supported: true, available: true, phase: 'loaded', revision: 12, plugin: { name: 'Instrument de test', loaded: true },
  devices: { audio: [{ id: 'ab1234', name: 'Synthetic output' }], midi: [{ id: 4, name: 'Synthetic drums' }], xinput: [{ index: 1, name: 'Synthetic controller' }] },
  settings: defaultSettings(), error: null, meters: { left: 0, right: 0 }, ...patch
} });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('mount and repeated status updates do not load plugins, enumerate devices, read input or start audio', async () => {
  const calls = [], controls = await fixture(async (...args) => { calls.push(args); return { ok: true }; });
  assert(controls.startButton.disabled); controls.update(snapshot()); controls.sync(snapshot());
  assert.deepEqual(calls, []); assert(controls.startButton.disabled, 'MIDI requires an explicit device selection');
  controls.chooseButton.click(); await settle(); controls.refreshButton.click(); await settle();
  assert.deepEqual(calls, [['drums.choosePlugin', {}], ['drums.refreshDevices', {}]]);
  controls.mtButton.click(); await settle(); assert.deepEqual(calls[2], ['drums.openMtPage', {}]);
  assert(!controls.plugin.textContent.includes('path')); controls.dispose();
});

test('MT private preparation requires an unchecked explicit licence agreement and never starts audio', async () => {
  const calls = [], controls = await fixture(async (...args) => { calls.push(args); return { ok: true }; });
  controls.update(snapshot({ mt: { version: '2.1.5.1', state: 'idle', progress: { receivedBytes: 0, totalBytes: null }, error: null } }));
  assert.equal(controls.mtConsent.checked, false); assert(controls.mtInstallButton.disabled);
  controls.mtInstallButton.click(); assert.deepEqual(calls, []);
  controls.mtLicenseButton.click(); await settle(); assert.deepEqual(calls.pop(), ['drums.openMtLicense', {}]);
  controls.mtConsent.checked = true; controls.mtConsent.dispatchEvent(new Event('change')); assert.equal(controls.mtInstallButton.disabled, false);
  controls.mtInstallButton.click(); await settle(); assert.deepEqual(calls, [['drums.installMt', { consent: true }]]);
  assert.equal(controls.mtConsent.checked, false); assert(controls.mtInstallButton.disabled);
  controls.update(snapshot({ mt: { state: 'downloading', progress: { receivedBytes: 1000000, totalBytes: 63000000 } } }, 'en'));
  assert.match(controls.mtStatus.textContent, /Downloading.*1.0 \/ 63.0 MB/); assert(controls.mtConsent.disabled);
  controls.update(snapshot({ mt: { state: 'error', error: 'DRUM_MT_ARCHIVE' } })); assert.match(controls.mtStatus.textContent, /incomplet/); controls.dispose();
});

test('manual audio start, fixed-velocity pad test, panic and stop are separate explicit actions', async () => {
  const calls = [], controls = await fixture(async (...args) => { calls.push(args); return { ok: true }; });
  const settings = defaultSettings(); settings.source = 'manual'; settings.pads[0].velocity = 87;
  controls.update(snapshot({ settings })); assert.equal(controls.startButton.disabled, false); assert(controls.stopButton.disabled);
  controls.startButton.click(); await settle(); assert.deepEqual(calls.pop(), ['drums.start', {}]);
  controls.update(snapshot({ settings, phase: 'running' })); assert(controls.startButton.disabled); assert.equal(controls.stopButton.disabled, false);
  assert(controls.audio.disabled); assert(controls.padRows[0].note.disabled);
  controls.padRows[0].testButton.click(); await settle(); assert.deepEqual(calls.pop(), ['drums.testPad', { padId: 'kick', velocity: 87 }]);
  controls.panicButton.click(); await settle(); assert.deepEqual(calls.pop(), ['drums.panic', {}]);
  controls.stopButton.click(); await settle(); assert.deepEqual(calls.pop(), ['drums.stop', {}]);
  controls.editorButton.click(); await settle(); assert.deepEqual(calls.pop(), ['drums.editor', { open: true }]); controls.dispose();
});

test('status and meter updates preserve edited custom mappings until a successful revisioned save', async () => {
  const calls = []; let controls;
  controls = await fixture(async (name, payload) => {
    calls.push([name, structuredClone(payload)]);
    if (name === 'drums.configure') controls.update(snapshot({ revision: 13, settings: payload.settings }));
    return { ok: true };
  });
  const settings = defaultSettings(); settings.source = 'xinput'; settings.xinputIndex = 1;
  settings.pads[0].binding = { kind: 'axis', index: 3, direction: -1 }; settings.pads[0].note = 74;
  controls.update(snapshot({ settings }));
  controls.padRows[0].note.change(75, 'input'); controls.volume.change(63, 'input');
  controls.update(snapshot({ settings, meters: { left: .6, right: .8 } }, 'en'));
  assert.equal(controls.padRows[0].note.value, '75'); assert.equal(controls.volume.value, '63');
  assert.deepEqual(controls.draft.pads[0].binding, { kind: 'axis', index: 3, direction: -1 });
  assert.equal(controls.draft.pads[0].note, 75); assert.equal(controls.meter.value, .8);
  assert.equal(controls.startButton.disabled, true); assert.equal(controls.saveButton.disabled, false);
  controls.saveButton.click(); await settle(); assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'drums.configure'); assert.equal(calls[0][1].revision, 12);
  assert.equal(calls[0][1].settings.volume, .63); assert.equal(calls[0][1].settings.pads[0].note, 75);
  assert.deepEqual(calls[0][1].settings.pads[0].binding, settings.pads[0].binding);
  assert.equal(controls.dirty, false); assert.equal(controls.baseRevision, 13); assert.equal(controls.padRows[0].note.value, '75'); controls.dispose();
});

test('invalid values disable Apply and Start without discarding the draft or invoking audio', async () => {
  const calls = [], controls = await fixture(async (...args) => { calls.push(args); return { ok: true }; });
  const settings = defaultSettings(); settings.source = 'manual'; controls.update(snapshot({ settings }));
  controls.padRows[0].note.change('', 'input'); assert(controls.saveButton.disabled); assert(controls.startButton.disabled);
  controls.saveButton.click(); controls.startButton.click(); assert.deepEqual(calls, []); assert.match(controls.unsaved.textContent, /0–127/);
  controls.padRows[0].note.change(36, 'input'); controls.padRows[0].channel.change(17, 'input'); assert(controls.saveButton.disabled);
  controls.padRows[0].channel.change(10, 'input'); controls.volume.change(101, 'input'); assert(controls.saveButton.disabled);
  controls.volume.change(50, 'input'); assert.equal(controls.saveButton.disabled, false); controls.dispose();
});

test('pending commands prevent duplicates and a failed save keeps custom edits with its original revision', async () => {
  let complete; const calls = [], controls = await fixture((name, payload) => { calls.push([name, payload]); return new Promise(resolve => { complete = resolve; }); });
  const settings = defaultSettings(); settings.source = 'xinput'; controls.update(snapshot({ settings }));
  controls.padRows[1].binding.change('button:16'); controls.padRows[1].velocity.change(91, 'input');
  controls.saveButton.click(); controls.saveButton.click(); controls.chooseButton.click(); assert.equal(calls.length, 1);
  controls.update(snapshot({ revision: 13, settings, meters: { left: .2 } }));
  complete({ ok: false, error: 'Synthetic stale revision' }); await settle();
  assert.equal(controls.feedback.textContent, 'Synthetic stale revision'); assert.equal(controls.feedback.hidden, false);
  assert(controls.dirty); assert.equal(controls.baseRevision, 12); assert.equal(controls.draft.pads[1].velocity, 91);
  assert.deepEqual(controls.draft.pads[1].binding, { kind: 'button', index: 16, direction: 1 });
  controls.reloadButton.click(); assert.equal(controls.dirty, false); assert.equal(controls.baseRevision, 13);
  assert.deepEqual(controls.draft.pads[1].binding, settings.pads[1].binding); controls.dispose();
});

test('MIDI velocity guidance and every static option switch between French and English', async () => {
  const controls = await fixture(async () => ({ ok: true })); const settings = defaultSettings(); settings.midiDeviceId = 4;
  controls.update(snapshot({ settings })); assert.match(controls.sourceHelp.textContent, /vélocité reçue.*conservée/);
  assert.equal(controls.startButton.disabled, false); assert.equal(controls.source.children[0].textContent, 'Batterie MIDI');
  controls.update(snapshot({ settings }, 'en')); assert.equal(controls.source.children[0].textContent, 'MIDI drum kit');
  assert.equal(controls.blockSize.children[0].textContent, '64 samples'); assert.match(controls.sourceHelp.textContent, /incoming velocity is preserved/);
  assert.match(controls.obs.textContent, /Application Audio Capture/); assert.match(controls.obs.textContent, /does not carry audio/);
  controls.source.change('xinput'); assert.match(controls.sourceHelp.textContent, /does not measure hit strength/); controls.dispose();
});

test('unsupported engines and missing plugins cannot start or test pads, and errors remain visible', async () => {
  const controls = await fixture(async () => ({ ok: true }));
  controls.update(snapshot({ supported: false, available: false })); assert(controls.startButton.disabled); assert(controls.chooseButton.disabled);
  assert.match(controls.status.textContent, /Windows/);
  controls.update(snapshot({ plugin: null, phase: 'stopped' })); assert(controls.startButton.disabled); assert(controls.editorButton.disabled);
  controls.update(snapshot({ phase: 'error', error: 'Synthetic device removed' })); assert.match(controls.status.textContent, /Synthetic device removed/);
  assert(controls.padRows.every(row => row.testButton.disabled)); controls.dispose();
});

test('saved instruments can be explicitly reloaded by Start and actual audio format remains distinct from requested settings', async () => {
  const calls = [], controls = await fixture(async (...args) => { calls.push(args); return { ok: true }; });
  const settings = defaultSettings(); settings.source = 'manual';
  controls.update(snapshot({ settings, phase: 'stopped', plugin: { name: 'Saved instrument', loaded: false } }));
  assert.equal(controls.startButton.disabled, false); assert(controls.editorButton.disabled); assert.match(controls.plugin.textContent, /chargé au démarrage/);
  assert.deepEqual(calls, []); controls.startButton.click(); await settle(); assert.deepEqual(calls, [['drums.start', {}]]);
  controls.update(snapshot({ settings, phase: 'running', audio: { sampleRate: 44100, blockSize: 256, latencyMs: 8.5, latencyKind: 'reported' } }));
  assert.match(controls.audioFormat.textContent, /44100 Hz.*256.*latence déclarée.*8.5 ms/); assert.equal(controls.draft.sampleRate, 48000);
  controls.update(snapshot({ settings, phase: 'error', error: 'DRUM_HOST_EXITED' }, 'en')); assert.match(controls.status.textContent, /audio engine closed/); assert(!controls.status.textContent.includes('DRUM_HOST_EXITED'));
  controls.dispose();
});

test('disposing removes command listeners and ignores a late command completion', async () => {
  let complete, calls = 0; const controls = await fixture(() => { calls++; return new Promise(resolve => { complete = resolve; }); });
  controls.update(snapshot()); controls.refreshButton.click(); const previous = controls.status.textContent;
  controls.dispose(); complete({ ok: false, error: 'Late error' }); await settle();
  controls.update(snapshot({ phase: 'error' }, 'en')); assert.equal(controls.status.textContent, previous);
  assert.equal(controls.feedback.hidden, true); controls.chooseButton.click(); assert.equal(calls, 1);
});

test('Stop and Panic remain available while audio start or MT preparation is pending', async () => {
  let finishStart; const calls = [], controls = await fixture((name, payload) => {
    calls.push([name, payload]); return name === 'drums.start' ? new Promise(resolve => { finishStart = resolve; }) : Promise.resolve({ ok: true });
  });
  const settings = defaultSettings(); settings.source = 'manual'; controls.update(snapshot({ settings })); controls.startButton.click();
  assert.equal(controls.stopButton.disabled, false); assert.equal(controls.panicButton.disabled, false);
  controls.stopButton.click(); await settle(); assert.deepEqual(calls.map(call => call[0]), ['drums.start', 'drums.stop']);
  assert.equal(controls.busy, true, 'finishing Stop cannot unlock settings while Start is still pending');
  controls.panicButton.click(); await settle(); assert.equal(calls.at(-1)[0], 'drums.panic');
  finishStart({ ok: true }); await settle(); assert.equal(controls.busy, false);
  controls.update(snapshot({ settings, busy: true, mt: { state: 'downloading', progress: { receivedBytes: 1, totalBytes: 10 } } }));
  assert.equal(controls.stopButton.disabled, false); controls.stopButton.click(); await settle(); assert.equal(calls.at(-1)[0], 'drums.stop'); controls.dispose();
});
