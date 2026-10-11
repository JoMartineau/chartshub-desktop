'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tick } = require('./floating-panel-dom.cjs');
const token = 'a'.repeat(64);
const selection = (revision = 1, count = 2) => ({ revision, volume: .6, available: true, selection: { id: 'b'.repeat(64), title: 'Synthetic stems', artist: 'Fixture', mediaUrls: Array.from({ length: count }, (_, index) => ({ name: index ? 'guitar.wav' : 'song.wav', url: `chartshub-companion://app/music-media/${token}/${index}` })) } });
class AudioFixture extends EventTarget {
  constructor() { super(); this.readyState = 0; this.duration = NaN; this.currentTime = 0; this.paused = true; this.volume = 1; this.plays = 0; this.src = ''; }
  load() {} pause() { this.paused = true; } removeAttribute(name) { if (name === 'src') this.src = ''; }
  play() { this.plays++; this.paused = false; return this.rejectPlay ? Promise.reject(Error('decode failed')) : Promise.resolve(); }
  ready(duration = 20) { this.duration = duration; this.readyState = 4; this.dispatchEvent(new Event('canplay')); }
}
async function fixture(t) {
  const { LocalMusicPlayerEngine } = await import('../companion/dist/player/LocalMusicPlayerEngine.js');
  const audio = [], reports = [], frames = [], tasks = new Map(), contexts = []; let serial = 0, fftValue = 128;
  const engine = new LocalMusicPlayerEngine({ report: state => reports.push(state), spectrum: state => frames.push(state), createAudio: () => { const element = new AudioFixture(); audio.push(element); return element; },
    createAudioContext: () => { const context = { sources: 0, resumed: 0, closed: 0, sampleRate: 48000, destination: {}, createAnalyser: () => ({ frequencyBinCount: 1024, fftSize: 2048, connect() {}, disconnect() {}, getByteFrequencyData: values => values.fill(fftValue) }), createMediaElementSource() { this.sources++; return { connect() {}, disconnect() {} }; }, async resume() { this.resumed++; }, async close() { this.closed++; } }; contexts.push(context); return context; },
    requestFrame: callback => { tasks.set(++serial, callback); return serial; }, cancelFrame: id => tasks.delete(id),
  });
  const frame = timestamp => { const entry = tasks.entries().next().value; assert.ok(entry); tasks.delete(entry[0]); entry[1](timestamp); };
  t.after(() => engine.dispose()); return { engine, audio, reports, frames, tasks, contexts, frame, silence: () => { fftValue = 0; } };
}

test('engine waits for every local stem and an explicit play action, then mixes exactly once', async t => {
  const f = await fixture(t); f.engine.update(selection()); assert.equal(f.audio.length, 2); assert.equal(f.contexts.length, 0);
  f.audio[0].ready(); f.engine.action({ revision: 1, action: 'play' }); await tick(); assert.equal(f.audio[0].plays, 0);
  f.audio[1].ready(30); await tick(); assert.equal(f.audio.every(track => track.plays === 1), true); assert.equal(f.contexts[0].sources, 2);
  assert.equal(f.reports.at(-1).duration, 30); assert.equal(f.reports.at(-1).playing, true);
  f.engine.update({ ...selection(), playing: true }); assert.equal(f.audio.length, 2, 'progress snapshots never create another engine');
});

test('engine accepts the final selection after loading=true at the same revision', async t => {
  const f = await fixture(t); f.engine.update({ ...selection(), selection: null, loading: true }); f.engine.action({ revision: 1, action: 'play' }); f.engine.update(selection());
  assert.equal(f.audio.length, 2); f.audio.forEach(track => track.ready()); await tick(); assert.equal(f.audio.every(track => track.plays === 1), true);
});

test('play action arriving before its revision is held until the matching selection loads', async t => {
  const f = await fixture(t); f.engine.action({ revision: 3, action: 'play' }); f.engine.update(selection(3)); f.audio.forEach(track => track.ready()); await tick();
  assert.equal(f.reports.at(-1).playing, true); f.engine.action({ revision: 2, action: 'stop' }); assert.equal(f.audio.every(track => !track.paused), true);
});

test('pause, seek, volume and stop apply to every stem with bounded reports', async t => {
  const f = await fixture(t); f.engine.update(selection()); f.audio.forEach(track => track.ready()); f.engine.action({ revision: 1, action: 'play' }); await tick();
  f.engine.action({ revision: 1, action: 'seek', value: 9 }); assert.equal(f.audio.every(track => track.currentTime === 9), true);
  f.engine.action({ revision: 1, action: 'volume', value: .25 }); assert.equal(f.audio.every(track => track.volume === .25), true);
  f.engine.action({ revision: 1, action: 'pause' }); assert.equal(f.audio.every(track => track.paused), true); assert.equal(f.tasks.size, 0);
  f.engine.action({ revision: 1, action: 'stop' }); assert.equal(f.audio.every(track => track.currentTime === 0), true); assert.equal(f.reports.at(-1).playing, false);
});

