'use strict';
// Actual sandboxed UI, preload, IPC, host, sync client/service/store/worker and
// library scanner. Only the upstream transport and unrelated native services
// are synthetic; every installed file belongs to this fresh output profile.
const { app, BrowserWindow, desktopCapturer, dialog, shell } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { registerFixtureMaintenance, revealWorkspace } = require('./workspace-input.cjs');
const disposeMaintenance = registerFixtureMaintenance();
const outputArg = process.argv.find(value => value.startsWith('--fixture-output='));
if (!outputArg) throw Error('Explicit disposable workspace output required');
const output = path.resolve(outputArg.slice('--fixture-output='.length));
const workspace = path.resolve(__dirname, '../../..');
const outputRoots = [path.join(workspace, 'outputs'), path.resolve(__dirname, '../outputs')];
if (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' && path.isAbsolute(process.env.RUNNER_TEMP || '') && path.resolve(process.env.RUNNER_TEMP) !== path.parse(process.env.RUNNER_TEMP).root) outputRoots.push(path.resolve(process.env.RUNNER_TEMP));
if (!outputRoots.some(root => { const relative = path.relative(root, output); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); })) throw Error('Output must be below workspace outputs or the CI runner temporary directory');
const directory = path.join(output, 'catalogue-sync-' + randomUUID().slice(0, 8));
const dataDirectory = path.join(directory, 'synthetic-companion'), songs = path.join(directory, 'Songs');
app.setPath('userData', path.join(directory, 'profile')); app.setPath('sessionData', path.join(directory, 'session'));
process.env.LOCALAPPDATA = path.join(directory, 'local-app-data');
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const { createCompanionHost, registerCompanionScheme } = require('../companion/host.cjs');
const { createCatalogueSyncClient } = require('../companion/catalogue-sync-client.cjs');
const { createCatalogueSyncWorker } = require('../companion/catalogue-sync-worker.cjs');
const { defaultSettings } = require('../companion/drum-vst-model.cjs');
registerCompanionScheme();
const checks = [], errors = [], externalRequests = [], requests = [], completions = [], imports = [];
const screenshots = [];
const forbidden = { capture: 0, external: 0, fileDialog: 0, drumCommand: 0 };
desktopCapturer.getSources = async () => { forbidden.capture++; throw Error('Real capture forbidden'); };
shell.openExternal = async () => { forbidden.external++; throw Error('External launch forbidden'); };
dialog.showOpenDialog = async () => { forbidden.fileDialog++; throw Error('Real folder selection forbidden'); };
let host, owner, view, contents, finished = false, visibilityUnexpected = false, gate = true, gated = false, catalogueAvailable = true;
const hash = value => createHash('sha256').update(value).digest('hex');
const folderId = '00000000-0000-4000-8000-000000000077';
const rows = [0, 1].map(index => ({ chartId: 'sync-demo-' + index, title: 'Signal de test ' + index, artist: 'Groupe Exemple', charter: 'Charter Démo', endpoint: `/api/charts/${folderId}/SyntheticSource${index}000/download-manifest`, bytes: [
  Buffer.from(`[song]\nname = Signal de test ${index}\nartist = Groupe Exemple\ncharter = Charter Demo\nsong_length = 25000\ndiff_guitar = 4\n`),
  Buffer.from('[Song]\n{\n Resolution = 192\n}\n[SyncTrack]\n{\n 0 = B 120000\n}\n[ExpertSingle]\n{\n 0 = N 0 0\n 192 = N 1 0\n}\n'),
  Buffer.from('Synthetic audio bytes; this fixture never opens or plays audio. ' + index)
] }));
const names = ['song.ini', 'notes.chart', 'song.ogg'];
function manifest(row) {
  const files = row.bytes.map((bytes, index) => { const parts = [names[index]], sha256 = hash(bytes), size = bytes.length; return { parts, size, sha256, revision: hash(JSON.stringify(['content', parts, size, sha256])), url: row.endpoint.replace('download-manifest', 'files/SyntheticFile' + index + '000') }; });
  const identities = files.map(file => [file.parts, file.size, file.revision]).sort((left, right) => JSON.stringify(left[0]).localeCompare(JSON.stringify(right[0])));
  return { title: row.title, artist: row.artist, charter: row.charter, contentRevision: hash(JSON.stringify(identities)), verification: 'content', totalBytes: row.bytes.reduce((sum, bytes) => sum + bytes.length, 0), files };
}
const descriptor = row => { const value = manifest(row); return { chartId: row.chartId, title: row.title, artist: row.artist, charter: row.charter, endpoint: row.endpoint, contentRevision: value.contentRevision, verification: 'content', files: value.files.length, totalBytes: value.totalBytes }; };
const jsonResponse = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
async function fetcher(raw, options) {
  const url = new URL(raw); assert.equal(url.origin, 'https://chartshub.ca'); assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
  requests.push(url.pathname);
  if (url.pathname === '/api/catalogue-sync') {
    assert.equal(url.searchParams.get('offset'), '0'); assert.equal(url.searchParams.get('limit'), '500');
    const items = rows.map(descriptor), revision = hash(JSON.stringify(items));
    return jsonResponse({ revision, total: items.length, offset: 0, nextOffset: null, items });
  }
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex], value = manifest(row);
    if (url.pathname === row.endpoint) return jsonResponse(value);
    const index = value.files.findIndex(file => file.url === url.pathname);
    if (index < 0) continue;
    assert.equal(options.headers['X-ChartsHub-Download'], '1');
    if (gate && rowIndex === 1 && index === 2) {
      gated = true;
      await new Promise((resolve, reject) => { const abort = () => reject(Object.assign(Error('Synthetic transfer paused'), { name: 'AbortError', code: 'ABORT_ERR' })); if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true }); });
    }
    const bytes = row.bytes[index];
    return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) } });
  }
  throw Error('Unexpected synthetic provider request: ' + url.pathname);
}
const fakeDrums = {
  status: () => ({ supported: false, available: false, phase: 'stopped', revision: 1, plugin: null, settings: defaultSettings(), devices: { audio: [], midi: [], xinput: [] }, meters: { left: 0, right: 0 }, audio: null, error: null, mt: { version: '2.1.5.1', state: 'idle', error: null, progress: { receivedBytes: 0, totalBytes: null } } }),
  command() { forbidden.drumCommand++; throw Error('Native drum command forbidden'); }, stop() {}, async dispose() {}
};
const quickImport = { status: () => ({ supported: true, selected: false, gameName: null, busy: false, connected: false, enabled: false, error: null, jobs: [] }), async load() {}, observeDownloads() {}, observeCompletedDownload(value) { imports.push(structuredClone(value)); }, update() {}, stop() {}, async dispose() {} };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(code) { let timer; try { return await Promise.race([contents.executeJavaScript(code), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Renderer evaluation timed out')), 10000); })]); } finally { clearTimeout(timer); } }
async function until(check, label, timeout = 15000) { const end = Date.now() + timeout; do { if (await check()) return; await delay(25); } while (Date.now() < end); throw Error('Timed out: ' + label + '; state=' + JSON.stringify(host?.snapshot().catalogueSync)); }
async function click(selector) {
  await revealWorkspace({ webContents: contents }, selector);
  // Host completion can precede its throttled renderer snapshot. Wait for the
  // actual user-facing control rather than racing a fixed 35ms sleep.
  await until(() => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return !!n&&!n.disabled&&!n.hidden&&!n.closest('[inert]')})()`), 'enabled control ' + selector);
  const before = host.snapshot().catalogueSync.revision;
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await until(() => host.snapshot().catalogueSync.revision !== before, 'host accepted ' + selector);
}
const command = (name, payload = {}) => evaluate(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`);
async function check(name, callback) { await callback(); checks.push(name); console.log('PASS ' + name); }
async function screenshot(name) {
  // Some headless Windows sessions expose no compositor surface for a hidden
  // WebContentsView. Record that limitation without replacing functional QA.
  try { await fs.writeFile(path.join(directory, name + '.png'), (await contents.capturePage()).toPNG()); screenshots.push({ name, captured: true }); }
  catch (error) { screenshots.push({ name, captured: false, reason: String(error.message) }); }
}
async function closeHost() { await host?.dispose(); host = null; if (owner && !owner.isDestroyed()) owner.destroy(); owner = null; contents = null; }
async function openHost() {
  owner = new BrowserWindow({ width: 1280, height: 950, show: false, frame: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  owner.on('show', () => { visibilityUnexpected = true; owner.hide(); });
  host = await createCompanionHost({ dataDirectory, catalogueSyncClient: createCatalogueSyncClient({ fetcher }), catalogueSyncWorker: createCatalogueSyncWorker({ fetcher }),
    drumVstService: fakeDrums, quickImportService: quickImport, cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({ running: false, sessions: [] }),
    isCatalogueAvailable: () => catalogueAvailable, authorizeCatalogue: async () => catalogueAvailable,
    reportDownloadCompletion: async endpoint => { completions.push(endpoint); },
    catalogueClient: { async load() { return { items: [], revision: 'sync-fixture', demo: false }; }, async artwork() { throw Error('Artwork forbidden'); } },
    embedded: { ownerWindow: owner, attachView(value) { view = value; owner.contentView.addChildView(value); view.setBounds({ x: 0, y: 0, width: 1280, height: 950 }); contents = value.webContents;
      contents.on('console-message', (_event, detail) => { if (detail.level === 'error' || detail.level >= 3) errors.push(detail.message); });
      contents.on('render-process-gone', (_event, detail) => { if (!finished) errors.push(detail.reason); });
      contents.session.webRequest.onBeforeRequest((details, callback) => { const allowed = details.url.startsWith('chartshub-companion://') || details.url.startsWith('data:') || details.url === 'about:blank'; if (!allowed) externalRequests.push(details.url); callback({ cancel: !allowed }); });
    }, activate() { view.setVisible(true); } }
  });
  host.setLanguage('fr'); await host.open(); await until(() => evaluate("!!document.querySelector('#catalogue-sync-analyze')"), 'sync renderer');
}
const deadline = setTimeout(() => void finish(Error('Sync Electron fixture exceeded 120 seconds')), 120000);
async function finish(error) {
  if (finished) return; finished = true; clearTimeout(deadline); if (error) console.error(error.stack || error);
  try { if (error && contents && !contents.isDestroyed()) await screenshot('failure'); await closeHost(); disposeMaintenance(); assert.equal(BrowserWindow.getAllWindows().length, 0); } catch (failure) { error ||= failure; }
  await fs.mkdir(directory, { recursive: true });
  const report = { result: error ? 'failed' : 'passed', checks, error: error ? String(error.stack || error) : null, errors, screenshots, externalRequests, forbiddenCalls: forbidden, requests, completions, imports,
    actualHostAndIpc: true, actualPreloadAndRenderer: true, actualSyncClientServiceStoreWorker: true, actualLibraryScanner: true, syntheticProviderTransport: true, visibilityUnexpected,
    rendererSandboxDisabled: app.commandLine.hasSwitch('no-sandbox'), realProfileRead: false, realNetworkUsed: false, realGameRead: false, realGameLaunched: false, realHardwareRead: false, realAudioOpened: false, realDesktopCaptured: false };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ directory, result: report.result, checks: checks.length })); app.exit(error ? 1 : 0);
}
process.on('uncaughtException', error => void finish(error)); process.on('unhandledRejection', error => void finish(error));
app.whenReady().then(async () => {
  await fs.mkdir(dataDirectory, { recursive: true }); await fs.mkdir(songs); await openHost();
  await check('Fresh sandboxed profile performs no automatic catalogue or file request', async () => {
    const preferences = contents.getLastWebPreferences(); assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false); assert.equal(owner.isVisible(), false);
    assert.deepEqual(requests, []); assert.equal(host.snapshot().catalogueSync.phase, 'idle');
    await host.library.configure({ watch: false, refreshOnStart: false }); await host.library.selectRoot(songs); await host.downloads.selectRoot(songs); await until(() => host.library.status().status === 'ready', 'initial library ready');
  });
  await check('French Analyze plans the catalogue with one batch request and no song bytes', async () => {
    await revealWorkspace({ webContents: contents }, '#catalogue-sync-analyze');
    await evaluate("(()=>{const n=document.querySelector('#catalogue-sync-concurrency');n.value='1';n.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await click('#catalogue-sync-analyze'); await until(() => host.snapshot().catalogueSync.phase === 'ready', 'analysis ready');
    assert.equal(host.snapshot().catalogueSync.counts.new, 2); assert.deepEqual(requests, ['/api/catalogue-sync']); assert.equal(completions.length, 0);
  });
  await check('Start installs one verified chart then Pause preserves the interrupted plan', async () => {
    await click('#catalogue-sync-start'); await until(() => gated && host.snapshot().catalogueSync.counts.completed === 1, 'first completed and second gated');
    await click('#catalogue-sync-pause'); await until(() => host.snapshot().catalogueSync.phase === 'paused' && !host.library.status().downloadBatchActive, 'paused batch settled');
    await until(() => host.library.status().status === 'ready', 'partial library refresh'); assert.equal(host.library.status().count, 1); assert.equal(completions.length, 1); assert.equal(imports.length, 1);
    await screenshot('paused');
  });
  await check('Restart loads real saved pages without downloading; Resume installs only the remaining chart', async () => {
    const before = requests.length; await closeHost(); await openHost(); await delay(200);
    assert.equal(host.snapshot().catalogueSync.phase, 'paused'); assert.equal(host.snapshot().catalogueSync.concurrency, 1); assert.equal(host.snapshot().catalogueSync.includeVideo, false); assert.equal(requests.length, before);
    gate = false; await click('#catalogue-sync-resume'); await until(() => host.snapshot().catalogueSync.phase === 'completed' && !host.library.status().downloadBatchActive, 'resumed completed');
    await until(() => host.library.status().status === 'ready', 'resumed library ready'); assert.equal(host.library.status().count, 2); assert.equal(completions.length, 2); assert.equal(imports.length, 2); assert.equal(host.snapshot().catalogueSync.counts.failed, 0);
  });
  await check('Second Analyze skips unchanged chart folders without manifests or media transfers', async () => {
    const before = requests.length; await click('#catalogue-sync-analyze'); await until(() => host.snapshot().catalogueSync.phase === 'ready', 'unchanged ready');
    assert.equal(host.snapshot().catalogueSync.counts.unchanged, 2); assert.equal(host.snapshot().catalogueSync.counts.new, 0); assert.deepEqual(requests.slice(before), ['/api/catalogue-sync']);
    assert.equal(await evaluate("document.querySelector('#catalogue-sync-start').disabled"), true); assert.equal(completions.length, 2);
  });
  await check('Changed source files update atomically, report once per chart and trigger one batched library scan', async () => {
    for (const row of rows) row.bytes[2] = Buffer.from('Changed synthetic audio bytes ' + row.chartId);
    await click('#catalogue-sync-analyze'); await until(() => host.snapshot().catalogueSync.phase === 'ready', 'changed ready'); assert.equal(host.snapshot().catalogueSync.counts.update, 2);
    const revision = host.library.status().revision, before = requests.length; await click('#catalogue-sync-start');
    await until(() => host.snapshot().catalogueSync.phase === 'completed' && !host.library.status().downloadBatchActive && host.library.status().status === 'ready', 'updates and single scan complete');
    assert.equal(host.library.status().revision, revision + 1); assert.equal(host.library.status().count, 2); assert.equal(completions.length, 4); assert.equal(imports.length, 4);
    const transfers = requests.slice(before).filter(value => value.includes('/files/')); assert.equal(transfers.length, 2); assert(transfers.every(value => value.endsWith('SyntheticFile2000')));
    for (const row of rows) assert.deepEqual(await fs.readFile(path.join(songs, row.artist + ' - ' + row.title, 'song.ogg')), row.bytes[2]);
  });
  await check('Local edits remain untouched and are reported for review', async () => {
    const target = path.join(songs, rows[0].artist + ' - ' + rows[0].title, 'song.ini'), edited = Buffer.from('[song]\nname = Local player edit\n'); await fs.writeFile(target, edited);
    const before = requests.length; await click('#catalogue-sync-analyze'); await until(() => host.snapshot().catalogueSync.phase === 'ready', 'conflict ready');
    assert.equal(host.snapshot().catalogueSync.counts.conflict, 1); assert.equal(host.snapshot().catalogueSync.counts.unchanged, 1); assert.deepEqual(await fs.readFile(target), edited); assert.deepEqual(requests.slice(before), ['/api/catalogue-sync']); assert.equal(completions.length, 4);
  });
  await check('Trusted IPC rejects renderer paths and unavailable catalogue authorization without requests', async () => {
    const before = requests.length; assert.equal((await command('catalogueSync.analyze', { rootPath: songs })).ok, false);
    catalogueAvailable = false; assert.equal((await command('catalogueSync.analyze', { mode: 'all', concurrency: 1, includeVideo: false })).ok, false); catalogueAvailable = true;
    assert.equal(requests.length, before); assert.equal(completions.length, 4); host.setLanguage('en'); await delay(100);
    await until(() => evaluate("document.querySelector('#catalogue-sync-analyze').textContent==='Analyze'"), 'English sync labels');
    await screenshot('completed');
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []); assert(Object.values(forbidden).every(value => value === 0)); assert.equal(visibilityUnexpected, false);
  });
  await finish();
}).catch(error => void finish(error));
