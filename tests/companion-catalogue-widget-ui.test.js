const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createDocument, tick } = require('./floating-panel-dom.cjs');
const appearance = () => ({ backgroundColor: '#151719e6', textColor: '#eef1f2', fontFamily: 'system', fontSize: 14 });
const snapshot = (extra = {}) => ({ language: 'fr', catalogue: { revision: 1, status: 'ready', demo: false }, downloads: { revision: 1, hasRoot: true, items: [], error: null }, floatingPanels: { revision: 0, appearance: { catalogue: appearance() }, canWrite: true, error: null }, catalogueShortcut: { registered: true }, ...extra });
const chart = (id, extra = {}) => ({ id, title: `Title ${id}`, artist: 'Artist', charter: 'Creator', downloadable: true, ...extra });
const uuid = n => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const download = (n, state = 'Downloading', extra = {}) => ({ id: uuid(n), chartId: `chart-${n}`, title: `Download ${n}`, artist: 'Artist', state, receivedBytes: 25, totalBytes: 100, updatedAt: `2026-10-${String(Math.min(n + 1, 28)).padStart(2, '0')}T12:00:00.000Z`, ...extra });
async function setup(t) {
  const { CatalogueWidgetControls } = await import('../companion/ui/catalogue-widget.js');
  const document = createDocument(), root = document.createElement('main'), calls = [];
  const html = readFileSync(require.resolve('../companion/ui/catalogue-widget.html'), 'utf8');
  for (const [, tag, id] of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"/g)) { const element = document.createElement(tag); element.id = id; root.append(element); }
  const controls = new CatalogueWidgetControls({ root, command: (name, payload) => new Promise(resolve => calls.push({ name, payload, resolve })) });
  t.after(() => controls.dispose());
  const get = selector => root.querySelector(selector);
  const search = value => { get('#catalogue-widget-query').value = value; get('#catalogue-widget-search-form').dispatchEvent(new Event('submit', { cancelable: true })); };
  const respond = async (index, { items = [chart('chart-1')], page = calls[index].payload?.page ?? 1, total = items.length, hasMore = false } = {}) => {
    calls[index].resolve({ ok: true, result: { items, page, total, hasMore, pageSize: 20, facets: { instruments: [], difficulties: [] } } }); await tick();
  };
  return { document, root, controls, calls, get, search, respond, html };
}

test('the native local widget uses a restrictive CSP and waits for explicit searching and downloading', async t => {
  const ui = await setup(t); ui.controls.update(snapshot());
  assert.match(ui.html, /connect-src 'none'/); assert.match(ui.html, /script-src 'self'/); assert.match(ui.html, /frame-src 'none'/);
  assert.equal(ui.calls.length, 0); assert.equal(ui.get('#catalogue-widget-downloads-panel').hidden, true);
  ui.get('#catalogue-widget-artist').value = 'Artist'; ui.get('#catalogue-widget-charter').value = 'Creator'; ui.get('#catalogue-widget-instrument').value = 'guitar'; ui.get('#catalogue-widget-difficulty').value = 'expert';
  ui.search('Title');
  assert.deepEqual(ui.calls[0], { name: 'catalogue.search', payload: { query: 'Title', artist: 'Artist', charter: 'Creator', genre: '', year: '', instrument: 'guitar', difficulty: 'expert', verified: 'all', installed: 'all', page: 1 }, resolve: ui.calls[0].resolve });
  await ui.respond(0); assert.equal(ui.calls.length, 1);
});

test('search results render hostile metadata as text and enqueue sends only the selected chart identifier', async t => {
  const ui = await setup(t); ui.controls.update(snapshot()); ui.search('unsafe');
  const unsafe = '<img src=x onerror=neverRun()>', result = chart('chart-1', { title: unsafe, artist: unsafe, charter: unsafe, downloadEndpoint: 'https://private.invalid', destination: 'C:/outside' });
  await ui.respond(0, { items: [result] });
  const row = ui.get('#catalogue-widget-results').children[0]; assert.equal(row.querySelector('h3').textContent, unsafe);
  assert.equal(row.querySelectorAll('p')[0].textContent, unsafe); assert.ok(!ui.root.textContent.includes('private.invalid'));
  row.querySelector('button').click(); assert.deepEqual(ui.calls[1].payload, { chartId: 'chart-1' }); assert.equal(ui.calls[1].name, 'downloads.enqueue');
  assert.equal(ui.get('#catalogue-widget-results').querySelector('button').disabled, true);
  ui.calls[1].resolve({ ok: true, result: { id: uuid(1) } }); await tick(); assert.match(ui.get('#catalogue-widget-feedback').textContent, /ajoutée/);
});

test('late searches and refresh responses cannot replace the current results or trigger an automatic transfer', async t => {
  const ui = await setup(t); ui.controls.update(snapshot()); ui.search('old'); ui.search('new');
  await ui.respond(1, { items: [chart('new')] }); await ui.respond(0, { items: [chart('old')] });
  assert.equal(ui.get('#catalogue-widget-results').children[0].dataset.chartId, 'new');
  ui.search('in-flight'); ui.get('#catalogue-widget-refresh').click(); assert.equal(ui.calls[3].name, 'catalogue.refresh');
  await ui.respond(2, { items: [chart('stale')] }); assert.equal(ui.get('#catalogue-widget-results').children.length, 0);
  ui.calls[3].resolve({ ok: true }); await tick(); assert.equal(ui.calls.length, 4); assert.match(ui.get('#catalogue-widget-feedback').textContent, /Lancez une recherche/);
});

test('pagination retains filters, and a changed catalogue blocks stale downloads until a new search', async t => {
  const ui = await setup(t); ui.controls.update(snapshot()); ui.search('song'); await ui.respond(0, { total: 40, hasMore: true });
  ui.get('#catalogue-widget-next').click(); assert.equal(ui.calls[1].payload.query, 'song'); assert.equal(ui.calls[1].payload.page, 2);
  await ui.respond(1, { page: 2, total: 40, items: [chart('second')] }); assert.equal(ui.get('#catalogue-widget-next').disabled, true);
  ui.controls.update(snapshot({ catalogue: { revision: 2, status: 'ready', demo: false } }));
  assert.equal(ui.get('#catalogue-widget-results').querySelector('button').disabled, true); assert.match(ui.get('#catalogue-widget-search-status').textContent, /catalogue a changé/);
  ui.search('song'); await ui.respond(2); assert.equal(ui.get('#catalogue-widget-results').querySelector('button').disabled, false);
});

test('missing download root, demo entries and queued charts stay disabled, and choosing a folder is explicit', async t => {
  const ui = await setup(t); ui.controls.update(snapshot({ downloads: { revision: 1, hasRoot: false, items: [] } })); ui.search('song'); await ui.respond(0);
  ui.get('#catalogue-widget-results').querySelector('button').click(); assert.equal(ui.calls.length, 1);
  ui.get('#catalogue-widget-choose-root').click(); assert.equal(ui.calls[1].name, 'downloads.chooseRoot'); assert.equal(ui.calls[1].payload, undefined);
  ui.calls[1].resolve({ ok: true, cancelled: true }); await tick(); assert.equal(ui.calls.length, 2);
  ui.controls.update(snapshot({ catalogue: { revision: 1, status: 'ready', demo: true } })); assert.equal(ui.get('#catalogue-widget-results').querySelector('button').disabled, true);
  ui.controls.update(snapshot({ downloads: { revision: 2, hasRoot: true, items: [download(1)] } }));
  assert.equal(ui.get('#catalogue-widget-results').querySelector('button').disabled, true); assert.match(ui.get('#catalogue-widget-results').textContent, /Déjà dans la file/);
});

test('download controls show real progress and send only allowed actions by queue id', async t => {
  const ui = await setup(t); ui.controls.update(snapshot({ downloads: { revision: 1, hasRoot: true, items: [download(1), download(2, 'Paused'), download(3, 'Failed')] } }));
  ui.get('#catalogue-widget-tab-downloads').click(); assert.equal(ui.get('#catalogue-widget-downloads-panel').hidden, false);
  const rows = ui.get('#catalogue-widget-downloads').children; assert.equal(rows[0].querySelector('progress').value, 25);
  const pause = rows[0].querySelectorAll('button').find(button => button.dataset.action === 'pause'); pause.click();
  assert.equal(ui.calls[0].name, 'downloads.pause'); assert.deepEqual(ui.calls[0].payload, { id: uuid(1) });
  assert.ok(ui.get('#catalogue-widget-downloads').children[0].querySelectorAll('button').every(button => button.disabled));
  ui.calls[0].resolve({ ok: true }); await tick();
  ui.get('#catalogue-widget-downloads').children[1].querySelectorAll('button').find(button => button.dataset.action === 'resume').click();
  assert.equal(ui.calls[1].name, 'downloads.resume'); assert.deepEqual(ui.calls[1].payload, { id: uuid(2) });
  ui.get('#catalogue-widget-downloads').children[2].querySelectorAll('button').find(button => button.dataset.action === 'retry').click(); assert.equal(ui.calls[2].name, 'downloads.retry');
});

test('recent tab contains only completed downloads, newest first, with a bounded count and localized dates', async t => {
  const ui = await setup(t), items = [download(99), ...Array.from({ length: 25 }, (_, index) => download(index + 1, 'Completed'))];
  ui.controls.update(snapshot({ downloads: { revision: 1, hasRoot: true, items } }));
  ui.get('#catalogue-widget-tab-recent').click(); const rows = ui.get('#catalogue-widget-recent').children;
  assert.equal(rows.length, 20); assert.equal(rows[0].dataset.downloadId, uuid(25)); assert.equal(rows[19].dataset.downloadId, uuid(6)); assert.equal(rows[0].querySelectorAll('button').length, 0);
  ui.document.documentElement.lang = 'en'; ui.document.defaultView.dispatchEvent(new Event('chartshub:languagechange'));
  assert.equal(ui.get('#catalogue-widget-recent').children[0].querySelector('time').textContent, new Date(items[25].updatedAt).toLocaleString('en-US'));
  assert.equal(ui.calls.length, 0);
});

test('keyboard tabs are accessible and Escape requests native hiding without a renderer close shortcut', async t => {
  const ui = await setup(t); ui.controls.update(snapshot());
  ui.get('#catalogue-widget-tab-search').dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'ArrowRight' }));
  assert.equal(ui.get('#catalogue-widget-tab-downloads').attributes['aria-selected'], 'true'); assert.equal(ui.document.activeElement, ui.get('#catalogue-widget-tab-downloads'));
  ui.document.defaultView.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }));
  assert.deepEqual(ui.calls[0].payload, { enabled: false }); assert.equal(ui.calls[0].name, 'catalogue.widget');
});

test('invalid identifiers and failed searches show a retryable state without interpreting untrusted contents', async t => {
  const ui = await setup(t); ui.controls.update(snapshot()); ui.search('bad'); await ui.respond(0, { items: [chart('../outside')] });
  assert.equal(ui.get('#catalogue-widget-results').children.length, 0); assert.match(ui.get('#catalogue-widget-search-status').textContent, /indisponible/);
  ui.search('recover'); await ui.respond(1); assert.equal(ui.get('#catalogue-widget-results').children.length, 1);
});

test('disposing cancels listeners and ignores all late search, download and appearance updates', async t => {
  const ui = await setup(t); ui.controls.update(snapshot()); ui.search('pending'); ui.controls.dispose(); const writes = ui.document.writes;
  await ui.respond(0); ui.controls.update(snapshot({ catalogue: { revision: 2 } })); ui.get('#catalogue-widget-close').click();
  assert.equal(ui.calls.length, 1); assert.equal(ui.document.writes, writes);
});
