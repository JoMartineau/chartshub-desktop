const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createDocument, tick } = require('./floating-panel-dom.cjs');

const snapshot = (extra = {}) => ({ catalogue: { revision: 1, status: 'ready', availableCount: 2, demo: false, error: null, warning: null, lastLoadedAt: null }, library: { revision: 1 }, ...extra });
const chart = (id, extra = {}) => ({ id, title: `Title ${id}`, artist: 'Artist', charter: 'Creator', verified: false, album: '', year: '', genre: '', instruments: ['Guitar'], difficulties: ['Expert'], artworkUrl: null, viewUrl: `https://chartshub.ca/index.html?chart=${id}`, downloadable: true, ...extra });
const externalChart = (md5 = 'a'.repeat(32), extra = {}) => chart('enchor:' + md5, { source: 'chorusencore', viewUrl: `https://enchor.us/chart/${md5}`, ...extra });

// Main catalogue controls also use replaceChildren, closest and data selectors.
// Extend the existing inert DOM fixture without introducing a global document.
function mainDocument() {
  const document = createDocument(), createElement = document.createElement.bind(document);
  document.createElement = tag => {
    const element = createElement(tag), append = element.append.bind(element), querySelectorAll = element.querySelectorAll.bind(element);
    const matches = (node, selector) => {
      const data = selector.match(/^\[data-([a-z-]+)(?:="([^"]*)")?\]$/);
      if (!data) return false;
      const key = data[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return Object.hasOwn(node.dataset, key) && (data[2] === undefined || node.dataset[key] === data[2]);
    };
    element.append = (...children) => { for (const child of children) child.parentElement = element; append(...children); };
    element.replaceChildren = (...children) => { element.textContent = ''; element.append(...children); };
    element.querySelectorAll = selector => selector.startsWith('[data-') ? element.children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]) : querySelectorAll(selector);
    element.closest = selector => { for (let node = element; node; node = node.parentElement) if (matches(node, selector)) return node; return null; };
    element.scrollIntoView = () => {};
    return element;
  };
  return document;
}
async function setup(t) {
  const { CatalogueControls } = await import('../companion/dist/settings/CatalogueControls.js');
  const document = mainDocument(), root = document.createElement('main'), calls = [];
  const html = readFileSync(require.resolve('../companion/ui/index.html'), 'utf8');
  for (const [, tag, id] of html.matchAll(/<(\w+)\b[^>]*\bid="(catalogue-[^"]+)"/g)) { const element = document.createElement(tag); element.id = id; root.append(element); }
  const controls = new CatalogueControls({ root, command: (name, payload) => new Promise(resolve => calls.push({ name, payload, resolve })) });
  t.after(() => controls.dispose()); controls.update(snapshot());
  const get = selector => root.querySelector(selector);
  const search = value => { get('#catalogue-query').value = value; get('#catalogue-search-form').dispatchEvent(new Event('submit', { cancelable: true })); };
  const respond = async (index, { items = [chart('native')], page = calls[index].payload?.page ?? 1, total = items.length, hasMore = false, ...extra } = {}) => {
    calls[index].resolve({ ok: true, result: { items, page, total, hasMore, pageSize: 20, facets: { instruments: [], difficulties: [] }, ...extra } }); await tick();
  };
  const card = id => get('#catalogue-items').children.find(node => node.dataset.catalogueId === id);
  const action = (id, name) => card(id)?.querySelector(`[data-catalogue-action="${name}"]`);
  return { document, root, calls, controls, html, get, search, respond, card, action };
}

