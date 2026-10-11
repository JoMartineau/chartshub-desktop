'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createPlayerFixtureRequestGuard, playerFixtureConsoleError } = require('./music-player-network-fixture.cjs');

test('player fixture permits protocol file fetches only for existing bundle ui/dist assets', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-player-network-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bundle = path.join(directory, 'companion'), allow = createPlayerFixtureRequestGuard(bundle);
  for (const filename of ['ui/index.html', 'dist/player/Engine.js', 'Songs/song.wav', 'settings/private.json', 'host.cjs']) {
    const target = path.join(bundle, filename); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, 'fixture');
  }
  for (const filename of ['ui/index.html', 'dist/player/Engine.js']) assert.equal(allow(pathToFileURL(path.join(bundle, filename)).href), true, filename);
  for (const filename of ['Songs/song.wav', 'settings/private.json', 'host.cjs', 'ui/missing.js']) assert.equal(allow(pathToFileURL(path.join(bundle, filename)).href), false, filename);
  const index = pathToFileURL(path.join(bundle, 'ui/index.html')).href;
  assert.equal(allow(index + '?secret=1'), false); assert.equal(allow(index + '#fragment'), false);
  assert.equal(allow(pathToFileURL(path.join(directory, 'companion-other/ui/index.html')).href), false);
  assert.equal(allow('file://untrusted-server/share/companion/ui/index.html'), false);
  assert.equal(allow('file:///C:/Users/Someone/Songs/song.wav'), false);
  assert.equal(allow('file:///bad%2fpath'), false);
  const outside = path.join(directory, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'private.js'), 'private');
  await fs.symlink(outside, path.join(bundle, 'ui', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(allow(pathToFileURL(path.join(bundle, 'ui/linked/private.js')).href), false, 'junction cannot escape the bundle');
});

test('player fixture blocks external network and foreign custom-protocol hosts', () => {
  const allow = createPlayerFixtureRequestGuard(path.resolve(__dirname, '../companion'));
  for (const value of ['https://chartshub.ca/api/charts', 'http://localhost:38473/', 'ws://localhost:3000/', 'chartshub-companion://foreign/ui/index.html', 'chartshub-companion://user@app/ui/index.html', 'not a URL']) assert.equal(allow(value), false, value);
  for (const value of ['chartshub-companion://app/ui/index.html', 'chartshub-companion://app/music-media/' + 'a'.repeat(64) + '/0', 'data:text/html,fixture', 'about:blank', 'blob:null/fixture']) assert.equal(allow(value), true, value);
});

test('player fixture records modern and legacy Electron console errors with bounded messages', () => {
  assert.equal(playerFixtureConsoleError({ level: 'error', message: 'CSP refused media' }), 'CSP refused media');
  assert.equal(playerFixtureConsoleError({}, 3, 'Legacy renderer failure'), 'Legacy renderer failure');
  assert.equal(playerFixtureConsoleError({ level: 'warning', message: 'Modern warning' }, 3, 'Ignored positional data'), null);
  assert.equal(playerFixtureConsoleError({}, 2, 'Legacy warning'), null);
  assert.equal(playerFixtureConsoleError({ level: 'error', message: 'x'.repeat(500) }).length, 300);
});
