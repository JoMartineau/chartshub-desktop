'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
class Element extends EventTarget {
  constructor(tag, document) { super(); Object.assign(this, { tagName: tag, ownerDocument: document, children: [], dataset: {}, disabled: false, hidden: false, textContent: '', attributes: {} }); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(key, value) { this.attributes[key] = value; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
async function fixture(command = async () => ({ ok: true })) {
  const document = { createElement: tag => new Element(tag, document), querySelector: () => heading }, heading = document.createElement('h2'), root = document.createElement('section');
  const { GameWidgetControls } = await import('../companion/ui/game-widget-controls.js');
  return new GameWidgetControls({ root, command });
}
const snapshot = (patch = {}, language = 'fr', checks = []) => ({ language,
  features: { gameWidgets: true }, gameWidgets: { supported: true, revision: 4, accuracy: false, lyrics: false, enabled: false, status: 'off', connected: false, busy: false, ...patch },
  gameModPreflight: { revision: 2, supported: true, checked: checks.length > 0, compatible: true, busy: false, checks },
});
const change = (node, checked) => { node.checked = checked; node.dispatchEvent(new Event('change')); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const textTree = node => node.textContent + ' ' + node.children.map(textTree).join(' ');

test('optional controls never connect, inspect files or start anything on mount and snapshots', async () => {
  const calls = [], controls = await fixture((...args) => { calls.push(args); return { ok: true }; });
  assert.equal(controls.root.hidden, true);
  controls.update(snapshot()); controls.update(snapshot({}, 'en'));
  assert.equal(controls.root.hidden, false); assert.deepEqual(calls, []);
  assert.equal(controls.nodes.accuracy.checked, false); assert.equal(controls.nodes.lyrics.checked, false);
  assert.match(controls.nodes.note.textContent, /off every time/);
});

test('Accuracy and lyrics require an explicit apply and remain independent', async () => {
  const calls = [], controls = await fixture(async (...args) => { calls.push(args); return { ok: true }; });
  controls.update(snapshot()); change(controls.nodes.accuracy, true);
  assert.deepEqual(calls, []); assert.equal(controls.nodes.lyrics.checked, false);
  await controls.run('gameWidgets.configure');
  assert.deepEqual(calls, [['gameWidgets.configure', { revision: 4, accuracy: true, lyrics: false }]]);
  controls.update(snapshot({ accuracy: true, enabled: true, revision: 5 })); change(controls.nodes.lyrics, true);
  await controls.run('gameWidgets.configure');
  assert.deepEqual(calls[1], ['gameWidgets.configure', { revision: 5, accuracy: true, lyrics: true }]);
});

test('only fixed commands are forwarded, with no renderer filesystem targets', async () => {
  const calls = [], controls = await fixture(async (...args) => { calls.push(args); return { ok: true }; });
  controls.update(snapshot());
  for (const name of ['gameWidgets.check', 'gameWidgets.openPackage', 'gameWidgets.prerequisites', 'gameWidgets.install', 'arbitrary']) await controls.run(name);
  assert.deepEqual(calls, [['gameWidgets.check', { revision: 2 }], ['gameWidgets.openPackage', {}], ['gameWidgets.prerequisites', {}]]);
});

test('a slow diagnostic never prevents turning off active widgets', async () => {
  const check = deferred(), calls = [], controls = await fixture(async (...args) => { calls.push(args); return args[0] === 'gameWidgets.check' ? check.promise : { ok: true }; });
  controls.update(snapshot({ accuracy: true, lyrics: true, enabled: true })); const task = controls.run('gameWidgets.check');
  assert.equal(controls.nodes.check.disabled, true); assert.equal(controls.nodes.accuracy.disabled, false);
  change(controls.nodes.accuracy, false); change(controls.nodes.lyrics, false);
  assert.equal(controls.nodes.apply.disabled, false); await controls.run('gameWidgets.configure');
  assert.deepEqual(calls[1], ['gameWidgets.configure', { revision: 4, accuracy: false, lyrics: false }]);
  check.resolve({ ok: true }); await task; assert.equal(controls.nodes.check.disabled, false);
});

test('draft choices and a single pending apply survive repeated live snapshots', async () => {
  const pending = deferred(), calls = [], controls = await fixture(async (...args) => { calls.push(args); return pending.promise; });
  controls.update(snapshot()); change(controls.nodes.lyrics, true);
  controls.update(snapshot({ revision: 5 })); assert.equal(controls.nodes.lyrics.checked, true);
  const task = controls.run('gameWidgets.configure'); await controls.run('gameWidgets.configure');
  controls.update(snapshot({ revision: 6 })); assert.equal(controls.nodes.lyrics.checked, true); assert.equal(controls.nodes.apply.disabled, true); assert.equal(calls.length, 1);
  pending.resolve({ ok: false, code: 'GAME_WIDGETS_STALE' }); await task;
  assert.equal(controls.nodes.lyrics.checked, true); assert.match(controls.nodes.feedback.textContent, /choix ont changé/);
});

test('one thousand unrelated measurement snapshots cause no DOM writes', async () => {
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

test('setup diagnostics and errors are bounded, localized and never display raw details', async () => {
  const controls = await fixture(async () => ({ ok: false, code: 'C:/Private/secret-token', error: 'private-log' }));
  const checks = Array.from({ length: 20 }, () => ({ id: 'C:/Private/secret-token', code: 'raw-secret', level: '<script>' }));
  controls.update(snapshot({}, 'fr', [{ id: 'process', code: 'GAME_RUNNING', level: 'error' }, ...checks]));
  assert.equal(controls.nodes.report.children.length, 12); assert.match(controls.nodes.report.children[0].textContent, /Fermez Clone Hero/);
  await controls.run('gameWidgets.openPackage'); assert.equal(controls.nodes.feedback.hidden, false);
  assert.doesNotMatch(textTree(controls.root), /Private|secret-token|raw-secret|private-log|<script>/);
  controls.update(snapshot({}, 'en', [{ id: 'process', code: 'GAME_RUNNING', level: 'error' }]));
  assert.match(controls.nodes.report.children[0].textContent, /Close Clone Hero/);
  assert.match(controls.nodes.compatibility.textContent, /1\.1\.0\.6142-final Stable/);
});

test('unsupported systems cannot enable widgets and disposal removes all command listeners', async () => {
  const pending = deferred(), calls = [], controls = await fixture(async (...args) => { calls.push(args); return pending.promise; });
  controls.update(snapshot({ supported: false })); assert.equal(controls.nodes.accuracy.disabled, true); assert.equal(controls.nodes.apply.disabled, true);
  controls.update(snapshot()); const task = controls.run('gameWidgets.check'); controls.dispose();
  controls.nodes.openPackage.click(); controls.nodes.requirements.click(); pending.resolve({ ok: false }); await task;
  assert.equal(calls.length, 1); assert.equal(controls.error, null);
});
