'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validateUIPalette, createUIPaletteIpc } = require('../desktop/ui-palette.cjs');
const { createUIBloomStore } = require('../desktop/ui-bloom.cjs');
const palette = () => ({ mode: 'dark', paletteMode: 'season', colors: { accent: '#ffb77c', secondary: '#bfa4ff', background: '#090e19', surface: '#111c2e', surfaceAlt: '#18263c', text: '#eef4ff', muted: '#9db2d0', border: '#2d4059', bloom: '#ffb77c' } });
test('remote palette accepts only a fixed-size set of hex colors and known modes', () => {
  const input = palette(), valid = validateUIPalette(input); input.colors.accent = '#000000'; assert.equal(valid.colors.accent, '#ffb77c');
  for (const value of [null, [], {}, { ...palette(), mode: 'auto' }, { ...palette(), paletteMode: 'url(https://evil.test)' }, { ...palette(), url: 'https://evil.test' }]) assert.equal(validateUIPalette(value), null);
  for (const color of ['red', '#fff', 'rgb(1,2,3)', '#ffb77c00', 'url(https://evil.test)', '#ffffff;opacity:0', 'x'.repeat(20000), null, {}, 1]) {
    const value = palette(); value.colors.accent = color; assert.equal(validateUIPalette(value), null);
  }
  const extra = palette(); extra.colors.path = '/private/settings.json'; assert.equal(validateUIPalette(extra), null);
  const missing = palette(); delete missing.colors.bloom; assert.equal(validateUIPalette(missing), null);
});
test('palette IPC never delivers invalid payloads or untrusted senders to local views', () => {
  const handlers = new Map(), seen = [], trusted = {}, subframe = {}, loggedOut = {};
  let maintenance = false;
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) };
  const controller = createUIPaletteIpc({ ipcMain, allowedSender: event => event === trusted && !maintenance, onPalette: value => { seen.push(value); return true; } });
  const handle = handlers.get('chartshub:ui-palette');
  for (const event of [subframe, loggedOut, null]) assert.equal(handle(event, palette()), null);
  maintenance = true; assert.equal(handle(trusted, palette()), null); maintenance = false;
  assert.equal(handle(trusted, { ...palette(), css: 'background:url(https://evil.test)' }), null); assert.equal(seen.length, 0);
  assert.equal(handle(trusted, palette()), true); assert.equal(seen.length, 1);
  controller.dispose(); assert.equal(handlers.size, 0);
});
test('legacy bloom defaults to following Catalogue without overwriting saved personal colors', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ch-palette-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const model = await import('../companion/ui/ui-bloom-model.js'), store = await createUIBloomStore(directory);
  const legacy = { ...model.DEFAULTS, enabled: true, color: '#00ff11', radius: 9 }; delete legacy.followCatalogue;
  const bytes = JSON.stringify(legacy); await fs.writeFile(path.join(directory, 'ui-bloom.json'), bytes);
  const restored = (await store.read()).settings; assert.equal(restored.followCatalogue, true); assert.equal(restored.color, '#00ff11'); assert.equal(restored.radius, 9);
  assert.equal(await fs.readFile(path.join(directory, 'ui-bloom.json'), 'utf8'), bytes);
  await store.save({ ...restored, followCatalogue: false });
  assert.equal((await (await createUIBloomStore(directory)).read()).settings.followCatalogue, false);
  assert.equal((await store.read()).settings.color, '#00ff11');
  for (const followCatalogue of ['true', 1, {}, null]) assert.equal(model.validate({ ...model.DEFAULTS, followCatalogue }), null);
  assert.deepEqual(await fs.readdir(directory), ['ui-bloom.json']);
});
test('main-panel palette remains separate from widget renderers, media and stream styles', async () => {
  for (const name of ['overlay', 'stream', 'song-requests', 'catalogue-widget', 'filters-widget', 'music-player']) {
    for (const extension of ['js', 'html']) {
      const filename = name === 'song-requests' && extension === 'js' ? 'song-requests-overlay.js' : name + '.' + extension;
      const source = await fs.readFile(path.join(__dirname, '../companion/ui', filename), 'utf8');
      assert.ok(!source.includes('catalogue-palette'), name + '.' + extension);
    }
  }
  const source = await fs.readFile(path.join(__dirname, '../companion/host.cjs'), 'utf8');
  const body = source.slice(source.indexOf('  function setUIPalette(value) {'), source.indexOf('  const unsubscribe = services.store.subscribe(publish);'));
  const seen = [], create = Function('validateUIPalette', 'publishPanel', 'let uiPalette=null,disposing=false;' + body + ';return {set:setUIPalette,read:()=>uiPalette};');
  const host = create(validateUIPalette, () => seen.push('main-panel'));
  const value = palette(); assert.equal(host.set(value), true); value.colors.bloom = '#000000';
  assert.equal(host.read().colors.bloom, '#ffb77c'); assert.deepEqual(seen, ['main-panel']);
  assert.equal(host.set({ ...palette(), widget: { color: 'red' } }), false); assert.equal(seen.length, 1);
});
