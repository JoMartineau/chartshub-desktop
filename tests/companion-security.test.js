const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { assetPath, trustedSender, trustedFiltersWidgetCommand, validCommand } = require('../companion/security.cjs');
const root = path.resolve(__dirname, '../companion');
test('companion assets remain in local UI/dist directories', () => {
  assert.equal(assetPath(root, 'https://app/ui/index.html'), null);
  assert.equal(assetPath(root, 'chartshub-companion://other/ui/index.html'), null);
  assert.equal(assetPath(root, 'chartshub-companion://app/ui/%2e%2e%2fpreload.cjs'), null);
  assert.equal(assetPath(root, 'chartshub-companion://app/ui/%2e%2e%5cpreload.cjs'), null);
  assert.equal(assetPath(root, 'chartshub-companion://app/../main.js'), null);
  assert.equal(assetPath(root, 'chartshub-companion://user@app/ui/index.html'), null);
  assert.equal(assetPath(root, 'chartshub-companion://app/ui/missing.js'), null);
  assert.equal(assetPath(root, 'chartshub-companion://app/ui/index.html'), path.join(root, 'ui/index.html'));
});

test('asset canonical paths cannot escape UI/dist through an internal directory link', async t => {
  const fs = require('node:fs/promises'), os = require('node:os');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-assets-test-'));
  t.after(async () => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('chartshub-assets-test-')) throw Error('Unexpected temporary test directory');
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(directory, 'ui'));
  await fs.mkdir(path.join(directory, 'private'));
  await fs.writeFile(path.join(directory, 'private', 'main-only.js'), 'private main-process asset');
  await fs.symlink(path.join(directory, 'private'), path.join(directory, 'ui', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(assetPath(directory, 'chartshub-companion://app/ui/linked/main-only.js'), null);
});
test('companion IPC requires the known window and its local main frame', () => {
  const frame = { url: 'chartshub-companion://app/ui/index.html' }, web = { mainFrame: null }; web.mainFrame = frame;
  const win = { isDestroyed: () => false, webContents: web };
  assert.equal(trustedSender({ sender: web, senderFrame: frame }, win, 'index.html'), true);
  assert.equal(trustedSender({ sender: {}, senderFrame: frame }, win, 'index.html'), false);
  assert.equal(trustedSender({ sender: web, senderFrame: { ...frame } }, win, 'index.html'), false);
  frame.url = 'https://chartshub.ca/'; assert.equal(trustedSender({ sender: web, senderFrame: frame }, win, 'index.html'), false);
});
test('companion command validation rejects unknown widgets, states and writes', () => {
  assert.equal(validCommand('widget.enabled', { id: 'title', enabled: false }, ['title']), true);
  assert.equal(validCommand('widget.enabled', { id: 'other', enabled: true }, ['title']), false);
  assert.equal(validCommand('widget.enabled', { id: 'title', enabled: 1 }, ['title']), false);
  assert.equal(validCommand('mock.state', { state: 'playing' }, []), true);
  assert.equal(validCommand('mock.state', { state: 'bad' }, []), false);
  assert.equal(validCommand('write-file', { path: 'anything' }, []), false);
  assert.equal(validCommand('mock.next', { unexpected: true }, []), false);
});

test('filter IPC accepts bounded full settings and prohibits renderer filesystem targets', () => {
  const settings = { enabled: false, saturation: 1, contrast: 1, gamma: 1, exposure: 0, sharpness: 0, vignette: 0 };
  assert.equal(validCommand('filters.settings', { settings }, []), true);
  for (const patch of [{ enabled: 1 }, { saturation: Infinity }, { gamma: .49 }, { contrast: 2.01 }, { sharpness: -1 }, { exposure: 2.01 }, { vignette: '1' }, { path: 'arbitrary.ini' }]) assert.equal(validCommand('filters.settings', { settings: { ...settings, ...patch } }, []), false);
  assert.equal(validCommand('filters.settings', { settings: { enabled: true } }, []), false);
  assert.equal(validCommand('filters.settings', { settings, path: 'arbitrary.ini' }, []), false);
  for (const command of ['filters.chooseRoot', 'filters.install', 'filters.restore', 'filters.refresh', 'filters.openPanel']) {
    assert.equal(validCommand(command, undefined, []), true);
    assert.equal(validCommand(command, { path: 'arbitrary-game' }, []), false);
  }
  assert.equal(validCommand('filters.widget', { enabled: true }, []), true);
  assert.equal(validCommand('filters.widget', { enabled: true, width: 500 }, []), false);
});

test('filter mini widget is permitted only filter controls and opening the main panel', () => {
  const frame = { url: 'chartshub-companion://app/ui/filters-widget.html' };
  const webContents = { mainFrame: frame };
  const window = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: frame };
  for (const command of ['filters.settings', 'filters.openPanel', 'reshade.command']) assert.equal(trustedFiltersWidgetCommand(event, window, command), true);
  for (const command of ['filters.chooseRoot', 'filters.install', 'filters.restore', 'filters.refresh', 'filters.widget', 'reshade.chooseRoot', 'reshade.install', 'reshade.refresh', 'reshade.setupPrepare', 'reshade.setupInstall', 'reshade.setupCancel', 'library.openFolder', 'library.compareDuplicates', 'library.chooseDuplicate', 'library.prepareCleanup', 'library.recycleDuplicates', 'profile.save', 'profile.apply', 'profile.delete', 'widget.locked', 'overlay.enabled']) assert.equal(trustedFiltersWidgetCommand(event, window, command), false);
  assert.equal(trustedFiltersWidgetCommand({ ...event, senderFrame: { ...frame } }, window, 'filters.settings'), false);
  frame.url = 'chartshub-companion://app/ui/overlay.html';
  assert.equal(trustedFiltersWidgetCommand(event, window, 'filters.settings'), false);
});

test('ReShade IPC accepts bounded control messages and denies filesystem/network payloads', () => {
  for (const payload of [{ action: 'enabled', enabled: true }, { action: 'technique', id: 't:abc123', enabled: false }, { action: 'selectEffect', effect: 'Bloom.fx' }, { action: 'uniform', id: 'u_42', values: [0, .25, true] }, { action: 'save' }]) assert.equal(validCommand('reshade.command', payload, []), true);
  for (const payload of [null, { action: 'install' }, { action: 'enabled', enabled: 1 }, { action: 'save', path: 'preset.ini' }, { action: 'technique', id: '../dll', enabled: true }, { action: 'selectEffect', effect: 'unsafe\nvalue' }, { action: 'uniform', id: 'u1', values: [] }, { action: 'uniform', id: 'u1', values: [NaN] }, { action: 'uniform', id: 'u1', values: ['.5'] }, { action: 'uniform', id: 'u1', values: new Array(17).fill(0) }, { action: 'uniform', id: 'u1', values: [1], path: 'shader.fx' }]) assert.equal(validCommand('reshade.command', payload, []), false);
  for (const name of ['reshade.chooseRoot', 'reshade.install', 'reshade.refresh']) {
    assert.equal(validCommand(name, undefined, []), true);
    assert.equal(validCommand(name, { path: 'other-game' }, []), false);
  }
});

test('ReShade setup IPC permits only the explicit optional-pack flag and no renderer target', () => {
  for (const includeStarterEffects of [true, false]) assert.equal(validCommand('reshade.setupPrepare', { includeStarterEffects }, []), true);
  for (const payload of [undefined, null, {}, { includeStarterEffects: 1 }, { includeStarterEffects: false, path: 'other-game' }, { includeStarterEffects: true, url: 'https://other.test/setup.exe' }]) assert.equal(validCommand('reshade.setupPrepare', payload, []), false);
  for (const name of ['reshade.setupInstall', 'reshade.setupCancel']) {
    assert.equal(validCommand(name, undefined, []), true);
    assert.equal(validCommand(name, { path: 'other-game' }, []), false);
  }
});

test('Clone Hero commands accept modes and native file selection only', () => {
  for (const mode of ['live', 'mock']) assert.equal(validCommand('clonehero.mode', { mode }, []), true);
  for (const payload of [{ mode: 'other' }, { mode: 'live', path: 'private.txt' }, null]) assert.equal(validCommand('clonehero.mode', payload, []), false);
  for (const name of ['clonehero.chooseFile', 'clonehero.detect']) {
    assert.equal(validCommand(name, undefined, []), true);
    assert.equal(validCommand(name, { path: 'private.txt' }, []), false);
  }
});

test('font size commands validate the widget, revision and finite bounds', () => {
  const command = payload => validCommand('widget.fontSize', payload, ['song-charter']);
  for (const fontSize of [8, 14, 32.5, 200]) assert.equal(command({ id: 'song-charter', revision: 0, fontSize }), true);
  for (const fontSize of [0, 7, 201, NaN, Infinity, '24', null]) assert.equal(command({ id: 'song-charter', revision: 0, fontSize }), false);
  assert.equal(command({ id: 'unknown', revision: 0, fontSize: 24 }), false);
  assert.equal(command({ id: 'song-charter', revision: -1, fontSize: 24 }), false);
  assert.equal(command({ id: 'song-charter', revision: 0, fontSize: 24, color: '#ffffff' }), false);
});

test('builder commands reject invalid coordinates, duplicate identities and unsupported visibility', () => {
  const item = { id: 'title', x: 20, y: 30, width: 300, height: 60 };
  const layout = items => ({ revision: 0, items });
  const valid = payload => validCommand('widget.layout', payload, ['title', 'artist']);
  assert.equal(valid(layout([item])), true);
  for (const patch of [{ x: -1 }, { y: Infinity }, { x: NaN }, { width: 23 }, { height: 15 }, { x: 1200 }, { y: 710 }, { id: 'unknown' }, { config: {} }]) {
    assert.equal(valid(layout([{ ...item, ...patch }])), false);
  }
  assert.equal(valid(layout([item, item])), false);
  assert.equal(valid(layout([])), false);
  assert.equal(valid({ revision: 0.5, items: [item] }), false);
  assert.equal(valid({ revision: -1, items: [item] }), false);
  assert.equal(validCommand('widget.visibility', { revision: 0, id: 'title', game: true, gameplayVisibility: [] }, ['title']), true);
  for (const gameplayVisibility of [['menu'], ['playing', 'playing'], ['playing', 'paused', 'results'], 'playing']) {
    assert.equal(validCommand('widget.visibility', { revision: 0, id: 'title', game: true, gameplayVisibility }, ['title']), false);
  }
  assert.equal(validCommand('editor.undo', undefined, []), true);
  assert.equal(validCommand('editor.redo', { unexpected: true }, []), false);
});

test('theme command routing validates preset, token, widget and revision identities', () => {
  assert.equal(validCommand('theme.preset', { revision: 0, id: 'neon' }, []), true);
  assert.equal(validCommand('theme.preset', { revision: 0, id: 'unknown' }, []), false);
  assert.equal(validCommand('theme.color', { revision: 0, token: 'text', color: 'rgb(20 30 40 / 50%)' }, []), true);
  assert.equal(validCommand('theme.color', { revision: 0, token: 'backgroundImage', color: '#fff' }, []), false);
  assert.equal(validCommand('theme.color', { revision: -1, token: 'text', color: '#fff' }, []), false);
  assert.equal(validCommand('theme.color', { revision: 0, token: 'text', color: 'x'.repeat(129) }, []), false);
  assert.equal(validCommand('theme.effects', { revision: 0, effects: { css: 'anything' } }, []), false);
  assert.equal(validCommand('widget.appearance', { revision: 0, id: 'title', style: { colorMode: 'custom', color: '#f09' } }, ['title']), true);
  assert.equal(validCommand('widget.appearance', { revision: 0, id: 'other', style: {} }, ['title']), false);
  assert.equal(validCommand('widget.appearance', { revision: 0, id: 'title', style: { backgroundImage: 'url(x)' } }, ['title']), false);
});
test('existing application menu can open Companion without removing catalogue commands', () => {
  const { applicationMenu } = require('../app-menu'); let calls = 0;
  const menu = applicationMenu({ language: 'fr', companion: () => calls++ });
  menu.find(item => item.label === 'Clone Hero Companion').click();
  assert.equal(calls, 1); assert.ok(menu.some(item => item.label === 'Catalogue'));
});

