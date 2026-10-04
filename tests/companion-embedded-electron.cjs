'use strict';

// Real renderer/IPC regression for the embedded Companion. All game and
// download services below are fixtures; nothing is installed or downloaded.
const { app, BrowserWindow, WebContentsView, dialog, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { registerCompanionScheme, createCompanionHost } = require('../companion/host.cjs');

const directory = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'embedded-ui-verification'));
app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration();
if (process.env.CHARTSHUB_TEST_NO_SANDBOX === '1') app.commandLine.appendSwitch('no-sandbox');
registerCompanionScheme();

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await check()) return; await delay(30); }
  throw Error('Timed out: ' + label);
}
const localUrl = 'chartshub-companion://app/ui/index.html';
const passed = [], calls = { refresh: 0, cancel: 0, filtersDispose: 0, reshadeDispose: 0, setupDispose: 0, stop: 0 };
const native = {
  rootPath: path.join(directory, 'Clone Hero fixture'), supported: true, installed: false,
  binaryAvailable: true, restoreAvailable: false, running: false, busy: false,
  state: 'not-installed', message: 'Module de test uniquement.', error: null, native: null,
  settings: { enabled: false, saturation: 1, contrast: 1, gamma: 1, exposure: 0, sharpness: 0, vignette: 0 }
};
const reshade = {
  rootPath: native.rootPath, supported: true, installed: true, binaryAvailable: true,
  running: false, connected: true, busy: false, state: 'ready', message: 'Fixture ReShade connectée.', error: null,
  catalog: { enabled: false, preset: path.join(directory, 'private', 'Fixture.ini'), selectedEffect: null, uniforms: [], techniques: [
    { id: 't:bloom', name: 'Bloom', label: 'Bloom', effect: 'Bloom.fx', enabled: false },
    { id: 't:grain', name: 'FilmGrain', label: 'Film Grain', effect: 'FilmGrain.fx', enabled: false }
  ] }
};
const setup = { state: 'idle', busy: false, rootPath: native.rootPath, includeStarterEffects: false,
  version: '6.8.0', message: 'Préparation de test uniquement.', error: null, progress: null, files: [] };
let host, owner, sibling, view, attached = 0, activated = 0, finishPreparation;
const publish = () => host?.services.store.setState(value => ({ ...value }));
const filtersService = {
  async load() {}, status: () => structuredClone(native), async refresh() { calls.refresh++; },
  async setSettings(value) { native.settings = structuredClone(value); },
  async selectRoot() { throw Error('No real game directory may be selected'); },
  async install() { throw Error('No real installation may be performed'); },
  async restore() { throw Error('No real restoration may be performed'); },
  async dispose() { calls.filtersDispose++; }
};
const reshadeService = {
  async load() {}, status: () => structuredClone(reshade), async refresh() {},
  async selectRoot() { throw Error('No real game directory may be selected'); },
  async install() { throw Error('No real addon may be installed'); },
  async command(payload) {
    if (payload.action !== 'enabled') throw Error('Unexpected fixture command');
    reshade.catalog.enabled = payload.enabled;
  },
  async dispose() { calls.reshadeDispose++; }
};
const reshadeSetupService = {
  async load() {}, status: () => structuredClone(setup),
  prepare(options) {
    Object.assign(setup, { state: 'preparing', busy: true, includeStarterEffects: options.includeStarterEffects,
      progress: { label: 'Préparation simulée', received: 1, total: 4 } });
    publish();
    return new Promise(resolve => { finishPreparation = resolve; });
  },
  async cancel() {
    calls.cancel++;
    Object.assign(setup, { state: 'idle', busy: false, progress: null });
    finishPreparation?.(); finishPreparation = null;
  },
  async install() { throw Error('No real setup may be installed'); },
  async dispose() { calls.setupDispose++; }
};

