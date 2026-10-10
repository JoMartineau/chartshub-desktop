const test = require('node:test');
const assert = require('node:assert/strict');
const { createDocument, tick } = require('./floating-panel-dom.cjs');
const defaults = () => ({ backgroundColor: '#151719e6', textColor: '#eef1f2', fontFamily: 'system', fontSize: 14 });
const state = (extra = {}) => ({ revision: 0, appearance: { catalogue: defaults(), filters: defaults() }, error: null, canWrite: true, ...extra });
async function setup(t, panels) {
  const { FloatingPanelsControls } = await import('../companion/ui/floating-panels-controls.js');
  const document = createDocument(), root = document.createElement('main'), calls = [];
  const controls = new FloatingPanelsControls({ root, panels, command: (name, payload) => new Promise(resolve => calls.push({ name, payload, resolve })) });
  t.after(() => controls.dispose());
  const get = selector => root.querySelector(selector), change = (selector, value) => { const input = get(selector); input.value = String(value); input.dispatchEvent(new Event('input')); input.dispatchEvent(new Event('change')); };
  return { root, document, controls, calls, get, change, update: value => controls.update({ floatingPanels: value }) };
}

test('appearance controls require a valid snapshot and editing changes only the local preview', async t => {
  const ui = await setup(t); assert.equal(ui.get('#floating-panels-save').disabled, true);
  ui.update(state()); assert.equal(ui.get('#floating-panels-save').disabled, true);
  ui.change('#floating-panels-opacity', 50); ui.change('#floating-panels-text', '#ffcc00'); ui.change('#floating-panels-font', 'consolas'); ui.change('#floating-panels-font-size', 20);
  const style = ui.get('#floating-panels-preview').style;
  assert.equal(style.getPropertyValue('--floating-background'), '#15171980'); assert.equal(style.getPropertyValue('--floating-text'), '#ffcc00');
  assert.equal(style.getPropertyValue('--floating-font'), 'Consolas, monospace'); assert.equal(style.getPropertyValue('--floating-font-size'), '20px');
  assert.equal(ui.calls.length, 0); assert.equal(ui.get('#floating-panels-save').disabled, false);
  assert.equal(ui.get('#floating-panels-opacity').attributes['aria-valuetext'], '50 %');
});

test('explicit save sends a complete appearance with the current revision and applies a confirmed response', async t => {
  const ui = await setup(t); ui.update(state({ revision: 3 })); ui.change('#floating-panels-font-size', 18); ui.get('#floating-panels-save').click();
  assert.equal(ui.calls[0].name, 'panels.appearance');
  assert.deepEqual(ui.calls[0].payload, { revision: 3, panel: 'catalogue', appearance: { ...defaults(), fontSize: 18 } });
  assert.equal(ui.get('#floating-panels-save').disabled, true); assert.equal(ui.get('#floating-panels-panel').disabled, true);
  ui.calls[0].resolve({ ok: true, result: state({ revision: 4, appearance: { catalogue: { ...defaults(), fontSize: 18 }, filters: defaults() } }) }); await tick();
  assert.match(ui.get('#floating-panels-feedback').textContent, /enregistrée/); assert.equal(ui.get('#floating-panels-save').disabled, true);
  ui.change('#floating-panels-font-size', 19); ui.get('#floating-panels-save').click(); assert.equal(ui.calls[1].payload.revision, 4);
});

test('each panel retains its own unsaved draft while progress snapshots leave edits untouched', async t => {
  const ui = await setup(t); ui.update(state()); ui.change('#floating-panels-font-size', 19);
  ui.update(state({ revision: 1 })); assert.equal(ui.get('#floating-panels-font-size').value, '19');
  ui.change('#floating-panels-panel', 'filters'); assert.equal(ui.get('#floating-panels-font-size').value, '14');
  ui.change('#floating-panels-font-size', 11); ui.change('#floating-panels-panel', 'catalogue'); assert.equal(ui.get('#floating-panels-font-size').value, '19');
  ui.change('#floating-panels-panel', 'filters'); assert.equal(ui.get('#floating-panels-font-size').value, '11');
  ui.get('#floating-panels-save').click(); assert.equal(ui.calls[0].payload.panel, 'filters'); assert.equal(ui.calls[0].payload.revision, 1);
});