async function hostFixture(t, { catalogueClient, downloadWorker, filtersService, reshadeService, reshadeSetupService, prepareData, embedded = false } = {}) {
  const fs = require('node:fs/promises'), os = require('node:os');
  const { EventEmitter } = require('node:events');
  const Module = require('node:module');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-host-test-'));
  const windows = [], views = [], attached = [], handlers = new Map(), copied = [], opened = [], openedUrls = [];
  let activations = 0;
  let localProtocol;
  const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) };
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.visible = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        mainFrame: { url: '' }, isLoading: () => false, send() {}, setWindowOpenHandler() {}
      });
      windows.push(this);
    }
    async loadURL(url) { this.webContents.mainFrame.url = url; }
    isDestroyed() { return this.destroyed; }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.visible = false; this.emit('closed'); } }
    show() { assert.equal(this.destroyed, false); this.visible = true; }
    showInactive() { this.show(); }
    hide() { this.visible = false; }
    isMinimized() { return false; }
    restore() {}
    focus() {}
    setMenuBarVisibility() {}
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
  }
  class ContentsView {
    constructor(options) {
      this.options = options; this.visible = true;
      const contents = this.webContents = new EventEmitter();
      let destroyed = false;
      Object.assign(contents, {
        mainFrame: { url: '' }, isLoading: () => false, isDestroyed: () => destroyed, send() {}, setWindowOpenHandler() {},
        async loadURL(url) { contents.mainFrame.url = url; },
        close() { if (!destroyed) { destroyed = true; contents.emit('destroyed'); } }
      });
      views.push(this);
    }
    setVisible(value) { this.visible = value; }
  }
  const owner = embedded ? new Window({ title: 'ChartsHub shell' }) : null;
  const app = new EventEmitter();
  app.getPath = () => directory; app.quit = () => {};
  const localSession = new EventEmitter();
  Object.assign(localSession, {
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    protocol: { async handle(_scheme, handler) { localProtocol = handler; }, unhandle() {} }
  });
  const shell = { async openPath(value) { opened.push(value); return ''; }, async openExternal(value) { openedUrls.push(value); }, async trashItem() { throw Error('No native recycling in tests'); } };
  const electron = {
    app, BrowserWindow: Window, WebContentsView: ContentsView,
    clipboard: { writeText(value) { copied.push(value); } },
    dialog, shell,
    ipcMain: { handle(name, handler) { handlers.set(name, handler); }, removeHandler(name) { handlers.delete(name); } },
    protocol: { registerSchemesAsPrivileged() {} },
    session: { fromPartition(name) { assert.equal(name, 'companion-local'); return localSession; } },
    net: { fetch() { throw Error('Unexpected network access'); } },
    screen: { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }) }
  };
  const hostPath = require.resolve('../companion/host.cjs');
  const previous = require.cache[hostPath], originalLoad = Module._load;
  let createCompanionHost;
  try {
    delete require.cache[hostPath];
    Module._load = function (request, ...args) { return request === 'electron' ? electron : originalLoad.call(this, request, ...args); };
    ({ createCompanionHost } = require(hostPath));
  } finally {
    Module._load = originalLoad;
    if (previous) require.cache[hostPath] = previous; else delete require.cache[hostPath];
  }
  if (prepareData) await prepareData(directory);
  const host = await createCompanionHost({ dataDirectory: directory, catalogueClient, downloadWorker, cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({ running: null, sessions: [] }), filtersService, reshadeService, reshadeSetupService,
    ...(embedded ? { embedded: { ownerWindow: owner, attachView: view => attached.push(view), activate: () => { activations++; } } } : {}) });
  t.after(async () => {
    await host.dispose();
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    await host.stop();
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('chartshub-host-test-')) throw Error('Unexpected temporary test directory');
    await fs.rm(directory, { recursive: true, force: true });
  });
  const eventFor = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  return { host, windows, views, owner, attached, activations: () => activations, app, handlers, eventFor, directory, copied, dialog, shell, opened, openedUrls, protocolRequest: (url, method = 'GET') => localProtocol({ url, method }) };
}

function fakeFiltersService() {
  const value = { rootPath: null, settings: { enabled: false, saturation: 1, contrast: 1, gamma: 1, exposure: 0, sharpness: 0, vignette: 0 }, supported: true, binaryAvailable: true, installed: false, reshadePresent: false, state: 'unconfigured', message: 'Choisissez le dossier du jeu.', error: null, running: false, busy: false, native: null };
  const calls = [];
  return { value, calls, async load() {}, status: () => structuredClone(value),
    async refresh() { calls.push('refresh'); }, async dispose() { calls.push('dispose'); },
    async selectRoot(rootPath) { value.rootPath = rootPath; value.state = 'not-installed'; calls.push('selectRoot'); },
    async setSettings(settings) { value.settings = structuredClone(settings); calls.push('setSettings'); },
    async install() { value.installed = true; calls.push('install'); },
    async restore() { value.installed = false; calls.push('restore'); }
  };
}

function fakeReShadeService() {
  const value = { rootPath: null, supported: true, binaryAvailable: true, installed: false, running: false, connected: true, busy: false, state: 'ready', message: 'ReShade connecté.', error: null, catalog: { enabled: true, preset: path.join('private', 'my-preset.ini'), selectedEffect: null, techniques: [{ id: 't1', name: 'Bloom', label: 'Bloom', effect: 'Bloom.fx', enabled: false }], uniforms: [] } };
  const calls = [];
  return { value, calls, async load() {}, status: () => structuredClone(value), async refresh() {}, async dispose() {},
    async selectRoot(rootPath) { value.rootPath = rootPath; calls.push('selectRoot'); },
    async install() { value.installed = true; calls.push('install'); },
    async command(payload) { calls.push(structuredClone(payload)); if (payload.action === 'enabled') value.catalog.enabled = payload.enabled; }
  };
}

function fakeReShadeSetupService(reshadeService) {
  const value = { state: 'idle', busy: false, rootPath: null, includeStarterEffects: false, version: '6.8.0', message: 'À préparer.', error: null, progress: null, files: [] };
  const calls = [];
  return { value, calls, async load() {}, status: () => structuredClone(value), async dispose() {},
    async prepare(options) { calls.push({ action: 'prepare', ...options }); Object.assign(value, { state: 'ready', rootPath: reshadeService.status().rootPath, includeStarterEffects: options.includeStarterEffects, files: ['dxgi.dll', 'ChartsHubReShade.addon64'] }); },
    async install() { calls.push({ action: 'install' }); value.state = 'complete'; },
    async cancel() { calls.push({ action: 'cancel' }); value.state = 'idle'; value.busy = false; value.files = []; }
  };
}

test('embedded Companion trusts only its exact local contents and publishes no state into the shell', async t => {
  const f = await hostFixture(t, { embedded: true });
  const beforeQuit = f.app.listenerCount('before-quit');
  const [first, second] = await Promise.all([f.host.open(), f.host.open()]);
  assert.equal(first, f.owner); assert.equal(second, f.owner);
  assert.equal(f.windows.length, 1, 'opening a tab must not create another BrowserWindow');
  assert.equal(f.views.length, 1); assert.deepEqual(f.attached, [f.host.getPanelView()]);
  const contents = f.host.getPanelContents(), panelEvent = { sender: contents, senderFrame: contents.mainFrame };
  assert.equal(contents, f.host.getPanelView().webContents);
  assert.notEqual(contents, f.owner.webContents);
  assert.equal(f.app.listenerCount('before-quit'), beforeQuit);
  assert.equal(beforeQuit, 0, 'the embedding application owns shutdown');
  let shellUpdates = 0, panelUpdates = 0;
  f.owner.webContents.send = () => { shellUpdates++; };
  contents.send = () => { panelUpdates++; };
  f.owner.webContents.mainFrame.url = contents.mainFrame.url;
  const snapshot = f.handlers.get('companion:snapshot'), command = f.handlers.get('companion:command');
  assert.ok(snapshot(panelEvent));
  assert.equal(snapshot(f.eventFor(f.owner)), null, 'a shared URL does not grant the shell native access');
  assert.equal((await command(f.eventFor(f.owner), 'mock.next')).ok, false);
  assert.equal((await command({ sender: contents, senderFrame: { ...contents.mainFrame } }, 'mock.next')).ok, false);
  assert.equal((await command(panelEvent, 'mock.next')).ok, true);
  assert.ok(panelUpdates > 0); assert.equal(shellUpdates, 0);
  await f.host.setFiltersWidget(true);
  const priorActivations = f.activations();
  assert.equal((await command(f.eventFor(f.host.getFiltersWidget()), 'filters.openPanel')).ok, true);
  assert.equal(f.activations(), priorActivations + 1); assert.equal(f.views.length, 1);
  assert.equal((await command(f.eventFor(f.host.getFiltersWidget()), 'reshade.setupPrepare', { includeStarterEffects: false })).ok, false);
  const dispose = f.host.dispose(); assert.equal(f.host.dispose(), dispose); await dispose;
  assert.equal(contents.isDestroyed(), true); assert.equal(f.owner.isDestroyed(), false);
  assert.equal(f.handlers.has('companion:command'), false);
});

test('embedded tab visibility preserves active services and native pickers use the owner window', async t => {
  const reshadeService = fakeReShadeService(), reshadeSetupService = fakeReShadeSetupService(reshadeService);
  const f = await hostFixture(t, { embedded: true, reshadeService, reshadeSetupService });
  await f.host.open();
  const contents = f.host.getPanelContents(), event = { sender: contents, senderFrame: contents.mainFrame };
  const invoke = (name, payload) => f.handlers.get('companion:command')(event, name, payload);
  Object.assign(reshadeSetupService.value, { state: 'ready', files: ['dxgi.dll'] });
  await f.host.setOverlay(true); await f.host.setFiltersWidget(true);
  f.host.getPanelView().setVisible(false);
  assert.equal(f.host.snapshot().overlayEnabled, true); assert.equal(f.host.snapshot().filtersWidgetEnabled, true);
  assert.equal(reshadeSetupService.calls.some(call => call.action === 'cancel'), false);
  assert.equal((await invoke('mock.next')).ok, true, 'a hidden tab remains connected');
  let release;
  f.dialog.showOpenDialog = (owner) => { assert.equal(owner, f.owner); return new Promise(resolve => { release = resolve; }); };
  const picking = invoke('reshade.chooseRoot');
  assert.equal(typeof release, 'function');
  contents.close();
  release({ canceled: false, filePaths: [path.join(f.directory, 'late-game')] });
  assert.equal((await picking).ok, false, 'a closed contents invalidates its picker even while the owner lives');
  await f.host.stop();
  assert.equal(reshadeService.calls.includes('selectRoot'), false);
  assert.equal(f.owner.isDestroyed(), false);
  assert.equal(f.host.snapshot().overlayEnabled, false);
  assert.ok(reshadeSetupService.calls.some(call => call.action === 'cancel'));
});

test('recreating an embedded tab rejects the previous library picker even with the same owner', async t => {
  const f = await hostFixture(t, { embedded: true }); await f.host.open();
  let release;
  f.dialog.showOpenDialog = owner => { assert.equal(owner, f.owner); return new Promise(resolve => { release = resolve; }); };
  const contents = f.host.getPanelContents();
  const picking = f.handlers.get('companion:command')({ sender: contents, senderFrame: contents.mainFrame }, 'library.chooseRoot');
  contents.close(); await f.host.open();
  assert.equal(f.host.getPanel(), f.owner); assert.notEqual(f.host.getPanelContents(), contents);
  release({ canceled: false, filePaths: [f.directory] });
  assert.equal((await picking).ok, false);
  assert.equal(f.host.library.status().settings.rootPath, null);
});

test('ReShade setup stays main-only and installs only the reviewed target with the game closed', async t => {
  const reshadeService = fakeReShadeService(), reshadeSetupService = fakeReShadeSetupService(reshadeService);
  const { host, handlers, eventFor, dialog, directory } = await hostFixture(t, { reshadeService, reshadeSetupService });
  const panel = await host.open(); await host.setFiltersWidget(true); await host.setOverlay(true);
  const invoke = (window, name, payload) => handlers.get('companion:command')(eventFor(window), name, payload);
  for (const window of [host.getFiltersWidget(), host.getOverlay()]) {
    assert.equal((await invoke(window, 'reshade.setupPrepare', { includeStarterEffects: true })).ok, false);
    assert.equal((await invoke(window, 'reshade.setupInstall')).ok, false);
    assert.equal((await invoke(window, 'reshade.setupCancel')).ok, false);
  }
  assert.equal(handlers.get('companion:snapshot')(eventFor(host.getFiltersWidget())).reshadeSetup, undefined);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(directory, 'game')] });
  await invoke(panel, 'reshade.chooseRoot');
  reshadeService.value.running = true;
  assert.equal((await invoke(panel, 'reshade.setupPrepare', { includeStarterEffects: true })).ok, true, 'preparation is allowed while the game runs');
  assert.equal(host.snapshot().reshadeSetup.includeStarterEffects, true);
  assert.equal((await invoke(panel, 'reshade.setupInstall')).ok, false);
  reshadeService.value.running = null;
  assert.equal((await invoke(panel, 'reshade.setupInstall')).ok, false);
  reshadeService.value.running = false;
  reshadeService.value.rootPath = path.join(directory, 'other-game');
  assert.equal((await invoke(panel, 'reshade.setupInstall')).ok, false);
  reshadeService.value.rootPath = reshadeSetupService.value.rootPath;
  dialog.showMessageBox = async () => { throw Error('The reviewed install button must not open a second confirmation'); };
  assert.equal((await invoke(panel, 'reshade.setupInstall')).ok, true);
  assert.equal(reshadeSetupService.calls.filter(call => call.action === 'install').length, 1);
  reshadeSetupService.prepare = async () => { throw Object.assign(Error('Téléchargement officiel indisponible.'), { code: 'RESHADE_SETUP_SAFE' }); };
  assert.equal((await invoke(panel, 'reshade.setupPrepare', { includeStarterEffects: false })).error, 'Téléchargement officiel indisponible.');
});

