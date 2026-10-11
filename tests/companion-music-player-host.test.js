'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { trustedSender, trustedContentsSender } = require('../companion/security.cjs');
const { createMusicPlayerPreferences, DEFAULT_APPEARANCE } = require('../companion/music-player-preferences.cjs');
const { createMusicPlayer } = require('../companion/music-player.cjs');

const settings = () => ({ appearance: { ...DEFAULT_APPEARANCE }, videoEnabled: true, volume: .7 });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function fixture(t, { loading } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-music-host-'));
  const preferences = createMusicPlayerPreferences({ dataDirectory: directory }); await preferences.load();
  const source = await fs.readFile(path.join(__dirname, '../companion/host.cjs'), 'utf8');
  const start = source.indexOf('  async function ensurePlayerWindow()'), end = source.indexOf('  function canRead(', start);
  assert.ok(start >= 0 && end > start, 'The real player window and preference orchestration must remain identifiable');
  const windows = [], applied = [];
  let stopped = 0;
  const musicPlayer = createMusicPlayer({ preferences: preferences.status(), library: {
    matchingSnapshot: () => ({ rootKey: null, revision: 0, items: [] }), status: () => ({ status: 'ready' })
  } });
  const stop = musicPlayer.stop, applyPreferences = musicPlayer.applyPreferences;
  musicPlayer.stop = () => { stopped++; stop(); };
  musicPlayer.applyPreferences = value => { applied.push(structuredClone(value)); applyPreferences(value); };
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.visible = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { mainFrame: { url: '' }, isDestroyed: () => this.destroyed, isLoading: () => false });
      windows.push(this);
    }
    async loadURL(url) { if (loading) await loading(); this.webContents.mainFrame.url = url; }
    isDestroyed() { return this.destroyed; }
    setAlwaysOnTop() {}
    showInactive() { assert.equal(this.destroyed, false); this.visible = true; }
    hide() { this.visible = false; }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.visible = false; this.emit('closed'); } }
  }
  // Exercise the actual host functions; only native window creation and the
  // surrounding host lifecycle are controlled. No browser or Songs are used.
  const create = new vm.Script(`(function(BrowserWindow,musicPlayer,playerPreferences){
    const SCHEME='chartshub-companion',language='fr',preferences={},harden=()=>{},publishPanel=()=>{};
    let disposing=false,stopTask=null,hostActive=true,lifecycleRevision=0,playerWindow=null,playerWindowLoad=null,playerPreferencesTask=Promise.resolve();
    const panelAlive=()=>hostActive, panelContents=null;
    ${source.slice(start, end)}
    return {ensure:ensurePlayerWindow,widget:setPlayerWidget,save:savePlayerPreferences,trusted:trustedPlayer,
      idle:()=>playerPreferencesTask,halt:()=>{hostActive=false;lifecycleRevision++;musicPlayer.stop();if(playerWindow&&!playerWindow.isDestroyed())playerWindow.destroy();},
      window:()=>playerWindow};
  })`, { filename: 'companion/host.cjs player orchestration' }).runInNewContext({ path, __dirname: path.join(__dirname, '../companion'), trustedSender, trustedContentsSender });
  const host = create(Window, musicPlayer, preferences);
  t.after(async () => {
    await host.idle(); await preferences.flush(); for (const window of windows) window.destroy();
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('chartshub-music-host-')) throw Error('Unsafe temporary fixture');
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { host, windows, preferences, directory, applied, state: () => musicPlayer.snapshot(), stopped: () => stopped };
}

test('concurrent requests share one audio owner; hiding and showing the widget never creates a second window', async t => {
  const gate = deferred(), entered = deferred(), f = await fixture(t, { loading: () => { entered.resolve(); return gate.promise; } });
  const first = f.host.ensure(), second = f.host.ensure(); await entered.promise;
  assert.equal(f.windows.length, 1); gate.resolve(); assert.equal(await first, await second);
  await f.host.widget(true); assert.equal(f.windows[0].visible, true);
  const close = { prevented: false, preventDefault() { this.prevented = true; } }; f.windows[0].emit('close', close);
  assert.equal(close.prevented, true); assert.equal(f.windows[0].visible, false); assert.equal(f.stopped(), 0);
  await f.host.widget(true); assert.equal(f.windows.length, 1); assert.equal(f.windows[0].visible, true);
});

test('closing the Companion during window loading rejects the old request and cannot show an orphan player', async t => {
  const gate = deferred(), entered = deferred(), f = await fixture(t, { loading: () => { entered.resolve(); return gate.promise; } });
  const showing = f.host.widget(true); await entered.promise; f.host.halt(); gate.resolve();
  await assert.rejects(showing, /Player unavailable/);
  assert.equal(f.windows.length, 1); assert.equal(f.windows[0].destroyed, true); assert.equal(f.windows[0].visible, false);
  assert.equal(f.state().widgetEnabled, false); await assert.rejects(f.host.ensure(), /Player unavailable/);
});

test('only the live exact player main frame is trusted, including after crash or replacement', async t => {
  const f = await fixture(t), window = await f.host.ensure(), event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  assert.equal(f.host.trusted(event), true);
  assert.equal(f.host.trusted({ ...event, senderFrame: { url: event.senderFrame.url } }), false);
  assert.equal(f.host.trusted({ ...event, sender: { mainFrame: event.senderFrame } }), false);
  const url = event.senderFrame.url; event.senderFrame.url += '?role=player'; assert.equal(f.host.trusted(event), false); event.senderFrame.url = url;
  window.webContents.emit('render-process-gone'); assert.equal(f.host.trusted(event), false);
  const replacement = await f.host.ensure(); assert.notEqual(replacement, window); assert.equal(f.windows.length, 2);
  assert.equal(f.host.trusted(event), false); assert.equal(f.stopped() > 0, true);
});

test('host serial preference changes merge each latest saved field without creating an audio window', async t => {
  const f = await fixture(t), appearance = { ...DEFAULT_APPEARANCE, spectrumModel: 'circle', accentColor: '#ffffff' };
  const tasks = [f.host.save({ videoEnabled: false }), f.host.save({ appearance }), f.host.save({ volume: 0 })];
  for (const task of tasks) assert.equal((await task).ok, true); await f.host.idle();
  const saved = await createMusicPlayerPreferences({ dataDirectory: f.directory }).load();
  assert.deepEqual(saved, { appearance, videoEnabled: false, volume: 0, shuffle: false, playlists: [], canWrite: true, error: null });
  assert.equal(f.applied.length, 3); assert.equal(f.windows.length, 0);
});

test('refused externally changed preferences are preserved and their protected status reaches the player', async t => {
  const f = await fixture(t); await f.host.save({ volume: .2 });
  const file = path.join(f.directory, 'music-player-preferences.json'), original = JSON.stringify({ version: 1, ...settings(), volume: .9 });
  await fs.writeFile(file, original);
  await assert.rejects(f.host.save({ videoEnabled: false }), error => error.code === 'MUSIC_PLAYER_PREFERENCES_SAFE');
  assert.equal(await fs.readFile(file, 'utf8'), original); assert.equal(f.preferences.status().canWrite, false);
  assert.equal(f.state().appearanceCanWrite, false); assert.equal(f.state().preferencesError, f.preferences.status().error);
  assert.equal(f.state().volume, .2); assert.equal(f.windows.length, 0);
});