test('reports carry the load epoch and newest accepted transport epoch, including metadata and errors', async t => {
  const f = await fixture(t);
  f.engine.update({ ...selection(), playbackEpoch: 4 }); f.audio.forEach(track => track.ready());
  assert.equal(f.reports.at(-1).epoch, 4, 'metadata is stamped with the selection load epoch');
  f.engine.action({ revision: 1, epoch: 5, action: 'play' }); await tick();
  assert.equal(f.reports.at(-1).epoch, 5); assert.equal(f.reports.at(-1).playing, true);
  f.engine.action({ revision: 1, epoch: 6, action: 'pause' });
  const count = f.reports.length; f.engine.action({ revision: 1, epoch: 5, action: 'play' }); await tick();
  assert.equal(f.reports.length, count, 'late play cannot emit another old report');
  assert.equal(f.reports.at(-1).epoch, 6); assert.equal(f.reports.at(-1).playing, false);
  f.engine.action({ revision: 1, epoch: 100, action: 'volume', value: .2 });
  assert.equal(f.reports.at(-1).epoch, 6, 'volume does not change the playback epoch');
  f.engine.action({ revision: 1, epoch: 7, action: 'seek', value: 3 }); assert.equal(f.reports.at(-1).epoch, 7);
  f.engine.action({ revision: 1, epoch: 8, action: 'stop' }); assert.equal(f.reports.at(-1).epoch, 8);
  f.engine.update({ ...selection(2, 1), playbackEpoch: 9 });
  f.engine.action({ revision: 2, epoch: 10, action: 'play' }); f.audio.at(-1).ready(); await tick();
  assert.ok(f.reports.filter(report => report.revision === 2).every(report => report.epoch === 10), 'play before metadata stamps every load report with its newer epoch');
  f.audio.at(-1).dispatchEvent(new Event('error'));
  assert.equal(f.reports.at(-1).epoch, 10); assert.equal(f.reports.at(-1).errorCode, 'playback');
});

test('source replacement and library loss pause/release old tracks, contexts and stale callbacks', async t => {
  const f = await fixture(t); f.engine.update(selection()); f.audio.forEach(track => track.ready()); f.engine.action({ revision: 1, action: 'play' }); await tick();
  f.engine.update(selection(2, 1)); assert.equal(f.audio[0].paused, true); assert.equal(f.audio[0].src, ''); assert.equal(f.contexts[0].closed, 1);
  const count = f.reports.length; f.audio[0].dispatchEvent(new Event('error')); assert.equal(f.reports.length, count, 'old source errors detached');
  f.engine.update({ ...selection(3), selection: null, available: false }); assert.equal(f.audio[2].src, ''); assert.equal(f.tasks.size, 0);
});

test('one unplayable stem stops all tracks and reports a safe error code', async t => {
  const f = await fixture(t); f.engine.update(selection()); f.audio.forEach(track => track.ready()); f.audio[1].rejectPlay = true;
  f.engine.action({ revision: 1, action: 'play' }); await tick(); assert.equal(f.audio.every(track => track.paused), true); assert.equal(f.reports.at(-1).errorCode, 'playback');
  assert.equal(JSON.stringify(f.reports).includes('decode failed'), false);
});

test('engine refuses external/file media without creating audio and never restarts from snapshots', async t => {
  const f = await fixture(t); const state = selection(); state.selection.mediaUrls[0].url = 'file:///C:/private/song.wav'; f.engine.update(state);
  assert.equal(f.audio.length, 0); assert.equal(f.reports.at(-1).errorCode, 'unavailable');
});

test('FFT is real analyser data, rate limited to 10Hz, silent at zero and stopped on pause', async t => {
  const f = await fixture(t); f.engine.update(selection()); f.audio.forEach(track => track.ready()); f.engine.action({ revision: 1, action: 'play' }); await tick();
  f.frame(0); const count = f.frames.length; assert.equal(f.frames.at(-1).bands.length, 32); assert.ok(f.frames.at(-1).bands.every(value => value > 0 && value <= 1));
  f.frame(30); f.frame(90); assert.equal(f.frames.length, count); f.silence(); f.frame(100); assert.equal(f.frames.at(-1).bands.every(value => value === 0), true);
  f.engine.action({ revision: 1, action: 'pause' }); assert.equal(f.tasks.size, 0); assert.equal(f.frames.at(-1).bands.every(value => value === 0), true);
});

