'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

class Element extends EventTarget {
  constructor(tag, document) { super(); Object.assign(this, { tagName: tag, ownerDocument: document, children: [], open: false, disabled: false, hidden: false, checked: false, textContent: '', value: '', attributes: {} }); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(key, value) { this.attributes[key] = value; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
const id = number => number.toString(16).padStart(64, '0'), rootKey = 'a'.repeat(64), planId = '12345678-1234-4234-8234-123456789abc';
const item = index => ({ id: id(index), title: 'Signal ' + index, artist: 'Groupe Exemple', album: 'Album Démo', relativePath: 'Collection/Signal ' + index + '/notes.chart' });
const snapshot = (patch = {}, language = 'fr') => ({ language, library: { settings: { rootPath: 'C:/Synthetic/Songs' }, status: 'ready', revision: 1, bulkCleanup: null, selectedRemoval: { phase: 'idle', processed: 0, total: 0 }, ...patch } });
const page = (offset = 0, total = 100000, patch = {}) => ({ rootKey, revision: 1, total, offset, limit: 50, items: Array.from({ length: Math.min(50, Math.max(0, total - offset)) }, (_, index) => item(index + offset + 1)), ...patch });
const plan = (ids, patch = {}) => ({ planId, rootKey, revision: 1, count: ids.length, eligibleCount: ids.length, blockedCount: 0, totalBytes: ids.length * 1024,
  entries: ids.slice(0, 50).map(value => ({ ...item(Number.parseInt(value, 16)), id: value, targetRelativePath: 'Collection/Signal ' + Number.parseInt(value, 16), bytes: 1024, eligible: true, blocked: null })), previewTruncated: ids.length > 50, ...patch });
const text = node => node.textContent + ' ' + node.children.map(text).join(' ');
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };
async function fixture(custom) {
  const calls = [], document = { createElement: tag => new Element(tag, document) }, root = document.createElement('details');
  const command = async (name, payload) => { calls.push([name, payload]); if (custom) { const response = custom(name, payload); if (response !== undefined) return response; }
    if (name === 'library.selectedRemovalQuery') return { ok: true, result: page(payload.offset) };
    if (name === 'library.selectedRemovalIds') return { ok: true, result: { rootKey, revision: 1, total: 100000, ids: Array.from({ length: 1000 }, (_, i) => id(i + 1)), truncated: true } };
    if (name === 'library.prepareSelectedRemoval') return { ok: true, result: plan(payload.ids) };
    if (name === 'library.recycleSelectedRemoval') return { ok: true, result: { recycledIds: [id(1)], failed: [], cancelled: false, refreshRequested: true } };
    return { ok: true };
  };
  const { LibraryRemovalControls } = await import('../companion/ui/library-removal-controls.js');
  const controls = new LibraryRemovalControls({ root, command }); controls.update(snapshot());
  const open = async () => { root.open = true; root.dispatchEvent(new Event('toggle')); await settle(); };
  return { controls, calls, root, open };
}

test('removal is collapsed and local inventory is queried only after opening', async () => {
  const { controls, root, calls, open } = await fixture(); assert.equal(root.open, false); assert.deepEqual(calls, []);
  for (let i = 0; i < 100; i++) controls.update({ ...snapshot(), state: { performance: { hits: i } } });
  assert.deepEqual(calls, []); await open();
  assert.deepEqual(calls, [['library.selectedRemovalQuery', { query: '', artist: '', album: '', offset: 0, limit: 50 }]]);
  assert.equal(controls.nodes.list.children.length, 50); assert.match(controls.nodes.pageText.textContent, /2.?000/);
  assert.match(controls.nodes.history.textContent, /jamais jouées.*indisponible/);
});

test('100000-chart paging and artist or album searches keep off-page selection', async () => {
  const { controls, calls, open } = await fixture(); await open(); await controls.run('selectPage');
  await controls.run('next'); controls.select(id(51), true); assert.equal(controls.selected.size, 51);
  controls.inputs.artist.value = 'groupe'; controls.inputs.album.value = 'album'; controls.inputs.search.value = 'signal'; controls.offset = 0; await controls.search();
  assert.deepEqual(calls.at(-1), ['library.selectedRemovalQuery', { query: 'signal', artist: 'groupe', album: 'album', offset: 0, limit: 50 }]);
  assert.equal(controls.selected.size, 51); assert.equal(controls.checks.get(id(1)).checked, true); assert.equal(controls.selected.has(id(51)), true);
  assert.equal(controls.nodes.list.children.length, 50);
});

test('selecting all filtered results is bounded to1000 and clearly reports truncation', async () => {
  const { controls, calls, open } = await fixture(); await open(); await controls.selectResults();
  assert.equal(controls.selected.size, 1000); assert.match(controls.nodes.status.textContent, /1 000 premiers résultats/);
  assert.equal(controls.nodes.selectPage.disabled, true); assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['library.selectedRemovalIds', { query: '', artist: '', album: '' }]);
});

test('review contains exact selected IDs and final recycling uses only the immutable plan token', async () => {
  const { controls, calls, open } = await fixture(); await open(); controls.select(id(1), true); controls.select(id(2), true);
  await controls.prepare();
  assert.deepEqual(calls.at(-1), ['library.prepareSelectedRemoval', { ids: [id(1), id(2)], rootKey, revision: 1 }]);
  assert.equal(calls.some(([name]) => name.includes('recycle')), false); assert.equal(controls.nodes.preview.hidden, false);
  assert.match(controls.nodes.previewSummary.textContent, /^2 .*vérifiée/); assert.match(controls.nodes.previewSize.textContent, /2 Kio/);
  assert.equal(controls.nodes.recycle.disabled, false); assert.equal(controls.nodes.clear.disabled, true);
  await controls.recycle(); await settle();
  assert.deepEqual(calls.find(([name]) => name === 'library.recycleSelectedRemoval'), ['library.recycleSelectedRemoval', { planId, rootKey, revision: 1 }]);
  assert.equal(controls.selected.size, 0); assert.match(controls.nodes.status.textContent, /1 chart\(s\) envoyée/);
});

test('unverifiable selections show preserved items and never offer final recycling', async () => {
  const { controls, calls, open } = await fixture((name, payload) => name === 'library.prepareSelectedRemoval' ? { ok: true, result: plan(payload.ids, {
    eligibleCount: 0, blockedCount: payload.ids.length, totalBytes: 0, entries: payload.ids.map(value => ({ ...item(1), id: value, eligible: false, bytes: null, targetRelativePath: null, blocked: 'changed' })) }) } : undefined);
  await open(); controls.select(id(1), true); await controls.prepare(); assert.equal(controls.nodes.recycle.disabled, true); assert.match(controls.nodes.status.textContent, /fichiers sont conservés/);
  await controls.run('recycle'); assert.equal(calls.some(([name]) => name.includes('recycle')), false);
  assert.match(text(controls.nodes.previewItems), /Conservée/);
});

test('native confirmation cancellation preserves selected charts and clears the review', async () => {
  const { controls, open } = await fixture(name => name === 'library.recycleSelectedRemoval' ? { ok: true, cancelled: true } : undefined);
  await open(); controls.select(id(1), true); await controls.prepare(); await controls.recycle();
  assert.equal(controls.selected.size, 1); assert.equal(controls.plan, null); assert.match(controls.nodes.status.textContent, /annulée/);
});

test('a revision change invalidates selection, proof and stale asynchronous queries', async () => {
  const held = deferred(); let count = 0;
  const { controls, root, open } = await fixture((name, payload) => name === 'library.selectedRemovalQuery' && ++count === 2 ? held.promise : undefined);
  await open(); controls.select(id(1), true); await controls.prepare(); assert.ok(controls.plan);
  controls.update(snapshot({ revision: 2, status: 'scanning' })); assert.equal(controls.selected.size, 0); assert.equal(controls.plan, null); assert.equal(controls.nodes.recycle.disabled, true);
  root.open = false; controls.update(snapshot({ revision: 2 })); const pending = controls.search();
  controls.update(snapshot({ revision: 3, status: 'scanning' })); held.resolve({ ok: true, result: page(0, 100000, { revision: 2 }) }); await pending;
  assert.equal(controls.page, null); assert.equal(controls.model.revision, 3);
});

test('cancelling an in-flight review ignores its late proof and keeps the selection', async () => {
  const held = deferred(), { controls, calls, open } = await fixture(name => name === 'library.prepareSelectedRemoval' ? held.promise : undefined);
  await open(); controls.select(id(1), true); const prepare = controls.prepare(); await controls.cancel();
  held.resolve({ ok: true, result: plan([id(1)]) }); await prepare;
  assert.equal(controls.plan, null); assert.equal(controls.pending, null); assert.equal(controls.selected.size, 1);
  assert.deepEqual(calls.at(-1), ['library.cancelSelectedRemoval', {}]);
});

test('an index commit during recycling accepts only the submitted root and shows the final result', async () => {
  const held = deferred(), { controls, open, root } = await fixture(name => name === 'library.recycleSelectedRemoval' ? held.promise : undefined);
  await open(); controls.select(id(1), true); await controls.prepare(); const pending = controls.recycle();
  root.open = false; controls.update(snapshot({ revision: 2 }));
  held.resolve({ ok: true, result: { recycledIds: [id(1)], failed: [], cancelled: false, refreshRequested: true } }); await pending;
  assert.equal(controls.pending, null); assert.match(controls.nodes.status.textContent, /1 chart\(s\) envoyée/);
});

test('stopping recycling explains that completed moves stay in the Recycle Bin', async () => {
  const held = deferred(), { controls, open } = await fixture(name => name === 'library.recycleSelectedRemoval' ? held.promise : undefined);
  await open(); controls.select(id(1), true); await controls.prepare(); const pending = controls.recycle(); await controls.cancel();
  held.resolve({ ok: true, result: { recycledIds: [id(1)], failed: [], cancelled: true } }); await pending;
  assert.equal(controls.plan, null); assert.match(controls.nodes.status.textContent, /déjà déplacés restent dans la Corbeille/);
});

test('bulk transfers and other cleanup operations block selection without losing it', async () => {
  const { controls, open, calls } = await fixture(); await open(); controls.select(id(1), true);
  controls.update(snapshot({ downloadBatchActive: true })); await controls.prepare(); assert.equal(controls.nodes.prepare.disabled, true); assert.equal(calls.length, 1);
  controls.update(snapshot({ bulkCleanup: { phase: 'preparing' } })); assert.equal(controls.nodes.prepare.disabled, true);
  controls.update(snapshot()); assert.equal(controls.nodes.prepare.disabled, false); assert.equal(controls.selected.size, 1);
});

test('unrelated live gameplay updates do not rewrite selection DOM or query the index', async () => {
  const { controls, open, calls } = await fixture(); await open(); let writes = 0;
  function watch(node) { for (const key of ['textContent', 'disabled', 'hidden', 'checked', 'value']) { let current = node[key]; Object.defineProperty(node, key, { get: () => current, set: value => { writes++; current = value; } }); }
    const set = node.setAttribute; node.setAttribute = function (...args) { writes++; set.apply(this, args); }; node.children.forEach(watch); }
  watch(controls.root); for (let i = 0; i < 1000; i++) controls.update({ ...snapshot(), state: { performance: { hits: i } } });
  assert.equal(writes, 0); assert.equal(calls.length, 1);
});

test('foreign IDs in query, proof or final results fail closed without exposing raw backend errors', async () => {
  const { controls, open } = await fixture(name => name === 'library.prepareSelectedRemoval' ? { ok: true, result: plan([id(999)]) } : undefined);
  await open(); controls.select(id(1), true); await controls.prepare(); assert.equal(controls.plan, null); assert.match(controls.nodes.status.textContent, /nouvelle vérification/);
  const bad = await fixture(name => name === 'library.selectedRemovalQuery' ? { ok: false, error: 'C:/PRIVATE/provider-token.txt' } : undefined); await bad.open();
  assert.equal(bad.controls.page, null); assert.doesNotMatch(text(bad.root), /PRIVATE|provider-token/);
});

test('both languages explain reviewed folder removal and unavailable played history', async () => {
  const { controls, open } = await fixture(); await open(); controls.update(snapshot({}, 'en'));
  assert.match(controls.nodes.summary.textContent, /Free up space/); assert.match(controls.nodes.history.textContent, /never played.*unavailable/);
  assert.match(controls.nodes.trashHelp.textContent, /empty it yourself/); assert.equal(controls.nodes.list.children.length, 50);
  controls.update(snapshot()); assert.match(controls.nodes.summary.textContent, /Libérer/);
});

test('dispose ignores pending work and disables all button event listeners', async () => {
  const held = deferred(), { controls, root, calls } = await fixture(name => name === 'library.selectedRemovalQuery' ? held.promise : undefined);
  root.open = true; const pending = controls.search(); controls.dispose(); held.resolve({ ok: true, result: page() }); await pending;
  root.dispatchEvent(new Event('toggle')); controls.nodes.selectResults.click(); assert.equal(calls.length, 1); assert.equal(controls.page, null);
});

test('removal progress updates its independent panel while library index changes still reconcile globally', async () => {
  const { controlSnapshotSignature } = await import('../companion/ui/panel-snapshot.js');
  const before = { ...snapshot(), state: { performance: null } }, after = { ...before, library: { ...before.library, selectedRemoval: { phase: 'preparing', processed: 500, total: 1000 } } };
  assert.equal(controlSnapshotSignature(before), controlSnapshotSignature(after));
  assert.notEqual(controlSnapshotSignature(before), controlSnapshotSignature({ ...after, library: { ...after.library, revision: 2 } }));
  const source = fs.readFileSync(path.join(__dirname, '../companion/ui/panel.js'), 'utf8');
  assert(source.indexOf('libraryRemovalControls.update(snapshot)') < source.indexOf('const measurementsOnly ='));
  assert.match(source, /libraryRemovalControls\.dispose\(\)/);
});
