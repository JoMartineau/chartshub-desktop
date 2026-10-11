const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { setMaxListeners } = require('node:events');
const { test } = require('node:test');
const vm = require('node:vm');

class Element extends EventTarget {
  constructor(document, tag) {
    super(); this.ownerDocument = document; this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {};
    this.disabled = false; this.hidden = false; this.checked = false; this.text = '';
    this.classList = { toggle: (key, value) => { this.attributes[key] = value; } };
  }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('Song metadata must be rendered as text'); }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(name, listener, options) { if (options?.signal) setMaxListeners(0, options.signal); super.addEventListener(name, listener, options); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const matches = item => selector.startsWith('#') ? item.id === selector.slice(1)
      : selector.startsWith('.') ? item.className?.split(' ').includes(selector.slice(1)) : item.tagName === selector;
    return this.children.flatMap(item => [...(matches(item) ? [item] : []), ...item.querySelectorAll(selector)]);
  }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() { this.scrollCount = (this.scrollCount ?? 0) + 1; }
}
const id = letter => letter.repeat(64);
const target = (letter, extra = {}) => ({ id: id(letter), relativePath: `Group/${letter}/notes.chart`, targetRelativePath: `Group/${letter}`,
  kind: 'folder', bytes: 120, audio: { status: 'verified', count: 1, bytes: 80 }, ...extra });
const differences = () => ({ status: 'verified', files: [
  { name: 'notes.chart', category: 'notes', status: 'changed', keeperBytes: 10, copyBytes: 12 },
  { name: 'song.opus', category: 'audio', status: 'identical', keeperBytes: 80, copyBytes: 80 },
] });
const plan = (extra = {}) => ({ planId: 'a'.repeat(32), revision: 1,
  keepers: [target('a', { title: '<title & song>', artist: 'Artist', charter: 'Charter' }), target('b', { title: 'Second group' })],
  candidates: [target('c', { keeperId: id('a'), eligible: false, forceable: true, reason: 'Notes différentes.', differences: differences() }),
    target('d', { keeperId: id('b'), eligible: false, forceable: true, bytes: 180, differences: differences() })],
  summary: { totalGroups: 5, readyGroups: 2, needsKeeperGroups: 1, blockedGroups: 1, identicalGroups: 1, candidateCount: 2 }, ...extra });
const state = (extra = {}) => ({ rootPath: 'C:\\Songs', revision: 1, scanning: false, busy: false, progress: null, ...extra });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
class CustomEvent extends Event { constructor(type, options) { super(type); this.detail = options?.detail; } }

async function fixture(t) {
  const document = { activeElement: null, documentElement: { lang: 'fr' }, body: null, readyState: 'loading', addEventListener() {}, createElement(tag) { return new Element(this, tag); } };
  const window = new EventTarget(); window.ChartsHubCompanion = { initialLanguage: 'fr' };
  vm.runInNewContext(readFileSync(require.resolve('../companion/ui/localization.js'), 'utf8'), { window, document, CustomEvent, console });
  const old = { window: globalThis.window, document: globalThis.document };
  globalThis.window = window; globalThis.document = document;
  const root = document.createElement('main'), html = readFileSync(require.resolve('../companion/ui/index.html'), 'utf8');
  for (const [, tag, key] of html.matchAll(/<(\w+)\b[^>]*\bid="(library-bulk-cleanup[^"]*)"/g)) {
    const element = document.createElement(tag); element.id = key; root.append(element);
  }
  const { BulkDifferentCleanupControls } = await import('../companion/dist/settings/BulkDifferentCleanupControls.js');
  const calls = [], ui = { document, root, calls, refreshes: 0, availability: 0, window, get: selector => root.querySelector(selector) };
  ui.controls = new BulkDifferentCleanupControls({ root, command: (name, payload) => new Promise(resolve => calls.push({ name, payload, resolve })),
    refreshIndex: () => { ui.refreshes++; }, availabilityChanged: () => { ui.availability++; } });
  t.after(() => {
    ui.controls.dispose();
    for (const key of ['window', 'document']) if (old[key] === undefined) delete globalThis[key]; else globalThis[key] = old[key];
  });
  ui.controls.update(state());
  ui.check = letter => ui.get('#library-bulk-cleanup-candidates').querySelectorAll('input').find(item => item.dataset.cleanupId === id(letter));
  ui.prepare = async (result = plan()) => {
    ui.get('#library-bulk-cleanup-prepare').click();
    const call = calls.at(-1); assert.equal(call.name, 'library.prepareBulkCleanup'); call.resolve({ ok: true, result }); await tick();
  };
  ui.select = (letter, checked = true) => { const check = ui.check(letter); check.checked = checked; check.dispatchEvent(new Event('change')); };
  return ui;
}

