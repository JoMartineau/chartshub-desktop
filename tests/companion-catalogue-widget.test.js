'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events'), Module = require('node:module');
const { trustedCatalogueWidgetCommand, trustedFiltersWidgetCommand, validCommand } = require('../companion/security.cjs');
const search = { query: '', artist: '', charter: '', genre: '', year: '', instrument: '', difficulty: '', verified: 'all', installed: 'all', page: 1 };
const appearance = { backgroundColor: '#12345680', textColor: '#abcdef', fontFamily: 'verdana', fontSize: 18 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const end = Date.now() + 5000; while (!check()) { assert.ok(Date.now() < end, 'operation settles'); await delay(10); } }
async function fixture(t, { collision = false, authorize = async () => true, available = () => true, downloadWorker, downloadNotifications } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-mini-catalogue-'));
  const windows = [], handlers = new Map(), shortcuts = new Map(), unregistered = [], opened = [];
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.visible = false; this.focused = false; this.messages = [];
      const web = this.webContents = new EventEmitter();
      Object.assign(web, { mainFrame: { url: '' }, isLoading: () => false, isDestroyed: () => this.destroyed,
        send: (channel, value) => this.messages.push({ channel, value }), setWindowOpenHandler: handler => { this.windowHandler = handler; } });
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
    focus() { this.focused = true; }
    setMenuBarVisibility() {}
    setIgnoreMouseEvents() {}
    setAlwaysOnTop(enabled, level) { this.onTop = { enabled, level }; }
  }
  const app = new EventEmitter(); app.getPath = () => directory; app.quit = () => {};
  const ses = new EventEmitter();
  Object.assign(ses, { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, protocol: { async handle() {}, async unhandle() {} } });
  const dialog = { async showOpenDialog(owner) { opened.push(owner); return { canceled: true, filePaths: [] }; }, async showMessageBox() { throw Error('No chart deletion in mini catalogue tests'); } };
  const electron = { app, BrowserWindow: Window, dialog, clipboard: { writeText() {} }, shell: {},
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    protocol: { registerSchemesAsPrivileged() {} }, session: { fromPartition: () => ses },
    screen: { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }) }, net: { fetch() { throw Error('No network in fixture'); } },
    globalShortcut: { register(key, handler) { if (collision || shortcuts.has(key)) return false; shortcuts.set(key, handler); return true; }, unregister(key) { unregistered.push(key); shortcuts.delete(key); } } };
  const hostPath = require.resolve('../companion/host.cjs'), previous = require.cache[hostPath], originalLoad = Module._load;
  let createCompanionHost;
  try {
    delete require.cache[hostPath]; Module._load = function(request, ...args) { return request === 'electron' ? electron : originalLoad.call(this, request, ...args); };
    ({ createCompanionHost } = require(hostPath));
  } finally { Module._load = originalLoad; if (previous) require.cache[hostPath] = previous; else delete require.cache[hostPath]; }
  const chart = { id: 'mini-chart', title: 'Mini fixture', artist: 'Artist', charter: 'Charter', viewUrl: 'https://chartshub.ca/index.html?chart=mini-chart&share=2', downloadEndpoint: '/api/charts/11111111-1111-4111-8111-111111111111/abcdefghijkl/download-manifest', instruments: ['Guitar'], difficulties: ['Expert'] };
  const host = await createCompanionHost({ dataDirectory: directory, catalogueClient: { async load() { return { items: [chart], demo: false }; }, async artwork() { return null; } },
    cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({ running: false, sessions: [] }),
    isCatalogueAvailable: available, authorizeCatalogue: authorize, downloadNotifications,
    downloadWorker: downloadWorker ?? { async run() { throw Error('No unexpected download'); }, async discard() {}, async resolveCompleted() { return null; } } });
  t.after(async () => {
    await host.dispose();
    for (const window of windows) window.destroy();
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('chartshub-mini-catalogue-')) throw Error('Unsafe fixture path');
    await fs.rm(directory, { recursive: true, force: true });
  });
  const eventFor = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const invoke = (window, name, payload) => handlers.get('companion:command')(eventFor(window), name, payload);
  const snapshot = window => handlers.get('companion:snapshot')(eventFor(window));
  return { host, directory, windows, handlers, shortcuts, unregistered, opened, dialog, eventFor, invoke, snapshot };
}

