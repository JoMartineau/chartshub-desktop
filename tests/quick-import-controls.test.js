'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
class Element extends EventTarget {
  constructor(tag, document) { super(); Object.assign(this, { tagName: tag, ownerDocument: document, children: [], disabled: false, hidden: false, textContent: '', attributes: {} }); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(key, value) { this.attributes[key] = value; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
async function fixture(command = async () => ({ ok: true })) {
  const document = { createElement: tag => new Element(tag, document) }, root = document.createElement('section');
  const { QuickImportControls } = await import('../companion/ui/quick-import-controls.js');
  return new QuickImportControls({ root, command });
}
const snapshot = (patch = {}, language = 'fr', hasRoot = true) => ({ language, library: { settings: { rootPath: hasRoot ? 'C:/Synthetic/Songs' : null } }, quickImport: {
  supported: true, platform: 'win32', selected: true, gameName: 'Clone Hero test', busy: false, connected: false, enabled: false, error: null, jobs: [], savedCanWrite: true, ...patch,
} });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const id = '11111111-1111-4111-8111-111111111111';
const texts = controls => Object.values(controls.nodes).map(node => node.textContent + ' ' + node.children.map(child => child.textContent).join(' ')).join(' ');

test('mounting, snapshots and language changes never connect, choose a file or start imports', async () => {
  const calls = [], controls = await fixture((...args) => { calls.push(args); return { ok: true }; });
  assert.equal(controls.nodes.connect.disabled, true);
  controls.update(snapshot()); controls.update(snapshot({}, 'en'));
  assert.deepEqual(calls, []); assert.match(controls.nodes.title.textContent, /BETA/);
});
test('a selected game and Songs root are both required before explicit connection', async () => {
  const controls = await fixture();
  controls.update(snapshot({ selected: false })); assert.equal(controls.nodes.connect.disabled, true);
  controls.update(snapshot({}, 'fr', false)); assert.equal(controls.nodes.connect.disabled, true); assert.match(controls.nodes.status.textContent, /Songs/);
  controls.update(snapshot()); assert.equal(controls.nodes.connect.disabled, false);
  controls.update(snapshot({ savedCanWrite: false })); assert.equal(controls.nodes.chooseGame.disabled, true); assert.equal(controls.nodes.connect.disabled, true); assert.match(controls.nodes.feedback.textContent, /réglages existant/);
});
test('only explicit fixed buttons send empty payloads without filesystem paths', async () => {
  const calls = [], controls = await fixture(async (name, payload) => { calls.push([name, payload]); return { ok: true }; });
  controls.update(snapshot()); await controls.run('chooseGame'); await controls.run('connect');
  controls.update(snapshot({ connected: true, enabled: true, jobs: [{ id, state: 'queued', confirmed: true }] }));
  await controls.run('refresh'); await controls.run('disable'); await controls.run('arbitrary');
  assert.deepEqual(calls, ['chooseGame', 'connect', 'refresh', 'disable'].map(name => ['quickImport.' + name, {}]));
});
test('disconnect wins over a late connection completion and keeps its controls responsive', async () => {
  const connect = deferred(), disconnect = deferred(), calls = [];
  const controls = await fixture(async name => { calls.push(name); return name === 'quickImport.connect' ? connect.promise : disconnect.promise; });
  controls.update(snapshot()); const first = controls.run('connect');
  assert.equal(controls.nodes.disable.disabled, false); const second = controls.run('disable');
  disconnect.resolve({ ok: true }); await second;
  connect.resolve({ ok: false, code: 'CONNECTION_UNAVAILABLE' }); await first;
  assert.equal(controls.pending, false); assert.equal(controls.localError, false); assert.equal(controls.nodes.connect.disabled, false);
  assert.deepEqual(calls, ['quickImport.connect', 'quickImport.disable']);
});
test('errors are fixed guidance and never render raw provider details or paths', async () => {
  const controls = await fixture(async () => ({ ok: false, code: 'C:/Private/token.txt', error: 'secret-token' }));
  controls.update(snapshot()); await controls.run('connect'); assert.equal(controls.nodes.feedback.hidden, false);
  assert.doesNotMatch(texts(controls), /Private|secret-token|token.txt/);
  controls.update(snapshot({ error: 'UNVERIFIED_BUILD' })); assert.match(controls.nodes.feedback.textContent, /terminer/);
  controls.localError = false; controls.update(snapshot({ error: 'UNVERIFIED_BUILD' })); assert.match(controls.nodes.feedback.textContent, /validé/);
  controls.update(snapshot({ error: 'CONNECTION_UNAVAILABLE' })); assert.match(controls.nodes.feedback.textContent, /Mods\/ChartsHub\.QuickImport\.dll/);
});
test('one thousand unrelated live snapshots perform no DOM writes or job-list replacement', async () => {
  const controls = await fixture(); controls.update(snapshot()); let writes = 0;
  for (const node of Object.values(controls.nodes)) {
    for (const field of ['textContent', 'hidden', 'disabled']) {
      let value = node[field]; Object.defineProperty(node, field, { get: () => value, set: next => { writes++; value = next; } });
    }
    const replace = node.replaceChildren; node.replaceChildren = function (...args) { writes++; return replace.apply(this, args); };
  }
  for (let index = 0; index < 1000; index++) controls.update({ ...snapshot(), state: { performance: { hits: index } } });
  assert.equal(writes, 0);
});
test('queued, local preparation and unconfirmed game results remain distinct and bilingual', async () => {
  const controls = await fixture(), jobs = [{ id, state: 'queued', confirmed: true }, { id, state: 'ready', confirmed: false }, { id, state: 'resolving', confirmed: false }];
  controls.update(snapshot({ connected: true, jobs }));
  assert.match(controls.nodes.jobs.children[0].textContent, /attente du menu/);
  assert.match(controls.nodes.jobs.children[1].textContent, /à vérifier/); assert.doesNotMatch(controls.nodes.jobs.children[1].textContent, /Prêt/);
  assert.match(controls.nodes.jobs.children[2].textContent, /Préparation/);
  controls.update(snapshot({ connected: true, jobs }, 'en')); assert.match(controls.nodes.jobs.children[0].textContent, /Waiting for a menu/); assert.match(controls.nodes.connect.textContent, /^Enable and connect$/);
});
test('optional beta explains the exact Stable build and every step in both languages', async () => {
  const controls = await fixture();
  for (const language of ['fr', 'en']) {
    controls.update(snapshot({}, language));
    assert.match(controls.nodes.title.textContent, /B[ÊE]TA/);
    assert.match(controls.nodes.compatibility.textContent, /1\.1\.0\.6142-final Stable/);
    assert.match(controls.nodes.optional.textContent, language === 'fr' ? /Facultatif.*désactivé/ : /Optional.*off/);
    assert.equal(controls.nodes.steps.children.length, 5);
    const instructions = controls.nodes.steps.children.flatMap(row => row.children.map(node => node.textContent)).join(' ');
    for (const required of ['MelonLoader', 'Songs', 'Clone Hero.exe', 'notes.chart', 'notes.mid', 'ZIP', 'SNG']) assert.equal(instructions.includes(required), true);
  }
});
test('job display is bounded and untrusted metadata never becomes markup', async () => {
  const controls = await fixture(); controls.update(snapshot({ jobs: Array.from({ length: 100 }, () => ({ id, state: '<img src=x>', title: '<script>secret()</script>' })) }));
  assert.equal(controls.nodes.jobs.children.length, 32); assert.doesNotMatch(texts(controls), /<img|<script>|secret/);
});
test('disposal removes listeners and ignores both successful and failing late results', async () => {
  const pending = deferred(), calls = [], controls = await fixture(name => { calls.push(name); return pending.promise; });
  controls.update(snapshot()); const task = controls.run('connect'); controls.dispose();
  controls.nodes.chooseGame.click(); pending.resolve({ ok: false }); await task;
  assert.deepEqual(calls, ['quickImport.connect']); assert.equal(controls.localError, false);
});

test('first setup is visible before connection steps and explains the real optional script in both languages', async () => {
  const controls = await fixture();
  assert(controls.root.children.indexOf(controls.nodes.installation) < controls.root.children.indexOf(controls.nodes.steps));
  assert.equal(controls.nodes.installation.attributes['aria-labelledby'], controls.nodes.installTitle.id);
  for (const language of ['fr', 'en']) {
    controls.update(snapshot({}, language));
    assert.match(controls.nodes.installTitle.textContent, /MelonLoader/);
    assert.equal(controls.nodes.setup.textContent, language === 'fr' ? 'Installer Quick Import' : 'Install Quick Import');
    assert.equal(controls.nodes.installSteps.children.length, 4);
    const instructions = controls.nodes.installSteps.children.flatMap(row => row.children.map(node => node.textContent)).join(' ');
    for (const required of ['1.1.0.6142-final Stable', 'Windows x64', '0.7.3', '.NET 6 Desktop Runtime', 'Clone Hero.exe', 'Songs', '0 Mods loaded', 'Mods/ChartsHub.QuickImport.dll']) assert(instructions.includes(required), required);
    assert.equal(controls.nodes.installCommand.textContent, 'powershell.exe -NoProfile -STA -File .\\Install-QuickImport.ps1 -Guided -Language ' + language);
    assert.doesNotMatch(controls.nodes.installCommand.textContent, /-Apply|-EnableBeta/);
    assert.match(controls.nodes.installRemoval.textContent, /Uninstall-QuickImport\.ps1/);
    assert.match(controls.nodes.installShared.textContent, /Accuracy/);
  }
});

test('setup help uses only fixed empty-payload guide commands and remains available without a selected game or Songs', async () => {
  const calls = [], controls = await fixture(async (name, payload) => { calls.push([name, payload]); return { ok: true }; });
  controls.update(snapshot({ supported: false, selected: false, savedCanWrite: false }, 'fr', false));
  assert.equal(controls.nodes.openPackage.id, 'quick-import-open-package'); assert.equal(controls.nodes.openPackage.disabled, false);
  assert.equal(controls.nodes.openPackage.type, 'button');
  await controls.openHelp('openPackage'); await controls.openHelp('prerequisites'); await controls.openHelp('setup'); await controls.openHelp('install'); await controls.run('openPackage');
  assert.deepEqual(calls, [['quickImport.openPackage', {}], ['quickImport.prerequisites', {}], ['quickImport.setup', {}]]);
  assert.equal(controls.nodes.connect.disabled, true); assert.equal(controls.nodes.installFeedback.hidden, true);
});

test('console buttons require a selected Windows game and send an explicit visibility choice', async () => {
  const calls = [], controls = await fixture(async (name, payload) => { calls.push([name, payload]); return { ok: true }; });
  controls.update(snapshot({ selected: false }));
  await controls.openHelp('hideConsole');
  assert.deepEqual(calls, []);
  controls.update(snapshot());
  await controls.openHelp('hideConsole');
  assert.match(controls.nodes.installNotice.textContent, /sera masqué/);
  controls.update(snapshot({}, 'en'));
  await controls.openHelp('showConsole');
  assert.match(controls.nodes.installNotice.textContent, /will be visible/);
  assert.deepEqual(calls, [['quickImport.console', { hidden: true }], ['quickImport.console', { hidden: false }]]);
});

test('opening a setup folder never cancels a pending connection or enables imports', async () => {
  const connecting = deferred(), opening = deferred(), calls = [];
  const controls = await fixture(name => { calls.push(name); return name === 'quickImport.connect' ? connecting.promise : opening.promise; });
  controls.update(snapshot()); const connect = controls.run('connect'), epoch = controls.commandEpoch, help = controls.openHelp('openPackage');
  assert.equal(controls.nodes.openPackage.disabled, true); await controls.openHelp('openPackage');
  assert.equal(controls.commandEpoch, epoch); assert.equal(controls.pending, true);
  opening.resolve({ ok: true }); await help; assert.equal(controls.pending, true); assert.equal(controls.nodes.openPackage.disabled, false);
  connecting.resolve({ ok: true }); await connect;
  assert.deepEqual(calls, ['quickImport.connect', 'quickImport.openPackage']); assert.equal(controls.pending, false); assert.equal(controls.localError, false);
});

test('guide failures remain fixed text and a retry cannot expose an error path or execute a script', async () => {
  const calls = [], controls = await fixture(async name => { calls.push(name); return { ok: false, error: 'C:/Private/key.json', code: '<img src=x>' }; });
  controls.update(snapshot()); await controls.openHelp('openPackage');
  assert.equal(controls.nodes.installFeedback.hidden, false); assert.doesNotMatch(controls.nodes.installFeedback.textContent, /Private|key.json|<img/);
  assert.equal(controls.pending, false); assert.equal(controls.nodes.openPackage.disabled, false); assert.deepEqual(calls, ['quickImport.openPackage']);
});

test('disposal removes the new guide button listeners and ignores a late guide failure', async () => {
  const result = deferred(), calls = [], controls = await fixture(name => { calls.push(name); return result.promise; });
  controls.update(snapshot()); const pending = controls.openHelp('openPackage'); controls.dispose();
  controls.nodes.openPackage.click(); controls.nodes.prerequisites.click(); result.resolve({ ok: false }); await pending;
  assert.deepEqual(calls, ['quickImport.openPackage']); assert.equal(controls.helpError, false);
});

test('Linux and macOS guides default from the main snapshot in FR and EN without Windows commands or active import controls', async () => {
  for (const platform of ['linux', 'darwin']) for (const language of ['fr', 'en']) {
    const calls = [], controls = await fixture((...args) => { calls.push(args); return { ok: true }; });
    controls.update(snapshot({ platform, supported: false }, language));
    assert.equal(controls.nodes.guideSystem.value, platform);
    assert.match(controls.nodes.installIntro.textContent, platform === 'linux' ? /Linux/ : /macOS/);
    assert.match(controls.nodes.status.textContent, /Scan Songs/);
    assert.equal(controls.nodes.installCommand.hidden, true); assert.equal(controls.nodes.installCommand.textContent, '');
    assert.equal(controls.nodes.openPackage.hidden, true); assert.equal(controls.nodes.openPackage.disabled, true);
    assert.equal(controls.nodes.actions.hidden, true);
    for (const action of ['chooseGame', 'connect', 'disable', 'refresh']) { assert.equal(controls.nodes[action].disabled, true); await controls.run(action); }
    await controls.openHelp('openPackage'); assert.deepEqual(calls, []);
    const instructions = controls.nodes.installSteps.children.flatMap(row => row.children.map(node => node.textContent)).join(' ');
    assert.doesNotMatch(instructions, /Install-QuickImport\.ps1|-Apply|-EnableBeta/);
    assert.match(instructions, platform === 'linux' ? /Installer\.Linux/ : /Installer\.MacOS\.dmg/);
    assert.match(instructions, platform === 'linux' ? /Wine/ : /arm64/);
  }
});

test('switching instructional guides never changes runtime support, activates a module or sends an OS from the renderer', async () => {
  const calls = [], controls = await fixture((...args) => { calls.push(args); return { ok: true }; });
  controls.update(snapshot({ platform: 'linux', supported: false }));
  controls.nodes.guideSystem.value = 'win32'; controls.nodes.guideSystem.dispatchEvent(new Event('change'));
  assert.equal(controls.nodes.guideSystem.value, 'win32'); assert.equal(controls.nodes.connect.disabled, true);
  assert.equal(controls.nodes.installCommand.textContent, ''); assert.equal(controls.nodes.openPackage.disabled, true);
  await controls.run('connect'); await controls.openHelp('release'); await controls.openHelp('prerequisites');
  assert.deepEqual(calls, [['quickImport.release', {}], ['quickImport.prerequisites', {}]]);
  controls.update(snapshot({ platform: 'linux', supported: true }, 'en'));
  assert.equal(controls.nodes.connect.disabled, true, 'Even a malformed supported flag never overrides the main platform');
  assert.equal(controls.nodes.guideSystem.value, 'win32', 'The chosen explanation survives language changes');
  controls.dispose(); controls.nodes.guideSystem.value = 'linux'; controls.nodes.guideSystem.dispatchEvent(new Event('change'));
  assert.equal(controls.guideSelection, 'win32');
});

test('unknown or missing platforms stay unvalidated without PowerShell examples while help stays explicit', async () => {
  const calls = [], controls = await fixture((...args) => { calls.push(args); return { ok: true }; });
  for (const platform of [undefined, 'unknown', 'freebsd', '<img>']) {
    controls.update(snapshot({ platform }, 'en'));
    assert.equal(controls.nodes.guideSystem.value, 'unknown'); assert.match(controls.nodes.status.textContent, /not validated/);
    assert.equal(controls.nodes.installCommand.textContent, ''); assert.equal(controls.nodes.connect.disabled, true);
    assert.doesNotMatch(texts(controls), /<img>/);
  }
  assert.deepEqual(calls, []);
});
