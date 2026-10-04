'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Module, createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(t, onSelectTab = async () => {}) {
  const handlers = new Map(), views = [];
  class FakeWeb extends EventEmitter {
    constructor() {
      super(); this.url = ''; this.mainFrame = { url: '' }; this.sent = []; this.destroyed = false; this.loading = false; this.reloads = 0; this.closes = 0; this.focuses = 0;
      this.session = new EventEmitter();
      this.session.setPermissionRequestHandler = handler => { this.session.permissionRequest = handler; };
      this.session.setPermissionCheckHandler = handler => { this.session.permissionCheck = handler; };
    }
    getURL() { return this.url; }
    isDestroyed() { return this.destroyed; }
    isLoading() { return this.loading; }
    setWindowOpenHandler(handler) { this.openHandler = handler; }
    setVisualZoomLevelLimits() { return Promise.resolve(); }
    setZoomFactor(value) { this.zoom = value; }
    send(channel, state) { this.sent.push({ channel, state }); }
    focus() { this.focuses++; }
    reload() { this.reloads++; this.loading = true; this.emit('did-start-loading'); }
    close() { this.closes++; this.destroyed = true; this.emit('destroyed'); }
    finish(url) { this.url = url; this.mainFrame.url = url; this.loading = false; this.emit('did-finish-load'); this.emit('did-stop-loading'); }
  }
  class FakeView {
    constructor(options) { this.options = options; this.webContents = new FakeWeb(); this.visible = true; views.push(this); }
    setVisible(value) { this.visible = value; }
    setBounds(value) { this.bounds = value; }
  }
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.webContents = new FakeWeb(); this.destroyed = false; this.size = [1400, 950]; this.fullscreen = false;
      this.contentView = { children: [], addChildView: view => this.contentView.children.push(view), removeChildView: view => { this.contentView.children = this.contentView.children.filter(item => item !== view); } };
    }
    setMenuBarVisibility(value) { this.menu = value; }
    getContentSize() { return this.size; }
    isDestroyed() { return this.destroyed; }
    loadFile(filename) { this.filename = filename; return Promise.resolve().then(() => this.webContents.finish(pathToFileURL(filename).href)); }
    setBackgroundColor(value) { this.background = value; }
    setTitleBarOverlay(value) { this.titlebar = value; }
    setAccentColor(value) { this.accent = value; }
    isFullScreen() { return this.fullscreen; }
    setFullScreen(value) { this.fullscreen = value; this.emit(value ? 'enter-full-screen' : 'leave-full-screen'); }
  }
  const electron = { BrowserWindow: FakeWindow, WebContentsView: FakeView, ipcMain: { handle: (name, handler) => { assert.ok(!handlers.has(name)); handlers.set(name, handler); }, removeHandler: name => handlers.delete(name) } };
  const filename = require.resolve('../desktop/controller.cjs'), loaded = new Module(filename, module), normal = createRequire(filename);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename)); loaded.require = name => name === 'electron' ? electron : normal(name);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  const preferences = { session: { partition: 'persist:chartshub' }, preload: '/catalogue/preload.js', sandbox: true, contextIsolation: true };
  const shell = loaded.exports.createDesktopShell({ cataloguePreferences: preferences, onSelectTab });
  t.after(() => shell.dispose());
  const event = () => ({ sender: shell.window.webContents, senderFrame: shell.window.webContents.mainFrame });
  const state = () => handlers.get('chartshub-shell:state')(event());
  const select = name => handlers.get('chartshub-shell:select-tab')(event(), name);
  const view = (url = 'chartshub-companion://app/ui/index.html') => { const value = new FakeView({}); value.webContents.finish(url); return value; };
  return { shell, handlers, event, state, select, view, views, preferences };
}