test('mini catalogue IPC grants only its exact main frame and its own appearance', () => {
  const frame = { url: 'chartshub-companion://app/ui/catalogue-widget.html' }, web = { mainFrame: frame }, window = { webContents: web, isDestroyed: () => false }, event = { sender: web, senderFrame: frame };
  for (const name of ['catalogue.widget', 'catalogue.search', 'catalogue.refresh', 'downloads.enqueue', 'downloads.chooseRoot', 'downloads.pause', 'downloads.resume', 'downloads.cancel', 'downloads.retry']) assert.equal(trustedCatalogueWidgetCommand(event, window, name), true);
  assert.equal(trustedCatalogueWidgetCommand(event, window, 'panels.appearance', { panel: 'catalogue' }), true);
  assert.equal(trustedCatalogueWidgetCommand(event, window, 'panels.appearance', { panel: 'filters' }), false);
  for (const name of ['library.query', 'library.recycleDuplicates', 'profile.apply', 'filters.settings', 'downloads.openFolder', 'catalogue.open']) assert.equal(trustedCatalogueWidgetCommand(event, window, name), false);
  assert.equal(trustedCatalogueWidgetCommand({ ...event, senderFrame: { ...frame } }, window, 'catalogue.search'), false);
  assert.equal(trustedCatalogueWidgetCommand({ ...event, sender: {} }, window, 'catalogue.search'), false);
  frame.url += '#forged'; assert.equal(trustedCatalogueWidgetCommand(event, window, 'catalogue.search'), false);
  frame.url = 'chartshub-companion://app/ui/filters-widget.html';
  assert.equal(trustedFiltersWidgetCommand(event, window, 'panels.appearance', { panel: 'filters' }), true);
  assert.equal(trustedFiltersWidgetCommand(event, window, 'panels.appearance', { panel: 'catalogue' }), false);
});

test('floating panel command validates keys, bounded styles and explicit catalogue visibility', () => {
  assert.equal(validCommand('catalogue.widget', { enabled: true }, []), true);
  for (const value of [undefined, {}, { enabled: 1 }, { enabled: true, path: 'outside' }]) assert.equal(validCommand('catalogue.widget', value, []), false);
  const payload = { revision: 0, panel: 'catalogue', appearance };
  assert.equal(validCommand('panels.appearance', payload, []), true);
  for (const invalid of [{ revision: -1 }, { panel: 'library' }, { style: {} }, { appearance: { ...appearance, fontSize: 25 } }, { appearance: { ...appearance, fontSize: 10.5 } }, { appearance: { ...appearance, fontFamily: 'url(remote)' } }, { appearance: { ...appearance, css: 'arbitrary' } }]) assert.equal(validCommand('panels.appearance', { ...payload, ...invalid }, []), false);
});

test('floating catalogue is hardened, searchable and receives no private panel data', async t => {
  const f = await fixture(t), panel = await f.host.open();
  assert.equal((await f.invoke(panel, 'catalogue.widget', { enabled: true })).ok, true);
  const mini = f.host.getCatalogueWidget();
  assert.equal(mini.visible, true); assert.equal(mini.focused, true);
  assert.equal(mini.options.transparent, true); assert.equal(mini.options.frame, false); assert.equal(mini.options.resizable, true);
  assert.equal(mini.options.webPreferences.sandbox, true); assert.equal(mini.options.webPreferences.nodeIntegration, false); assert.equal(mini.options.webPreferences.contextIsolation, true);
  assert.deepEqual(mini.windowHandler(), { action: 'deny' });
  let prevented = false; mini.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'https://chartshub.ca'); assert.equal(prevented, true);
  const result = await f.invoke(mini, 'catalogue.search', search);
  assert.equal(result.ok, true); assert.equal(result.result.items[0].id, 'mini-chart');
  const value = f.snapshot(mini);
  assert.deepEqual(Object.keys(value).sort(), ['catalogue', 'catalogueShortcut', 'catalogueWidgetEnabled', 'downloads', 'floatingPanels', 'language']);
  assert.deepEqual(Object.keys(value.floatingPanels.appearance), ['catalogue']);
  assert.equal(value.downloads.hasRoot, false); assert.doesNotMatch(JSON.stringify(value), /stream-access|library\.json|currentsong|rootPath|destination/);
  for (const [name, payload] of [['library.chooseRoot'], ['catalogue.link', {}], ['panels.appearance', { revision: 0, panel: 'filters', appearance }], ['downloads.enqueue', { chartId: 'mini-chart', endpoint: 'https://outside' }]]) assert.equal((await f.invoke(mini, name, payload)).ok, false);
  f.host.setLanguage('en'); assert.equal(mini.messages.at(-1).value.language, 'en');
  await f.host.setFiltersWidget(true);
  const filterSnapshot = f.snapshot(f.host.getFiltersWidget());
  assert.deepEqual(Object.keys(filterSnapshot.floatingPanels.appearance), ['filters']);
  assert.equal(filterSnapshot.language, 'en');
});

