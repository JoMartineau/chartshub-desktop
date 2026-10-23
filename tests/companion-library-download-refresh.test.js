'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { createLibraryDownloadRefresh } = require('../companion/library-download-refresh.cjs');
const idle = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const root = path.resolve('SyntheticSongs'), state = { active: true, ready: true, scanning: false, revision: 1, busy: false, root, lifecycle: 1 }, calls = [];
  let callback = null;
  const refresh = createLibraryDownloadRefresh({ context: () => state, scan: () => calls.push(state.root),
    setTimer: fn => { callback = fn; return 1; }, clearTimer: () => { callback = null; } });
  const item = (id, status = 'Completed', destination = path.join(root, id)) => ({ id, state: status, destination });
  return { state, calls, refresh, item, pending: () => !!callback, async fire() { const fn = callback; callback = null; fn?.(); await idle(); } };
}
test('old download history never starts a scan, newly completed Songs downloads coalesce without watch', async () => {
  const f = fixture(); f.refresh.observe({ items: [f.item('old')] }); assert.equal(f.pending(), false);
  f.refresh.observe({ items: [f.item('old'), f.item('new', 'Downloading')] }); assert.equal(f.pending(), false);
  f.refresh.observe({ items: [f.item('old'), f.item('new')] }); assert.equal(f.pending(), true);
  f.refresh.observe({ items: [f.item('old'), f.item('new'), f.item('second')] }); await f.fire();
  assert.deepEqual(f.calls, [f.state.root]);
  f.refresh.observe({ items: [f.item('old'), f.item('new'), f.item('second')] }); assert.equal(f.pending(), false);
});
test('downloads outside Songs never scan and do not escape through relative path prefixes', async () => {
  const f = fixture(); f.refresh.observe({ items: [] });
  for (const destination of [path.resolve('OtherSongs', 'new'), f.state.root + '-sibling' + path.sep + 'new', path.dirname(f.state.root), f.state.root]) {
    f.refresh.observe({ items: [f.item('new-' + destination, 'Completed', destination)] });
  }
  await f.fire(); assert.deepEqual(f.calls, []);
});
test('scan and cleanup activity defer refresh until the library becomes ready', async () => {
  const f = fixture(); f.refresh.observe({ items: [] }); f.state.ready = false; f.refresh.observe({ items: [f.item('new')] });
  assert.equal(f.pending(), false); f.state.ready = true; f.state.busy = true; f.refresh.update(); assert.equal(f.pending(), false);
  f.state.busy = false; f.refresh.update(); assert.equal(f.pending(), true); await f.fire(); assert.equal(f.calls.length, 1);
});
test('closing, stopping or selecting a different root cancels delayed download scans', async () => {
  for (const reason of ['inactive', 'lifecycle', 'root', 'stop']) {
    const f = fixture(); f.refresh.observe({ items: [] }); f.refresh.observe({ items: [f.item('new')] }); assert.equal(f.pending(), true);
    if (reason === 'inactive') f.state.active = false;
    else if (reason === 'lifecycle') f.state.lifecycle++;
    else if (reason === 'root') f.state.root = path.resolve('NewSyntheticSongs');
    else f.refresh.stop();
    await f.fire(); assert.deepEqual(f.calls, []);
  }
});

test('a successful watcher scan that starts after completion absorbs the pending download scan',async()=>{
  const f=fixture();f.refresh.observe({items:[]});f.refresh.observe({items:[f.item('new')]});assert.equal(f.pending(),true);
  f.state.ready=false;f.state.scanning=true;f.refresh.update();assert.equal(f.pending(),false);
  f.state.revision++;f.state.ready=true;f.state.scanning=false;f.refresh.update();
  assert.equal(f.pending(),false);await f.fire();assert.deepEqual(f.calls,[]);
});

test('a scan already running at completion cannot absorb the newly finished download',async()=>{
  const f=fixture();f.refresh.observe({items:[]});f.state.ready=false;f.state.scanning=true;f.refresh.observe({items:[f.item('new')]});
  f.state.revision++;f.state.ready=true;f.state.scanning=false;f.refresh.update();assert.equal(f.pending(),true);
  await f.fire();assert.equal(f.calls.length,1);
});

test('an aborted scan never consumes a pending download and a later successful scan may absorb it',async()=>{
  const f=fixture();f.refresh.observe({items:[]});f.refresh.observe({items:[f.item('new')]});
  f.state.ready=false;f.state.scanning=true;f.refresh.update();f.state.scanning=false;f.refresh.update();
  assert.equal(f.pending(),false); // Cancelled/unready: keep intent without scanning in a loop.
  f.state.ready=true;f.refresh.update();assert.equal(f.pending(),true,'no committed revision has covered the new download');
  f.state.ready=false;f.state.scanning=true;f.refresh.update();f.state.revision++;f.state.ready=true;f.state.scanning=false;f.refresh.update();
  assert.equal(f.pending(),false);await f.fire();assert.deepEqual(f.calls,[]);
});

test('an index cleanup after a cancelled scan cannot pretend that it scanned a completed download',async()=>{
  const f=fixture();f.refresh.observe({items:[]});f.refresh.observe({items:[f.item('new')]});
  f.state.ready=false;f.state.scanning=true;f.refresh.update();
  f.state.ready=true;f.state.scanning=false;f.refresh.update();assert.equal(f.pending(),true,'cancelled scan did not commit');
  f.state.revision++;f.refresh.update();assert.equal(f.pending(),true,'cleanup revision is not a successful scan');
  await f.fire();assert.equal(f.calls.length,1);
});