test('shell separates local privileges from catalogue session and only trusts its exact main frame', async t => {
  const f = fixture(t); await f.shell.ready;
  const prefs = f.shell.window.options.webPreferences;
  assert.equal(prefs.contextIsolation, true); assert.equal(prefs.sandbox, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.webviewTag, false);
  assert.notEqual(prefs.partition, 'persist:chartshub'); assert.match(prefs.preload, /desktop[\\/]preload\.cjs$/);
  assert.equal(f.shell.catalogueView.options.webPreferences.session, f.preferences.session);
  assert.equal(f.shell.catalogueView.options.webPreferences.preload, f.preferences.preload);
  assert.deepEqual([...f.handlers.keys()].sort(), ['chartshub-shell:select-tab', 'chartshub-shell:state']);
  const read = f.handlers.get('chartshub-shell:state'), select = f.handlers.get('chartshub-shell:select-tab');
  assert.equal(read(f.event()).activeTab, 'catalogue');
  assert.equal(read({ ...f.event(), sender: f.shell.catalogueView.webContents }), null);
  assert.equal(read({ ...f.event(), senderFrame: { ...f.event().senderFrame } }), null);
  assert.equal(read(f.event(), {}), null);
  assert.equal(select(f.event(), 'companion:command'), null); assert.equal(select(f.event(), { name: 'catalogue' }), null);
  const expected = f.shell.window.webContents.url;
  for (const url of [expected + '#spoof', expected + '?spoof', 'https://chartshub.ca/', 'file:///elsewhere/index.html']) {
    f.shell.window.webContents.url = url; f.shell.window.webContents.mainFrame.url = url;
    assert.equal(read(f.event()), null);
  }
  f.shell.window.webContents.url = expected; f.shell.window.webContents.mainFrame.url = expected;
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
    let blocked = false; f.shell.window.webContents.emit(name, { preventDefault() { blocked = true; } }); assert.equal(blocked, true);
  }
  assert.deepEqual(f.shell.window.webContents.openHandler({ url: 'https://example.org' }), { action: 'deny' });
  assert.equal(f.shell.window.webContents.session.permissionCheck(), false);
});

test('guest login and logout gate the Companion tab without disposing its persistent view', async t => {
  const selected = [], f = fixture(t, async name => { selected.push(name); }); await f.shell.ready;
  f.shell.catalogueView.webContents.finish('https://chartshub.ca/');
  const companion = f.view(); f.shell.attachCompanion(companion);
  assert.equal(f.state().companionAvailable, false);
  f.shell.showTab('companion'); await f.select('companion');
  assert.equal(f.state().activeTab, 'catalogue'); assert.deepEqual(selected, []); assert.equal(companion.visible, false);
  f.shell.setCompanionAvailable(true); await f.select('companion');
  assert.equal(f.state().activeTab, 'companion'); assert.equal(companion.visible, true); assert.equal(f.shell.catalogueView.visible, false);
  f.shell.setCompanionAvailable(false); await flush();
  assert.equal(f.state().activeTab, 'catalogue'); assert.equal(f.state().companionAvailable, false);
  assert.equal(companion.visible, false); assert.equal(companion.webContents.closes, 0); assert.equal(f.shell.catalogueView.visible, true);
  assert.deepEqual(selected, ['companion', 'catalogue']);
  f.shell.setCompanionAvailable(true); f.shell.showTab('companion');
  assert.equal(companion.visible, true); assert.equal(companion.webContents.reloads, 0);
  assert.throws(() => f.shell.setCompanionAvailable('true'), TypeError);
});

test('tab switches preserve view identity and resize both beneath the fixed 108-pixel shell', async t => {
  const f = fixture(t); await f.shell.ready; f.shell.setCompanionAvailable(true);
  const catalogue = f.shell.catalogueView, companion = f.view(); catalogue.webContents.finish('https://chartshub.ca/'); f.shell.attachCompanion(companion);
  for (let index = 0; index < 6; index++) f.shell.showTab(index % 2 ? 'catalogue' : 'companion');
  assert.equal(f.views.length, 2); assert.equal(catalogue.webContents.reloads + companion.webContents.reloads, 0);
  assert.deepEqual(catalogue.bounds, { x: 0, y: 108, width: 1400, height: 842 });
  f.shell.window.size = [900, 660]; f.shell.window.emit('resize');
  assert.deepEqual(companion.bounds, { x: 0, y: 108, width: 900, height: 552 });
  f.shell.window.size = [1920, 1080]; f.shell.window.emit('enter-full-screen');
  assert.deepEqual(catalogue.bounds, { x: 0, y: 108, width: 1920, height: 972 });
  f.shell.window.size = [20, 50]; f.shell.window.emit('leave-full-screen'); assert.equal(companion.bounds.height, 0);
  assert.throws(() => f.shell.showTab('overlay'), TypeError);
});

test('pending Companion startup is coalesced and cannot steal a newer catalogue selection', async t => {
  const gate = deferred(), selections = [], f = fixture(t, name => { selections.push(name); return name === 'companion' ? gate.promise : undefined; });
  await f.shell.ready; f.shell.setCompanionAvailable(true); f.shell.catalogueView.webContents.finish('https://chartshub.ca/');
  const pending = f.select('companion'), duplicate = f.select('companion'); await flush();
  assert.equal(f.state().tabs.companion.loading, true); assert.deepEqual(selections, ['companion']);
  await f.select('catalogue');
  const companion = f.view(); f.shell.attachCompanion(companion); gate.resolve(); await Promise.all([pending, duplicate]);
  assert.equal(f.state().activeTab, 'catalogue'); assert.equal(companion.visible, false); assert.equal(f.shell.catalogueView.visible, true);
});