test('closing the panel cancels preparation and invalidates pending setup installation', async t => {
  const reshadeService = fakeReShadeService(), reshadeSetupService = fakeReShadeSetupService(reshadeService);
  const { host, handlers, eventFor, directory } = await hostFixture(t, { reshadeService, reshadeSetupService });
  reshadeService.value.rootPath = path.join(directory, 'game');
  let panel = await host.open();
  const invoke = (name, payload) => handlers.get('companion:command')(eventFor(panel), name, payload);
  let finishPreparation;
  reshadeSetupService.prepare = () => { reshadeSetupService.value.state = 'preparing'; reshadeSetupService.value.busy = true; return new Promise(resolve => { finishPreparation = resolve; }); };
  const originalCancel = reshadeSetupService.cancel;
  reshadeSetupService.cancel = async () => { await originalCancel(); finishPreparation?.(); };
  const preparing = invoke('reshade.setupPrepare', { includeStarterEffects: false });
  assert.equal((await invoke('reshade.chooseRoot')).ok, false, 'the game target cannot move during preparation');
  panel.destroy(); await host.stop(); await preparing;
  assert.ok(reshadeSetupService.calls.some(call => call.action === 'cancel'));
  panel = await host.open(); await new Promise(resolve => setImmediate(resolve));
  Object.assign(reshadeSetupService.value, { state: 'ready', rootPath: reshadeService.value.rootPath, files: ['dxgi.dll'], busy: false });
  let releaseRefresh, entered;
  const refreshing = new Promise(resolve => { entered = resolve; });
  reshadeService.refresh = () => { entered(); return new Promise(resolve => { releaseRefresh = resolve; }); };
  const installing = invoke('reshade.setupInstall');
  await refreshing;
  panel.destroy(); releaseRefresh(); await host.stop();
  assert.equal((await installing).ok, false);
  assert.equal(reshadeSetupService.calls.some(call => call.action === 'install'), false);
});

test('closing the panel waits for an active ReShade installation without cancelling it', async t => {
  const reshadeService = fakeReShadeService(), reshadeSetupService = fakeReShadeSetupService(reshadeService);
  const { host, handlers, eventFor, directory } = await hostFixture(t, { reshadeService, reshadeSetupService });
  reshadeService.value.rootPath = path.join(directory, 'game');
  Object.assign(reshadeSetupService.value, { state: 'ready', rootPath: reshadeService.value.rootPath, files: ['dxgi.dll'] });
  let finishInstallation, startedInstallation;
  const started = new Promise(resolve => { startedInstallation = resolve; });
  const active = new Promise(resolve => { finishInstallation = resolve; });
  reshadeSetupService.install = async () => {
    reshadeSetupService.value.state = 'installing'; reshadeSetupService.value.busy = true;
    startedInstallation(); await active;
    reshadeSetupService.value.state = 'complete'; reshadeSetupService.value.busy = false;
  };
  reshadeSetupService.whenIdle = () => active;
  const panel = await host.open();
  const installing = handlers.get('companion:command')(eventFor(panel), 'reshade.setupInstall');
  await started;
  panel.destroy();
  let stopped = false;
  const stopping = host.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false, 'shutdown must wait until installation commits or rolls back');
  assert.equal(reshadeSetupService.calls.some(call => call.action === 'cancel'), false);
  finishInstallation(); await stopping;
  assert.equal((await installing).ok, true);
});

test('ReShade widget controls reach the service while installation stays panel-only', async t => {
  const reshadeService = fakeReShadeService();
  const { host, handlers, eventFor } = await hostFixture(t, { reshadeService });
  const panel = await host.open();
  await host.setFiltersWidget(true); await host.setOverlay(true);
  const widget = host.getFiltersWidget();
  const invoke = (window, name, payload) => handlers.get('companion:command')(eventFor(window), name, payload);
  const snapshot = handlers.get('companion:snapshot')(eventFor(widget));
  assert.equal(snapshot.reshade.catalog.preset, 'my-preset.ini');
  assert.equal(snapshot.reshade.rootPath, undefined);
  assert.equal(snapshot.reshade.message, undefined);
  for (const name of ['reshade.chooseRoot', 'reshade.install', 'reshade.refresh']) assert.equal((await invoke(widget, name)).ok, false);
  assert.equal((await invoke(widget, 'reshade.command', { action: 'enabled', enabled: false })).ok, true);
  assert.equal(reshadeService.value.catalog.enabled, false);
  assert.equal((await invoke(widget, 'reshade.command', { action: 'technique', id: 't1', enabled: true })).ok, true);
  assert.equal((await invoke(host.getOverlay(), 'reshade.command', { action: 'save' })).ok, false);
  assert.equal((await invoke(panel, 'reshade.command', { action: 'save' })).ok, true);
  assert.ok(reshadeService.calls.some(call => call.action === 'save'));
});

test('ReShade installation confirms the addon target and discards late dialogs', async t => {
  const reshadeService = fakeReShadeService();
  const { host, handlers, eventFor, dialog, directory } = await hostFixture(t, { reshadeService });
  let panel = await host.open();
  const invoke = (name, payload) => handlers.get('companion:command')(eventFor(panel), name, payload);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(directory, 'game')] });
  assert.equal((await invoke('reshade.chooseRoot')).ok, true);
  let detail = '';
  dialog.showMessageBox = async (_owner, options) => { detail = options.detail; return { response: 0 }; };
  assert.equal((await invoke('reshade.install')).cancelled, true);
  assert.match(detail, /ChartsHubReShade\.addon64/);
  assert.ok(detail.includes(reshadeService.value.rootPath));
  assert.equal(reshadeService.calls.includes('install'), false);
  reshadeService.value.running = true;
  dialog.showMessageBox = async () => { throw Error('Should require closing the game'); };
  assert.equal((await invoke('reshade.install')).ok, false);
  reshadeService.value.running = false;
  dialog.showMessageBox = async () => ({ response: 1 });
  assert.equal((await invoke('reshade.install')).ok, true);
  assert.equal(reshadeService.calls.filter(call => call === 'install').length, 1);
  let release, entered;
  const opened = new Promise(resolve => { entered = resolve; });
  dialog.showMessageBox = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const pending = invoke('reshade.install');
  await opened;
  assert.equal((await invoke('filters.chooseRoot')).ok, false, 'native and ReShade setup dialogs cannot overlap');
  panel.destroy(); await host.stop(); panel = await host.open();
  release({ response: 1 });
  assert.equal((await pending).ok, false);
  assert.equal(reshadeService.calls.filter(call => call === 'install').length, 1);
});

test('unreadable filter settings are preserved without preventing Companion startup', async t => {
  const fs = require('node:fs/promises');
  const original = '{invalid filters settings';
  const { host, directory, handlers, eventFor } = await hostFixture(t, { prepareData: directory => fs.writeFile(path.join(directory, 'filters.json'), original) });
  const panel = await host.open();
  assert.ok(panel && !panel.isDestroyed());
  assert.equal(host.snapshot().filters.state, 'error');
  assert.equal(await fs.readFile(path.join(directory, 'filters.json'), 'utf8'), original);
  assert.equal((await handlers.get('companion:command')(eventFor(panel), 'mock.state', { state: 'playing' })).ok, true);
  assert.equal(host.snapshot().state.gameplay.state, 'playing');
});

test('filter widget has isolated reads and cannot install modules or control the click-through overlay', async t => {
  const filtersService = fakeFiltersService();
  const { host, handlers, eventFor } = await hostFixture(t, { filtersService });
  const panel = await host.open();
  const originalState = structuredClone(host.snapshot().state);
  await host.setOverlay(true);
  const invoke = (window, name, payload) => handlers.get('companion:command')(eventFor(window), name, payload);
  assert.equal((await invoke(panel, 'filters.widget', { enabled: true })).ok, true);
  const widget = host.getFiltersWidget();
  assert.notEqual(widget, host.getOverlay());
  assert.equal(widget.options.alwaysOnTop, true);
  assert.equal(host.getOverlay().options.focusable, false);
  const snapshot = handlers.get('companion:snapshot')(eventFor(widget));
  assert.deepEqual(Object.keys(snapshot).sort(), ['filters', 'filtersWidgetEnabled', 'reshade']);
  assert.equal(snapshot.filters.rootPath, undefined);
  assert.equal(snapshot.filters.message, undefined);
  for (const name of ['filters.install', 'filters.restore', 'filters.chooseRoot', 'filters.refresh', 'downloads.chooseRoot']) assert.equal((await invoke(widget, name)).ok, false);
  assert.equal((await invoke(widget, 'overlay.enabled', { enabled: false })).ok, false);
  assert.equal((await invoke(host.getOverlay(), 'filters.settings', { settings: filtersService.value.settings })).ok, false);
  assert.equal((await invoke(widget, 'filters.settings', { settings: { ...filtersService.value.settings, enabled: true } })).ok, true);
  assert.equal(filtersService.value.settings.enabled, true);
  assert.equal((await invoke(widget, 'filters.openPanel')).ok, true);
  assert.equal(host.snapshot().filtersFocusRevision, 1);
  assert.deepEqual(host.snapshot().state, originalState, 'game filters must not mutate overlay appearance or editor history');
  widget.destroy();
  assert.equal(host.snapshot().filtersWidgetEnabled, false);
  assert.equal((await invoke(widget, 'filters.settings', { settings: filtersService.value.settings })).ok, false);
});

test('native filter installation confirms the selected target and rejects stale dialogs', async t => {
  const filtersService = fakeFiltersService();
  const { host, handlers, eventFor, dialog, directory } = await hostFixture(t, { filtersService });
  let panel = await host.open();
  const invoke = (name, payload) => handlers.get('companion:command')(eventFor(panel), name, payload);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(directory, 'game-fixture')] });
  assert.equal((await invoke('filters.chooseRoot')).ok, true);
  let confirmation;
  dialog.showMessageBox = async (_owner, options) => { confirmation = options; return { response: 0 }; };
  assert.equal((await invoke('filters.install')).cancelled, true);
  assert.match(confirmation.detail, /dxgi\.dll/);
  assert.ok(confirmation.detail.includes(filtersService.value.rootPath));
  assert.equal(filtersService.calls.includes('install'), false);
  dialog.showMessageBox = async () => ({ response: 1 });
  assert.equal((await invoke('filters.install')).ok, true);
  assert.equal(filtersService.calls.filter(call => call === 'install').length, 1);
  filtersService.value.running = true;
  assert.equal((await invoke('filters.restore')).ok, false);
  assert.equal(filtersService.calls.includes('restore'), false);
  filtersService.value.running = false;
  let release, opened;
  const waiting = new Promise(resolve => { opened = resolve; });
  dialog.showMessageBox = () => { opened(); return new Promise(resolve => { release = resolve; }); };
  const stale = invoke('filters.restore');
  await waiting;
  panel.destroy();
  await host.stop();
  panel = await host.open();
  release({ response: 1 });
  assert.equal((await stale).ok, false);
  assert.equal(filtersService.calls.includes('restore'), false);
  const selected = filtersService.value.rootPath;
  let releasePicker;
  dialog.showOpenDialog = () => new Promise(resolve => { releasePicker = resolve; });
  const picking = invoke('filters.chooseRoot');
  panel.destroy();
  await host.stop();
  releasePicker({ canceled: false, filePaths: [path.join(directory, 'other-game')] });
  assert.equal((await picking).ok, false);
  assert.equal(filtersService.value.rootPath, selected);
});