test('natural completion uses the longest stem and stops cleanly without an ended callback', async t => {
  const f = await fixture(t); f.engine.update(selection()); f.audio[0].ready(10); f.audio[1].ready(20); f.engine.action({ revision: 1, action: 'play' }); await tick();
  f.audio[0].dispatchEvent(new Event('ended')); assert.equal(f.reports.at(-1).playing, true);
  f.audio[1].ended = true; f.audio[1].currentTime = 20; f.audio[1].dispatchEvent(new Event('ended')); assert.equal(f.reports.at(-1).playing, false); assert.equal(f.reports.at(-1).currentTime, 20);
});

test('only the playing master natural end advances the queue, once; pause and seek-to-end never advance it', async t => {
  const { LocalMusicPlayerEngine } = await import('../companion/dist/player/LocalMusicPlayerEngine.js');
  const ended = [], reports = [], audio = [];
  const engine = new LocalMusicPlayerEngine({ report: state => reports.push(state), ended: state => ended.push(state), createAudio: () => { const track = new AudioFixture(); audio.push(track); return track; },
    createAudioContext: () => ({ sampleRate: 48000, destination: {}, createAnalyser: () => ({ fftSize: 2048, frequencyBinCount: 1024, connect() {}, disconnect() {} }), createMediaElementSource: () => ({ connect() {}, disconnect() {} }), resume: async () => {}, close: async () => {} }), requestFrame: () => 1, cancelFrame: () => {},
  }); t.after(() => engine.dispose()); engine.update(selection()); audio[0].ready(10); audio[1].ready(20);
  engine.action({ revision: 1, action: 'play' }); await tick();
  audio[0].ended = true; audio[0].currentTime = 10; audio[0].dispatchEvent(new Event('ended')); assert.equal(ended.length, 0);
  engine.action({ revision: 1, action: 'seek', value: 20 }); audio[1].ended = true; audio[1].currentTime = 20; audio[1].dispatchEvent(new Event('ended'));
  assert.equal(ended.length, 0); assert.equal(reports.at(-1).playing, false);
  audio[0].ended = audio[1].ended = false; engine.action({ revision: 1, action: 'play' }); await tick();
  const before = reports.length; audio[1].ended = true; audio[1].currentTime = 20; audio[1].dispatchEvent(new Event('ended')); audio[1].dispatchEvent(new Event('ended'));
  assert.deepEqual(ended, [{ revision: 1, epoch: 0 }]); assert.equal(reports.length, before, 'no stale terminal report is sent before queue advancement');
});

test('natural ended carries the current playback epoch; stale same-revision actions and volume cannot reset it', async t => {
  const { LocalMusicPlayerEngine } = await import('../companion/dist/player/LocalMusicPlayerEngine.js');
  const ended = [], audio = [];
  const engine = new LocalMusicPlayerEngine({ report() {}, ended: value => ended.push(value), createAudio: () => { const track = new AudioFixture(); audio.push(track); return track; },
    createAudioContext: () => ({ sampleRate: 48000, destination: {}, createAnalyser: () => ({ fftSize: 2048, frequencyBinCount: 1024, connect() {}, disconnect() {} }), createMediaElementSource: () => ({ connect() {}, disconnect() {} }), resume: async () => {}, close: async () => {} }), requestFrame: () => 1, cancelFrame: () => {},
  }); t.after(() => engine.dispose());
  engine.update({ ...selection(1, 1), playbackEpoch: 4 }); audio[0].ready(20);
  engine.action({ revision: 1, epoch: 4, action: 'play' }); await tick();
  engine.action({ revision: 1, epoch: 5, action: 'pause' });
  engine.action({ revision: 1, epoch: 4, action: 'play' }); await tick(); assert.equal(audio[0].paused, true, 'late play cannot revive a paused epoch');
  audio[0].ended = true; audio[0].currentTime = 20; audio[0].dispatchEvent(new Event('ended')); assert.equal(ended.length, 0);
  audio[0].ended = false; engine.action({ revision: 1, epoch: 6, action: 'seek', value: 0 }); engine.action({ revision: 1, epoch: 7, action: 'play' }); await tick();
  engine.action({ revision: 1, epoch: 100, action: 'volume', value: .5 });
  audio[0].ended = true; audio[0].currentTime = 20; audio[0].dispatchEvent(new Event('ended'));
  assert.deepEqual(ended, [{ revision: 1, epoch: 7 }], 'volume never changes the natural completion epoch');
});

test('seeking backwards resumes a shorter stem that already ended while the longest kept playing', async t => {
  const f = await fixture(t); f.engine.update(selection()); f.audio[0].ready(10); f.audio[1].ready(20); f.engine.action({ revision: 1, action: 'play' }); await tick();
  f.audio[0].paused = true; f.audio[0].currentTime = 10; f.audio[1].currentTime = 15;
  f.engine.action({ revision: 1, action: 'seek', value: 4 }); await tick();
  assert.equal(f.audio.every(track => track.currentTime === 4 && !track.paused), true);
});
