const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { setMaxListeners } = require('node:events');
const { test } = require('node:test');
const { createHash } = require('node:crypto');

class Element extends EventTarget {
  constructor(document, tag) {
    super(); this.ownerDocument = document; this.tagName = tag; this.dataset = {}; this.attributes = {};
    this.children = []; this.value = ''; this.disabled = false; this.hidden = false; this.text = '';
    this.scrollTop = 0; this.clientHeight = 0; this.scrollHeight = 0;
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
  scrollIntoView() { this.scrollCount = (this.scrollCount ?? 0) + 1; }
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
const song = (id, extra = {}) => ({ id: /^[a-f0-9]{64}$/.test(String(id)) ? String(id) : createHash('sha256').update(String(id)).digest('hex'), relativePath: `Songs/${id}`, title: `Song ${id}`, artist: 'Artist', charter: 'Creator', format: 'chart', audio: 'missing', ...extra });
const snapshot = (extra = {}) => ({ library: {
  settings: { rootPath: 'C:\\Songs', watch: false, refreshOnStart: true }, status: 'ready', mode: 'full',
  progress: { visited: 101, processed: 101, discovered: 101 }, count: 101, lastScanAt: null,
  changes: { added: 0, removed: 0, modified: 0 }, warningCount: 0, skippedCount: 0, error: null, watcher: 'off', revision: 1, ...extra,
} });
async function setup(t, observe = false) {
  const { LibraryControls } = await import('../companion/dist/settings/LibraryControls.js');
  const ui = fixture(), calls = [];
  const observers = [];
  if (observe) {
    const previous = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(callback, options) { this.callback = callback; this.options = options; observers.push(this); }
      observe(target) { this.target = target; }
      disconnect() { this.disconnected = true; }
      emit(isIntersecting) { this.callback([{ target: this.target, isIntersecting }]); }
    };
    t.after(() => { if (previous === undefined) delete globalThis.IntersectionObserver; else globalThis.IntersectionObserver = previous; });
  }
  const controls = new LibraryControls({ root: ui.root, command: (name, payload) => new Promise(resolve => calls.push({ name, payload, resolve })) });
  t.after(() => controls.dispose());
  const request = async index => { await waitFor(() => calls.length > index); return calls[index]; };
  const respond = async (index, { items = [song(index)], total = items.length, revision = 1 } = {}) => {
    const call = await request(index);
    call.resolve({ ok: true, result: { items, total, revision, offset: call.payload.offset, limit: 50 } });
    await tick();
  };
  return { ...ui, controls, calls, request, respond, observers };
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
  assert.match(ui.get('#library-page-status').textContent, /50 sur 101 résultats affichés/);
  assert.equal(ui.get('#library-prev'), null); assert.equal(ui.get('#library-next'), null);
  assert.equal(ui.get('#library-clear-filters').disabled, true);
});