test('invalid input blocks saving and defaults only become effective after explicit save', async t => {
  const ui = await setup(t); ui.update(state()); ui.change('#floating-panels-font-size', 200);
  assert.equal(ui.get('#floating-panels-save').disabled, true); assert.equal(ui.get('#floating-panels-font-size').attributes['aria-invalid'], 'true');
  ui.update(state({ revision: 1 })); assert.equal(ui.get('#floating-panels-font-size').value, '200');
  ui.get('#floating-panels-reset').click(); assert.equal(ui.get('#floating-panels-font-size').value, '14'); assert.equal(ui.calls.length, 0);
  assert.match(ui.get('#floating-panels-feedback').textContent, /Enregistrez pour les appliquer/);
  ui.get('#floating-panels-save').click(); assert.deepEqual(ui.calls[0].payload.appearance, defaults());
});

test('failed or unconfirmed saves keep the draft available for retry and protected storage disables editing', async t => {
  const ui = await setup(t); ui.update(state()); ui.change('#floating-panels-font-size', 17); ui.get('#floating-panels-save').click();
  ui.calls[0].resolve({ ok: false, error: 'Les réglages ont changé.' }); await tick();
  assert.equal(ui.get('#floating-panels-font-size').value, '17'); assert.equal(ui.get('#floating-panels-save').disabled, false);
  ui.get('#floating-panels-save').click(); ui.calls[1].resolve({ ok: true }); await tick();
  assert.match(ui.get('#floating-panels-feedback').textContent, /n’a pas pu/); assert.equal(ui.get('#floating-panels-save').disabled, false);
  ui.update(state({ canWrite: false, error: 'Le fichier original est conservé.' }));
  assert.equal(ui.get('#floating-panels-background').disabled, true); assert.equal(ui.get('#floating-panels-reset').disabled, true); assert.equal(ui.get('#floating-panels-save').disabled, true);
});

test('mini controls accept a scoped snapshot and cannot select or send another panel', async t => {
  const ui = await setup(t, ['catalogue']); ui.update(state({ appearance: { catalogue: defaults() } }));
  assert.deepEqual(ui.get('#floating-panels-panel').children.map(option => option.value), ['catalogue']);
  ui.change('#floating-panels-panel', 'filters'); ui.change('#floating-panels-font-size', 16); ui.get('#floating-panels-save').click();
  assert.equal(ui.calls[0].payload.panel, 'catalogue');
  ui.calls[0].resolve({ ok: true, result: state({ revision: 1, appearance: { catalogue: { ...defaults(), fontSize: 16 } } }) }); await tick();
  assert.match(ui.get('#floating-panels-feedback').textContent, /enregistrée/);
});

test('style helper sets only scoped inert CSS values and preserves non-quantized alpha on font edits', async t => {
  const { applyFloatingAppearance } = await import('../companion/ui/floating-panels-controls.js');
  const ui = await setup(t), element = ui.document.createElement('div');
  applyFloatingAppearance(element, { ...defaults(), fontFamily: 'url(https://private.invalid)' });
  assert.equal(element.style.getPropertyValue('--floating-font'), '"Segoe UI", Arial, sans-serif');
  applyFloatingAppearance(element, { ...defaults(), textColor: 'url(x)', backgroundColor: 'var(--secret)' });
  assert.equal(element.style.getPropertyValue('--floating-background'), defaults().backgroundColor);
  ui.update(state({ appearance: { catalogue: { ...defaults(), backgroundColor: '#12345688' }, filters: defaults() } }));
  ui.change('#floating-panels-font-size', 18); assert.equal(ui.get('#floating-panels-preview').style.getPropertyValue('--floating-background'), '#12345688');
});

test('disposal removes listeners and late save responses never rewrite detached controls', async t => {
  const ui = await setup(t); ui.update(state()); ui.change('#floating-panels-font-size', 18); ui.get('#floating-panels-save').click(); ui.controls.dispose();
  const writes = ui.document.writes; ui.calls[0].resolve({ ok: true, result: state({ revision: 1 }) }); await tick();
  ui.controls.update({ floatingPanels: state({ revision: 2 }) }); ui.get('#floating-panels-reset').click(); assert.equal(ui.document.writes, writes);
});
