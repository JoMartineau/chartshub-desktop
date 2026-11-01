'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { defaultSessionWidgetSettings } = require('../companion/session-widget-model.cjs');
class Element extends EventTarget {
  constructor(tag, document) { super(); Object.assign(this, { tagName: tag, ownerDocument: document, children: [], textContent: '', attributes: {}, disabled: false, checked: false, value: '', hidden: false }); }
  append(...nodes) { this.children.push(...nodes); } replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  click() { this.dispatchEvent(new Event('click')); } input(value) { if (this.type === 'checkbox') this.checked = value; else this.value = String(value); this.dispatchEvent(new Event('input')); }
}
const snapshot = (patch = {}) => ({ language: 'fr', sessionWidgets: { revision: 0, settings: defaultSessionWidgetSettings(), ...patch } });
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
async function fixture(command = async () => ({ ok: true })) {
  const document = { createElement: tag => new Element(tag, document) }, root = document.createElement('section'), calls = [];
  const { SessionWidgetControls } = await import('../companion/ui/session-widget-controls.js');
  return { root, calls, controls: new SessionWidgetControls({ root, command: (name, payload) => { calls.push([name, payload]); return command(name, payload); } }) };
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
test('Sharing controls mount unchecked and neither snapshots nor language changes send a command', async () => {
  const f = await fixture(), n = f.controls.nodes; f.controls.update(snapshot()); f.controls.update({ ...snapshot(), language: 'en' });
  assert.equal(n.shareChat.checked, false); assert.equal(n.shareActivity.checked, false); assert.equal(n.showViewerNames.checked, false);
  assert.equal(n.copyChat.disabled, true); assert.equal(n.copyActivity.disabled, true); assert.equal(n.apply.disabled, true); assert.deepEqual(f.calls, []);
  assert.match(n.shareChatPrivacy.textContent, /messages and viewer names/); assert.match(n.intro.textContent, /off every time/);
});
test('An explicit Apply sends exactly revision plus all settings; copying never enables chat or sends a URL', async () => {
  const f = await fixture((name, payload) => Promise.resolve(name === 'sessionWidgets.configure' ? { ok: true, result: { revision: 1, settings: payload.settings } } : { ok: true })); const n = f.controls.nodes;
  n.shareChat.input(true); n.fontSize.input(24); n.apply.click(); await settle();
  assert.deepEqual(f.calls[0], ['sessionWidgets.configure', { revision: 0, settings: { ...defaultSessionWidgetSettings(), shareChat: true, fontSize: 24 } }]);
  assert.equal(n.copyChat.disabled, false); n.copyChat.click(); await settle();
  assert.deepEqual(f.calls[1], ['sessionWidgets.copyUrl', { kind: 'chat' }]); assert.equal(f.calls.length, 2); assert.match(n.feedback.textContent, /Lien copié/);
  assert.equal(n.shareActivity.checked, false); assert.equal(n.showViewerNames.checked, false);
});
test('A thousand unrelated live snapshots write no DOM and a draft survives updates without changing its revision', async () => {
  const f = await fixture(), value = snapshot(); f.controls.update(value); let writes = 0;
  for (const node of descendants(f.root)) { for (const key of ['textContent', 'checked', 'value', 'disabled', 'hidden']) { let prior = node[key]; Object.defineProperty(node, key, { get: () => prior, set: next => { writes++; prior = next; } }); } const attribute = node.setAttribute.bind(node); node.setAttribute = (...args) => { writes++; attribute(...args); }; }
  for (let i = 0; i < 1000; i++) f.controls.update({ ...value, state: { timing: i }, drums: { meters: { left: i / 1000 } } }); assert.equal(writes, 0);
  f.controls.nodes.fontSize.input(31); for (let i = 0; i < 50; i++) f.controls.update({ ...value, state: { timing: i } }); assert.equal(f.controls.nodes.fontSize.value, '31'); assert.equal(f.controls.baseRevision, 0);
});
test('An external revision preserves the draft and requires explicit reload rather than overwriting new sharing choices', async () => {
  const f = await fixture(), n = f.controls.nodes; n.shareChat.input(true); n.fontSize.input(27);
  const next = snapshot({ revision: 1, settings: { ...defaultSessionWidgetSettings(), shareActivity: true, fontSize: 20 } }); f.controls.update(next);
  assert.equal(n.fontSize.value, '27'); assert.equal(n.apply.disabled, true); assert.match(n.status.textContent, /changé ailleurs/);
  n.apply.click(); await settle(); assert.equal(f.calls.length, 0); n.reset.click(); assert.equal(n.fontSize.value, '20'); assert.equal(n.shareChat.checked, false); assert.equal(n.shareActivity.checked, true); assert.equal(f.controls.dirty, false);
});
test('Invalid bounds never cross IPC, failed commands preserve drafts, and pending actions cannot be duplicated', async () => {
  let finish; const f = await fixture(() => new Promise(resolve => { finish = resolve; })), n = f.controls.nodes;
  n.fontSize.input(49); n.apply.click(); await settle(); assert.equal(f.calls.length, 0); assert.match(n.feedback.textContent, /12 à 48/);
  n.fontSize.input(25); n.apply.click(); n.apply.click(); await settle(); assert.equal(f.calls.length, 1); assert.equal(n.shareChat.disabled, true);
  finish({ ok: false, error: 'SECRET C:/Private' }); await settle(); assert.equal(n.fontSize.value, '25'); assert.equal(n.apply.disabled, false); assert.doesNotMatch(n.feedback.textContent, /SECRET|Private/); assert.match(n.feedback.textContent, /Réessayez/);
});
test('FR and EN labels translate, applying forces reconciliation, and disposal ignores a late successful response', async () => {
  let finish; const f = await fixture(() => new Promise(resolve => { finish = resolve; })), n = f.controls.nodes;
  f.controls.update({ ...snapshot(), language: 'en' }); assert.equal(n.shareActivityLabel.textContent, 'Share activity in OBS'); n.shareActivity.input(true); n.apply.click(); await settle();
  const before = n.status.textContent; f.controls.dispose(); finish({ ok: true, result: { revision: 1, settings: { ...defaultSessionWidgetSettings(), shareActivity: true } } }); await settle();
  assert.equal(n.status.textContent, before); n.copyActivity.click(); assert.equal(f.calls.length, 1);
});
