'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
class Element extends EventTarget {
  constructor(tag, document) { super(); this.tagName = tag; this.ownerDocument = document; this.children = []; this.disabled = false; this.hidden = false; this.textContent = ''; this.attributes = {}; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
async function fixture(command) {
  const document = { createElement: tag => new Element(tag, document) }, root = document.createElement('section');
  const { InputViewerControls } = await import('../companion/ui/input-viewer-controls.js');
  return new InputViewerControls({ root, command });
}
const snapshot = (inputViewer = {}, stream = {}, language = 'fr') => ({ language, inputViewer: { available: true, outputOpen: false, outputEditing: false, outputAlwaysOnTop: true, ...inputViewer }, stream });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('Companion can copy an OBS Browser link while Stream is off and keeps the settings action separate', async () => {
  const calls = [], controls = await fixture(async (...args) => { calls.push(args); return { ok: true }; });
  assert.equal(controls.button.disabled, true); controls.update(snapshot());
  assert.equal(controls.copyButton.disabled, false); assert.match(controls.copyButton.textContent, /Activer Stream/);
  controls.copyButton.click(); await settle();
  assert.deepEqual(calls, [['inputViewer.copyUrl', {}]]); assert.match(controls.feedback.textContent, /copié/);
  controls.button.click(); await settle(); assert.deepEqual(calls[1], ['inputViewer.open', {}]);
  controls.update(snapshot({}, { inputViewerUrl: 'http://127.0.0.1:38473/input-viewer?token=redacted' }, 'en'));
  assert.equal(controls.copyButton.textContent, 'Copy OBS browser link'); assert.match(controls.description.textContent, /Browser Source/);
  assert(!controls.description.textContent.includes('Window Capture')); controls.dispose();
});

test('game widget show, positioning, lock, hide and topmost actions use the independent output contract', async () => {
  const calls = [], controls = await fixture(async (...args) => { calls.push(args); return { ok: true }; }); controls.update(snapshot());
  assert.equal(controls.hideButton.disabled, true); assert.equal(controls.topCheckbox.disabled, true);
  controls.showButton.click(); await settle(); assert.deepEqual(calls.pop(), ['inputViewer.showOutput', { editing: false }]);
  controls.positionButton.click(); await settle(); assert.deepEqual(calls.pop(), ['inputViewer.showOutput', { editing: true }]);
  controls.update(snapshot({ outputOpen: true, outputEditing: true })); assert.match(controls.status.textContent, /Positionnement/);
  controls.positionButton.click(); await settle(); assert.deepEqual(calls.pop(), ['inputViewer.showOutput', { editing: false }]);
  controls.topCheckbox.checked = false; controls.topCheckbox.dispatchEvent(new Event('change')); await settle();
  assert.deepEqual(calls.pop(), ['inputViewer.showOutput', { editing: true, alwaysOnTop: false }]);
  controls.update(snapshot({ outputOpen: true, outputEditing: false, outputAlwaysOnTop: false }));
  assert.equal(controls.showButton.disabled, true); assert.equal(controls.topCheckbox.checked, false); assert.match(controls.status.textContent, /clics traversent/);
  controls.hideButton.click(); await settle(); assert.deepEqual(calls.pop(), ['inputViewer.hideOutput', {}]); controls.dispose();
});

test('pending actions prevent duplicate commands, show failures and stop updating disposed controls', async () => {
  let complete, calls = 0;
  const controls = await fixture(() => { calls++; return new Promise(resolve => { complete = resolve; }); }); controls.update(snapshot());
  controls.copyButton.click(); controls.button.click(); controls.hideButton.click(); assert.equal(calls, 1); assert.equal(controls.positionButton.disabled, true);
  complete({ ok: false, error: 'Synthetic unavailable output' }); await settle();
  assert.equal(controls.feedback.hidden, false); assert.equal(controls.feedback.textContent, 'Synthetic unavailable output'); assert.equal(controls.copyButton.disabled, false);
  controls.copyButton.click(); const status = controls.status.textContent, feedback = controls.feedback.textContent;
  controls.dispose(); complete({ ok: true }); await settle(); controls.update(snapshot({ outputOpen: true }, {}, 'en'));
  assert.equal(controls.status.textContent, status); assert.equal(controls.feedback.textContent, feedback);
  controls.copyButton.click(); await settle(); assert.equal(calls, 2);
});

test('positioning a hidden widget enters editing even when its previous editing state was retained', async () => {
  const calls = [], controls = await fixture(async (...args) => { calls.push(args); return { ok: true }; });
  controls.update(snapshot({ outputOpen: false, outputEditing: true }));
  assert.equal(controls.positionButton.textContent, 'Déplacer et redimensionner'); assert.equal(controls.positionButton.disabled, false);
  controls.positionButton.click(); await settle();
  assert.deepEqual(calls, [['inputViewer.showOutput', { editing: true }]]);
  controls.update(snapshot({ outputOpen: true, outputEditing: true }));
  assert.equal(controls.positionButton.textContent, 'Verrouiller la position');
  controls.positionButton.click(); await settle(); assert.deepEqual(calls[1], ['inputViewer.showOutput', { editing: false }]);
  controls.dispose();
});
