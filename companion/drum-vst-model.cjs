'use strict';

const SAMPLE_RATES = Object.freeze([44100, 48000, 96000]);
const BLOCK_SIZES = Object.freeze([64, 128, 256, 512]);
const PAD_DEFAULTS = Object.freeze([
  ['kick', 36], ['snare', 38], ['hat', 42], ['hat-open', 46],
  ['tom-high', 48], ['tom-mid', 45], ['tom-low', 43], ['crash', 49], ['ride', 51]
].map(([id, note]) => Object.freeze({ id, note })));
const PAD_IDS = Object.freeze(PAD_DEFAULTS.map(pad => pad.id));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
const validPadId = value => typeof value === 'string' && PAD_IDS.includes(value);
const invalid = () => new TypeError('Invalid drum VST settings');

function validateBinding(value) {
  if (!exact(value, ['kind', 'index', 'direction']) || !['none', 'button', 'axis'].includes(value.kind)
      || !integer(value.index, 0, value.kind === 'axis' ? 3 : value.kind === 'none' ? 0 : 16)
      || ![1, -1].includes(value.direction) || value.kind === 'none' && value.direction !== 1) throw invalid();
  return { kind: value.kind, index: value.index, direction: value.direction };
}

function defaultSettings() {
  return { version: 1, source: 'midi', midiDeviceId: -1, xinputIndex: 0, audioDeviceId: 'default',
    sampleRate: 48000, blockSize: 128, volume: .5,
    pads: PAD_DEFAULTS.map(({ id, note }) => ({ id, note, channel: 9, velocity: 100, binding: { kind: 'none', index: 0, direction: 1 } })) };
}

/** Device IDs are opaque selections, never renderer-supplied filesystem paths.
 * velocity is only for manual/XInput hits; incoming MIDI velocity is untouched. */
function validateSettings(value) {
  if (!exact(value, ['version', 'source', 'midiDeviceId', 'xinputIndex', 'audioDeviceId', 'sampleRate', 'blockSize', 'volume', 'pads'])
      || value.version !== 1 || !['midi', 'xinput', 'manual'].includes(value.source)
      || !integer(value.midiDeviceId, -1, 65535) || !integer(value.xinputIndex, 0, 3)
      || typeof value.audioDeviceId !== 'string' || !/^[A-Za-z0-9{][A-Za-z0-9:._{}-]{0,255}$/.test(value.audioDeviceId)
      || !SAMPLE_RATES.includes(value.sampleRate) || !BLOCK_SIZES.includes(value.blockSize)
      || typeof value.volume !== 'number' || !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 1
      || !Array.isArray(value.pads) || value.pads.length !== PAD_IDS.length) throw invalid();
  const ids = new Set(), pads = value.pads.map(pad => {
    if (!exact(pad, ['id', 'note', 'channel', 'velocity', 'binding']) || !validPadId(pad.id) || ids.has(pad.id)
        || !integer(pad.note, 0, 127) || !integer(pad.channel, 0, 15) || !integer(pad.velocity, 1, 127)) throw invalid();
    ids.add(pad.id);
    return { id: pad.id, note: pad.note, channel: pad.channel, velocity: pad.velocity, binding: validateBinding(pad.binding) };
  });
  return { version: 1, source: value.source, midiDeviceId: value.midiDeviceId, xinputIndex: value.xinputIndex,
    audioDeviceId: value.audioDeviceId, sampleRate: value.sampleRate, blockSize: value.blockSize, volume: value.volume,
    pads: PAD_IDS.map(id => pads.find(pad => pad.id === id)) };
}

module.exports = { SAMPLE_RATES, BLOCK_SIZES, PAD_DEFAULTS, PAD_IDS, validPadId, defaultSettings, validateBinding, validateSettings };