test('attaching after did-finish-load but before did-stop-loading still reveals Companion', async t => {
  const f = fixture(t); await f.shell.ready; f.shell.setCompanionAvailable(true);
  const companion = f.view(); companion.webContents.loading = true;
  f.shell.attachCompanion(companion); f.shell.showTab('companion');
  assert.equal(companion.visible, false);
  companion.webContents.loading = false; companion.webContents.emit('did-stop-loading');
  assert.equal(companion.visible, true); assert.equal(f.state().tabs.companion.ready, true);
  assert.equal(f.state().tabs.companion.loading, false);
});

test('revoking access before a queued click runs prevents the Companion callback', async t => {
  const selected = [], f = fixture(t, name => selected.push(name)); await f.shell.ready; f.shell.setCompanionAvailable(true);
  const pending = f.select('companion'); f.shell.setCompanionAvailable(false); await pending; await flush();
  assert.deepEqual(selected, ['catalogue']); assert.equal(f.state().activeTab, 'catalogue');
});

test('main-frame load failures show a safe retry state while aborted and subframe loads do not', async t => {
  const f = fixture(t); await f.shell.ready;
  const web = f.shell.catalogueView.webContents; web.finish('https://chartshub.ca/');
  web.emit('did-fail-load', {}, -3, 'aborted', '', true); assert.equal(f.state().tabs.catalogue.ready, true);
  web.emit('did-fail-load', {}, -2, 'subframe', '', false); assert.equal(f.state().tabs.catalogue.ready, true);
  web.emit('did-fail-load', {}, -105, 'SECRET internal path', '', true);
  assert.equal(f.state().tabs.catalogue.ready, false); assert.equal(f.shell.catalogueView.visible, false);
  assert.ok(f.state().tabs.catalogue.error); assert.ok(!JSON.stringify(f.state()).includes('SECRET'));
  web.emit('did-finish-load'); assert.equal(f.state().tabs.catalogue.ready, false, 'Chromium error page is not a successful catalogue');
  await f.select('catalogue'); assert.equal(web.reloads, 1); assert.equal(f.state().tabs.catalogue.loading, true);
  web.finish('https://chartshub.ca/'); assert.equal(f.shell.catalogueView.visible, true); assert.equal(f.state().tabs.catalogue.error, null);
});

test('rejected initialization is recoverable and disposing during an await leaves no live handlers', async t => {
  const gate = deferred(); let fail = true;
  const f = fixture(t, () => fail ? Promise.reject(Error('SECRET filesystem path')) : gate.promise); await f.shell.ready; f.shell.setCompanionAvailable(true);
  await f.select('companion'); assert.equal(f.state().tabs.companion.loading, false); assert.ok(f.state().tabs.companion.error);
  assert.ok(!JSON.stringify(f.state()).includes('SECRET'));
  fail = false; const pending = f.select('companion'); await flush();
  const companion = f.view(); f.shell.attachCompanion(companion);
  f.shell.dispose(); f.shell.dispose(); gate.resolve(); await pending;
  assert.equal(f.handlers.size, 0); assert.equal(f.shell.catalogueView.webContents.closes, 1); assert.equal(companion.webContents.closes, 0);
  assert.equal(f.shell.window.destroyed, false); assert.equal(f.shell.window.contentView.children.length, 0);
  assert.equal(companion.webContents.listenerCount('before-input-event'), 0);
});

test('destroyed native view accessors cannot interrupt later host shutdown listeners or shell disposal', async t => {
  const f = fixture(t); await f.shell.ready; f.shell.setCompanionAvailable(true);
  f.shell.catalogueView.webContents.finish('https://chartshub.ca/');
  const companion = f.view(), contents = companion.webContents;
  Object.defineProperty(companion, 'webContents', { get() {
    if (contents.destroyed) return undefined;
    return contents;
  } });
  f.shell.attachCompanion(companion); f.shell.showTab('companion');
  let hostObservedDestruction = false;
  contents.once('destroyed', () => { hostObservedDestruction = true; });
  assert.doesNotThrow(() => contents.close());
  assert.equal(hostObservedDestruction, true, 'the host must receive its destruction acknowledgement');
  assert.equal(f.state().tabs.companion.ready, false);
  assert.doesNotThrow(() => f.shell.window.emit('resize'));
  assert.doesNotThrow(() => f.shell.showTab('catalogue'));
  const remove = f.shell.window.contentView.removeChildView;
  f.shell.window.contentView.removeChildView = view => {
    if (view === companion) throw Error('Native view has been destroyed');
    remove(view);
  };
  assert.doesNotThrow(() => f.shell.dispose());
  assert.equal(f.handlers.size, 0); assert.equal(f.shell.catalogueView.webContents.closes, 1);
});

