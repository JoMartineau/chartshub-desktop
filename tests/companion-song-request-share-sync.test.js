'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSongRequestShareSync, songRequestShareKey } = require('../companion/song-request-share-sync.cjs');
const idle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function clock() {
  let now = 0, id = 0; const jobs = new Map();
  return { setTimer: (callback, delay) => { const key = ++id; jobs.set(key, { callback, due: now + delay }); return key; },
    clearTimer: key => jobs.delete(key), size: () => jobs.size,
    async advance(delay) { const until = now + delay;
      for (;;) { const next = [...jobs].filter(([, job]) => job.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break; now = next[1].due; jobs.delete(next[0]); next[1].callback(); await idle(); }
      now = until; await idle();
    } };
}
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(options = {}) {
  const state = { active: true, ready: true, published: true, key: 'one' }, time = clock(), calls = [], cancelled = [];
  const sync = createSongRequestShareSync({ ...time, debounceMs: 100, retryDelays: [200, 400], context: () => state,
    publish: () => { calls.push(state.key); return options.publish?.() ?? { ok: true }; }, cancel: () => { cancelled.push(state.key); options.cancel?.(); } });
  return { state, time, calls, cancelled, sync };
}

test('private libraries never publish from startup, scans, progress or language updates', async () => {
  const f = fixture(); f.state.published = false; f.sync.resume();
  for (let index = 0; index < 20; index++) { f.state.key = String(index); f.sync.update(); }
  await f.time.advance(10000); assert.deepEqual(f.calls, []); assert.equal(f.time.size(), 0); assert.equal(f.sync.status().enabled, false);
});

test('committed changes coalesce and unchanged revisions never upload the same content again', async () => {
  const f = fixture(); f.sync.resume({ synchronized: 'one' });
  for (let index = 0; index < 20; index++) f.sync.update();
  await f.time.advance(1000); assert.deepEqual(f.calls, []);
  f.state.key = 'two'; f.sync.update(); await f.time.advance(50);
  f.state.key = 'three'; f.sync.update(); await f.time.advance(50); assert.deepEqual(f.calls, []);
  await f.time.advance(50); assert.deepEqual(f.calls, ['three']);
  f.sync.update(); await f.time.advance(1000); assert.deepEqual(f.calls, ['three']); assert.equal(f.sync.status().pending, false);
});

test('a changed root or a scan aborts the old publication and waits for the latest ready snapshot', async () => {
  const gate = deferred(), f = fixture({ publish: () => gate.promise }); f.sync.resume(); await f.time.advance(100);
  assert.deepEqual(f.calls, ['one']); f.state.ready = false; f.state.key = 'new-root'; f.sync.update();
  assert.deepEqual(f.cancelled, ['new-root']);
  gate.resolve({ ok: true }); await idle(); await f.time.advance(1000); assert.deepEqual(f.calls, ['one']);
  f.state.ready = true; f.sync.update(); await f.time.advance(100); assert.deepEqual(f.calls, ['one', 'new-root']);
});

test('new metadata during an upload cancels it and only schedules one replacement', async () => {
  const gate = deferred(); let count = 0;
  const f = fixture({ publish: () => ++count === 1 ? gate.promise : { ok: true } });
  f.sync.resume(); await f.time.advance(100); f.state.key = 'new-rules'; f.sync.update(); f.sync.update();
  assert.equal(f.cancelled.length, 1); gate.resolve({ ok: true }); await idle();
  await f.time.advance(100); assert.deepEqual(f.calls, ['one', 'new-rules']); assert.equal(f.sync.status().pending, false);
});

test('reverting to the previous key repairs an uncertain late commit instead of assuming it is still synchronized',async()=>{
  const gate=deferred();let remote='one',count=0;
  const f=fixture({publish:()=>{
    const desired=f.state.key;
    if(++count===1)return gate.promise.then(()=>{remote=desired;return {ok:false,error:'SHARE_CANCELLED'};});
    remote=desired;return {ok:true};
  }});
  f.sync.resume({synchronized:'one'});f.state.key='two';f.sync.update();await f.time.advance(100);
  f.state.key='one';f.sync.update();assert.equal(f.cancelled.length,1);assert.equal(f.sync.status().pending,true);
  gate.resolve();await idle();assert.equal(remote,'two','an already accepted server commit can finish despite local cancellation');
  await f.time.advance(100);assert.equal(remote,'one');assert.deepEqual(f.calls,['two','one']);assert.equal(f.sync.status().pending,false);
});

test('transient failures retry a bounded number of times and terminal errors wait for a new change', async () => {
  const f = fixture({ publish: () => ({ ok: false, error: 'SHARE_NETWORK' }) }); f.sync.resume();
  await f.time.advance(100); assert.equal(f.sync.status().retrying, true);
  await f.time.advance(200); await f.time.advance(400); await f.time.advance(10000);
  assert.equal(f.calls.length, 3); assert.equal(f.sync.status().pending, false); assert.equal(f.time.size(), 0);
  f.state.key = 'two'; f.sync.update(); await f.time.advance(100); assert.equal(f.calls.length, 4);
  await f.sync.pause();
  const terminal = fixture({ publish: () => ({ ok: false, error: 'SHARE_ACCESS_DENIED' }) }); terminal.sync.resume();
  await terminal.time.advance(10000); assert.equal(terminal.calls.length, 1); assert.equal(terminal.time.size(), 0);
});

test('withdrawal, logout and closing fence late completions and never resurrect sharing', async () => {
  for (const reason of ['withdraw', 'logout', 'close']) {
    const gate = deferred(), f = fixture({ publish: () => gate.promise }); f.sync.resume(); await f.time.advance(100);
    const paused = f.sync.pause({ forget: reason !== 'close' });
    if (reason === 'withdraw') f.state.published = false; else f.state.active = false;
    f.state.key = 'late'; f.sync.update(); gate.resolve({ ok: true }); await paused; await f.time.advance(10000);
    assert.deepEqual(f.calls, ['one']); assert.equal(f.sync.status().enabled, false); assert.equal(f.time.size(), 0);
  }
});

test('content keys ignore order and scan revisions but include root, metadata fingerprints and rules', () => {
  const rules = { maxDurationMinutes: null, instrument: 'all', difficulty: 'all' };
  const index = { rootKey: 'root', revision: 1, items: [{ id: 'b', fingerprint: 'file-b', title: 'B' }, { id: 'a', fingerprint: 'file-a', title: 'A' }] };
  const key = songRequestShareKey(index, rules);
  assert.equal(songRequestShareKey({ ...index, revision: 99, items: [...index.items].reverse() }, rules), key);
  for (const changed of [ { ...index, rootKey: 'new-root' }, { ...index, items: [{ ...index.items[0], fingerprint: 'changed-ini-instruments-duration' }, index.items[1]] },
    { ...index, items: [{ ...index.items[0], tracks: [{ instrument: 'drums', difficulty: 'expert' }], durationMs: 1234 }, index.items[1]] },
    { ...index, items: [{ ...index.items[0], title: 'Renamed' }, index.items[1]] }, { ...index, items: [index.items[0]] } ]) {
    assert.notEqual(songRequestShareKey(changed, rules), key);
  }
  assert.notEqual(songRequestShareKey(index, { ...rules, instrument: 'guitar' }), key);
  assert.equal(songRequestShareKey({ items: [] }, rules), null);
});

module.exports = { clock };
