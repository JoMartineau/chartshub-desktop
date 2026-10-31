'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const repo = path.resolve(__dirname, '..');
const sheet = path.join(repo, 'companion/ui/button-motion.css');
const css = fs.readFileSync(sheet, 'utf8');

test('all five native button surfaces load the same packaged stylesheet after local styles', () => {
  for (const file of ['desktop/index.html', ...['index', 'catalogue-widget', 'filters-widget', 'music-player'].map(name => `companion/ui/${name}.html`)]) {
    const links = [...fs.readFileSync(path.join(repo, file), 'utf8').matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)].map(match => match[1]);
    assert.equal(path.resolve(repo, path.dirname(file), links.at(-1)), sheet, file);
    assert.equal(links.filter(link => link.endsWith('/button-motion.css')).length, 1, file);
  }
  for (const name of ['overlay', 'stream', 'song-requests']) assert.ok(!fs.readFileSync(path.join(repo, 'companion/ui', name + '.html'), 'utf8').includes('button-motion.css'), 'display-only documents stay untouched');
});

test('motion uses additive CSS properties without changing colors, geometry or native drag regions', () => {
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[a-z-]+\s*:[^;{}]+;/g) || [];
  for (const declaration of declarations) assert.ok(!/^\s*(?:transform|color|background(?:-color)?|border(?:-color)?|box-shadow|width|height|padding|margin|-webkit-app-region)\s*:/.test(declaration), declaration);
  for (const protectedTarget of ['.builder-resize-handle', '[data-resize-handle]', '#builder-canvas *', '#game-preview *', '#theme-preview *', '#stream-preview *', '.floating-titlebar *', '.catalogue-widget-titlebar *', '.local-player-window #local-player-widget']) {
    assert.equal(css.split(protectedTarget).length - 1, 3, 'all interaction rules exclude ' + protectedTarget);
  }
  assert.match(css, /:is\(:disabled, \[aria-disabled="true"\]\)\s*\{\s*translate: none;\s*scale: none;\s*transition-duration: 0ms;/);
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\)/);
  for (const mode of ['off', 'subtle']) assert.ok(css.includes(`[data-ch-motion="${mode}"]`));
  assert.ok(css.includes('[data-ch-economy="on"]'));
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(reduced.includes('(forced-colors: active)'));
  for (const declaration of ['--ch-button-lift: 0px', '--ch-button-press: 0px', '--ch-button-scale: 1', '--ch-button-duration: 0ms']) assert.ok(reduced.includes(declaration + ' !important;'), 'OS accessibility wins over any mode');
});

test('existing economy previews and cancellation update button motion without changing saved Bloom settings', async () => {
  const model = await import('../companion/ui/ui-bloom-model.js');
  const { applyButtonMotion } = await import('../companion/ui/button-motion.js');
  const source = fs.readFileSync(path.join(repo, 'companion/ui/ui-bloom.js'), 'utf8');
  const body = source.slice(source.indexOf('  function paint(value) {'), source.indexOf('  function preview(value)'));
  const properties = new Map(), document = { documentElement: { dataset: {}, style: { setProperty: (name, value) => properties.set(name, value), removeProperty: name => properties.delete(name) } } };
  const paint = Function('document', 'model', 'applyButtonMotion', 'paintCataloguePalette', body + ';return paint;')(document, model, applyButtonMotion, () => null);
  const saved = { ...model.DEFAULTS, color: '#123456' }, original = structuredClone(saved);
  paint({ ...saved, economy: true, hoverLift: 5 });
  assert.equal(document.documentElement.dataset.chEconomy, 'on');
  assert.equal(document.documentElement.dataset.chBloom, 'off');
  assert.equal(properties.get('--ch-bloom-shadow'), 'none');
  assert.equal(properties.get('--ch-motion-hover-lift'), '5px');
  paint(saved);
  assert.equal(document.documentElement.dataset.chEconomy, 'off');
  assert.equal(properties.has('--ch-motion-hover-lift'), false, 'Auto restores the mode fallback');
  assert.deepEqual(saved, original);
});

test('legacy Bloom v1 remains byte-identical on read; optional hover level persists and accepts only 1/3/5', async t => {
  const model = await import('../companion/ui/ui-bloom-model.js');
  const { createUIBloomStore } = require('../desktop/ui-bloom.cjs');
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ch-button-motion-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'ui-bloom.json'), original = JSON.stringify(model.DEFAULTS);
  await fsp.writeFile(file, original);
  const store = await createUIBloomStore(directory);
  assert.deepEqual((await store.read()).settings, model.DEFAULTS);
  assert.equal(await fsp.readFile(file, 'utf8'), original, 'no migration write');
  for (const hoverLift of [1, 3, 5]) {
    const candidate = { ...model.DEFAULTS, hoverLift };
    await store.save(candidate);
    assert.deepEqual((await (await createUIBloomStore(directory)).read()).settings, candidate);
  }
  const before = await fsp.readFile(file, 'utf8');
  for (const hoverLift of [0, 2, 4, 6, -3, '3', 'auto', null, NaN, Infinity, 'url(x)', {}]) {
    assert.equal(model.validate({ ...model.DEFAULTS, hoverLift }), null);
    await assert.rejects(store.save({ ...model.DEFAULTS, hoverLift }));
  }
  assert.equal(await fsp.readFile(file, 'utf8'), before);
  await store.save(model.DEFAULTS);
  assert.equal(Object.hasOwn((await store.read()).settings, 'hoverLift'), false);
});

test('narrow host relay copies only valid hover/economy values and publishes changes once', () => {
  const source = fs.readFileSync(path.join(repo, 'companion/host.cjs'), 'utf8');
  const body = source.slice(source.indexOf('  function setButtonMotion(value) {'), source.indexOf('  const unsubscribe = services.store.subscribe(publish);'));
  const make = Function('let buttonMotion={economy:false},disposing=false,published=0;function publish(){published++;}' + body + ';return {set:setButtonMotion,snapshot:()=>({...buttonMotion}),published:()=>published};');
  const host = make(), input = { economy: true, hoverLift: 1 };
  assert.equal(host.set(input), true); input.hoverLift = 5;
  assert.deepEqual(host.snapshot(), { economy: true, hoverLift: 1 });
  assert.equal(host.set({ economy: true, hoverLift: 1 }), true); assert.equal(host.published(), 1);
  for (const value of [null, [], {}, { economy: 1 }, { economy: false, hoverLift: 2 }, { economy: false, path: 'private' }]) assert.equal(host.set(value), false);
  assert.equal(host.published(), 1);
  assert.equal(host.set({ economy: false }), true); assert.deepEqual(host.snapshot(), { economy: false });
});
