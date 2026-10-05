const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { setMaxListeners } = require('node:events');
const { test } = require('node:test');

class Element extends EventTarget {
  constructor(document, tag) {
    super(); this.ownerDocument = document; this.tagName = tag; this.dataset = {}; this.attributes = {};
    this.children = []; this.value = ''; this.disabled = false; this.hidden = false; this.text = '';
    this.classList = { toggle: (name, enabled) => { this.ownerDocument.writes++; this.attributes[name] = enabled; } };
  }
  set textContent(value) { this.ownerDocument.writes++; this.text = value; this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw Error('Metadata must never be interpreted as HTML'); }
  addEventListener(type, listener, options) { if (options?.signal) setMaxListeners(0, options.signal); super.addEventListener(type, listener, options); }
  append(...children) {
    this.ownerDocument.writes++;
    for (const child of children) { if (child.parent) child.remove(); child.parent = this; this.children.push(child); }
  }
  remove() { this.ownerDocument.writes++; this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(name, value) { this.ownerDocument.writes++; this.attributes[name] = String(value); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const matches = element => selector.startsWith('#') ? element.id === selector.slice(1)
      : selector.startsWith('.') ? element.className?.split(' ').includes(selector.slice(1))
        : element.tagName === selector;
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  focus() { this.ownerDocument.activeElement = this; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
function fixture() {
  const document = { activeElement: null, writes: 0, createElement(tag) { return new Element(this, tag); } };
  const root = document.createElement('main');
  const html = readFileSync(require.resolve('../companion/ui/index.html'), 'utf8').split('<section id="library-panel"')[1].split('</section>')[0];
  for (const [, tag, id] of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"/g)) {
    const element = document.createElement(tag); element.id = id;
    if (tag === 'select') element.value = html.split(`id="${id}"`)[1].match(/<option value="([^"]+)"/)[1];
    root.append(element);
  }
  const get = selector => root.querySelector(selector);
  const change = (selector, value) => { const element = get(selector); element.value = value; element.dispatchEvent(new Event('change')); };
  const search = value => {
    const element = get('#library-search'); element.value = value; element.dispatchEvent(new Event('input'));
    element.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Enter' }));
  };
  return { document, root, html, get, change, search };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() >= deadline) assert.fail('Library UI did not settle'); await tick(); }
}
const song = (id, extra = {}) => ({ id: String(id), relativePath: `Songs/${id}`, title: `Song ${id}`, artist: 'Artist', charter: 'Creator', format: 'chart', audio: 'missing', ...extra });
const snapshot = (extra = {}) => ({ library: {
  settings: { rootPath: 'C:\\Songs', watch: false, refreshOnStart: true }, status: 'ready', mode: 'full',
  progress: { visited: 101, processed: 101, discovered: 101 }, count: 101, lastScanAt: null,
  changes: { added: 0, removed: 0, modified: 0 }, warningCount: 0, skippedCount: 0, error: null, watcher: 'off', revision: 1, ...extra,
} });
async function setup(t) {
  const { LibraryControls } = await import('../companion/dist/settings/LibraryControls.js');
  const ui = fixture(), calls = [];
  const controls = new LibraryControls({ root: ui.root, command: (name, payload) => new Promise(resolve => calls.push({ name, payload, resolve })) });
  t.after(() => controls.dispose());
  const request = async index => { await waitFor(() => calls.length > index); return calls[index]; };
  const respond = async (index, { items = [song(index)], total = items.length, revision = 1 } = {}) => {
    const call = await request(index);
    call.resolve({ ok: true, result: { items, total, revision, offset: call.payload.offset, limit: 50 } });
    await tick();
  };
  return { ...ui, controls, calls, request, respond };
}

test('library filter controls are labeled, unavailable without a folder, and retain a 50-row page', async t => {
  const ui = await setup(t);
  for (const id of ['library-audio', 'library-duplicates']) {
    assert.match(ui.html, new RegExp(`<label[^>]+for="${id}"`));
    assert.equal(ui.get(`#${id}`).disabled, true);
    assert.equal(ui.get(`#${id}`).value, 'all');
  }
  const options = id => [...ui.html.split(`id="${id}"`)[1].split('</select>')[0].matchAll(/<option value="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(options('library-audio'), ['all', 'missing', 'present', 'unknown']);
  assert.deepEqual(options('library-duplicates'), ['all', 'possible']);
  ui.controls.update(snapshot({ settings: { rootPath: null, watch: false, refreshOnStart: true } }));
  await tick(); assert.equal(ui.calls.length, 0); assert.equal(ui.get('#library-audio').disabled, true);
  ui.controls.update(snapshot());
  const call = await ui.request(0);
  assert.deepEqual({ name: call.name, payload: call.payload }, { name: 'library.query', payload: { query: '', sort: 'title', audio: 'all', duplicates: 'all', offset: 0, limit: 50 } });
  await ui.respond(0, { items: Array.from({ length: 60 }, (_, i) => song(i)), total: 101 });
  assert.equal(ui.get('#library-rows').children.length, 50);
  assert.match(ui.get('#library-page-status').textContent, /1–50 sur 101/);
  assert.equal(ui.get('#library-clear-filters').disabled, true);
});

test('search, sort and both filters combine; changing each filter resets pagination and scan snapshots preserve them', async t => {
  const ui = await setup(t); ui.controls.update(snapshot()); await ui.respond(0, { total: 101 });
  ui.get('#library-next').click(); assert.equal((await ui.request(1)).payload.offset, 50); await ui.respond(1, { total: 101 });
  ui.search('Artist'); ui.change('#library-sort', 'artist'); ui.change('#library-audio', 'missing'); ui.change('#library-duplicates', 'possible');
  assert.deepEqual((await ui.request(2)).payload, { query: 'Artist', sort: 'artist', audio: 'missing', duplicates: 'possible', offset: 0, limit: 50 });
  await ui.respond(2, { total: 101 });
  ui.controls.update(snapshot({ status: 'scanning', progress: { visited: 200, processed: 30, discovered: 20 } }));
  for (const id of ['library-search', 'library-sort', 'library-audio', 'library-duplicates']) assert.equal(ui.get(`#${id}`).disabled, false);
  assert.equal(ui.get('#library-search').value, 'Artist');
  assert.equal(ui.get('#library-audio').value, 'missing'); assert.equal(ui.get('#library-duplicates').value, 'possible');
  await tick(); assert.equal(ui.calls.length, 3, 'scan progress alone must not repeat queries');
  ui.get('#library-next').click(); assert.equal((await ui.request(3)).payload.offset, 50); await ui.respond(3, { total: 101 });
  ui.change('#library-audio', 'present');
  assert.deepEqual((await ui.request(4)).payload, { query: 'Artist', sort: 'artist', audio: 'present', duplicates: 'possible', offset: 0, limit: 50 });
  await ui.respond(4, { total: 101 });
  ui.get('#library-next').click(); await ui.respond(5, { total: 101 });
  ui.change('#library-duplicates', 'all'); assert.equal((await ui.request(6)).payload.offset, 0); await ui.respond(6, { total: 101 });
  ui.change('#library-audio', 'unknown'); assert.equal((await ui.request(7)).payload.audio, 'unknown'); await ui.respond(7, { total: 101 });
  ui.controls.update(snapshot({ revision: 2 }));
  assert.deepEqual((await ui.request(8)).payload, { query: 'Artist', sort: 'artist', audio: 'unknown', duplicates: 'all', offset: 0, limit: 50 });
  await ui.respond(8, { revision: 2, total: 101 });
  ui.get('#library-clear-filters').click();
  assert.deepEqual((await ui.request(9)).payload, { query: 'Artist', sort: 'artist', audio: 'all', duplicates: 'all', offset: 0, limit: 50 });
  await ui.respond(9, { revision: 2 });
  assert.equal(ui.get('#library-search').value, 'Artist'); assert.equal(ui.get('#library-sort').value, 'artist');
  assert.equal(ui.get('#library-audio').value, 'all'); assert.equal(ui.get('#library-duplicates').value, 'all');
  assert.equal(ui.get('#library-clear-filters').disabled, true);
  assert.ok(ui.calls.every(call => call.name === 'library.query'), 'filtering only reads the index');
});

test('late results and errors from superseded filters cannot overwrite the active results', async t => {
  const ui = await setup(t); ui.controls.update(snapshot()); await ui.request(0);
  ui.change('#library-audio', 'missing'); await ui.request(1);
  ui.change('#library-duplicates', 'possible'); await ui.request(2);
  await ui.respond(2, { items: [song('current', { duplicateCount: 2 })] });
  await ui.respond(0, { items: [song('old')] });
  ui.calls[1].resolve({ ok: false }); await tick();
  assert.equal(ui.get('#library-rows').children.length, 1);
  assert.equal(ui.get('#library-rows').children[0].dataset.librarySongId, 'current');
  assert.equal(ui.get('#library-query-retry').hidden, true);
  assert.equal(ui.get('#library-results').attributes['aria-busy'], 'false');
});

test('filtered empty results have a recovery action; duplicate badges remain tentative and update with index revisions', async t => {
  const ui = await setup(t); ui.controls.update(snapshot());
  await ui.respond(0, { items: [song('same', { title: '<img src=x onerror=neverExecute()>', duplicateCount: 2 })] });
  const row = ui.get('#library-rows').children[0], badge = row.querySelector('.library-duplicate-badge');
  assert.equal(row.querySelector('strong').textContent, '<img src=x onerror=neverExecute()>');
  assert.equal(badge.hidden, false); assert.equal(badge.textContent, 'Doublon possible (2)');
  ui.controls.update(snapshot({ revision: 2 })); await ui.respond(1, { items: [song('same', { duplicateCount: 1 })], revision: 2 });
  assert.equal(ui.get('#library-rows').children[0], row); assert.equal(badge.hidden, true); assert.equal(badge.textContent, '');
  ui.change('#library-audio', 'unknown'); ui.change('#library-duplicates', 'possible'); await ui.respond(2, { items: [], revision: 2 });
  assert.equal(ui.get('#library-empty').hidden, false); assert.equal(ui.get('#library-table-container').hidden, true);
  assert.match(ui.get('#library-empty-title').textContent, /ces filtres/);
  assert.match(ui.get('#library-empty-description').textContent, /Réinitialisez/);
  assert.equal(ui.get('#library-clear-filters').disabled, false); assert.equal(ui.get('#library-next').disabled, true);
  ui.search('Other'); await ui.respond(3, { items: [], revision: 2 });
  assert.match(ui.get('#library-empty-description').textContent, /recherche/);
  ui.get('#library-clear-filters').click(); await ui.respond(4, { items: [], revision: 2 });
  assert.match(ui.get('#library-empty-title').textContent, /cette recherche/);
  assert.equal(ui.get('#library-search').value, 'Other');
});

test('a stale index revision retries the active filter, and disposal cancels pending queries and listeners', async t => {
  const ui = await setup(t); ui.controls.update(snapshot()); await ui.respond(0);
  ui.change('#library-audio', 'missing'); ui.change('#library-duplicates', 'possible');
  await ui.respond(1, { revision: 0, items: [song('stale')] });
  assert.equal((await ui.request(2)).payload.audio, 'missing'); assert.equal(ui.calls[2].payload.duplicates, 'possible');
  assert.doesNotMatch(ui.get('#library-rows').textContent, /stale/);
  ui.controls.dispose(); const writes = ui.document.writes;
  await ui.respond(2, { items: [song('too-late')] });
  ui.controls.update(snapshot({ revision: 2 })); ui.change('#library-audio', 'present'); ui.get('#library-clear-filters').click();
  await tick(); assert.equal(ui.calls.length, 3); assert.equal(ui.document.writes, writes);
  const queued = await setup(t); queued.controls.update(snapshot()); queued.controls.dispose();
  await tick(); assert.equal(queued.calls.length, 0, 'disposing before the timer fires cancels the initial request');
});

const variantId = letter => letter.repeat(64);
const comparison = (extra = {}) => ({
  contextId: 'e'.repeat(32), revision: 1, title: '<img src=x onerror=neverExecute()>', artist: 'Artist', charter: 'Creator',
  preferredId: null, selectionError: null, canChoose: true,
  summary: { total: 4, readable: 3, noteGroups: 2, identicalGroups: 1, unverified: 1 },
  variants: ['a', 'b', 'c', 'd'].map((letter, index) => ({
    id: variantId(letter), relativePath: `Songs/<unsafe & path>/${'long path/'.repeat(15)}${letter}`,
    format: index === 3 ? 'sng' : index === 2 ? 'midi' : 'chart', audio: index === 0 ? 'present' : index === 1 ? 'missing' : 'unknown',
    notes: { status: index === 3 ? 'unsupported' : 'readable', format: index === 3 ? null : index === 2 ? 'midi' : 'chart', bytes: index === 3 ? null : 1234, modifiedAt: index === 3 ? null : '2026-10-03T12:30:00.000Z', reason: index === 3 ? 'Archive .sng non comparée.' : null },
    noteGroup: index === 3 ? null : index === 2 ? 2 : 1, identicalCount: index < 2 ? 2 : 1,
  })), ...extra,
});
const card = (ui, letter) => ui.get('#library-comparison-cards').children.find(element => element.dataset.variantId === variantId(letter));
async function openComparison(t, result = comparison()) {
  const ui = await setup(t); ui.controls.update(snapshot());
  await ui.respond(0, { items: [song(variantId('a'), { duplicateCount: 4 }), song(variantId('b'), { duplicateCount: 4 }), song('unique')] });
  ui.get('#library-rows').children[0].querySelector('.library-compare').click();
  const request = await ui.request(1); request.resolve({ ok: true, result }); await tick();
  return ui;
}

test('choosing a version to keep automatically verifies the other copies before cleanup', async t => {
  const ui = await openComparison(t);
  assert.deepEqual(ui.calls[1].payload, { id: variantId('a'), revision: 1 });
  assert.equal(ui.calls[1].name, 'library.compareDuplicates');
  assert.equal(ui.get('#library-comparison').hidden, false);
  assert.equal(ui.get('#library-rows').children[2].querySelector('.library-compare').hidden, true);
  assert.equal(ui.get('#library-comparison-cards').children.length, 4);
  assert.equal(card(ui, 'a').querySelector('h4').textContent, comparison().title);
  assert.equal(card(ui, 'a').querySelector('code').textContent, comparison().variants[0].relativePath);
  assert.match(card(ui, 'a').textContent, /1\s?234 octets/);
  assert.match(card(ui, 'a').textContent, /Notes identiques · groupe 1 \(2 versions\)/);
  assert.match(card(ui, 'c').textContent, /Notes vérifiées · groupe 2/);
  assert.match(card(ui, 'd').textContent, /Format non pris en charge/);
  assert.equal(card(ui, 'd').querySelector('.library-variant-choose').disabled, true);
  assert.match(ui.html, /Aucun fichier n’est supprimé, déplacé ou modifié/);
  assert.match(ui.html, /notes identiques ne prouvent pas que les fichiers audio sont identiques/);
  card(ui, 'b').querySelector('.library-variant-choose').click();
  const choose = await ui.request(2);
  assert.deepEqual({ name: choose.name, payload: choose.payload }, { name: 'library.chooseDuplicate', payload: { contextId: 'e'.repeat(32), revision: 1, id: variantId('b') } });
  assert.equal(card(ui, 'a').querySelector('.library-variant-choose').disabled, true);
  assert.equal(ui.get('#library-comparison').attributes['aria-busy'], 'true');
  choose.resolve({ ok: true, result: { contextId: 'e'.repeat(32), revision: 1, preferredId: variantId('b') } }); await tick();
  const autoPrepare = await ui.request(3);
  assert.deepEqual({ name: autoPrepare.name, payload: autoPrepare.payload }, { name: 'library.prepareCleanup', payload: { contextId: 'e'.repeat(32), revision: 1, keepId: variantId('b') } });
  autoPrepare.resolve({ ok: true, result: cleanupPlan({ keepId: variantId('b'), keep: cleanupTarget('b'), candidates: [cleanupTarget('a', { eligible: true, reason: null })] }) }); await tick();
  assert.equal(card(ui, 'b').querySelector('.library-preferred-badge').hidden, false);
  assert.equal(card(ui, 'a').querySelector('.library-preferred-badge').hidden, true);
  assert.equal(ui.get('#library-comparison-clear').hidden, false);
  assert.equal(cleanupCheck(ui, 'a').checked, true);
  assert.equal(ui.get('#library-cleanup-recycle').textContent, 'Supprimer l’autre version');
  ui.get('#library-comparison-clear').click(); const clear = await ui.request(4);
  assert.deepEqual(clear.payload, { contextId: 'e'.repeat(32), revision: 1, id: null });
  clear.resolve({ ok: true, result: { contextId: 'e'.repeat(32), revision: 1, preferredId: null } }); await tick();
  assert.equal(card(ui, 'b').querySelector('.library-preferred-badge').hidden, true);
  assert.equal(ui.get('#library-comparison-clear').hidden, true);
  card(ui, 'a').querySelector('.library-variant-open').click();
  const open = await ui.request(5); assert.equal(open.name, 'library.openFolder'); assert.deepEqual(open.payload, { id: variantId('a') });
  open.resolve({ ok: true }); await tick();
  ui.get('#library-comparison-close').click();
  assert.equal(ui.get('#library-comparison').hidden, true);
  assert.equal(ui.document.activeElement, ui.get('#library-rows').children[0].querySelector('.library-compare'));
});

test('comparison failures and preference-store failures offer a reload and never claim an unconfirmed choice', async t => {
  const ui = await openComparison(t, comparison({ canChoose: false, selectionError: 'Le fichier des choix est indisponible.' }));
  assert.match(ui.get('#library-comparison-feedback').textContent, /fichier des choix/);
  assert.equal(card(ui, 'a').querySelector('.library-variant-choose').disabled, true);
  ui.get('#library-comparison-retry').click(); const retry = await ui.request(2);
  retry.resolve({ ok: false, error: 'Le dossier est indisponible.' }); await tick();
  assert.equal(ui.get('#library-comparison-cards').children.length, 0);
  assert.match(ui.get('#library-comparison-feedback').textContent, /dossier est indisponible/);
  assert.equal(ui.get('#library-comparison-retry').hidden, false);
  ui.get('#library-comparison-retry').click(); const recovered = await ui.request(3);
  recovered.resolve({ ok: true, result: comparison() }); await tick();
  card(ui, 'a').querySelector('.library-variant-choose').click(); const choose = await ui.request(4);
  choose.resolve({ ok: false, error: 'Les notes ont changé. Rechargez la comparaison.' }); await tick();
  assert.equal(card(ui, 'a').querySelector('.library-preferred-badge').hidden, true);
  assert.equal(card(ui, 'a').querySelector('.library-variant-choose').disabled, true);
  assert.match(ui.get('#library-comparison-feedback').textContent, /notes ont changé/);
  assert.equal(ui.get('#library-comparison-retry').hidden, false);
});

test('comparison survives filters and scan progress; cancelling a scan restores choices without a new comparison', async t => {
  const ui = await openComparison(t), originalCard = card(ui, 'a');
  ui.change('#library-audio', 'missing'); await ui.respond(2, { items: [song(variantId('b'), { duplicateCount: 4 })] });
  assert.equal(card(ui, 'a'), originalCard);
  ui.get('#library-scan-full').click(); const scan = await ui.request(3);
  ui.controls.update(snapshot({ status: 'scanning', progress: { visited: 110, processed: 25, discovered: 20 } }));
  assert.equal(card(ui, 'a'), originalCard);
  assert.equal(card(ui, 'a').querySelector('.library-variant-choose').disabled, true);
  assert.equal(ui.get('#library-comparison-scanning').hidden, false);
  ui.get('#library-cancel').click(); const cancel = await ui.request(4); assert.equal(cancel.name, 'library.cancel');
  cancel.resolve({ ok: true }); await tick();
  ui.controls.update(snapshot({ status: 'cancelled' }));
  assert.equal(card(ui, 'a').querySelector('.library-variant-choose').disabled, true, 'the scan action is still pending');
  scan.resolve({ ok: true }); await tick();
  assert.equal(card(ui, 'a').querySelector('.library-variant-choose').disabled, false);
  assert.equal(ui.get('#library-comparison-scanning').hidden, true);
  assert.equal(ui.get('#library-audio').value, 'missing');
  assert.equal(ui.calls.filter(call => call.name === 'library.compareDuplicates').length, 1);
});

test('closing or superseding a pending comparison prevents late responses and errors from reopening it', async t => {
  const ui = await openComparison(t);
  const rows = ui.get('#library-rows').children;
  rows[0].querySelector('.library-compare').click(); const earlier = await ui.request(2);
  rows[1].querySelector('.library-compare').click(); const newer = await ui.request(3);
  newer.resolve({ ok: true, result: comparison({ contextId: 'f'.repeat(32), title: 'Newest comparison' }) }); await tick();
  earlier.resolve({ ok: false, error: 'Obsolete error' }); await tick();
  assert.equal(card(ui, 'a').querySelector('h4').textContent, 'Newest comparison');
  assert.doesNotMatch(ui.get('#library-comparison-feedback').textContent, /Obsolete/);
  rows[0].querySelector('.library-compare').click(); const closed = await ui.request(4);
  ui.get('#library-comparison-close').click(); closed.resolve({ ok: true, result: comparison() }); await tick();
  assert.equal(ui.get('#library-comparison').hidden, true);
  assert.equal(ui.get('#library-comparison-cards').children.length, 0);
});

test('new revisions and roots invalidate pending comparisons and preference acknowledgements', async t => {
  const ui = await openComparison(t);
  card(ui, 'a').querySelector('.library-variant-choose').click(); const choose = await ui.request(2);
  ui.controls.update(snapshot({ revision: 2 })); await ui.respond(3, { revision: 2, items: [song(variantId('a'), { duplicateCount: 4 })] });
  choose.resolve({ ok: true, result: { contextId: 'e'.repeat(32), revision: 1, preferredId: variantId('a') } }); await tick();
  assert.equal(ui.get('#library-comparison').hidden, true); assert.equal(ui.get('#library-comparison-cards').children.length, 0);
  assert.match(ui.get('#library-feedback').textContent, /bibliothèque a changé/);
  ui.get('#library-rows').children[0].querySelector('.library-compare').click(); const pending = await ui.request(4);
  assert.equal(pending.payload.revision, 2);
  ui.controls.update(snapshot({ revision: 2, settings: { rootPath: 'D:\\Other Songs', watch: false, refreshOnStart: true } })); await ui.respond(5, { revision: 2 });
  pending.resolve({ ok: true, result: comparison({ revision: 2 }) }); await tick();
  assert.equal(ui.get('#library-comparison').hidden, true); assert.equal(ui.get('#library-comparison-cards').children.length, 0);
});

test('a mismatched comparison or choice acknowledgement is rejected, and disposal cancels all comparison listeners', async t => {
  const ui = await openComparison(t, comparison({ revision: 0 }));
  assert.equal(ui.get('#library-comparison-cards').children.length, 0);
  assert.match(ui.get('#library-comparison-feedback').textContent, /périmée/);
  ui.get('#library-comparison-retry').click(); const retry = await ui.request(2);
  retry.resolve({ ok: true, result: comparison() }); await tick();
  card(ui, 'a').querySelector('.library-variant-choose').click(); const choose = await ui.request(3);
  choose.resolve({ ok: true, result: { contextId: 'f'.repeat(32), revision: 1, preferredId: variantId('a') } }); await tick();
  assert.equal(card(ui, 'a').querySelector('.library-preferred-badge').hidden, true);
  ui.get('#library-comparison-retry').click(); const pending = await ui.request(4);
  ui.controls.dispose(); const writes = ui.document.writes;
  pending.resolve({ ok: true, result: comparison() }); await tick();
  ui.get('#library-comparison-close').click(); ui.get('#library-comparison-retry').click();
  ui.get('#library-rows').children[0].querySelector('.library-compare').click(); await tick();
  assert.equal(ui.document.writes, writes); assert.equal(ui.calls.length, 5);
});

const cleanupTarget = (letter, extra = {}) => ({
  id: variantId(letter), relativePath: `Charts/${letter}`, targetRelativePath: `Charts/${letter}`,
  kind: 'folder', bytes: 42000, audio: { status: 'verified', count: 2, bytes: 40000 }, ...extra,
});
const cleanupPlan = (extra = {}) => ({
  planId: 'a'.repeat(32), contextId: 'e'.repeat(32), revision: 1, keepId: variantId('a'), keep: cleanupTarget('a'),
  candidates: [
    cleanupTarget('b', { eligible: true, reason: null }),
    cleanupTarget('c', { eligible: false, reason: 'Fichiers supplémentaires ou métadonnées différents.' }),
    cleanupTarget('d', { kind: 'sng', targetRelativePath: 'Charts/<unsafe & archive>.sng', eligible: true, reason: null }),
  ], ...extra,
});
const cleanupCheck = (ui, letter) => ui.get('#library-cleanup-candidates').children.find(element => element.dataset.cleanupId === variantId(letter))?.querySelector('input');
const checkCleanup = (ui, letter, checked = true) => { const check = cleanupCheck(ui, letter); check.checked = checked; check.dispatchEvent(new Event('change')); };
async function preparedCleanup(t, plan = cleanupPlan()) {
  const ui = await openComparison(t, comparison({ preferredId: variantId('a') }));
  ui.get('#library-cleanup-prepare').click(); const prepare = await ui.request(2);
  prepare.resolve({ ok: true, result: plan }); await tick(); return ui;
}

test('cleanup preselects safe copies while unsafe copies and the keeper remain protected', async t => {
  const initial = await openComparison(t);
  assert.equal(initial.get('#library-cleanup-prepare').hidden, true);
  initial.get('#library-cleanup-prepare').click(); await tick(); assert.equal(initial.calls.length, 2);
  const ui = await preparedCleanup(t);
  assert.deepEqual({ name: ui.calls[2].name, payload: ui.calls[2].payload }, {
    name: 'library.prepareCleanup', payload: { contextId: 'e'.repeat(32), revision: 1, keepId: variantId('a') },
  });
  assert.equal(ui.get('#library-cleanup-plan').hidden, false);
  assert.equal(ui.get('#library-cleanup-keep').querySelector('input'), null);
  assert.match(ui.get('#library-cleanup-keep').textContent, /Version conservée · exclue du nettoyage/);
  assert.equal(ui.get('#library-cleanup-candidates').children.length, 3);
  assert.match(ui.get('#library-cleanup-candidates').textContent, /Dossier entier, avec tout son contenu/);
  assert.match(ui.get('#library-cleanup-candidates').textContent, /Fichier .sng uniquement/);
  assert.equal(ui.get('#library-cleanup-candidates').children[2].querySelector('code').textContent, 'Charts/<unsafe & archive>.sng');
  assert.match(ui.get('#library-cleanup-candidates').textContent, /42\s?000 octets/);
  assert.match(ui.get('#library-cleanup-candidates').textContent, /Audio vérifié · 2 fichier\(s\) · 40\s?000 octets/);
  assert.match(ui.get('#library-cleanup-candidates').textContent, /Fichiers supplémentaires ou métadonnées différents/);
  assert.equal(cleanupCheck(ui, 'b').checked, true, 'safe folder copy is preselected');
  assert.equal(cleanupCheck(ui, 'd').checked, true, 'safe SNG copy is preselected');
  assert.equal(cleanupCheck(ui, 'c').checked, false, 'unsafe copy is never preselected');
  assert.equal(cleanupCheck(ui, 'c').disabled, true);
  checkCleanup(ui, 'c'); assert.equal(cleanupCheck(ui, 'c').checked, false, 'even a dispatched disabled change cannot select an unsafe copy');
  assert.equal(ui.get('#library-cleanup-recycle').disabled, false);
  assert.equal(ui.get('#library-cleanup-recycle').textContent, 'Supprimer les 2 autres versions');
  checkCleanup(ui, 'd', false); assert.equal(ui.get('#library-cleanup-recycle').textContent, 'Supprimer l’autre version');
  ui.get('#library-cleanup-recycle').click(); const recycle = await ui.request(3);
  assert.deepEqual({ name: recycle.name, payload: recycle.payload }, {
    name: 'library.recycleDuplicates', payload: { planId: 'a'.repeat(32), revision: 1, ids: [variantId('b')] },
  });
  assert.equal(ui.get('#library-comparison-close').disabled, true);
  assert.equal(ui.get('#library-cleanup-prepare').disabled, true);
  assert.equal(card(ui, 'b').querySelector('.library-variant-choose').disabled, true);
  ui.get('#library-cleanup-recycle').click(); await tick(); assert.equal(ui.calls.length, 4, 'no repeated execution');
  recycle.resolve({ ok: true, cancelled: true }); await tick();
  assert.match(ui.get('#library-cleanup-result').textContent, /annulé dans la confirmation Windows.*Aucun fichier envoyé/s);
  assert.equal(ui.get('#library-cleanup-plan').hidden, true);
  assert.equal(ui.get('#library-cleanup-recycle').disabled, true);
  assert.equal(ui.get('#library-comparison-close').disabled, false);
  assert.equal(ui.get('#library-cleanup-prepare').disabled, false);
  ui.get('#library-cleanup-prepare').click(); const again = await ui.request(4);
  again.resolve({ ok: true, result: cleanupPlan({ planId: 'b'.repeat(32) }) }); await tick();
  assert.equal(cleanupCheck(ui, 'b').checked, true, 'a fresh verification preselects safe copies again');
  assert.equal(cleanupCheck(ui, 'd').checked, true, 'all safe copies are preselected on a fresh plan');
});

test('missing or unavailable audio remains visibly blocked even if a malformed candidate says eligible', async t => {
  const ui = await preparedCleanup(t, cleanupPlan({ candidates: [
    cleanupTarget('b', { audio: { status: 'missing', count: 0, bytes: 0 }, eligible: true, reason: 'Audio absent.' }),
    cleanupTarget('c', { audio: { status: 'unavailable', count: 1, bytes: 40 }, eligible: false, reason: 'Audio illisible.' }),
  ] }));
  assert.equal(cleanupCheck(ui, 'b').disabled, true); assert.equal(cleanupCheck(ui, 'c').disabled, true);
  assert.match(ui.get('#library-cleanup-candidates').textContent, /Audio absent · 0 fichier\(s\).*Audio absent\./s);
  assert.match(ui.get('#library-cleanup-candidates').textContent, /Audio indisponible.*Audio illisible\./s);
  assert.match(ui.get('#library-comparison-feedback').textContent, /Aucune autre version/);
  assert.equal(ui.get('#library-cleanup-recycle').disabled, true);
});

test('unavailable target summaries remain visible without blocking an eligible peer', async t => {
  const ui = await preparedCleanup(t, cleanupPlan({ candidates: [
    cleanupTarget('b', { eligible: true, reason: null }),
    cleanupTarget('c', { targetRelativePath: null, kind: null, bytes: null, audio: { status: 'unavailable', count: 0, bytes: 0 }, eligible: false, reason: 'Le contenu complet de cette version ne peut pas être vérifié.' }),
  ] }));
  assert.equal(ui.get('#library-cleanup-plan').hidden, false);
  assert.equal(cleanupCheck(ui, 'b').disabled, false); assert.equal(cleanupCheck(ui, 'c').disabled, true);
  const blocked = ui.get('#library-cleanup-candidates').children[1];
  assert.equal(blocked.querySelector('code').textContent, 'Charts/c');
  assert.match(blocked.textContent, /Cible non vérifiée · Taille non vérifiée/);
  assert.match(blocked.textContent, /contenu complet de cette version ne peut pas être vérifié/);
  assert.equal(cleanupCheck(ui, 'b').checked, true);
  assert.equal(ui.get('#library-cleanup-recycle').disabled, false);
  const missingKeeper = await preparedCleanup(t, cleanupPlan({ keep: cleanupTarget('a', { targetRelativePath: null, kind: null, bytes: null }) }));
  assert.equal(missingKeeper.get('#library-cleanup-plan').hidden, false);
  assert.equal(cleanupCheck(missingKeeper, 'b').disabled, true);
  assert.equal(missingKeeper.get('#library-cleanup-recycle').disabled, true);
});

test('changing or clearing the preferred version discards the old plan and automatically prepares the new keeper', async t => {
  const ui = await preparedCleanup(t);
  card(ui, 'c').querySelector('.library-variant-choose').click(); const choose = await ui.request(3);
  assert.equal(ui.get('#library-cleanup-plan').hidden, true);
  choose.resolve({ ok: true, result: { contextId: 'e'.repeat(32), revision: 1, preferredId: variantId('c') } }); await tick();
  const next = await ui.request(4);
  assert.equal(next.name, 'library.prepareCleanup');
  assert.equal(next.payload.keepId, variantId('c'));
  next.resolve({ ok: true, result: cleanupPlan({ keepId: variantId('c'), keep: cleanupTarget('c'), candidates: [cleanupTarget('b', { eligible: true, reason: null })] }) }); await tick();
  assert.equal(cleanupCheck(ui, 'b').checked, true);
  assert.equal(ui.get('#library-cleanup-recycle').textContent, 'Supprimer l’autre version');
  ui.get('#library-comparison-clear').click(); const clear = await ui.request(5);
  assert.equal(ui.get('#library-cleanup-plan').hidden, true);
  clear.resolve({ ok: true, result: { contextId: 'e'.repeat(32), revision: 1, preferredId: null } }); await tick();
  assert.equal(ui.get('#library-cleanup-prepare').hidden, true);
});

test('closing verification and revision or root changes invalidate cleanup plans and late replies', async t => {
  const ui = await openComparison(t, comparison({ preferredId: variantId('a') }));
  ui.get('#library-cleanup-prepare').click(); const closed = await ui.request(2);
  assert.equal(card(ui, 'b').querySelector('.library-variant-choose').disabled, true);
  assert.equal(ui.get('#library-comparison-clear').disabled, true);
  ui.get('#library-comparison-close').click();
  closed.resolve({ ok: true, result: cleanupPlan() }); await tick();
  assert.equal(ui.get('#library-comparison').hidden, true); assert.equal(ui.get('#library-cleanup-plan').hidden, true);
  ui.get('#library-rows').children[0].querySelector('.library-compare').click(); const fresh = await ui.request(3);
  fresh.resolve({ ok: true, result: comparison({ preferredId: variantId('a') }) }); await tick();
  ui.get('#library-cleanup-prepare').click(); const obsolete = await ui.request(4);
  ui.controls.update(snapshot({ revision: 2 })); await ui.respond(5, { revision: 2 });
  obsolete.resolve({ ok: false, error: 'Old preparation failure' }); await tick();
  assert.equal(ui.get('#library-comparison').hidden, true); assert.equal(ui.get('#library-cleanup-plan').hidden, true);
  assert.doesNotMatch(ui.get('#library-comparison-feedback').textContent, /Old preparation/);
  const rootChange = await preparedCleanup(t); checkCleanup(rootChange, 'b');
  rootChange.controls.update(snapshot({ settings: { rootPath: 'D:\\Other Songs', watch: false, refreshOnStart: true } }));
  await rootChange.respond(3); assert.equal(rootChange.get('#library-cleanup-plan').hidden, true);
  rootChange.get('#library-cleanup-recycle').click(); await tick(); assert.equal(rootChange.calls.length, 4);
});

test('a stale, mismatched, or keeper-including cleanup response is rejected and reload clears selection', async t => {
  for (const extra of [
    { revision: 0 }, { contextId: 'f'.repeat(32) }, { keepId: variantId('b') },
    { candidates: [cleanupTarget('a', { eligible: true, reason: null })] },
  ]) {
    const ui = await preparedCleanup(t, cleanupPlan(extra));
    assert.equal(ui.get('#library-cleanup-plan').hidden, true);
    assert.equal(ui.get('#library-cleanup-recycle').disabled, true);
    assert.match(ui.get('#library-comparison-feedback').textContent, /périmé ou invalide/);
    ui.get('#library-comparison-retry').click(); const reload = await ui.request(3);
    reload.resolve({ ok: true, result: comparison({ preferredId: variantId('a') }) }); await tick();
    assert.equal(ui.get('#library-cleanup-plan').hidden, true);
    assert.equal(ui.get('#library-cleanup-prepare').disabled, false);
  }
});

test('partial cleanup reports exact outcomes and stays visible after automatic index refresh', async t => {
  const ui = await preparedCleanup(t); checkCleanup(ui, 'b'); checkCleanup(ui, 'd');
  ui.get('#library-cleanup-recycle').click(); const recycle = await ui.request(3);
  ui.controls.update(snapshot({ status: 'scanning', mode: 'quick' }));
  ui.controls.update(snapshot({ revision: 2, changes: { added: 0, removed: 1, modified: 0 } }));
  await ui.respond(4, { revision: 2, items: [song(variantId('a'), { duplicateCount: 3 })] });
  assert.equal(ui.get('#library-comparison').hidden, true);
  recycle.resolve({ ok: true, result: { recycledIds: [variantId('b')], failed: [{ id: variantId('d'), reason: 'Fichier verrouillé.' }], cancelled: false, refreshRequested: true } }); await tick();
  const result = ui.get('#library-cleanup-result');
  assert.equal(result.hidden, false);
  assert.match(result.textContent, /1 copie\(s\) envoyée\(s\) à la Corbeille Windows/);
  assert.match(result.textContent, /Version conservée : Charts\/a/);
  assert.match(result.textContent, /1 copie\(s\) non envoyée\(s\)/);
  assert.match(result.textContent, /Charts\/<unsafe & archive>\.sng : Fichier verrouillé/);
  assert.match(result.textContent, /Actualisation de la bibliothèque demandée/);
  assert.equal(result.attributes['is-error'], true);
  const retained = result.textContent;
  ui.change('#library-audio', 'missing'); await ui.respond(5, { revision: 2 });
  assert.equal(result.textContent, retained); assert.equal(result.hidden, false);
  assert.equal(ui.get('#library-cleanup-recycle').disabled, true);
});

test('execution cancellation after a partial result never claims that no files moved; disposal ignores all late cleanup writes', async t => {
  const ui = await preparedCleanup(t); checkCleanup(ui, 'b'); checkCleanup(ui, 'd');
  ui.get('#library-cleanup-recycle').click(); const recycle = await ui.request(3);
  recycle.resolve({ ok: true, result: { recycledIds: [variantId('b')], failed: [], cancelled: true, refreshRequested: true } }); await tick();
  assert.match(ui.get('#library-cleanup-result').textContent, /1 copie\(s\) envoyée\(s\).*Opération interrompue/s);
  assert.doesNotMatch(ui.get('#library-cleanup-result').textContent, /Aucun fichier envoyé/);
  assert.equal(ui.get('#library-comparison-retry').hidden, false);
  assert.equal(ui.get('#library-cleanup-prepare').disabled, true);
  const pending = await preparedCleanup(t); checkCleanup(pending, 'b');
  pending.get('#library-cleanup-recycle').click(); const late = await pending.request(3);
  pending.controls.dispose(); const writes = pending.document.writes;
  late.resolve({ ok: true, cancelled: true }); await tick();
  pending.get('#library-cleanup-prepare').click(); pending.get('#library-cleanup-recycle').click();
  assert.equal(pending.document.writes, writes); assert.equal(pending.calls.length, 4);
});


test('global duplicate verification shows progress, refreshes all duplicate rows and labels verified groups', async t => {
  const ui = await setup(t);
  ui.controls.update(snapshot());
  await ui.respond(0, { items: [song('bulk-a', { duplicateCount: 2 })], total: 1 });
  assert.equal(ui.get('#library-verify-all-duplicates').disabled, false);
  ui.get('#library-verify-all-duplicates').click();
  const verify = await ui.request(1);
  assert.equal(verify.name, 'library.verifyAllDuplicates');
  assert.equal(verify.payload, undefined);
  ui.controls.update(snapshot({ duplicateVerification: { running: true, processed: 2, total: 3 } }));
  assert.match(ui.get('#library-verify-all-duplicates').textContent, /2 \/ 3/);
  assert.match(ui.get('#library-verify-all-status').textContent, /2 \/ 3 groupes/);
  assert.equal(ui.get('#library-verify-all-duplicates').disabled, true);
  verify.resolve({ ok: true, result: { revision: 1, totalGroups: 3, readyGroups: 1, needsKeeperGroups: 1, blockedGroups: 1, eligibleCopies: 2 } });
  const refresh = await ui.request(2);
  assert.equal(refresh.name, 'library.query');
  assert.equal(refresh.payload.duplicates, 'possible');
  refresh.resolve({ ok: true, result: { items: [song('bulk-a', { duplicateCount: 2, duplicateVerification: 'ready', verifiedEligibleCopies: 2 })], total: 1, revision: 1, offset: 0, limit: 50 } });
  await tick();
  assert.equal(ui.get('#library-duplicates').value, 'possible');
  assert.match(ui.get('#library-verify-all-status').textContent, /1 groupe\(s\) prêt\(s\).*1 choix de version requis.*1 bloqué\(s\).*2 copie\(s\) vérifiée\(s\)/);
  const badge = ui.get('#library-rows').children[0].querySelector('.library-duplicate-badge');
  assert.match(badge.textContent, /Prêt à nettoyer.*2 copie\(s\) vérifiée\(s\)/);
  assert.equal(badge.dataset.verification, 'ready');
});