test('bulk cleanup prepares different copies across groups and protects every keeper without selecting copies', async t => {
  const ui = await fixture(t); await ui.prepare();
  assert.equal(ui.get('#library-bulk-cleanup-plan').hidden, false);
  assert.deepEqual(ui.get('#library-bulk-cleanup-candidates').querySelectorAll('input').map(item => item.dataset.cleanupId), [id('c'), id('d')]);
  assert.equal(ui.check('c').checked, false); assert.equal(ui.check('d').checked, false);
  assert.equal(ui.get('#library-bulk-cleanup-recycle').disabled, true);
  assert.match(ui.get('#library-bulk-cleanup-summary').textContent, /1 choix de version requis.*1 groupe\(s\) bloqué/s);
  assert.match(ui.get('#library-bulk-cleanup-candidates').textContent, /<title & song>.*Group\/a.*notes.chart.*Modifié/s);
  assert.equal(ui.check('a'), undefined); assert.equal(ui.check('b'), undefined);
  assert.equal(ui.get('#library-bulk-cleanup-candidates').querySelectorAll('.library-file-differences').every(details => details.open), true);
});

test('select all is explicit, clear unchecks everything, and selected total spans all groups', async t => {
  const ui = await fixture(t); await ui.prepare();
  ui.get('#library-bulk-cleanup-select-all').click();
  assert.equal(ui.check('c').checked, true); assert.equal(ui.check('d').checked, true);
  assert.match(ui.get('#library-bulk-cleanup-selection').textContent, /2 copie.*300 octets/);
  ui.get('#library-bulk-cleanup-clear').click();
  assert.equal(ui.check('c').checked, false); assert.equal(ui.check('d').checked, false);
  assert.equal(ui.get('#library-bulk-cleanup-recycle').disabled, true); assert.equal(ui.calls.length, 1);
});

test('one execution submits exactly the selected copies from two groups and defers the final scan', async t => {
  const ui = await fixture(t); await ui.prepare(); ui.get('#library-bulk-cleanup-select-all').click();
  ui.get('#library-bulk-cleanup-recycle').click(); ui.get('#library-bulk-cleanup-recycle').click();
  assert.equal(ui.calls.length, 2); const call = ui.calls[1];
  assert.equal(call.name, 'library.recycleBulkDifferences'); assert.deepEqual(call.payload, { planId: 'a'.repeat(32), revision: 1, ids: [id('c'), id('d')] });
  assert.equal(ui.controls.busy, true); assert.equal(ui.get('#library-bulk-cleanup').attributes['aria-busy'], 'true');
  ui.controls.update(state({ revision: 2, progress: { phase: 'executing', processed: 2, total: 2 } }));
  call.resolve({ ok: true, result: { recycledIds: [id('c'), id('d')], failed: [], cancelled: false, refreshRequested: false } }); await tick();
  assert.equal(ui.refreshes, 1); assert.equal(ui.calls.some(item => item.name === 'library.scan'), false);
  assert.equal(ui.get('#library-bulk-cleanup-plan').hidden, true); assert.equal(ui.get('#library-bulk-cleanup-result').hidden, false);
  assert.match(ui.get('#library-bulk-cleanup-result').textContent, /2 copie.*Actualiser à la fin/s);
  assert.equal(ui.document.activeElement, ui.get('#library-bulk-cleanup-result'));
  assert.equal(ui.controls.busy, false);
});

test('individual selection submits only that copy and a partial result reports the retained failures', async t => {
  const ui = await fixture(t); await ui.prepare(); ui.select('d'); ui.get('#library-bulk-cleanup-recycle').click();
  assert.deepEqual(ui.calls[1].payload.ids, [id('d')]);
  ui.calls[1].resolve({ ok: true, result: { recycledIds: [], failed: [{ id: id('d'), reason: 'Locked' }], cancelled: false, refreshRequested: false } }); await tick();
  assert.equal(ui.refreshes, 0); assert.match(ui.get('#library-bulk-cleanup-result').textContent, /0 copie.*1 échec.*restent en place/s);
  assert.equal(ui.get('#library-bulk-cleanup-result').attributes['is-error'], true);
});