test('main source selection defaults to all and explicit searches and paging retain the submitted source', async t => {
  const ui = await setup(t); assert.equal(ui.calls.length, 0);
  assert.match(ui.html, /<label\b[^>]*for="catalogue-source"/);
  for (const value of ['all', 'chartshub', 'chorusencore']) assert.match(ui.html, new RegExp('<option\\b[^>]*value="' + value + '"'));
  ui.search('default'); assert.equal(ui.calls[0].name, 'catalogue.search'); assert.equal(ui.calls[0].payload.source, 'all'); assert.equal(ui.calls[0].payload.externalSearch, true); await ui.respond(0);
  ui.get('#catalogue-source').value = 'chartshub'; ui.search('native'); assert.equal(ui.calls[1].payload.source, 'chartshub'); await ui.respond(1);
  ui.get('#catalogue-source').value = 'chorusencore'; ui.search('Encore'); assert.equal(ui.calls[2].payload.source, 'chorusencore'); assert.equal(ui.calls[2].payload.externalSearch, true);
  await ui.respond(2, { items: [externalChart()], total: 40, hasMore: true });
  ui.get('#catalogue-source').value = 'chartshub'; ui.get('#catalogue-next').click();
  assert.equal(ui.calls[3].payload.source, 'chorusencore'); assert.equal(ui.calls[3].payload.query, 'Encore'); assert.equal(ui.calls[3].payload.page, 2); assert.equal(ui.calls[3].payload.externalSearch, true);
  await ui.respond(3, { items: [externalChart('b'.repeat(32))], page: 2, total: 40 });
  ui.get('#catalogue-prev').click(); assert.equal(ui.calls[4].payload.source, 'chorusencore'); assert.equal(ui.calls[4].payload.page, 1); assert.equal(ui.calls[4].payload.externalSearch, true); await ui.respond(4);
});

test('main external cards attribute Chorus Encore and suppress forged native verification and association claims', async t => {
  const ui = await setup(t), hostile = '<img src=x onerror=neverRun()>', external = externalChart('c'.repeat(32), { title: hostile, artist: hostile, charter: hostile,
    verified: true, installed: { status: 'linked', reason: 'Forged association' }, reason: 'Forged native match', favorite: true, staffRole: 'administrator' });
  ui.search('mixed'); await ui.respond(0, { items: [chart('native', { verified: true, installed: { status: 'linked' } }), external] });
  const card = ui.card(external.id); assert.equal(card.dataset.source, 'chorusencore'); assert.equal(card.querySelector('.catalogue-source-badge').textContent, 'Chorus Encore');
  assert.equal(card.querySelector('h3').textContent, hostile); assert.equal(card.querySelector('.catalogue-item-artist').textContent, hostile); assert.equal(card.querySelectorAll('img').length, 0);
  assert.equal(card.querySelector('[data-catalogue-verified]'), null); assert.equal(card.querySelector('.catalogue-relation'), null); assert.equal(card.querySelector('.catalogue-match-reason'), null);
  assert.equal(ui.action(external.id, 'link'), null); assert.equal(ui.action(external.id, 'unlink'), null); assert.doesNotMatch(card.textContent, /Forged|vérifié/);
  assert.equal(ui.card('native').querySelector('[data-catalogue-verified]').dataset.catalogueVerified, 'true');
  assert.equal(ui.card('native').querySelector('.catalogue-relation').dataset.catalogueRelation, 'linked'); assert.equal(ui.calls.length, 1);
  ui.controls.showCandidates('local-test'); assert.equal(ui.calls[1].name, 'catalogue.candidates'); assert.deepEqual(ui.calls[1].payload, { localId: 'local-test' });
  ui.calls[1].resolve({ ok: true, result: { local: { id: 'local-test', title: 'Local', artist: 'Artist', charter: 'Creator' }, contextId: 'context-test', items: [chart('native'), external], linkedChartId: external.id, total: 2 } }); await tick();
  assert.ok(ui.action('native', 'link')); assert.equal(ui.action(external.id, 'link'), null); assert.equal(ui.action(external.id, 'unlink'), null);
});

