'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ORIGIN = 'https://chartshub.ca';
const member = { id: 'ordinary-member', emailVerified: false, staffRole: null };
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check, label) { for (let index = 0; index < 100; index++) { if (check()) return; await settle(); } throw Error('Timed out: ' + label); }

// Execute the actual main process against deterministic Electron boundaries.
// The companion host and native shell have their own real-Electron harnesses.
async function fixture({ user: initialUser = member, argv = [], hostInitialization, hostOpening, hostDisposal } = {}) {
  const ipc = new Map(), menus = [], requests = [], windows = [], tabs = [], availability = [], errors = [];
  let user = initialUser, shell, hostOptions, hostCreates = 0, hostOpens = 0, hostDisposes = 0;
  let fetchAccount = async () => Response.json({ user });
  const session = Object.assign(new EventEmitter(), {
    cookies: new EventEmitter(), setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    fetch: (...args) => { requests.push(args); return fetchAccount(...args); }
  });
  class Contents extends EventEmitter {
    constructor(url = '') { super(); this.mainFrame = { url }; this.destroyed = false; this.sent = []; this.loads = []; }
    isDestroyed() { return this.destroyed; }
    getURL() { if (this.destroyed) throw Error('Contents destroyed'); return this.mainFrame.url; }
    send(name, data) { if (this.destroyed) throw Error('Contents destroyed'); this.sent.push({ name, data }); }
    setWindowOpenHandler(handler) { this.windowOpen = handler; }
    async loadURL(url) {
      if (this.destroyed) throw Error('Contents destroyed'); this.loads.push(url);
      this.emit('did-start-navigation', {}, url, false, true); this.mainFrame.url = url;
      this.emit('did-finish-load');
    }
    reload() { return this.loadURL(this.mainFrame.url); }
    getZoomLevel() { return 0; }
    setZoomLevel() {}
    close() { if (!this.destroyed) { this.destroyed = true; this.emit('destroyed'); } }
  }
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = new Contents('file:///desktop/index.html'); this.destroyed = false; windows.push(this); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    restore() {}
    show() {}
    focus() {}
    setMenuBarVisibility() {}
    setProgressBar() {}
    setFullScreen(value) { this.fullscreen = value; }
    isFullScreen() { return !!this.fullscreen; }
    async loadURL(url) { await this.webContents.loadURL(url); }
    close() {
      if (this.destroyed) return;
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      this.emit('close', event);
      if (!event.prevented) { this.destroyed = true; this.webContents.close(); this.emit('closed'); }
    }
  }
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    getPath: () => path.join(__dirname, 'unused-main-profile'), setPath() {}, quit() {}
  });
  const electron = {
    app, BrowserWindow: Window, ipcMain: { handle: (name, handler) => ipc.set(name, handler) },
    session: { fromPartition: name => { assert.equal(name, 'persist:chartshub'); return session; } },
    Menu: { setApplicationMenu() {}, buildFromTemplate: template => ({ popup() { menus.push(template); } }) },
    dialog: { showErrorBox: (...args) => errors.push(args), showMessageBox: async () => ({ response: 0 }) },
    shell: {}, nativeTheme: {}
  };
  const host = {
    async open() { hostOpens++; if (hostOpening) await hostOpening.promise; await hostOptions.embedded.activate(); },
    async dispose() { hostDisposes++; if (hostDisposal) await hostDisposal.promise; }
  };
  const createDesktopShell = options => {
    const catalogueView = { webContents: new Contents() };
    shell = {
      window: new Window(), catalogueView, ready: Promise.resolve(), activeTab: 'catalogue', available: false, disposed: false,
      select: name => options.onSelectTab(name),
      showTab(name) { if (this.disposed) throw Error('Shell disposed'); if (name === 'companion' && !this.available) return; this.activeTab = name; tabs.push(name); },
      attachCompanion() {}, setTheme() {},
      setCompanionAvailable(value) {
        if (this.disposed) throw Error('Shell disposed'); this.available = value; availability.push(value);
        if (!value && this.activeTab === 'companion') { this.activeTab = 'catalogue'; void options.onSelectTab('catalogue'); }
      },
      dispose() { this.disposed = true; catalogueView.webContents.close(); }
    };
    assert.equal(options.cataloguePreferences.session, session);
    assert.equal(options.cataloguePreferences.sandbox, true);
    return shell;
  };
  const localRequire = name => {
    if (name === 'electron') return electron;
    if (name === './desktop/controller.cjs') return { createDesktopShell };
    if (name === './companion/host.cjs') return { registerCompanionScheme() {}, async createCompanionHost(options) { hostCreates++; hostOptions = options; if (hostInitialization) await hostInitialization.promise; return host; } };
    if (name === './download') return { ORIGIN, endpointValid: () => false, downloadChart: () => { throw Error('No download permitted'); } };
    if (name === './download-folder') return { folderPreferences: () => ({ get: async () => null }) };
    return require(name.startsWith('./') ? path.join(__dirname, '..', name) : name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), {
    require: localRequire, process: { ...process, argv: ['ChartsHub.exe', ...argv] }, URL, AbortController, AbortSignal,
    __dirname: path.join(__dirname, '..'), setInterval, clearInterval, console: { warn: (...args) => errors.push(args), error: (...args) => errors.push(args) }
  });
  await settle();
  const web = shell.catalogueView.webContents;
  const invokeAs = (sender, name, ...args) => ipc.get('chartshub:' + name)({ sender, senderFrame: sender.mainFrame }, ...args);
  return {
    app, ipc, shell, web, windows, tabs, availability, requests, menus, errors, host,
    get hostCreates() { return hostCreates; }, get hostOpens() { return hostOpens; }, get hostDisposes() { return hostDisposes; },
    setUser(value) { user = value; }, setFetch(fn) { fetchAccount = fn; },
    cookieChanged() { session.cookies.emit('changed', {}, { name: 'chartshub_session', domain: 'chartshub.ca' }); },
    invoke: (name, ...args) => invokeAs(web, name, ...args), invokeAs,
    event: () => ({ sender: web, senderFrame: web.mainFrame })
  };
}