test('native cancellation consumes the plan and never claims a deletion', async t => {
  const ui = await fixture(t); await ui.prepare(); ui.select('c'); ui.get('#library-bulk-cleanup-recycle').click();
  ui.calls[1].resolve({ ok: true, cancelled: true }); await tick();
  assert.match(ui.get('#library-bulk-cleanup-result').textContent, /annulée.*Aucun fichier/s);
  assert.equal(ui.get('#library-bulk-cleanup-plan').hidden, true); assert.equal(ui.refreshes, 0);
  await ui.prepare(plan({ planId: 'b'.repeat(32) })); assert.equal(ui.check('c').checked, false);
});

test('stopping a running batch requests one cancellation and reports partial completed work', async t => {
  const ui = await fixture(t); await ui.prepare(); ui.get('#library-bulk-cleanup-select-all').click(); ui.get('#library-bulk-cleanup-recycle').click();
  ui.get('#library-bulk-cleanup-cancel').click(); ui.get('#library-bulk-cleanup-cancel').click();
  assert.equal(ui.calls.length, 3); assert.equal(ui.calls[2].name, 'library.cancelBulkCleanup');
  ui.calls[2].resolve({ ok: true }); ui.calls[1].resolve({ ok: true, result: { recycledIds: [id('c')], failed: [], cancelled: true, refreshRequested: false } }); await tick();
  assert.match(ui.get('#library-bulk-cleanup-result').textContent, /1 copie.*interrompue.*1 copie\(s\) non traitée\(s\) restent en place/s);
  assert.doesNotMatch(ui.get('#library-bulk-cleanup-result').textContent, /Aucun fichier/);
  assert.equal(ui.refreshes, 1);
});

test('changing root, revision, starting a scan or changing the keeper discards stale selection and late preparation', async t => {
  for (const next of [state({ rootPath: 'D:\\Songs' }), state({ revision: 2 }), state({ scanning: true }), 'choice', 'context']) {
    const ui = await fixture(t); ui.get('#library-bulk-cleanup-prepare').click(); const pending = ui.calls[0];
    if (next === 'choice' || next === 'context') ui.root.dispatchEvent(new Event(`companion:duplicate-${next === 'choice' ? 'choice' : 'context'}-changed`));
    else ui.controls.update(next);
    pending.resolve({ ok: true, result: plan() }); await tick();
    assert.equal(ui.get('#library-bulk-cleanup-plan').hidden, true); assert.equal(ui.get('#library-bulk-cleanup-recycle').disabled, true);
    ui.get('#library-bulk-cleanup-recycle').click(); assert.equal(ui.calls.length, 1);
  }
});

test('unsafe or stale bulk plans never offer a deletion checkbox', async t => {
  const unsafe = [plan({ revision: 2 }), plan({ summary: { candidateCount: 2 } }), plan({ candidates: [target('a', { keeperId: id('a'), eligible: false, forceable: true, differences: differences() })], summary: { ...plan().summary, candidateCount: 1 } }),
    plan({ candidates: [target('c', { keeperId: id('a'), eligible: false, forceable: true, audio: { status: 'missing', count: 0, bytes: 0 }, differences: differences() })], summary: { ...plan().summary, candidateCount: 1 } })];
  for (const result of unsafe) {
    const ui = await fixture(t); await ui.prepare(result);
    assert.equal(ui.get('#library-bulk-cleanup-plan').hidden, true); assert.equal(ui.get('#library-bulk-cleanup-recycle').disabled, true);
    assert.match(ui.get('#library-bulk-cleanup-status').textContent, /indisponible/);
  }
});

test('mismatched completion receipts cannot claim success for an unselected copy', async t => {
  for (const result of [
    { recycledIds: [id('a')], failed: [], cancelled: false, refreshRequested: false },
    { recycledIds: [id('c'), id('c')], failed: [], cancelled: false, refreshRequested: false },
    { recycledIds: [], failed: [], cancelled: false, refreshRequested: false },
    { recycledIds: [id('c')], failed: [], cancelled: false, refreshRequested: true },
  ]) {
    const ui = await fixture(t); await ui.prepare(); ui.select('c'); ui.get('#library-bulk-cleanup-recycle').click();
    ui.calls[1].resolve({ ok: true, result }); await tick();
    assert.match(ui.get('#library-bulk-cleanup-result').textContent, /n’a pas pu être confirmée/);
    assert.equal(ui.refreshes, 0); assert.equal(ui.get('#library-bulk-cleanup-plan').hidden, true);
  }
});