test('native Clone Hero export reaches widgets and clears them without changing the layout', async t => {
  const fs = require('node:fs/promises');
  const { WidgetRenderer } = await import('../companion/dist/widgets/engine/WidgetRenderer.js');
  const { createLocalOverlayServer } = require('../companion/stream-server.cjs');
  const { WebSocket } = require('ws');
  const { host, handlers, eventFor, directory, dialog } = await hostFixture(t);
  const panel = await host.open();
  const command = (name, payload) => handlers.get('companion:command')(eventFor(panel), name, payload);
  const token = 'a'.repeat(64);
  const streamServer = createLocalOverlayServer({ root, token });
  const unbind = host.services.store.subscribe(() => streamServer.publish(host.snapshot().state));
  const streamFrames = [];
  let socket;
  t.after(async () => { unbind(); socket?.terminate(); await streamServer.stop(); });
  await streamServer.start(0);
  const streamUrl = new URL(streamServer.status().url);
  socket = new WebSocket(`ws://${streamUrl.host}/events?token=${token}`, { origin: streamUrl.origin });
  socket.on('message', bytes => { const message = JSON.parse(String(bytes)); if (message.type === 'snapshot') streamFrames.push(message.state); });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const gameDirectory = path.join(directory, 'test-game');
  await fs.mkdir(gameDirectory);
  const songFile = path.join(gameDirectory, 'currentsong.txt');
  await fs.writeFile(path.join(gameDirectory, 'settings.ini'), '[streamer]\nsong_export = 1\ncustom_song_export = %s%n%a%n%c\n');
  await fs.writeFile(path.join(gameDirectory, 'songs.json'), JSON.stringify([
    { Name: 'Premonitions', Artist: 'Synestia', Charter: '<color=#FF0000>Test</color> <color=#00FF88>Charter</color>' },
    { Name: 'Second song', Artist: 'Second artist', Charter: '<color=#0088FF>Another author</color>' }
  ]));
  await fs.writeFile(songFile, 'Stale song\nStale artist\nStale charter');
  const originalWidgets = structuredClone(host.snapshot().state.widgets);
  host.integration.transition('playing');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.snapshot().state.nowPlaying.title, 'Everlong');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [songFile] });
  assert.equal((await command('clonehero.chooseFile')).ok, true);
  assert.equal(host.snapshot().cloneHero.mode, 'live');
  assert.equal(host.snapshot().state.nowPlaying, null, 'old demo and stale disk title both clear');
  assert.equal((await command('mock.state', { state: 'playing' })).ok, false);
  await host.setOverlay(true);
  assert.equal((await handlers.get('companion:command')(eventFor(host.getOverlay()), 'clonehero.mode', { mode: 'mock' })).ok, false);
  const waitFor = async predicate => {
    const deadline = Date.now() + 6000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(predicate(), 'native export should propagate');
  };
  await fs.writeFile(songFile, 'Premonitions\nSynestia\nTest Charter');
  await waitFor(() => host.snapshot().state.nowPlaying?.title === 'Premonitions');
  const renderer = new WidgetRenderer(host.registry);
  assert.deepEqual(renderer.renderWidgetModels(host.snapshot().state, 'game').map(widget => widget.text), ['Premonitions', 'Synestia', 'Test Charter']);
  assert.equal(host.getOverlay().visible, true);
  assert.equal(host.snapshot().state.nowPlaying.instrument, undefined);
  assert.equal(host.snapshot().state.nowPlaying.difficulty, undefined);
  const firstColors = [{ text: 'Test', color: '#ff0000' }, { text: ' ' }, { text: 'Charter', color: '#00ff88' }];
  await waitFor(() => host.snapshot().state.nowPlaying?.charterSegments?.length === 3);
  assert.deepEqual(host.snapshot().state.nowPlaying.charterSegments, firstColors);
  assert.deepEqual(renderer.renderWidgetModels(host.snapshot().state, 'game').find(widget => widget.type === 'song.charter').segments, firstColors);
  await waitFor(() => streamFrames.at(-1)?.nowPlaying?.title === 'Premonitions' && streamFrames.at(-1)?.nowPlaying?.charterSegments?.length === 3);
  const obs = streamFrames.at(-1);
  assert.equal(obs.nowPlaying.title, 'Premonitions');
  assert.deepEqual(obs.nowPlaying.charterSegments, firstColors);
  assert.ok(!JSON.stringify(obs).includes(directory));
  await fs.writeFile(songFile, 'Second song\nSecond artist\nAnother author');
  await waitFor(() => host.snapshot().state.nowPlaying?.title === 'Second song');
  await waitFor(() => streamFrames.at(-1)?.nowPlaying?.title === 'Second song' && streamFrames.at(-1)?.nowPlaying?.charterSegments?.length === 1);
  assert.deepEqual(streamFrames.at(-1).nowPlaying.charterSegments, [{ text: 'Another author', color: '#0088ff' }]);
  assert.equal((await command('widget.appearance', { revision: host.snapshot().editor.revision, id: 'song-charter', style: { useSourceColors: false, colorMode: 'custom', color: '#abcdef' } })).ok, true);
  const customCharter = renderer.renderWidgetModels(host.snapshot().state, 'game').find(widget => widget.type === 'song.charter');
  assert.equal(customCharter.segments, undefined);
  assert.equal(customCharter.style.color, '#abcdef');
  await command('editor.undo');
  assert.deepEqual(host.snapshot().state.widgets, originalWidgets);
  await fs.writeFile(songFile, '');
  await waitFor(() => host.snapshot().state.nowPlaying === null);
  assert.equal(host.getOverlay().visible, false);
  await waitFor(() => streamFrames.at(-1)?.nowPlaying === null);
  assert.deepEqual(host.snapshot().state.widgets, originalWidgets);
  assert.equal((await command('clonehero.mode', { mode: 'mock' })).ok, true);
  assert.equal((await command('mock.state', { state: 'playing' })).ok, true);
  await waitFor(() => host.snapshot().state.nowPlaying?.title === 'Everlong');
});

test('closing a panel invalidates its pending Clone Hero file picker', async t => {
  const { host, handlers, eventFor, dialog } = await hostFixture(t);
  const panel = await host.open();
  let finish;
  dialog.showOpenDialog = () => new Promise(resolve => { finish = resolve; });
  const result = handlers.get('companion:command')(eventFor(panel), 'clonehero.chooseFile');
  panel.destroy();
  await host.open();
  finish({ canceled: false, filePaths: ['C:\\unselected\\currentsong.txt'] });
  assert.equal((await result).ok, false);
  assert.equal(host.snapshot().cloneHero.mode, 'mock');
});

test('font resizing preserves charter colors and layouts, rejects stale edits, undoes and persists', async t => {
  const fs = require('node:fs/promises');
  const { host, handlers, eventFor, directory } = await hostFixture(t);
  const panel = await host.open();
  const command = (name, payload) => handlers.get('companion:command')(eventFor(panel), name, payload);
  const id = 'song-charter';
  const style = { ...host.snapshot().state.widgets.instances.find(widget => widget.id === id).style, useSourceColors: true, colorMode: 'custom', color: '#123456', glow: { enabled: true, color: '#abcdef', blur: 12 } };
  await command('widget.appearance', { revision: host.snapshot().editor.revision, id, style });
  const initial = structuredClone(host.snapshot().state);
  const revision = host.snapshot().editor.revision;
  assert.equal((await command('widget.fontSize', { revision, id, fontSize: 80 })).ok, true);
  const expected = structuredClone(initial.widgets);
  expected.instances.find(widget => widget.id === id).style.fontSize = 80;
  assert.deepEqual(host.snapshot().state.widgets, expected);
  assert.deepEqual(host.snapshot().state.stream, initial.stream);
  assert.equal((await command('widget.fontSize', { revision, id, fontSize: 8 })).code, 'STALE_REVISION');
  await host.setOverlay(true);
  assert.equal((await handlers.get('companion:command')(eventFor(host.getOverlay()), 'widget.fontSize', { revision: host.snapshot().editor.revision, id, fontSize: 8 })).ok, false);
  await command('editor.undo');
  assert.deepEqual(host.snapshot().state.widgets, initial.widgets);
  await command('editor.redo');
  assert.deepEqual(host.snapshot().state.widgets, expected);
  const nextRevision = host.snapshot().editor.revision;
  await command('widget.fontSize', { revision: nextRevision, id, fontSize: 80 });
  assert.equal(host.snapshot().editor.revision, nextRevision, 'unchanged size does not add history');
  await host.stop();
  const stored = JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'));
  assert.deepEqual(stored.widgets, expected.instances);
});

test('builder group edits are atomic, undoable and reject stale revisions without changing gameplay', async t => {
  const { host, handlers, eventFor } = await hostFixture(t);
  const panel = await host.open();
  const command = (name, payload) => handlers.get('companion:command')(eventFor(panel), name, payload);
  const initial = structuredClone(host.snapshot().state.widgets.instances);
  const items = initial.slice(0, 2).map(widget => ({ id: widget.id, x: widget.position.x + 80, y: widget.position.y - 40, ...widget.size }));
  assert.equal((await command('widget.layout', { revision: 0, items })).ok, true);
  assert.deepEqual(host.snapshot().editor, { revision: 1, canUndo: true, canRedo: false });
  const moved = structuredClone(host.snapshot().state.widgets.instances);
  assert.equal(moved[0].position.x, initial[0].position.x + 80);
  assert.equal(moved[1].position.x, initial[1].position.x + 80);
  assert.equal(host.snapshot().state.gameplay.state, 'menu');
  assert.equal(host.snapshot().state.nowPlaying, null);
  assert.equal((await command('widget.layout', { revision: 0, items })).code, 'STALE_REVISION');
  assert.deepEqual(host.snapshot().state.widgets.instances, moved);
  await command('widget.layout', { revision: 1, items });
  assert.equal(host.snapshot().editor.revision, 1, 'no-op does not create a new action');
  await command('editor.undo');
  assert.deepEqual(host.snapshot().state.widgets.instances, initial);
  assert.deepEqual(host.snapshot().editor, { revision: 2, canUndo: false, canRedo: true });
  await command('editor.redo');
  assert.deepEqual(host.snapshot().state.widgets.instances, moved);
  await command('editor.undo');
  await command('widget.enabled', { id: 'song-title', enabled: false });
  assert.equal(host.snapshot().editor.canRedo, false, 'new edit discards previous redo branch');
  const revision = host.snapshot().editor.revision;
  await command('editor.redo');
  assert.equal(host.snapshot().editor.revision, revision, 'empty redo is a no-op');
});

test('builder visibility updates native overlay and geometry survives a flushed settings reload', async t => {
  const fs = require('node:fs/promises');
  const { host, handlers, eventFor, directory } = await hostFixture(t);
  const panel = await host.open();
  const command = (name, payload) => handlers.get('companion:command')(eventFor(panel), name, payload);
  for (const widget of host.snapshot().state.widgets.instances.slice(1)) await command('widget.enabled', { id: widget.id, enabled: false });
  await host.setOverlay(true);
  host.integration.transition('playing');
  await new Promise(resolve => setImmediate(resolve));
  const overlay = host.getOverlay();
  assert.equal(overlay.visible, true);
  await command('widget.visibility', { revision: host.snapshot().editor.revision, id: 'song-title', game: true, gameplayVisibility: ['paused'] });
  assert.equal(overlay.visible, false, 'playing visibility obeys its checkbox');
  host.integration.transition('paused');
  assert.equal(overlay.visible, true);
  await command('widget.visibility', { revision: host.snapshot().editor.revision, id: 'song-title', game: false, gameplayVisibility: ['paused'] });
  assert.equal(overlay.visible, false, 'game destination can be hidden independently');
  const item = { id: 'song-title', x: 176, y: 96, width: 600, height: 72 };
  assert.equal((await handlers.get('companion:command')(eventFor(overlay), 'widget.layout', { revision: host.snapshot().editor.revision, items: [item] })).ok, false);
  await command('widget.layout', { revision: host.snapshot().editor.revision, items: [item] });
  await host.stop();
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'));
  const { SettingsRepository } = await import('../companion/dist/storage/SettingsRepository.js');
  const loaded = await new SettingsRepository(path.join(directory, 'settings.json'), []).load();
  assert.deepEqual(saved, loaded);
  const title = loaded.widgets.find(widget => widget.id === 'song-title');
  assert.deepEqual(title.position, { x: 176, y: 96 });
  assert.deepEqual(title.size, { width: 600, height: 72 });
  assert.deepEqual(title.gameplayVisibility, ['paused']);
  assert.deepEqual(title.visibility, { game: false, stream: false });
});

test('themes and geometry share one chronological history while presets preserve widget overrides', async t => {
  const { host, handlers, eventFor } = await hostFixture(t);
  const panel = await host.open();
  const command = (name, payload = {}) => handlers.get('companion:command')(eventFor(panel), name, { revision: host.snapshot().editor.revision, ...payload });
  const history = name => handlers.get('companion:command')(eventFor(panel), name);
  const original = structuredClone(host.snapshot().state);
  assert.equal((await command('theme.preset', { id: 'neon' })).ok, true);
  assert.equal(host.snapshot().state.theme.presetId, 'neon');
  assert.deepEqual(host.snapshot().state.widgets, original.widgets);
  const item = { id: 'song-title', x: 80, y: 120, width: 600, height: 60 };
  await command('widget.layout', { items: [item] });
  await history('editor.undo');
  assert.deepEqual(host.snapshot().state.widgets, original.widgets);
  assert.equal(host.snapshot().state.theme.presetId, 'neon');
  await history('editor.undo');
  assert.deepEqual(host.snapshot().state.theme, original.theme);
  await history('editor.redo');
  await history('editor.redo');
  assert.deepEqual(host.snapshot().state.widgets.instances[0].position, { x: 80, y: 120 });
  const before = host.snapshot().state.widgets.instances[0].style;
  await command('widget.appearance', { id: 'song-title', style: { ...before, colorMode: 'custom', color: 'rgba(255, 79, 216, 0.5)' } });
  const appearance = structuredClone(host.snapshot().state.widgets.instances[0].style);
  await command('theme.preset', { id: 'light' });
  assert.deepEqual(host.snapshot().state.widgets.instances[0].style, appearance);
  assert.deepEqual(host.snapshot().state.widgets.instances[0].position, { x: 80, y: 120 });
  assert.equal(host.snapshot().state.gameplay.state, 'menu');
  assert.equal(host.snapshot().state.nowPlaying, null);
});

test('theme payloads reject stale or unsafe changes and persist canonical colors and effects', async t => {
  const fs = require('node:fs/promises');
  const { host, handlers, eventFor, directory } = await hostFixture(t);
  const panel = await host.open();
  const command = (name, payload = {}) => handlers.get('companion:command')(eventFor(panel), name, { revision: host.snapshot().editor.revision, ...payload });
  const { normalizeColor } = await import('../companion/dist/themes/normalizeColor.js');
  await command('theme.color', { token: 'text', color: 'hsl(120 100% 50% / 50%)' });
  assert.equal(host.snapshot().state.theme.colors.text, normalizeColor('hsl(120 100% 50% / 50%)'));
  const expected = structuredClone(host.snapshot().state.theme);
  const revision = host.snapshot().editor.revision;
  assert.equal((await command('theme.color', { revision: 0, token: 'text', color: '#fff' })).code, 'STALE_REVISION');
  for (const [name, payload] of [
    ['theme.color', { token: 'text', color: 'url(https://invalid.test)' }],
    ['theme.effects', { effects: { glow: { enabled: true, blur: Infinity } } }],
    ['theme.effects', { effects: { gradient: { from: 'var(--unsafe)' } } }],
    ['widget.appearance', { id: 'song-title', style: { fontSize: 10000 } }],
    ['widget.appearance', { id: 'song-title', style: { glow: { enabled: true, blur: 8, color: 'expression(x)' } } }]
  ]) assert.equal((await command(name, payload)).ok, false);
  assert.equal(host.snapshot().editor.revision, revision);
  assert.deepEqual(host.snapshot().state.theme, expected);
  await command('theme.effects', { effects: { glow: { enabled: true, blur: 12 }, gradient: { enabled: true, from: '#00ffff', to: '#ff00ff', angle: 45 } } });
  await host.setOverlay(true);
  const overlay = host.getOverlay();
  assert.equal((await handlers.get('companion:command')(eventFor(overlay), 'theme.preset', { revision: host.snapshot().editor.revision, id: 'light' })).ok, false);
  await host.stop();
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'));
  assert.equal(saved.version, 3);
  assert.deepEqual(saved.theme, host.snapshot().state.theme);
  assert.equal(saved.theme.effects.gradient.angle, 45);
  assert.equal(saved.theme.effects.glow.enabled, true);
});