test('a dead Companion native view can be replaced without accessing its destroyed getter', async t => {
  const f = fixture(t); await f.shell.ready; f.shell.setCompanionAvailable(true);
  const first = f.view(), contents = first.webContents;
  f.shell.attachCompanion(first);
  Object.defineProperty(first, 'webContents', { get() { throw Error('Object has been destroyed'); } });
  contents.destroyed = true;
  assert.doesNotThrow(() => contents.emit('destroyed'));
  const replacement = f.view();
  assert.doesNotThrow(() => f.shell.attachCompanion(replacement));
  f.shell.showTab('companion');
  assert.equal(replacement.visible, true); assert.equal(f.state().tabs.companion.error, null);
});

test('keyboard tab and fullscreen actions work from all views while guests cannot open Companion', async t => {
  const selections = [], f = fixture(t, name => selections.push(name)); await f.shell.ready;
  const companion = f.view(); f.shell.attachCompanion(companion); f.shell.catalogueView.webContents.finish('https://chartshub.ca/');
  function input(web, key, extra = {}) {
    let prevented = false; web.emit('before-input-event', { preventDefault() { prevented = true; } }, { type: 'keyDown', key, ...extra }); return prevented;
  }
  assert.equal(input(f.shell.window.webContents, 'c', { control: true, shift: true }), true); await flush(); assert.deepEqual(selections, []);
  f.shell.setCompanionAvailable(true);
  for (const web of [f.shell.window.webContents, f.shell.catalogueView.webContents, companion.webContents]) {
    assert.equal(input(web, 'Tab', { control: true }), true); await flush();
    assert.equal(input(web, 'F11'), true); assert.equal(f.shell.window.isFullScreen(), true);
    assert.equal(input(web, 'Escape'), true); assert.equal(f.shell.window.isFullScreen(), false);
  }
  assert.equal(selections.length, 3);
  assert.equal(input(companion.webContents, 'r', { control: true }), false, 'catalogue main retains reload/zoom handlers');
});

test('theme is validated, copied and updates native titlebar without changing the selected content', async t => {
  const f = fixture(t); await f.shell.ready;
  assert.equal(f.shell.setTheme({ mode: 'dark', accent: 'url(secret)' }), false);
  const selected = f.state().activeTab;
  assert.equal(f.shell.setTheme({ mode: 'light', accent: '#AbCdEf' }), true);
  assert.equal(f.state().theme.mode, 'light'); assert.equal(f.state().theme.accent, '#abcdef');
  const copy = f.state(); copy.theme.accent = '#000000'; assert.equal(f.state().theme.accent, '#abcdef');
  assert.equal(f.state().activeTab, selected); assert.equal(f.shell.window.background, f.state().theme.color);
  if (process.platform !== 'darwin') assert.equal(f.shell.window.titlebar.height, 36);
});

test('shell preload exposes only validated tab selection and snapshots, never raw Electron events', async () => {
  let api, notification; const invocations = [], removed = [];
  const electron = { contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'chartsHubShell'); api = value; } }, ipcRenderer: {
    invoke: (...args) => { invocations.push(args); return Promise.resolve({}); },
    on: (channel, listener) => { assert.equal(channel, 'chartshub-shell:changed'); notification = listener; },
    removeListener: (channel, listener) => removed.push([channel, listener])
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../desktop/preload.cjs'), 'utf8'), { require: name => { assert.equal(name, 'electron'); return electron; } });
  assert.deepEqual(Object.keys(api).sort(), ['getState', 'onState', 'selectTab']);
  await api.getState(); await api.selectTab('companion'); await assert.rejects(api.selectTab('companion:command'));
  assert.deepEqual(invocations, [['chartshub-shell:state'], ['chartshub-shell:select-tab', 'companion']]);
  const received = [], unsubscribe = api.onState((...args) => received.push(args));
  notification({ sender: 'secret privileged event' }, { activeTab: 'catalogue' });
  assert.deepEqual(received, [[{ activeTab: 'catalogue' }]]); unsubscribe(); assert.equal(removed[0][1], notification);
  assert.equal(Object.isFrozen(api), true);
});