test('failure after one successful target reports the remaining unprocessed selected copy without claiming it moved', async t => {
  const third = target('e', { keeperId: id('a'), eligible: false, forceable: true, differences: differences() });
  const ui = await fixture(t); await ui.prepare(plan({ candidates: [...plan().candidates, third], summary: { ...plan().summary, candidateCount: 3 } }));
  ui.get('#library-bulk-cleanup-select-all').click(); ui.get('#library-bulk-cleanup-recycle').click();
  assert.deepEqual(ui.calls[1].payload.ids, [id('c'), id('d'), id('e')]);
  ui.calls[1].resolve({ ok: true, result: { recycledIds: [id('c')], failed: [{ id: id('d'), reason: 'Locked' }], cancelled: false, refreshRequested: false } }); await tick();
  assert.match(ui.get('#library-bulk-cleanup-result').textContent, /1 copie.*1 échec.*1 copie\(s\) non traitée\(s\) restent en place/s);
  assert.equal(ui.refreshes, 1); assert.equal(ui.get('#library-bulk-cleanup-plan').hidden, true);
});

test('an empty plan explains keeper choices without showing an enabled delete button', async t => {
  const ui = await fixture(t); await ui.prepare(plan({ keepers: [], candidates: [], summary: { totalGroups: 2, readyGroups: 0, needsKeeperGroups: 2, blockedGroups: 0, identicalGroups: 0, candidateCount: 0 } }));
  assert.match(ui.get('#library-bulk-cleanup-status').textContent, /Aucune copie.*Comparer/s);
  assert.equal(ui.get('#library-bulk-cleanup-recycle').disabled, true); assert.equal(ui.get('#library-bulk-cleanup-select-all').disabled, true);
});

test('real FR/EN language switches preserve selection and translate dynamic file comparisons', async t => {
  const ui = await fixture(t); await ui.prepare(); ui.select('c');
  ui.window.ChartshubCompanionLanguage.apply('en');
  assert.equal(ui.get('#library-bulk-cleanup-prepare').textContent, 'Prepare different copies');
  assert.match(ui.get('#library-bulk-cleanup-selection').textContent, /1 selected copy.*120 bytes/);
  assert.match(ui.get('#library-bulk-cleanup-candidates').textContent, /Delete this different copy anyway.*Changed/s);
  assert.equal(ui.check('c').checked, true); assert.equal(ui.check('d').checked, false);
  ui.window.ChartshubCompanionLanguage.apply('fr');
  assert.match(ui.get('#library-bulk-cleanup-selection').textContent, /1 copie.*120 octets/);
  assert.equal(ui.check('c').checked, true); assert.match(ui.get('#library-bulk-cleanup-candidates').textContent, /Modifié/);
});

test('user interaction during the batch prevents completion from stealing focus', async t => {
  const ui = await fixture(t); await ui.prepare(); ui.select('c'); ui.get('#library-bulk-cleanup-recycle').click();
  const input = ui.document.createElement('input'); input.focus(); ui.root.dispatchEvent(new Event('keydown'));
  ui.calls[1].resolve({ ok: true, result: { recycledIds: [id('c')], failed: [], cancelled: false, refreshRequested: false } }); await tick();
  assert.equal(ui.document.activeElement, input); assert.equal(ui.get('#library-bulk-cleanup-result').scrollCount, undefined);
});

test('disposal ignores a late cleanup result and cannot start a new batch', async t => {
  const ui = await fixture(t); await ui.prepare(); ui.select('c'); ui.get('#library-bulk-cleanup-recycle').click(); ui.controls.dispose();
  ui.calls[1].resolve({ ok: true, result: { recycledIds: [id('c')], failed: [], cancelled: false, refreshRequested: false } }); await tick();
  assert.equal(ui.get('#library-bulk-cleanup-result').hidden, true); assert.equal(ui.refreshes, 0);
  ui.get('#library-bulk-cleanup-prepare').click(); assert.equal(ui.calls.length, 2);
});