app.whenReady().then(async () => {
  await fs.mkdir(directory, { recursive: true });
  const preferences = { session: session.fromPartition('companion-local'), preload: path.join(__dirname, '..', 'companion', 'preload.cjs'),
    contextIsolation: true, nodeIntegration: false, sandbox: true };
  owner = new BrowserWindow({ width: 1250, height: 850, show: false, webPreferences: preferences });
  const quitListeners = app.listenerCount('before-quit');
  host = await createCompanionHost({
    dataDirectory: path.join(directory, 'companion'), cloneHeroCandidates: [],
    cloneHeroProcessProbe: async () => ({ running: false, sessions: [] }),
    filtersService, reshadeService, reshadeSetupService,
    catalogueClient: { async load() { return { items: [], revision: 'embedded-fixture', demo: false }; }, async artwork() { throw Error('No network permitted'); } },
    downloadWorker: { async run() { throw Error('No downloads permitted'); }, async discard() {}, async resolveCompleted() { return null; } },
    embedded: {
      ownerWindow: owner,
      attachView(value) { attached++; view = value; owner.contentView.addChildView(value); value.setBounds({ x: 0, y: 0, width: 1250, height: 850 }); },
      activate() { activated++; view?.setVisible(true); }
    }
  });
  assert.equal(app.listenerCount('before-quit'), quitListeners, 'embedded host leaves app quit ownership to the shell');
  const originalStop = host.services.stop.bind(host.services);
  host.services.stop = (...args) => { calls.stop++; return originalStop(...args); };
  assert.equal(await host.open(), owner);
  assert.equal(host.getPanel(), owner);
  assert.ok(host.getPanelView() instanceof WebContentsView);
  assert.equal(host.getPanelView(), view);
  const contents = host.getPanelContents();
  assert.equal(contents, view.webContents);
  assert.notEqual(contents, owner.webContents);
  assert.equal(contents.getURL(), localUrl);
  assert.equal(attached, 1);
  assert.equal(activated, 1);
  const evaluate = source => contents.executeJavaScript(source);
  const command = (name, payload) => evaluate(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`);
  await waitFor(() => evaluate("document.querySelectorAll('.reshade-technique').length===2"), 'embedded local panel renders');
  const snapshot = await evaluate('window.ChartsHubCompanion.getSnapshot()');
  assert.equal(snapshot.reshade.rootPath, native.rootPath);
  assert.equal((await command('reshade.command', { action: 'enabled', enabled: true })).ok, true);
  assert.equal(reshade.catalog.enabled, true);

  // These frames deliberately use the same preload, session and exact local URL.
  // Origin/URL equality must not grant a parent or sibling the view's capability.
  await owner.loadURL(localUrl);
  sibling = new WebContentsView({ webPreferences: preferences });
  owner.contentView.addChildView(sibling);
  sibling.setVisible(false);
  await sibling.webContents.loadURL(localUrl);
  for (const unauthorized of [owner.webContents, sibling.webContents]) {
    assert.equal(await unauthorized.executeJavaScript('window.ChartsHubCompanion.getSnapshot()'), null);
    for (const [name, payload] of [
      ['reshade.command', { action: 'enabled', enabled: false }],
      ['reshade.setupPrepare', { includeStarterEffects: true }],
      ['filters.chooseRoot', undefined]
    ]) {
      assert.equal((await unauthorized.executeJavaScript(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`)).ok, false);
    }
  }
  assert.equal(reshade.catalog.enabled, true);
  passed.push('real embedded renderer is authorized; parent and sibling using its exact URL, preload and session cannot read snapshots or issue commands');

  const originalDialog = dialog.showOpenDialog;
  let dialogCount = 0;
  dialog.showOpenDialog = async (parentWindow, options) => {
    assert.equal(parentWindow, owner, 'native picker must belong to the BrowserWindow, not the WebContentsView');
    assert.ok(options.properties.includes('openDirectory'));
    dialogCount++;
    return { canceled: true, filePaths: [] };
  };
  try {
    for (const name of ['filters.chooseRoot', 'reshade.chooseRoot', 'library.chooseRoot', 'downloads.chooseRoot']) {
      assert.equal((await command(name)).ok, true);
    }
  } finally { dialog.showOpenDialog = originalDialog; }
  assert.equal(dialogCount, 4);
  passed.push('four native directory pickers use the containing BrowserWindow as parent');

  await evaluate("window.__embeddedMarker={stable:true};window.__embeddedNode=document.querySelector('#reshade-search');window.__embeddedNode.value='bloom';window.__embeddedNode.dispatchEvent(new Event('input',{bubbles:true}));void window.ChartsHubCompanion.command('reshade.setupPrepare',{includeStarterEffects:false})");
  await waitFor(() => setup.state === 'preparing', 'fixture setup starts');
  const refreshes = calls.refresh;
  view.setVisible(false);
  owner.hide();
  await waitFor(() => calls.refresh > refreshes, 'filter polling continues while the tab is hidden');
  assert.equal(host.services.wanted, true);
  assert.equal(calls.stop, 0);
  assert.equal(calls.cancel, 0);
  assert.equal(setup.state, 'preparing');
  assert.equal(await host.open(), owner);
  assert.equal(attached, 1, 'opening an existing tab must reuse its view');
  assert.equal(activated, 2);
  assert.equal(host.getPanelContents(), contents);
  assert.equal(await evaluate("window.__embeddedMarker.stable&&window.__embeddedNode===document.querySelector('#reshade-search')&&window.__embeddedNode.value==='bloom'"), true);
  passed.push('tab hide/reopen preserves live services, polling, pending setup, renderer identity and search input without attaching a second view');

  await host.setFiltersWidget(true);
  const widget = host.getFiltersWidget();
  widget.hide();
  const mini = source => widget.webContents.executeJavaScript(source);
  const miniSnapshot = await mini('window.ChartsHubCompanion.getSnapshot()');
  assert.equal(miniSnapshot.reshade.rootPath, undefined);
  assert.equal(miniSnapshot.reshade.catalog.preset, 'Fixture.ini');
  for (const key of ['reshadeSetup', 'library', 'downloads', 'logs', 'stream']) assert.equal(miniSnapshot[key], undefined);
  for (const [name, payload] of [
    ['filters.chooseRoot', undefined], ['reshade.setupCancel', undefined],
    ['reshade.setupInstall', undefined], ['reshade.setupPrepare', { includeStarterEffects: true }],
    ['overlay.enabled', { enabled: true }]
  ]) assert.equal((await mini(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`)).ok, false);
  assert.equal((await mini("window.ChartsHubCompanion.command('reshade.command',{action:'enabled',enabled:false})")).ok, true);
  await waitFor(() => evaluate("!document.querySelector('#reshade-enabled').checked"), 'mini command reaches the embedded panel');
  view.setVisible(false);
  assert.equal((await mini("window.ChartsHubCompanion.command('filters.openPanel')")).ok, true);
  assert.equal(activated, 3, 'mini opens the Companion tab through the shell activation callback');
  assert.equal(attached, 1);
  assert.equal(host.getPanelContents(), contents);
  await waitFor(() => evaluate("document.activeElement.id==='game-filters'"), 'mini focuses the filters in the embedded panel');
  passed.push('mini widget has a restricted snapshot and commands, shares filter changes, and activates the existing embedded tab');

  await host.dispose();
  assert.equal(contents.isDestroyed(), true, 'dispose closes the embedded webContents');
  assert.equal(owner.isDestroyed(), false, 'dispose never destroys the shell window');
  assert.equal(sibling.webContents.isDestroyed(), false, 'dispose never destroys another tab');
  assert.equal(widget.isDestroyed(), true);
  assert.equal(calls.stop, 1);
  assert.equal(calls.cancel, 1, 'explicit disposal cancels pending preparation once');
  assert.equal(calls.filtersDispose, 1);
  assert.equal(calls.reshadeDispose, 1);
  assert.equal(calls.setupDispose, 1);
  assert.equal(app.listenerCount('before-quit'), quitListeners);
  host = null;
  passed.push('explicit disposal stops services, cancels preparation and closes its renderer/widget while preserving owner and sibling');
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify({ ok: true, passed }, null, 2));
}).catch(async error => {
  process.exitCode = 1;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify({ ok: false, error: error.stack, passed }, null, 2));
}).finally(async () => {
  finishPreparation?.();
  await host?.dispose();
  if (sibling && !sibling.webContents.isDestroyed()) sibling.webContents.close();
  if (owner && !owner.isDestroyed()) owner.destroy();
  app.exit(process.exitCode || 0);
});
