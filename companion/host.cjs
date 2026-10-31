'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, protocol, session, net, screen, clipboard, dialog, shell, globalShortcut, safeStorage, Menu, desktopCapturer } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { assetPath, trustedSender, trustedContentsSender, trustedPlayerFullscreen, trustedFiltersWidgetCommand, trustedCatalogueWidgetCommand, validCommand } = require('./security.cjs');
const { createFiltersService } = require('./filters-service.cjs');
const { createReShadeService } = require('./reshade-service.cjs');
const { createReShadeSetupService } = require('./reshade-setup.cjs');
const { createLocalOverlayServer } = require('./stream-server.cjs');
const { createBackgroundLibraryService } = require('./library-background.cjs');
const { verifyNativeCleanup } = require('./native-cleanup.cjs');
const { verifyNativeBadSongCleanup } = require('./library-bad-songs.cjs');
const { createChartsHubClient } = require('./catalogue-client.cjs');
const { createCatalogueDownloadWorker } = require('./catalogue-download-worker.cjs');
const { createCatalogueService } = require('./catalogue-service.cjs');
const { createDownloadService } = require('./download-service.cjs');
const { createLibraryDownloadRefresh } = require('./library-download-refresh.cjs');
const { createCloneHeroSource } = require('./clonehero-source.cjs');
const { createTelemetrySource } = require('./clonehero-telemetry-source.cjs');
const { publicTelemetrySnapshot, telemetryStateView } = require('./clonehero-telemetry-view.cjs');
const { createCharterColorResolver } = require('./charter-color-resolver.cjs');
const { createCloneHeroProcessProbe } = require('./clonehero-process.cjs');
const { createOverlayProfiles } = require('./overlay-profiles.cjs');
const { createFloatingPanels } = require('./floating-panels.cjs');
const { createSongRequests } = require('./song-requests.cjs');
const { createSongRequestServer } = require('./song-request-server.cjs');
const { createSongRequestPreferences } = require('./song-request-preferences.cjs');
const { createSongRequestAccountStore } = require('./song-request-account-store.cjs');
const { createSongRequestConnections } = require('./song-request-connections.cjs');
const { twitchClientId: publishedTwitchClientId } = require('./song-request-config.cjs');
const { shareErrorCode } = require('./song-request-share-contract.cjs');
const { createSongRequestShareSync, songRequestShareKey } = require('./song-request-share-sync.cjs');
const { createSongRequestPublicBroker } = require('./song-request-public-broker.cjs');
const { attachEditContextMenu } = require('../desktop/edit-context-menu.cjs');
const { createMusicPlayer } = require('./music-player.cjs');
const { createSongVisuals } = require('./song-visuals.cjs');
const { createMusicPlayerPreferences } = require('./music-player-preferences.cjs');
const { changeMusicPlaylist } = require('./music-playlists.cjs');
const { createGameCapture } = require('./game-capture.cjs');
const SCHEME = 'chartshub-companion';
const CAPTURE_WINDOW_TITLES = Object.freeze({ catalogue: 'ChartsHub — Mini Catalogue', filters: 'ChartsHub — Filtres du jeu', player: 'ChartsHub — Lecteur Songs' });
function registerCompanionScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
}
async function createCompanionHost({ dataDirectory = path.join(app.getPath('userData'), 'companion'), catalogueClient, downloadWorker, cloneHeroCandidates, cloneHeroProcessProbe, filtersService, reshadeService, reshadeSetupService, embedded, isCatalogueAvailable = () => true, authorizeCatalogue = async () => true, downloadNotifications, sharingClient, songRequestConnectionOptions = {} } = {}) {
  if (typeof isCatalogueAvailable !== 'function' || typeof authorizeCatalogue !== 'function') throw Error('Invalid catalogue availability');
  if (embedded && (!embedded.ownerWindow || typeof embedded.ownerWindow.isDestroyed !== 'function' || typeof embedded.attachView !== 'function' || typeof embedded.activate !== 'function')) throw Error('Invalid embedded Companion host');
  const [{ ServiceContainer }, { MockCloneHeroIntegration }, { createDefaultRegistry, createDefaultWidgets, ensureGameplayDocument }, { WidgetRenderer }, { SettingsRepository, validateSettings }, { SnapshotHistory }, { ThemeService, createDefaultTheme }, { validateWidgetStyle }, { createDefaultStream, validateStream }] = await Promise.all([
    import('./dist/core/services/ServiceContainer.js'), import('./dist/integrations/clonehero/MockCloneHeroIntegration.js'),
    import('./dist/widgets/core/index.js'), import('./dist/widgets/engine/WidgetRenderer.js'), import('./dist/storage/SettingsRepository.js'), import('./dist/layout/WidgetHistory.js'),
    import('./dist/themes/ThemeService.js'), import('./dist/themes/ThemeResolver.js'), import('./dist/overlay/stream/StreamConfig.js')
  ]);
  const logs = [];
  // The dialog owner and the trusted renderer are different objects in a tab.
  let panel = null, panelContents = null, panelView = null, overlay = null, overlayEnabled = false, persistenceError = '', saveTimer = null, quitting = false;
  let openTask = null, stopTask = null, disposeTask = null, overlayLoad = null, disposing = false;
  let maintenanceLocked = false;
  let logTail = Promise.resolve(), pendingSave = Promise.resolve();
  let streamServer = null, streamInit = null, streamTask = Promise.resolve(), streamDesired = false, streamError = null;
  let library = null, rootPickerOpen = false;
  let songVisuals = null;
  let gameCapture = null, gameCaptureTask = null;
  let musicPlayer = null, playerWindow = null, playerWindowLoad = null, playerSpectrumAt = 0;
  let playerPreferencesTask = Promise.resolve();
  const playerPreferences = createMusicPlayerPreferences({ dataDirectory });
  await playerPreferences.load();
  let songRequests = null, songRequestServer = null, songRequestConnections = null, songRequestBusy = false;
  let songRequestShare = { supported: !!sharingClient, url: null, count: 0, updatedAt: null, busy: false, error: null, unavailableCount: 0, progress: null };
  let songRequestShareRevision = 0;
  let songRequestShareController = null;
  let songRequestShareSync = null;
  let songRequestShareBroker = null;
  let songRequestShareKeyCache = null;
  let songRequestShareManualBusy = null;
  const songRequestPreferences = createSongRequestPreferences({ dataDirectory });
  await songRequestPreferences.load();
  const songRequestAccounts = createSongRequestAccountStore({ dataDirectory, safeStorage });
  await songRequestAccounts.load();
  let cleanupDialogOpen = false, cleanupTask = null, cleanupApproval = null;
  let catalogue = null, libraryIndexRevision = -1;
  let libraryRequestRoot = null;
  let downloads = null, downloadPickerOpen = false;
  let libraryDownloadRefresh = null;
  let catalogueWidget = null, catalogueWidgetLoad = null, catalogueWidgetEnabled = false, catalogueWidgetTicket = 0;
  let catalogueAccess = true, hostActive = false, shortcutRegistered = false, shortcutError = null, shortcutPending = false;
  const catalogueAccelerator = 'CommandOrControl+Shift+K';
  const downloadNotice = (method, ...args) => { try { return downloadNotifications?.[method]?.(...args); } catch { return null; } };
  let cloneHeroPickerOpen = false;
  let filters = null, filtersWidget = null, filtersWidgetLoad = null, filtersWidgetEnabled = false;
  let filtersPickerOpen = false, filtersConfirmationOpen = false, filtersTimer = null, filtersRefresh = null, filtersFocusRevision = 0;
  let reshade = null, reshadeRefresh = null, reshadePickerOpen = false, reshadeConfirmationOpen = false;
  let reshadeSetup = null, reshadeSetupStarting = false;
  let lifecycleRevision = 0;
  let language = 'fr';
  let telemetry = null;
  let buttonMotion = { economy: false };
  const tr = (fr, en) => language === 'fr' ? fr : en;
  let preferredProfileId = null;
  const profileWrites = new Set();
  const logger = Object.fromEntries(['info','warn','error'].map(level => [level, message => {
    const entry = { level, message: String(message).slice(0, 200), time: new Date().toISOString() };
    logs.push(entry); if (logs.length > 100) logs.shift();
    logTail = logTail.then(async () => {
      await fs.mkdir(dataDirectory, { recursive: true });
      const file = path.join(dataDirectory, 'companion.log');
      try { if ((await fs.stat(file)).size > 1048576) await fs.rename(file, file + '.previous'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
    }).catch(() => {});
  }]));
  const defaults = createDefaultWidgets();
  const repository = new SettingsRepository(path.join(dataDirectory, 'settings.json'), defaults);
  let widgets = defaults;
  let theme = createDefaultTheme();
  let stream = createDefaultStream(widgets);
  try { const loaded = await repository.load(); widgets = loaded.widgets; theme = loaded.theme; stream = loaded.stream; } catch {
    persistenceError = 'Les réglages précédents ne peuvent pas être chargés. Les valeurs par défaut sont utilisées ; le fichier original est conservé.';
    logger.warn('Settings could not be loaded');
  }
  const profiles = createOverlayProfiles({ dataDirectory, validateSettings });
  ({ widgets, theme, stream } = validateSettings(ensureGameplayDocument({ version: 3, widgets, theme, stream })));
  await profiles.load();
  const floatingPanels = createFloatingPanels({ dataDirectory });
  await floatingPanels.load();
  const candidateRoots = [app.getPath('documents'), path.join(os.homedir(), 'Documents'),
    ...[process.env.OneDrive, process.env.OneDriveConsumer, path.join(os.homedir(), 'OneDrive')].filter(Boolean).map(root => path.join(root, 'Documents'))];
  const integration = await createCloneHeroSource({ mock: new MockCloneHeroIntegration(), dataDirectory,
    candidates: cloneHeroCandidates ?? [...new Set(candidateRoots.map(root => path.join(root, 'Clone Hero', 'currentsong.txt')))],
    resolveCharter: createCharterColorResolver({ dataDirectory }),
    probeGame: cloneHeroProcessProbe ?? createCloneHeroProcessProbe(),
    onChange: () => { if (!disposing) publishPanel(); }
  });
  const services = new ServiceContainer({ integration, initialWidgets: widgets, logger });
  services.store.setState(state => ({ ...state, theme, stream }));
  telemetry = await createTelemetrySource({ dataDirectory, onChange: () => { if (!disposing) publish(); } });
  const history = new SnapshotHistory({ widgets, theme, stream });
  const themeService = new ThemeService();
  let editorRevision = 0;
  const registry = createDefaultRegistry();
  const renderer = new WidgetRenderer(registry, () => logger.warn('Widget unavailable'));
  const ses = session.fromPartition('companion-local');
  const playerFullscreenTargets = () => ({ active: hostActive && !disposing && !stopTask,
    panelContents, playerContents: playerWindow && !playerWindow.isDestroyed() ? playerWindow.webContents : null });
  ses.setPermissionRequestHandler((web, permission, callback, details) => callback(trustedPlayerFullscreen(web, permission, details, playerFullscreenTargets())));
  ses.setPermissionCheckHandler((web, permission, origin, details) => trustedPlayerFullscreen(web, permission, details, playerFullscreenTargets(), origin));
  ses.on('will-download', event => event.preventDefault());
  await ses.protocol.handle(SCHEME, async request => {
    // Artwork is fetched by ID from the known public catalogue. The renderer
    // cannot turn this local route into a proxy for arbitrary URLs.
    let requested;
    try { requested = new URL(request.url); } catch { return new Response('Not found', { status: 404 }); }
    const media = await musicPlayer?.serve(request);
    if (media) return media;
    const artworkKey = /^\/catalogue-artwork\/([a-f0-9]{64})$/.exec(requested.pathname)?.[1];
    if (artworkKey && requested.protocol === `${SCHEME}:` && requested.hostname === 'app' && !requested.port && !requested.username && !requested.password && !requested.search && !requested.hash && request.method === 'GET') {
      try {
        const artwork = await catalogue?.artwork(artworkKey);
        if (artwork) return new Response(artwork.bytes, { headers: { 'Content-Type': artwork.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' } });
      } catch { /* Missing or unavailable artwork keeps the card placeholder. */ }
      return new Response('Not found', { status: 404 });
    }
    const filename = assetPath(__dirname, request.url);
    if (!filename || request.method !== 'GET') return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(filename).href);
  });
  const preferences = { session: ses, preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false };
  const gameCaptureStatus = () => gameCapture?.snapshot() ?? { available: hostActive && !disposing && !stopTask && !maintenanceLocked, phase: 'stopped', title: 'ChartsHub — Capture Clone Hero' };
  async function ensureGameCapture() {
    if (gameCapture) return gameCapture;
    if (!gameCaptureTask) gameCaptureTask = createGameCapture({ root: __dirname, onChange: () => { if (!disposing) publishPanel(); },
      active: () => hostActive && !disposing && !stopTask && !maintenanceLocked, language: () => language,
      electron: { BrowserWindow, desktopCapturer, session, ipcMain, net } }).then(value => gameCapture = value).finally(() => { gameCaptureTask = null; });
    return gameCaptureTask;
  }
  function hardenContents(contents, page, ownerWindow) {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => { if (url !== `${SCHEME}://app/ui/${page}`) event.preventDefault(); });
    contents.on('will-redirect', event => event.preventDefault());
    contents.on('will-attach-webview', event => event.preventDefault());
    attachEditContextMenu({ contents, ownerWindow, buildMenu: template => Menu.buildFromTemplate(template), language: () => language,
      isAllowed: () => !disposing && contents.getURL() === `${SCHEME}://app/ui/${page}` });
  }
  function harden(window, page) { window.setMenuBarVisibility(false); hardenContents(window.webContents, page, window); }
  const streamStatus = () => streamServer?.status() ?? { enabled: false, url: null, clients: 0, error: streamError };
  const catalogueShortcut = () => ({ accelerator: catalogueAccelerator, registered: shortcutRegistered, error: shortcutError });
  const captureWindows = () => ({
    catalogue: { canOpen: !disposing && !stopTask && catalogueAllowed(), title: CAPTURE_WINDOW_TITLES.catalogue },
    filters: { canOpen: !disposing && !stopTask && (filters?.status()?.supported === true || reshade?.status()?.supported === true), title: CAPTURE_WINDOW_TITLES.filters },
    player: { canOpen: hostActive && !disposing && !stopTask && panelAlive(), title: CAPTURE_WINDOW_TITLES.player }
  });
  const songRequestSnapshot = () => ({ ...songRequests?.snapshot(), widget: songRequestPreferences.status().widget,
    publicRequests: songRequestShareBroker?.status(), connections: songRequestConnections?.status(), sharing: { ...songRequestShare, autoSync: songRequestShareSync?.status(),
    progress: songRequestShare.busy && songRequestShare.progress?.phase === 'preparing' ? (library?.status().sharingPreparation ?? songRequestShare.progress) : songRequestShare.progress }, bridge: songRequestServer?.status() ?? { enabled: false, port: songRequestPreferences.status().port, url: null, overlayUrl: null, error: songRequestPreferences.status().error, platforms: ['twitch', 'tiktok', 'youtube'] } });
  const stateView = () => ({ ...telemetryStateView(services.store.getState(), telemetry?.snapshot(), { language, liveMetadata: integration.status().mode === 'live' }), lyrics: songVisuals?.lyricsSnapshot() ?? null });
  const telemetryPanel = () => { const value = telemetry?.snapshot(); return value ? { ...publicTelemetrySnapshot(value, language), enabled: value.enabled, canWrite: value.canWrite, persistenceError: value.persistenceError, settings: value.settings, calibration: value.calibration, reason: value.reason } : null; };
  const snapshot = () => ({ language, buttonMotion: { ...buttonMotion }, state: stateView(), telemetry: telemetryPanel(), visuals: songVisuals?.snapshot(), gameCapture: gameCaptureStatus(), profiles: profiles.status({ version: 3, ...editorDocument() }, preferredProfileId), cloneHero: integration.status(), overlayEnabled, stream: streamStatus(), songRequests: songRequestSnapshot(), player: musicPlayer?.snapshot(), captureWindows: captureWindows(), library: library?.status(), catalogue: catalogue?.status(), downloads: downloads?.status(), filters: filters?.status(), reshade: reshade?.status(), reshadeSetup: reshadeSetup?.status(), filtersWidgetEnabled, filtersFocusRevision, catalogueWidgetEnabled, catalogueShortcut: catalogueShortcut(), floatingPanels: floatingPanels.status(), editor: { revision: editorRevision, canUndo: history.canUndo, canRedo: history.canRedo }, logs: [...logs], ...(persistenceError ? { persistenceError } : {}) });
  const floatingPanelSnapshot = name => {
    const value = floatingPanels.status();
    return { revision: value.revision, appearance: { [name]: value.appearance[name] }, error: value.error, canWrite: value.canWrite };
  };
  const playerWidgetSnapshot = () => ({ language, buttonMotion: { ...buttonMotion }, player: musicPlayer.snapshot({ engine: true }), floatingPanels: floatingPanelSnapshot('player') });
  const catalogueWidgetSnapshot = () => {
    const value = downloads?.status();
    return { language, buttonMotion: { ...buttonMotion }, catalogue: catalogue?.status(), catalogueWidgetEnabled, catalogueShortcut: catalogueShortcut(), floatingPanels: floatingPanelSnapshot('catalogue'),
      downloads: value ? { revision: value.revision, hasRoot: !!value.rootPath, error: value.error,
        items: value.items.map(item => Object.fromEntries(['id', 'chartId', 'title', 'artist', 'state', 'receivedBytes', 'totalBytes', 'completedFiles', 'totalFiles', 'error', 'updatedAt'].map(key => [key, item[key]]))) } : null };
  };
  // The interactive filter widget receives no song library, paths, logs or stream access URL.
  const filtersWidgetSnapshot = () => {
    const status = filters?.status();
    const source = reshade?.status();
    const reshadeStatus = source ? { supported: source.supported, installed: source.installed, running: source.running, connected: source.connected, busy: source.busy, state: source.state, catalog: source.catalog ? { ...source.catalog, preset: source.catalog.preset ? path.basename(source.catalog.preset) : '' } : null } : null;
    if (!status) return { filters: null, reshade: reshadeStatus, language, buttonMotion: { ...buttonMotion }, floatingPanels: floatingPanelSnapshot('filters') };
    const { settings, supported, installed, state, running, busy, native } = status;
    return { filters: { settings, supported, installed, state, running, busy, native }, reshade: reshadeStatus, filtersWidgetEnabled, language, buttonMotion: { ...buttonMotion }, floatingPanels: floatingPanelSnapshot('filters') };
  };
  function syncOverlay() {
    if (!overlay || overlay.isDestroyed()) return;
    const visible = overlayEnabled && renderer.renderWidgetModels(stateView(), 'game').length > 0;
    if (visible && !overlay.webContents.isLoading()) overlay.showInactive(); else overlay.hide();
  }
  function updateVisuals() {
    if (!songVisuals) return;
    songVisuals.setEnabled(hostActive && !disposing && !stopTask && (streamDesired || services.store.getState().widgets.instances.some(w => w.type === 'song.lyrics' && w.enabled && (w.visibility.game || w.visibility.stream))));
    const view = stateView(), performance = view.performance;
    const real = performance?.connected === true || (integration.status().mode === 'live' && integration.status().status === 'active');
    void songVisuals.update({ live: real && hostActive && !disposing && !stopTask, phase: view.gameplay.state,
      song: view.nowPlaying, clock: performance?.connected ? performance.active?.clock : null });
  }
  function publish() {
    updateVisuals();
    const value = snapshot();
    publishPanel(value);
    if (overlay && !overlay.isDestroyed() && !overlay.webContents.isLoading()) overlay.webContents.send('companion:changed', { ...value, songRequests: undefined, player: undefined });
    if (filtersWidget && !filtersWidget.isDestroyed() && !filtersWidget.webContents.isLoading()) filtersWidget.webContents.send('companion:changed', filtersWidgetSnapshot());
    syncOverlay();
    streamServer?.publish(value.state);
  }
  function panelAlive() { return !!panel && !panel.isDestroyed() && !!panelContents && !panelContents.isDestroyed?.(); }
  function catalogueAllowed() { try { return hostActive && catalogueAccess && !disposing && !stopTask && panelAlive() && isCatalogueAvailable() === true; } catch { return false; } }
  function publishPanel(value) {
    if (panelAlive() && !panelContents.isLoading()) panelContents.send('companion:changed', value ?? snapshot());
    if (playerWindow && !playerWindow.isDestroyed() && !playerWindow.webContents.isLoading()) playerWindow.webContents.send('companion:changed', playerWidgetSnapshot());
    if (catalogueAllowed() && catalogueWidget && !catalogueWidget.isDestroyed() && !catalogueWidget.webContents.isLoading()) catalogueWidget.webContents.send('companion:changed', catalogueWidgetSnapshot());
  }
  function setLanguage(value) { if (!['fr','en'].includes(value) || language === value) return language; language=value; publish(); return language; }
  function setButtonMotion(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.economy !== 'boolean' || Object.keys(value).some(key => !['economy', 'hoverLift'].includes(key)) || (Object.hasOwn(value, 'hoverLift') && ![1, 3, 5].includes(value.hoverLift))) return false;
    const next = { economy: value.economy, ...(Object.hasOwn(value, 'hoverLift') ? { hoverLift: value.hoverLift } : {}) };
    if (JSON.stringify(buttonMotion) !== JSON.stringify(next)) { buttonMotion = next; if (!disposing) publish(); }
    return true;
  }
  const unsubscribe = services.store.subscribe(publish);
  // The index and expensive work stay in a worker. Progress only updates the panel,
  // without waking either overlay or exposing library paths to the OBS server.
  library = createBackgroundLibraryService({ dataDirectory, recycle: async (target, proof) => {
    const approval = cleanupApproval;
    if (!approval || disposing || stopTask || approval.lifecycle !== lifecycleRevision || approval.owner !== panel || panel.isDestroyed()
      || library.status().settings.rootPath !== approval.root || !approval.targets.has(target)) throw Error('Nettoyage non autorisé.');
    const relative = path.relative(approval.root, target);
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw Error('Copie invalide.');
    // Bind the final check to the identities hashed by the worker, including
    // the keeper: a replacement during the IPC hop cannot reuse this approval.
    if (approval.kind === 'bad-songs') await verifyNativeBadSongCleanup({ root: approval.root, target, proof });
    else {
      const keep = approval.keeps ? approval.keeps.get(target) : approval.keep;
      if (!keep || approval.targets.has(keep)) throw Error('Version conservée invalide.');
      await verifyNativeCleanup({ root: approval.root, keep, target, proof });
    }
    if (disposing || stopTask || approval !== cleanupApproval || approval.lifecycle !== lifecycleRevision || approval.owner !== panel || panel.isDestroyed()) throw Error('Nettoyage arrêté.');
    approval.targets.delete(target);
    await shell.trashItem(target);
  }, onChange: () => {
    musicPlayer?.libraryChanged();
    updateVisuals();
    const requestState = library?.status(), requestRoot = library?.matchingSnapshot().rootKey;
    const refreshingRequestRoot = requestState?.status === 'scanning' && requestState.count > 0 && !!requestRoot && requestRoot === libraryRequestRoot;
    if (requestState?.status === 'ready') libraryRequestRoot = requestRoot;
    // A background refresh pauses validation through canReceive/resolveSong but
    // keeps the user's reception choice. Missing/changed roots still stop it.
    if (songRequests?.snapshot().enabled && ((!refreshingRequestRoot && requestState?.status !== 'ready') || requestState?.count < 1)) {
      songRequests.configure({ enabled: false });
      void songRequestConnections?.setReceiving(false);
      void songRequestServer?.stop();
    }
    const revision = library?.status().revision ?? -1;
    if (revision !== libraryIndexRevision) { libraryIndexRevision = revision; catalogue?.libraryChanged(); }
    songRequestShareSync?.update();
    songRequestShareBroker?.update();
    libraryDownloadRefresh?.update();
    if (!disposing) publishPanel();
  } });
  await library.load();
  songVisuals = createSongVisuals({ library, onChange: () => { if (!disposing) publish(); } });
  musicPlayer = createMusicPlayer({ library, preferences: playerPreferences.status(), onChange: () => { if (!disposing) publishPanel(); }, onAction: value => {
    if (playerWindow && !playerWindow.isDestroyed() && !playerWindow.webContents.isLoading()) playerWindow.webContents.send('companion:player-action', value);
  } });
  const normalizeRequestQuery = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');
  const requestNowPlaying = () => {
    const state = services.store.getState(), live = integration.status().mode === 'live';
    return state.nowPlaying && (live ? state.gameplay.isChartActive : state.gameplay.state === 'playing')
      ? { ...state.nowPlaying, state: live ? 'exported' : 'playing' } : null;
  };
  songRequests = createSongRequests({
    getLibrarySnapshot: () => library.matchingSnapshot(),
    searchSongs: async ({ query, limit }) => {
      const index = library.matchingSnapshot(), search = normalizeRequestQuery(query), tokens = search.split(' ').filter(Boolean);
      const exact = index.items.filter(item => [item.title, `${item.artist} ${item.title}`, `${item.title} ${item.artist}`].some(value => normalizeRequestQuery(value) === search));
      const matches = exact.length ? exact : index.items.filter(item => tokens.every(token => normalizeRequestQuery(`${item.title} ${item.artist} ${item.charter}`).includes(token)));
      return { items: matches.slice(0, limit), total: matches.length, revision: index.revision };
    },
    resolveSong: (id, context) => library.resolveRequestSong(id, context),
    getNowPlaying: requestNowPlaying,
    onChange: () => { if (!disposing) publishPanel(); }
  });
  const requestPreferences = songRequestPreferences.status();
  songRequests.configure({ rules: requestPreferences.rules, enabled: false });
  songRequestConnections = createSongRequestConnections({
    ...songRequestConnectionOptions,
    twitchClientId: songRequestConnectionOptions.twitchClientId ?? publishedTwitchClientId,
    accountStore: songRequestAccounts, openExternal: url => shell.openExternal(url),
    receive: input => songRequests.receive(input),
    canReceive: () => hostActive && !disposing && !stopTask && songRequests.snapshot().enabled && library.status().status === 'ready' && library.status().count > 0,
    getLanguage: () => language, onChange: () => { if (!disposing) publishPanel(); }
  });
  if (requestPreferences.ingestToken && requestPreferences.readToken && !requestPreferences.error) {
    songRequestServer = createSongRequestServer({ root: __dirname, ingestToken: requestPreferences.ingestToken, readToken: requestPreferences.readToken,
      receive: input => {
        if (!hostActive || disposing || stopTask) return { ok: false, code: 'disabled' };
        // An existing Streamer.bot action can stay installed without replying twice.
        if (input.platform === 'twitch' && songRequestConnections.handlesBridge('twitch')) return { ok: true, silent: true };
        return songRequests.receive(input);
      },
      getSnapshot: () => songRequests.snapshot(), getLanguage: () => language,
      getWidget: () => songRequestPreferences.status().widget, getNowPlaying: requestNowPlaying,
      onStatus: () => { if (!disposing) publishPanel(); }
    });
    songRequestServer.setPort(requestPreferences.port);
  }
  async function configureSongRequests(payload) {
    if (songRequestBusy) return { ok: false, error: 'Une modification Song Request est déjà en cours.' };
    const lifecycle = lifecycleRevision;
    songRequestBusy = true;
    try {
      if (!payload.enabled) { songRequests.configure({ enabled: false }); await songRequestShareBroker?.stop(); await songRequestConnections.setReceiving(false); await songRequestServer?.stop(); }
      if (disposing || stopTask || !hostActive || lifecycle !== lifecycleRevision) return { ok: false, error: 'Le panneau a été fermé.' };
      if (payload.enabled && (library.status().status !== 'ready' || library.status().count < 1)) return { ok: false, error: 'Scannez votre dossier Songs avant d’activer les demandes.' };
      if (songRequestServer?.status().enabled && songRequestServer.status().port !== payload.port) return { ok: false, error: 'Arrêtez la réception avant de changer le port.' };
      await songRequestPreferences.save({ port: payload.port, rules: payload.rules });
      if (disposing || stopTask || !hostActive || lifecycle !== lifecycleRevision) return { ok: false, error: 'Le panneau a été fermé.' };
      songRequests.configure({ rules: payload.rules });
      songRequestShareSync?.update();
      if (!songRequestServer?.status().enabled) songRequestServer?.setPort(payload.port);
      if (payload.enabled) {
        await songRequestServer?.start(payload.port);
        if (disposing || stopTask || !hostActive || lifecycle !== lifecycleRevision) { await songRequestServer?.stop(); return { ok: false, error: 'Le panneau a été fermé.' }; }
        if (library.status().status !== 'ready' || library.status().count < 1) {
          songRequests.configure({ enabled: false });
          await songRequestConnections.setReceiving(false); await songRequestServer?.stop();
          return { ok: false, error: 'Scannez votre dossier Songs avant d’activer les demandes.' };
        }
        songRequests.configure({ enabled: true });
        void songRequestConnections.setReceiving(true);
      }
      songRequestShareBroker?.update();
      publishPanel(); return { ok: true };
    } finally { songRequestBusy = false; }
  }
  songRequestShareBroker = createSongRequestPublicBroker({ client: sharingClient,
    context: () => {
      const state = library.status(), index = library.matchingSnapshot();
      return { active: catalogueAccess && hostActive && !disposing && !stopTask && songRequests.snapshot().enabled
          && state.status === 'ready' && state.count > 0 && !!songRequestShare.url && !songRequestShare.busy && !songRequestShareManualBusy,
        revision: songRequestShare.revision,
        key: JSON.stringify([lifecycleRevision, index.rootKey, index.revision, songRequestShare.revision, songRequests.snapshot().rules]) };
    }, receive: (input, options) => songRequests.receive(input, options),
    onChange: () => { if (!disposing) publishPanel(); } });
  function songRequestShareContext() {
    const state = library?.status(), index = library?.matchingSnapshot(), rules = songRequests?.snapshot().rules;
    const serializedRules = JSON.stringify(rules);
    if (!songRequestShareKeyCache || songRequestShareKeyCache.index !== index || songRequestShareKeyCache.rules !== serializedRules) {
      songRequestShareKeyCache = { index, rules: serializedRules, key: songRequestShareKey(index, rules) };
    }
    return { active: !!sharingClient && catalogueAccess && hostActive && !disposing && !stopTask,
      published: !!songRequestShare.url, ready: state?.status === 'ready', key: songRequestShareKeyCache.key };
  }
  async function refreshSongRequestShare() {
    if (!sharingClient || songRequestShare.busy || songRequestShareManualBusy || disposing || !hostActive || !catalogueAccess) return;
    const lifecycle = lifecycleRevision, revision = ++songRequestShareRevision;
    const valid = () => !disposing && !stopTask && hostActive && lifecycle === lifecycleRevision && revision === songRequestShareRevision;
    try { const status = await sharingClient.status(); if (valid()) {
      songRequestShare = { ...songRequestShare, ...status, error: null };
      if (status.url) songRequestShareSync?.resume(); else void songRequestShareSync?.pause({ forget: true });
    } }
    catch (failure) { if (valid()) songRequestShare = { ...songRequestShare, error: shareErrorCode(failure) }; }
    if (valid()) { songRequestShareBroker?.update(); publishPanel(); }
  }
  async function changeSongRequestShare(remove = false, automatic = false) {
    if (automatic) return performSongRequestShare(remove, true);
    if (songRequestShareManualBusy) return { ok: false, error: 'SHARE_UNAVAILABLE' };
    const manual = {}; songRequestShareManualBusy = manual;
    // Fence both late status reads and the old upload before waiting for its
    // cancellation. The explicit action runs after that operation has settled.
    const requestedRevision = ++songRequestShareRevision;
    try {
      // A manual publication can commit before its local guard notices a
      // change, so its previous synchronized key must also become uncertain.
      await songRequestShareSync?.pause({ forget: true });
      if (requestedRevision !== songRequestShareRevision) return { ok: false, error: 'SHARE_CANCELLED' };
      songRequestShare.busy = false; songRequestShare.progress = null;
      return await performSongRequestShare(remove, false);
    } finally {
      if (songRequestShareManualBusy === manual) {
        songRequestShareManualBusy = null;
        if (!remove && songRequestShareContext().active && songRequestShare.url) songRequestShareSync?.resume();
        songRequestShareBroker?.update();
      }
    }
  }
  async function performSongRequestShare(remove, automatic) {
    if (!sharingClient || songRequestShare.busy || disposing || stopTask || !hostActive || !catalogueAccess) return { ok: false, error: 'SHARE_CANCELLED' };
    const lifecycle = lifecycleRevision, revision = ++songRequestShareRevision;
    const valid = () => !disposing && !stopTask && hostActive && lifecycle === lifecycleRevision && revision === songRequestShareRevision && !controller.signal.aborted;
    const controller = new AbortController(); songRequestShareController = controller;
    songRequestShare.busy = true; songRequestShare.error = null;
    songRequestShare.progress = { phase: remove ? 'removing' : 'preparing', processed: 0, total: library.status?.().count ?? 0 };
    songRequestShareBroker?.update(); publishPanel();
    try {
      const account = await sharingClient.capture?.();
      if (!valid()) return { ok: false };
      let result, unavailableCount = 0, synchronizedKey = null, publicationCurrent = valid;
      if (remove) result = await sharingClient.remove(account, { signal: controller.signal, isCurrent: valid });
      else {
        const rules = songRequests.snapshot().rules;
        synchronizedKey = songRequestShareContext().key;
        const prepared = await library.requestLibraryForSharing();
        const current = () => valid() && library.status().status === 'ready' && library.matchingSnapshot().rootKey === prepared.rootKey && library.matchingSnapshot().revision === prepared.revision && JSON.stringify(rules) === JSON.stringify(songRequests.snapshot().rules);
        publicationCurrent = current;
        if (!current()) { if (valid()) songRequestShare.error = 'SHARE_LIBRARY_CHANGED'; return { ok: false, error: 'SHARE_LIBRARY_CHANGED' }; }
        result = await sharingClient.publish({ songs: prepared.songs, rules }, account, { signal: controller.signal, isCurrent: current,
          onProgress: progress => { if (valid()) { songRequestShare.progress = { ...progress }; publishPanel(); } } }); unavailableCount = prepared.unavailableCount;
      }
      if (!publicationCurrent()) return { ok: false, error: 'SHARE_LIBRARY_CHANGED' };
      songRequestShare = { ...songRequestShare, ...result, unavailableCount, error: null };
      if (!remove && !automatic) {
        // Publishing opts this chosen Songs root into automatic detection. A later
        // explicit choice to turn detection off is preserved across app restarts.
        try {
          const settings = library.status().settings;
          if (settings && !settings.watch) await library.configure({ watch: true, refreshOnStart: settings.refreshOnStart });
        } catch { logger.warn('Song list published; automatic folder detection could not be enabled'); }
        if (valid()) songRequestShareSync?.resume({ synchronized: synchronizedKey });
      }
      return { ok: true };
    } catch (failure) {
      const error = shareErrorCode(failure); if (valid()) songRequestShare.error = error;
      return { ok: false, error };
    }
    finally { if (songRequestShareController === controller) songRequestShareController = null;
      if (revision === songRequestShareRevision) { songRequestShare.busy = false; songRequestShare.progress = null; songRequestShareBroker?.update(); if (!disposing) publishPanel(); } }
  }
  songRequestShareSync = createSongRequestShareSync({ context: songRequestShareContext,
    publish: () => changeSongRequestShare(false, true),
    cancel: () => {
      songRequestShareController?.abort();
      if (typeof library?.cancelLibrarySharing === 'function') void library.cancelLibrarySharing().catch(() => {});
    }, onChange: () => { if (!disposing) publishPanel(); } });
  catalogue = createCatalogueService({ dataDirectory, client: catalogueClient ?? createChartsHubClient({ fetcher: (url, options) => net.fetch(url, options) }), getLibrary: () => library.matchingSnapshot(), onChange: () => {
    if (!disposing) publishPanel();
  } });
  await catalogue.load();
  libraryDownloadRefresh = createLibraryDownloadRefresh({ context: () => {
    const state = library.status();
    return { active: hostActive && !disposing && !stopTask, lifecycle: lifecycleRevision, root: state.settings.rootPath,
      ready: state.status === 'ready', scanning: state.status === 'scanning', revision: state.revision,
      busy: !!state.cleanupRefreshPending || !!state.badSongsBusy || !!state.bulkCleanup };
  }, scan: () => library.requestScan('quick') });
  downloads = createDownloadService({ dataDirectory, worker: downloadWorker ?? createCatalogueDownloadWorker({ fetcher: (url, options) => net.fetch(url, options) }), onChange: value => {
    downloadNotice('observe', value);
    libraryDownloadRefresh.observe(value);
    if (!disposing) publishPanel();
  } });
  await downloads.load();
  filters = filtersService ?? createFiltersService({ dataDirectory, onChange: () => { if (!disposing) publish(); } });
  try { await filters.load(); } catch { logger.warn('Game filter settings could not be loaded; the original file is preserved'); }
  reshade = reshadeService ?? createReShadeService({ dataDirectory, filtersService: filters, initialRoot: filters.status().rootPath, onChange: () => { if (!disposing) publish(); } });
  try { await reshade.load(); } catch { logger.warn('ReShade connection settings could not be loaded; the original file is preserved'); }
  reshadeSetup = reshadeSetupService ?? createReShadeSetupService({ dataDirectory, filtersService: filters, reshadeService: reshade, onChange: () => {
    if (!disposing) publishPanel();
  } });
  try { await reshadeSetup.load(); } catch { logger.warn('ReShade setup could not be loaded'); }
  function filtersSetupBusy() { return reshadeSetupStarting || !!reshadeSetup?.status().busy; }
  async function installPreparedReShade() {
    if (filtersSetupBusy() || reshadePickerOpen || reshadeConfirmationOpen || filtersPickerOpen || filtersConfirmationOpen) return { ok: false, error: 'Une action sur les filtres est déjà en cours.' };
    const owner = panel, revision = lifecycleRevision;
    reshadeSetupStarting = true;
    try {
      await refreshReShade();
      if (disposing || stopTask || revision !== lifecycleRevision || owner !== panel || owner.isDestroyed()) return { ok: false, error: 'Le panneau a été fermé.' };
      const prepared = reshadeSetup.status(), source = reshade.status();
      if (prepared.state !== 'ready' || !prepared.rootPath || prepared.rootPath !== source.rootPath || prepared.files.length === 0) return { ok: false, error: 'Préparez l’installation pour le dossier sélectionné avant de continuer.' };
      if (source.running !== false) return { ok: false, error: source.running ? 'Fermez Clone Hero avant de lancer l’installation.' : 'L’état de Clone Hero ne peut pas être vérifié. Actualisez l’état avant l’installation.' };
      // The ready screen already presents the concrete version, target and file
      // list. Clicking its install button is the user's confirmation.
      await reshadeSetup.install();
      await refreshReShade(); await refreshFilters();
      return { ok: true };
    } finally { reshadeSetupStarting = false; }
  }
  function refreshFilters() {
    if (disposing || stopTask || filtersRefresh) return filtersRefresh ?? Promise.resolve();
    filtersRefresh = Promise.resolve().then(() => filters.refresh()).catch(() => { logger.warn('Game filters status could not refresh'); }).finally(() => { filtersRefresh = null; });
    return filtersRefresh;
  }
  function startFiltersPolling() {
    if (filtersTimer) return;
    void refreshFilters();
    void refreshReShade();
    filtersTimer = setInterval(() => { void refreshFilters(); void refreshReShade(); }, 1000);
    filtersTimer.unref?.();
  }
  function refreshReShade() {
    if (disposing || stopTask || reshadeRefresh) return reshadeRefresh ?? Promise.resolve();
    reshadeRefresh = Promise.resolve().then(() => reshade.refresh()).catch(() => { logger.warn('ReShade connection could not refresh'); }).finally(() => { reshadeRefresh = null; });
    return reshadeRefresh;
  }
  async function chooseReShadeRoot() {
    if (reshadePickerOpen || reshadeConfirmationOpen || filtersPickerOpen || filtersConfirmationOpen || filtersSetupBusy()) return { ok: false, error: 'Une action sur les filtres est déjà ouverte.' };
    const owner = panel, revision = lifecycleRevision;
    reshadePickerOpen = true;
    try {
      const choice = await dialog.showOpenDialog(owner, { title: tr('Choisir Clone Hero avec ReShade', 'Choose Clone Hero with ReShade'), properties: ['openDirectory'], ...(reshade.status().rootPath ? { defaultPath: reshade.status().rootPath } : {}) });
      if (disposing || stopTask || revision !== lifecycleRevision || owner !== panel || owner.isDestroyed()) return { ok: false, error: 'Le panneau a été fermé.' };
      if (choice.canceled || choice.filePaths.length !== 1) return { ok: true, cancelled: true };
      await reshade.selectRoot(choice.filePaths[0]);
      return { ok: true };
    } finally { reshadePickerOpen = false; }
  }
  async function installReShade() {
    if (reshadePickerOpen || reshadeConfirmationOpen || filtersPickerOpen || filtersConfirmationOpen || filtersSetupBusy()) return { ok: false, error: 'Une action sur les filtres est déjà ouverte.' };
    const owner = panel, revision = lifecycleRevision;
    reshadeConfirmationOpen = true;
    try {
      await refreshReShade();
      if (disposing || stopTask || revision !== lifecycleRevision || owner !== panel || owner.isDestroyed()) return { ok: false, error: 'Le panneau a été fermé.' };
      const status = reshade.status();
      if (!status.rootPath || status.busy || status.running !== false || !status.supported || !status.binaryAvailable) return { ok: false, error: status.running === true ? 'Fermez Clone Hero avant d’installer l’intégration ReShade.' : status.running !== false ? 'L’état de Clone Hero ne peut pas être vérifié. Actualisez l’état avant l’installation.' : status.message || 'L’intégration ReShade ne peut pas être installée dans cet état.' };
      const choice = await dialog.showMessageBox(owner, { type: 'question', title: tr('Connecter les effets ReShade', 'Connect ReShade effects'), message: tr('Installer l’intégration ReShade dans ce dossier ?', 'Install the ReShade integration in this folder?'), detail: tr(`${status.rootPath}\n\nChartsHubReShade.addon64 sera installé dans ce dossier. Si le moteur ChartsHub classique remplace votre ancien ReShade, sa sauvegarde sera restaurée. Vos effets ne seront pas tous activés : vous les choisirez dans le panneau. Relancez Clone Hero pour établir la connexion.`, `${status.rootPath}\n\nChartsHubReShade.addon64 will be installed in this folder. If the classic ChartsHub engine replaced your previous ReShade installation, its backup will be restored. Effects will not all be enabled automatically: choose them in the panel. Restart Clone Hero to establish the connection.`), buttons: [tr('Annuler', 'Cancel'), tr('Installer', 'Install')], defaultId: 0, cancelId: 0, noLink: true });
      if (disposing || stopTask || revision !== lifecycleRevision || owner !== panel || owner.isDestroyed() || status.rootPath !== reshade.status().rootPath) return { ok: false, error: 'Le panneau ou le dossier a changé.' };
      if (choice.response !== 1) return { ok: true, cancelled: true };
      await reshade.install();
      await refreshFilters();
      return { ok: true };
    } finally { reshadeConfirmationOpen = false; }
  }
  async function chooseFiltersRoot() {
    if (filtersPickerOpen || filtersConfirmationOpen || reshadePickerOpen || reshadeConfirmationOpen || filtersSetupBusy()) return { ok: false, error: 'Une action sur le module de filtres est déjà ouverte.' };
    const owner = panel, revision = lifecycleRevision;
    filtersPickerOpen = true;
    try {
      const choice = await dialog.showOpenDialog(owner, { title: tr('Choisir le dossier contenant Clone Hero.exe', 'Choose the folder containing Clone Hero.exe'), properties: ['openDirectory'], ...(filters.status().rootPath ? { defaultPath: filters.status().rootPath } : {}) });
      if (disposing || stopTask || revision !== lifecycleRevision || owner !== panel || owner.isDestroyed()) return { ok: false, error: 'Le panneau a été fermé.' };
      if (choice.canceled || choice.filePaths.length !== 1) return { ok: true, cancelled: true };
      await filters.selectRoot(choice.filePaths[0]);
      return { ok: true };
    } finally { filtersPickerOpen = false; }
  }
  async function changeFiltersModule(action) {
    if (filtersConfirmationOpen || filtersPickerOpen || reshadePickerOpen || reshadeConfirmationOpen || filtersSetupBusy()) return { ok: false, error: 'Une action sur le module de filtres est déjà ouverte.' };
    const owner = panel, revision = lifecycleRevision;
    filtersConfirmationOpen = true;
    try {
      await refreshFilters();
      if (disposing || stopTask || revision !== lifecycleRevision || owner !== panel || owner.isDestroyed()) return { ok: false, error: 'Le panneau a été fermé.' };
      const status = filters.status();
      if (!status.rootPath || status.busy || status.running === true || (action === 'install' && (!status.supported || !status.binaryAvailable))) return { ok: false, error: status.running ? 'Fermez Clone Hero avant de modifier son module de filtres.' : status.message || 'Le module ne peut pas être modifié dans cet état.' };
      const install = action === 'install';
      const choice = await dialog.showMessageBox(owner, { type: 'question', title: install ? tr('Installer les filtres ChartsHub', 'Install ChartsHub filters') : tr('Restaurer le module précédent', 'Restore previous module'), message: install ? tr('Installer le module ChartsHub dans ce dossier ?', 'Install the ChartsHub module in this folder?') : tr('Retirer le module ChartsHub et restaurer la sauvegarde ?', 'Remove the ChartsHub module and restore the backup?'), detail: install ? tr(`${status.rootPath}\n\nLe fichier dxgi.dll sera installé dans ce dossier. Le module précédent sera sauvegardé avant remplacement. Les filtres prendront effet au prochain lancement de Clone Hero.`, `${status.rootPath}\n\ndxgi.dll will be installed in this folder. The previous module will be backed up before replacement. Filters will take effect the next time Clone Hero starts.`) : tr(`${status.rootPath}\n\nLe fichier dxgi.dll de ChartsHub sera retiré. La sauvegarde du module précédent, si elle existe, sera remise à sa place.`, `${status.rootPath}\n\nThe ChartsHub dxgi.dll will be removed. The previous module backup, if available, will be restored.`), buttons: [tr('Annuler', 'Cancel'), install ? tr('Installer', 'Install') : tr('Restaurer', 'Restore')], defaultId: 0, cancelId: 0, noLink: true });
      if (disposing || stopTask || revision !== lifecycleRevision || owner !== panel || owner.isDestroyed() || status.rootPath !== filters.status().rootPath) return { ok: false, error: 'Le panneau ou le dossier a changé.' };
      if (choice.response !== 1) return { ok: true, cancelled: true };
      await filters[action]();
      return { ok: true };
    } finally { filtersConfirmationOpen = false; }
  }
  function downloadOwnerValid(owner, revision) {
    return !disposing && !stopTask && revision === lifecycleRevision && owner && !owner.isDestroyed()
      && (owner === panel || (owner === catalogueWidget && catalogueAllowed()));
  }
  async function chooseDownloadRoot(owner = panel) {
    if (downloadPickerOpen) throw Object.assign(Error('Le choix du dossier de téléchargement est déjà ouvert.'), { code: 'DOWNLOAD_SAFE' });
    const revision = lifecycleRevision;
    downloadPickerOpen = true;
    try {
      const choice = await dialog.showOpenDialog(owner, { title: tr('Choisir le dossier de téléchargements ChartsHub', 'Choose ChartsHub download folder'), properties: ['openDirectory', 'createDirectory'], ...(downloads.status().rootPath ? { defaultPath: downloads.status().rootPath } : {}) });
      if (!downloadOwnerValid(owner, revision)) throw Object.assign(Error('Le panneau a été fermé.'), { code: 'DOWNLOAD_SAFE' });
      if (choice.canceled || choice.filePaths.length !== 1) return false;
      await downloads.selectRoot(choice.filePaths[0]);
      return true;
    } finally { downloadPickerOpen = false; }
  }
  function editorDocument() {
    const state = services.store.getState();
    return { widgets: state.widgets.instances, theme: state.theme, stream: state.stream };
  }
  function saveSettings() {
    clearTimeout(saveTimer); saveTimer = null;
    pendingSave = repository.save({ version: 3, ...editorDocument() })
      .then(() => { persistenceError = ''; publish(); })
      .catch(() => { persistenceError = 'Réglages non enregistrés. Vérifie que le dossier de données est accessible.'; logger.warn('Settings could not be saved'); publish(); });
    return pendingSave;
  }
  function applyEditorState(next) {
    editorRevision++;
    services.store.setState(state => ({ ...state, widgets: { ...state.widgets, instances: next.widgets }, theme: next.theme, stream: next.stream }));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveSettings(), 500);
  }
  function commitWidgets(next) {
    commitEditorState({ ...editorDocument(), widgets: next });
  }
  function commitEditorState(next) {
    if (history.commit(next)) applyEditorState(next);
  }
  function trackProfileWrite(task) {
    profileWrites.add(task);
    void task.then(() => profileWrites.delete(task), () => profileWrites.delete(task));
    return task;
  }
  function changesLockedStreamLayout(next) {
    const document = editorDocument();
    const previous = new Map(document.stream.layout.map(item => [item.id, item]));
    const locked = new Set(document.widgets.filter(widget => widget.locked).map(widget => widget.id));
    return next.layout.some(item => locked.has(item.id) && ['x', 'y', 'width', 'height'].some(key => item[key] !== previous.get(item.id)?.[key]));
  }
  async function ensureStreamServer() {
    if (streamServer) return streamServer;
    if (!streamInit) streamInit = (async () => {
      await fs.mkdir(dataDirectory, { recursive: true });
      const tokenFile = path.join(dataDirectory, 'stream-access.key');
      let token;
      try { token = (await fs.readFile(tokenFile, 'utf8')).trim(); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        token = randomBytes(32).toString('hex');
        try { await fs.writeFile(tokenFile, token + '\n', { flag: 'wx', mode: 0o600 }); }
        catch (writeError) {
          if (writeError.code !== 'EEXIST') throw writeError;
          token = (await fs.readFile(tokenFile, 'utf8')).trim();
        }
      }
      if (!/^[a-f0-9]{64}$/.test(token)) throw Error('Invalid stream access key');
      streamServer = createLocalOverlayServer({ root: __dirname, token, onStatus: publish, visuals: songVisuals });
      return streamServer;
    })().finally(() => { streamInit = null; });
    return streamInit;
  }
  function setStream(enabled) {
    streamDesired = enabled;
    updateVisuals();
    streamTask = streamTask.catch(() => {}).then(async () => {
      if (!streamDesired || disposing || stopTask) {
        await streamServer?.stop();
        publish();
        return;
      }
      try {
        const server = await ensureStreamServer();
        if (!streamDesired || disposing || stopTask) { await server.stop(); return; }
        server.publish(stateView());
        await server.start(services.store.getState().stream.port);
        if (!server.status().enabled) streamDesired = false;
        streamError = null;
      } catch {
        streamDesired = false;
        streamError = 'Le serveur OBS n’a pas pu démarrer. Vérifiez le port et le dossier de réglages.';
        logger.warn('Stream server could not start');
      }
      publish();
    });
    return streamTask;
  }
  async function setOverlay(enabled) {
    if (disposing || stopTask) return;
    overlayEnabled = enabled;
    if (!enabled) { if (overlay && !overlay.isDestroyed()) overlay.hide(); publish(); return; }
    if (!overlay || overlay.isDestroyed()) {
      const bounds = screen.getPrimaryDisplay().bounds;
      overlay = new BrowserWindow({ ...bounds, show: false, frame: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true, focusable: false, skipTaskbar: true, hasShadow: false, resizable: false, movable: false, title: 'ChartsHub — Game Overlay', webPreferences: preferences });
      overlay.setIgnoreMouseEvents(true, { forward: true });
      overlay.setAlwaysOnTop(true, 'screen-saver');
      harden(overlay, 'overlay.html');
      overlay.webContents.on('did-stop-loading', publish);
      overlay.on('closed', () => { overlay = null; });
      const target = overlay;
      overlayLoad = target.loadURL(`${SCHEME}://app/ui/overlay.html`).catch(error => { if (!target.isDestroyed() && overlayEnabled) throw error; });
    }
    if (overlayLoad) await overlayLoad;
    if (disposing || stopTask) return;
    publish();
  }
  function unregisterCatalogueShortcut() {
    if (shortcutRegistered) { try { globalShortcut.unregister(catalogueAccelerator); } catch {} }
    shortcutRegistered = false;
  }
  function registerCatalogueShortcut() {
    if (!catalogueAllowed() || shortcutRegistered) return;
    try {
      shortcutRegistered = globalShortcut?.register(catalogueAccelerator, () => {
        if (shortcutPending || !catalogueAllowed()) return;
        shortcutPending = true;
        void setCatalogueWidget(!catalogueWidgetEnabled).catch(() => {
          shortcutError = 'Le mini Catalogue ne peut pas être ouvert. Vérifiez votre connexion à ChartsHub.';
          publishPanel();
        }).finally(() => { shortcutPending = false; });
      }) === true;
    } catch { shortcutRegistered = false; }
    shortcutError = shortcutRegistered ? null : 'Le raccourci du mini Catalogue est déjà utilisé ou indisponible. Utilisez le bouton du Companion.';
  }
  function setCatalogueAvailable(enabled) {
    if (typeof enabled !== 'boolean') throw TypeError('Invalid catalogue availability');
    catalogueAccess = enabled;
    if (!enabled) {
      songVisuals?.stop();
      void songRequestShareBroker?.stop();
      void songRequestShareSync?.pause({ forget: true });
      songRequestShareManualBusy = null;
      catalogue?.cancelSearch('panel', true); catalogue?.cancelSearch('widget', true);
      songRequestShareRevision++;
      songRequestShareController?.abort(); songRequestShareController = null;
      if (typeof library?.cancelLibrarySharing === 'function') void library.cancelLibrarySharing().catch(() => {});
      songRequestShare = { ...songRequestShare, url: null, count: 0, updatedAt: null, busy: false, error: null, unavailableCount: 0, progress: null };
      catalogueWidgetTicket++; catalogueWidgetEnabled = false;
      unregisterCatalogueShortcut();
      if (catalogueWidget && !catalogueWidget.isDestroyed()) catalogueWidget.destroy();
      catalogueWidgetLoad = null;
    } else { registerCatalogueShortcut(); void refreshSongRequestShare(); }
    if (!disposing) publishPanel();
  }
  async function requireCatalogueAuthorization(owner, revision = lifecycleRevision) {
    let authorized = false;
    try { authorized = catalogueAllowed() && await authorizeCatalogue() === true; } catch {}
    if (!authorized || !catalogueAllowed() || revision !== lifecycleRevision || (owner && (!downloadOwnerValid(owner, revision) || owner !== catalogueWidget))) {
      throw Object.assign(Error('Le mini Catalogue nécessite une connexion ChartsHub active.'), { code: 'CATALOGUE_WIDGET_SAFE' });
    }
  }
  async function setCatalogueWidget(enabled) {
    if (typeof enabled !== 'boolean') throw TypeError('Invalid catalogue widget state');
    const ticket = ++catalogueWidgetTicket, revision = lifecycleRevision;
    if (!enabled) {
      catalogueWidgetEnabled = false;
      catalogue?.cancelSearch('widget');
      if (catalogueWidget && !catalogueWidget.isDestroyed()) catalogueWidget.hide();
      publishPanel(); return;
    }
    await requireCatalogueAuthorization(null, revision);
    if (ticket !== catalogueWidgetTicket) return;
    catalogueWidgetEnabled = true;
    if (!catalogueWidget || catalogueWidget.isDestroyed()) {
      const window = new BrowserWindow({ width: 580, height: 720, minWidth: 280, minHeight: 220, show: false, frame: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true, focusable: true, skipTaskbar: true, resizable: true, movable: true, title: CAPTURE_WINDOW_TITLES.catalogue,
        webPreferences: { ...preferences, additionalArguments: [`--chartshub-companion-language=${language}`] } });
      catalogueWidget = window; harden(window, 'catalogue-widget.html');
      window.on('page-title-updated', event => event.preventDefault());
      window.setAlwaysOnTop(true, 'screen-saver');
      window.on('closed', () => {
        if (catalogueWidget === window) { catalogue?.cancelSearch('widget'); catalogueWidget = null; catalogueWidgetLoad = null; catalogueWidgetEnabled = false; catalogueWidgetTicket++; if (!disposing) publishPanel(); }
      });
      catalogueWidgetLoad = window.loadURL(`${SCHEME}://app/ui/catalogue-widget.html`).catch(error => {
        if (!window.isDestroyed()) window.destroy();
        throw error;
      });
    }
    if (catalogueWidgetLoad) await catalogueWidgetLoad;
    if (ticket !== catalogueWidgetTicket || revision !== lifecycleRevision || !catalogueAllowed() || !catalogueWidgetEnabled || !catalogueWidget || catalogueWidget.isDestroyed()) return;
    catalogueWidget.show(); catalogueWidget.focus(); publishPanel();
  }
  async function setFiltersWidget(enabled) {
    if (disposing || stopTask) return;
    filtersWidgetEnabled = enabled;
    if (!enabled) { if (filtersWidget && !filtersWidget.isDestroyed()) filtersWidget.hide(); publish(); return; }
    if (!filtersWidget || filtersWidget.isDestroyed()) {
      const window = new BrowserWindow({ width: 410, height: 610, minWidth: 360, minHeight: 360, show: false, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: true, movable: true, title: CAPTURE_WINDOW_TITLES.filters, backgroundColor: '#00000000', webPreferences: { ...preferences, additionalArguments: [`--chartshub-companion-language=${language}`] } });
      filtersWidget = window;
      harden(window, 'filters-widget.html');
      window.on('page-title-updated', event => event.preventDefault());
      window.on('closed', () => { if (filtersWidget === window) { filtersWidget = null; filtersWidgetEnabled = false; publish(); } });
      filtersWidgetLoad = window.loadURL(`${SCHEME}://app/ui/filters-widget.html`).catch(error => { if (!window.isDestroyed() && filtersWidgetEnabled) throw error; });
    }
    if (filtersWidgetLoad) await filtersWidgetLoad;
    if (disposing || stopTask || !filtersWidgetEnabled || !filtersWidget || filtersWidget.isDestroyed()) return;
    filtersWidget.showInactive();
    publish();
  }
  async function ensurePlayerWindow() {
    if (disposing || stopTask || !hostActive || !panelAlive()) throw Error('Player unavailable');
    const lifecycle = lifecycleRevision;
    if (!playerWindow || playerWindow.isDestroyed()) {
      const window = new BrowserWindow({ width: 380, height: 510, minWidth: 280, minHeight: 200, show: false, frame: false, transparent: true, alwaysOnTop: true, focusable: true, skipTaskbar: true,
        resizable: true, movable: true, title: CAPTURE_WINDOW_TITLES.player, icon: path.join(__dirname, '..', 'icon.ico'), backgroundColor: '#00000000',
        webPreferences: { ...preferences, autoplayPolicy: 'no-user-gesture-required', additionalArguments: [`--chartshub-companion-language=${language}`] } });
      playerWindow = window;
      harden(window, 'music-player.html');
      window.setAlwaysOnTop(true, 'screen-saver');
      window.on('page-title-updated', event => event.preventDefault());
      window.on('close', event => { if (!disposing && hostActive && !stopTask) { event.preventDefault(); window.hide(); musicPlayer.setWidget(false); } });
      window.on('closed', () => { if (playerWindow === window) { playerWindow = null; playerWindowLoad = null; musicPlayer.stop(); } });
      window.webContents.on('render-process-gone', () => { if (playerWindow === window) { musicPlayer.stop(); if (!window.isDestroyed()) window.destroy(); } });
      playerWindowLoad = window.loadURL(`${SCHEME}://app/ui/music-player.html`).catch(error => { if (!window.isDestroyed()) window.destroy(); throw error; });
    }
    if (playerWindowLoad) await playerWindowLoad;
    if (disposing || stopTask || !hostActive || lifecycle !== lifecycleRevision || !playerWindow || playerWindow.isDestroyed()) throw Error('Player unavailable');
    publishPanel();
    return playerWindow;
  }
  async function setPlayerWidget(enabled) {
    musicPlayer.setWidget(enabled);
    if (!enabled) { if (playerWindow && !playerWindow.isDestroyed()) playerWindow.hide(); return; }
    try {
      const window = await ensurePlayerWindow();
      if (musicPlayer.snapshot().widgetEnabled) window.showInactive();
    } catch (error) { musicPlayer.setWidget(false); throw error; }
  }
  function trustedPanel(event) { return panelAlive() && trustedContentsSender(event, panelContents, 'index.html'); }
  function savePlayerPreferences(change) {
    const task = playerPreferencesTask.then(async () => {
      const current = playerPreferences.status();
      try {
        const saved = await playerPreferences.save({ appearance: current.appearance, videoEnabled: current.videoEnabled, volume: current.volume, shuffle: current.shuffle, playlists: current.playlists, ...(typeof change === 'function' ? change(current) : change) });
        musicPlayer.applyPreferences(saved);
        return { ok: true };
      } catch (error) {
        musicPlayer.applyPreferences(playerPreferences.status());
        throw error;
      }
    });
    playerPreferencesTask = task.catch(() => {}); return task;
  }
  function trustedPlayer(event) { return trustedSender(event, playerWindow, 'music-player.html'); }
  function canRead(event) { return trustedPanel(event) || trustedSender(event, overlay, 'overlay.html'); }
  ipcMain.handle('companion:snapshot', event => trustedPanel(event) ? snapshot() : trustedPlayer(event) ? playerWidgetSnapshot() : canRead(event) ? { ...snapshot(), songRequests: undefined, player: undefined } : trustedSender(event, filtersWidget, 'filters-widget.html') ? filtersWidgetSnapshot() : catalogueAllowed() && trustedSender(event, catalogueWidget, 'catalogue-widget.html') ? catalogueWidgetSnapshot() : null);
  ipcMain.handle('companion:command', async (event, command, payload) => {
    const mini = catalogueAllowed() && trustedCatalogueWidgetCommand(event, catalogueWidget, command, payload);
    const playerSender = trustedPlayer(event) && typeof command === 'string' && (command.startsWith('player.') || (command === 'panels.appearance' && payload?.panel === 'player'));
    if (disposing || stopTask || maintenanceLocked || !(trustedPanel(event) || trustedFiltersWidgetCommand(event, filtersWidget, command, payload) || mini || playerSender) || !validCommand(command, payload, services.store.getState().widgets.instances.map(w => w.id))) return { ok: false, error: 'Commande non autorisée.' };
    if (['widget.layout', 'widget.visibility', 'widget.appearance', 'widget.fontSize', 'widget.accuracy', 'widget.lyrics', 'widget.locked', 'theme.preset', 'theme.color', 'theme.effects', 'stream.settings', 'profile.save', 'profile.apply'].includes(command) && payload.revision !== editorRevision) return { ok: false, code: 'STALE_REVISION', error: 'Les réglages ont changé. Réessaie avec leur version actuelle.' };
    try {
      if (command === 'player.report' || command === 'player.spectrum' || command === 'player.ended') {
        if (!trustedPlayer(event)) return { ok: false };
        if (command === 'player.ended') return await musicPlayer.ended(payload);
        if (command === 'player.report') return musicPlayer.report(payload);
        if (!musicPlayer.acceptSpectrum(payload)) return { ok: false };
        const now = performance.now();
        if ((now - playerSpectrumAt >= 80 || payload.bands.every(value => value === 0)) && panelAlive() && !panelContents.isLoading()) { playerSpectrumAt = now; panelContents.send('companion:player-spectrum', payload); }
        return { ok: true };
      }
      if (command === 'player.search') {
        const result = await library.queryPlayback({ query: payload.query, offset: payload.offset ?? 0, limit: payload.limit ?? 50, ...(payload.filters ? { filters: payload.filters } : {}) });
        return { ok: true, result: { ...result, items: result.items.map(item => Object.fromEntries(['id', 'title', 'artist', 'charter', 'album', 'year', 'genre', 'tracks', 'format', 'audio'].map(key => [key, item[key]]))) } };
      }
      if (command === 'player.select') { await ensurePlayerWindow(); return await musicPlayer.select(payload.id); }
      if (command === 'player.control') return payload.action === 'volume' ? await savePlayerPreferences({ volume: payload.value }) : await musicPlayer.control(payload.action, payload.value);
      if (command === 'player.widget') { await setPlayerWidget(payload.enabled); return { ok: true }; }
      if (command === 'capture.player') { await setPlayerWidget(true); return { ok: true }; }
      if (command === 'gameCapture.open') { await (await ensureGameCapture()).open(); return { ok: true }; }
      if (command === 'player.video') return await savePlayerPreferences({ videoEnabled: payload.enabled });
      if (command === 'player.appearance') return await savePlayerPreferences({ appearance: payload.appearance });
      if (command === 'player.shuffle') return await savePlayerPreferences({ shuffle: payload.enabled });
      if (command === 'player.playPlaylist') { await ensurePlayerWindow(); return await musicPlayer.playPlaylist(payload.id); }
      if (['player.playlistCreate', 'player.playlistRename', 'player.playlistDelete', 'player.playlistAdd', 'player.playlistRemove'].includes(command)) {
        let playlistId;
        const result = await savePlayerPreferences(current => {
          if (library.status().status !== 'ready') throw Error('Library unavailable');
          const updated = changeMusicPlaylist(current, command.slice('player.playlist'.length).toLowerCase(), payload, library.matchingSnapshot());
          playlistId = updated.playlistId; return { playlists: updated.playlists };
        });
        return { ...result, playlistId };
      }
      if (command === 'songRequests.configure') return await configureSongRequests(payload);
      if (command === 'songRequests.widget') { await songRequestPreferences.saveWidget(payload.settings); publishPanel(); return { ok: true }; }
      if (['songRequests.connect', 'songRequests.disconnect', 'songRequests.cancelAuth'].includes(command) && !hostActive) return { ok: false };
      if (command === 'songRequests.connect') {
        // Consent and LIVE connection run in the background so Cancel/Stop remain usable.
        void songRequestConnections.connect(payload.platform, payload).catch(() => {});
        return { ok: true };
      }
      if (command === 'songRequests.disconnect') return await songRequestConnections.disconnect(payload.platform);
      if (command === 'songRequests.cancelAuth') return await songRequestConnections.cancelAuth(payload.platform);
      if (command === 'songRequests.publishLibrary' || command === 'songRequests.removeLibrary') return await changeSongRequestShare(command.endsWith('removeLibrary'));
      if (command === 'songRequests.copyLibraryUrl') {
        if (!songRequestShare.url || songRequestShare.busy) return { ok: false };
        clipboard.writeText(songRequestShare.url); return { ok: true };
      }
      if (['songRequests.accept', 'songRequests.reject', 'songRequests.played', 'songRequests.move', 'songRequests.resetOrder'].includes(command)) {
        const action = command.slice('songRequests.'.length);
        const result = await (action === 'resetOrder' ? songRequests.resetOrder() : action === 'move' ? songRequests.move(payload.id, { direction: payload.direction }) : songRequests[action](payload.id));
        publishPanel(); return result;
      }
      if (command === 'songRequests.copyBridgeConfiguration' || command === 'songRequests.copyOverlayUrl') {
        const bridge = songRequestServer?.status();
        if (!songRequests.snapshot().enabled || !bridge?.enabled) return { ok: false, error: 'Activez la réception avant de copier la configuration.' };
        clipboard.writeText(command.endsWith('copyOverlayUrl') ? bridge.overlayUrl : JSON.stringify(songRequestServer.bridgeConfiguration()));
        return { ok: true };
      }
      if (command === 'catalogue.widget') { await setCatalogueWidget(payload.enabled); return { ok: true }; }
      if (command === 'panels.appearance') {
        await floatingPanels.update(payload); publish();
        return { ok: true, result: mini ? floatingPanelSnapshot('catalogue') : trustedPanel(event) ? floatingPanels.status() : floatingPanelSnapshot(playerSender ? 'player' : 'filters') };
      }
      if (command.startsWith('mock.') && integration.status().mode !== 'mock') return { ok: false, error: 'Les commandes de démonstration sont disponibles uniquement en mode Démonstration.' };
      if (command === 'profile.save') {
        const result = await trackProfileWrite(profiles.save({ revision: payload.profilesRevision, ...(payload.id ? { id: payload.id } : {}), name: payload.name, document: { version: 3, ...editorDocument() } }));
        preferredProfileId = result.id;
        publish();
        return { ok: true, result: { id: result.id }, revision: editorRevision };
      } else if (command === 'profile.apply') {
        const lifecycle = lifecycleRevision;
        const saved = await profiles.get({ revision: payload.profilesRevision, id: payload.id });
        if (disposing || stopTask || lifecycle !== lifecycleRevision) return { ok: false, error: 'Le panneau a été fermé.' };
        if (payload.revision !== editorRevision) return { ok: false, code: 'STALE_REVISION', error: 'Les réglages ont changé. Réessaie avec leur version actuelle.' };
        const next = validateSettings({ version: 3, ...saved, stream: { ...saved.stream, port: editorDocument().stream.port } });
        preferredProfileId = payload.id;
        commitEditorState({ widgets: next.widgets, theme: next.theme, stream: next.stream });
      } else if (command === 'profile.delete') {
        await trackProfileWrite(profiles.remove({ revision: payload.profilesRevision, id: payload.id }));
        if (preferredProfileId === payload.id) preferredProfileId = null;
      } else if (command === 'reshade.setupPrepare') {
        if (filtersSetupBusy() || reshadePickerOpen || reshadeConfirmationOpen || filtersPickerOpen || filtersConfirmationOpen) return { ok: false, error: 'Une action sur les filtres est déjà en cours.' };
        await reshadeSetup.prepare(payload);
      }
      else if (command === 'reshade.setupInstall') return await installPreparedReShade();
      else if (command === 'reshade.setupCancel') {
        if (reshadeSetupStarting || reshadeSetup.status().state === 'installing') return { ok: false, error: 'L’installation est déjà en cours.' };
        await reshadeSetup.cancel();
      }
      else if (command === 'reshade.chooseRoot') return await chooseReShadeRoot();
      else if (command === 'reshade.install') return await installReShade();
      else if (command === 'reshade.refresh') await refreshReShade();
      else if (command === 'reshade.command') await reshade.command(payload);
      else if (command === 'filters.chooseRoot') return await chooseFiltersRoot();
      else if (command === 'filters.install' || command === 'filters.restore') return await changeFiltersModule(command.slice('filters.'.length));
      else if (command === 'filters.settings') await filters.setSettings(payload.settings);
      else if (command === 'filters.refresh') await refreshFilters();
      else if (command === 'filters.widget') await setFiltersWidget(payload.enabled);
      else if (command === 'filters.openPanel') { await open(); filtersFocusRevision++; }
      else if (command === 'clonehero.mode') await integration.setMode(payload.mode);
      else if (command === 'telemetry.enabled') await telemetry.setEnabled(payload.enabled);
      else if (command === 'telemetry.configure') await telemetry.configure(payload);
      else if (command === 'telemetry.sessionReset') telemetry.resetSession();
      else if (command === 'telemetry.calibrationStart') telemetry.startCalibration(payload.stage, payload.settingMs, payload.source);
      else if (command === 'telemetry.calibrationFinish') telemetry.finishCalibration();
      else if (command === 'telemetry.guide') await shell.openExternal('https://wiki.clonehero.net/books/guides-and-tutorials/page/calibrating-audio-and-video');
      else if (command === 'telemetry.widgets') {
        const next = ensureGameplayDocument({ version: 3, ...editorDocument() });
        const types = new Set(['gameplay.accuracy','gameplay.combo','gameplay.fc','gameplay.progress','gameplay.comparison','session.goal','session.history']);
        commitEditorState({ ...next, widgets: next.widgets.map(widget => types.has(widget.type) ? { ...widget, enabled: true, visibility: { ...widget.visibility, stream: true } } : widget) });
      }
      else if (command === 'clonehero.detect') await integration.detect();
      else if (command === 'clonehero.chooseFile') {
        if (cloneHeroPickerOpen) return { ok: false, error: 'Le choix du fichier est déjà ouvert.' };
        cloneHeroPickerOpen = true;
        const owner = panel, revision = lifecycleRevision;
        try {
          const choice = await dialog.showOpenDialog(owner, { title: tr('Choisir currentsong.txt de Clone Hero', 'Choose Clone Hero currentsong.txt'), properties: ['openFile'], filters: [{ name: 'Export Clone Hero', extensions: ['txt'] }], ...(integration.status().filePath ? { defaultPath: integration.status().filePath } : {}) });
          if (disposing || stopTask || revision !== lifecycleRevision || owner !== panel || owner.isDestroyed()) return { ok: false, error: 'Le panneau a été fermé.' };
          if (choice.canceled || choice.filePaths.length !== 1) return { ok: true, cancelled: true };
          await integration.selectFile(choice.filePaths[0]);
        } finally { cloneHeroPickerOpen = false; }
      }
      else if (command === 'mock.next') integration.step();
      else if (command === 'mock.reset') integration.reset();
      else if (command === 'mock.state') integration.transition(payload.state);
      else if (command === 'widget.enabled') {
        commitWidgets(services.store.getState().widgets.instances.map(w => w.id === payload.id ? { ...w, enabled: payload.enabled } : w));
      } else if (command === 'widget.layout') {
        const changes = new Map(payload.items.map(item => [item.id, item]));
        if (services.store.getState().widgets.instances.some(widget => widget.locked && changes.has(widget.id))) return { ok: false, code: 'WIDGET_LOCKED', error: 'Déverrouillez le widget avant de modifier sa disposition.' };
        if (payload.destination === 'stream') {
          const document = editorDocument();
          const next = { ...document.stream, layout: document.stream.layout.map(item => changes.has(item.id) ? { ...changes.get(item.id) } : item) };
          commitEditorState({ ...document, stream: validateStream(next, document.widgets) });
        } else {
          commitWidgets(services.store.getState().widgets.instances.map(widget => {
            const item = changes.get(widget.id);
            return item ? { ...widget, position: { x: item.x, y: item.y }, size: { width: item.width, height: item.height } } : widget;
          }));
        }
      } else if (command === 'widget.visibility') {
        commitWidgets(services.store.getState().widgets.instances.map(widget => widget.id === payload.id
          ? { ...widget, visibility: { ...widget.visibility, game: payload.game, ...(payload.stream === undefined ? {} : { stream: payload.stream }) }, gameplayVisibility: [...payload.gameplayVisibility] } : widget));
      } else if (command === 'theme.preset') {
        commitEditorState({ ...editorDocument(), theme: themeService.applyPreset(payload.id) });
      } else if (command === 'theme.color') {
        commitEditorState({ ...editorDocument(), theme: themeService.setColor(editorDocument().theme, payload.token, payload.color) });
      } else if (command === 'theme.effects') {
        commitEditorState({ ...editorDocument(), theme: themeService.setEffects(editorDocument().theme, payload.effects) });
      } else if (command === 'widget.appearance') {
        const style = validateWidgetStyle(payload.style);
        commitWidgets(services.store.getState().widgets.instances.map(widget => widget.id === payload.id ? { ...widget, style } : widget));
      } else if (command === 'widget.fontSize') {
        commitWidgets(services.store.getState().widgets.instances.map(widget => widget.id === payload.id
          ? { ...widget, style: { ...widget.style, fontSize: payload.fontSize } } : widget));
      } else if (command === 'widget.accuracy') {
        if (services.store.getState().widgets.instances.find(widget => widget.id === payload.id)?.type !== 'gameplay.accuracy') return { ok: false, error: 'Ce réglage concerne uniquement Accuracy.' };
        const config = require('./dist/widgets/core/Gameplay/AccuracyConfig.js').validateAccuracyConfig(payload.config);
        commitWidgets(services.store.getState().widgets.instances.map(widget => widget.id === payload.id ? { ...widget, config } : widget));
      } else if (command === 'widget.lyrics') {
        if (services.store.getState().widgets.instances.find(widget => widget.id === payload.id)?.type !== 'song.lyrics') return { ok: false, error: 'Ce réglage concerne uniquement les paroles.' };
        const config = require('./dist/widgets/core/Gameplay/LyricsConfig.js').validateLyricsConfig(payload.config);
        commitWidgets(services.store.getState().widgets.instances.map(widget => widget.id === payload.id ? { ...widget, config } : widget));
      } else if (command === 'widget.locked') {
        commitWidgets(services.store.getState().widgets.instances.map(widget => widget.id === payload.id ? { ...widget, locked: payload.locked } : widget));
      } else if (command === 'editor.undo' || command === 'editor.redo') {
        const pending = command === 'editor.undo' ? history.peekUndo() : history.peekRedo();
        if (pending && (streamDesired || streamStatus().enabled) && pending.stream.port !== editorDocument().stream.port) return { ok: false, error: 'Arrêtez le serveur OBS avant d’annuler un changement de port.' };
        const next = command === 'editor.undo' ? history.undo() : history.redo();
        if (next) applyEditorState(next);
      } else if (command === 'stream.settings') {
        const document = editorDocument();
        const next = validateStream(payload.settings, document.widgets);
        if (changesLockedStreamLayout(next)) return { ok: false, code: 'WIDGET_LOCKED', error: 'Déverrouillez le widget avant de modifier sa disposition Stream.' };
        if ((streamDesired || streamStatus().enabled) && next.port !== document.stream.port) return { ok: false, error: 'Arrêtez le serveur OBS avant de changer son port.' };
        commitEditorState({ ...document, stream: next });
      } else if (command === 'stream.enabled') {
        await setStream(payload.enabled);
        if (payload.enabled && !streamStatus().enabled) return { ok: false, error: streamStatus().error || streamError || 'Le serveur OBS est indisponible.' };
      } else if (command === 'visuals.select') {
        await songVisuals.select(payload);
      } else if (command === 'visuals.copyUrl') {
        const value = streamStatus(), url = payload.kind === 'background' ? value.backgroundUrl : value.videoUrl;
        if (!value.enabled || !url) return { ok: false, error: 'Activez le serveur OBS pour copier cette source.' };
        clipboard.writeText(url);
      } else if (command === 'stream.copyUrl') {
        const status = streamStatus();
        if (!status.enabled || !status.url) return { ok: false, error: 'Activez le serveur OBS avant de copier son adresse.' };
        clipboard.writeText(status.url);
      } else if (command.startsWith('library.') && !['library.query', 'library.openFolder', 'library.cleanupHistory', 'library.cancelBulkCleanup'].includes(command) && (cleanupDialogOpen || cleanupTask)) {
        return { ok: false, error: 'Terminez ou annulez le nettoyage des copies avant cette action.' };
      } else if (command === 'library.query') {
        return { ok: true, result: await library.query(payload) };
      } else if (command === 'library.verifyAllDuplicates') {
        return { ok: true, result: await library.verifyAllDuplicates() };
      } else if (command === 'library.cancelDuplicateVerification') {
        return { ok: true, result: await library.cancelDuplicateVerification() };
      } else if (command === 'library.cleanupHistory') {
        return { ok: true, result: await library.cleanupHistory(payload) };
      } else if (command === 'library.compareDuplicates' || command === 'library.chooseDuplicate' || command === 'library.keepDuplicateVersions' || command === 'library.prepareCleanup' || command === 'library.prepareBulkCleanup' || command === 'library.cancelBulkCleanup') {
        return { ok: true, result: await library[command.slice('library.'.length)](payload) };
      } else if (command === 'library.recycleBulkDifferences') {
        const owner = panel, lifecycle = lifecycleRevision;
        const request = { planId: payload.planId, revision: payload.revision, ids: [...payload.ids] };
        cleanupDialogOpen = true;
        try {
          const review = await library.bulkCleanupReview(request);
          const root = library.status().settings.rootPath;
          if (disposing || stopTask || lifecycle !== lifecycleRevision || owner !== panel || owner.isDestroyed()) return { ok: true, cancelled: true };
          const keepers = new Map(review.keepers.map(keep => [keep.id, keep]));
          const totalBytes = review.candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
          const choice = await dialog.showMessageBox(owner, { type: 'warning',
            title: tr('Supprimer les versions différentes sélectionnées ?', 'Delete the selected different versions?'),
            message: tr(`${review.candidates.length} copie(s) différente(s) sélectionnée(s) · ${totalBytes} octets.`, `${review.candidates.length} selected different copy/copies · ${totalBytes} bytes.`),
            detail: tr(`Versions conservées :\n${review.keepers.map(keep => keep.targetRelativePath).join('\n')}\n\nCopies sélectionnées :\n${review.candidates.map(candidate => `${candidate.targetRelativePath} → conserver ${keepers.get(candidate.keeperId)?.targetRelativePath}`).join('\n')}\n\nLes notes, l’audio et/ou des fichiers non audio peuvent être différents. Seules les copies sélectionnées seront envoyées à la Corbeille Windows, avec tous leurs fichiers. Aucune suppression définitive ne sera utilisée.`, `Kept versions:\n${review.keepers.map(keep => keep.targetRelativePath).join('\n')}\n\nSelected copies:\n${review.candidates.map(candidate => `${candidate.targetRelativePath} → keep ${keepers.get(candidate.keeperId)?.targetRelativePath}`).join('\n')}\n\nNotes, audio and/or non-audio files may differ. Only the selected copies and all their files will be sent to the Windows Recycle Bin. Permanent deletion is never used.`),
            buttons: [tr('Annuler', 'Cancel'), tr('Envoyer la sélection à la Corbeille', 'Send selection to Recycle Bin')], defaultId: 0, cancelId: 0, noLink: true });
          if (choice.response !== 1 || disposing || stopTask || lifecycle !== lifecycleRevision || owner !== panel || owner.isDestroyed()) return { ok: true, cancelled: true };
          const keeps = new Map(review.candidates.map(candidate => {
            const keep = keepers.get(candidate.keeperId);
            if (!keep?.targetRelativePath) throw Error('Version conservée invalide.');
            return [path.resolve(root, candidate.targetRelativePath), path.resolve(root, keep.targetRelativePath)];
          }));
          cleanupApproval = { owner, lifecycle, root, keeps, targets: new Set(keeps.keys()) };
          cleanupTask = library.recycleBulkDifferences(request);
          return { ok: true, result: await cleanupTask };
        } finally { cleanupApproval = null; cleanupTask = null; cleanupDialogOpen = false; }
      } else if (command === 'library.forceRecycleDuplicate') {
        const owner = panel, lifecycle = lifecycleRevision;
        const request = { planId: payload.planId, revision: payload.revision, id: payload.id };
        cleanupDialogOpen = true;
        try {
          const review = await library.cleanupForceReview(request);
          const root = library.status().settings.rootPath;
          if (disposing || stopTask || lifecycle !== lifecycleRevision || owner !== panel || owner.isDestroyed()) return { ok: true, cancelled: true };
          const candidate = review.candidates[0];
          const choice = await dialog.showMessageBox(owner, { type: 'warning',
            title: tr('Supprimer quand même cette copie ?', 'Delete this copy anyway?'),
            message: tr('Cette copie vérifiée diffère de la version conservée.', 'This verified copy differs from the kept version.'),
            detail: tr(`Version conservée : ${review.keep.targetRelativePath}\n\nCopie à supprimer : ${candidate.targetRelativePath}\nTaille conservée : ${review.keep.bytes} octets\nTaille de la copie : ${candidate.bytes} octets\nAudio conservé : ${review.keep.audio.bytes} octets\nAudio de la copie : ${candidate.audio.bytes} octets\n\nLes notes, l’audio et/ou des fichiers non audio peuvent être différents. La copie complète sera envoyée à la Corbeille Windows. Cette action n’est pas automatique et aucune suppression définitive ne sera utilisée.`, `Kept version: ${review.keep.targetRelativePath}\n\nCopy to delete: ${candidate.targetRelativePath}\nKept size: ${review.keep.bytes} bytes\nCopy size: ${candidate.bytes} bytes\nKept audio: ${review.keep.audio.bytes} bytes\nCopy audio: ${candidate.audio.bytes} bytes\n\nNotes, audio and/or non-audio files may differ. The complete copy will be sent to the Windows Recycle Bin. This action is not automatic and permanent deletion is never used.`),
            buttons: [tr('Annuler', 'Cancel'), tr('Supprimer quand même', 'Delete anyway')], defaultId: 0, cancelId: 0, noLink: true });
          if (choice.response !== 1 || disposing || stopTask || lifecycle !== lifecycleRevision || owner !== panel || owner.isDestroyed()) return { ok: true, cancelled: true };
          cleanupApproval = { owner, lifecycle, root, keep: path.resolve(root, review.keep.targetRelativePath), targets: new Set([path.resolve(root, candidate.targetRelativePath)]) };
          cleanupTask = library.forceRecycleDuplicate(request);
          return { ok: true, result: await cleanupTask };
        } finally { cleanupApproval = null; cleanupTask = null; cleanupDialogOpen = false; }
      } else if (command === 'library.recycleDuplicates') {
        const owner = panel, lifecycle = lifecycleRevision;
        const request = { planId: payload.planId, revision: payload.revision, ids: [...payload.ids] };
        cleanupDialogOpen = true;
        try {
          const review = await library.cleanupReview(request);
          const root = library.status().settings.rootPath;
          if (disposing || stopTask || lifecycle !== lifecycleRevision || owner !== panel || owner.isDestroyed()) return { ok: true, cancelled: true };
          const choice = await dialog.showMessageBox(owner, { type: 'warning', title: tr('Envoyer les copies à la Corbeille Windows', 'Send copies to Windows Recycle Bin'),
            message: tr(`Envoyer ${review.candidates.length} copie(s) sélectionnée(s) à la Corbeille ?`, `Send ${review.candidates.length} selected copy/copies to the Recycle Bin?`),
            detail: tr(`Version conservée : ${review.keep.targetRelativePath}\n\nCopies sélectionnées :\n${review.candidates.map(item => `${item.kind === 'folder' ? 'Dossier entier' : 'Fichier SNG'} : ${item.targetRelativePath}`).join('\n')}\n\nLes dossiers sont déplacés avec tous leurs fichiers. Aucune suppression définitive ne sera utilisée si la Corbeille est indisponible.`, `Kept version: ${review.keep.targetRelativePath}\n\nSelected copies:\n${review.candidates.map(item => `${item.kind === 'folder' ? 'Entire folder' : 'SNG file'} : ${item.targetRelativePath}`).join('\n')}\n\nFolders are moved with all their files. Permanent deletion is never used if the Recycle Bin is unavailable.`),
            buttons: [tr('Annuler', 'Cancel'), tr('Envoyer à la Corbeille', 'Send to Recycle Bin')], defaultId: 0, cancelId: 0, noLink: true });
          if (choice.response !== 1 || disposing || stopTask || lifecycle !== lifecycleRevision || owner !== panel || owner.isDestroyed()) return { ok: true, cancelled: true };
          cleanupApproval = { owner, lifecycle, root, keep: path.resolve(root, review.keep.targetRelativePath), targets: new Set(review.candidates.map(item => path.resolve(root, item.targetRelativePath))) };
          cleanupTask = library.recycleDuplicates(request);
          return { ok: true, result: await cleanupTask };
        } finally { cleanupApproval = null; cleanupTask = null; cleanupDialogOpen = false; }
      } else if (command === 'library.chooseBadSongs') {
        if (rootPickerOpen) return { ok: false, error: 'Le choix du fichier est déjà ouvert.' };
        const owner = panel, lifecycle = lifecycleRevision;
        rootPickerOpen = true;
        try {
          const exportPath = integration.status().filePath;
          const choice = await dialog.showOpenDialog(owner, { title: tr('Importer badsongs.txt de Clone Hero', 'Import Clone Hero badsongs.txt'), properties: ['openFile'], filters: [{ name: 'Clone Hero badsongs.txt', extensions: ['txt'] }],
            defaultPath: path.join(exportPath ? path.dirname(exportPath) : app.getPath('documents'), exportPath ? 'badsongs.txt' : 'Clone Hero/badsongs.txt') });
          if (disposing || stopTask || lifecycle !== lifecycleRevision || owner !== panel || owner.isDestroyed()) return { ok: true, cancelled: true };
          if (choice.canceled || choice.filePaths.length !== 1) return { ok: true, cancelled: true };
          return { ok: true, result: await library.prepareBadSongs(choice.filePaths[0]) };
        } finally { rootPickerOpen = false; }
      } else if (command === 'library.cancelBadSongs') {
        return { ok: true, result: await library.cancelBadSongs() };
      } else if (command === 'library.recycleBadSongs') {
        const owner = panel, lifecycle = lifecycleRevision, request = { planId: payload.planId, revision: payload.revision, ids: [...payload.ids] };
        cleanupDialogOpen = true;
        try {
          const review = await library.badSongsReview(request), root = library.status().settings.rootPath;
          if (disposing || stopTask || lifecycle !== lifecycleRevision || owner !== panel || owner.isDestroyed()) return { ok: true, cancelled: true };
          const paths = review.entries.map(entry => path.resolve(root, ...entry.targetRelativePath.split('/')));
          const choice = await dialog.showMessageBox(owner, { type: 'warning', title: tr('Supprimer les charts signalées par Clone Hero ?', 'Delete charts reported by Clone Hero?'),
            message: tr(paths.length + ' chart(s) sélectionnée(s).', paths.length + ' selected chart(s).'),
            detail: tr('Dossier Songs : ', 'Songs folder: ') + root + '\n\n' + review.entries.map((entry, index) => paths[index] + '\n' + entry.reasons.join('\n')).join('\n\n') + '\n\n' + tr('Les dossiers sélectionnés et tout leur contenu seront envoyés à la Corbeille Windows. Les charts non cochées restent en place.', 'Selected folders and all their contents will be sent to the Windows Recycle Bin. Unchecked charts stay in place.'),
            buttons: [tr('Annuler', 'Cancel'), tr('Envoyer la sélection à la Corbeille', 'Send selection to Recycle Bin')], defaultId: 0, cancelId: 0, noLink: true });
          if (choice.response !== 1 || disposing || stopTask || lifecycle !== lifecycleRevision || owner !== panel || owner.isDestroyed()) return { ok: true, cancelled: true };
          cleanupApproval = { owner, lifecycle, root, kind: 'bad-songs', targets: new Set(paths) };
          cleanupTask = library.recycleBadSongs(request);
          return { ok: true, result: await cleanupTask };
        } finally { cleanupApproval = null; cleanupTask = null; cleanupDialogOpen = false; }
      } else if (command === 'library.chooseRoot') {
        if (rootPickerOpen) return { ok: false, error: 'Le choix du dossier est déjà ouvert.' };
        const owner = panel, revision = lifecycleRevision;
        rootPickerOpen = true;
        try {
          const choice = await dialog.showOpenDialog(owner, { title: tr('Choisir le dossier de chansons Clone Hero', 'Choose Clone Hero Songs folder'), properties: ['openDirectory'], ...(library.status().settings.rootPath ? { defaultPath: library.status().settings.rootPath } : {}) });
          if (disposing || stopTask || revision !== lifecycleRevision || owner !== panel || owner.isDestroyed()) return { ok: false, error: 'Le panneau a été fermé.' };
          if (!choice.canceled && choice.filePaths.length === 1) await library.selectRoot(choice.filePaths[0]);
        } finally { rootPickerOpen = false; }
      } else if (command === 'library.scan') {
        await library.requestScan(payload.mode);
      } else if (command === 'library.cancel') {
        await library.cancel();
      } else if (command === 'library.settings') {
        await library.configure(payload);
      } else if (command === 'library.openFolder') {
        const folder = await library.resolveSongFolder(payload.id);
        if (!folder || await shell.openPath(folder)) return { ok: false, error: 'Ce dossier de chanson n’est plus accessible.' };
      } else if (command === 'catalogue.search') {
        const searchRevision = lifecycleRevision, searchTicket = catalogueWidgetTicket;
        if (payload.externalSearch && payload.source !== 'chartshub' && (!catalogueAllowed() || mini && !catalogueWidgetEnabled)) return { ok: false, error: 'Cette recherche nécessite un panneau ChartsHub actif.' };
        const isCurrent = () => !disposing && !stopTask && searchRevision === lifecycleRevision && (!mini || searchTicket === catalogueWidgetTicket);
        const result = await catalogue.search(payload, { scope: mini ? 'widget' : 'panel', isCurrent });
        if (!isCurrent()) return { ok: false, error: 'La recherche a été remplacée ou le panneau fermé.' };
        return { ok: true, result };
      } else if (command === 'catalogue.favorite') {
        return { ok: true, result: await catalogue.favorite(payload) };
      } else if (command === 'catalogue.candidates') {
        return { ok: true, result: await catalogue.candidates(payload.localId) };
      } else if (command === 'catalogue.refresh') {
        await catalogue.refresh();
      } else if (command === 'catalogue.link') {
        return { ok: true, result: await catalogue.link(payload) };
      } else if (command === 'catalogue.unlink') {
        return { ok: true, result: await catalogue.unlink(payload) };
      } else if (command === 'catalogue.open') {
        await shell.openExternal(await catalogue.openUrl(payload.chartId));
      } else if (command === 'downloads.chooseRoot') {
        const owner = mini ? catalogueWidget : panel;
        if (mini) await requireCatalogueAuthorization(owner);
        if (!await chooseDownloadRoot(owner)) return { ok: true, cancelled: true };
      } else if (command === 'downloads.enqueue') {
        const owner = mini ? catalogueWidget : panel, revision = lifecycleRevision;
        const notificationScope = downloadNotice('capture');
        if (mini) await requireCatalogueAuthorization(owner, revision);
        // Validate catalogue membership before any dialog, and again after its await.
        catalogue.downloadDescriptor(payload.chartId);
        if (!downloads.status().rootPath && !await chooseDownloadRoot(owner)) return { ok: true, cancelled: true };
        if (mini) await requireCatalogueAuthorization(owner, revision);
        const before = downloads.status(), existing = before.items.some(item => item.chartId === payload.chartId && item.rootPath === before.rootPath && item.state !== 'Cancelled');
        const result = await downloads.enqueue(catalogue.downloadDescriptor(payload.chartId));
        if (!existing) downloadNotice('track', notificationScope, result.id, downloads.status());
        return { ok: true, result };
      } else if (command === 'downloads.openFolder') {
        const owner = panel, revision = lifecycleRevision;
        const folder = await downloads.resolveFolder(payload.id);
        if (disposing || revision !== lifecycleRevision || owner !== panel || owner.isDestroyed() || !folder || await shell.openPath(folder)) return { ok: false, error: 'Le dossier de ce téléchargement n’est plus accessible.' };
      } else if (['downloads.pause', 'downloads.resume', 'downloads.cancel', 'downloads.retry', 'downloads.remove'].includes(command)) {
        const notificationScope = ['downloads.resume', 'downloads.retry'].includes(command) ? downloadNotice('capture') : null;
        await downloads[command.slice('downloads.'.length)](payload.id);
        if (notificationScope) downloadNotice('track', notificationScope, payload.id, downloads.status(), { restart: true });
      } else if (command === 'overlay.enabled') await setOverlay(payload.enabled);
      publish();
      return { ok: true, revision: editorRevision };
    } catch (error) {
      logger.error('Companion command failed');
      if (command.startsWith('player.')) return { ok: false, error: ['MUSIC_PLAYER_PREFERENCES_SAFE', 'MUSIC_PLAYLIST_SAFE'].includes(error?.code) ? error.message : 'Le lecteur n’a pas pu effectuer cette action. Vérifiez la bibliothèque et les réglages.' };
      if (command === 'panels.appearance') return { ok: false, ...(error?.code === 'STALE_FLOATING_PANELS' ? { code: error.code } : {}), error: ['FLOATING_PANELS_SAFE', 'STALE_FLOATING_PANELS'].includes(error?.code) ? error.message : 'Les réglages des panneaux n’ont pas pu être enregistrés.' };
      if (error?.code === 'CATALOGUE_WIDGET_SAFE' || command === 'catalogue.widget') return { ok: false, error: 'Le mini Catalogue nécessite une connexion ChartsHub active.' };
      if (command === 'library.cleanupHistory') return { ok: false, error: 'L’historique des nettoyages est indisponible. Les résultats du nettoyage restent inchangés.' };
      if (['library.chooseBadSongs', 'library.recycleBadSongs', 'library.prepareCleanup', 'library.recycleDuplicates', 'library.forceRecycleDuplicate', 'library.verifyAllDuplicates', 'library.prepareBulkCleanup', 'library.recycleBulkDifferences', 'library.cancelBulkCleanup'].includes(command) || error?.code === 'LIBRARY_CLEANUP_SAFE') {
        return { ok: false, error: ['LIBRARY_CLEANUP_SAFE', 'LIBRARY_COMPARISON_SAFE'].includes(error?.code) ? error.message : 'Le nettoyage n’a pas pu être terminé. Vérifiez les copies puis relancez la vérification.' };
      }
      if (command === 'library.compareDuplicates' || command === 'library.chooseDuplicate' || command === 'library.keepDuplicateVersions') {
        return { ok: false, error: error?.code === 'LIBRARY_COMPARISON_SAFE' ? error.message : 'La comparaison n’a pas pu être terminée. Vérifiez les fichiers puis recomparez les versions.' };
      }
      if (command.startsWith('telemetry.')) return { ok: false, error: 'Vérifiez la connexion aux mesures, le réglage testé et les 30 jugements continus avant de terminer un essai.' };
      if (command.startsWith('profile.')) {
        publish();
        return { ok: false, ...(error?.code === 'STALE_PROFILES' ? { code: error.code } : {}), error: ['PROFILE_SAFE', 'STALE_PROFILES'].includes(error?.code) ? error.message : 'Le profil n’a pas pu être enregistré ou chargé. Réessayez.' };
      }
      return { ok: false, error: command.startsWith('reshade.setup') ? error?.code === 'RESHADE_SETUP_SAFE' ? error.message : reshadeSetup.status().error || 'La préparation ou l’installation ReShade n’a pas pu être terminée.' : command.startsWith('reshade.') ? error?.code === 'RESHADE_SAFE' ? error.message : reshade.status().error || 'La connexion ReShade n’a pas pu effectuer cette action.' : command.startsWith('filters.') ? error?.code === 'FILTERS_SAFE' ? error.message : filters.status().error || 'Les filtres n’ont pas pu effectuer cette action. Vérifiez le dossier et l’état du module.' : command.startsWith('clonehero.') ? error?.code === 'CLONEHERO_SAFE' ? error.message : 'La connexion à Clone Hero n’a pas pu être configurée. Vérifie le fichier choisi.' : command.startsWith('downloads.') ? error?.code === 'DOWNLOAD_SAFE' ? error.message : downloads.status().error || 'Le téléchargement n’a pas pu effectuer cette action. Vérifiez le dossier et rechargez le catalogue.' : command.startsWith('catalogue.') ? catalogue.status().error || 'Cette action ChartsHub n’est plus disponible. Rechargez les résultats ou les correspondances.' : command.startsWith('library.') ? library.status().error || 'La bibliothèque n’a pas pu effectuer cette action. Vérifiez que le dossier est accessible.' : 'L’action n’a pas pu être terminée. Réessaie.' }; }
  });
  function stop() {
    if (stopTask) return stopTask;
    lifecycleRevision++;
    telemetry.stop();
    songVisuals?.stop();
    libraryDownloadRefresh?.stop();
    const songRequestSharingStop = songRequestShareSync?.pause();
    const songRequestPublicStop = songRequestShareBroker?.stop();
    songRequestShareManualBusy = null;
    songRequestShareRevision++;
    songRequestShareController?.abort(); songRequestShareController = null;
    songRequestShare.busy = false; songRequestShare.progress = null;
    songRequests.configure({ enabled: false });
    const songRequestStop = songRequestServer?.stop();
    const songRequestConnectionsStop = songRequestConnections?.stop();
    hostActive = false; catalogueWidgetTicket++; catalogueWidgetEnabled = false;
    gameCapture?.stop();
    musicPlayer?.stop();
    if (playerWindow && !playerWindow.isDestroyed()) playerWindow.destroy();
    playerWindowLoad = null;
    unregisterCatalogueShortcut();
    if (catalogueWidget && !catalogueWidget.isDestroyed()) catalogueWidget.destroy();
    catalogueWidgetLoad = null;
    clearInterval(filtersTimer); filtersTimer = null;
    filtersWidgetEnabled = false;
    if (filtersWidget && !filtersWidget.isDestroyed()) filtersWidget.destroy();
    filtersWidgetLoad = null;
    overlayEnabled = false;
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    overlayLoad = null;
    const serviceStop = services.stop();
    const streamStop = setStream(false);
    const libraryStop = library.stop();
    const catalogueStop = catalogue.stop();
    const downloadsStop = downloads.stop();
    const setupState = reshadeSetup.status().state;
    const setupStop = ['preparing', 'ready'].includes(setupState)
      ? Promise.resolve().then(() => reshadeSetup.cancel()).catch(() => { logger.warn('ReShade preparation could not be cancelled'); })
      : setupState === 'installing' && typeof reshadeSetup.whenIdle === 'function'
        ? Promise.resolve().then(() => reshadeSetup.whenIdle()).catch(() => { logger.warn('ReShade installation ended with an error'); })
      : Promise.resolve();
    if (saveTimer) void saveSettings();
    const task = (async () => { await songRequestPublicStop; await songRequestSharingStop; await songRequestStop; await songRequestConnectionsStop; await songRequestPreferences.flush(); await playerPreferencesTask; await playerPreferences.flush(); await pendingSave; await floatingPanels.flush(); await Promise.allSettled([...profileWrites, ...(cleanupTask ? [cleanupTask] : [])]); await serviceStop; await streamStop; await libraryStop; await catalogueStop; await downloadsStop; await setupStop; await filtersRefresh; await reshadeRefresh; await logTail; })();
    const done = task.finally(() => { if (stopTask === done) stopTask = null; });
    stopTask = done;
    return done;
  }
  function open() {
    if (openTask) return openTask;
    const task = (async () => {
      if (stopTask) await stopTask;
      if (disposing || embedded?.ownerWindow.isDestroyed()) return null;
      const openingRevision = lifecycleRevision;
      await services.start();
      telemetry.start();
      if (disposing || openingRevision !== lifecycleRevision || embedded?.ownerWindow.isDestroyed()) return null;
      hostActive = true;
      void refreshSongRequestShare();
      if (panelAlive()) {
        if (embedded) await embedded.activate();
        else { if (panel.isMinimized()) panel.restore(); panel.focus(); }
        if (!panelAlive() || disposing || openingRevision !== lifecycleRevision) return null;
        startFiltersPolling();
        registerCatalogueShortcut(); publishPanel();
        return panel;
      }
      await library.start();
      if (disposing || openingRevision !== lifecycleRevision || embedded?.ownerWindow.isDestroyed()) return null;
      await catalogue.start();
      if (disposing || openingRevision !== lifecycleRevision || embedded?.ownerWindow.isDestroyed()) return null;
      await downloads.start();
      if (disposing || openingRevision !== lifecycleRevision || embedded?.ownerWindow.isDestroyed()) return null;
      const panelPreferences = { ...preferences, additionalArguments: [`--chartshub-companion-language=${language}`] };
      const window = embedded?.ownerWindow ?? new BrowserWindow({ width: 1250, height: 850, minWidth: 900, minHeight: 660, show: false, title: 'ChartsHub — Clone Hero Companion', backgroundColor: '#10121a', icon: path.join(__dirname, '..', 'icon.ico'), webPreferences: panelPreferences });
      const view = embedded ? new WebContentsView({ webPreferences: panelPreferences }) : null;
      const contents = view?.webContents ?? window.webContents;
      panel = window;
      panelContents = contents;
      panelView = view;
      const closed = () => {
        if (panelContents !== contents) return;
        panel = null; panelContents = null; panelView = null;
        if (!disposing) void stop();
      };
      if (embedded) { hardenContents(contents, 'index.html', embedded.ownerWindow); contents.once('destroyed', closed); }
      else { harden(window, 'index.html'); window.on('closed', closed); }
      try {
        if (embedded) { embedded.attachView(view); await contents.loadURL(`${SCHEME}://app/ui/index.html`); }
        else await window.loadURL(`${SCHEME}://app/ui/index.html`);
      } catch (error) {
        if (panelAlive() && !disposing) {
          if (embedded) contents.close();
          throw error;
        }
      }
      if (!panelAlive() || disposing || openingRevision !== lifecycleRevision) return null;
      if (embedded) await embedded.activate(); else window.show();
      if (!panelAlive() || disposing || openingRevision !== lifecycleRevision) return null;
      startFiltersPolling();
      registerCatalogueShortcut(); publishPanel();
      return window;
    })();
    const done = task.finally(() => { if (openTask === done) openTask = null; });
    openTask = done;
    return done;
  }
  const beforeQuit = event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    void stop().finally(() => app.quit());
  };
  const ownerClosed = () => {
    if (panelContents && !panelContents.isDestroyed()) panelContents.close();
    if (!disposing) void stop();
  };
  if (embedded) embedded.ownerWindow.once('closed', ownerClosed);
  else app.on('before-quit', beforeQuit);
  function dispose() {
    if (disposeTask) return disposeTask;
    disposing = true;
    if (embedded) embedded.ownerWindow.removeListener('closed', ownerClosed);
    else app.removeListener('before-quit', beforeQuit);
    unsubscribe(); ipcMain.removeHandler('companion:snapshot'); ipcMain.removeHandler('companion:command');
    disposeTask = (async () => {
      await stop(); if (gameCaptureTask) await gameCaptureTask; await gameCapture?.dispose(); await telemetry.dispose(); await reshadeSetup.dispose(); await reshade.dispose(); await filters.dispose();
      if (embedded && panelContents && !panelContents.isDestroyed()) {
        const contents = panelContents;
        await new Promise(resolve => { contents.once('destroyed', resolve); contents.close(); });
      }
      if (openTask) await openTask;
      if (!embedded && panel && !panel.isDestroyed()) panel.destroy();
      await ses.protocol.unhandle(SCHEME);
    })();
    return disposeTask;
  }
  function maintenanceStatus() {
    const reasons = [], state = library?.status(), player = musicPlayer?.snapshot();
    if (disposing || stopTask || openTask) reasons.push('companion_busy');
    if (state?.status === 'scanning') reasons.push('library_scanning');
    if (cleanupTask || cleanupDialogOpen || state?.duplicateVerification?.running || state?.bulkCleanup || state?.badSongsBusy) reasons.push('library_cleanup');
    if (downloads?.status()?.items?.some(item => ['Queued','Downloading'].includes(item.state))) reasons.push('chart_downloads');
    if (filters?.status()?.busy || reshade?.status()?.busy || ['preparing','installing'].includes(reshadeSetup?.status()?.state)) reasons.push('game_setup');
    if (player?.playing || player?.loading) reasons.push('player_active');
    if (streamStatus().enabled || gameCaptureStatus().phase !== 'stopped') reasons.push('stream_active');
    if (songRequests?.snapshot().enabled || songRequestBusy) reasons.push('requests_active');
    if (songRequestShare.busy) reasons.push('sharing_active');
    if (rootPickerOpen || downloadPickerOpen || cloneHeroPickerOpen || filtersPickerOpen || filtersConfirmationOpen || reshadePickerOpen || reshadeConfirmationOpen) reasons.push('dialog_active');
    return { busyReasons: reasons };
  }
  async function flushPortableConfiguration() {
    await saveSettings();await Promise.all([...profileWrites]);await floatingPanels.flush();await songRequestPreferences.flush();
    if(persistenceError||profiles.status().error||floatingPanels.status().error||songRequestPreferences.status().error)throw Object.assign(Error('Visual settings could not be saved'),{code:'BACKUP_WRITE_FAILED'});
  }
  return { open, stop, snapshot, services, integration, registry, setLanguage, setButtonMotion, setOverlay, setStream, setFiltersWidget, setCatalogueWidget, setCatalogueAvailable, saveSettings, library, catalogue, downloads, filters, reshade, reshadeSetup,
    maintenanceStatus, flushPortableConfiguration, setMaintenanceLocked: value => { maintenanceLocked = value === true; },
    getPanel: () => panel, getPanelContents: () => panelContents, getPanelView: () => panelView, getOverlay: () => overlay, getFiltersWidget: () => filtersWidget, getCatalogueWidget: () => catalogueWidget, getPlayerWidget: () => playerWindow, dispose
  };
}
module.exports = { registerCompanionScheme, createCompanionHost };