test('search, sort and both filters combine; changing each filter resets pagination and scan snapshots preserve them', async t => {
  const ui = await setup(t); ui.controls.update(snapshot()); await ui.respond(0, { total: 101 });
  ui.get('#library-load-more').click(); assert.equal((await ui.request(1)).payload.offset, 50); await ui.respond(1, { total: 101 });
  ui.search('Artist'); ui.change('#library-sort', 'artist'); ui.change('#library-audio', 'missing'); ui.change('#library-duplicates', 'possible');
  assert.deepEqual((await ui.request(2)).payload, { query: 'Artist', sort: 'artist', audio: 'missing', duplicates: 'possible', offset: 0, limit: 50 });
  await ui.respond(2, { total: 101 });
  ui.controls.update(snapshot({ status: 'scanning', progress: { visited: 200, processed: 30, discovered: 20 } }));
  for (const id of ['library-search', 'library-sort', 'library-audio', 'library-duplicates']) assert.equal(ui.get(`#${id}`).disabled, false);
  assert.equal(ui.get('#library-search').value, 'Artist');
  assert.equal(ui.get('#library-audio').value, 'missing'); assert.equal(ui.get('#library-duplicates').value, 'possible');
  await tick(); assert.equal(ui.calls.length, 3, 'scan progress alone must not repeat queries');
  ui.get('#library-load-more').click(); assert.equal((await ui.request(3)).payload.offset, 50); await ui.respond(3, { total: 101 });
  ui.change('#library-audio', 'present');
  assert.deepEqual((await ui.request(4)).payload, { query: 'Artist', sort: 'artist', audio: 'present', duplicates: 'possible', offset: 0, limit: 50 });
  await ui.respond(4, { total: 101 });
  ui.get('#library-load-more').click(); await ui.respond(5, { total: 101 });
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
  assert.equal(ui.get('#library-rows').children[0].dataset.librarySongId, song('current').id);
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
  const refreshed = ui.get('#library-rows').children[0];
  assert.notEqual(refreshed, row); assert.equal(refreshed.querySelector('.library-duplicate-badge').hidden, true);
  ui.change('#library-audio', 'unknown'); ui.change('#library-duplicates', 'possible'); await ui.respond(2, { items: [], revision: 2 });
  assert.equal(ui.get('#library-empty').hidden, false); assert.equal(ui.get('#library-table-container').hidden, true);
  assert.match(ui.get('#library-empty-title').textContent, /ces filtres/);
  assert.match(ui.get('#library-empty-description').textContent, /Réinitialisez/);
  assert.equal(ui.get('#library-clear-filters').disabled, false); assert.equal(ui.get('#library-load-more').hidden, true);
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

test('the scroll sentinel appends three bounded batches exactly once and disconnects on disposal', async t => {
  const ui = await setup(t, true), page = offset => Array.from({ length: Math.min(50, 116 - offset) }, (_, i) => song(offset + i));
  ui.controls.update(snapshot()); await ui.respond(0, { items: page(0), total: 116 });
  const observer = ui.observers[0], first = ui.get('#library-rows').children[0];
  assert.equal(observer.options.root, ui.get('#library-table-container')); assert.equal(observer.options.rootMargin, '160px 0px');
  assert.equal(observer.target, ui.get('#library-load-sentinel'));
  observer.emit(true); observer.emit(true); observer.emit(true);
  assert.equal((await ui.request(1)).payload.offset, 50); await tick(); assert.equal(ui.calls.length, 2);
  assert.equal(ui.get('#library-load-more').hidden, true);
  await ui.respond(1, { items: page(50), total: 116 });
  assert.equal(ui.get('#library-rows').children.length, 100); assert.equal(ui.get('#library-rows').children[0], first);
  observer.emit(false); observer.emit(true);
  assert.equal((await ui.request(2)).payload.offset, 100); await ui.respond(2, { items: page(100), total: 116 });
  assert.equal(ui.get('#library-rows').children.length, 116);
  assert.equal(new Set(ui.get('#library-rows').children.map(row => row.dataset.librarySongId)).size, 116);
  observer.emit(true); await tick(); assert.equal(ui.calls.length, 3);
  assert.ok(ui.calls.every(call => call.payload.limit === 50)); assert.equal(ui.get('#library-load-more').hidden, true);
  ui.controls.dispose(); assert.equal(observer.disconnected, true); observer.emit(true); await tick(); assert.equal(ui.calls.length, 3);
});

test('scroll fallback preserves rows, focus and scroll across append and scan progress without duplicate IDs', async t => {
  const ui = await setup(t); ui.controls.update(snapshot());
  await ui.respond(0, { items: Array.from({ length: 50 }, (_, i) => song(i)), total: 101 });
  const scroller = ui.get('#library-table-container'), first = ui.get('#library-rows').children[0], action = first.querySelector('button');
  action.focus(); scroller.clientHeight = 400; scroller.scrollHeight = 5000; scroller.scrollTop = 4500;
  scroller.dispatchEvent(new Event('scroll')); scroller.dispatchEvent(new Event('scroll'));
  assert.equal((await ui.request(1)).payload.offset, 50); assert.equal(action.disabled, false);
  ui.controls.update(snapshot({ status: 'scanning', progress: { visited: 500, processed: 200, discovered: 100 } }));
  assert.equal(scroller.scrollTop, 4500); assert.equal(ui.get('#library-rows').children[0], first); assert.equal(ui.calls.length, 2);
  await ui.respond(1, { items: [song(49), ...Array.from({ length: 49 }, (_, i) => song(50 + i))], total: 101 });
  assert.equal(ui.get('#library-rows').children.length, 99); assert.equal(ui.get('#library-rows').children[0], first);
  assert.equal(scroller.scrollTop, 4500); assert.equal(ui.document.activeElement, action);
  assert.equal(new Set(ui.get('#library-rows').children.map(row => row.dataset.librarySongId)).size, 99);
});

test('a failed appended page keeps loaded charts and offers an explicit retry without automatic retry loops', async t => {
  const ui = await setup(t, true); ui.controls.update(snapshot());
  await ui.respond(0, { items: Array.from({ length: 50 }, (_, i) => song(i)), total: 101 });
  const more = ui.get('#library-load-more'), first = ui.get('#library-rows').children[0];
  more.focus(); more.click(); const failed = await ui.request(1);
  assert.equal(ui.document.activeElement, ui.get('#library-page-status')); assert.equal(more.hidden, true);
  failed.resolve({ ok: false }); await tick();
  assert.equal(ui.get('#library-rows').children.length, 50); assert.equal(ui.get('#library-rows').children[0], first);
  assert.equal(more.textContent, 'Réessayer le chargement'); assert.equal(more.hidden, false); assert.equal(more.disabled, false);
  assert.match(ui.get('#library-page-status').textContent, /50 sur 101.*Suite indisponible/);
  assert.equal(ui.get('#library-query-retry').hidden, true);
  ui.observers[0].emit(true); ui.observers[0].emit(true); await tick(); assert.equal(ui.calls.length, 2);
  more.click(); assert.equal((await ui.request(2)).payload.offset, 50);
  await ui.respond(2, { items: Array.from({ length: 50 }, (_, i) => song(50 + i)), total: 101 });
  assert.equal(ui.get('#library-rows').children.length, 100); assert.equal(more.textContent, 'Charger plus');
});

test('a new query or scan revision resets loaded batches and ignores any older appended result', async t => {
  const ui = await setup(t); ui.controls.update(snapshot());
  await ui.respond(0, { items: Array.from({ length: 50 }, (_, i) => song(i)), total: 101 });
  ui.get('#library-load-more').click(); await ui.request(1);
  ui.get('#library-table-container').scrollTop = 700;
  ui.search('New song'); const searched = await ui.request(2);
  assert.equal(searched.payload.offset, 0); assert.equal(ui.get('#library-rows').children.length, 0);
  assert.equal(ui.get('#library-table-container').scrollTop, 0);
  await ui.respond(2, { items: [song('new')] }); await ui.respond(1, { items: [song('late')], total: 101 });
  assert.equal(ui.get('#library-rows').children.length, 1); assert.equal(ui.get('#library-rows').children[0].dataset.librarySongId, song('new').id);
  ui.controls.update(snapshot({ revision: 2 })); assert.equal((await ui.request(3)).payload.offset, 0);
  await ui.respond(3, { revision: 2, items: Array.from({ length: 50 }, (_, i) => song('scan-' + i)), total: 101 });
  ui.get('#library-load-more').click(); await ui.request(4);
  ui.controls.update(snapshot({ revision: 3 })); assert.equal((await ui.request(5)).payload.offset, 0);
  await ui.respond(5, { revision: 3, items: [song('current-scan')] }); await ui.respond(4, { revision: 2, items: [song('late-scan')], total: 101 });
  assert.equal(ui.get('#library-rows').children.length, 1); assert.equal(ui.get('#library-rows').children[0].dataset.librarySongId, song('current-scan').id);
});

test('inconsistent or unsafe appended pages cannot replace loaded rows or advance the cursor', async t => {
  const ui = await setup(t); ui.controls.update(snapshot());
  await ui.respond(0, { items: Array.from({ length: 50 }, (_, i) => song(i)), total: 101 });
  for (const result of [
    { items: [song('wrong-offset')], offset: 0, limit: 50, total: 101, revision: 1 },
    { items: [song('changed-total')], offset: 50, limit: 50, total: 100, revision: 1 },
    { items: [song(null, { id: {} })], offset: 50, limit: 50, total: 101, revision: 1 },
    { items: [song('unsafe', { id: '../../Songs/unsafe' })], offset: 50, limit: 50, total: 101, revision: 1 },
    { items: [], offset: 50, limit: 50, total: 101, revision: 1 }
  ]) {
    ui.get('#library-load-more').click(); const request = await ui.request(ui.calls.length);
    assert.equal(request.payload.offset, 50); request.resolve({ ok: true, result }); await tick();
    assert.equal(ui.get('#library-rows').children.length, 50); assert.equal(ui.get('#library-load-more').textContent, 'Réessayer le chargement');
  }
});
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
async function openComparison(t, result = comparison(), total) {
  const ui = await setup(t); ui.controls.update(snapshot());
  await ui.respond(0, { items: [song(variantId('a'), { duplicateCount: 4 }), song(variantId('b'), { duplicateCount: 4 }), song('unique')], ...(total === undefined ? {} : { total }) });
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
  assert.equal(cleanupCheck(ui, 'a').checked, false, 'choosing the keeper does not select a copy for deletion');
  assert.equal(ui.get('#library-cleanup-recycle').disabled, true);
  ui.get('#library-comparison-clear').click(); const clear = await ui.request(4);
  assert.equal(clear.name, 'library.keepDuplicateVersions');
  assert.deepEqual(clear.payload, { contextId: 'e'.repeat(32), revision: 1 });
  clear.resolve({ ok: true, result: { contextId: 'e'.repeat(32), revision: 1, preferredId: null, keptAll: true } }); await tick();
  assert.equal(card(ui, 'b').querySelector('.library-preferred-badge').hidden, true);
  assert.equal(ui.get('#library-comparison-clear').hidden, true);
  await ui.respond(5, { items: [song(variantId('a'), { duplicateCount: 4, keptAll: true })] });
  card(ui, 'a').querySelector('.library-variant-open').click();
  const open = await ui.request(6); assert.equal(open.name, 'library.openFolder'); assert.deepEqual(open.payload, { id: variantId('a') });
  open.resolve({ ok: true }); await tick();
  ui.get('#library-comparison-close').click();
  assert.equal(ui.get('#library-comparison').hidden, true);
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
  ui.get('#library-comparison-close').click(); closed.resolve({ ok: true, result: comparison({ preferredId: variantId('a') }) }); await tick();
  assert.equal(ui.get('#library-comparison').hidden, true);
  assert.equal(ui.get('#library-comparison-cards').children.length, 0);
  assert.equal(ui.calls.some(call => call.name === 'library.prepareCleanup'), false, 'a restored choice from a closed comparison cannot start verification');
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
  pending.resolve({ ok: true, result: comparison({ revision: 2, preferredId: variantId('a') }) }); await tick();
  assert.equal(ui.get('#library-comparison').hidden, true); assert.equal(ui.get('#library-comparison-cards').children.length, 0);
  assert.equal(ui.calls.some(call => call.name === 'library.prepareCleanup'), false);
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
  pending.resolve({ ok: true, result: comparison({ preferredId: variantId('a') }) }); await tick();
  ui.get('#library-comparison-close').click(); ui.get('#library-comparison-retry').click();
  ui.get('#library-rows').children[0].querySelector('.library-compare').click(); await tick();
  assert.equal(ui.document.writes, writes); assert.equal(ui.calls.length, 5);
});

const cleanupTarget = (letter, extra = {}) => ({
  id: variantId(letter), relativePath: `Charts/${letter}`, targetRelativePath: `Charts/${letter}`,
  kind: 'folder', bytes: 42000, audio: { status: 'verified', count: 2, bytes: 40000 }, eligible: false, forceable: false, reason: null, ...extra,
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
async function preparedCleanup(t, plan = cleanupPlan(), total) {
  const ui = await openComparison(t, comparison({ preferredId: variantId('a') }), total);
  const prepare = await ui.request(2);
  assert.equal(prepare.name, 'library.prepareCleanup', 'a restored keeper is reverified without a manual prepare action');
  prepare.resolve({ ok: true, result: plan }); await tick(); return ui;
}

test('a restored keeper automatically verifies content without saving a choice or selecting any deletion', async t => {
  const ui = await openComparison(t, comparison({ preferredId: variantId('a') }));
  const prepare = await ui.request(2);
  assert.deepEqual({ name: prepare.name, payload: prepare.payload }, { name: 'library.prepareCleanup', payload: { contextId: 'e'.repeat(32), revision: 1, keepId: variantId('a') } });
  assert.equal(card(ui, 'a').querySelector('.library-preferred-badge').hidden, false);
  assert.equal(ui.get('#library-comparison').attributes['aria-busy'], 'true');
  prepare.resolve({ ok: true, result: cleanupPlan() }); await tick();
  assert.equal(ui.get('#library-cleanup-plan').hidden, false);
  assert.equal(cleanupCheck(ui, 'a'), undefined, 'the keeper never becomes a deletion candidate');
  assert.equal(cleanupCheck(ui, 'b').checked, false);
  assert.equal(cleanupCheck(ui, 'd').checked, false);
  assert.equal(ui.get('#library-cleanup-recycle').disabled, true);
  assert.equal(ui.calls.some(call => call.name === 'library.chooseDuplicate' || call.name.includes('Recycle') || call.name === 'library.recycleDuplicates'), false);
});

test('a missing keeper or an unavailable or errored preference never starts automatic cleanup preparation', async t => {
  for (const extra of [{ preferredId: null }, { preferredId: variantId('a'), canChoose: false }, { preferredId: variantId('a'), selectionError: 'Le choix enregistré ne correspond plus aux notes.' }]) {
    const ui = await openComparison(t, comparison(extra));
    await tick(); assert.equal(ui.calls.length, 2);
    assert.equal(ui.get('#library-cleanup-plan').hidden, true);
    assert.equal(ui.get('#library-cleanup-recycle').disabled, true);
    if (extra.selectionError) {
      assert.equal(ui.get('#library-cleanup-prepare').disabled, true);
      ui.get('#library-cleanup-prepare').click(); await tick(); assert.equal(ui.calls.length, 2);
      assert.equal(ui.get('#library-comparison-feedback').textContent, extra.selectionError);
    }
  }
});

test('a restored keeper still refuses files changed since the scan and offers a fresh comparison', async t => {
  const ui = await openComparison(t, comparison({ preferredId: variantId('a') }));
  const prepare = await ui.request(2);
  prepare.resolve({ ok: false, error: 'Cette version a changé depuis le scan ou la comparaison. Relancez le scan de la bibliothèque puis comparez les versions.' }); await tick();
  assert.equal(ui.get('#library-cleanup-plan').hidden, true);
  assert.equal(ui.get('#library-cleanup-recycle').disabled, true);
  assert.equal(ui.get('#library-comparison-retry').hidden, false);
  assert.match(ui.get('#library-comparison-feedback').textContent, /changé depuis le scan/);
  ui.get('#library-cleanup-prepare').click(); ui.get('#library-cleanup-recycle').click(); await tick();
  assert.equal(ui.calls.length, 3, 'failed verification never enables an unchecked or stale cleanup');
});

test('an explicitly corrected keeper can recover from a restored-choice error without selecting any copy', async t => {
  const ui = await openComparison(t, comparison({ preferredId: variantId('a'), selectionError: 'Le choix enregistré ne correspond plus aux notes.' }));
  assert.equal(ui.calls.length, 2); card(ui, 'b').querySelector('.library-variant-choose').click();
  const choose = await ui.request(2);
  choose.resolve({ ok: true, result: { contextId: 'e'.repeat(32), revision: 1, preferredId: variantId('b') } }); await tick();
  const prepare = await ui.request(3); assert.equal(prepare.name, 'library.prepareCleanup'); assert.equal(prepare.payload.keepId, variantId('b'));
  prepare.resolve({ ok: true, result: cleanupPlan({ keepId: variantId('b'), keep: cleanupTarget('b'), candidates: [cleanupTarget('a', { eligible: true })] }) }); await tick();
  assert.equal(ui.get('#library-cleanup-plan').hidden, false); assert.equal(cleanupCheck(ui, 'a').checked, false);
  assert.equal(ui.get('#library-cleanup-recycle').disabled, true);
});

test('closing, disposing or changing the library ignores every in-flight restored-keeper cleanup response', async t => {
  for (const change of ['close', 'dispose', 'root', 'revision']) {
    const ui = await openComparison(t, comparison({ preferredId: variantId('a') }));
    const prepare = await ui.request(2);
    if (change === 'close') ui.get('#library-comparison-close').click();
    else if (change === 'dispose') ui.controls.dispose();
    else ui.controls.update(snapshot(change === 'root' ? { settings: { rootPath: 'D:\\New Songs', watch: false, refreshOnStart: true } } : { revision: 2 }));
    const writes = ui.document.writes;
    prepare.resolve({ ok: true, result: cleanupPlan() }); await tick();
    assert.equal(ui.get('#library-cleanup-plan').hidden, true); assert.equal(cleanupCheck(ui, 'b'), undefined);
    if (change === 'dispose') assert.equal(ui.document.writes, writes, 'disposed comparison receives no late DOM writes');
    assert.equal(ui.calls.filter(call => call.name === 'library.prepareCleanup').length, 1);
    assert.equal(ui.calls.some(call => call.name === 'library.chooseDuplicate' || call.name === 'library.recycleDuplicates' || call.name === 'library.forceRecycleDuplicate'), false);
  }
});

test('a scan invalidates pending restored-keeper comparisons and plans even if cancellation preserves the revision', async t => {
  for (const stage of ['comparison', 'preparation']) {
    const ui = stage === 'preparation' ? await openComparison(t, comparison({ preferredId: variantId('a') })) : await setup(t);
    if (stage === 'comparison') {
      ui.controls.update(snapshot()); await ui.respond(0, { items: [song(variantId('a'), { duplicateCount: 4 })] });
      ui.get('#library-rows').children[0].querySelector('.library-compare').click();
    }
    const pending = await ui.request(stage === 'comparison' ? 1 : 2);
    ui.controls.update(snapshot({ status: 'scanning' }));
    ui.controls.update(snapshot({ status: 'cancelled' }));
    pending.resolve({ ok: true, result: stage === 'comparison' ? comparison({ preferredId: variantId('a') }) : cleanupPlan() }); await tick();
    assert.equal(ui.get('#library-cleanup-plan').hidden, true);
    assert.equal(ui.get('#library-comparison').attributes['aria-busy'], 'false');
    assert.equal(ui.get('#library-comparison-retry').hidden, false);
    assert.equal(ui.calls.length, stage === 'comparison' ? 2 : 3, 'an obsolete response cannot trigger preparation or deletion');
    ui.get('#library-comparison-retry').click(); const retry = await ui.request(ui.calls.length - 1);
    assert.equal(retry.name, 'library.compareDuplicates');
    retry.resolve({ ok: true, result: comparison({ preferredId: variantId('a'), contextId: 'f'.repeat(32) }) }); await tick();
    const fresh = ui.calls.at(-1); assert.equal(fresh.name, 'library.prepareCleanup'); assert.equal(fresh.payload.contextId, 'f'.repeat(32));
    fresh.resolve({ ok: true, result: cleanupPlan({ contextId: 'f'.repeat(32) }) }); await tick();
    assert.equal(ui.get('#library-cleanup-plan').hidden, false); assert.equal(cleanupCheck(ui, 'b').checked, false);
  }
});

test('keeping all versions records exclusion, clears every selection and retains all ordinary library rows', async t => {
  const ui = await preparedCleanup(t); checkCleanup(ui, 'b'); checkCleanup(ui, 'd');
  assert.match(ui.html, /id="library-comparison-clear"[^>]*>Conserver toutes les versions</);
  ui.get('#library-comparison-clear').click(); const clear = await ui.request(3);
  assert.equal(clear.name, 'library.keepDuplicateVersions');
  assert.deepEqual(clear.payload, { contextId: 'e'.repeat(32), revision: 1 });
  assert.equal(ui.get('#library-cleanup-plan').hidden, true);
  clear.resolve({ ok: true, result: { contextId: 'e'.repeat(32), revision: 1, preferredId: null, keptAll: true } }); await tick();
  assert.equal(card(ui, 'a').querySelector('.library-preferred-badge').hidden, true);
  assert.equal(ui.get('#library-cleanup-prepare').hidden, true);
  assert.match(ui.get('#library-comparison-feedback').textContent, /Aucun fichier déplacé ou supprimé.*retiré des doublons/);
  assert.equal(ui.get('#library-comparison-clear').hidden, true);
  await ui.respond(4, { items: ['a', 'b', 'c', 'd'].map(letter => song(variantId(letter), { duplicateCount: 4, keptAll: true })) });
  assert.equal(ui.get('#library-rows').children.length, 4);
  assert.equal(ui.get('#library-rows').children[0].querySelector('.library-duplicate-badge').textContent, 'Versions conservées');
  ui.get('#library-cleanup-recycle').click(); await tick(); assert.equal(ui.calls.length, 5);
  ui.get('#library-comparison-close').click(); ui.get('#library-rows').children[0].querySelector('.library-compare').click();
  const reopened = await ui.request(5); reopened.resolve({ ok: true, result: comparison({ preferredId: null, keptAll: true }) }); await tick();
  assert.equal(ui.get('#library-cleanup-plan').hidden, true); assert.equal(ui.calls.length, 6);
  assert.equal(ui.get('#library-comparison-clear').hidden, true);
  assert.equal(ui.calls.some(call => call.name === 'library.recycleDuplicates' || call.name === 'library.forceRecycleDuplicate'), false);
});

test('keep-all works before any keeper is chosen and removes the group only from the duplicates filter', async t => {
  const ui = await openComparison(t);
  assert.equal(ui.get('#library-comparison-clear').hidden, false);
  assert.equal(ui.get('#library-comparison-clear').disabled, false);
  ui.change('#library-duplicates', 'possible'); await ui.respond(2, { items: [song(variantId('a'), { duplicateCount: 4 })] });
  ui.get('#library-comparison-clear').click(); const keep = await ui.request(3);
  assert.equal(keep.name, 'library.keepDuplicateVersions');
  keep.resolve({ ok: true, result: { contextId: 'e'.repeat(32), revision: 1, preferredId: null, keptAll: true } });
  await ui.respond(4, { items: [], total: 0 });
  assert.equal(ui.calls[4].payload.duplicates, 'possible');
  assert.equal(ui.get('#library-rows').children.length, 0);
  assert.equal(ui.get('#library-comparison').hidden, false, 'retention is recorded without moving or losing access to the versions');
  assert.equal(ui.calls.some(call => call.name === 'library.chooseDuplicate' || call.name === 'library.prepareCleanup' || call.name === 'library.scan' || /Recycle|recycle/.test(call.name)), false);
  card(ui, 'a').querySelector('.library-variant-choose').click(); const choose = await ui.request(5);
  choose.resolve({ ok: true, result: { contextId: 'e'.repeat(32), revision: 1, preferredId: variantId('a') } });
  const prepare = await ui.request(6); assert.equal(prepare.name, 'library.prepareCleanup');
  prepare.resolve({ ok: true, result: cleanupPlan() });
  await ui.respond(7, { items: [song(variantId('a'), { duplicateCount: 4 })] });
  assert.equal(ui.get('#library-comparison-clear').hidden, false, 'an explicit keeper choice cancels the keep-all disposition');
  assert.equal(ui.get('#library-rows').children.length, 1);
  assert.equal(cleanupCheck(ui, 'b').checked, false); assert.equal(cleanupCheck(ui, 'd').checked, false);
});

test('failed, mismatched and stale keep-all replies cannot remove a group or revive controls', async t => {
  for (const outcome of ['error', 'mismatch', 'close', 'root', 'dispose']) {
    const ui = await openComparison(t); ui.get('#library-comparison-clear').click(); const keep = await ui.request(2);
    if (outcome === 'close') ui.get('#library-comparison-close').click();
    if (outcome === 'root') ui.controls.update(snapshot({ settings: { rootPath: 'D:\\Other Songs', watch: false, refreshOnStart: true } }));
    if (outcome === 'dispose') ui.controls.dispose();
    const writes = ui.document.writes;
    keep.resolve(outcome === 'error' ? { ok: false, error: 'Préférence indisponible.' } : {
      ok: true, result: { contextId: outcome === 'mismatch' ? 'f'.repeat(32) : 'e'.repeat(32), revision: 1, preferredId: null, keptAll: true },
    }); await tick();
    assert.equal(ui.calls.filter(call => call.name === 'library.query').length, outcome === 'root' ? 2 : 1);
    if (outcome === 'error' || outcome === 'mismatch') {
      assert.equal(ui.get('#library-comparison-retry').hidden, false);
      assert.doesNotMatch(ui.get('#library-feedback').textContent, /retiré des doublons/);
    } else if (outcome !== 'dispose') assert.equal(ui.get('#library-comparison').hidden, true);
    if (outcome === 'dispose') assert.equal(ui.document.writes, writes);
    assert.equal(ui.calls.some(call => call.name === 'library.scan' || /Recycle|recycle/.test(call.name)), false);
  }
});

async function namedCall(ui, name, after) {
  await waitFor(() => ui.calls.slice(after).some(call => call.name === name));
  const index = ui.calls.findIndex((call, index) => index >= after && call.name === name);
  return { index, call: ui.calls[index] };
}
const remainingComparison = (revision, letters, contextId = 'f'.repeat(32)) => comparison({
  revision, contextId, preferredId: variantId('a'),
  variants: comparison().variants.filter(variant => letters.includes(variant.id[0])),
  summary: { total: letters.length, readable: letters.length, noteGroups: 1, identicalGroups: 1, unverified: 0 },
});

test('force then partial-selection cleanup refreshes only the index and supports one final explicit scan', async t => {
  for (const order of ['reply-first', 'snapshot-first']) {
    const ui = await preparedCleanup(t, cleanupPlan({ candidates: [cleanupTarget('b', { forceable: true }), cleanupTarget('c', { eligible: true }), cleanupTarget('d', { eligible: true })] }));
    ui.get('#library-cleanup-candidates').children[0].querySelector('.library-cleanup-force').click();
    const first = await ui.request(3); assert.equal(first.name, 'library.forceRecycleDuplicate');
    const nativeResult = { ok: true, result: { recycledIds: [variantId('b')], failed: [], cancelled: false, refreshRequested: false } };
    if (order === 'reply-first') { first.resolve(nativeResult); await ui.request(4); }
    const mark = ui.calls.length;
    ui.controls.update(snapshot({ revision: 2, cleanupRefreshPending: true, count: 3 }));
    if (order === 'snapshot-first') { first.resolve(nativeResult); await tick(); }
    const fresh = await namedCall(ui, 'library.compareDuplicates', mark);
    assert.deepEqual(fresh.call.payload, { id: variantId('a'), revision: 2 });
    const query = await namedCall(ui, 'library.query', mark);
    await ui.respond(query.index, { revision: 2, items: ['a', 'c', 'd'].map(letter => song(variantId(letter), { duplicateCount: 3 })) });
    if (order === 'reply-first') await ui.respond(4, { revision: 1, items: [song('stale-removed-b')] });
    assert.equal(ui.get('#library-rows').children.length, 3, 'an older result cannot restore a recycled copy');
    fresh.call.resolve({ ok: true, result: remainingComparison(2, ['a', 'c', 'd']) });
    const prepare = await namedCall(ui, 'library.prepareCleanup', fresh.index + 1);
    assert.equal(prepare.call.payload.revision, 2); assert.equal(prepare.call.payload.keepId, variantId('a'));
    prepare.call.resolve({ ok: true, result: cleanupPlan({ revision: 2, contextId: 'f'.repeat(32), planId: 'b'.repeat(32), candidates: [cleanupTarget('c', { eligible: true }), cleanupTarget('d', { eligible: true })] }) }); await tick();
    assert.equal(cleanupCheck(ui, 'b'), undefined); assert.equal(cleanupCheck(ui, 'a'), undefined);
    assert.equal(cleanupCheck(ui, 'c').checked, false); assert.equal(cleanupCheck(ui, 'd').checked, false);
    assert.equal(ui.get('#library-cleanup-recycle').disabled, true);
    assert.equal(ui.get('#library-refresh').textContent, 'Actualiser à la fin');
    assert.equal(ui.get('#library-cleanup-refresh-note').hidden, false);
    assert.match(ui.get('#library-cleanup-result').textContent, /poursuivre le nettoyage.*une seule analyse/s);
    checkCleanup(ui, 'c'); checkCleanup(ui, 'd'); ui.get('#library-cleanup-recycle').click();
    const second = await namedCall(ui, 'library.recycleDuplicates', prepare.index + 1);
    assert.deepEqual(second.call.payload.ids, [variantId('c'), variantId('d')]);
    const nextMark = ui.calls.length;
    ui.controls.update(snapshot({ revision: 3, cleanupRefreshPending: true, count: 1 }));
    second.call.resolve({ ok: true, result: { recycledIds: [variantId('c'), variantId('d')], failed: [], cancelled: false, refreshRequested: false } });
    const finalQuery = await namedCall(ui, 'library.query', nextMark);
    await ui.respond(finalQuery.index, { revision: 3, items: [song(variantId('a'))] });
    assert.equal(ui.get('#library-comparison').hidden, true, 'the keeper alone needs no duplicate comparison');
    assert.equal(ui.calls.some(call => call.name === 'library.scan'), false, 'neither cleanup starts a scan');
    const beforeScan = ui.calls.length; ui.get('#library-refresh').click();
    const scan = await ui.request(beforeScan);
    assert.deepEqual({ name: scan.name, payload: scan.payload }, { name: 'library.scan', payload: { mode: 'quick' } });
    scan.resolve({ ok: true }); await tick();
    ui.controls.update(snapshot({ revision: 4, cleanupRefreshPending: false, count: 1 }));
    const afterScan = await namedCall(ui, 'library.query', beforeScan + 1);
    await ui.respond(afterScan.index, { revision: 4, items: [song(variantId('a'))] });
    assert.equal(ui.get('#library-refresh').textContent, 'Actualiser');
    assert.equal(ui.get('#library-cleanup-refresh-note').hidden, true);
    assert.equal(ui.calls.filter(call => call.name === 'library.scan').length, 1);
  }
});

test('partial failure preserves its outcome and retries only remaining copies after fresh comparison', async t => {
  const ui = await preparedCleanup(t); checkCleanup(ui, 'b'); checkCleanup(ui, 'd');
  ui.get('#library-cleanup-recycle').click(); const request = await ui.request(3), mark = ui.calls.length;
  request.resolve({ ok: true, result: { recycledIds: [variantId('b')], failed: [{ id: variantId('d'), reason: 'Fichier verrouillé.' }], cancelled: true, refreshRequested: false } });
  ui.controls.update(snapshot({ revision: 2, cleanupRefreshPending: true }));
  const fresh = await namedCall(ui, 'library.compareDuplicates', mark), query = await namedCall(ui, 'library.query', mark);
  await ui.respond(query.index, { revision: 2, items: ['a', 'c', 'd'].map(letter => song(variantId(letter), { duplicateCount: 3 })) });
  fresh.call.resolve({ ok: true, result: remainingComparison(2, ['a', 'c', 'd']) });
  const prepare = await namedCall(ui, 'library.prepareCleanup', fresh.index + 1);
  prepare.call.resolve({ ok: true, result: cleanupPlan({ revision: 2, contextId: 'f'.repeat(32), candidates: [cleanupTarget('d', { eligible: true })] }) }); await tick();
  assert.match(ui.get('#library-cleanup-result').textContent, /1 copie\(s\) envoyée.*1 copie\(s\) non envoyée.*Opération interrompue.*Fichier verrouillé/s);
  assert.equal(ui.get('#library-cleanup-result').attributes['is-error'], true);
  assert.equal(cleanupCheck(ui, 'd').checked, false); assert.equal(cleanupCheck(ui, 'b'), undefined);
  assert.equal(ui.calls.some(call => call.name === 'library.scan'), false);
});

test('cancelled and interrupted cleanup never schedules a resumed comparison or a scan', async t => {
  for (const outcome of ['cancel', 'scan', 'root', 'dispose', 'close-after-reply']) {
    const ui = await preparedCleanup(t); checkCleanup(ui, 'b'); ui.get('#library-cleanup-recycle').click();
    const request = await ui.request(3);
    if (outcome === 'scan') { ui.controls.update(snapshot({ status: 'scanning' })); ui.controls.update(snapshot({ status: 'cancelled' })); }
    if (outcome === 'root') ui.controls.update(snapshot({ settings: { rootPath: 'D:\\Other Songs', watch: false, refreshOnStart: true } }));
    if (outcome === 'dispose') ui.controls.dispose();
    const writes = ui.document.writes;
    request.resolve(outcome === 'cancel' ? { ok: true, cancelled: true } : { ok: true, result: { recycledIds: [variantId('b')], failed: [], cancelled: false, refreshRequested: false } }); await tick();
    if (outcome === 'close-after-reply') {
      ui.get('#library-comparison-close').click();
      ui.controls.update(snapshot({ revision: 2, cleanupRefreshPending: true })); await tick();
    }
    assert.equal(ui.calls.filter(call => call.name === 'library.compareDuplicates').length, 1);
    assert.equal(ui.calls.some(call => call.name === 'library.scan'), false);
    if (outcome === 'dispose') assert.equal(ui.document.writes, writes);
    if (outcome === 'cancel') assert.equal(ui.calls.length, 4, 'a native cancellation changes neither index nor scan state');
  }
});

test('closing a resumed comparison discards its pending verification without restoring a consumed selection', async t => {
  const ui = await preparedCleanup(t); checkCleanup(ui, 'b'); ui.get('#library-cleanup-recycle').click();
  const request = await ui.request(3), mark = ui.calls.length;
  ui.controls.update(snapshot({ revision: 2, cleanupRefreshPending: true }));
  request.resolve({ ok: true, result: { recycledIds: [variantId('b')], failed: [], cancelled: false, refreshRequested: false } });
  const fresh = await namedCall(ui, 'library.compareDuplicates', mark);
  ui.get('#library-comparison-close').click();
  fresh.call.resolve({ ok: true, result: remainingComparison(2, ['a', 'c', 'd']) }); await tick();
  assert.equal(ui.get('#library-comparison').hidden, true);
  assert.equal(ui.calls.filter(call => call.name === 'library.prepareCleanup').length, 1);
  assert.equal(ui.get('#library-cleanup-plan').hidden, true);
  assert.equal(ui.calls.filter(call => call.name === 'library.recycleDuplicates').length, 1);
});

test('cleanup outcome is revealed after both the replacement rows and resumed plan settle, in either order', async t => {
  for (const order of ['query-first', 'plan-first', 'verification-error']) {
    const ui = await preparedCleanup(t); checkCleanup(ui, 'b'); ui.get('#library-cleanup-recycle').click();
    const request = await ui.request(3), mark = ui.calls.length;
    ui.controls.update(snapshot({ revision: 2, cleanupRefreshPending: true }));
    request.resolve({ ok: true, result: { recycledIds: [variantId('b')], failed: [], cancelled: false, refreshRequested: false } });
    const fresh = await namedCall(ui, 'library.compareDuplicates', mark), query = await namedCall(ui, 'library.query', mark);
    const outcome = ui.get('#library-cleanup-result'), before = outcome.scrollCount;
    const rows = () => ui.respond(query.index, { revision: 2, items: ['a', 'c', 'd'].map(letter => song(variantId(letter), { duplicateCount: 3 })) });
    if (order === 'query-first') { await rows(); assert.equal(outcome.scrollCount, before, 'comparison still changes layout above the result'); }
    fresh.call.resolve({ ok: true, result: remainingComparison(2, ['a', 'c', 'd']) });
    const prepare = await namedCall(ui, 'library.prepareCleanup', fresh.index + 1);
    prepare.call.resolve(order === 'verification-error' ? { ok: false, error: 'Fichiers changés depuis le scan.' } : {
      ok: true, result: cleanupPlan({ revision: 2, contextId: 'f'.repeat(32), candidates: [cleanupTarget('c', { eligible: true }), cleanupTarget('d', { eligible: true })] }),
    }); await tick();
    if (order !== 'query-first') {
      assert.equal(outcome.scrollCount, before, 'a pending index query can still grow the page'); await rows();
    }
    assert.equal(outcome.scrollCount, before + 1, 'the completed result is revealed again after the layout settles');
    assert.equal(ui.document.activeElement, outcome);
    assert.match(outcome.textContent, /1 copie\(s\) envoyée.*Version conservée : Charts\/a/s);
    assert.equal(ui.get('#library-cleanup-plan').hidden, order === 'verification-error');
    assert.equal(ui.get('#library-cleanup-recycle').disabled, true, 'reveal never selects or retries cleanup');
    ui.controls.update(snapshot({ revision: 2, cleanupRefreshPending: true, progress: { visited: 120, processed: 110, discovered: 101 } }));
    await tick(); assert.equal(outcome.scrollCount, before + 1, 'later snapshots do not steal the viewport again');
  }
});

test('late resumed verification does not reclaim focus or scroll after user input, a new scan, closure or disposal', async t => {
  for (const action of ['focus', 'wheel', 'scan', 'close', 'dispose']) {
    const ui = await preparedCleanup(t); checkCleanup(ui, 'b'); ui.get('#library-cleanup-recycle').click();
    const request = await ui.request(3), mark = ui.calls.length;
    ui.controls.update(snapshot({ revision: 2, cleanupRefreshPending: true }));
    request.resolve({ ok: true, result: { recycledIds: [variantId('b')], failed: [], cancelled: false, refreshRequested: false } });
    const fresh = await namedCall(ui, 'library.compareDuplicates', mark), query = await namedCall(ui, 'library.query', mark);
    fresh.call.resolve({ ok: true, result: remainingComparison(2, ['a', 'c', 'd']) });
    const prepare = await namedCall(ui, 'library.prepareCleanup', fresh.index + 1);
    const outcome = ui.get('#library-cleanup-result'), before = outcome.scrollCount;
    if (action === 'focus') ui.get('#library-search').focus();
    if (action === 'wheel') ui.root.dispatchEvent(new Event('wheel'));
    if (action === 'close') ui.get('#library-comparison-close').click();
    if (action === 'dispose') ui.controls.dispose();
    const writes = ui.document.writes;
    prepare.call.resolve({ ok: true, result: cleanupPlan({ revision: 2, contextId: 'f'.repeat(32), candidates: [cleanupTarget('d', { eligible: true })] }) });
    if (action === 'scan') {
      await tick(); // Verification settled, but the rows still hold the pending reveal.
      ui.controls.update(snapshot({ revision: 2, status: 'scanning', cleanupRefreshPending: true }));
      ui.controls.update(snapshot({ revision: 2, status: 'cancelled', cleanupRefreshPending: true }));
    }
    await ui.respond(query.index, { revision: 2, items: [song(variantId('a'), { duplicateCount: 3 })] });
    assert.equal(outcome.scrollCount, before, 'the user controls the viewport once they move on');
    if (action === 'focus') assert.equal(ui.document.activeElement, ui.get('#library-search'));
    if (action === 'close') assert.equal(ui.get('#library-comparison').hidden, true);
    if (action === 'dispose') assert.equal(ui.document.writes, writes);
  }
});

test('a failed or cancelled final scan keeps the pending notice and explicit refresh action', async t => {
  const ui = await setup(t);
  ui.controls.update(snapshot({ cleanupRefreshPending: true })); await ui.respond(0);
  assert.equal(ui.get('#library-refresh').textContent, 'Actualiser à la fin');
  ui.get('#library-refresh').click(); const scan = await ui.request(1);
  ui.controls.update(snapshot({ cleanupRefreshPending: true, status: 'scanning', mode: 'quick' }));
  scan.resolve({ ok: false }); await tick();
  for (const status of ['cancelled', 'error']) {
    ui.controls.update(snapshot({ cleanupRefreshPending: true, status }));
    assert.equal(ui.get('#library-cleanup-refresh-note').hidden, false);
    assert.equal(ui.get('#library-refresh').textContent, 'Actualiser à la fin');
    assert.equal(ui.get('#library-refresh').disabled, false);
    assert.match(ui.get('#library-watcher').textContent, /suspendue/);
  }
  assert.equal(ui.calls.length, 2, 'failed final refresh is never restarted automatically');
});

test('deferred-cleanup status, guidance and persistent keep-all feedback translate both ways', async t => {
  const ui = await preparedCleanup(t); checkCleanup(ui, 'b'); ui.get('#library-cleanup-recycle').click();
  const request = await ui.request(3);
  request.resolve({ ok: true, result: { recycledIds: [variantId('b')], failed: [], cancelled: false, refreshRequested: false } }); await tick();
  ui.controls.update(snapshot({ cleanupRefreshPending: true }));
  const kept = await openComparison(t, comparison({ keptAll: true }));
  const elements = [ui.get('#library-refresh'), ui.get('#library-status'), ui.get('#library-watcher'),
    ...ui.get('#library-cleanup-result').children, kept.get('#library-comparison-feedback')];
  const french = elements.map(element => element.textContent);
  const nodes = elements.map(element => ({ parentElement: element,
    get nodeValue() { return element.textContent; }, set nodeValue(value) { element.textContent = value; } }));
  const document = { body: ui.root, readyState: 'loading', documentElement: { lang: 'fr' }, addEventListener() {},
    createTreeWalker() { let index = 0; return { nextNode: () => nodes[index++] ?? null }; } };
  const window = { ChartsHubCompanion: { initialLanguage: 'fr' }, dispatchEvent() {} };
  require('node:vm').runInNewContext(readFileSync(require.resolve('../companion/ui/localization.js'), 'utf8'), {
    window, document, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, NodeFilter: { SHOW_TEXT: 4 }, CustomEvent: class {},
  });
  window.ChartshubCompanionLanguage.apply('en');
  assert.equal(elements[0].textContent, 'Refresh when finished');
  assert.equal(elements[1].textContent, 'Final refresh pending');
  assert.match(elements[2].textContent, /paused until the final refresh/);
  assert.match(ui.get('#library-cleanup-result').textContent, /continue cleanup.*run a single scan/s);
  assert.match(kept.get('#library-comparison-feedback').textContent, /No file was moved or deleted.*removed from duplicates/);
  const notice = ui.html.match(/id="library-cleanup-refresh-note"[^>]*>([^<]+)<\/p>/)[1];
  assert.match(window.ChartshubCompanionLanguage.translate(notice), /Change detection stays paused until a successful scan/);
  assert.equal(window.ChartshubCompanionLanguage.translate('Versions conservées'), 'Versions kept');
  window.ChartshubCompanionLanguage.apply('fr');
  assert.deepEqual(elements.map(element => element.textContent), french);
});

test('loading another batch preserves the chosen keeper and every explicit deletion selection', async t => {
  const ui = await preparedCleanup(t, cleanupPlan(), 101); checkCleanup(ui, 'b');
  const check = cleanupCheck(ui, 'b'), kept = card(ui, 'a'), plan = ui.get('#library-cleanup-plan');
  ui.get('#library-load-more').click(); const appended = await ui.request(3);
  assert.equal(appended.name, 'library.query'); assert.equal(appended.payload.offset, 50);
  assert.equal(plan.hidden, false); assert.equal(cleanupCheck(ui, 'b'), check); assert.equal(check.checked, true);
  await ui.respond(3, { items: Array.from({ length: 50 }, (_, i) => song(50 + i)), total: 101 });
  assert.equal(ui.get('#library-comparison').hidden, false); assert.equal(card(ui, 'a'), kept);
  assert.equal(card(ui, 'a').querySelector('.library-preferred-badge').hidden, false);
  assert.equal(cleanupCheck(ui, 'b'), check); assert.equal(check.checked, true);
  assert.equal(cleanupCheck(ui, 'd').checked, false); assert.equal(cleanupCheck(ui, 'a'), undefined);
  assert.equal(ui.calls.some(call => call.name === 'library.chooseDuplicate' || call.name === 'library.recycleDuplicates'), false);
});

test('cleanup requires individual selection while unsafe copies, unchecked copies and the keeper remain protected', async t => {
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
  assert.equal(cleanupCheck(ui, 'b').checked, false, 'safe folder copy requires explicit selection');
  assert.equal(cleanupCheck(ui, 'd').checked, false, 'safe SNG copy requires explicit selection');
  assert.equal(cleanupCheck(ui, 'c').checked, false, 'unsafe copy remains unchecked');
  assert.equal(cleanupCheck(ui, 'c').disabled, true);
  checkCleanup(ui, 'c'); assert.equal(cleanupCheck(ui, 'c').checked, false, 'even a dispatched disabled change cannot select an unsafe copy');
  assert.equal(ui.get('#library-cleanup-recycle').disabled, true);
  assert.equal(ui.get('#library-cleanup-summary').hidden, true);
  assert.match(ui.get('#library-cleanup-selection').textContent, /0 copie\(s\) sélectionnée\(s\).*3 autre\(s\) copie\(s\) non cochée\(s\) restent en place/);
  ui.get('#library-cleanup-recycle').click(); await tick(); assert.equal(ui.calls.length, 3, 'no command without an individual selection');
  checkCleanup(ui, 'b'); checkCleanup(ui, 'd');
  assert.equal(ui.get('#library-cleanup-recycle').disabled, false);
  assert.equal(ui.get('#library-cleanup-recycle').textContent, 'Envoyer les 2 copies sélectionnées à la Corbeille…');
  assert.equal(ui.get('#library-cleanup-summary').hidden, false);
  assert.deepEqual(ui.get('#library-cleanup-selected-targets').querySelectorAll('code').map(element => element.textContent), ['Charts/b', 'Charts/<unsafe & archive>.sng']);
  assert.match(ui.get('#library-cleanup-selection').textContent, /2 copie\(s\) sélectionnée\(s\) · 84\s?000 octets.*1 autre\(s\) copie\(s\) non cochée\(s\) restent en place/);
  checkCleanup(ui, 'd', false); assert.equal(ui.get('#library-cleanup-recycle').textContent, 'Envoyer la copie sélectionnée à la Corbeille…');
  assert.deepEqual(ui.get('#library-cleanup-selected-targets').querySelectorAll('code').map(element => element.textContent), ['Charts/b']);
  assert.match(ui.get('#library-cleanup-selection').textContent, /1 copie\(s\) sélectionnée\(s\) · 42\s?000 octets.*2 autre\(s\) copie\(s\) non cochée\(s\) restent en place/);
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
  assert.equal(cleanupCheck(ui, 'b').checked, false, 'cancelling does not preserve an earlier deletion selection');
  assert.equal(cleanupCheck(ui, 'd').checked, false, 'fresh plans always require individual selections');
});

test('verified but different copy stays unselected and offers a separate delete-anyway action', async t => {
  for (const reason of ['Les fichiers audio sont absents, différents ou non vérifiés.', 'Cette version contient des fichiers différents ou supplémentaires.']) {
    const ui = await preparedCleanup(t, cleanupPlan({ candidates: [
      cleanupTarget('b', { eligible: false, forceable: true, audio: { status: 'verified', count: 1, bytes: 2565590 }, reason })
    ] }));
    const candidate = ui.get('#library-cleanup-candidates').children[0];
    const check = cleanupCheck(ui, 'b');
    assert.equal(check.checked, false); assert.equal(check.disabled, true);
    assert.match(candidate.textContent, /copie est entièrement vérifiée/i);
    const force = candidate.querySelector('.library-cleanup-force');
    assert.ok(force); assert.equal(force.textContent, 'Supprimer quand même');
    assert.equal(ui.get('#library-cleanup-recycle').disabled, true);
    force.click(); const request = await ui.request(3);
    assert.deepEqual({ name: request.name, payload: request.payload }, {
      name: 'library.forceRecycleDuplicate', payload: { planId: 'a'.repeat(32), revision: 1, id: variantId('b') }
    });
    assert.equal(ui.get('#library-comparison-close').disabled, true);
    request.resolve({ ok: true, cancelled: true }); await tick();
    assert.match(ui.get('#library-cleanup-result').textContent, /annulée.*Aucun fichier envoyé/s);
    assert.equal(ui.get('#library-cleanup-plan').hidden, true);
  }
});

test('file comparison expands for different copies and shows categories, exact sizes and missing or extra files', async t => {
  const files = [
    { name: 'notes.chart', category: 'notes', status: 'identical', keeperBytes: 123, copyBytes: 123 },
    { name: 'song.ogg', category: 'audio', status: 'changed', keeperBytes: 500, copyBytes: 500 },
    { name: 'album.png', category: 'artwork', status: 'only-keeper', keeperBytes: 80, copyBytes: null },
    { name: 'credits & thanks.txt', category: 'other', status: 'only-copy', keeperBytes: null, copyBytes: 30 },
    { name: 'SNG: metadata', category: 'metadata', status: 'changed', keeperBytes: 20, copyBytes: 21 },
  ];
  const ui = await preparedCleanup(t, cleanupPlan({ candidates: [cleanupTarget('b', { forceable: true,
    differences: { status: 'verified', counts: { identical: 1, changed: 2, onlyKeeper: 1, onlyCopy: 1, unverified: 0 }, files },
  })] }));
  const candidate = ui.get('#library-cleanup-candidates').children[0], details = candidate.querySelector('.library-file-differences');
  assert.equal(details.open, true, 'a forceable copy reveals the differences before its separate confirmation action');
  assert.equal(details.querySelector('summary').textContent, 'Comparer les fichiers · 4 différence(s)');
  assert.match(details.querySelector('p').textContent, /1 identique\(s\) · 2 modifié\(s\) · 1 uniquement dans la version conservée · 1 uniquement dans cette copie/);
  const rows = details.querySelector('tbody').children;
  assert.deepEqual(rows[1].children.map(cell => cell.textContent), ['song.ogg', 'Audio', 'Modifié', '500', '500']);
  assert.deepEqual(rows[2].children.map(cell => cell.textContent), ['album.png', 'Illustration', 'Uniquement dans la version conservée', '80', '—']);
  assert.deepEqual(rows[3].children.map(cell => cell.textContent), ['credits & thanks.txt', 'Autre', 'Uniquement dans cette copie', '—', '30']);
  assert.equal(rows[3].querySelector('code').textContent, 'credits & thanks.txt');
  assert.equal(rows[4].children[0].textContent, 'Métadonnées du conteneur .sng');
  assert.equal(cleanupCheck(ui, 'b').checked, false); assert.equal(cleanupCheck(ui, 'b').disabled, true);
  assert.equal(cleanupCheck(ui, 'a'), undefined, 'the keeper has no deletion checkbox');
  assert.equal(candidate.querySelector('.library-cleanup-force').disabled, false);
});

test('unverified file comparisons never label unknown content as absent or alter explicit selection', async t => {
  const ui = await preparedCleanup(t, cleanupPlan({ candidates: [
    cleanupTarget('b', { eligible: true, differences: { status: 'verified', counts: { identical: 1, changed: 0, onlyKeeper: 0, onlyCopy: 0, unverified: 0 },
      files: [{ name: 'notes.chart', category: 'notes', status: 'identical', keeperBytes: 123, copyBytes: 123 }] } }),
    cleanupTarget('c', { differences: { status: 'unavailable', counts: { identical: 0, changed: 0, onlyKeeper: 0, onlyCopy: 0, unverified: 1 },
      files: [{ name: 'song.ogg', category: 'audio', status: 'unverified', keeperBytes: 500, copyBytes: null }] } }),
  ] }));
  const verified = ui.get('#library-cleanup-candidates').children[0].querySelector('.library-file-differences');
  const unavailable = ui.get('#library-cleanup-candidates').children[1].querySelector('.library-file-differences');
  assert.equal(verified.open, false);
  assert.equal(verified.querySelector('summary').textContent, 'Comparer les fichiers · 0 différence(s)');
  assert.equal(unavailable.querySelector('summary').textContent, 'Comparaison des fichiers indisponible');
  assert.match(unavailable.textContent, /non vérifié ne doit pas être considéré comme absent/);
  assert.equal(unavailable.querySelector('tbody').children[0].dataset.fileStatus, 'unverified');
  assert.doesNotMatch(unavailable.textContent, /Uniquement dans/);
  assert.equal(cleanupCheck(ui, 'b').checked, false);
  checkCleanup(ui, 'b');
  ui.get('#library-cleanup-recycle').click(); const recycle = await ui.request(3);
  assert.deepEqual(recycle.payload.ids, [variantId('b')]);
  recycle.resolve({ ok: true, cancelled: true }); await tick();
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
  assert.equal(cleanupCheck(ui, 'b').checked, false);
  assert.equal(ui.get('#library-cleanup-recycle').disabled, true);
  checkCleanup(ui, 'b'); assert.equal(ui.get('#library-cleanup-recycle').disabled, false);
  const missingKeeper = await preparedCleanup(t, cleanupPlan({ keep: cleanupTarget('a', { targetRelativePath: null, kind: null, bytes: null }) }));
  assert.equal(missingKeeper.get('#library-cleanup-plan').hidden, false);
  assert.equal(cleanupCheck(missingKeeper, 'b').disabled, true);
  assert.equal(missingKeeper.get('#library-cleanup-recycle').disabled, true);
});

test('changing or clearing the preferred version discards the old plan and automatically prepares the new keeper', async t => {
  const ui = await preparedCleanup(t);
  checkCleanup(ui, 'b');
  card(ui, 'c').querySelector('.library-variant-choose').click(); const choose = await ui.request(3);
  assert.equal(ui.get('#library-cleanup-plan').hidden, true);
  choose.resolve({ ok: true, result: { contextId: 'e'.repeat(32), revision: 1, preferredId: variantId('c') } }); await tick();
  const next = await ui.request(4);
  assert.equal(next.name, 'library.prepareCleanup');
  assert.equal(next.payload.keepId, variantId('c'));
  next.resolve({ ok: true, result: cleanupPlan({ keepId: variantId('c'), keep: cleanupTarget('c'), candidates: [cleanupTarget('b', { eligible: true, reason: null })] }) }); await tick();
  assert.equal(cleanupCheck(ui, 'b').checked, false, 'a keeper change clears previous deletion selections');
  assert.equal(ui.get('#library-cleanup-recycle').disabled, true);
  ui.get('#library-comparison-clear').click(); const clear = await ui.request(5);
  assert.equal(ui.get('#library-cleanup-plan').hidden, true);
  assert.equal(clear.name, 'library.keepDuplicateVersions');
  clear.resolve({ ok: true, result: { contextId: 'e'.repeat(32), revision: 1, preferredId: null, keptAll: true } }); await tick();
  assert.equal(ui.get('#library-cleanup-prepare').hidden, true);
});

test('a saved keeper survives closing and reopening while deletion selections never do', async t => {
  const ui = await preparedCleanup(t);
  assert.equal(card(ui, 'a').querySelector('.library-preferred-badge').hidden, false);
  assert.equal(card(ui, 'a').querySelector('.library-variant-choose').disabled, true);
  checkCleanup(ui, 'b');
  ui.get('#library-comparison-close').click();
  ui.get('#library-rows').children[0].querySelector('.library-compare').click();
  const reopened = await ui.request(3);
  reopened.resolve({ ok: true, result: comparison({ preferredId: variantId('a') }) }); await tick();
  assert.equal(card(ui, 'a').querySelector('.library-preferred-badge').hidden, false);
  assert.equal(ui.get('#library-cleanup-plan').hidden, true);
  const prepare = await ui.request(4);
  assert.equal(prepare.payload.keepId, variantId('a'));
  prepare.resolve({ ok: true, result: cleanupPlan({ planId: 'b'.repeat(32) }) }); await tick();
  assert.equal(cleanupCheck(ui, 'b').checked, false);
  assert.equal(cleanupCheck(ui, 'd').checked, false);
  assert.equal(ui.get('#library-cleanup-recycle').disabled, true);
  assert.equal(ui.calls.some(call => call.name === 'library.chooseDuplicate' || call.name === 'library.recycleDuplicates'), false);
});

test('successful cleanup submits only the selected copy and reports the protected keeper', async t => {
  const ui = await preparedCleanup(t);
  checkCleanup(ui, 'd');
  ui.get('#library-cleanup-recycle').click(); const recycle = await ui.request(3);
  assert.deepEqual(recycle.payload.ids, [variantId('d')]);
  assert.equal(recycle.payload.ids.includes(variantId('a')), false);
  assert.equal(recycle.payload.ids.includes(variantId('b')), false);
  recycle.resolve({ ok: true, result: { recycledIds: [variantId('d')], failed: [], cancelled: false, refreshRequested: true } }); await tick();
  assert.match(ui.get('#library-cleanup-result').textContent, /1 copie\(s\) envoyée\(s\).*Version conservée : Charts\/a/s);
  assert.equal(ui.get('#library-cleanup-result').attributes['is-error'], false);
  assert.equal(ui.get('#library-cleanup-plan').hidden, true);
  assert.equal(ui.get('#library-cleanup-recycle').disabled, true);
  assert.equal(ui.get('#library-comparison-retry').hidden, false);
  const result = ui.get('#library-cleanup-result');
  assert.equal(ui.document.activeElement, result);
  assert.equal(result.scrollCount, 1, 'the finished operation reveals its outcome');
  ui.controls.update(snapshot({ revision: 2 })); await ui.respond(4, { revision: 2 });
  assert.equal(result.scrollCount, 2, 'the cleanup refresh keeps the outcome visible when comparison collapses');
  ui.get('#library-search').focus();
  ui.controls.update(snapshot({ revision: 3 })); await ui.respond(5, { revision: 3 });
  assert.equal(result.scrollCount, 2, 'later unrelated scans never steal the viewport');
  assert.equal(ui.document.activeElement, ui.get('#library-search'));
});

test('history write warnings preserve native success and the keeper for normal and force cleanup', async t => {
  const warning = 'Le nettoyage est terminé, mais son historique n’a pas pu être enregistré.';
  for (const force of [false, true]) {
    const ui = await preparedCleanup(t, cleanupPlan({ candidates: [cleanupTarget('b', { eligible: !force, forceable: force })] }));
    if (force) ui.get('#library-cleanup-candidates').querySelector('.library-cleanup-force').click();
    else { checkCleanup(ui, 'b'); ui.get('#library-cleanup-recycle').click(); }
    const request = await ui.request(3);
    assert.equal(request.name, force ? 'library.forceRecycleDuplicate' : 'library.recycleDuplicates');
    request.resolve({ ok: true, result: { recycledIds: [variantId('b')], failed: [], cancelled: false, refreshRequested: true, historyError: warning } }); await tick();
    const result = ui.get('#library-cleanup-result');
    assert.ok(result.textContent.includes(warning));
    assert.ok(result.children.some(line => line.textContent.trim() === warning), 'the history warning has its own translatable text node');
    assert.match(result.textContent, /1 copie.*envoyée.*Corbeille Windows/);
    assert.match(result.textContent, /Version conservée : Charts\/a/);
    assert.equal(result.attributes['is-error'], false, 'recording failure must not report native recycling as failed');
    assert.equal(result.hidden, false); assert.equal(ui.document.activeElement, result);
    assert.equal(ui.get('#library-cleanup-recycle').disabled, true);
    const frenchResult = result.textContent;
    const nodes = result.children.map(line => ({ parentElement: line,
      get nodeValue() { return line.textContent; }, set nodeValue(value) { line.textContent = value; } }));
    const document = { body: result, readyState: 'loading', documentElement: { lang: 'fr' }, addEventListener() {},
      createTreeWalker() { let index = 0; return { nextNode: () => nodes[index++] ?? null }; } };
    const window = { ChartsHubCompanion: { initialLanguage: 'fr' }, dispatchEvent() {} };
    require('node:vm').runInNewContext(readFileSync(require.resolve('../companion/ui/localization.js'), 'utf8'), {
      window, document, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, NodeFilter: { SHOW_TEXT: 4 }, CustomEvent: class {},
    });
    window.ChartshubCompanionLanguage.apply('en');
    assert.match(result.textContent, /Cleanup has finished, but its history could not be saved\./);
    assert.ok(result.textContent.includes('Charts/a'), 'translation preserves the selected keeper path');
    window.ChartshubCompanionLanguage.apply('fr');
    assert.equal(result.textContent, frenchResult, 'switching back restores all result lines and newlines');
  }
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
    assert.equal(ui.get('#library-cleanup-prepare').disabled, true, 'reload is automatically verifying the restored keeper');
    const prepare = await ui.request(4); assert.equal(prepare.name, 'library.prepareCleanup');
    prepare.resolve({ ok: true, result: cleanupPlan() }); await tick();
    assert.equal(ui.get('#library-cleanup-plan').hidden, false); assert.equal(cleanupCheck(ui, 'b').checked, false);
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
  assert.equal(ui.document.activeElement, result);
  assert.equal(result.scrollCount, 1, 'a response after refresh reveals the completed outcome');
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
  verify.resolve({ ok: true, result: { revision: 1, totalGroups: 3, processedGroups: 3, cancelled: false, readyGroups: 1, needsKeeperGroups: 1, blockedGroups: 1, eligibleCopies: 2 } });
  const refresh = await ui.request(2);
  assert.equal(refresh.name, 'library.query');
  assert.equal(refresh.payload.duplicates, 'possible');
  refresh.resolve({ ok: true, result: { items: [song('bulk-a', { duplicateCount: 2, duplicateVerification: 'ready', verifiedEligibleCopies: 2 })], total: 1, revision: 1, offset: 0, limit: 50 } });
  await tick();
  assert.equal(ui.get('#library-duplicates').value, 'possible');
  assert.match(ui.get('#library-verify-all-status').textContent, /1 groupe\(s\) prêt\(s\).*1 choix de version requis.*1 bloqué\(s\).*2 copie\(s\) identique\(s\) prête\(s\) à sélectionner/);
  assert.match(ui.get('#library-verify-all-status').textContent, /Ouvrez « Comparer » pour connaître les raisons précises/);
  const badge = ui.get('#library-rows').children[0].querySelector('.library-duplicate-badge');
  assert.match(badge.textContent, /Prêt à nettoyer.*2 copie\(s\) vérifiée\(s\)/);
  assert.equal(badge.dataset.verification, 'ready');
});

test('global verification has its own stop action, shows partial results and can restart', async t => {
  const ui = await setup(t); ui.controls.update(snapshot()); await ui.respond(0);
  const stop = ui.get('#library-cancel-duplicate-verification');
  assert.equal(stop.hidden, true); assert.equal(stop.disabled, true);
  ui.get('#library-verify-all-duplicates').click(); const verify = await ui.request(1);
  ui.controls.update(snapshot({ duplicateVerification: { running: true, stopping: false, processed: 1, total: 3 } }));
  assert.equal(stop.hidden, false); assert.equal(stop.disabled, false);
  assert.equal(ui.get('#library-cancel').hidden, true, 'scan cancellation is separate');
  stop.click(); const cancel = await ui.request(2);
  assert.equal(cancel.name, 'library.cancelDuplicateVerification'); assert.equal(cancel.payload, undefined);
  assert.equal(stop.disabled, true); assert.match(stop.textContent, /Arrêt en cours/);
  assert.match(ui.get('#library-verify-all-status').textContent, /Arrêt.*1 \/ 3/);
  stop.click(); assert.equal(ui.calls.length, 3, 'only one stop request is sent');
  const result = { revision: 1, totalGroups: 3, processedGroups: 1, cancelled: true, readyGroups: 1, needsKeeperGroups: 0, blockedGroups: 0, eligibleCopies: 2 };
  ui.controls.update(snapshot({ duplicateVerification: null }));
  verify.resolve({ ok: true, result }); cancel.resolve({ ok: true, result });
  await ui.respond(3);
  assert.equal(stop.hidden, true);
  assert.match(ui.get('#library-verify-all-status').textContent, /Vérification interrompue : 1 \/ 3.*1 groupe\(s\) prêt\(s\).*Aucun fichier n’a été supprimé/);
  assert.equal(ui.get('#library-verify-all-status').attributes['is-error'], false);
  assert.equal(ui.get('#library-verify-all-duplicates').disabled, false);
  ui.get('#library-verify-all-duplicates').click(); const restarted = await ui.request(4);
  assert.equal(restarted.name, 'library.verifyAllDuplicates');
  restarted.resolve({ ok: true, result: { ...result, processedGroups: 3, readyGroups: 3, eligibleCopies: 6, cancelled: false } });
  await ui.respond(5);
  assert.doesNotMatch(ui.get('#library-verify-all-status').textContent, /interrompue/);
});

test('a panel opened during global verification can stop it and display the partial result', async t => {
  const ui = await setup(t);
  ui.controls.update(snapshot({ duplicateVerification: { running: true, stopping: false, processed: 0, total: 2 } }));
  await ui.respond(0);
  ui.get('#library-cancel-duplicate-verification').click(); const cancel = await ui.request(1);
  ui.controls.update(snapshot({ duplicateVerification: null }));
  cancel.resolve({ ok: true, result: { revision: 1, totalGroups: 2, processedGroups: 0, cancelled: true, readyGroups: 0, needsKeeperGroups: 0, blockedGroups: 0, eligibleCopies: 0 } });
  await ui.respond(2);
  assert.match(ui.get('#library-verify-all-status').textContent, /Vérification interrompue : 0 \/ 2/);
  assert.equal(ui.get('#library-cancel-duplicate-verification').hidden, true);
});

test('late stop responses do not overwrite a restarted verification or write after disposal', async t => {
  const ui = await setup(t); ui.controls.update(snapshot()); await ui.respond(0);
  ui.get('#library-verify-all-duplicates').click(); const verify = await ui.request(1);
  ui.get('#library-cancel-duplicate-verification').click(); const cancel = await ui.request(2);
  const result = { revision: 1, totalGroups: 2, processedGroups: 0, cancelled: true, readyGroups: 0, needsKeeperGroups: 0, blockedGroups: 0, eligibleCopies: 0 };
  verify.resolve({ ok: true, result }); await ui.respond(3);
  ui.get('#library-verify-all-duplicates').click(); const restarted = await ui.request(4);
  cancel.resolve({ ok: true, result }); await tick();
  assert.match(ui.get('#library-verify-all-status').textContent, /Vérification des notes/);
  ui.controls.dispose(); const writes = ui.document.writes;
  restarted.resolve({ ok: true, result }); await tick();
  assert.equal(ui.document.writes, writes);
});