test('catalogue shortcut toggles without ending services, revocation closes it and stop unregisters', async t => {
  let available = true, authCalls = 0;
  const f = await fixture(t, { available: () => available, authorize: async () => { authCalls++; return available; } });
  assert.equal(f.shortcuts.size, 0); await f.host.open();
  const key = f.host.snapshot().catalogueShortcut.accelerator; assert.equal(f.shortcuts.size, 1);
  f.shortcuts.get(key)(); await until(() => f.host.getCatalogueWidget()?.visible);
  assert.equal(authCalls, 1);
  f.shortcuts.get(key)(); await until(() => !f.host.getCatalogueWidget().visible);
  assert.equal(f.shortcuts.size, 1);
  await f.host.setCatalogueWidget(true); const former = f.host.getCatalogueWidget();
  available = false; f.host.setCatalogueAvailable(false);
  assert.equal(former.isDestroyed(), true); assert.equal(f.shortcuts.size, 0); assert.equal(f.snapshot(former), null);
  assert.equal((await f.invoke(former, 'catalogue.search', search)).ok, false);
  available = true; f.host.setCatalogueAvailable(true); assert.equal(f.shortcuts.size, 1);
  await f.host.stop(); assert.equal(f.shortcuts.size, 0); assert.ok(f.unregistered.every(value => value === key));
});

test('shortcut collision leaves a visible diagnostic and the explicit open button working', async t => {
  const f = await fixture(t, { collision: true }), panel = await f.host.open();
  assert.equal(f.host.snapshot().catalogueShortcut.registered, false);
  assert.match(f.host.snapshot().catalogueShortcut.error, /raccourci.*indisponible/i);
  assert.equal((await f.invoke(panel, 'catalogue.widget', { enabled: true })).ok, true);
  await f.host.stop(); assert.deepEqual(f.unregistered, [], 'never unregister a shortcut owned by another application');
});

test('authorization completed after stop cannot create a catalogue window', async t => {
  let release;
  const f = await fixture(t, { authorize: () => new Promise(resolve => { release = resolve; }) }), panel = await f.host.open();
  const pending = f.invoke(panel, 'catalogue.widget', { enabled: true }); await until(() => !!release);
  await f.host.stop(); release(true);
  assert.equal((await pending).ok, false); assert.equal(f.host.getCatalogueWidget(), null);
});

test('mini native picker cancellation and revocation never enqueue a download', async t => {
  const f = await fixture(t), panel = await f.host.open(); await f.host.setCatalogueWidget(true);
  const mini = f.host.getCatalogueWidget(); await f.invoke(mini, 'catalogue.search', search);
  assert.equal((await f.invoke(mini, 'downloads.enqueue', { chartId: 'unknown' })).ok, false); assert.equal(f.opened.length, 0);
  assert.equal((await f.invoke(mini, 'downloads.enqueue', { chartId: 'mini-chart' })).cancelled, true);
  assert.deepEqual(f.opened, [mini]); assert.deepEqual(f.host.downloads.status().items, []);
  let release; f.dialog.showOpenDialog = owner => { assert.equal(owner, mini); return new Promise(resolve => { release = resolve; }); };
  const pending = f.invoke(mini, 'downloads.enqueue', { chartId: 'mini-chart' }); await until(() => !!release);
  f.host.setCatalogueAvailable(false); release({ canceled: false, filePaths: [f.directory] });
  assert.equal((await pending).ok, false); assert.deepEqual(f.host.downloads.status().items, []);
  assert.equal(f.host.downloads.status().rootPath, null); assert.equal(panel.isDestroyed(), false);
});

test('mini downloads use the existing queue and remain active while the mini is hidden', async t => {
  let run, finish;
  const worker = { async run(options) {
    run = options; options.onProgress({ receivedBytes: 4, totalBytes: 8, completedFiles: 0, totalFiles: 1, currentFile: 'private-current-path' });
    await new Promise((resolve, reject) => { finish = resolve; options.signal.addEventListener('abort', () => reject(Object.assign(Error('Stopped'), { name: 'AbortError' })), { once: true }); });
    const destination = path.join(options.rootPath, 'mini-installed'); await fs.mkdir(destination); await fs.writeFile(path.join(destination, 'notes.chart'), 'fixture');
    return { destination, folderName: 'mini-installed', files: 1, totalBytes: 8 };
  }, async discard() {}, async resolveCompleted(value) { return value.destination; } };
  const f = await fixture(t, { downloadWorker: worker }); await f.host.open(); await f.host.setCatalogueWidget(true);
  const mini = f.host.getCatalogueWidget(); await f.invoke(mini, 'catalogue.search', search);
  const target = path.join(f.directory, 'Downloads'); await fs.mkdir(target);
  f.dialog.showOpenDialog = async owner => { assert.equal(owner, mini); return { canceled: false, filePaths: [target] }; };
  const response = await f.invoke(mini, 'downloads.enqueue', { chartId: 'mini-chart' });
  assert.equal(response.ok, true); assert.deepEqual(Object.keys(response.result), ['id']); await until(() => !!run);
  assert.match(run.endpoint, /download-manifest$/); assert.equal(run.rootPath, target);
  const value = f.snapshot(mini); assert.equal(value.downloads.hasRoot, true);
  assert.doesNotMatch(JSON.stringify(value), /rootPath|destination|currentFile|private-current-path|endpoint/);
  assert.ok(value.downloads.items[0].updatedAt);
  await f.host.setCatalogueWidget(false); assert.equal(run.signal.aborted, false);
  finish(); await until(() => f.host.downloads.status().items[0].state === 'Completed');
  await f.host.setCatalogueWidget(true);
  assert.equal(f.snapshot(mini).downloads.items[0].state, 'Completed');
  assert.equal(await fs.readFile(path.join(target, 'mini-installed', 'notes.chart'), 'utf8'), 'fixture');
});