test('host concurrent open requests share a single panel', async t => {
  const { host, windows } = await hostFixture(t);
  const [first, second] = await Promise.all([host.open(), host.open()]);
  assert.equal(first, second);
  assert.equal(windows.length, 1);
  assert.equal(first.visible, true);
});

test('host immediate panel close and reopen leaves services connected', async t => {
  const { host } = await hostFixture(t);
  const first = await host.open();
  first.destroy();
  const second = await host.open();
  assert.notEqual(second, first);
  assert.equal(second.visible, true);
  assert.equal(host.snapshot().state.serviceHealth.cloneHero.status, 'running');
  assert.equal((await host.integration.getGameplayState()).state, 'menu');
});

test('all host stop callers wait for the same pending disconnect', async t => {
  const { host } = await hostFixture(t);
  await host.open();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const originalDisconnect = host.integration.disconnect.bind(host.integration);
  host.integration.disconnect = async () => { await gate; await originalDisconnect(); };
  let firstFinished = false, secondFinished = false;
  const first = host.stop().then(() => { firstFinished = true; });
  const second = host.stop().then(() => { secondFinished = true; });
  await new Promise(resolve => setImmediate(resolve));
  const early = { firstFinished, secondFinished };
  release();
  await Promise.all([first, second]);
  assert.deepEqual(early, { firstFinished: false, secondFinished: false });
});

test('actual overlay visibility follows gameplay and its frame cannot issue control commands', async t => {
  const { host, handlers, eventFor } = await hostFixture(t);
  const panel = await host.open();
  await host.setOverlay(true);
  const overlay = host.getOverlay();
  const snapshot = handlers.get('companion:snapshot');
  const command = handlers.get('companion:command');
  assert.equal(overlay.visible, false, 'menu is hidden');
  host.integration.transition('playing');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(overlay.visible, true, 'playing is visible');
  host.integration.transition('paused');
  assert.equal(overlay.visible, true, 'paused stays visible');
  assert.ok(snapshot(eventFor(overlay)).state);
  assert.equal((await command(eventFor(overlay), 'mock.state', { state: 'menu' })).ok, false);
  assert.equal(host.snapshot().state.gameplay.state, 'paused');
  assert.equal((await command(eventFor(panel), 'mock.state', { state: 'results' })).ok, true);
  assert.equal(overlay.visible, false, 'results hides immediately');
  host.integration.transition('playing');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(overlay.visible, true);
  host.integration.transition('menu');
  assert.equal(overlay.visible, false, 'return to menu hides synchronously');
  assert.equal(snapshot({ sender: {}, senderFrame: panel.webContents.mainFrame }), null);
});

test('overlay becomes visible when Chromium finishes loading after loadURL resolves', async t => {
  const { host, windows } = await hostFixture(t);
  await host.open();
  host.integration.transition('paused');
  const prototype = Object.getPrototypeOf(windows[0]);
  const load = prototype.loadURL;
  prototype.loadURL = async function (url) { await load.call(this, url); if (url.endsWith('overlay.html')) this.webContents.isLoading = () => true; };
  await host.setOverlay(true);
  const overlay = host.getOverlay();
  assert.equal(overlay.visible, false);
  overlay.webContents.isLoading = () => false;
  overlay.webContents.emit('did-stop-loading');
  assert.equal(overlay.visible, true);
});

test('stream command routing only allows known destinations and bounded setting routes', () => {
  const ids = ['song-title'];
  const item = { id: ids[0], x: 0, y: 0, width: 100, height: 50 };
  assert.equal(validCommand('widget.layout', { revision: 0, destination: 'stream', items: [item] }, ids), true);
  assert.equal(validCommand('widget.layout', { revision: 0, destination: 'remote', items: [item] }, ids), false);
  assert.equal(validCommand('widget.visibility', { revision: 0, id: ids[0], game: false, stream: true, gameplayVisibility: ['playing'] }, ids), true);
  assert.equal(validCommand('widget.visibility', { revision: 0, id: ids[0], game: true, stream: 'yes', gameplayVisibility: [] }, ids), false);
  assert.equal(validCommand('stream.enabled', { enabled: true }, ids), true);
  assert.equal(validCommand('stream.enabled', { enabled: true, host: '0.0.0.0' }, ids), false);
  assert.equal(validCommand('stream.copyUrl', {}, ids), true);
  assert.equal(validCommand('stream.copyUrl', { url: 'https://unexpected.test/' }, ids), false);
  assert.equal(validCommand('stream.settings', { revision: 0, settings: { port: 40000, canvas: {}, layout: [] } }, ids), true);
  assert.equal(validCommand('stream.settings', { revision: 0, settings: { root: 'C:/' } }, ids), false);
  assert.equal(validCommand('stream.settings', { revision: -1, settings: {} }, ids), false);
});

test('stream layout and visibility remain independent, undo together, and persist in version 3', async t => {
  const { host, handlers, eventFor, directory } = await hostFixture(t);
  const panel = await host.open();
  const command = (name, payload) => handlers.get('companion:command')(eventFor(panel), name, payload);
  const edit = (name, payload) => command(name, { revision: host.snapshot().editor.revision, ...payload });
  const initial = structuredClone(host.snapshot().state);
  const item = { id: 'song-title', x: 360, y: 100, width: 700, height: 80 };
  assert.equal((await edit('widget.layout', { destination: 'stream', items: [item] })).ok, true);
  assert.deepEqual(host.snapshot().state.widgets, initial.widgets);
  assert.deepEqual(host.snapshot().state.stream.layout[0], item);
  await edit('widget.visibility', { id: item.id, game: false, stream: true, gameplayVisibility: ['playing', 'paused'] });
  assert.deepEqual(host.snapshot().state.widgets.instances[0].visibility, { game: false, stream: true });
  const configured = structuredClone(host.snapshot().state);
  await command('editor.undo');
  assert.deepEqual(host.snapshot().state.widgets.instances[0].visibility, initial.widgets.instances[0].visibility);
  assert.deepEqual(host.snapshot().state.stream.layout[0], item);
  await command('editor.undo');
  assert.deepEqual(host.snapshot().state.stream, initial.stream);
  await command('editor.redo'); await command('editor.redo');
  assert.deepEqual(host.snapshot().state.stream, configured.stream);
  assert.deepEqual(host.snapshot().state.widgets, configured.widgets);
  const revision = host.snapshot().editor.revision;
  assert.equal((await command('stream.settings', { revision: 0, settings: configured.stream })).code, 'STALE_REVISION');
  assert.equal((await edit('stream.settings', { settings: { ...configured.stream, canvas: { width: 0, height: 1080, fps: 60 } } })).ok, false);
  assert.equal(host.snapshot().editor.revision, revision);
  const next = { ...configured.stream, canvas: { width: 1920, height: 1080, fps: 30 } };
  assert.equal((await edit('stream.settings', { settings: next })).ok, true);
  assert.deepEqual(host.snapshot().state.widgets, configured.widgets);
  await host.saveSettings();
  const saved = JSON.parse(await require('node:fs/promises').readFile(path.join(directory, 'settings.json'), 'utf8'));
  assert.equal(saved.version, 3); assert.deepEqual(saved.stream, next);
  assert.equal(host.snapshot().state.gameplay.state, 'menu');
});

