'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const flush = () => new Promise(resolve => setImmediate(resolve));
const preload = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
const source = preload.slice(preload.indexOf('  const hex=value=>{'), preload.indexOf('  const button=document.createElement'));
async function fixture(respond) {
  const events = new Map(), windowEvents = new Map(), documentEvents = new Map(), timers = new Map(), calls = [];
  const values = new Map([['--blue', '#49bbff'], ['--purple', '#8768ff'], ['--ch-bloom-color', '#00ff11']]);
  let sequence = 0, observer;
  const root = { dataset: { theme: 'dark', chBloomFollowSeason: 'false' }, hasAttribute: () => false };
  const document = { documentElement: root, hidden: false, addEventListener: (name, handler) => documentEvents.set(name, handler), removeEventListener: name => documentEvents.delete(name) };
  const context = { document, outline: { style: {} }, caption: null, getComputedStyle: () => ({ getPropertyValue: name => values.get(name) || '' }), queueMicrotask,
    setTimeout: (handler, ms) => { const id = ++sequence; timers.set(id, { handler, ms }); return id; }, clearTimeout: id => timers.delete(id),
    MutationObserver: class { constructor(handler) { observer = { handler, disconnected: false }; } observe() {} disconnect() { observer.disconnected = true; } },
    window: { addEventListener: (name, handler) => windowEvents.set(name, handler), removeEventListener: name => windowEvents.delete(name) },
    ipcRenderer: { on: (name, handler) => events.set(name, handler), removeListener: name => events.delete(name), invoke: async (name, payload) => { calls.push({ name, payload }); return respond(payload); } }
  };
  vm.runInNewContext(source, context); await flush();
  return { calls, timers, values, events, windowEvents, documentEvents, observer, async tick() { const [id, timer] = timers.entries().next().value || []; if (timer) { timers.delete(id); timer.handler(); await flush(); } }, async mutate() { observer.handler(); await flush(); } };
}
test('a temporarily rejected palette is retried unchanged and deduped only after acknowledgement', async () => {
  let locked = true;
  const f = await fixture(() => locked ? null : { color: '#111111', symbolColor: '#ffffff', accent: '#49bbff' });
  assert.equal(f.calls.length, 1); assert.equal(f.timers.size, 1);
  locked = false; await f.tick(); assert.equal(f.calls.length, 2);
  assert.equal(JSON.stringify(f.calls[0].payload), JSON.stringify(f.calls[1].payload)); assert.equal(f.timers.size, 0);
  await f.mutate(); assert.equal(f.calls.length, 2);
});
test('temporary retry is bounded and native resume retries after exhaustion without a DOM change', async () => {
  let locked = true;
  const f = await fixture(() => locked ? null : { color: '#111111', symbolColor: '#ffffff', accent: '#49bbff' });
  for (let n = 0; n < 10; n++) await f.tick();
  assert.equal(f.calls.length, 7); assert.equal(f.timers.size, 0);
  locked = false; f.events.get('chartshub:ui-palette-resume')(); await flush();
  assert.equal(f.calls.length, 8); assert.equal(f.timers.size, 0);
  await f.mutate(); assert.equal(f.calls.length, 8);
});
test('page navigation clears retry timers and native listeners; late replies cannot restart work', async () => {
  const f = await fixture(() => null); assert.equal(f.timers.size, 1);
  f.windowEvents.get('pagehide')({ persisted: false }); await flush();
  assert.equal(f.timers.size, 0); assert.equal(f.events.size, 0); assert.equal(f.observer.disconnected, true);
  await f.mutate(); await f.tick(); assert.equal(f.calls.length, 1);
  let resolve;
  const pending = await fixture(() => new Promise(done => { resolve = done; }));
  pending.windowEvents.get('pagehide')({ persisted: false }); resolve(null); await flush();
  assert.equal(pending.timers.size, 0); assert.equal(pending.calls.length, 1);
});
test('back-forward restoration resumes a suspended page and sends the latest palette', async () => {
  const f = await fixture(() => ({ color: '#111111', symbolColor: '#ffffff', accent: '#49bbff' }));
  f.windowEvents.get('pagehide')({ persisted: true }); f.values.set('--blue', '#ff0000'); await f.mutate(); assert.equal(f.calls.length, 1);
  f.windowEvents.get('pageshow')({ persisted: true }); await flush();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].payload.colors.accent, '#ff0000');
});