test('main external open and download send only the current result identifier and retain keyboard focus', async t => {
  const ui = await setup(t), external = externalChart('d'.repeat(32), { viewUrl: 'https://private.invalid/open', downloadEndpoint: 'https://private.invalid/archive.zip', destination: 'C:/outside' });
  ui.search('safe actions'); await ui.respond(0, { items: [external] });
  const open = ui.action(external.id, 'open'); open.focus(); open.click(); open.click();
  assert.equal(ui.calls.length, 2); assert.equal(ui.calls[1].name, 'catalogue.open'); assert.deepEqual(ui.calls[1].payload, { chartId: external.id });
  ui.calls[1].resolve({ ok: true }); await tick(); assert.equal(ui.document.activeElement, open);
  assert.match(ui.get('#catalogue-feedback').textContent, /fiche Chorus Encore/);
  const download = ui.action(external.id, 'download'); download.focus(); download.click();
  assert.equal(ui.calls[2].name, 'downloads.enqueue'); assert.deepEqual(ui.calls[2].payload, { chartId: external.id });
  ui.calls[2].resolve({ ok: true }); await tick(); assert.equal(ui.document.activeElement, download); assert.equal(ui.calls.length, 3);
  assert.doesNotMatch(ui.root.textContent, /private\.invalid|C:\/outside/);
  ui.controls.update(snapshot({ library: { revision: 2 } }));
  assert.equal(ui.action(external.id, 'open').disabled, true); assert.equal(ui.action(external.id, 'download').disabled, true);
  const restored = ui.action(external.id, 'download'); assert.equal(ui.document.activeElement, restored, 'rerendered action restores focused chart identity');
  restored.click(); assert.equal(ui.calls.length, 3);
});

test('main late provider searches cannot replace current results and disposed controls ignore pending responses', async t => {
  const ui = await setup(t); ui.get('#catalogue-source').value = 'chorusencore'; ui.search('old Encore');
  ui.get('#catalogue-source').value = 'chartshub'; ui.search('current native');
  await ui.respond(1, { items: [chart('current')], external: { status: 'error' } }); await ui.respond(0, { items: [externalChart('e'.repeat(32))], external: { status: 'ready' } });
  assert.deepEqual(ui.get('#catalogue-items').children.map(node => node.dataset.catalogueId), ['current']); assert.equal(ui.get('#catalogue-external-status').hidden, true);
  assert.equal(ui.get('#catalogue-results').getAttribute('aria-busy'), 'false');
  ui.search('pending'); ui.controls.dispose(); const writes = ui.document.writes; await ui.respond(2, { items: [externalChart('f'.repeat(32))] });
  assert.equal(ui.document.writes, writes); assert.deepEqual(ui.get('#catalogue-items').children.map(node => node.dataset.catalogueId), ['current']);
});

test('main provider cooldown keeps native rows usable and makes no automatic search or transfer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ui = await setup(t); ui.search('fallback'); await ui.respond(0, { items: [chart('native')], nativeTotal: 1, externalTotal: 0,
    external: { status: 'cooldown', retryAfterSeconds: 60, unsupported: ['verified', 'installed'], localFilters: ['genre'] } });
  const status = ui.get('#catalogue-external-status'); assert.equal(status.hidden, false); assert.match(status.textContent, /réessayez dans 60 s/);
  assert.match(status.textContent, /Filtres non pris en charge par Chorus Encore : créateur vérifié, association locale/); assert.match(status.textContent, /page Chorus Encore reçue/);
  assert.equal(ui.action('native', 'open').disabled, false); assert.equal(ui.action('native', 'download').disabled, false);
  t.mock.timers.tick(180000); assert.equal(ui.calls.length, 1);
  ui.action('native', 'download').click(); assert.equal(ui.calls[1].name, 'downloads.enqueue'); assert.deepEqual(ui.calls[1].payload, { chartId: 'native' }); ui.calls[1].resolve({ ok: true }); await tick();
  ui.search('explicit retry'); assert.equal(ui.calls[2].payload.externalSearch, true); await ui.respond(2);
});

test('main catalogue refresh follows up without another external provider search', async t => {
  const ui = await setup(t); ui.get('#catalogue-source').value = 'chorusencore'; ui.search('Encore'); await ui.respond(0, { items: [externalChart()] });
  ui.get('#catalogue-refresh').click(); assert.equal(ui.calls[1].name, 'catalogue.refresh'); assert.deepEqual(ui.calls[1].payload, {});
  ui.calls[1].resolve({ ok: true }); await tick();
  assert.equal(ui.calls[2].name, 'catalogue.search'); assert.equal(ui.calls[2].payload.source, 'chorusencore'); assert.equal(ui.calls[2].payload.query, 'Encore'); assert.equal(ui.calls[2].payload.externalSearch, false);
  await ui.respond(2, { items: [externalChart()], external: { status: 'idle' } }); assert.equal(ui.calls.length, 3);
});