test('panel appearance remains independent, rejects unsafe colors and flushes on stop', async t => {
  const f = await fixture(t), panel = await f.host.open(); await f.host.setCatalogueWidget(true); const mini = f.host.getCatalogueWidget();
  const initial = f.host.snapshot().state;
  const saved = await f.invoke(mini, 'panels.appearance', { revision: 0, panel: 'catalogue', appearance });
  assert.equal(saved.ok, true); assert.deepEqual(Object.keys(saved.result.appearance), ['catalogue']);
  assert.equal(f.snapshot(mini).floatingPanels.appearance.catalogue.fontSize, 18);
  assert.equal((await f.invoke(mini, 'panels.appearance', { revision: 0, panel: 'catalogue', appearance })).code, 'STALE_FLOATING_PANELS');
  const revision = f.host.snapshot().floatingPanels.revision;
  for (const color of ['url(https://outside)', 'red;display:none', 'var(--user-controlled)']) assert.equal((await f.invoke(panel, 'panels.appearance', { revision, panel: 'catalogue', appearance: { ...appearance, backgroundColor: color } })).ok, false);
  assert.deepEqual(f.host.snapshot().state, initial);
  await f.host.stop();
  const stored = JSON.parse(await fs.readFile(path.join(f.directory, 'floating-panels.json'), 'utf8'));
  assert.equal(stored.appearance.catalogue.fontSize, 18); assert.equal(stored.appearance.filters.fontSize, 14);
});

test('download notification ownership is captured before the picker and never rebound after account switch', async t => {
  const { createDownloadNotifications } = require('../desktop/download-notifications.cjs');
  const sent = [], broker = createDownloadNotifications({ fetcher: async (_url, request) => { sent.push(request); return { ok: false }; } });
  broker.setAccount({ id: 'account-A' }); t.after(() => broker.dispose());
  const f = await fixture(t, { downloadNotifications: { capture: () => broker.capture(), track: (...args) => broker.trackCompanion(...args), observe: value => broker.observeCompanion(value) } });
  const panel = await f.host.open(); await f.invoke(panel, 'catalogue.search', search);
  const folder = path.join(f.directory, 'Downloads'); await fs.mkdir(folder);
  let release; f.dialog.showOpenDialog = () => new Promise(resolve => { release = resolve; });
  const pending = f.invoke(panel, 'downloads.enqueue', { chartId: 'mini-chart' }); await until(() => !!release);
  broker.invalidate(); broker.setAccount({ id: 'account-B' });
  release({ canceled: false, filePaths: [folder] });
  assert.equal((await pending).ok, true);
  await until(() => f.host.downloads.status().items[0].state === 'Failed'); await broker.flush();
  assert.deepEqual(sent, [], 'neither success nor failure of an earlier intent belongs to the next account');
  assert.equal((await f.invoke(panel, 'downloads.retry', { id: f.host.downloads.status().items[0].id })).ok, true);
  await until(() => f.host.downloads.status().items[0].state === 'Failed'); await broker.flush();
  assert.equal(sent.length, 1); assert.equal(sent[0].headers['X-Chartshub-Account-Id'], 'account-B', 'an explicit retry is a new user intent');
});

test('renderer commands cannot forge or directly post desktop notifications', async t => {
  const f = await fixture(t), panel = await f.host.open(); await f.host.setCatalogueWidget(true);
  for (const window of [panel, f.host.getCatalogueWidget()]) {
    for (const name of ['notifications.create', 'notifications.downloads', 'desktop.notify']) assert.equal((await f.invoke(window, name, { accountId: 'other-account', eventId: 'fake', url: 'https://outside' })).ok, false);
  }
});
