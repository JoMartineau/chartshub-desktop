'use strict';
// Actual public Host/preload/renderer, accepted Windows pipe and OBS browser.
// Every chart, provider, descriptor and profile belongs to this fixture.
const { app, BrowserWindow, desktopCapturer, dialog, shell } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), net = require('node:net'), assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
if (process.env.NODE_PATH) require('node:module').Module._initPaths();
const { registerFixtureMaintenance, revealWorkspace } = require('./workspace-input.cjs');
const disposeMaintenance = registerFixtureMaintenance();
const archiveArg = process.argv.find(value => value.startsWith('--fixture-asar='));
const productRoot = archiveArg ? path.resolve(archiveArg.slice('--fixture-asar='.length)) : path.resolve(__dirname, '..');
if (archiveArg && !productRoot.endsWith('.asar')) throw Error('Actual ASAR required');
const outputArg = process.argv.find(value => value.startsWith('--fixture-output='));
if (!outputArg) throw Error('Explicit disposable output required');
const output = path.resolve(outputArg.slice('--fixture-output='.length)), workspace = path.resolve(__dirname, '../../..');
const outputRoots = [path.join(workspace, 'outputs'), path.resolve(__dirname, '../outputs')];
if (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' && typeof process.env.RUNNER_TEMP === 'string' && path.isAbsolute(process.env.RUNNER_TEMP) && path.resolve(process.env.RUNNER_TEMP) !== path.parse(process.env.RUNNER_TEMP).root) outputRoots.push(path.resolve(process.env.RUNNER_TEMP));
if (!outputRoots.some(root => { const relative = path.relative(root, output); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); })) throw Error('Fresh workspace or CI temporary output required');
const directory = path.join(output, 'game-widgets-' + randomUUID().slice(0, 8)), dataDirectory = path.join(directory, 'synthetic-companion');
const songs = path.join(directory, 'Songs'), settingsFile = path.join(dataDirectory, 'settings.json');
app.setPath('userData', path.join(directory, 'profile')); app.setPath('sessionData', path.join(directory, 'session')); process.env.LOCALAPPDATA = path.join(directory, 'local-app-data');
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
let suppressedDisplays = 0;
app.on('browser-window-created', (_event, window) => { window.showInactive = () => { suppressedDisplays++; }; });
const forbiddenCalls = { hardware: 0, setup: 0, capture: 0, external: 0, dialog: 0, download: 0 };
const forbiddenService = kind => new Proxy({}, { get() { forbiddenCalls[kind]++; throw Error('Retired ' + kind + ' must not be accessed'); } });
desktopCapturer.getSources = async () => { forbiddenCalls.capture++; throw Error('Desktop capture forbidden'); };
dialog.showOpenDialog = async () => { forbiddenCalls.dialog++; throw Error('File picker forbidden'); };
shell.openExternal = async () => { forbiddenCalls.external++; throw Error('External launch forbidden'); };
const { createCompanionHost, registerCompanionScheme } = require(path.join(productRoot, 'companion/host.cjs'));
const contract = require(path.join(productRoot, 'companion/clonehero-telemetry-contract.cjs'));
const { SUPPORTED_BUILDS } = require(path.join(productRoot, 'companion/clonehero-telemetry-source.cjs'));
registerCompanionScheme();
const provider = { id: 'chartshub.clonehero.il2cpp', version: '0.2.2' }, game = SUPPORTED_BUILDS[0];
const sessionId = 'owned-optional-widget-fixture', metadata = { title: 'Synthetic chart', artist: 'Fixture group', charter: 'Fixture author', instrument: 'Guitar', difficulty: 'Expert' };
const caps = Object.fromEntries(contract.CAPABILITIES.map(key => [key, ['hitTiming', 'clock', 'songMetadata', 'attemptResults'].includes(key)]));
const checks = [], errors = [], externalRequests = [], peers = [], sourceHashes = {};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceNames = ['companion/host.cjs', 'companion/preload.cjs', 'companion/gameplay-measurements.cjs', 'companion/clonehero-telemetry-source.cjs', 'companion/clonehero-telemetry-model.cjs', 'companion/clonehero-telemetry-view.cjs', 'companion/song-visuals.cjs', 'companion/song-lyrics-parser.cjs', 'companion/ui/panel.js', 'companion/ui/gameplay-features.js'];
let host, owner, contents, view, obs, foreign, server, peer, heartbeat, descriptor, originalSettings, settingsDocument, finished = false, visibilityUnexpected = false, connections = 0, sequence = 0, attemptId = 'owned-first-attempt';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(code, target = contents) { let timer; try { return await Promise.race([target.executeJavaScript(code), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Renderer evaluation timed out')), 10000); })]); } finally { clearTimeout(timer); } }
async function until(check, label, timeout = 10000) { const end = Date.now() + timeout; do { if (await check()) return; await delay(25); } while (Date.now() < end); throw Error('Timed out: ' + label); }
async function check(name, action) { await action(); checks.push(name); console.log('PASS ' + name); }
const flags = () => host.snapshot().gameWidgets;
const widgetIds = () => evaluate("[...document.querySelectorAll('#widget-settings input[data-widget-id]')].map(n=>n.dataset.widgetId)");
const lyricNode = "#game-preview [data-widget-id='song-lyrics'] .companion-widget-text";
const accuracyNode = "#game-preview [data-widget-id='gameplay-accuracy'] .companion-widget-text";
const obsLyric = "[data-widget-id='song-lyrics'] .companion-widget-text";
async function command(name, payload = {}, target = contents) { return evaluate(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`, target); }
async function configure(accuracy, lyrics) { const result = await command('gameWidgets.configure', { revision: flags().revision, accuracy, lyrics }); assert.equal(result.ok, true, JSON.stringify(result)); await until(() => flags().accuracy === accuracy && flags().lyrics === lyrics && flags().busy !== true, 'integration flags applied'); }
function send(type, data = {}) { assert(peer && !peer.destroyed); peer.write(JSON.stringify({ schema: contract.SCHEMA, provider, game, sessionId, attemptId, playerId: 0, sequence: sequence++, type, data }) + '\n'); }
function state(phase, position, speed = 1) { send('state', { phase, metadata, ...(position === undefined ? {} : { clock: { positionSeconds: position, durationSeconds: 12, ...(speed === null ? {} : { speed }) } }) }); }
async function noPublicRecords() { await assert.rejects(fs.readFile(path.join(dataDirectory, 'clonehero-records.json')), error => error.code === 'ENOENT', 'Optional widget sessions must not create legacy record history'); }
async function settingsUnchanged() { const state = host.snapshot().state; assert.equal(state.widgets.instances.length, 13); assert.deepEqual(state.widgets.instances, settingsDocument.widgets); assert.deepEqual(state.stream, settingsDocument.stream); assert((await fs.readFile(settingsFile)).equals(originalSettings), 'Optional session toggles must preserve historical widget settings bytes'); await noPublicRecords(); }
function projectedState(state, optionalIds) { const ids = [...settingsDocument.widgets.filter(widget => !widget.id.startsWith('gameplay-') && !widget.id.startsWith('session-') && widget.id !== 'song-lyrics').map(widget => widget.id), ...optionalIds]; assert.deepEqual(state.widgets.instances.map(widget => widget.id).sort(), ids.sort()); assert.equal(state.stream.layout.length, ids.length); assert(state.stream.layout.every(item => ids.includes(item.id))); }
async function obsState() { return evaluate("new Promise((resolve,reject)=>{const u=new URL('/events',location.href);u.protocol='ws:';u.search=location.search;const s=new WebSocket(u),t=setTimeout(()=>{s.close();reject(Error('Owned OBS snapshot unavailable'));},3000);s.onmessage=e=>{const v=JSON.parse(e.data);if(v.type==='snapshot'){clearTimeout(t);s.close();resolve(v.state);}};s.onerror=()=>{clearTimeout(t);s.close();reject(Error('Owned OBS snapshot rejected'));};})", obs.webContents); }
async function createHost() {
  host = await createCompanionHost({ dataDirectory, calibrationHardwareService: forbiddenService('hardware'), connectorSetupService: forbiddenService('setup'), cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({ running: false, sessions: [] }), isCatalogueAvailable: () => true, authorizeCatalogue: async () => true,
    catalogueClient: { async load() { return { items: [], revision: 'optional-widget-fixture', demo: false }; }, async artwork() { throw Error('Artwork forbidden'); } },
    downloadWorker: { async run() { forbiddenCalls.download++; throw Error('Download forbidden'); }, async discard() {}, async resolveCompleted() { return null; } },
    embedded: { ownerWindow: owner, attachView(value) { view = value; owner.contentView.addChildView(value); view.setBounds({ x: 0, y: 0, width: 1280, height: 950 }); contents = value.webContents;
      contents.on('console-message', (_event, detail) => { if (detail.level === 'error' || detail.level >= 3) errors.push(detail.message); });
      contents.on('render-process-gone', (_event, detail) => { if (!finished) errors.push(detail.reason); });
      contents.session.webRequest.onBeforeRequest((details, callback) => { const allowed = details.url.startsWith('chartshub-companion://') || details.url.startsWith('data:') || details.url === 'about:blank' || /^(?:http|ws):\/\/127\.0\.0\.1:\d+\//.test(details.url); if (!allowed) externalRequests.push(details.url); callback({ cancel: !allowed }); });
    }, activate() { view.setVisible(true); } }
  });
  await host.open(); await until(() => evaluate("!!document.querySelector('#game-widget-integrations')&&!!window.ChartshubWorkspaceNavigation"), 'optional integration renderer ready');
}
const deadline = setTimeout(() => void finish(Error('Optional game widget fixture exceeded 120 seconds')), 120000);
async function finish(error) {
  if (finished) return; finished = true; clearTimeout(deadline); clearInterval(heartbeat); if (error) console.error(error.stack || error);
  try { if (foreign && !foreign.isDestroyed()) foreign.destroy(); if (obs && !obs.isDestroyed()) obs.destroy(); await host?.dispose(); await noPublicRecords(); for (const socket of peers) socket.destroy(); if (server?.listening) await new Promise(resolve => server.close(resolve)); if (owner && !owner.isDestroyed()) owner.destroy(); disposeMaintenance(); assert.equal(BrowserWindow.getAllWindows().length, 0); if (originalSettings) assert((await fs.readFile(settingsFile)).equals(originalSettings), 'Historical widget settings changed during disposal'); } catch (failure) { error ||= failure; }
  const after = {}; for (const name of sourceNames) after[name] = hash(await fs.readFile(path.join(productRoot, name))); if (Object.keys(sourceHashes).length) try { assert.deepEqual(after, sourceHashes); } catch (failure) { error ||= failure; }
  await fs.mkdir(directory, { recursive: true });
  const report = { result: error ? 'failed' : 'passed', checks, error: error ? String(error.stack || error) : null, errors, externalRequests, forbiddenCalls,
    loadedFromAsar: !!archiveArg, productRoot, actualHostAndIpc: true, actualPreloadAndRenderer: true, actualTelemetrySourceAndModel: true, actualWindowsNamedPipe: true, actualLocalObsServerAndBrowser: true, actualSyntheticLibrary: true, syntheticGameFrames: true,
    sourceHashesBefore: sourceHashes, sourceHashesAfter: after, rendererSandboxDisabled: app.commandLine.hasSwitch('no-sandbox'), visibilityUnexpected, nativeFloatingDisplaysSuppressed: true, suppressedDisplays, connections,
    calibrationExposed: false, realGameRead: false, realGameLaunched: false, realProviderConnected: false, realHardwareRead: false, realInputRead: false, realAudioOpened: false, realProfileRead: false, realUserProfileRead: false, realDesktopCaptured: false, realDownload: false, realNetworkUsed: false, installationPerformed: false };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ directory, result: report.result, checks: checks.length })); app.exit(error ? 1 : 0);
}
process.on('uncaughtException', error => void finish(error)); process.on('unhandledRejection', error => void finish(error));
app.whenReady().then(async () => {
  await fs.mkdir(dataDirectory, { recursive: true }); for (const name of sourceNames) sourceHashes[name] = hash(await fs.readFile(path.join(productRoot, name)));
  const folder = path.join(songs, 'Fixture'); await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'song.ini'), '[song]\nname=Synthetic chart\nartist=Fixture group\ncharter=Fixture author\nsong_length=12000\n');
  await fs.writeFile(path.join(folder, 'notes.chart'), '[Song]\n{\nResolution = 192\n}\n[SyncTrack]\n{\n0 = B 120000\n}\n[Events]\n{\n0 = E "phrase_start"\n0 = E "lyric Synthetic"\n192 = E "lyric marker_one"\n1536 = E "phrase_end"\n2304 = E "phrase_start"\n2304 = E "lyric Next_marker"\n3840 = E "phrase_end"\n}\n[ExpertSingle]\n{\n0 = N 0 0\n}\n');
  const { pathToFileURL } = require('node:url');
  const [core, themes, stream, storage] = await Promise.all(['widgets/core/index.js', 'themes/ThemeService.js', 'overlay/stream/StreamConfig.js', 'storage/SettingsRepository.js'].map(name => import(pathToFileURL(path.join(productRoot, 'companion/dist', name)).href)));
  const defaults = core.createDefaultWidgets(), document = core.ensureGameplayDocument({ version: 3, widgets: defaults, theme: themes.createDefaultTheme(), stream: stream.createDefaultStream(defaults) });
  const free = net.createServer(); await new Promise(resolve => free.listen(0, '127.0.0.1', resolve)); document.stream.port = free.address().port; await new Promise(resolve => free.close(resolve));
  for (const widget of document.widgets) if (['gameplay.accuracy', 'song.lyrics'].includes(widget.type)) { widget.enabled = true; widget.visibility = { game: true, stream: true }; }
  const validated = storage.validateSettings(document); assert.equal(validated.widgets.length, 13); settingsDocument = validated; originalSettings = Buffer.from(JSON.stringify(validated, null, 2) + '\n'); await fs.writeFile(settingsFile, originalSettings, { flag: 'wx' });
  const connection = path.join(process.env.LOCALAPPDATA, 'ChartsHub/Telemetry/v1'); await fs.mkdir(connection, { recursive: true });
  descriptor = { schema: contract.DESCRIPTOR_SCHEMA, provider, game, sessionId, pipeName: 'ChartsHub.CloneHero.Telemetry.' + randomUUID(), nonce: 'e'.repeat(64), pid: process.pid };
  server = net.createServer(socket => { peers.push(socket); socket.on('error', () => {}); let buffer = '', authenticated = false;
    socket.on('data', bytes => { if (authenticated) return; buffer += bytes.toString(); if (!buffer.includes('\n')) return; const hello = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); assert.equal(hello.nonce, descriptor.nonce); authenticated = true; connections++; peer = socket; send('hello', { capabilities: caps, coverage: 'from-attempt-start', state: { phase: 'paused', metadata, clock: { positionSeconds: 1, durationSeconds: 12, speed: 1 } } }); });
  }); await new Promise((resolve, reject) => { server.once('error', reject); server.listen('\\\\.\\pipe\\' + descriptor.pipeName, resolve); }); await fs.writeFile(path.join(connection, 'connection.json'), JSON.stringify(descriptor));
  heartbeat = setInterval(() => { if (peer && !peer.destroyed) send('heartbeat'); }, 700);
  owner = new BrowserWindow({ width: 1280, height: 950, show: false, frame: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } }); owner.on('show', () => { visibilityUnexpected = true; owner.hide(); });
  await createHost();
  await check('Public integrations are available but no provider is contacted and no optional widget is offered at startup', async () => {
    await delay(100); assert.equal(connections, 0); for (const key of ['accuracy', 'lyrics', 'enabled', 'connected']) assert.equal(flags()[key], false, key); assert.equal(host.snapshot().state.performance, null); assert.equal(host.snapshot().state.lyrics, null);
    assert.deepEqual(host.snapshot().features, { gameplayMeasurements: false, calibrationBeta: false, gameWidgets: true }); assert.equal((await widgetIds()).length, 5); assert.equal(contents.getLastWebPreferences().sandbox, true); assert.equal(owner.isVisible(), false);
  });
  await check('French and English group independent unchecked choices beside Quick Import without auto activation', async () => {
    for (const language of ['fr', 'en']) { host.setLanguage(language); await until(() => evaluate('document.documentElement.lang===' + JSON.stringify(language)), 'language ' + language); await revealWorkspace({ webContents: contents }, '#game-widget-integrations');
      assert.deepEqual(await evaluate("({accuracy:document.querySelector('#game-widgets-accuracy').checked,lyrics:document.querySelector('#game-widgets-lyrics').checked,group:document.querySelector('#game-widget-integrations').closest('#game-integrations-panel')!==null,quick:document.querySelector('#quick-import-panel').closest('#game-integrations-panel')!==null})"), { accuracy: false, lyrics: false, group: true, quick: true });
    } assert.equal(connections, 0); await settingsUnchanged();
  });
  await check('Malformed and stale integration commands cannot connect or change either session option', async () => {
    for (const payload of [null, {}, { revision: flags().revision, accuracy: 'true', lyrics: false }, { revision: flags().revision, accuracy: true, lyrics: false, gamePath: 'PRIVATE' }, { revision: -1, accuracy: true, lyrics: false }, { revision: flags().revision + 100, accuracy: true, lyrics: false }]) assert.equal((await command('gameWidgets.configure', payload)).ok, false);
    assert.equal(connections, 0); assert.equal(flags().enabled, false); await settingsUnchanged();
  });
  await check('Accuracy opt-in uses actual accepted pipe frames and exact timing statistics without enabling lyrics', async () => {
    await configure(true, false); await until(() => flags().connected, 'owned provider connected'); assert.equal(connections, 1); state('playing', 1); [-10, 0, 10].forEach(offsetMs => send('hit', { offsetMs }));
    await until(() => host.snapshot().state.performance?.timing?.sampleCount === 3, 'three accepted judgments'); const value = host.snapshot().state.performance.timing;
    assert.equal(value.meanOffsetMs, 0); assert.equal(value.lastOffsetMs, 10); assert(Math.abs(value.meanAbsoluteOffsetMs - 20 / 3) < 1e-10); assert(Math.abs(value.standardDeviationMs - Math.sqrt(200 / 3)) < 1e-10); assert.equal(value.withinWindowPercent, 100); assert.equal(host.snapshot().state.lyrics, null);
    await until(async () => (await widgetIds()).length === 6, 'only Accuracy added'); assert(!(await widgetIds()).includes('gameplay-combo')); await settingsUnchanged();
  });
  await check('Opting out clears readings and disconnects immediately while retaining every historical widget setting', async () => {
    await configure(false, false); await until(() => peer.destroyed && !flags().connected, 'provider disconnected on opt-out'); assert.equal(host.snapshot().state.performance, null); assert.equal(host.snapshot().state.lyrics, null); await until(async () => (await widgetIds()).length === 5, 'metadata-only controls restored'); await settingsUnchanged();
  });
  await host.library.selectRoot(songs); await host.library.requestScan('full'); await until(() => host.library.status().status === 'ready', 'owned chart scan');
  await check('Lyrics-only opt-in resolves the owned chart and exposes the current phrase without Accuracy', async () => {
    await configure(false, true); await until(() => flags().connected, 'lyrics provider connected'); state('paused', 1); await until(() => host.snapshot().state.lyrics?.current === 'Synthetic marker one', 'synchronized chart words');
    const performance = host.snapshot().state.performance;
    assert.equal(performance.connected, true); assert.equal(performance.capabilities.hitTiming, false); assert.equal(performance.capabilities.clock, true); assert.equal(performance.hasChartIdentity, false); assert.deepEqual(performance.history, []);
    assert.deepEqual(performance.timing, { lastOffsetMs: null, meanOffsetMs: null, meanAbsoluteOffsetMs: null, standardDeviationMs: null, withinWindowPercent: null, windowMs: 20, sampleCount: 0, coverage: 'incomplete' });
    assert(Object.values(performance.active.stats).every(value => value === null)); assert(Object.values(performance.comparison).every(value => value === null)); assert(Object.values(performance.session).every(value => value === 0));
    assert.deepEqual(performance.active.metadata, metadata); assert.deepEqual(performance.active.clock, { positionSeconds: 1, durationSeconds: 12, speed: 1 });
    await until(async () => (await widgetIds()).includes('song-lyrics'), 'lyrics settings offered'); assert(!(await widgetIds()).includes('gameplay-accuracy')); await until(() => evaluate(`document.querySelector(${JSON.stringify(lyricNode)})?.textContent==='Synthetic marker one'`), 'actual game preview phrase'); await settingsUnchanged();
    send('attemptEnd', { completed: true, state: { phase: 'results', metadata } }); await until(() => host.snapshot().state.performance?.phase === 'results', 'accepted complete attempt in public lyrics session'); assert.deepEqual(host.snapshot().state.performance.history, []); await noPublicRecords(); attemptId = 'owned-second-attempt'; state('paused', 1); await until(() => host.snapshot().state.performance?.phase === 'paused' && host.snapshot().state.lyrics?.current === 'Synthetic marker one', 'new public attempt restores only current words');
  });
  await check('Lyrics follow pause, native speed, backwards seek and gaps and reject a speedless clock', async () => {
    state('paused', 7, .75); await until(() => host.snapshot().state.lyrics?.current === 'Next marker', 'forward seek'); state('paused', 1, 1.5); await until(() => host.snapshot().state.lyrics?.current === 'Synthetic marker one', 'backward seek');
    state('playing', 4.5, .75); await until(() => host.snapshot().state.lyrics === null, 'instrumental gap'); state('paused', 1, null); await until(() => host.snapshot().visuals.clockReady === false, 'missing native speed rejected'); assert.equal(host.snapshot().state.lyrics, null); state('paused', 1, 1); await until(() => host.snapshot().state.lyrics?.current === 'Synthetic marker one', 'known clock restored');
  });
  await check('Both independent choices share one active provider and only Accuracy and Lyrics join metadata controls', async () => {
    const before = connections; await configure(true, true); assert.equal(connections, before); state('playing', 1); send('hit', { offsetMs: 4 }); await until(() => host.snapshot().state.performance?.timing?.sampleCount > 0 && host.snapshot().state.lyrics?.current === 'Synthetic marker one', 'both feeds available'); await until(async () => (await widgetIds()).length === 7, 'two optional controls offered');
    assert.deepEqual((await widgetIds()).filter(id => id.startsWith('gameplay-') || id.startsWith('session-')), ['gameplay-accuracy']); await settingsUnchanged();
  });
  await check('Actual authenticated OBS renders the opted-in text and timing and revokes each feed independently', async () => {
    state('paused', 1); assert.equal((await command('stream.enabled', { enabled: true })).ok, true);
    obs = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } }); await obs.loadURL(host.snapshot().stream.url);
    await until(() => evaluate(`document.querySelector(${JSON.stringify(obsLyric)})?.textContent==='Synthetic marker one'`, obs.webContents), 'OBS synchronized phrase'); await until(() => evaluate("!!document.querySelector('[data-widget-id=\"gameplay-accuracy\"]')", obs.webContents), 'OBS actual timing widget');
    assert.equal(await evaluate('typeof window.ChartsHubCompanion', obs.webContents), 'undefined'); projectedState(await obsState(), ['gameplay-accuracy', 'song-lyrics']);
    await configure(true, false); await until(() => evaluate(`!document.querySelector(${JSON.stringify(obsLyric)})`, obs.webContents), 'OBS lyrics removed on opt-out'); assert(flags().accuracy && !flags().lyrics); assert.equal(host.snapshot().state.lyrics, null); projectedState(await obsState(), ['gameplay-accuracy']);
    await configure(false, false); projectedState(await obsState(), []); await configure(true, false); await until(() => flags().connected, 'Accuracy provider restored for sender checks'); await settingsUnchanged();
  });
  await check('Foreign and read-only overlay senders cannot activate or configure game integrations', async () => {
    const probe = path.join(directory, 'probe.cjs'); await fs.writeFile(probe, "const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('FixtureProbe',{read:()=>ipcRenderer.invoke('companion:snapshot'),configure:p=>ipcRenderer.invoke('companion:command','gameWidgets.configure',p)});", { flag: 'wx' });
    foreign = new BrowserWindow({ show: false, webPreferences: { session: contents.session, preload: probe, contextIsolation: true, nodeIntegration: false, sandbox: true } }); await foreign.loadURL('about:blank'); const before = flags().revision;
    assert.equal(await evaluate('window.FixtureProbe.read()', foreign.webContents), null); assert.equal((await evaluate(`window.FixtureProbe.configure(${JSON.stringify({ revision: before, accuracy: false, lyrics: true })})`, foreign.webContents)).ok, false); assert.equal(flags().revision, before); foreign.destroy(); foreign = null;
    await host.setOverlay(true); const overlay = host.getOverlay(); assert(overlay); assert.equal(overlay.isVisible(), false); const readOnly = await evaluate('window.ChartsHubCompanion.getSnapshot()', overlay.webContents); assert.equal(readOnly.gameWidgets, undefined); assert.equal(readOnly.gameModPreflight, undefined); projectedState(readOnly.state, ['gameplay-accuracy']); assert.equal((await command('gameWidgets.configure', { revision: before, accuracy: false, lyrics: true }, overlay.webContents)).ok, false); assert.equal(flags().revision, before); await host.setOverlay(false);
  });
  await check('Menu, provider loss and an unvalidated build cannot expose measurements or calibration and installation capabilities', async () => {
    state('menu'); await until(() => host.snapshot().state.performance?.phase === 'menu', 'native menu phase'); await until(() => evaluate("!document.querySelector('[data-widget-id=\"gameplay-accuracy\"]')", obs.webContents), 'OBS timing hidden outside chart');
    peer.destroy(); await until(() => !flags().connected && !host.snapshot().state.performance?.connected && (host.snapshot().state.performance?.timing?.sampleCount ?? 0) === 0, 'provider loss revokes timing');
    await configure(false, false); await fs.writeFile(path.join(connection, 'connection.json'), JSON.stringify({ ...descriptor, game: { ...game, gameAssemblySha256: 'f'.repeat(64) } })); const before = connections;
    await configure(true, false); await until(() => flags().status === 'unsupported', 'unvalidated fingerprint rejected'); assert.equal(flags().reason, 'UNVALIDATED_GAME_BUILD'); assert.equal(connections, before, 'No transport may open for an unvalidated game fingerprint'); assert.equal(host.snapshot().state.performance?.timing?.sampleCount ?? 0, 0);
    for (const [name, payload] of [['telemetry.hardwareRefresh', {}], ['telemetry.connectorChoose', {}], ['telemetry.connectorPrepare', { hideConsole: true }], ['telemetry.connectorInstall', { planId: randomUUID(), confirmation: true }], ['telemetry.calibrationStart', { stage: 'audio', settingMs: 0, source: 'gameplay' }], ['telemetry.calibrationFinish', {}], ['telemetry.guide', {}]]) assert.equal((await command(name, payload)).ok, false, name);
    assert.equal(await evaluate("document.querySelector('#calibration-panel').hidden&&document.querySelector('#calibration-controls').childElementCount===0"), true); await settingsUnchanged();
  });
  await check('Maintenance and a fresh Host revoke session choices without opening hardware, a game or saved settings', async () => {
    host.setMaintenanceLocked(true); for (const key of ['accuracy', 'lyrics', 'enabled', 'connected']) assert.equal(flags()[key], false, key); assert.equal((await command('gameWidgets.configure', { revision: flags().revision, accuracy: true, lyrics: true })).ok, false); host.setMaintenanceLocked(false);
    if (obs && !obs.isDestroyed()) { obs.destroy(); obs = null; } await host.dispose(); const before = connections; await createHost(); await delay(100); assert.equal(connections, before); for (const key of ['accuracy', 'lyrics', 'enabled', 'connected']) assert.equal(flags()[key], false, key); assert.equal(host.snapshot().state.performance, null); assert.equal(host.snapshot().state.lyrics, null);
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []); assert.deepEqual(forbiddenCalls, { hardware: 0, setup: 0, capture: 0, external: 0, dialog: 0, download: 0 }); await settingsUnchanged();
  });
  assert.equal(checks.length, 12); await finish();
}).catch(error => void finish(error));
