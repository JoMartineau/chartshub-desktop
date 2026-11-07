'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

class Element extends EventTarget {
  constructor(tag, document) { super(); Object.assign(this, { tagName: tag, ownerDocument: document, children: [], disabled: false, hidden: false, checked: false, textContent: '', value: '', attributes: {} }); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(key, value) { this.attributes[key] = value; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
async function fixture(command = async () => ({ ok: true })) {
  const document = { createElement: tag => new Element(tag, document) }, root = document.createElement('section');
  const module = await import('../companion/ui/catalogue-sync-controls.js');
  return { ...module, controls: new module.CatalogueSyncControls({ root, command }) };
}
function snapshot(patch = {}, language = 'fr') {
  return { language, downloads: { rootPath: 'C:/Synthetic/Songs' }, catalogueSync: { phase: 'idle', mode: 'all', total: 0, processed: 0, concurrency: 2, includeVideo: false, canResume: true, counts: { new: 0, update: 0, unchanged: 0, conflict: 0, failed: 0, completed: 0 }, items: [], ...patch } };
}
const text = node => node.textContent + ' ' + node.children.map(text).join(' ');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('loading, reconnecting and changing language never fetch inventory or download anything', async () => {
  const calls = [], { controls } = await fixture((...args) => { calls.push(args); return { ok: true }; });
  assert.equal(controls.nodes.analyze.disabled, true);
  controls.update(snapshot()); controls.update(snapshot({}, 'en'));
  assert.deepEqual(calls, []); assert.equal(controls.nodes.analyze.disabled, false); assert.equal(controls.nodes.start.hidden, true);
  assert.match(controls.nodes.title.textContent, /ChartsHub/); assert.match(controls.nodes.scope.textContent, /external sources/);
});

test('analysis requires a chosen folder and a host that actually supports synchronization', async () => {
  const { controls } = await fixture(); controls.update({ language: 'en', catalogueSync: { phase: 'idle' } });
  assert.equal(controls.nodes.analyze.disabled, true); assert.match(controls.nodes.status.textContent, /Choose.*folder/);
  controls.update(snapshot({ supported: false })); assert.equal(controls.nodes.analyze.disabled, true);
  controls.update({ ...snapshot(), catalogueSync: null }); assert.equal(controls.nodes.analyze.disabled, true);
});

test('explicit analysis sends only bounded options and never a renderer filesystem path', async () => {
  const calls = [], { controls } = await fixture(async (...args) => { calls.push(args); return { ok: true }; });
  controls.update(snapshot()); controls.nodes.mode.value = 'installed'; controls.nodes.concurrency.value = '4'; controls.nodes.includeVideo.checked = true;
  await controls.run('analyze'); await controls.run('arbitrary');
  assert.deepEqual(calls, [['catalogueSync.analyze', { mode: 'installed', concurrency: 4, includeVideo: true }]]);
  controls.nodes.mode.value = '../../other'; controls.nodes.concurrency.value = '100000'; controls.nodes.includeVideo.checked = false;
  await controls.run('analyze');
  assert.deepEqual(calls[1], ['catalogueSync.analyze', { mode: 'all', concurrency: 2, includeVideo: false }]);
});

test('ready summary precedes download and changing analyzed options requires a fresh analysis', async () => {
  const calls = [], { controls } = await fixture(async (...args) => { calls.push(args); return { ok: true }; });
  controls.update(snapshot({ phase: 'ready', total: 100000, processed: 100000, counts: { new: 30, update: 2, unchanged: 99967, conflict: 1 } }));
  assert.equal(controls.nodes.start.disabled, false); assert.equal(controls.nodes.start.hidden, false);
  assert.equal(controls.countNodes.new.value.textContent, '31'); assert.equal(controls.countNodes.conflict, undefined);
  assert.match(controls.nodes.preservation.textContent, /dossier séparé/);
  assert.equal(controls.nodes.progress.max, 100000);
  controls.nodes.includeVideo.checked = true; controls.nodes.includeVideo.dispatchEvent(new Event('change'));
  assert.equal(controls.nodes.start.disabled, true); assert.match(controls.nodes.status.textContent, /options ont changé/);
  await controls.run('start'); assert.equal(calls.length, 0);
  controls.update(snapshot({ phase: 'analyzing', includeVideo: true }));
  controls.update(snapshot({ phase: 'ready', includeVideo: true, counts: { new: 1 } }));
  await controls.run('start'); assert.deepEqual(calls, [['catalogueSync.start', {}]]);
});

test('unchanged-only analysis cannot start an empty download batch', async () => {
  const { controls } = await fixture(); controls.update(snapshot({ phase: 'ready', total: 100000, processed: 100000, counts: { unchanged: 100000 } }));
  assert.equal(controls.nodes.start.disabled, true); assert.equal(controls.countNodes.unchanged.value.textContent, (100000).toLocaleString('fr'));
});

test('pause is responsive while analysis command waits and supersedes its late result', async () => {
  const analysis = deferred(), pause = deferred(), calls = [], { controls } = await fixture(name => { calls.push(name); return name.endsWith('analyze') ? analysis.promise : pause.promise; });
  controls.update(snapshot()); const first = controls.run('analyze');
  controls.update(snapshot({ phase: 'analyzing' })); assert.equal(controls.nodes.pause.disabled, false);
  const second = controls.run('pause'); pause.resolve({ ok: true }); await second;
  controls.update(snapshot({ phase: 'paused', total: 100000 }));
  analysis.resolve({ ok: false, error: 'private-provider-token' }); await first;
  assert.equal(controls.pending, null); assert.equal(controls.localError, false); assert.equal(controls.nodes.resume.disabled, false);
  assert.deepEqual(calls, ['catalogueSync.analyze', 'catalogueSync.pause']);
});

test('pause, resume and retry commands are explicit and phase constrained', async () => {
  const calls = [], { controls } = await fixture(async (...args) => { calls.push(args); return { ok: true }; });
  controls.update(snapshot({ phase: 'running' })); assert.equal(controls.nodes.mode.disabled, true); assert.equal(controls.nodes.includeVideo.disabled, true);
  await controls.run('analyze'); await controls.run('pause');
  controls.update(snapshot({ phase: 'paused' })); await controls.run('resume');
  controls.update(snapshot({ phase: 'completed', counts: { failed: 2 } })); await controls.run('retry');
  assert.deepEqual(calls, ['pause', 'resume', 'retry'].map(action => ['catalogueSync.' + action, {}]));
});

test('100000-item status is projected into only 50 recent safe text rows', async () => {
  const { controls, projectCatalogueSync } = await fixture();
  const large = snapshot({ phase: 'completed', total: 100000, processed: 100000, items: Array.from({ length: 100000 }, (_, index) => ({ title: 'Synthetic ' + index, state: 'completed' })) });
  assert.equal(projectCatalogueSync(large).items.length, 50); controls.update(large); assert.equal(controls.nodes.items.children.length, 50);
  assert.equal(controls.nodes.items.children[0].children[0].textContent, 'Synthetic 99950');
  controls.update(snapshot({ items: [{ title: '<img src=x onerror=secret()>', state: '<script>secret()</script>', error: 'provider-secret' }], error: 'C:/Private/token.txt' }));
  assert.equal(controls.nodes.items.children[0].children[0].textContent, '<img src=x onerror=secret()>');
  assert.equal(controls.nodes.items.children[0].children[1].textContent, 'État indisponible');
  assert.doesNotMatch(controls.nodes.feedback.textContent, /Private|secret|token/);
});

test('one thousand unrelated gameplay updates cause no DOM writes', async () => {
  const { controls } = await fixture(); controls.update(snapshot({ phase: 'paused', total: 100000 })); let writes = 0;
  function watch(node) {
    for (const key of ['textContent', 'disabled', 'hidden', 'checked', 'value', 'max']) {
      let current = node[key]; Object.defineProperty(node, key, { get: () => current, set: value => { writes++; current = value; } });
    }
    const set = node.setAttribute; node.setAttribute = function (...args) { writes++; set.apply(this, args); };
    const replace = node.replaceChildren; node.replaceChildren = function (...args) { writes++; replace.apply(this, args); };
    node.children.forEach(watch);
  }
  watch(controls.root);
  for (let index = 0; index < 1000; index++) controls.update({ ...snapshot({ phase: 'paused', total: 100000 }), state: { performance: { hits: index } } });
  assert.equal(writes, 0);
});

test('both language variants explain scope, saved progress and preserved user changes', async () => {
  const { controls } = await fixture();
  for (const language of ['fr', 'en']) {
    controls.update(snapshot({ phase: 'paused' }, language));
    assert.match(controls.nodes.title.textContent, /ChartsHub/);
    assert.match(controls.nodes.mode.children[1].textContent, language === 'fr' ? /charts suivies/ : /tracked charts/);
    assert.match(controls.nodes.status.textContent, language === 'fr' ? /progression est conservée/ : /Progress is saved/);
    assert.match(controls.nodes.preservation.textContent, language === 'fr' ? /dossier séparé/ : /separate folder/);
    assert.match(controls.nodes.videoHelp.textContent, language === 'fr' ? /conservé/ : /saved/);
  }
});

test('failed commands are fixed guidance and dispose suppresses late results and listeners', async () => {
  const pending = deferred(), calls = [], { controls } = await fixture(name => { calls.push(name); return pending.promise; });
  controls.update(snapshot()); const operation = controls.run('analyze'); controls.dispose();
  pending.resolve({ ok: false, error: 'private-path-secret' }); await operation; controls.nodes.analyze.click();
  assert.deepEqual(calls, ['catalogueSync.analyze']); assert.equal(controls.localError, false);
  assert.doesNotMatch(text(controls.root), /private-path-secret/);
});

test('an interrupted incomplete analysis offers reanalysis while a saved complete plan offers resume', async () => {
  const { controls } = await fixture();
  controls.update(snapshot({ phase: 'paused', canResume: false, error: 'SYNC_ANALYSIS_INTERRUPTED' }));
  assert.equal(controls.nodes.analyze.disabled, false); assert.equal(controls.nodes.resume.hidden, true); assert.match(controls.nodes.status.textContent, /Relancez Analyser/);
  controls.update(snapshot({ phase: 'paused', canResume: true })); assert.equal(controls.nodes.resume.disabled, false); assert.equal(controls.nodes.analyze.disabled, true);
  controls.update(snapshot({ phase: 'error', canResume: true })); assert.equal(controls.nodes.resume.hidden, false);
});

test('a missing server update has actionable bilingual guidance without raw provider details', async () => {
  const { controls } = await fixture(async () => ({ ok: false, code: 'SYNC_SERVER_UPDATE_REQUIRED', error: 'private-provider-url' }));
  controls.update(snapshot()); await controls.run('analyze'); assert.match(controls.nodes.feedback.textContent, /site ChartsHub doit être mis à jour/);
  controls.localError = false; controls.update(snapshot({ phase: 'error', error: 'SYNC_SERVER_UPDATE_REQUIRED' }, 'en'));
  assert.match(controls.nodes.feedback.textContent, /website must be updated/); assert.doesNotMatch(controls.nodes.feedback.textContent, /private-provider/);
});

test('out-of-space failures retain an explicit resume action and live running items read Downloading', async () => {
  const { controls } = await fixture();
  for (const language of ['fr', 'en']) {
    controls.update(snapshot({ phase: 'error', error: 'SYNC_NO_SPACE', canResume: true, counts: { failed: 0 }, items: [{ title: 'Signal', state: 'running' }] }, language));
    assert.equal(controls.nodes.resume.disabled, false); assert.equal(controls.nodes.resume.hidden, false);
    assert.match(controls.nodes.feedback.textContent, language === 'fr' ? /espace disque.*Reprendre/ : /disk space.*Resume/);
    assert.equal(controls.nodes.items.children[0].children[1].textContent, language === 'fr' ? 'Téléchargement' : 'Downloading');
    assert.match(controls.nodes.preservation.textContent, language === 'fr' ? /Sans empreinte fiable.*téléchargés/ : /Without a reliable source fingerprint.*downloaded/);
  }
});

test('UI mounts inside existing downloads workspace and sync progress avoids global reconciliation', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '../companion/ui', file), 'utf8');
  assert.match(read('index.html'), /downloads-folder-row[\s\S]*?id="catalogue-sync-controls"[\s\S]*?id="game-integrations-panel"/);
  const panel = read('panel.js');
  assert.match(panel, /import \{ CatalogueSyncControls \}/); assert.match(panel, /catalogueSyncControls\.update\(snapshot\)/); assert.match(panel, /catalogueSyncControls\.dispose\(\)/);
  assert(panel.indexOf('catalogueSyncControls.update(snapshot)') < panel.indexOf('const measurementsOnly ='));
  assert.match(read('panel-snapshot.js'), /quickImport, catalogueSync, requestDiscovery/);
});