async function reservePort() {
  const server = require('node:net').createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

test('stream host preserves its local URL, restricts control IPC and stops on panel closure', async t => {
  const { host, handlers, eventFor, copied, directory } = await hostFixture(t);
  let panel = await host.open();
  const command = (name, payload) => handlers.get('companion:command')(eventFor(panel), name, payload);
  const edit = (settings) => command('stream.settings', { revision: host.snapshot().editor.revision, settings });
  assert.deepEqual(host.snapshot().stream, { enabled: false, url: null, clients: 0, error: null });
  assert.equal((await command('stream.copyUrl')).ok, false);
  const allocation = await reservePort(); await allocation.close();
  await edit({ ...host.snapshot().state.stream, port: allocation.port });
  assert.equal((await command('stream.enabled', { enabled: true })).ok, true);
  const firstUrl = host.snapshot().stream.url;
  assert.equal(new URL(firstUrl).hostname, '127.0.0.1');
  assert.match(new URL(firstUrl).searchParams.get('token'), /^[a-f0-9]{64}$/);
  const key = (await require('node:fs/promises').readFile(path.join(directory, 'stream-access.key'), 'utf8')).trim();
  assert.equal(new URL(firstUrl).searchParams.get('token'), key);
  assert.equal((await command('stream.copyUrl', {})).ok, true); assert.equal(copied.at(-1), firstUrl);
  assert.equal((await fetch(firstUrl)).status, 200);
  await host.setOverlay(true);
  assert.equal((await handlers.get('companion:command')(eventFor(host.getOverlay()), 'stream.enabled', { enabled: false })).ok, false);
  const revision = host.snapshot().editor.revision;
  assert.equal((await edit({ ...host.snapshot().state.stream, port: allocation.port === 65535 ? 65534 : allocation.port + 1 })).ok, false);
  assert.equal((await command('editor.undo')).ok, false, 'undo cannot silently change the running server port');
  assert.equal(host.snapshot().editor.revision, revision);
  assert.equal(host.snapshot().editor.canUndo, true, 'rejected undo preserves history');
  await edit({ ...host.snapshot().state.stream, canvas: { width: 1920, height: 1080, fps: 30 } });
  assert.equal(host.snapshot().stream.url, firstUrl);
  await command('stream.enabled', { enabled: false });
  assert.equal(host.snapshot().stream.enabled, false);
  assert.equal((await command('stream.enabled', { enabled: true })).ok, true);
  assert.equal(host.snapshot().stream.url, firstUrl);
  panel.destroy(); await host.stop();
  assert.equal(host.snapshot().stream.enabled, false);
  panel = await host.open();
  assert.equal(host.snapshot().stream.enabled, false, 'opening the panel never starts broadcasting automatically');
  await command('stream.enabled', { enabled: true });
  assert.equal(host.snapshot().stream.url, firstUrl);
});

test('an occupied stream port leaves gameplay usable and can recover on the same port', async t => {
  const { host, handlers, eventFor } = await hostFixture(t);
  const panel = await host.open();
  const command = (name, payload) => handlers.get('companion:command')(eventFor(panel), name, payload);
  const allocation = await reservePort();
  try {
    await command('stream.settings', { revision: host.snapshot().editor.revision, settings: { ...host.snapshot().state.stream, port: allocation.port } });
    assert.equal((await command('stream.enabled', { enabled: true })).ok, false);
    assert.equal(host.snapshot().stream.enabled, false);
    assert.ok(host.snapshot().stream.error);
    assert.equal((await command('mock.state', { state: 'playing' })).ok, true);
    assert.equal(host.snapshot().state.gameplay.state, 'playing');
  } finally { await allocation.close(); }
  assert.equal((await command('stream.enabled', { enabled: true })).ok, true);
  assert.equal(host.snapshot().stream.error, null);
});

test('library IPC accepts bounded queries and never accepts a renderer-selected filesystem path', () => {
  const valid = (command, payload) => validCommand(command, payload, []);
  assert.equal(valid('library.chooseRoot', {}), true);
  assert.equal(valid('library.chooseRoot', { path: 'C:\\Songs' }), false);
  assert.equal(valid('library.settings', { watch: true, refreshOnStart: false }), true);
  assert.equal(valid('library.settings', { watch: true, refreshOnStart: false, rootPath: 'C:\\' }), false);
  assert.equal(valid('library.scan', { mode: 'quick' }), true);
  assert.equal(valid('library.scan', { mode: 'other' }), false);
  assert.equal(valid('library.cancel', {}), true);
  const query = { query: 'étoile', sort: 'title', offset: 0, limit: 50 };
  assert.equal(valid('library.query', query), true);
  assert.equal(valid('library.query', { ...query, offset: 1_000_001 }), true);
  for (const audio of ['all', 'missing', 'present', 'unknown']) assert.equal(valid('library.query', { ...query, audio, duplicates: 'possible' }), true);
  for (const patch of [{ audio: 'invalid' }, { duplicates: 'invalid' }, { audio: true }, { duplicates: [] }]) assert.equal(valid('library.query', { ...query, ...patch }), false);
  for (const patch of [{ query: 'a'.repeat(201) }, { query: null }, { offset: -1 }, { offset: Infinity }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { limit: 101 }, { limit: 0 }, { sort: 'path' }, { path: 'C:\\' }]) assert.equal(valid('library.query', { ...query, ...patch }), false);
  assert.equal(valid('library.openFolder', { id: 'a'.repeat(64) }), true);
  for (const payload of [{ id: '../outside' }, { id: 'a'.repeat(64), path: 'C:\\' }, { id: 'https://example.com/' }]) assert.equal(valid('library.openFolder', payload), false);
});

test('library host indexes only the native picker result, paginates IPC and opens only known song folders', async t => {
  const fs = require('node:fs/promises');
  const { host, handlers, eventFor, directory, dialog, opened } = await hostFixture(t);
  const songs = path.join(directory, 'Songs');
  const song = path.join(songs, 'Example');
  await fs.mkdir(song, { recursive: true });
  await fs.writeFile(path.join(song, 'notes.chart'), '[Song]\n{\n Name = "Fixture"\n Artist = "Band"\n}\n');
  await fs.writeFile(path.join(song, 'song.ini'), '[song]\nname = Fixture\nartist = Band\ncharter = Local\n');
  let panel = await host.open();
  const command = (name, payload) => handlers.get('companion:command')(eventFor(panel), name, payload);
  const waitScan = async () => {
    const deadline = Date.now() + 5000;
    while (host.snapshot().library.status === 'scanning' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(host.snapshot().library.status, 'ready', JSON.stringify(host.snapshot().library));
  };
  assert.equal((await command('library.chooseRoot', {})).ok, true);
  assert.equal(host.snapshot().library.settings.rootPath, null, 'cancelled dialog leaves library untouched');
  dialog.showOpenDialog = async owner => { assert.equal(owner, panel); return { canceled: false, filePaths: [songs] }; };
  assert.equal((await command('library.chooseRoot', {})).ok, true);
  await waitScan();
  assert.equal(host.snapshot().library.count, 1);
  assert.equal(host.snapshot().library.items, undefined, 'full index is not broadcast in snapshots');
  const result = await command('library.query', { query: 'band', sort: 'title', offset: 0, limit: 50 });
  assert.equal(result.ok, true); assert.equal(result.result.total, 1);
  assert.equal(result.result.items[0].title, 'Fixture');
  assert.equal(result.result.items[0].audio, 'missing');
  assert.equal((await command('library.openFolder', { id: result.result.items[0].id })).ok, true);
  assert.equal(opened.at(-1), await fs.realpath(song));
  assert.equal((await command('library.openFolder', { id: '0'.repeat(64) })).ok, false);
  assert.equal(opened.length, 1);
  await host.setOverlay(true);
  assert.equal((await handlers.get('companion:command')(eventFor(host.getOverlay()), 'library.query', { query: '', sort: 'title', offset: 0, limit: 50 })).ok, false);
  assert.equal((await command('library.settings', { watch: false, refreshOnStart: false })).ok, true);
  panel.destroy(); await host.stop();
  panel = await host.open();
  assert.equal(host.snapshot().library.count, 1);
  assert.equal(host.snapshot().library.status, 'ready');
  assert.equal(host.snapshot().state.nowPlaying, null, 'a library scan never simulates a song playing');
});

test('closing the panel during the library picker rejects its late result', async t => {
  const { host, handlers, eventFor, dialog, directory } = await hostFixture(t);
  const panel = await host.open();
  let settle;
  dialog.showOpenDialog = () => new Promise(resolve => { settle = resolve; });
  const pending = handlers.get('companion:command')(eventFor(panel), 'library.chooseRoot', {});
  panel.destroy(); await host.stop();
  settle({ canceled: false, filePaths: [directory] });
  assert.equal((await pending).ok, false);
  assert.equal(host.snapshot().library.settings.rootPath, null);
});

test('stopping while the library starts cannot create a late panel', async t => {
  const { host, windows } = await hostFixture(t);
  let release, entered;
  const entry = new Promise(resolve => { entered = resolve; });
  const originalStart = host.library.start;
  host.library.start = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  const opening = host.open();
  await entry;
  await host.stop();
  release();
  assert.equal(await opening, null);
  assert.equal(windows.length, 0, 'the cancelled open creates no window');
  host.library.start = originalStart;
  assert.ok(await host.open(), 'a later user open still works');
});

const catalogueSearch = patch => ({ query: '', artist: '', charter: '', genre: '', year: '', instrument: '', difficulty: '', verified: 'all', installed: 'all', page: 1, ...patch });

test('download IPC rejects renderer paths, arbitrary endpoints and malformed job identities', () => {
  const id = '12345678-1234-4123-8123-123456789abc';
  assert.equal(validCommand('downloads.chooseRoot', undefined, []), true);
  assert.equal(validCommand('downloads.chooseRoot', { path: 'C:\\secret' }, []), false);
  assert.equal(validCommand('downloads.enqueue', { chartId: 'drive:root:song' }, []), true);
  for (const payload of [{ chartId: 'drive:root:song', endpoint: '/api/charts/anything' }, { chartId: 'https://other.test/' }, { chartId: '' }, { chartId: 'a'.repeat(513) }]) assert.equal(validCommand('downloads.enqueue', payload, []), false);
  for (const action of ['pause', 'resume', 'cancel', 'retry', 'remove', 'openFolder']) {
    assert.equal(validCommand(`downloads.${action}`, { id }, []), true);
    for (const payload of [{ id: '../song' }, { id, path: 'C:\\secret' }, { id: 'a'.repeat(32) }, {}]) assert.equal(validCommand(`downloads.${action}`, payload, []), false);
  }
});

test('download host chooses native folders, authorizes catalogue IDs and pauses on shutdown', async t => {
  const fs = require('node:fs/promises');
  const remote = { id: 'drive:rootFolder123:songFolder123', title: 'Download fixture', artist: 'Band', charter: 'Creator', downloadEndpoint: '/api/charts/12345678-1234-4123-8123-123456789abc/songFolder123/download-manifest', viewUrl: 'https://chartshub.ca/index.html?chart=drive%3ArootFolder123%3AsongFolder123&share=2' };
  let demo = false, transfers = 0, discarded = 0, calls = [];
  const worker = {
    run: async options => {
      transfers++; calls.push(options);
      options.onProgress({ receivedBytes: 5, totalBytes: 10, completedFiles: 0, totalFiles: 1, currentFile: 'notes.chart' });
      await new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(Error('Paused'), { name: 'AbortError' }));
        if (options.signal.aborted) fail(); else options.signal.addEventListener('abort', fail, { once: true });
      });
    },
    async discard() { discarded++; }, async resolveCompleted({ destination }) { return destination; }
  };
  const f = await hostFixture(t, { catalogueClient: { async load() { return { items: [remote], demo }; }, async artwork() { return null; } }, downloadWorker: worker });
  const folder = path.join(f.directory, 'Downloads'); await fs.mkdir(folder);
  const panel = await f.host.open();
  const command = (name, payload) => f.handlers.get('companion:command')(f.eventFor(panel), name, payload);
  assert.equal(transfers, 0);
  assert.equal((await command('downloads.enqueue', { chartId: remote.id })).ok, false);
  await command('catalogue.search', catalogueSearch());
  assert.deepEqual(await command('downloads.enqueue', { chartId: remote.id }), { ok: true, cancelled: true });
  assert.equal(f.host.snapshot().downloads.items.length, 0);
  f.dialog.showOpenDialog = async (_owner, options) => { assert.ok(options.properties.includes('openDirectory')); return { canceled: false, filePaths: [folder] }; };
  const added = await command('downloads.enqueue', { chartId: remote.id });
  assert.equal(added.ok, true); const id = added.result.id;
  for (let attempts = 0; attempts < 100 && !transfers; attempts++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(transfers, 1); assert.equal(calls[0].endpoint, remote.downloadEndpoint); assert.equal(calls[0].rootPath, folder);
  assert.ok(!JSON.stringify(f.host.snapshot()).includes('download-manifest'), 'private endpoint never reaches renderer snapshots');
  assert.equal((await command('downloads.enqueue', { chartId: remote.id })).result.id, id);
  await command('downloads.pause', { id }); assert.equal(f.host.snapshot().downloads.items[0].state, 'Paused');
  await command('downloads.resume', { id });
  for (let attempts = 0; attempts < 100 && transfers < 2; attempts++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(transfers, 2);
  await f.host.setOverlay(true);
  assert.equal((await f.handlers.get('companion:command')(f.eventFor(f.host.getOverlay()), 'downloads.cancel', { id })).ok, false);
  panel.destroy(); await f.host.stop();
  assert.equal(f.host.snapshot().downloads.items[0].state, 'Paused');
  const reopened = await f.host.open();
  const resumedCommand = (name, payload) => f.handlers.get('companion:command')(f.eventFor(reopened), name, payload);
  assert.equal(transfers, 2, 'reopening does not restart downloads');
  demo = true; await resumedCommand('catalogue.search', catalogueSearch());
  assert.equal((await resumedCommand('downloads.enqueue', { chartId: remote.id })).ok, false);
  await resumedCommand('downloads.cancel', { id });
  assert.equal(f.host.snapshot().downloads.items[0].state, 'Cancelled'); assert.equal(discarded, 1);
  await resumedCommand('downloads.remove', { id }); assert.equal(f.host.snapshot().downloads.items.length, 0);
});

test('closing the panel while a download folder dialog is pending discards its late result', async t => {
  const f = await hostFixture(t); const fs = require('node:fs/promises');
  const folder = path.join(f.directory, 'Downloads'); await fs.mkdir(folder);
  const panel = await f.host.open(); let finish;
  f.dialog.showOpenDialog = () => new Promise(resolve => { finish = resolve; });
  const selecting = f.handlers.get('companion:command')(f.eventFor(panel), 'downloads.chooseRoot');
  panel.destroy(); await f.host.stop();
  finish({ canceled: false, filePaths: [folder] });
  assert.equal((await selecting).ok, false);
  assert.equal(f.host.snapshot().downloads.rootPath, null);
});

test('real Companion worker and queue deliver verified files through catalogue commands without touching the library', async t => {
  const fs = require('node:fs/promises'), crypto = require('node:crypto');
  const { createDownloadWorker } = require('../companion/download-worker.cjs');
  const endpoint = '/api/charts/12345678-1234-4123-8123-123456789abc/songFolder123/download-manifest';
  const prefix = endpoint.replace('download-manifest', 'files/');
  const content = [Buffer.from('[Song]\n{ Name = "Queue fixture" }\n'), Buffer.from('synthetic audio bytes')];
  const manifest = { title: 'Queue fixture', artist: 'Fixture artist', files: content.map((bytes, index) => ({ parts: [index ? 'song.ogg' : 'notes.chart'], size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), url: prefix + 'fixtureFile' + index })) };
  let requests = 0;
  const worker = createDownloadWorker({ fetcher: async (url, options) => {
    requests++; assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    if (url === 'https://chartshub.ca' + endpoint) return new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } });
    const index = manifest.files.findIndex(file => url === 'https://chartshub.ca' + file.url); assert.ok(index >= 0);
    return new Response(content[index], { headers: { 'content-length': String(content[index].length) } });
  } });
  const remote = { id: 'drive:root:download', title: 'Queue fixture', artist: 'Fixture artist', charter: '', downloadEndpoint: endpoint, viewUrl: 'https://chartshub.ca/index.html?chart=drive%3Aroot%3Adownload&share=2' };
  const f = await hostFixture(t, { catalogueClient: { async load() { return { items: [remote], demo: false }; } }, downloadWorker: worker });
  const folder = path.join(f.directory, 'Downloads'); await fs.mkdir(folder);
  f.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  const panel = await f.host.open(), initial = structuredClone(f.host.snapshot().state);
  const command = (name, payload) => f.handlers.get('companion:command')(f.eventFor(panel), name, payload);
  await command('catalogue.search', catalogueSearch());
  assert.equal(requests, 0);
  const added = await command('downloads.enqueue', { chartId: remote.id }); assert.equal(added.ok, true);
  for (let attempt = 0; attempt < 400 && !['Completed', 'Failed'].includes(f.host.snapshot().downloads.items[0]?.state); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  const completed = f.host.snapshot().downloads.items[0]; assert.equal(completed.state, 'Completed', completed.error);
  assert.equal(requests, 3);
  for (const [index, file] of manifest.files.entries()) assert.deepEqual(await fs.readFile(path.join(completed.destination, ...file.parts)), content[index]);
  assert.equal((await command('downloads.openFolder', { id: completed.id })).ok, true);
  assert.deepEqual(f.opened, [completed.destination]);
  assert.equal(f.host.snapshot().library.count, 0); assert.equal(f.host.snapshot().library.settings.rootPath, null);
  assert.deepEqual(f.host.snapshot().state, initial);
  assert.equal((await command('downloads.remove', { id: completed.id })).ok, true);
  assert.equal(f.host.snapshot().downloads.items.length, 0);
  assert.equal((await fs.stat(completed.destination)).isDirectory(), true, 'removing history retains the completed chart');
});
test('catalogue IPC permits only bounded filters, known identifiers and explicit association contexts', () => {
  const valid = (name, payload) => validCommand(name, payload, []);
  assert.equal(valid('catalogue.search', catalogueSearch()), true);
  for (const patch of [{ query: 'a'.repeat(201) }, { query: 'a\nb' }, { page: 0 }, { page: Infinity }, { verified: true }, { installed: 'sure' }, { url: 'https://other.test/' }]) assert.equal(valid('catalogue.search', catalogueSearch(patch)), false);
  assert.equal(valid('catalogue.refresh', {}), true);
  assert.equal(valid('catalogue.refresh', { url: 'https://other.test/' }), false);
  assert.equal(valid('catalogue.candidates', { localId: 'a'.repeat(64) }), true);
  assert.equal(valid('catalogue.open', { chartId: 'drive:folder:chart' }), true);
  assert.equal(valid('catalogue.open', { chartId: 'https://other.test/' }), false);
  const link = { localId: 'a'.repeat(64), chartId: 'drive:folder:chart', contextId: 'b'.repeat(32) };
  assert.equal(valid('catalogue.link', link), true);
  assert.equal(valid('catalogue.link', { ...link, contextId: '' }), false);
  assert.equal(valid('catalogue.link', { ...link, verified: true }), false);
  assert.equal(valid('catalogue.unlink', { localId: link.localId, contextId: link.contextId }), true);
});

