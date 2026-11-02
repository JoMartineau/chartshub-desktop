'use strict';
// Real Host/preload/renderer/IPC. Only synthetic Quick Import/download services
// and a new workspace profile are used; no game, provider, audio or device I/O.
const { app, BrowserWindow, desktopCapturer, dialog, shell } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
if (process.env.NODE_PATH) require('node:module').Module._initPaths();
const { registerFixtureMaintenance, revealWorkspace } = require('./workspace-input.cjs');
const disposeMaintenance = registerFixtureMaintenance();
const archiveArg = process.argv.find(value => value.startsWith('--fixture-asar='));
const productRoot = archiveArg ? path.resolve(archiveArg.slice('--fixture-asar='.length)) : path.resolve(__dirname, '..');
if (archiveArg && !productRoot.endsWith('.asar')) throw Error('Actual ASAR required');
const outputArg = process.argv.find(value => value.startsWith('--fixture-output='));
if (!outputArg) throw Error('Explicit disposable workspace output required');
const output = path.resolve(outputArg.slice('--fixture-output='.length)), workspace = path.resolve(__dirname, '../../..');
const contained = root => { const relative = path.relative(root, output); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const outputRoots = [path.join(workspace, 'outputs'), path.resolve(__dirname, '../outputs')];
// The checked-in workflow also runs this fixture from the actual public ASAR.
// Only GitHub Actions may use its explicit non-root runner temporary directory.
if (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' && typeof process.env.RUNNER_TEMP === 'string' && path.isAbsolute(process.env.RUNNER_TEMP)) {
  const temporary = path.resolve(process.env.RUNNER_TEMP); if (temporary !== path.parse(temporary).root) outputRoots.push(temporary);
}
if (!outputRoots.some(contained)) { console.error('Fresh output below workspace outputs or the CI runner temporary directory required'); app.exit(1); }
const directory = path.join(output, 'quick-import-' + randomUUID().slice(0, 8)), dataDirectory = path.join(directory, 'synthetic-companion');
const songs = path.join(directory, 'Songs'), nextSongs = path.join(directory, 'OtherSongs');
app.setPath('userData', path.join(directory, 'profile')); app.setPath('sessionData', path.join(directory, 'session'));
process.env.LOCALAPPDATA = path.join(directory, 'local-app-data');
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
// Exercise real hidden overlay/player renderers and their real preloads without
// displaying native floating windows over the user's running application.
let suppressedDisplayRequests = 0;
app.on('browser-window-created', (_event, window) => { window.showInactive = () => { suppressedDisplayRequests++; }; });
const { createCompanionHost, registerCompanionScheme } = require(path.join(productRoot, 'companion/host.cjs'));
const { defaultSettings } = require(path.join(productRoot, 'companion/drum-vst-model.cjs'));
registerCompanionScheme();
const checks = [], errors = [], externalRequests = [], calls = [], lifecycle = [], observations = [];
const mainCompletions = [], packageOpens = [], helpOpens = [];
const forbidden = { capture: 0, external: 0, fileDialog: 0, drumCommand: 0, realDownload: 0 };
desktopCapturer.getSources = async () => { forbidden.capture++; throw Error('Real capture forbidden'); };
shell.openExternal = async url => {
  if (['https://github.com/LavaGang/MelonLoader/releases/tag/v0.7.3', 'https://github.com/LavaGang/MelonLoader/blob/v0.7.3/README.md#requirements', 'https://github.com/LavaGang/MelonWiki/blob/master/docs/gettingstarted.md', 'https://github.com/LavaGang/MelonLoader.Installer#how-does-it-work'].includes(url)) { helpOpens.push(url); return; }
  forbidden.external++; throw Error('Real external launch forbidden');
};
shell.openPath = async folder => { assert.equal(folder, path.join(productRoot, 'quick-import-mod')); packageOpens.push(folder); return ''; };
dialog.showOpenDialog = async () => { forbidden.fileDialog++; throw Error('Real game selection forbidden'); };
const jobId = '00000000-0000-4000-8000-000000000036';
let state = { supported: true, selected: false, gameName: null, busy: false, connected: false, enabled: false, error: null, jobs: [], savedCanWrite: true };
let loaded = false, nextError = null, host, owner, contents, view, foreign, finished = false, visibilityUnexpected = false, catalogueAvailable = false;
const fakeService = {
  status: () => structuredClone(state),
  async load() { lifecycle.push('load'); loaded = true; return this.status(); },
  observeDownloads(value) { assert.equal(loaded, true, 'Service loads before persisted download notifications'); lifecycle.push('observe'); observations.push(structuredClone(value)); },
  observeCompletedDownload(value) { mainCompletions.push(structuredClone(value)); return this.status(); },
  update() { lifecycle.push('update'); },
  async command(name, payload) {
    calls.push({ name, payload: structuredClone(payload) });
    if (nextError) { const code = nextError; nextError = null; state.error = 'QUICK_IMPORT_FAILED'; throw Object.assign(Error('C:\\Private\\token=SECRET'), { code }); }
    state.error = null;
    if (name === 'quickImport.chooseGame') { state.selected = true; state.gameName = 'Clone Hero'; }
    else if (name === 'quickImport.connect') { state.enabled = true; state.connected = true; state.jobs = [{ id: jobId, state: 'queued', code: null, confirmed: true, deduplicated: false, waitingForSafeMenu: true, mayHaveReachedMod: true }]; }
    else if (name === 'quickImport.refresh') state.jobs = state.jobs.map(job => ({ ...job, state: 'ready', waitingForSafeMenu: false }));
    else if (name === 'quickImport.disable') { state.connected = false; state.enabled = false; }
    else throw Error('Unexpected Quick Import command');
    return this.status();
  },
  stop() { lifecycle.push('stop'); state.connected = false; state.enabled = false; return this.status(); },
  async dispose() { lifecycle.push('dispose'); }
};
const fakeDrums = {
  status: () => ({ supported: false, available: false, phase: 'stopped', revision: 1, plugin: null, settings: defaultSettings(), devices: { audio: [], midi: [], xinput: [] }, meters: { left: 0, right: 0 }, audio: null, error: null, mt: { version: '2.1.5.1', state: 'idle', error: null, progress: { receivedBytes: 0, totalBytes: null } } }),
  command() { forbidden.drumCommand++; throw Error('Unexpected drum command'); }, stop() {}, async dispose() {}
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(code, target = contents) { let timer; try { return await Promise.race([target.executeJavaScript(code), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Renderer evaluation timed out')), 10000); })]); } finally { clearTimeout(timer); } }
async function until(check, label) { const deadline = Date.now() + 10000; do { if (await check()) return; await delay(25); } while (Date.now() < deadline); throw Error('Timed out: ' + label); }
async function click(selector) {
  await revealWorkspace({ webContents: contents }, selector);
  await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled||n.closest('[inert]'))throw Error('Unavailable Quick Import control');n.click();})()`);
  await delay(30);
}
async function command(name, payload = {}, target = contents) { return evaluate(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`, target); }
async function check(name, action) { await action(); checks.push(name); console.log('PASS ' + name); }
const deadline = setTimeout(() => void finish(Error('Quick Import fixture exceeded 120 seconds')), 120000);
async function finish(error) {
  if (finished) return; finished = true; clearTimeout(deadline);
  if (error) console.error(error.stack || error);
  try {
    if (error && contents && !contents.isDestroyed()) await fs.writeFile(path.join(directory, 'failure.png'), (await contents.capturePage()).toPNG());
    if (foreign && !foreign.isDestroyed()) foreign.destroy(); await host?.dispose();
    if (owner && !owner.isDestroyed()) owner.destroy(); disposeMaintenance(); assert.equal(BrowserWindow.getAllWindows().length, 0);
  } catch (failure) { error ||= failure; }
  await fs.mkdir(directory, { recursive: true });
  const report = { result: error ? 'failed' : 'passed', checks, error: error ? String(error.stack || error) : null, errors, externalRequests, forbiddenCalls: forbidden, calls, lifecycle, helpOpens,
    actualHostAndIpc: true, actualPreloadAndRenderer: true, syntheticQuickImportService: true, syntheticDownloadWorker: true, loadedFromAsar: !!archiveArg, productRoot,
    rendererSandboxDisabled: app.commandLine.hasSwitch('no-sandbox'), visibilityUnexpected, nativeFloatingDisplaysSuppressed: true, suppressedDisplayRequests,
    realGameRead: false, realGameLaunched: false, realProviderConnected: false, realHardwareRead: false, realInputRead: false, realAudioOpened: false,
    realProfileRead: false, realUserProfileRead: false, realDesktopCaptured: false, realDownload: false, realNetworkUsed: false };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ directory, result: report.result, checks: checks.length })); app.exit(error ? 1 : 0);
}
process.on('uncaughtException', error => void finish(error)); process.on('unhandledRejection', error => void finish(error));
app.whenReady().then(async () => {
  await fs.mkdir(dataDirectory, { recursive: true }); await fs.mkdir(songs); await fs.mkdir(nextSongs);
  const historical = { id: '00000000-0000-4000-8000-000000000035', chartId: 'synthetic-history', endpoint: '/api/charts/00000000-0000-4000-8000-000000000035/abcdefghijkl/download-manifest', title: 'Fictional history', artist: 'Example Project', charter: 'Synthetic Charter', rootPath: songs, state: 'Completed', destination: path.join(songs, 'Historical'), folderName: 'Historical', receivedBytes: 1, totalBytes: 1, completedFiles: 1, totalFiles: 1, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' };
  await fs.writeFile(path.join(dataDirectory, 'download-state.json'), JSON.stringify({ version: 1, rootPath: songs, revision: 1, items: [historical] }), { flag: 'wx' });
  owner = new BrowserWindow({ width: 1280, height: 950, show: false, frame: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  owner.on('show', () => { visibilityUnexpected = true; owner.hide(); });
  const hostOptions = { dataDirectory, quickImportService: fakeService, quickImportRuntimePlatform: 'win32', drumVstService: fakeDrums,
    cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({ running: false, sessions: [] }), isCatalogueAvailable: () => catalogueAvailable, authorizeCatalogue: async () => catalogueAvailable,
    catalogueClient: { async load() { return { items: [], revision: 'quick-import-fixture', demo: false }; }, async artwork() { throw Error('Real artwork forbidden'); } },
    downloadWorker: { async run({ rootPath }) { const folderName = 'FictionalNewChart', destination = path.join(rootPath, folderName); await fs.mkdir(destination); return { folderName, destination, files: 1, totalBytes: 1 }; }, async discard() {}, async resolveCompleted({ destination }) { return destination; } },
    embedded: { ownerWindow: owner, attachView(value) {
      view = value; owner.contentView.addChildView(value); view.setBounds({ x: 0, y: 0, width: 1280, height: 950 }); contents = value.webContents;
      contents.on('console-message', (_event, detail) => { if (detail.level === 'error' || detail.level >= 3) errors.push(detail.message); });
      contents.on('render-process-gone', (_event, detail) => { if (!finished) errors.push(detail.reason); });
      contents.session.webRequest.onBeforeRequest((details, callback) => { const allowed = details.url.startsWith('chartshub-companion://') || details.url.startsWith('data:') || details.url === 'about:blank'; if (!allowed) externalRequests.push(details.url); callback({ cancel: !allowed }); });
    }, activate() { view.setVisible(true); } }
  };
  host = await createCompanionHost(hostOptions);
  host.setLanguage('fr'); await host.open(); await until(() => evaluate("!!document.querySelector('#quick-import-connect')"), 'Quick Import renderer');
  await check('Sandboxed public panel loads Quick Import before historical notifications without any automatic command', async () => {
    const preferences = contents.getLastWebPreferences(); assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
    assert.equal(owner.isVisible(), false); assert.deepEqual(calls, []); assert.equal(lifecycle[0], 'load'); assert(observations.some(value => value.items.some(item => item.id === historical.id && item.state === 'Completed')));
    assert.equal(host.snapshot().quickImport.selected, false); assert.equal(await evaluate("document.querySelector('#quick-import-connect').disabled"), true);
  });
  await check('French controls select and connect only through empty trusted IPC payloads with an explicit Songs folder', async () => {
    await host.library.selectRoot(songs); await until(() => evaluate("window.ChartsHubCompanion.getSnapshot().then(s=>s.library.settings.rootPath!==null)"), 'synthetic Songs selected');
    const beforeGuide = calls.length;
    const guide = await command('quickImport.openPackage');
    assert.equal(guide.ok, !archiveArg, 'Source fixture opens only the supplied local package; an ASAR-only fixture has no external optional package');
    assert.equal(packageOpens.length, archiveArg ? 0 : 1);
    assert.equal(calls.length, beforeGuide, 'Opening installation files never installs, selects a game or enables Quick Import');
    assert.equal((await command('quickImport.release')).ok, true);
    assert.equal(helpOpens.at(-1), 'https://github.com/LavaGang/MelonLoader/releases/tag/v0.7.3');
    assert.equal((await command('quickImport.prerequisites')).ok, true);
    assert.equal(helpOpens.at(-1), 'https://github.com/LavaGang/MelonLoader/blob/v0.7.3/README.md#requirements');
    assert.equal(host.snapshot().quickImport.selected, false);
    await click('#quick-import-choose-game'); await until(() => evaluate("!document.querySelector('#quick-import-connect').disabled"), 'synthetic selected game');
    assert.equal(calls.at(-1).name, 'quickImport.chooseGame'); await click('#quick-import-connect');
    await until(() => evaluate("document.querySelector('#quick-import-status').textContent==='Connecté'"), 'French connected status');
    assert(calls.every(value => Object.keys(value.payload).length === 0)); assert.equal(forbidden.fileDialog, 0);
    assert.equal(await evaluate("document.querySelectorAll('.quick-import-steps > li').length"), 5);
    assert.equal(await evaluate("document.querySelector('.quick-import-compatibility').textContent.includes('1.1.0.6142-final Stable')"), true);
  });
  await check('Actual download service forwards new queued downloading and completed states while historical downloads are never commands', async () => {
    const before = calls.length, queued = await host.downloads.enqueue({ chartId: 'synthetic-new', endpoint: '/api/charts/00000000-0000-4000-8000-000000000036/abcdefghijkl/download-manifest', title: 'Fictional new chart', artist: 'Example Project', charter: 'Synthetic Charter' });
    await until(() => observations.some(value => value.items.some(item => item.id === queued.id && item.state === 'Completed')), 'synthetic completion notification');
    for (const state of ['Queued', 'Downloading', 'Completed']) assert(observations.some(value => value.items.some(item => item.id === queued.id && item.state === state)));
    assert.equal(calls.length, before); assert.equal(host.downloads.status().items.find(item => item.id === historical.id).state, 'Completed');
    const completed = { id: queued.id, destination: path.join(songs, 'FictionalNewChart') };
    assert.equal(host.acceptDownloadedChart(completed), false); assert.deepEqual(mainCompletions, []);
    catalogueAvailable = true; host.acceptDownloadedChart(completed); assert.deepEqual(mainCompletions, [completed]); catalogueAvailable = false;
    assert.equal((await command('quickImport.observeCompletedDownload', completed)).ok, false); assert.deepEqual(mainCompletions, [completed]);
  });
  await check('English live import updates use their own controls and do not rebuild unrelated panel signatures', async () => {
    host.setLanguage('en'); await until(() => evaluate("document.querySelector('#quick-import-status').textContent==='Connected'"), 'English connected status');
    assert.equal(await evaluate("document.querySelector('#quick-import-refresh').textContent"), 'Refresh imports');
    await click('#quick-import-refresh'); await until(() => evaluate("document.querySelector('.quick-import-jobs').textContent.includes('Ready in Clone Hero')"), 'ready import label');
    assert.equal(await evaluate("(async()=>{const {controlSnapshotSignature}=await import('./panel-snapshot.js'),s=await window.ChartsHubCompanion.getSnapshot(),before=controlSnapshotSignature(s);s.quickImport.jobs=[];s.quickImport.busy=true;return before===controlSnapshotSignature(s);})()"), true);
    assert.equal(await evaluate("document.querySelector('.quick-import-steps').textContent.includes('Enable and connect')"), true);
  });
  await check('Malformed commands never reach the service and failures expose fixed codes without private exception text', async () => {
    const before = calls.length;
    for (const [name, payload] of [['quickImport.connect', null], ['quickImport.connect', { gamePath: 'C:\\Private\\game.exe' }], ['quickImport.chooseGame', []], ['quickImport.delete', {}], ['quickImport.openPackage', { path: 'private' }], ['quickImport.openPackage', { install: true }], ['quickImport.release', { url: 'https://other.test' }], ['quickImport.prerequisites', { platform: 'win32' }]]) assert.equal((await command(name, payload)).ok, false);
    assert.equal(calls.length, before); nextError = 'C:\\Private\\token=SECRET';
    const result = await command('quickImport.refresh'); assert.equal(result.ok, false); assert.equal(result.code, 'QUICK_IMPORT_FAILED'); assert(!JSON.stringify(result).includes('SECRET')); assert(!JSON.stringify(result).includes('Private'));
  });
  await check('A foreign sandboxed sender cannot read or invoke Quick Import capabilities', async () => {
    const probe = path.join(directory, 'probe.cjs'); await fs.writeFile(probe, "const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('FixtureProbe',{read:()=>ipcRenderer.invoke('companion:snapshot'),connect:()=>ipcRenderer.invoke('companion:command','quickImport.connect',{})});", { flag: 'wx' });
    foreign = new BrowserWindow({ show: false, webPreferences: { session: contents.session, preload: probe, contextIsolation: true, nodeIntegration: false, sandbox: true } }); await foreign.loadURL('about:blank');
    const before = calls.length; assert.equal(await evaluate('window.FixtureProbe.read()', foreign.webContents), null); assert.equal((await evaluate('window.FixtureProbe.connect()', foreign.webContents)).ok, false); assert.equal(calls.length, before); foreign.destroy(); foreign = null;
  });
  await check('Actual read-only overlay and player snapshots exclude Quick Import and cannot invoke its commands', async () => {
    await host.setOverlay(true); const overlay = host.getOverlay(); assert(overlay); assert.equal(overlay.isVisible(), false);
    const before = calls.length; assert.equal((await evaluate('window.ChartsHubCompanion.getSnapshot()', overlay.webContents)).quickImport, undefined); assert.equal((await command('quickImport.connect', {}, overlay.webContents)).ok, false);
    assert.equal((await command('quickImport.openPackage', {}, overlay.webContents)).ok, false);
    assert.equal((await command('capture.player')).ok, true); const player = host.getPlayerWidget(); assert(player); assert.equal(player.isVisible(), false);
    assert.equal((await evaluate('window.ChartsHubCompanion.getSnapshot()', player.webContents)).quickImport, undefined); assert.equal((await command('quickImport.connect', {}, player.webContents)).ok, false);
    assert.equal((await command('quickImport.openPackage', {}, player.webContents)).ok, false);
    assert.equal(calls.length, before); await host.setOverlay(false);
  });
  await check('Songs changes notify the service and maintenance stop and disposal revoke command access without touching a game', async () => {
    const updates = lifecycle.filter(value => value === 'update').length; await host.library.selectRoot(nextSongs); assert(lifecycle.filter(value => value === 'update').length > updates);
    const stops = lifecycle.filter(value => value === 'stop').length; host.setMaintenanceLocked(true); assert.equal(lifecycle.filter(value => value === 'stop').length, stops + 1);
    catalogueAvailable = true; const completions = mainCompletions.length; assert.equal(host.acceptDownloadedChart({ id: jobId, destination: songs }), false); assert.equal(mainCompletions.length, completions);
    const before = calls.length; assert.equal((await command('quickImport.connect')).ok, false); assert.equal(calls.length, before); host.setMaintenanceLocked(false);
    await host.stop(); assert(lifecycle.filter(value => value === 'stop').length >= stops + 2); assert.equal(state.connected, false); await host.dispose(); assert(lifecycle.includes('dispose'));
    assert.equal(host.acceptDownloadedChart({ id: jobId, destination: songs }), false); assert.equal(mainCompletions.length, completions);
    // Main platform wins even when an injected service claims support. These
    // cases run through the same trusted preload/IPC, not a browser OS string.
    for (const platform of ['linux', 'darwin', 'freebsd']) {
      const localSongs = path.join(directory, platform + '-Songs'); await fs.mkdir(localSongs);
      host = await createCompanionHost({ ...hostOptions, dataDirectory: path.join(directory, platform + '-profile'), quickImportRuntimePlatform: platform });
      await host.open(); await until(() => evaluate("!!document.querySelector('#quick-import-guide-system')"), platform + ' guide');
      const expected = platform === 'freebsd' ? 'unknown' : platform;
      assert.equal(host.snapshot().quickImport.platform, expected); assert.equal(host.snapshot().quickImport.supported, false);
      assert.equal(await evaluate("document.querySelector('#quick-import-guide-system').value"), expected);
      const beforeCommands = calls.length, beforeFolders = packageOpens.length;
      for (const name of ['chooseGame', 'connect', 'disable', 'refresh', 'openPackage']) assert.equal((await command('quickImport.' + name)).code, 'QUICK_IMPORT_WINDOWS_REQUIRED');
      assert.equal(calls.length, beforeCommands); assert.equal(packageOpens.length, beforeFolders);
      assert.equal((await command('quickImport.prerequisites')).ok, true);
      assert.equal(helpOpens.at(-1), platform === 'darwin' ? 'https://github.com/LavaGang/MelonLoader.Installer#how-does-it-work' : 'https://github.com/LavaGang/MelonWiki/blob/master/docs/gettingstarted.md');
      await host.library.selectRoot(localSongs);
      await host.downloads.selectRoot(localSongs);
      const download = await host.downloads.enqueue({ chartId: 'synthetic-' + platform, endpoint: '/api/charts/00000000-0000-4000-8000-000000000036/abcdefghijkl/download-manifest', title: 'Fictional chart', artist: 'Example Project', charter: 'Synthetic Charter' });
      await until(() => host.downloads.status().items.some(item => item.id === download.id && item.state === 'Completed'), platform + ' normal download');
      assert.equal(calls.length, beforeCommands, 'Unsupported Quick Import never blocks or starts from a normal download');
      await host.stop(); await delay(80); await host.dispose();
    }
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []); assert.deepEqual(forbidden, { capture: 0, external: 0, fileDialog: 0, drumCommand: 0, realDownload: 0 });
  });
  assert.equal(checks.length, 8); await finish();
}).catch(error => void finish(error));
