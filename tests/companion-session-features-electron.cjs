'use strict';
// Exercise the real public Host, IPC, preload and renderer in a fresh profile.
// Only fixture-owned Songs files are scanned. Providers, catalogue and the local
// request bridge are in memory: no socket, audio, game, device or download opens.
const { app, BrowserWindow, desktopCapturer, dialog, shell, clipboard } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
if (process.env.NODE_PATH) require('node:module').Module._initPaths();
const { registerFixtureMaintenance } = require('./workspace-input.cjs');
const disposeMaintenance = registerFixtureMaintenance();
const archiveArg = process.argv.find(value => value.startsWith('--fixture-asar='));
const productRoot = archiveArg ? path.resolve(archiveArg.slice('--fixture-asar='.length)) : path.resolve(__dirname, '..');
if (archiveArg && !productRoot.endsWith('.asar')) throw Error('Actual ASAR required');
const outputArg = process.argv.find(value => value.startsWith('--fixture-output='));
if (!outputArg) throw Error('Explicit disposable workspace output required');
const output = path.resolve(outputArg.slice('--fixture-output='.length)), workspace = path.resolve(__dirname, '../../..');
const outputRoots = [path.join(workspace, 'outputs'), path.resolve(__dirname, '../outputs')];
if (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' && typeof process.env.RUNNER_TEMP === 'string' && path.isAbsolute(process.env.RUNNER_TEMP)) {
  const temporary = path.resolve(process.env.RUNNER_TEMP); if (temporary !== path.parse(temporary).root) outputRoots.push(temporary);
}
if (!outputRoots.some(root => { const relative = path.relative(root, output); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); })) throw Error('Fresh workspace/CI temporary output required');
const directory = path.join(output, 'session-features-' + randomUUID().slice(0, 8)), dataDirectory = path.join(directory, 'synthetic-companion');
const songs = path.join(directory, 'Songs'), nextSongs = path.join(directory, 'OtherSongs');
app.setPath('userData', path.join(directory, 'profile')); app.setPath('sessionData', path.join(directory, 'session')); process.env.LOCALAPPDATA = path.join(directory, 'local-app-data');
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
let suppressedDisplayRequests = 0;
app.on('browser-window-created', (_event, window) => { window.showInactive = () => { suppressedDisplayRequests++; }; });
const checks = [], errors = [], externalRequests = [], providerCalls = [], catalogueCalls = [], replies = [], bridgeCalls = [], captures = [];
const forbidden = { capture: 0, external: 0, fileDialog: 0, drumCommand: 0, download: 0 };
const copiedUrls = []; let sessionFeedProvider = null, streamStarts = 0;
clipboard.writeText = value => { copiedUrls.push(value); };
desktopCapturer.getSources = async () => { forbidden.capture++; throw Error('Capture forbidden'); };
shell.openExternal = async () => { forbidden.external++; throw Error('External launch forbidden'); };
dialog.showOpenDialog = async () => { forbidden.fileDialog++; throw Error('File picker forbidden'); };
// This substitution is confined to this test process. Keep replyFor and every
// production queue/provider guard; replace only the socket-opening factory.
const bridgePath = require.resolve(path.join(productRoot, 'companion/song-request-server.cjs')), bridgeModule = require(bridgePath);
require.cache[bridgePath].exports = { ...bridgeModule, createSongRequestServer(options) {
  let enabled = false, port = 38474;
  return { status: () => ({ enabled, port, url: null, overlayUrl: null, error: null }), setPort(value) { port = value; },
    async start(value) { enabled = true; port = value; bridgeCalls.push('start'); options.onStatus?.(); },
    async stop() { enabled = false; bridgeCalls.push('stop'); options.onStatus?.(); }, bridgeConfiguration: () => null };
} };
// The HTTP boundary has its own actual-loopback test suite. This Host fixture
// observes the exact feed callback and URL-copy consent without opening a port
// or altering the user's clipboard.
const streamPath = require.resolve(path.join(productRoot, 'companion/stream-server.cjs')), streamModule = require(streamPath);
require.cache[streamPath].exports = { ...streamModule, createLocalOverlayServer(options) {
  sessionFeedProvider = options.sessionFeeds; let enabled = false;
  const url = kind => enabled ? `http://127.0.0.1:39999/${kind}?token=${options.token}` : null;
  return { status: () => ({ enabled, url: url('overlay'), chatUrl: url('chat'), activityUrl: url('activity'), clients: 0, error: null }),
    publish() {}, async start() { enabled = true; streamStarts++; options.onStatus?.(); }, async stop() { enabled = false; options.onStatus?.(); } };
} };
const { createCompanionHost, registerCompanionScheme } = require(path.join(productRoot, 'companion/host.cjs'));
const { defaultSettings } = require(path.join(productRoot, 'companion/drum-vst-model.cjs'));
const { projectSessionFeed } = require(path.join(productRoot, 'companion/session-widget-model.cjs'));
registerCompanionScheme();
const providers = {};
function providerFactory(platform) { return options => {
  let state = 'disconnected', receiving = false, displayName = null;
  const notify = () => options.onStatus?.();
  const value = { status: () => ({ state, displayName, error: null, token: 'PRIVATE_FIXTURE_TOKEN' }),
    async connect() { providerCalls.push({ platform, action: 'connect' }); state = 'connected'; displayName = platform + '-fixture'; notify(); },
    async disconnect() { state = 'disconnected'; receiving = false; displayName = null; notify(); },
    async setReceiving(value) { receiving = value === true; notify(); },
    async stop() { state = 'disconnected'; receiving = false; displayName = null; notify(); },
    async sendReply(text) { replies.push(text); return { ok: true }; },
    emit(query, eventId = randomUUID()) {
      // Emit even after disconnect to prove the real wrapper fences late events.
      const event = { platform, eventId, viewerId: 'PRIVATE_VIEWER_ID', viewerName: 'Synthetic Viewer', query };
      if (platform === 'twitch') options.onMessage(event);
      else { options.onChatMessage?.(event); if (/^!(sr|vote|queue|song)(?:\s|$)/i.test(query)) options.onMessage(event); }
    }, receiving: () => receiving };
  providers[platform] = value; return value;
}; }
const fakeDrums = { status: () => ({ supported: false, available: false, phase: 'stopped', revision: 1, plugin: null, settings: defaultSettings(), devices: { audio: [], midi: [], xinput: [] }, meters: { left: 0, right: 0 }, audio: null, error: null, mt: { version: '2.1.5.1', state: 'idle', error: null, progress: { receivedBytes: 0, totalBytes: null } } }), command() { forbidden.drumCommand++; throw Error('Drums forbidden'); }, stop() {}, async dispose() {} };
let host, owner, contents, view, foreign, finished = false, visibilityUnexpected = false, catalogueAvailable = true;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(code, target = contents) { let timer; try { return await Promise.race([target.executeJavaScript(code), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Renderer evaluation timed out')), 10000); })]); } finally { clearTimeout(timer); } }
async function until(predicate, label) { const deadline = Date.now() + 10000; do { if (await predicate()) return; await delay(25); } while (Date.now() < deadline); throw Error('Timed out: ' + label); }
async function navigate(value) { await evaluate(`window.ChartshubWorkspaceNavigation.select(${JSON.stringify(value)})`); await delay(20); }
async function click(selector) { await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled||n.closest('[inert]'))throw Error('Unavailable session control: '+${JSON.stringify(selector)});n.click();})()`); await delay(30); }
async function command(name, payload = {}, target = contents) { return evaluate(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`, target); }
async function check(name, action) { await action(); checks.push(name); console.log('PASS ' + name); }
async function writeSong(folder, title) {
  await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'song.ini'), `[song]\nname = ${title}\nartist = Fictional Project\ncharter = Synthetic Charter\nsong_length = 180000\ndiff_guitar = 4\n`);
  await fs.writeFile(path.join(folder, 'notes.chart'), `[Song]\n{\n Name = "${title}"\n Resolution = 192\n}\n[SyncTrack]\n{\n 0 = B 120000\n}\n[ExpertSingle]\n{\n 0 = N 0 0\n 192 = N 1 0\n}\n`);
  await fs.writeFile(path.join(folder, 'song.ogg'), 'Fixture presence only; never decoded or played');
}
async function screenshot(name) {
  try { await fs.writeFile(path.join(directory, name), (await contents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(), { flag: 'wx' }); captures.push({ name, result: 'captured' }); }
  catch { captures.push({ name, result: 'hidden_surface_unavailable' }); }
}
const deadline = setTimeout(() => void finish(Error('Session fixture exceeded 120 seconds')), 120000);
async function finish(error) {
  if (finished) return; finished = true; clearTimeout(deadline); if (error) console.error(error.stack || error);
  try { if (error && contents && !contents.isDestroyed()) await screenshot('failure.png'); } catch { /* A failed capture must never skip fixture cleanup. */ }
  try { if (foreign && !foreign.isDestroyed()) foreign.destroy(); await host?.dispose(); if (owner && !owner.isDestroyed()) owner.destroy(); disposeMaintenance(); assert.equal(BrowserWindow.getAllWindows().length, 0); } catch (failure) { error ||= failure; }
  await fs.mkdir(directory, { recursive: true });
  const report = { result: error ? 'failed' : 'passed', checks, error: error ? String(error.stack || error) : null, errors, externalRequests, forbiddenCalls: forbidden, providerCalls, catalogueCalls, bridgeCalls, captures, clipboardWriteCount: copiedUrls.length,
    actualHostAndIpc: true, actualPreloadAndRenderer: true, actualLibraryAndRequestQueue: true, syntheticProviders: true, syntheticLocalBridge: true, syntheticStreamServer: true, syntheticClipboard: true, syntheticCatalogue: true, syntheticDownloadWorker: true, syntheticDOMActions: true,
    loadedFromAsar: !!archiveArg, productRoot, rendererSandboxDisabled: app.commandLine.hasSwitch('no-sandbox'), visibilityUnexpected, nativeFloatingDisplaysSuppressed: true, suppressedDisplayRequests,
    realGameRead: false, realGameLaunched: false, realProviderConnected: false, realHardwareRead: false, realInputRead: false, realAudioOpened: false, realProfileRead: false, realUserProfileRead: false, realDesktopCaptured: false, realDownload: false, realNetworkUsed: false };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ directory, result: report.result, checks: checks.length })); app.exit(error ? 1 : 0);
}
process.on('uncaughtException', error => void finish(error)); process.on('unhandledRejection', error => void finish(error));
app.whenReady().then(async () => {
  await fs.mkdir(dataDirectory, { recursive: true }); await fs.mkdir(songs); await fs.mkdir(nextSongs); await writeSong(path.join(songs, 'Alpha'), 'Fixture Alpha');
  owner = new BrowserWindow({ width: 1280, height: 950, show: false, frame: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  owner.on('show', () => { visibilityUnexpected = true; owner.hide(); });
  host = await createCompanionHost({ dataDirectory, drumVstService: fakeDrums, cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({ running: false, sessions: [] }),
    isCatalogueAvailable: () => catalogueAvailable, authorizeCatalogue: async () => catalogueAvailable,
    songRequestConnectionOptions: { createTwitch: providerFactory('twitch'), createTikTok: providerFactory('tiktok') },
    catalogueClient: { async load() { catalogueCalls.push('load'); return { items: [{ id: 'synthetic-discovery', title: 'Fixture Missing', artist: 'Fictional Project', charter: 'Synthetic Charter', instruments: ['Guitar'], instrumentDifficulties: { Guitar: ['Expert'] }, artworkUrl: null, downloadEndpoint: null }], revision: 'session-fixture', demo: false }; }, async artwork() { throw Error('Artwork forbidden'); } },
    downloadWorker: { async run() { forbidden.download++; throw Error('Download forbidden'); }, async discard() {}, async resolveCompleted() { throw Error('Download completion forbidden'); } },
    embedded: { ownerWindow: owner, attachView(value) { view = value; owner.contentView.addChildView(value); value.setBounds({ x: 0, y: 0, width: 1280, height: 950 }); contents = value.webContents;
      contents.on('console-message', (_event, detail) => { if (detail.level === 'error' || detail.level >= 3) errors.push(detail.message); });
      contents.on('render-process-gone', (_event, detail) => { if (!finished) errors.push(detail.reason); });
      contents.session.webRequest.onBeforeRequest((details, callback) => { const allowed = details.url.startsWith('chartshub-companion://') || details.url.startsWith('data:') || details.url === 'about:blank'; if (!allowed) externalRequests.push(details.url); callback({ cancel: !allowed }); });
    }, activate() { view.setVisible(true); } }
  });
  host.setLanguage('fr'); await host.open(); await until(() => evaluate("!!document.querySelector('#unified-chat-panel input')&&!!document.querySelector('#request-discovery-panel h3')"), 'session controls ready');
  await check('The real sandboxed public panel starts all session features off without provider or network access', async () => {
    const p = contents.getLastWebPreferences(); assert.equal(p.sandbox, true); assert.equal(p.contextIsolation, true); assert.equal(p.nodeIntegration, false); assert.equal(owner.isVisible(), false);
    assert.equal(host.snapshot().chat.enabled, false); assert.equal(host.snapshot().requestDiscovery.items.length, 0); assert.deepEqual(providerCalls, []); assert.deepEqual(catalogueCalls, []);
    assert.equal(await evaluate("document.querySelectorAll('#companion-workspace-nav [data-companion-workspace]:not([hidden])').length"), 10);
    assert.equal(await evaluate("document.querySelector('[data-companion-workspace=calibration]').hidden"), true);
  });
  await check('Chat requires an explicit local opt in and account setup never silently connects a provider', async () => {
    await navigate('chat'); await click('#unified-chat-panel input'); await until(() => host.snapshot().chat.enabled, 'chat enabled'); assert.deepEqual(providerCalls, []);
    await click('#unified-chat-panel .unified-chat-actions button:nth-of-type(1)'); assert.equal(await evaluate("document.querySelector('#song-requests-connections-details').open"), true); assert.deepEqual(providerCalls, []);
    await click('#song-requests-twitch-connect'); assert.equal((await command('songRequests.connect', { platform: 'tiktok', username: 'fixture' })).ok, true);
    await until(() => host.snapshot().chat.connections.twitch.state === 'connected' && host.snapshot().chat.connections.tiktok.state === 'connected', 'explicit synthetic providers'); assert.equal(providerCalls.length, 2);
    assert.equal(host.snapshot().chat.connections.kick.state, 'not_configured');
  });
  await check('Authenticated synthetic Twitch and TikTok messages render literally and expose no provider identity or credential', async () => {
    const id = randomUUID(); providers.twitch.emit('<img src=x onerror=alert(1)> & fixture', id); providers.twitch.emit('duplicate', id); providers.tiktok.emit('Bonjour du second chat');
    await navigate('chat'); await until(() => evaluate("document.querySelectorAll('.unified-chat-message').length===2"), 'two chat messages');
    assert.equal(await evaluate("document.querySelector('.unified-chat-message p').textContent"), '<img src=x onerror=alert(1)> & fixture'); assert.equal(await evaluate("document.querySelectorAll('.unified-chat-message img').length"), 0);
    assert(!JSON.stringify(host.snapshot().chat).includes('PRIVATE')); assert.equal(host.snapshot().chat.messages.length, 2); await screenshot('chat-fr.png');
  });
  await check('Paused display purges a disconnected platform and keeps the other platform and filter coherent', async () => {
    await click('#unified-chat-panel .unified-chat-actions button:nth-of-type(3)'); assert.equal((await command('songRequests.disconnect', { platform: 'twitch' })).ok, true);
    providers.twitch.emit('Stale disconnected message'); await until(() => evaluate("document.querySelectorAll('.unified-chat-message').length===1"), 'paused disconnect purge');
    assert.equal(await evaluate("document.querySelector('.unified-chat-badge').textContent"), 'TikTok');
    await evaluate("(()=>{const n=document.querySelector('#unified-chat-panel select');n.value='twitch';n.dispatchEvent(new Event('change',{bubbles:true}));})()"); assert.equal(await evaluate("document.querySelectorAll('.unified-chat-message').length"), 0);
    await evaluate("(()=>{const n=document.querySelector('#unified-chat-panel select');n.value='all';n.dispatchEvent(new Event('change',{bubbles:true}));})()"); await click('#unified-chat-panel .unified-chat-actions button:nth-of-type(3)');
  });
  await check('Only an explicit ready synthetic Songs library can enable the real request queue', async () => {
    await host.library.configure({ watch: false, refreshOnStart: false }); await host.library.selectRoot(songs); await until(() => host.library.status().status === 'ready' && host.library.status().count === 1, 'one synthetic song');
    await navigate('requests'); await until(() => evaluate("!document.querySelector('#song-requests-enabled').disabled"), 'reception control'); await click('#song-requests-enabled');
    await until(() => host.snapshot().songRequests.enabled, 'request reception enabled'); assert.deepEqual(bridgeCalls, ['start']); assert.equal(host.snapshot().songRequests.requests.length, 0);
    assert.equal((await command('songRequests.connect', { platform: 'twitch' })).ok, true); await until(() => host.snapshot().chat.connections.twitch.state === 'connected', 'Twitch reconnected explicitly');
  });
  let missingId;
  await check('A missing real queue request creates a local inbox without catalogue lookup download or playback', async () => {
    providers.twitch.emit('!sr Fictional Project Fixture Missing'); await until(() => host.snapshot().requestDiscovery.items.length === 1, 'missing request captured');
    const item = host.snapshot().requestDiscovery.items[0]; missingId = item.id; assert.equal(item.query, 'Fictional Project Fixture Missing'); assert.equal(item.state, 'missing');
    assert.deepEqual(catalogueCalls, []); assert.equal(forbidden.download, 0); assert.equal(host.snapshot().songRequests.requests.length, 0); assert(!JSON.stringify(host.snapshot().requestDiscovery).includes('PRIVATE'));
    await until(() => evaluate("document.querySelectorAll('.request-discovery-item').length===1"), 'inbox rendered'); assert.equal(await evaluate("document.querySelector('.request-discovery-actions button:nth-of-type(3)').disabled"), true);
  });
  await check('An explicit inbox search opens the real catalogue with the requested query and never downloads', async () => {
    await click('.request-discovery-actions button:nth-of-type(1)'); await until(() => catalogueCalls.length === 1, 'explicit catalogue search');
    assert.equal(await evaluate("document.querySelector('#catalogue-query').value"), 'Fictional Project Fixture Missing'); assert.equal(forbidden.download, 0); assert.equal(host.snapshot().requestDiscovery.items[0].state, 'searching');
  });
  await check('After a new synthetic song scan the user must choose its installed version before confirming the real queue', async () => {
    await writeSong(path.join(songs, 'Missing'), 'Fixture Missing'); assert.equal((await command('library.scan', { mode: 'quick' })).ok, true); await until(() => host.library.status().status === 'ready' && host.library.status().count === 2, 'new installed song');
    await navigate('requests'); await click('.request-discovery-actions button:nth-of-type(2)'); await until(() => evaluate("document.querySelector('.request-discovery-item select').options.length===2"), 'installed matches');
    assert.equal(await evaluate("document.querySelector('.request-discovery-actions button:nth-of-type(3)').disabled"), true);
    await evaluate("(()=>{const n=document.querySelector('.request-discovery-item select');n.value=n.options[1].value;n.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await click('.request-discovery-actions button:nth-of-type(3)'); await until(() => host.snapshot().requestDiscovery.items[0]?.state === 'queued', 'confirmed queue request');
    assert.equal(host.snapshot().songRequests.requests.length, 1); assert.equal(host.snapshot().songRequests.requests[0].title, 'Fixture Missing'); assert.equal(forbidden.download, 0); assert.equal(catalogueCalls.length, 1); await screenshot('discovery-fr.png');
  });
  await check('English session controls retain state and malformed or foreign senders cannot exercise chat or discovery', async () => {
    host.setLanguage('en'); await navigate('chat'); await until(() => evaluate("document.querySelector('#unified-chat-panel h2').textContent==='Multistream chat'"), 'English chat');
    assert.equal(await evaluate("document.querySelector('#request-discovery-panel h3').textContent"), 'Requests to find');
    for (const [name, payload] of [['chat.configure', { enabled: true, token: 'PRIVATE' }], ['chat.clear', null], ['songRequests.discoveryConfirm', { id: missingId, songId: '../private' }]]) assert.equal((await command(name, payload)).ok, false);
    const probe = path.join(directory, 'probe.cjs'); await fs.writeFile(probe, "const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('FixtureProbe',{read:()=>ipcRenderer.invoke('companion:snapshot'),enable:()=>ipcRenderer.invoke('companion:command','chat.configure',{enabled:true})});", { flag: 'wx' });
    foreign = new BrowserWindow({ show: false, webPreferences: { session: contents.session, preload: probe, contextIsolation: true, nodeIntegration: false, sandbox: true } }); await foreign.loadURL('about:blank');
    assert.equal(await evaluate('window.FixtureProbe.read()', foreign.webContents), null); assert.equal((await evaluate('window.FixtureProbe.enable()', foreign.webContents)).ok, false); foreign.destroy(); foreign = null;
    await host.setOverlay(true); const overlay = host.getOverlay(); assert.equal(overlay.isVisible(), false); const snapshot = await evaluate('window.ChartsHubCompanion.getSnapshot()', overlay.webContents);
    assert.equal(snapshot.chat, undefined); assert.equal(snapshot.requestDiscovery, undefined); assert.equal((await command('chat.configure', { enabled: true }, overlay.webContents)).ok, false); await host.setOverlay(false);
  });
  await check('Real OBS sharing controls require Apply and Copy before creating a feed and copying its tokenized local URL', async () => {
    await navigate('stream'); await until(() => evaluate("!!document.querySelector('#session-widgets-share-chat')"), 'OBS session controls');
    assert.equal(host.snapshot().sessionWidgets.settings.shareChat, false); assert.equal(host.snapshot().sessionWidgets.settings.shareActivity, false); assert.equal(streamStarts, 0); assert.equal(copiedUrls.length, 0);
    await click('#session-widgets-share-chat'); await click('#session-widgets-share-activity');
    assert.equal(host.snapshot().sessionWidgets.settings.shareChat, false); await click('#session-widgets-apply');
    await until(() => host.snapshot().sessionWidgets.settings.shareChat && host.snapshot().sessionWidgets.settings.shareActivity, 'explicit sharing applied');
    assert.equal(streamStarts, 0); assert.equal(copiedUrls.length, 0); const connections = providerCalls.length;
    await click('#session-widgets-copy-chat'); await until(() => copiedUrls.length === 1, 'local URL copied into synthetic clipboard');
    assert.match(copiedUrls[0], /^http:\/\/127\.0\.0\.1:39999\/chat\?token=[a-f0-9]{64}$/); assert.equal(streamStarts, 1); assert.equal(providerCalls.length, connections);
    const chat = projectSessionFeed('chat', sessionFeedProvider.snapshot('chat')), activity = projectSessionFeed('activity', sessionFeedProvider.snapshot('activity'));
    assert.equal(chat.enabled, true); assert(chat.items.length > 0); assert.equal(activity.enabled, true); assert(activity.items.some(item => item.title === 'Fixture Missing'));
    assert(!activity.items.some(item => Object.hasOwn(item, 'name'))); assert(!JSON.stringify({ chat, activity }).includes('PRIVATE'));
  });
  await check('Sharing revisions and read-only windows reject mutations while explicit opt-out immediately empties both feeds', async () => {
    const current = host.snapshot().sessionWidgets;
    assert.equal((await command('sessionWidgets.configure', { revision: current.revision - 1, settings: current.settings })).code, 'SESSION_WIDGETS_STALE');
    assert.equal((await command('sessionWidgets.copyUrl', { kind: 'chat', url: 'http://foreign.invalid' })).ok, false);
    await host.setOverlay(true); const overlay = host.getOverlay(), value = await evaluate('window.ChartsHubCompanion.getSnapshot()', overlay.webContents);
    assert.equal(value.sessionActivity, undefined); assert.equal(value.sessionWidgets, undefined); assert.equal((await command('sessionWidgets.configure', { revision: current.revision, settings: current.settings }, overlay.webContents)).ok, false); await host.setOverlay(false);
    await click('#session-widgets-share-chat'); await click('#session-widgets-share-activity'); await click('#session-widgets-apply');
    await until(() => !host.snapshot().sessionWidgets.settings.shareChat && !host.snapshot().sessionWidgets.settings.shareActivity, 'sharing opt-out');
    for (const kind of ['chat', 'activity']) { const feed = projectSessionFeed(kind, sessionFeedProvider.snapshot(kind)); assert.equal(feed.enabled, false); assert.deepEqual(feed.items, []); }
    assert.equal(copiedUrls.length, 1); assert.equal(await evaluate("document.querySelector('#session-widgets-copy-chat').disabled"), true);
    // Re-enable through the trusted panel to prove later account/maintenance
    // revocation clears real applied consent, not only an already-off default.
    const next = host.snapshot().sessionWidgets;
    assert.equal((await command('sessionWidgets.configure', { revision: next.revision, settings: { ...next.settings, shareChat: true, shareActivity: true } })).ok, true);
  });
  await check('Account access root changes maintenance and stop purge local inbox and chat and fence stale provider events', async () => {
    catalogueAvailable = false; host.setCatalogueAvailable(false); assert.equal(host.snapshot().chat.enabled, false); assert.equal(host.snapshot().chat.messages.length, 0); assert.equal(host.snapshot().requestDiscovery.items.length, 0);
    assert.equal(host.snapshot().sessionWidgets.settings.shareChat, false); assert.equal(host.snapshot().sessionWidgets.settings.shareActivity, false);
    const revoked = host.snapshot().sessionWidgets;
    assert.equal((await command('sessionWidgets.configure', { revision: revoked.revision, settings: { ...revoked.settings, shareChat: true, shareActivity: true } })).ok, false);
    assert.equal((await command('sessionWidgets.copyUrl', { kind: 'chat' })).ok, false);
    assert.equal(host.snapshot().sessionWidgets.settings.shareChat, false);
    for (const kind of ['chat', 'activity']) assert.deepEqual(projectSessionFeed(kind, sessionFeedProvider.snapshot(kind)).items, []);
    providers.twitch.emit('After access revoked'); assert.equal(host.snapshot().chat.messages.length, 0);
    catalogueAvailable = true; host.setCatalogueAvailable(true); providers.twitch.emit('Before fresh chat consent'); assert.equal(host.snapshot().chat.enabled, false); assert.equal(host.snapshot().chat.messages.length, 0);
    // Existing request reception may intentionally keep the authenticated
    // provider alive. New local consent may resume it, never automatically.
    assert.equal((await command('chat.configure', { enabled: true })).ok, true); providers.twitch.emit('After fresh chat consent'); assert.equal(host.snapshot().chat.messages.length, 1);
    await host.library.selectRoot(nextSongs); assert.equal(host.snapshot().requestDiscovery.items.length, 0);
    host.setMaintenanceLocked(true); assert.equal((await command('chat.configure', { enabled: true })).ok, false); assert.equal(host.snapshot().chat.enabled, false); assert.equal(host.snapshot().chat.messages.length, 0); host.setMaintenanceLocked(false);
    await host.stop(); providers.tiktok.emit('After stop'); assert.equal(host.snapshot().chat.enabled, false); assert.equal(host.snapshot().chat.messages.length, 0); assert.equal(host.snapshot().requestDiscovery.items.length, 0);
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []); assert.deepEqual(forbidden, { capture: 0, external: 0, fileDialog: 0, drumCommand: 0, download: 0 }); assert.equal(visibilityUnexpected, false);
  });
  assert.equal(checks.length, 12); await finish();
}).catch(error => void finish(error));