test('guest startup refuses --companion and opens the catalogue without initializing native services', async () => {
  const f = await fixture({ user: null, argv: ['--companion'] });
  await until(() => f.web.loads.length > 0, 'guest catalogue');
  assert.equal(f.hostCreates, 0); assert.equal(f.shell.available, false); assert.equal(f.shell.activeTab, 'catalogue');
  assert.ok(f.requests.every(([url, options]) => url === ORIGIN + '/api/auth/me' && options.credentials === 'include'));
  await f.invoke('menu', 'fr');
  assert.ok(!f.menus.at(-1).some(item => item.label === 'Clone Hero Companion'));
  f.app.emit('second-instance', {}, ['ChartsHub.exe', '--companion']); await settle();
  assert.equal(f.hostCreates, 0); assert.equal(f.shell.activeTab, 'catalogue');
});

test('ordinary members see Companion without administrator or verified-email privileges and logout hides it', async () => {
  const f = await fixture(); await until(() => f.shell.available, 'member availability');
  assert.equal(f.hostCreates, 0, 'login does not eagerly initialize Companion');
  await f.invoke('menu', 'fr');
  assert.ok(f.menus.at(-1).some(item => item.label === 'Clone Hero Companion'));
  assert.ok(!f.menus.at(-1).some(item => item.label === 'Voir comme visiteur'));
  await f.shell.select('companion');
  assert.equal(f.shell.activeTab, 'companion'); assert.equal(f.hostCreates, 1); assert.equal(f.hostOpens, 1);
  const beforeRefresh = f.availability.length;
  await f.invoke('download-state');
  assert.ok(f.availability.slice(beforeRefresh).every(Boolean), 'routine confirmed refresh must not briefly hide the tab');
  f.setUser(null); f.cookieChanged();
  assert.equal(f.shell.available, false);
  await until(() => f.shell.activeTab === 'catalogue', 'logout catalogue');
  await f.shell.select('companion');
  assert.equal(f.hostOpens, 1); assert.equal(f.shell.activeTab, 'catalogue');
  await f.invoke('menu', 'fr');
  assert.ok(!f.menus.at(-1).some(item => item.label === 'Clone Hero Companion'));
});

test('main IPC accepts only the exact catalogue main frame even when another renderer has its URL', async () => {
  const f = await fixture(); await until(() => f.shell.available, 'member availability');
  f.shell.window.webContents.mainFrame.url = f.web.mainFrame.url;
  const reads = f.requests.length;
  assert.equal(await f.invokeAs(f.shell.window.webContents, 'download-state'), null);
  assert.equal(await f.invokeAs(f.shell.window.webContents, 'menu', 'fr'), undefined);
  assert.equal(await f.ipc.get('chartshub:download-state')({ sender: f.web, senderFrame: { ...f.web.mainFrame } }), null);
  assert.equal(f.requests.length, reads); assert.equal(f.menus.length, 0);
  assert.ok(await f.invoke('download-state'));
  f.web.mainFrame.url = 'https://other.test/';
  assert.equal(await f.invoke('download-state'), null);
});

