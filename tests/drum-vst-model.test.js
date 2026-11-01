'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { PAD_IDS, defaultSettings, validateSettings, validateBinding } = require('../companion/drum-vst-model.cjs');
const copy = value => structuredClone(value);

test('drum defaults provide all GM pads without activating a device or inventing MIDI velocity', () => {
  const value = defaultSettings();
  assert.deepEqual(value.pads.map(pad => pad.note), [36, 38, 42, 46, 48, 45, 43, 49, 51]);
  assert(value.pads.every(pad => pad.channel === 9 && pad.velocity === 100 && pad.binding.kind === 'none'));
  assert.equal(value.source, 'midi'); assert.equal(value.midiDeviceId, -1);
  assert.equal(value.volume, .5); assert.equal(value.sampleRate, 48000); assert.equal(value.blockSize, 128);
  assert.deepEqual(validateSettings(value), value);
  value.pads[0].note = 99; assert.equal(defaultSettings().pads[0].note, 36);
});

test('complete custom maps survive validation as independent canonical copies', () => {
  const value = defaultSettings(); value.source = 'xinput'; value.xinputIndex = 3; value.audioDeviceId = 'wave:12';
  value.sampleRate = 96000; value.blockSize = 512; value.volume = 0;
  value.pads[0] = { id: 'kick', note: 60, channel: 15, velocity: 127, binding: { kind: 'axis', index: 3, direction: -1 } };
  value.pads[1].binding = { kind: 'button', index: 16, direction: 1 }; value.pads.reverse();
  const checked = validateSettings(value); assert.deepEqual(checked.pads.map(pad => pad.id), PAD_IDS);
  assert.deepEqual(checked.pads[0], value.pads.find(pad => pad.id === 'kick'));
  checked.pads[0].binding.index = 1; assert.equal(value.pads.find(pad => pad.id === 'kick').binding.index, 3);
  const max = defaultSettings(); max.midiDeviceId = 65535; max.volume = 1; max.pads[0].note = 0; max.pads[0].channel = 0; max.pads[0].velocity = 1;
  assert.deepEqual(validateSettings(max), max);
  const endpoint = defaultSettings(); endpoint.audioDeviceId = '{0.0.0.00000000}.{12345678-abcd-1234-abcd-123456789abc}';
  assert.equal(validateSettings(endpoint).audioDeviceId, endpoint.audioDeviceId);
});

test('settings reject unbounded, unknown and executable selections', () => {
  const value = defaultSettings();
  assert.throws(() => validateSettings({}));
  for (const patch of [null, [], { version: 2 }, { source: 'keyboard' }, { midiDeviceId: -2 }, { midiDeviceId: 65536 },
    { midiDeviceId: 1.5 }, { xinputIndex: 4 }, { audioDeviceId: '' }, { audioDeviceId: '../plugin.dll' },
    { audioDeviceId: 'C:\\plugin.dll' }, { audioDeviceId: 'a'.repeat(257) }, { audioDeviceId: 'device\n1' },
    { sampleRate: 192000 }, { blockSize: 32 }, { volume: NaN }, { volume: Infinity }, { volume: -.1 }, { volume: 1.01 },
    { pluginPath: 'arbitrary.dll' }, { enabled: true }, { pads: value.pads.slice(1) }]) {
    assert.throws(() => validateSettings(patch && !Array.isArray(patch) ? { ...value, ...patch } : patch));
  }
});

test('pad maps reject duplicates, invalid notes, velocities, channels and binding shapes', () => {
  const value = defaultSettings();
  for (const patch of [{ id: 'unknown' }, { id: 'snare' }, { note: -1 }, { note: 128 }, { note: 2.5 },
    { channel: 16 }, { channel: -1 }, { velocity: 0 }, { velocity: 128 }, { velocity: 4.5 },
    { file: 'sample.wav' }, { binding: { kind: 'axis', index: 4, direction: 1 } },
    { binding: { kind: 'button', index: 17, direction: 1 } }, { binding: { kind: 'button', index: 0, direction: 0 } },
    { binding: { kind: 'none', index: 1, direction: 1 } }, { binding: { kind: 'button', index: 0, direction: 1, key: 'Space' } }]) {
    const bad = copy(value); Object.assign(bad.pads[0], patch); assert.throws(() => validateSettings(bad));
  }
  assert.throws(() => validateBinding({ kind: 'none', index: 0, direction: -1 }));
});
