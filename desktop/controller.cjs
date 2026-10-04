'use strict';
const { BrowserWindow, WebContentsView, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { windowTheme } = require('../window-theme');

const HEADER_HEIGHT = 108;
const STATE_CHANNEL = 'chartshub-shell:state';
const SELECT_CHANNEL = 'chartshub-shell:select-tab';
const CHANGED_CHANNEL = 'chartshub-shell:changed';
const validTab = name => name === 'catalogue' || name === 'companion';
const messages = { catalogue: 'Le catalogue est indisponible. Vérifiez votre connexion, puis réessayez.', companion: 'Le Companion ne peut pas démarrer. Réessayez dans un instant.' };

/** The shell owns the catalogue; Companion retains ownership of its own view. */
function createDesktopShell({ cataloguePreferences = {}, onSelectTab = async () => {} } = {}) {
  if (typeof onSelectTab !== 'function') throw TypeError('Invalid desktop tab callback');
  const filename = path.join(__dirname, 'index.html'), shellUrl = pathToFileURL(filename).href;
  let disposed = false, companionView = null, activeTab = 'catalogue', companionAvailable = false;
  let theme = { mode: 'dark', accent: '#91d6c4', color: '#0d1118', symbolColor: '#eef1f2' };
  const state = {
    catalogue: { ready: false, loading: true, error: null },
    companion: { ready: false, loading: false, error: null }
  };
  const pending = new Map(), listeners = [], contentsByView = new WeakMap(), deadViews = new WeakSet();
  const window = new BrowserWindow({
    width: 1400, height: 950, minWidth: 720, minHeight: 560, title: 'ChartsHub',
    backgroundColor: '#151719', icon: path.join(__dirname, '..', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: theme.color, symbolColor: theme.symbolColor, height: 36 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), partition: 'chartshub-shell-' + randomUUID(),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false,
      webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false, spellcheck: false
    }
  });
  const shellWeb = window.webContents;
  window.setMenuBarVisibility(false);
  const catalogueView = new WebContentsView({ webPreferences: { ...cataloguePreferences } });
  const catalogueWeb = catalogueView.webContents;
  contentsByView.set(catalogueView, catalogueWeb);
  catalogueView.setVisible(false);
  window.contentView.addChildView(catalogueView);

  function on(emitter, event, listener) {
    emitter.on(event, listener); listeners.push(() => emitter.removeListener(event, listener));
  }
  function contentsAlive(contents) {
    try { return Boolean(contents && !contents.isDestroyed()); } catch { return false; }
  }
  const alive = view => Boolean(view && !deadViews.has(view) && contentsAlive(contentsByView.get(view)));
  function detach(view) {
    if (!view || window.isDestroyed()) return;
    // Electron may already have destroyed and detached the native View while
    // the corresponding JavaScript wrapper still exists.
    try { window.contentView.removeChildView(view); } catch { /* Already detached. */ }
  }
  function snapshot() {
    return { activeTab, companionAvailable, tabs: { catalogue: { ...state.catalogue }, companion: { ...state.companion } }, theme: { ...theme }, platform: process.platform };
  }
  function trusted(event) {
    return !disposed && !window.isDestroyed() && contentsAlive(shellWeb)
      && event?.sender === shellWeb && event.senderFrame === shellWeb.mainFrame
      && event.senderFrame?.url === shellUrl && shellWeb.getURL() === shellUrl;
  }
  function layout() {
    if (disposed || window.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    const bounds = { x: 0, y: HEADER_HEIGHT, width: Math.max(0, width), height: Math.max(0, height - HEADER_HEIGHT) };
    for (const [name, view] of [['catalogue', catalogueView], ['companion', companionView]]) {
      if (!alive(view)) continue;
      try {
        view.setBounds(bounds);
        view.setVisible(activeTab === name && state[name].ready && !state[name].error);
      } catch {
        deadViews.add(view);
        state[name].ready = false; state[name].loading = false; state[name].error = messages[name];
      }
    }
  }
  function publish() {
    if (disposed) return;
    layout();
    if (!window.isDestroyed() && contentsAlive(shellWeb) && shellWeb.getURL() === shellUrl)
      shellWeb.send(CHANGED_CHANNEL, snapshot());
  }
  function focusSelected() {
    const view = activeTab === 'catalogue' ? catalogueView : companionView;
    if (alive(view) && state[activeTab].ready && !state[activeTab].error) contentsByView.get(view).focus();
  }
  function showTab(name) {
    if (!validTab(name)) throw TypeError('Invalid desktop tab');
    if (disposed) return null;
    if (name === 'companion' && !companionAvailable) return snapshot();
    activeTab = name; publish(); focusSelected(); return snapshot();
  }
  function selectTab(name) {
    if (!validTab(name) || disposed) return Promise.resolve(null);
    if (name === 'companion' && !companionAvailable) return Promise.resolve(snapshot());
    showTab(name);
    if (pending.has(name)) return pending.get(name);
    const selected = state[name], retryCatalogue = name === 'catalogue' && Boolean(selected.error);
    selected.error = null;
    if (!selected.ready) selected.loading = true;
    publish();
    const task = Promise.resolve().then(() => {
      if (!disposed && retryCatalogue && alive(catalogueView)) catalogueWeb.reload();
      if (!disposed && (name !== 'companion' || companionAvailable)) return onSelectTab(name);
    }).then(() => {
      if (!disposed) { if (!selected.ready && !selected.error) selected.loading = true; publish(); }
      return disposed ? null : snapshot();
    }, () => {
      if (!disposed) { selected.loading = false; selected.error = messages[name]; publish(); }
      return disposed ? null : snapshot();
    }).finally(() => pending.delete(name));
    pending.set(name, task);
    return task;
  }
  function keyboard(event, input) {
    if (input.type !== 'keyDown' || input.alt) return;
    const key = String(input.key).toLowerCase();
    if (key === 'f11') { event.preventDefault(); window.setFullScreen(!window.isFullScreen()); return; }
    if (key === 'escape' && window.isFullScreen()) { event.preventDefault(); window.setFullScreen(false); return; }
    if (key === 'tab' && input.control) { event.preventDefault(); if (companionAvailable) void selectTab(activeTab === 'catalogue' ? 'companion' : 'catalogue'); }
    else if (key === 'c' && input.shift && (input.control || process.platform === 'darwin' && input.meta)) { event.preventDefault(); if (companionAvailable) void selectTab('companion'); }
  }
  function observeView(name, view) {
    const current = () => !disposed && (name === 'catalogue' ? catalogueView === view : companionView === view);
    const selected = state[name], contents = contentsByView.get(view);
    on(contents, 'before-input-event', keyboard);
    on(contents, 'did-start-loading', () => {
      if (!current() || !alive(view)) return; selected.loading = true; selected.error = null; publish();
    });
    on(contents, 'did-finish-load', () => {
      if (!current() || !alive(view) || selected.error) return; selected.ready = true; selected.loading = false; publish();
    });
    on(contents, 'did-stop-loading', () => {
      if (!current() || !alive(view)) return;
      // loadURL resolves at did-finish-load; a view attached immediately after
      // that promise may still report isLoading until this final event.
      const url = contents.getURL();
      if (!selected.error && url && url !== 'about:blank') selected.ready = true;
      selected.loading = false; publish();
    });
    on(contents, 'did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (!current() || mainFrame === false || code === -3) return;
      selected.ready = false; selected.loading = false; selected.error = messages[name]; publish();
    });
    const failed = () => {
      if (!current()) return; selected.ready = false; selected.loading = false; selected.error = messages[name]; publish();
    };
    on(contents, 'render-process-gone', failed);
    on(contents, 'destroyed', () => { deadViews.add(view); failed(); });
  }
  function attachCompanion(view) {
    if (disposed) return false;
    let contents;
    try { contents = view && (contentsByView.get(view) || view.webContents); } catch { /* Invalid native wrapper. */ }
    if (!contentsAlive(contents) || typeof view.setBounds !== 'function' || typeof view.setVisible !== 'function' || deadViews.has(view)) throw TypeError('Invalid Companion view');
    contentsByView.set(view, contents);
    if (companionView === view) { publish(); return true; }
    if (alive(companionView)) throw Error('Companion view is already attached');
    detach(companionView);
    companionView = view;
    view.setVisible(false); window.contentView.addChildView(view);
    const url = contents.getURL();
    state.companion.ready = Boolean(url && url !== 'about:blank' && !contents.isLoading());
    state.companion.loading = !state.companion.ready; state.companion.error = null;
    observeView('companion', view); publish(); return true;
  }
  function setTheme(value) {
    const validated = windowTheme(value);
    if (!validated || disposed) return false;
    theme = validated;
    if (!window.isDestroyed()) {
      window.setBackgroundColor(theme.color);
      if (process.platform !== 'darwin') window.setTitleBarOverlay({ color: theme.color, symbolColor: theme.symbolColor, height: 36 });
      if (process.platform === 'win32') window.setAccentColor(theme.accent);
    }
    publish(); return true;
  }
  function setCompanionAvailable(value) {
    if (typeof value !== 'boolean') throw TypeError('Invalid Companion availability');
    if (disposed) return null;
    companionAvailable = value;
    if (!value && activeTab === 'companion') void selectTab('catalogue');
    else publish();
    return snapshot();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    ipcMain.removeHandler(STATE_CHANNEL); ipcMain.removeHandler(SELECT_CHANNEL);
    for (const remove of listeners.splice(0)) {
      try { remove(); } catch { /* Native emitter may already be gone. */ }
    }
    for (const view of [catalogueView, companionView]) detach(view);
    if (contentsAlive(catalogueWeb)) catalogueWeb.close({ waitForBeforeUnload: false });
    // Companion's host may still own overlays or pending persistence work.
  }

  shellWeb.setWindowOpenHandler(() => ({ action: 'deny' }));
  void shellWeb.setVisualZoomLevelLimits(1, 1).catch(() => {});
  on(shellWeb, 'will-navigate', event => event.preventDefault());
  on(shellWeb, 'will-frame-navigate', event => event.preventDefault());
  on(shellWeb, 'will-redirect', event => event.preventDefault());
  on(shellWeb, 'will-attach-webview', event => event.preventDefault());
  on(shellWeb, 'before-input-event', keyboard);
  on(shellWeb, 'did-finish-load', () => { shellWeb.setZoomFactor(1); publish(); });
  shellWeb.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
  shellWeb.session.setPermissionCheckHandler(() => false);
  on(shellWeb.session, 'will-download', event => event.preventDefault());
  on(window, 'resize', layout);
  on(window, 'enter-full-screen', layout);
  on(window, 'leave-full-screen', layout);
  on(window, 'closed', dispose);
  observeView('catalogue', catalogueView);
  ipcMain.handle(STATE_CHANNEL, (event, payload) => trusted(event) && payload === undefined ? snapshot() : null);
  ipcMain.handle(SELECT_CHANNEL, (event, name) => trusted(event) && validTab(name) ? selectTab(name) : null);
  layout();
  const ready = window.loadFile(filename);
  return { window, catalogueView, ready, attachCompanion, showTab, setTheme, setCompanionAvailable, dispose };
}

module.exports = { createDesktopShell };