test('returning to Catalogue during Companion initialization prevents late activation and permits later reuse', async () => {
  const initialization = deferred(), f = await fixture({ hostInitialization: initialization });
  const pending = f.shell.select('companion'); await until(() => f.hostCreates === 1, 'host initialization');
  await f.shell.select('catalogue'); initialization.resolve(); await pending;
  assert.equal(f.hostOpens, 0); assert.equal(f.shell.activeTab, 'catalogue');
  await f.shell.select('companion'); assert.equal(f.hostCreates, 1); assert.equal(f.hostOpens, 1); assert.equal(f.shell.activeTab, 'companion');
});

test('changing tabs or logging out while Companion opens cannot activate it on late completion', async () => {
  for (const logout of [false, true]) {
    const opening = deferred(), f = await fixture({ hostOpening: opening });
    const pending = f.shell.select('companion'); await until(() => f.hostOpens === 1, 'host opening');
    if (logout) { f.setUser(null); f.cookieChanged(); await settle(); }
    else await f.shell.select('catalogue');
    opening.resolve(); await pending;
    assert.equal(f.shell.activeTab, 'catalogue');
    assert.equal(f.tabs.includes('companion'), false);
  }
});

test('closing during host initialization waits for disposal and never opens or activates the tab', async () => {
  const initialization = deferred(), disposal = deferred();
  const f = await fixture({ hostInitialization: initialization, hostDisposal: disposal });
  const pending = f.shell.select('companion'); await until(() => f.hostCreates === 1, 'host initialization');
  f.shell.window.close();
  assert.equal(f.shell.window.isDestroyed(), false); assert.equal(f.shell.disposed, false);
  initialization.resolve(); await until(() => f.hostDisposes === 1, 'host disposal');
  assert.equal(f.hostOpens, 0); assert.equal(f.shell.window.isDestroyed(), false);
  disposal.resolve(); await pending;
  await until(() => f.shell.window.isDestroyed(), 'window closed');
  assert.equal(f.shell.disposed, true); assert.equal(f.hostDisposes, 1); assert.equal(f.tabs.includes('companion'), false);
});

test('closing during account verification ignores its late result and never creates Companion', async () => {
  const f = await fixture(); await until(() => f.shell.available, 'initial account');
  const account = deferred(); f.setFetch(() => account.promise);
  const pending = f.shell.select('companion'); await settle();
  f.shell.window.close(); await until(() => f.shell.window.isDestroyed(), 'closed during account');
  account.resolve(Response.json({ user: member })); await pending;
  assert.equal(f.hostCreates, 0); assert.equal(f.shell.disposed, true);
});

test('a stale signed-in response after logout cannot restore the tab or initialize Companion', async () => {
  const f = await fixture(); await until(() => f.shell.available, 'initial account');
  const account = deferred(); f.setFetch(() => account.promise);
  const pending = f.shell.select('companion'); await settle();
  f.setFetch(async () => Response.json({ user: null })); f.cookieChanged(); await settle();
  assert.equal(f.shell.available, false);
  account.resolve(Response.json({ user: member })); await pending;
  assert.equal(f.shell.available, false); assert.equal(f.hostCreates, 0); assert.equal(f.shell.activeTab, 'catalogue');
});

test('closing while host.open is pending prevents its activation and awaits host disposal', async () => {
  const opening = deferred(), disposal = deferred();
  const f = await fixture({ hostOpening: opening, hostDisposal: disposal });
  const pending = f.shell.select('companion'); await until(() => f.hostOpens === 1, 'host opening');
  f.shell.window.close(); await until(() => f.hostDisposes === 1, 'host disposal');
  assert.equal(f.shell.window.isDestroyed(), false);
  opening.resolve(); await pending;
  assert.equal(f.tabs.includes('companion'), false);
  assert.equal(f.shell.window.isDestroyed(), false, 'the window must still wait for disposal');
  disposal.resolve(); await until(() => f.shell.window.isDestroyed(), 'closed after disposal');
  assert.equal(f.shell.disposed, true);
});
