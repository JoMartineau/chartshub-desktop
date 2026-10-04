const test = require('node:test');
const assert = require('node:assert/strict');

test('ReShade presentation requires a connected runtime and displays action errors', async () => {
  const { reShadePresentation } = await import('../companion/ui/reshade-controls.js');
  assert.equal(reShadePresentation({ installed: true, connected: false, catalog: null }).active, false);
  assert.match(reShadePresentation({ installed: true, connected: false, catalog: null }).label, /attente/);
  assert.equal(reShadePresentation({ connected: true, catalog: { enabled: true } }).active, true);
  assert.equal(reShadePresentation({ connected: true, catalog: { enabled: false } }).active, false);
  const failed = reShadePresentation({ connected: true, state: 'ready', error: 'Preset indisponible', catalog: { enabled: true } });
  assert.equal(failed.message, 'Preset indisponible');
  assert.equal(failed.active, false);
});

test('search matches original shader technique and effect names without changing catalog order', async () => {
  const { filterTechniques } = await import('../companion/ui/reshade-controls.js');
  const techniques = [{ id: 'a', name: 'Bloom', label: 'Lueur', effect: 'qUINT_bloom.fx' }, { id: 'b', name: 'FilmGrain', label: 'Grain cinéma', effect: 'FilmGrain.fx' }];
  assert.deepEqual(filterTechniques(techniques, 'BLOOM'), [techniques[0]]);
  assert.deepEqual(filterTechniques(techniques, 'grain cinéma'), [techniques[1]]);
  assert.deepEqual(filterTechniques(techniques, '  '), techniques);
  assert.deepEqual(filterTechniques(techniques, 'missing'), []);
});

test('uniform input respects numeric type and native component bounds', async () => {
  const { normalizeUniformComponent: normalize } = await import('../companion/ui/reshade-controls.js');
  const float = { type: 'float', min: [0, -2], max: [1, 2] };
  assert.equal(normalize(float, 0, '3'), 1);
  assert.equal(normalize(float, 1, '-3'), -2);
  assert.equal(normalize(float, 0, '.37'), .37);
  assert.equal(normalize(float, 0, ''), null);
  assert.equal(normalize(float, 0, 'not-a-number'), null);
  assert.equal(normalize({ type: 'int', min: [0], max: [10] }, 0, '3.8'), 4);
  assert.equal(normalize({ type: 'uint' }, 0, '-10'), 0);
  assert.equal(normalize({ type: 'bool' }, 0, false), false);
});

test('reload removes only stale parameter drafts, timers and queued controls; disconnect removes all', async t => {
  const { ReShadeControls } = await import('../companion/ui/reshade-controls.js');
  const controls = new ReShadeControls({ root: { querySelector: () => null }, command: async () => ({ ok: true }) });
  controls.render = () => {};
  t.after(() => controls.dispose());
  const catalog = { selectedEffect: 'Bloom.fx', techniques: [{ id: 't1', effect: 'Bloom.fx' }], uniforms: [{ id: 'u1' }, { id: 'u2' }] };
  controls.update({ reshade: { connected: true, catalog } });
  const firstTimer = setTimeout(() => {}, 5000), secondTimer = setTimeout(() => {}, 5000);
  controls.timers.set('u1', firstTimer); controls.timers.set('u2', secondTimer);
  controls.drafts.set('u1', [1]); controls.drafts.set('u2', [2]);
  controls.pending.set('uniform:u1', { action: 'uniform', id: 'u1', values: [1] });
  controls.pending.set('uniform:u2', { action: 'uniform', id: 'u2', values: [2] });
  controls.pending.set('technique:old', { action: 'technique', id: 'old', enabled: true });
  controls.pending.set('save:', { action: 'save' });
  controls.update({ reshade: { connected: true, catalog: { ...catalog, uniforms: [{ id: 'u1' }, { id: 'u3' }] } } });
  assert.deepEqual([...controls.timers.keys()], ['u1']);
  assert.deepEqual([...controls.drafts.keys()], ['u1']);
  assert.deepEqual([...controls.pending.keys()], ['uniform:u1', 'save:']);
  controls.update({ reshade: { connected: false, catalog: null } });
  assert.equal(controls.timers.size + controls.drafts.size + controls.pending.size, 0);
});

test('late errors from an obsolete catalog do not overwrite the current connection state', async t => {
  const { ReShadeControls } = await import('../companion/ui/reshade-controls.js');
  let release;
  const controls = new ReShadeControls({ root: { querySelector: () => null }, command: () => new Promise(resolve => { release = resolve; }) });
  controls.render = () => {};
  const feedback = []; controls.feedback = message => feedback.push(message);
  t.after(() => controls.dispose());
  controls.update({ reshade: { connected: true, catalog: { selectedEffect: 'Bloom.fx', techniques: [{ id: 't1', effect: 'Bloom.fx' }], uniforms: [{ id: 'u1' }] } } });
  controls.pending.set('uniform:u1', { action: 'uniform', id: 'u1', values: [1] });
  const draining = controls.drain();
  controls.update({ reshade: { connected: false, catalog: null } });
  release({ ok: false, error: 'This effect no longer exists' });
  await draining;
  assert.equal(feedback.some(message => message === 'This effect no longer exists'), false);
  assert.equal(controls.pending.size, 0);
});