test('catalogue host stays offline until requested, scopes artwork and links, and isolates gameplay', async t => {
  const fs = require('node:fs/promises');
  const remote = { id: 'drive:rootFolder123:chartFolder123', title: 'Fixture', artist: 'Band', charter: 'Local', verified: true, album: '', genre: 'Rock', year: '2020', instruments: ['Guitar'], difficulties: ['Expert'], instrumentDifficulties: { Guitar: ['Expert'] }, contentHash: null,
    artworkUrl: 'https://chartshub.ca/api/charts/12345678-1234-1234-1234-123456789abc/chartFolder123/cover', viewUrl: 'https://chartshub.ca/index.html?chart=drive%3ArootFolder123%3AchartFolder123&share=2' };
  let requests = 0, imageRequests = 0;
  const catalogueClient = {
    async load() { requests++; return { items: [remote], revision: null, demo: false }; },
    async artwork(url) { imageRequests++; assert.equal(url, remote.artworkUrl); return { bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), contentType: 'image/png' }; }
  };
  const { host, handlers, eventFor, directory, openedUrls, protocolRequest } = await hostFixture(t, { catalogueClient });
  const songs = path.join(directory, 'Songs'), song = path.join(songs, 'Example');
  await fs.mkdir(song, { recursive: true });
  await fs.writeFile(path.join(song, 'notes.chart'), '[Song]\n{\nName="Fixture"\nArtist="Band"\nCharter="Local"\n}\n');
  const panel = await host.open();
  const command = (name, payload) => handlers.get('companion:command')(eventFor(panel), name, payload);
  const initial = structuredClone(host.snapshot().state);
  assert.equal(requests, 0, 'opening Companion must not contact ChartsHub');
  await host.library.selectRoot(songs);
  for (let attempt = 0; attempt < 100 && host.library.status().status === 'scanning'; attempt++) await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(host.library.status().status, 'ready');
  const localId = (await host.library.query()).items[0].id;
  const page = await command('catalogue.search', catalogueSearch());
  assert.equal(page.ok, true); assert.equal(page.result.items.length, 1); assert.equal(requests, 1);
  assert.equal(page.result.items[0].installed.status, 'candidate');
  assert.equal(host.snapshot().catalogue.items, undefined, 'no full remote index in broadcasts');
  assert.match(page.result.items[0].artworkUrl, /^chartshub-companion:\/\/app\/catalogue-artwork\/[a-f0-9]{64}$/);
  const artwork = await protocolRequest(page.result.items[0].artworkUrl);
  assert.equal(artwork.status, 200); assert.equal(artwork.headers.get('content-type'), 'image/png');
  assert.equal((await protocolRequest('chartshub-companion://app/catalogue-artwork/' + '0'.repeat(64))).status, 404);
  assert.equal((await protocolRequest(page.result.items[0].artworkUrl + '?url=https://other.test/')).status, 404);
  assert.equal((await protocolRequest(page.result.items[0].artworkUrl, 'POST')).status, 404);
  assert.equal(imageRequests, 1, 'invalid proxy requests never reach the network');
  const candidates = await command('catalogue.candidates', { localId });
  assert.equal(candidates.ok, true);
  const contextId = candidates.result.contextId;
  assert.equal((await command('catalogue.link', { localId, chartId: remote.id, contextId })).ok, true);
  const linked = await command('catalogue.search', catalogueSearch({ installed: 'linked' }));
  assert.equal(linked.result.total, 1);
  assert.equal(linked.result.items[0].installed.status, 'linked');
  assert.equal((await command('catalogue.open', { chartId: remote.id })).ok, true);
  assert.deepEqual(openedUrls, [remote.viewUrl]);
  assert.equal((await command('catalogue.open', { chartId: 'unknown' })).ok, false);
  assert.equal((await command('catalogue.unlink', { localId, contextId })).ok, true);
  await host.setOverlay(true);
  assert.equal((await handlers.get('companion:command')(eventFor(host.getOverlay()), 'catalogue.search', catalogueSearch())).ok, false);
  assert.deepEqual(host.snapshot().state, initial);
  panel.destroy(); await host.stop();
  await host.open(); assert.equal(requests, 1, 'reopening does not automatically reload the remote catalogue');
});

test('overlay profile and lock commands accept only named snapshots and known widget IDs', () => {
  const id = 'a1234567-1234-4123-8123-123456789abc';
  const common = { revision: 0, profilesRevision: 0 };
  assert.equal(validCommand('profile.save', { ...common, name: 'Jeu' }, []), true);
  assert.equal(validCommand('profile.save', { ...common, id, name: 'OBS' }, []), true);
  assert.equal(validCommand('profile.apply', { ...common, id }, []), true);
  assert.equal(validCommand('profile.delete', { profilesRevision: 0, id }, []), true);
  for (const payload of [{ ...common, name: '' }, { ...common, name: ' '.repeat(5) }, { ...common, name: 'x'.repeat(41) }, { ...common, name: 'bad\nname' }, { ...common, name: 'Jeu', document: {} }, { ...common, name: 'Jeu', id: '../profile' }, { ...common, name: 'Jeu', profilesRevision: -1 }]) assert.equal(validCommand('profile.save', payload, []), false);
  assert.equal(validCommand('profile.apply', { ...common, id, port: 45000 }, []), false);
  assert.equal(validCommand('profile.apply', { profilesRevision: 0, id }, []), false);
  assert.equal(validCommand('profile.delete', { profilesRevision: 0, id, filePath: 'anything' }, []), false);
  assert.equal(validCommand('widget.locked', { revision: 0, id: 'song-title', locked: true }, ['song-title']), true);
  for (const payload of [{ revision: 0, id: 'other', locked: true }, { revision: 0, id: 'song-title', locked: 1 }, { revision: -1, id: 'song-title', locked: false }, { revision: 0, id: 'song-title', locked: true, position: {} }]) assert.equal(validCommand('widget.locked', payload, ['song-title']), false);
});


test('locked widgets reject geometry through both layout routes, remain style-editable and persist', async t => {
  const fs = require('node:fs/promises');
  const { host, handlers, eventFor, directory } = await hostFixture(t);
  const panel = await host.open();
  const command = (name, payload) => handlers.get('companion:command')(eventFor(panel), name, payload);
  const revision = () => host.snapshot().editor.revision;
  const id = 'song-title';
  assert.equal((await command('widget.locked', { revision: revision(), id, locked: true })).ok, true);
  const initial = structuredClone(host.snapshot().state);
  const widget = initial.widgets.instances.find(item => item.id === id);
  const gameItem = { id, x: widget.position.x, y: widget.position.y, width: widget.size.width - 1, height: widget.size.height };
  const streamItem = { ...initial.stream.layout.find(item => item.id === id) }; streamItem.width--;
  assert.equal((await command('widget.layout', { revision: revision(), destination: 'game', items: [gameItem] })).code, 'WIDGET_LOCKED');
  assert.equal((await command('widget.layout', { revision: revision(), destination: 'stream', items: [streamItem] })).code, 'WIDGET_LOCKED');
  const badStream = structuredClone(initial.stream); badStream.layout = badStream.layout.map(item => item.id === id ? streamItem : item);
  assert.equal((await command('stream.settings', { revision: revision(), settings: badStream })).code, 'WIDGET_LOCKED');
  assert.deepEqual(host.snapshot().state, initial);
  assert.equal((await command('widget.fontSize', { revision: revision(), id, fontSize: 60 })).ok, true);
  assert.equal(host.snapshot().state.widgets.instances.find(item => item.id === id).locked, true);
  await command('editor.undo');
  assert.deepEqual(host.snapshot().state, initial);
  await command('editor.undo');
  assert.equal(host.snapshot().state.widgets.instances.find(item => item.id === id).locked, undefined);
  await command('editor.redo');
  await host.stop();
  const stored = JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'));
  assert.equal(stored.widgets.find(item => item.id === id).locked, true);
});


test('named overlay profiles restore a whole visual snapshot without restoring network settings or song data', async t => {
  const fs = require('node:fs/promises');
  const { host, handlers, eventFor, directory } = await hostFixture(t);
  const panel = await host.open();
  const command = (name, payload) => handlers.get('companion:command')(eventFor(panel), name, payload);
  const rev = () => ({ revision: host.snapshot().editor.revision, profilesRevision: host.snapshot().profiles.revision });
  await command('mock.state', { state: 'playing' });
  host.services.store.setState(state => ({ ...state, nowPlaying: { ...state.nowPlaying, charter: 'Chosen', charterSegments: [{ text: 'Chosen', color: '#123456' }] } }));
  await command('widget.locked', { revision: rev().revision, id: 'song-charter', locked: true });
  const original = structuredClone(host.snapshot().state);
  const result = await command('profile.save', { ...rev(), name: 'Jeu' });
  assert.equal(result.ok, true); const id = result.result.id;
  assert.equal(host.snapshot().profiles.activeId, id);
  assert.equal(host.snapshot().editor.revision, 1, 'saving a named copy does not edit the current layout');
  assert.equal(host.snapshot().profiles.items[0].document, undefined, 'saved documents stay outside renderer summaries');
  await command('widget.fontSize', { revision: rev().revision, id: 'song-title', fontSize: 80 });
  assert.equal(host.snapshot().profiles.activeId, null);
  await command('theme.preset', { revision: rev().revision, id: 'neon' });
  const stream = structuredClone(host.snapshot().state.stream);
  stream.port = 49371; stream.canvas.width = 1920; stream.canvas.height = 1080;
  stream.layout.find(item => item.id === 'song-title').width--;
  assert.equal((await command('stream.settings', { revision: rev().revision, settings: stream })).ok, true);
  const beforeApply = structuredClone(host.snapshot().state), applyRevision = rev().revision;
  assert.equal((await command('profile.apply', { ...rev(), id })).ok, true);
  const applied = host.snapshot().state;
  assert.deepEqual(applied.widgets, original.widgets); assert.deepEqual(applied.theme, original.theme);
  assert.deepEqual(applied.stream, { ...original.stream, port: stream.port });
  assert.deepEqual(applied.nowPlaying, beforeApply.nowPlaying); assert.deepEqual(applied.gameplay, beforeApply.gameplay);
  assert.equal(host.snapshot().editor.revision, applyRevision + 1, 'applying is one history action');
  await command('editor.undo'); assert.deepEqual(host.snapshot().state, beforeApply);
  await command('editor.redo'); assert.deepEqual(host.snapshot().state.widgets, original.widgets);
  assert.equal((await command('profile.apply', { ...rev(), revision: applyRevision, id })).code, 'STALE_REVISION');
  assert.equal((await command('profile.save', { ...rev(), id, name: 'Jeu personnel' })).ok, true);
  assert.equal(host.snapshot().profiles.items[0].name, 'Jeu personnel');
  assert.equal((await command('profile.delete', { profilesRevision: 0, id })).code, 'STALE_PROFILES');
  await host.setOverlay(true);
  assert.equal((await handlers.get('companion:command')(eventFor(host.getOverlay()), 'profile.apply', { ...rev(), id })).ok, false);
  const stored = await fs.readFile(path.join(directory, 'overlay-profiles.json'), 'utf8');
  assert.doesNotMatch(stored, /49371|38473|charterSegments|nowPlaying|filePath|stream-access|Chosen/);
  const stateBeforeDelete = structuredClone(host.snapshot().state);
  assert.equal((await command('profile.delete', { profilesRevision: rev().profilesRevision, id })).ok, true);
  assert.equal(host.snapshot().profiles.items.length, 0); assert.deepEqual(host.snapshot().state, stateBeforeDelete);
});


test('a queued profile application cannot overwrite a newer edit or survive panel closure', async t => {
  const { host, handlers, eventFor } = await hostFixture(t);
  const panel = await host.open();
  const command = (name, payload) => handlers.get('companion:command')(eventFor(panel), name, payload);
  const rev = () => ({ revision: host.snapshot().editor.revision, profilesRevision: host.snapshot().profiles.revision });
  const saved = await command('profile.save', { ...rev(), name: 'Jeu' });
  const apply = command('profile.apply', { ...rev(), id: saved.result.id });
  await command('widget.fontSize', { revision: rev().revision, id: 'song-title', fontSize: 80 });
  assert.equal((await apply).code, 'STALE_REVISION');
  assert.equal(host.snapshot().state.widgets.instances.find(widget => widget.id === 'song-title').style.fontSize, 80);
  const late = command('profile.apply', { ...rev(), id: saved.result.id });
  panel.destroy();
  assert.equal((await late).ok, false);
  assert.equal(host.snapshot().state.widgets.instances.find(widget => widget.id === 'song-title').style.fontSize, 80);
});


