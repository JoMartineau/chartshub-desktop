const test = require('node:test');
const assert = require('node:assert/strict');

class Element extends EventTarget {
  constructor(document, tag) {
    super(); this.ownerDocument = document; this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {};
    this.hidden = false; this.disabled = false; this.text = '';
  }
  set textContent(value) { this.ownerDocument.writes++; this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw Error('History metadata must never be interpreted as HTML'); }
  append(...children) { this.ownerDocument.writes++; this.children.push(...children); }
  setAttribute(name, value) { this.ownerDocument.writes++; this.attributes[name] = String(value); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const matches = element => selector.startsWith('#') ? element.id === selector.slice(1) : selector.startsWith('.') ? element.className === selector.slice(1) : element.tagName === selector;
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const state = (rootPath = 'C:\\Songs', revision = 1) => ({ rootPath, revision });
const entry = (id = 'record', extra = {}) => ({
  id, at: '2026-10-10T12:30:00.000Z', mode: 'normal', keep: { id: 'keeper', relativePath: 'Keep/notes.chart', targetRelativePath: 'Keep' }, cancelled: false,
  candidates: [
    { id: 'b', relativePath: 'B/notes.chart', targetRelativePath: 'B', status: 'recycled', reason: null },
    { id: 'c', relativePath: 'C/notes.chart', targetRelativePath: 'C', status: 'failed', reason: 'Private C:/unsafe' },
    { id: 'd', relativePath: 'D/notes.chart', targetRelativePath: 'D', status: 'not-attempted', reason: null },
  ], ...extra,
});
async function setup(t) {
  const { CleanupHistoryControls } = await import('../companion/dist/settings/CleanupHistoryControls.js');
  const document = { writes: 0, documentElement: { lang: 'fr' }, defaultView: new EventTarget(), createElement(tag) { return new Element(this, tag); } };
  const root = document.createElement('main'), calls = [];
  const controls = new CleanupHistoryControls({ root, command: (name, payload) => new Promise(resolve => calls.push({ name, payload, resolve })) });
  t.after(() => controls.dispose());
  const get = selector => root.querySelector(selector);
  const respond = async (index, { entries = [entry()], total = entries.length, ...extra } = {}) => {
    const call = calls[index]; assert.ok(call, `Request ${index} must exist`);
    call.resolve({ ok: true, result: { entries, total, offset: call.payload.offset, limit: call.payload.limit, maxEntries: 200, ...extra } });
    await tick();
  };
  return { controls, document, root, get, calls, respond };
}

test('history is read only, lazy, labeled and disabled without a Songs folder', async t => {
  const ui = await setup(t);
  assert.equal(ui.get('#library-cleanup-history-toggle').disabled, true);
  assert.equal(ui.get('#library-cleanup-history-body').hidden, true);
  ui.get('#library-cleanup-history-toggle').click(); assert.equal(ui.calls.length, 0);
  ui.controls.update(state()); assert.equal(ui.calls.length, 0);
  assert.equal(ui.get('#library-cleanup-history-toggle').attributes['aria-controls'], 'library-cleanup-history-body');
  assert.equal(ui.get('#library-cleanup-history-status').attributes['role'], 'status');
  ui.get('#library-cleanup-history-toggle').click();
  assert.equal(ui.calls.length, 1); assert.deepEqual(ui.calls[0].payload, { offset: 0, limit: 10 }); assert.equal(ui.calls[0].name, 'library.cleanupHistory');
  assert.equal(ui.get('#library-cleanup-history-rows').attributes['aria-busy'], 'true');
  await ui.respond(0, { entries: [] });
  assert.match(ui.get('#library-cleanup-history-status').textContent, /Aucun nettoyage/);
  assert.equal(ui.get('#library-cleanup-history-next').disabled, true);
  assert.equal(ui.get('#library-cleanup-history-prev').disabled, true);
  assert.equal(ui.get('#library-cleanup-history-rows').attributes['aria-busy'], 'false');
});

test('records show the keeper and true partial outcomes with text-only paths and no native error disclosure', async t => {
  const ui = await setup(t); ui.controls.update(state()); ui.get('#library-cleanup-history-toggle').click();
  const unsafe = '<img src=x onerror=neverRun()>', record = entry('safe', { mode: 'force', cancelled: true });
  record.keep.relativePath = `${unsafe}/notes.chart`; record.candidates[0].targetRelativePath = unsafe;
  await ui.respond(0, { entries: [record] });
  const card = ui.get('#library-cleanup-history-rows').children[0], text = card.textContent;
  assert.equal(card.dataset.historyId, 'safe'); assert.match(text, /Version conservée/); assert.ok(text.includes(unsafe));
  assert.match(text, /différences confirmées/); assert.match(text, /Envoyée à la Corbeille/); assert.match(text, /Échec de la mise à la Corbeille/);
  assert.match(text, /Non tentée — conservée/); assert.match(text, /Nettoyage interrompu/); assert.ok(!text.includes('Private'));
  assert.deepEqual(card.querySelectorAll('li').map(row => row.dataset.historyStatus), ['recycled', 'failed', 'not-attempted']);
  assert.equal(card.querySelector('time').dateTime, record.at);
  assert.equal(card.querySelectorAll('button').length, 0, 'history provides no destructive or restore action');
});

test('history paginates recent records and refresh resets to the newest page', async t => {
  const ui = await setup(t); ui.controls.update(state()); ui.get('#library-cleanup-history-toggle').click();
  await ui.respond(0, { total: 25 });
  assert.equal(ui.get('#library-cleanup-history-pagination').hidden, false);
  ui.get('#library-cleanup-history-next').click(); assert.deepEqual(ui.calls[1].payload, { offset: 10, limit: 10 });
  assert.equal(ui.get('#library-cleanup-history-next').disabled, true);
  await ui.respond(1, { entries: [entry('older')], total: 25 });
  assert.equal(ui.get('#library-cleanup-history-prev').disabled, false);
  ui.get('#library-cleanup-history-next').click(); await ui.respond(2, { total: 25 }); assert.equal(ui.get('#library-cleanup-history-next').disabled, true);
  ui.get('#library-cleanup-history-prev').click(); assert.equal(ui.calls[3].payload.offset, 10); await ui.respond(3, { total: 25 });
  ui.get('#library-cleanup-history-refresh').click(); assert.equal(ui.calls[4].payload.offset, 0); await ui.respond(4, { total: 25 });
  assert.ok(ui.calls.every(call => call.name === 'library.cleanupHistory' && !Object.hasOwn(call.payload, 'rootPath')));
});

test('switching Songs clears old records immediately and late responses never contaminate another folder', async t => {
  const ui = await setup(t); ui.controls.update(state()); ui.get('#library-cleanup-history-toggle').click();
  ui.controls.update(state('C:\\Other Songs', 2)); assert.equal(ui.calls.length, 2);
  await ui.respond(1, { entries: [entry('other-folder')] });
  await ui.respond(0, { entries: [entry('stale-folder')] });
  assert.equal(ui.get('#library-cleanup-history-rows').children[0].dataset.historyId, 'other-folder');
  ui.controls.update(state('C:\\Third Songs', 3)); assert.equal(ui.get('#library-cleanup-history-rows').children.length, 0);
  ui.controls.update(state(null, 4)); assert.equal(ui.get('#library-cleanup-history-body').hidden, true);
  await ui.respond(2); assert.equal(ui.get('#library-cleanup-history-rows').children.length, 0);
});

test('a new committed revision reloads visible history while routine snapshots and collapsed panels stay idle', async t => {
  const ui = await setup(t); ui.controls.update(state()); ui.get('#library-cleanup-history-toggle').click(); await ui.respond(0);
  ui.controls.update(state()); ui.controls.update(state()); assert.equal(ui.calls.length, 1);
  ui.controls.update(state('C:\\Songs', 2)); assert.equal(ui.calls.length, 2); await ui.respond(1);
  ui.get('#library-cleanup-history-toggle').click(); ui.controls.update(state('C:\\Songs', 3)); ui.controls.refresh();
  assert.equal(ui.calls.length, 2); assert.equal(ui.get('#library-cleanup-history-body').hidden, true);
  ui.get('#library-cleanup-history-toggle').click(); assert.equal(ui.calls.length, 3); await ui.respond(2);
});

test('history errors are generic, retryable and never show stale records as a successful response', async t => {
  const ui = await setup(t); ui.controls.update(state()); ui.get('#library-cleanup-history-toggle').click(); await ui.respond(0);
  ui.get('#library-cleanup-history-refresh').click(); ui.calls[1].resolve({ ok: false, error: 'Private C:/profile' }); await tick();
  assert.equal(ui.get('#library-cleanup-history-rows').children.length, 0);
  assert.match(ui.get('#library-cleanup-history-status').textContent, /restent inchangés/); assert.doesNotMatch(ui.root.textContent, /Private/);
  assert.equal(ui.get('#library-cleanup-history-refresh').disabled, false);
  ui.get('#library-cleanup-history-refresh').click(); await ui.respond(2, { entries: [entry('recovered')] });
  assert.equal(ui.get('#library-cleanup-history-rows').children[0].dataset.historyId, 'recovered');
});

test('disposed history ignores pending results and removes action listeners', async t => {
  const ui = await setup(t); ui.controls.update(state()); ui.get('#library-cleanup-history-toggle').click(); ui.controls.dispose();
  const writes = ui.document.writes;
  await ui.respond(0); ui.controls.update(state('C:\\Other Songs')); ui.controls.refresh(); ui.get('#library-cleanup-history-toggle').click();
  assert.equal(ui.calls.length, 1); assert.equal(ui.document.writes, writes);
});

test('visible dates follow live French and English language changes without another history request', async t => {
  const ui = await setup(t); ui.controls.update(state()); ui.get('#library-cleanup-history-toggle').click(); await ui.respond(0);
  const date = ui.get('#library-cleanup-history-rows').querySelector('time'), expected = new Date(entry().at);
  assert.equal(date.textContent, expected.toLocaleString('fr-FR'));
  ui.document.documentElement.lang = 'en'; ui.document.defaultView.dispatchEvent(new Event('chartshub:languagechange'));
  assert.equal(date.textContent, expected.toLocaleString('en-US')); assert.equal(ui.calls.length, 1);
  ui.document.documentElement.lang = 'fr'; ui.document.defaultView.dispatchEvent(new Event('chartshub:languagechange'));
  assert.equal(date.textContent, expected.toLocaleString('fr-FR')); assert.equal(ui.calls.length, 1);
  ui.controls.dispose(); const writes = ui.document.writes;
  ui.document.documentElement.lang = 'en'; ui.document.defaultView.dispatchEvent(new Event('chartshub:languagechange'));
  assert.equal(ui.document.writes, writes);
});