test('stopping Companion waits for an already requested profile save', async t => {
  const fs = require('node:fs/promises');
  const { host, handlers, eventFor, directory } = await hostFixture(t);
  const panel = await host.open();
  const rename = fs.rename; let entered = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(fs, 'rename', async function (source, target) {
    if (target === path.join(directory, 'overlay-profiles.json')) { entered = true; await gate; }
    return rename.call(fs, source, target);
  });
  const saving = handlers.get('companion:command')(eventFor(panel), 'profile.save', { revision: 0, profilesRevision: 0, name: 'Jeu' });
  try {
    const started = Date.now();
    while (!entered && Date.now() - started < 2000) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(entered, true);
    let stopped = false;
    const stopping = host.stop().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(stopped, false);
    release();
    assert.equal((await saving).ok, true); await stopping;
  } finally { release(); }
  const stored = JSON.parse(await fs.readFile(path.join(directory, 'overlay-profiles.json'), 'utf8'));
  assert.equal(stored.items[0].name, 'Jeu');
});


test('duplicate comparison IPC accepts only index identities and server comparison contexts', () => {
  const id = 'a'.repeat(64), contextId = 'b'.repeat(32);
  const valid = (name, payload) => validCommand(name, payload, []);
  assert.equal(valid('library.compareDuplicates', { id, revision: 1 }), true);
  for (const payload of [{ id }, { id, revision: -1 }, { id, revision: 1, path: 'C:\\private' }, { id: '../notes.chart', revision: 1 }, null]) assert.equal(valid('library.compareDuplicates', payload), false);
  for (const choice of [id, null]) assert.equal(valid('library.chooseDuplicate', { id: choice, contextId, revision: 1 }), true);
  for (const payload of [{ id, revision: 1 }, { id, contextId: 'unknown', revision: 1 }, { contextId, revision: 1 }, { id, contextId, revision: NaN }, { id, contextId, revision: 1, delete: true }, { id: '../notes.mid', contextId, revision: 1 }]) assert.equal(valid('library.chooseDuplicate', payload), false);
});


test('duplicate comparisons cross the worker and keep a durable preference without modifying Songs', async t => {
  const fs = require('node:fs/promises');
  const { host, handlers, eventFor, directory } = await hostFixture(t);
  const songs = path.join(directory, 'Songs'), original = new Map();
  for (const [name, content, extension] of [['A', '[Song]\n{}\n[ExpertSingle]\n{\n0 = N 0 0\n}', 'chart'], ['B', '[Song]\n{}\n[ExpertSingle]\n{\n0 = N 0 0\n}', 'chart'], ['C', '[Song]\n{}\n[ExpertSingle]\n{\n0 = N 1 0\n}', 'chart'], ['D', 'MThd', 'mid']]) {
    const folder = path.join(songs, name); await fs.mkdir(folder, { recursive: true });
    const filename = path.join(folder, 'notes.' + extension); await fs.writeFile(filename, content); original.set(filename, content);
    const ini = path.join(folder, 'song.ini'), metadata = '[song]\nname = Example\nartist = Band\ncharter = Creator\n';
    await fs.writeFile(ini, metadata); original.set(ini, metadata);
  }
  let panel = await host.open();
  const command = (name, payload) => handlers.get('companion:command')(eventFor(panel), name, payload);
  await host.library.selectRoot(songs);
  const deadline = Date.now() + 5000;
  while (host.library.status().status === 'scanning' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(host.library.status().status, 'ready');
  await host.library.configure({ refreshOnStart: false });
  const revision = host.library.status().revision, rows = (await host.library.query({ duplicates: 'possible' })).items;
  const selected = rows.find(item => item.relativePath === 'A/notes.chart');
  const compared = await command('library.compareDuplicates', { id: selected.id, revision });
  assert.equal(compared.ok, true, compared.error);
  assert.deepEqual(compared.result.summary, { total: 4, readable: 4, noteGroups: 3, identicalGroups: 1, unverified: 0 });
  assert.equal(compared.result.preferredId, null); assert.equal(compared.result.variants.find(item => item.id === selected.id).identicalCount, 2);
  assert.ok(!JSON.stringify(compared.result).includes(directory));
  const chosen = await command('library.chooseDuplicate', { contextId: compared.result.contextId, revision, id: selected.id });
  assert.equal(chosen.ok, true, chosen.error); assert.equal(chosen.result.preferredId, selected.id);
  const invalid = await command('library.chooseDuplicate', { contextId: compared.result.contextId, revision, id: 'f'.repeat(64) });
  assert.equal(invalid.ok, false);
  await host.setOverlay(true);
  assert.equal((await handlers.get('companion:command')(eventFor(host.getOverlay()), 'library.compareDuplicates', { id: selected.id, revision })).ok, false);
  panel.destroy(); await host.stop(); panel = await host.open();
  const reopened = await command('library.compareDuplicates', { id: selected.id, revision });
  assert.equal(reopened.ok, true, reopened.error); assert.equal(reopened.result.preferredId, selected.id);
  assert.equal((await command('library.chooseDuplicate', { contextId: compared.result.contextId, revision, id: null })).ok, false, 'old worker contexts cannot change the preference');
  const cleared = await command('library.chooseDuplicate', { contextId: reopened.result.contextId, revision, id: null });
  assert.equal(cleared.ok, true, cleared.error); assert.equal(cleared.result.preferredId, null);
  for (const [filename, bytes] of original) assert.equal(await fs.readFile(filename, 'utf8'), bytes);
  assert.deepEqual((await fs.readdir(songs)).sort(), ['A', 'B', 'C', 'D']);
  assert.equal(host.snapshot().state.nowPlaying, null);
});


test('cleanup IPC accepts only revision-bound plans and unique chart IDs', () => {
  const planId = 'a'.repeat(32), contextId = 'b'.repeat(32), keepId = 'c'.repeat(64), id = 'd'.repeat(64);
  const prepare = { contextId, revision: 1, keepId }, execute = { planId, revision: 1, ids: [id] };
  assert.equal(validCommand('library.prepareCleanup', prepare, []), true);
  assert.equal(validCommand('library.recycleDuplicates', execute, []), true);
  for (const patch of [{ path: 'C:/private' }, { keepId: '../notes.chart' }, { revision: -1 }, { contextId: 'x' }]) assert.equal(validCommand('library.prepareCleanup', { ...prepare, ...patch }, []), false);
  for (const patch of [{ path: 'C:/private' }, { ids: [] }, { ids: [id, id] }, { ids: ['../notes.chart'] }, { revision: NaN }, { planId: 'x' }, { permanent: true }]) assert.equal(validCommand('library.recycleDuplicates', { ...execute, ...patch }, []), false);
  assert.equal(validCommand('library.cleanupReview', execute, []), false);
});

async function cleanupHostFixture(t) {
  const f = await hostFixture(t), fs = require('node:fs/promises'), songs = path.join(f.directory, 'Songs');
  for (const name of ['A', 'B', 'C']) {
    const folder = path.join(songs, name); await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'song.ini'), '[song]\nname = Example\nartist = Band\ncharter = Creator\n');
    await fs.writeFile(path.join(folder, 'notes.chart'), '[Song]\n{}\n[ExpertSingle]\n{\n0 = N 0 0\n}');
    await fs.writeFile(path.join(folder, 'song.ogg'), 'fixture-audio-bytes');
  }
  const panel = await f.host.open();
  const command = (name, payload) => f.handlers.get('companion:command')(f.eventFor(panel), name, payload);
  await f.host.library.selectRoot(songs);
  const until = Date.now() + 5000;
  while (f.host.library.status().status === 'scanning' && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.host.library.status().status, 'ready');
  const revision = f.host.library.status().revision, rows = (await f.host.library.query({ duplicates: 'possible' })).items;
  const keepId = rows.find(item => item.relativePath === 'A/notes.chart').id;
  const compared = await command('library.compareDuplicates', { id: keepId, revision }); assert.equal(compared.ok, true, compared.error);
  const contextId = compared.result.contextId;
  assert.equal((await command('library.chooseDuplicate', { contextId, revision, id: keepId })).ok, true);
  const prepared = await command('library.prepareCleanup', { contextId, revision, keepId }); assert.equal(prepared.ok, true, prepared.error);
  assert.ok(prepared.result.candidates.every(item => item.eligible));
  const payload = { planId: prepared.result.planId, revision, ids: prepared.result.candidates.map(item => item.id) };
  return { ...f, fs, songs, panel, command, plan: prepared.result, payload };
}


test('native cleanup defaults to cancel and recycles only the explicitly selected copy', async t => {
  const f = await cleanupHostFixture(t), recycled = [];
  f.shell.trashItem = async target => { recycled.push(target); await f.fs.rename(target, path.join(f.directory, 'fake-recycle-' + path.basename(target))); };
  let confirmations = 0;
  f.dialog.showMessageBox = async (owner, options) => {
    confirmations++; assert.equal(owner, f.panel); assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0);
    assert.ok(options.detail.includes('A')); assert.ok(options.detail.includes('Dossier entier')); return { response: 0 };
  };
  const selection = { ...f.payload, ids: [f.payload.ids[0]] };
  assert.deepEqual(await f.command('library.recycleDuplicates', selection), { ok: true, cancelled: true });
  assert.equal(confirmations, 1); assert.deepEqual(recycled, []);
  await f.host.setOverlay(true);
  assert.equal((await f.handlers.get('companion:command')(f.eventFor(f.host.getOverlay()), 'library.recycleDuplicates', selection)).ok, false);
  assert.equal((await f.command('library.recycleDuplicates', { ...selection, ids: [f.plan.keepId] })).ok, false);
  assert.equal(confirmations, 1);
  f.dialog.showMessageBox = async () => ({ response: 1 });
  const result = await f.command('library.recycleDuplicates', selection);
  assert.equal(result.ok, true, result.error); assert.deepEqual(result.result.recycledIds, selection.ids); assert.deepEqual(result.result.failed, []); assert.equal(result.result.refreshRequested, true);
  assert.equal(recycled.length, 1);
  const remaining = await f.fs.readdir(f.songs); assert.equal(remaining.length, 2); assert.ok(remaining.includes('A'));
  const until = Date.now() + 5000;
  while (f.host.library.status().status === 'scanning' && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.host.library.status().count, 2);
  assert.equal((await f.command('library.recycleDuplicates', selection)).ok, false, 'a consumed plan cannot run again');
});


test('cleanup refuses a copy whose audio changes while native confirmation is open', async t => {
  const f = await cleanupHostFixture(t); let recycled = 0;
  f.shell.trashItem = async () => { recycled++; };
  const selection = { ...f.payload, ids: [f.payload.ids[0]] };
  f.dialog.showMessageBox = async () => {
    const copy = f.plan.candidates.find(item => item.id === selection.ids[0]);
    await f.fs.writeFile(path.join(f.songs, copy.targetRelativePath, 'song.ogg'), 'edited audio');
    return { response: 1 };
  };
  const result = await f.command('library.recycleDuplicates', selection);
  assert.equal(result.ok, true, result.error); assert.deepEqual(result.result.recycledIds, []); assert.equal(result.result.failed.length, 1); assert.equal(recycled, 0);
  assert.deepEqual((await f.fs.readdir(f.songs)).sort(), ['A', 'B', 'C']);
});


test('native recycling reports partial results without a permanent-delete fallback', async t => {
  const f = await cleanupHostFixture(t); let calls = 0;
  f.dialog.showMessageBox = async () => ({ response: 1 });
  f.shell.trashItem = async target => {
    if (++calls === 2) throw Error('Recycle unavailable');
    await f.fs.rename(target, path.join(f.directory, 'fake-recycle-' + path.basename(target)));
  };
  const result = await f.command('library.recycleDuplicates', f.payload);
  assert.equal(result.ok, true, result.error); assert.equal(result.result.recycledIds.length, 1); assert.equal(result.result.failed.length, 1); assert.equal(calls, 2);
  const remaining = await f.fs.readdir(f.songs); assert.equal(remaining.length, 2); assert.ok(remaining.includes('A'));
});


test('closing the panel cancels a pending cleanup confirmation', async t => {
  const f = await cleanupHostFixture(t); let settle, calls = 0;
  f.shell.trashItem = async () => { calls++; };
  f.dialog.showMessageBox = () => new Promise(resolve => { settle = resolve; });
  const action = f.command('library.recycleDuplicates', f.payload);
  const until = Date.now() + 5000;
  while (!settle && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(settle);
  assert.equal((await f.command('library.scan', { mode: 'full' })).ok, false);
  f.panel.destroy(); await f.host.stop(); settle({ response: 1 });
  assert.deepEqual(await action, { ok: true, cancelled: true }); assert.equal(calls, 0);
});


test('host shutdown drains an in-flight recycle and prevents recycling the next copy', async t => {
  const f = await cleanupHostFixture(t); let settle, calls = 0, stopped = false;
  f.dialog.showMessageBox = async () => ({ response: 1 });
  f.shell.trashItem = () => { calls++; return new Promise(resolve => { settle = resolve; }); };
  const action = f.command('library.recycleDuplicates', f.payload);
  const until = Date.now() + 5000;
  while (!settle && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(settle);
  const shutdown = f.host.stop().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(stopped, false);
  settle(); const result = await action; await shutdown;
  assert.equal(result.ok, true, result.error); assert.equal(result.result.recycledIds.length, 1); assert.equal(result.result.cancelled, true); assert.equal(calls, 1);
});
