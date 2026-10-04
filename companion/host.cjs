'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, protocol, session, net, screen, clipboard, dialog, shell } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { assetPath, trustedSender, trustedContentsSender, trustedFiltersWidgetCommand, validCommand } = require('./security.cjs');
const { createFiltersService } = require('./filters-service.cjs');
const { createReShadeService } = require('./reshade-service.cjs');
const { createReShadeSetupService } = require('./reshade-setup.cjs');
const { createLocalOverlayServer } = require('./stream-server.cjs');
const { createBackgroundLibraryService } = require('./library-background.cjs');
const { createChartsHubClient } = require('./catalogue-client.cjs');
const { createCatalogueService } = require('./catalogue-service.cjs');
const { createDownloadService } = require('./download-service.cjs');
const { createDownloadWorker } = require('./download-worker.cjs');
const { createCloneHeroSource } = require('./clonehero-source.cjs');
const { createCharterColorResolver } = require('./charter-color-resolver.cjs');
const { createCloneHeroProcessProbe } = require('./clonehero-process.cjs');
const { createOverlayProfiles } = require('./overlay-profiles.cjs');
const SCHEME = 'chartshub-companion';
function registerCompanionScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
}
async function createCompanionHost({ dataDirectory = path.join(app.getPath('userData'), 'companion'), catalogueClient, downloadWorker, cloneHeroCandidates, cloneHeroProcessProbe, filtersService, reshadeService, reshadeSetupService, embedded } = {}) {
  if (embedded && (!embedded.ownerWindow || typeof embedded.ownerWindow.isDestroyed !== 'function' || typeof embedded.attachView !== 'function' || typeof embedded.activate !== 'function')) throw Error('Invalid embedded Companion host');
  const [{ ServiceContainer }, { MockCloneHeroIntegration }, { createDefaultRegistry, createDefaultWidgets }, { WidgetRenderer }, { SettingsRepository, validateSettings }, { SnapshotHistory }, { ThemeService, createDefaultTheme }, { validateWidgetStyle }, { createDefaultStream, validateStream }] = await Promise.all([
    import('./dist/core/services/ServiceContainer.js'), import('./dist/integrations/clonehero/MockCloneHeroIntegration.js'),
    import('./dist/widgets/core/index.js'), import('./dist/widgets/engine/WidgetRenderer.js'), import('./dist/storage/SettingsRepository.js'), import('./dist/layout/WidgetHistory.js'),
    import('./dist/themes/ThemeService.js'), import('./dist/themes/ThemeResolver.js'), import('./dist/overlay/stream/StreamConfig.js')
  ]);
  const logs = [];
  // The dialog owner and the trusted renderer are different objects in a tab.
  let panel = null, panelContents = null, panelView = null, overlay = null, overlayEnabled = false, persistenceError = '', saveTimer = null, quitting = false;
  let openTask = null, stopTask = null, disposeTask = null, overlayLoad = null, disposing = false;
  let logTail = Promise.resolve(), pendingSave = Promise.resolve();
  let streamServer = null, streamInit = null, streamTask = Promise.resolve(), streamDesired = false, streamError = null;
  let library = null, rootPickerOpen = false;
  let cleanupDialogOpen = false, cleanupTask = null, cleanupApproval = null;
  let catalogue = null, libraryIndexRevision = -1;
  let downloads = null, downloadPickerOpen = false;
  let cloneHeroPickerOpen = false;
  let filters = null, filtersWidget = null, filtersWidgetLoad = null, filtersWidgetEnabled = false;
  let filtersPickerOpen = false, filtersConfirmationOpen = false, filtersTimer = null, filtersRefresh = null, filtersFocusRevision = 0;
  let reshade = null, reshadeRefresh = null, reshadePickerOpen = false, reshadeConfirmationOpen = false;
  let reshadeSetup = null, reshadeSetupStarting = false;
  let lifecycleRevision = 0;
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
  await profiles.load();
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
  const history = new SnapshotHistory({ widgets, theme, stream });
  const themeService = new ThemeService();
  let editorRevision = 0;
  const registry = createDefaultRegistry();
  const renderer = new WidgetRenderer(registry, () => logger.warn('Widget unavailable'));
  const ses = session.fromPartition('companion-local');
  ses.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', event => event.preventDefault());
  await ses.protocol.handle(SCHEME, async request => {
    // Artwork is fetched by ID from the known public catalogue. The renderer
    // cannot turn this local route into a proxy for arbitrary URLs.
    let requested;
    try { requested = new URL(request.url); } catch { return new Response('Not found', { status: 404 }); }
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
  function hardenContents(contents, page) {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => { if (url !== `${SCHEME}://app/ui/${page}`) event.preventDefault(); });
    contents.on('will-redirect', event => event.preventDefault());
    contents.on('will-attach-webview', event => event.preventDefault());
  }
  function harden(window, page) { window.setMenuBarVisibility(false); hardenContents(window.webContents, page); }
  const streamStatus = () => streamServer?.status() ?? { enabled: false, url: null, clients: 0, error: streamError };
  const snapshot = () => ({ state: services.store.getState(), profiles: profiles.status({ version: 3, ...editorDocument() }, preferredProfileId), cloneHero: integration.status(), overlayEnabled, stream: streamStatus(), library: library?.status(), catalogue: catalogue?.status(), downloads: downloads?.status(), filters: filters?.status(), reshade: reshade?.status(), reshadeSetup: reshadeSetup?.status(), filtersWidgetEnabled, filtersFocusRevision, editor: { revision: editorRevision, canUndo: history.canUndo, canRedo: history.canRedo }, logs: [...logs], ...(persistenceError ? { persistenceError } : {}) });
  // The interactive filter widget receives no song library, paths, logs or stream access URL.
  const filtersWidgetSnapshot = () => {
    const status = filters?.status();
    const source = reshade?.status();
    const reshadeStatus = source ? { supported: source.supported, installed: source.installed, running: source.running, connected: source.connected, busy: source.busy, state: source.state, catalog: source.catalog ? { ...source.catalog, preset: source.catalog.preset ? path.basename(source.catalog.preset) : '' } : null } : null;
    if (!status) return { filters: null, reshade: reshadeStatus };
    const { settings, supported, installed, state, running, busy, native } = status;
    return { filters: { settings, supported, installed, state, running, busy, native }, reshade: reshadeStatus, filtersWidgetEnabled };
  };
  function syncOverlay() {
    if (!overlay || overlay.isDestroyed()) return;
    const visible = overlayEnabled && renderer.renderWidgetModels(services.store.getState(), 'game').length > 0;
    if (visible && !overlay.webContents.isLoading()) overlay.showInactive(); else overlay.hide();
  }
  function publish() {
    const value = snapshot();
    publishPanel(value);
    if (overlay && !overlay.isDestroyed() && !overlay.webContents.isLoading()) overlay.webContents.send('companion:changed', value);
    if (filtersWidget && !filtersWidget.isDestroyed() && !filtersWidget.webContents.isLoading()) filtersWidget.webContents.send('companion:changed', filtersWidgetSnapshot());
    syncOverlay();
    streamServer?.publish(value.state);
  }
  function panelAlive() { return !!panel && !panel.isDestroyed() && !!panelContents && !panelContents.isDestroyed?.(); }
  function publishPanel(value) { if (panelAlive() && !panelContents.isLoading()) panelContents.send('companion:changed', value ?? snapshot()); }
  const unsubscribe = services.store.subscribe(publish);
  // The index and expensive work stay in a worker. Progress only updates the panel,
  // without waking either overlay or exposing library paths to the OBS server.
  library = createBackgroundLibraryService({ dataDirectory, recycle: async target => {
    const approval = cleanupApproval;
    if (!approval || disposing || stopTask || approval.lifecycle !== lifecycleRevision || approval.owner !== panel || panel.isDestroyed()
      || library.status().settings.rootPath !== approval.root || !approval.targets.has(target)) throw Error('Nettoyage non autorisé.');
    const relative = path.relative(approval.root, target);
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw Error('Copie invalide.');
    // Check the native target again after the worker's content/identity verification.
    let cursor = approval.root;
    for (const part of ['', ...relative.split(path.sep)]) {
      if (part) cursor = path.join(cursor, part);
      if ((await fs.lstat(cursor)).isSymbolicLink() || path.relative(cursor, await fs.realpath(cursor)) !== '') throw Error('Copie modifiée.');
    }
    if (disposing || stopTask || approval !== cleanupApproval || approval.lifecycle !== lifecycleRevision || approval.owner !== panel || panel.isDestroyed()) throw Error('Nettoyage arrêté.');
    approval.targets.delete(target);
    await shell.trashItem(target);
  }, onChange: () => {

    const revision = library?.status().revision ?? -1;
    if (revision !== libraryIndexRevision) { libraryIndexRevision = revision; catalogue?.libraryChanged(); }
    if (!disposing) publishPanel();
  } });
  await library.load();
  catalogue = createCatalogueService({ dataDirectory, client: catalogueClient ?? createChartsHubClient({ fetcher: (url, options) => net.fetch(url, options) }), getLibrary: () => library.matchingSnapshot(), onChange: () => {
    if (!disposing) publishPanel();
  } });
  await catalogue.load();
  downloads = createDownloadService({ dataDirectory, worker: downloadWorker ?? createDownloadWorker({ fetcher: (url, options) => net.fetch(url, options) }), onChange: () => {
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
      const choice = await dialog.showOpenDialog(owner, { title: 'Choisir Clone Hero avec ReShade', properties: ['openDirectory'], ...(reshade.status().rootPath ? { defaultPath: reshade.status().rootPath } : {}) });
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
      const choice = await dialog.showMessageBox(owner, { type: 'question', title: 'Connecter les effets ReShade', message: 'Installer l’intégration ReShade dans ce dossier ?', detail: `${status.rootPath}\n\nChartsHubReShade.addon64 sera installé dans ce dossier. Si le moteur ChartsHub classique remplace votre ancien ReShade, sa sauvegarde sera restaurée. Vos effets ne seront pas tous activés : vous les choisirez dans le panneau. Relancez Clone Hero pour établir la connexion.`, buttons: ['Annuler', 'Installer'], defaultId: 0, cancelId: 0, noLink: true });
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
      const choice = await dialog.showOpenDialog(owner, { title: 'Choisir le dossier contenant Clone Hero.exe', properties: ['openDirectory'], ...(filters.status().rootPath ? { defaultPath: filters.status().rootPath } : {}) });
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
      const choice = await dialog.showMessageBox(owner, { type: 'question', title: install ? 'Installer les filtres ChartsHub' : 'Restaurer le module précédent', message: install ? 'Installer le module ChartsHub dans ce dossier ?' : 'Retirer le module ChartsHub et restaurer la sauvegarde ?', detail: `${status.rootPath}\n\n${install ? 'Le fichier dxgi.dll sera installé dans ce dossier. Le module précédent sera sauvegardé avant remplacement. Les filtres prendront effet au prochain lancement de Clone Hero.' : 'Le fichier dxgi.dll de ChartsHub sera retiré. La sauvegarde du module précédent, si elle existe, sera remise à sa place.'}`, buttons: ['Annuler', install ? 'Installer' : 'Restaurer'], defaultId: 0, cancelId: 0, noLink: true });
      if (disposing || stopTask || revision !== lifecycleRevision || owner !== panel || owner.isDestroyed() || status.rootPath !== filters.status().rootPath) return { ok: false, error: 'Le panneau ou le dossier a changé.' };
      if (choice.response !== 1) return { ok: true, cancelled: true };
      await filters[action]();
      return { ok: true };
    } finally { filtersConfirmationOpen = false; }
  }
  async function chooseDownloadRoot() {
    if (downloadPickerOpen) throw Object.assign(Error('Le choix du dossier de téléchargement est déjà ouvert.'), { code: 'DOWNLOAD_SAFE' });
    const owner = panel, revision = lifecycleRevision;
    downloadPickerOpen = true;
    try {
      const choice = await dialog.showOpenDialog(owner, { title: 'Choisir le dossier de téléchargements ChartsHub', properties: ['openDirectory', 'createDirectory'], ...(downloads.status().rootPath ? { defaultPath: downloads.status().rootPath } : {}) });
      if (disposing || stopTask || revision !== lifecycleRevision || owner !== panel || owner.isDestroyed()) throw Object.assign(Error('Le panneau a été fermé.'), { code: 'DOWNLOAD_SAFE' });
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
      streamServer = createLocalOverlayServer({ root: __dirname, token, onStatus: publish });
      return streamServer;
    })().finally(() => { streamInit = null; });
    return streamInit;
  }
  function setStream(enabled) {
    streamDesired = enabled;
    streamTask = streamTask.catch(() => {}).then(async () => {
      if (!streamDesired || disposing || stopTask) {
        await streamServer?.stop();
        publish();
        return;
      }
      try {
        const server = await ensureStreamServer();
        if (!streamDesired || disposing || stopTask) { await server.stop(); return; }
        server.publish(services.store.getState());
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
  async function setFiltersWidget(enabled) {
    if (disposing || stopTask) return;
    filtersWidgetEnabled = enabled;
    if (!enabled) { if (filtersWidget && !filtersWidget.isDestroyed()) filtersWidget.hide(); publish(); return; }
    if (!filtersWidget || filtersWidget.isDestroyed()) {
      const window = new BrowserWindow({ width: 410, height: 610, minWidth: 360, minHeight: 360, show: false, frame: true, alwaysOnTop: true, skipTaskbar: true, resizable: true, title: 'ChartsHub — Filtres du jeu', backgroundColor: '#151719', webPreferences: preferences });
      filtersWidget = window;
      harden(window, 'filters-widget.html');
      window.on('closed', () => { if (filtersWidget === window) { filtersWidget = null; filtersWidgetEnabled = false; publish(); } });
      filtersWidgetLoad = window.loadURL(`${SCHEME}://app/ui/filters-widget.html`).catch(error => { if (!window.isDestroyed() && filtersWidgetEnabled) throw error; });
    }
    if (filtersWidgetLoad) await filtersWidgetLoad;
    if (disposing || stopTask || !filtersWidgetEnabled || !filtersWidget || filtersWidget.isDestroyed()) return;
    filtersWidget.showInactive();
    publish();
  }
  function trustedPanel(event) { return panelAlive() && trustedContentsSender(event, panelContents, 'index.html'); }
  function canRead(event) { return trustedPanel(event) || trustedSender(event, overlay, 'overlay.html'); }
  ipcMain.handle('companion:snapshot', event => canRead(event) ? snapshot() : trustedSender(event, filtersWidget, 'filters-widget.html') ? filtersWidgetSnapshot() : null);
  ipcMain.handle('companion:command', async (event, command, payload) => {
    if (disposing || stopTask || !(trustedPanel(event) || trustedFiltersWidgetCommand(event, filtersWidget, command)) || !validCommand(command, payload, services.store.getState().widgets.instances.map(w => w.id))) return { ok: false, error: 'Commande non autorisée.' };
    if (['widget.layout', 'widget.visibility', 'widget.appearance', 'widget.fontSize', 'widget.locked', 'theme.preset', 'theme.color', 'theme.effects', 'stream.settings', 'profile.save', 'profile.apply'].includes(command) && payload.revision !== editorRevision) return { ok: false, code: 'STALE_REVISION', error: 'Les réglages ont changé. Réessaie avec leur version actuelle.' };
    try {
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
      else if (command === 'clonehero.detect') await integration.detect();
      else if (command === 'clonehero.chooseFile') {
        if (cloneHeroPickerOpen) return { ok: false, error: 'Le choix du fichier est déjà ouvert.' };
        cloneHeroPickerOpen = true;
        const owner = panel, revision = lifecycleRevision;
        try {
          const choice = await dialog.showOpenDialog(owner, { title: 'Choisir currentsong.txt de Clone Hero', properties: ['openFile'], filters: [{ name: 'Export Clone Hero', extensions: ['txt'] }], ...(integration.status().filePath ? { defaultPath: integration.status().filePath } : {}) });
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
      } else if (command === 'stream.copyUrl') {
        const status = streamStatus();
        if (!status.enabled || !status.url) return { ok: false, error: 'Activez le serveur OBS avant de copier son adresse.' };
        clipboard.writeText(status.url);
      } else if (command.startsWith('library.') && command !== 'library.query' && command !== 'library.openFolder' && (cleanupDialogOpen || cleanupTask)) {
        return { ok: false, error: 'Terminez ou annulez le nettoyage des copies avant cette action.' };
      } else if (command === 'library.query') {
        return { ok: true, result: await library.query(payload) };
      } else if (command === 'library.compareDuplicates' || command === 'library.chooseDuplicate' || command === 'library.prepareCleanup') {
        return { ok: true, result: await library[command.slice('library.'.length)](payload) };
      } else if (command === 'library.recycleDuplicates') {
        const owner = panel, lifecycle = lifecycleRevision;
        const request = { planId: payload.planId, revision: payload.revision, ids: [...payload.ids] };
        cleanupDialogOpen = true;
        try {
          const review = await library.cleanupReview(request);
          const root = library.status().settings.rootPath;
          if (disposing || stopTask || lifecycle !== lifecycleRevision || owner !== panel || owner.isDestroyed()) return { ok: true, cancelled: true };
          const choice = await dialog.showMessageBox(owner, { type: 'warning', title: 'Envoyer les copies à la Corbeille Windows',
            message: `Envoyer ${review.candidates.length} copie(s) sélectionnée(s) à la Corbeille ?`,
            detail: `Version conservée : ${review.keep.targetRelativePath}\n\nCopies sélectionnées :\n${review.candidates.map(item => `${item.kind === 'folder' ? 'Dossier entier' : 'Fichier SNG'} : ${item.targetRelativePath}`).join('\n')}\n\nLes dossiers sont déplacés avec tous leurs fichiers. Aucune suppression définitive ne sera utilisée si la Corbeille est indisponible.`,
            buttons: ['Annuler', 'Envoyer à la Corbeille'], defaultId: 0, cancelId: 0, noLink: true });
          if (choice.response !== 1 || disposing || stopTask || lifecycle !== lifecycleRevision || owner !== panel || owner.isDestroyed()) return { ok: true, cancelled: true };
          cleanupApproval = { owner, lifecycle, root, targets: new Set(review.candidates.map(item => path.resolve(root, item.targetRelativePath))) };
          cleanupTask = library.recycleDuplicates(request);
          return { ok: true, result: await cleanupTask };
        } finally { cleanupApproval = null; cleanupTask = null; cleanupDialogOpen = false; }
      } else if (command === 'library.chooseRoot') {
        if (rootPickerOpen) return { ok: false, error: 'Le choix du dossier est déjà ouvert.' };
        const owner = panel, revision = lifecycleRevision;
        rootPickerOpen = true;
        try {
          const choice = await dialog.showOpenDialog(owner, { title: 'Choisir le dossier de chansons Clone Hero', properties: ['openDirectory'], ...(library.status().settings.rootPath ? { defaultPath: library.status().settings.rootPath } : {}) });
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
        return { ok: true, result: await catalogue.search(payload) };
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
        if (!await chooseDownloadRoot()) return { ok: true, cancelled: true };
      } else if (command === 'downloads.enqueue') {
        // Validate catalogue membership before any dialog, and again after its await.
        catalogue.downloadDescriptor(payload.chartId);
        if (!downloads.status().rootPath && !await chooseDownloadRoot()) return { ok: true, cancelled: true };
        return { ok: true, result: await downloads.enqueue(catalogue.downloadDescriptor(payload.chartId)) };
      } else if (command === 'downloads.openFolder') {
        const owner = panel, revision = lifecycleRevision;
        const folder = await downloads.resolveFolder(payload.id);
        if (disposing || revision !== lifecycleRevision || owner !== panel || owner.isDestroyed() || !folder || await shell.openPath(folder)) return { ok: false, error: 'Le dossier de ce téléchargement n’est plus accessible.' };
      } else if (['downloads.pause', 'downloads.resume', 'downloads.cancel', 'downloads.retry', 'downloads.remove'].includes(command)) {
        await downloads[command.slice('downloads.'.length)](payload.id);
      } else if (command === 'overlay.enabled') await setOverlay(payload.enabled);
      publish();
      return { ok: true, revision: editorRevision };
    } catch (error) {
      logger.error('Companion command failed');
      if (['library.prepareCleanup', 'library.recycleDuplicates'].includes(command) || error?.code === 'LIBRARY_CLEANUP_SAFE') {
        return { ok: false, error: ['LIBRARY_CLEANUP_SAFE', 'LIBRARY_COMPARISON_SAFE'].includes(error?.code) ? error.message : 'Le nettoyage n’a pas pu être terminé. Vérifiez les copies puis relancez la vérification.' };
      }
      if (command === 'library.compareDuplicates' || command === 'library.chooseDuplicate') {
        return { ok: false, error: error?.code === 'LIBRARY_COMPARISON_SAFE' ? error.message : 'La comparaison n’a pas pu être terminée. Vérifiez les fichiers puis recomparez les versions.' };
      }
      if (command.startsWith('profile.')) {
        publish();
        return { ok: false, ...(error?.code === 'STALE_PROFILES' ? { code: error.code } : {}), error: ['PROFILE_SAFE', 'STALE_PROFILES'].includes(error?.code) ? error.message : 'Le profil n’a pas pu être enregistré ou chargé. Réessayez.' };
      }
      return { ok: false, error: command.startsWith('reshade.setup') ? error?.code === 'RESHADE_SETUP_SAFE' ? error.message : reshadeSetup.status().error || 'La préparation ou l’installation ReShade n’a pas pu être terminée.' : command.startsWith('reshade.') ? error?.code === 'RESHADE_SAFE' ? error.message : reshade.status().error || 'La connexion ReShade n’a pas pu effectuer cette action.' : command.startsWith('filters.') ? error?.code === 'FILTERS_SAFE' ? error.message : filters.status().error || 'Les filtres n’ont pas pu effectuer cette action. Vérifiez le dossier et l’état du module.' : command.startsWith('clonehero.') ? error?.code === 'CLONEHERO_SAFE' ? error.message : 'La connexion à Clone Hero n’a pas pu être configurée. Vérifie le fichier choisi.' : command.startsWith('downloads.') ? error?.code === 'DOWNLOAD_SAFE' ? error.message : downloads.status().error || 'Le téléchargement n’a pas pu effectuer cette action. Vérifiez le dossier et rechargez le catalogue.' : command.startsWith('catalogue.') ? catalogue.status().error || 'Cette action ChartsHub n’est plus disponible. Rechargez les résultats ou les correspondances.' : command.startsWith('library.') ? library.status().error || 'La bibliothèque n’a pas pu effectuer cette action. Vérifiez que le dossier est accessible.' : 'L’action n’a pas pu être terminée. Réessaie.' }; }
  });
  function stop() {
    if (stopTask) return stopTask;
    lifecycleRevision++;
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
    const task = (async () => { await pendingSave; await Promise.allSettled([...profileWrites, ...(cleanupTask ? [cleanupTask] : [])]); await serviceStop; await streamStop; await libraryStop; await catalogueStop; await downloadsStop; await setupStop; await filtersRefresh; await reshadeRefresh; await logTail; })();
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
      if (disposing || openingRevision !== lifecycleRevision || embedded?.ownerWindow.isDestroyed()) return null;
      if (panelAlive()) {
        if (embedded) await embedded.activate();
        else { if (panel.isMinimized()) panel.restore(); panel.focus(); }
        if (!panelAlive() || disposing || openingRevision !== lifecycleRevision) return null;
        startFiltersPolling();
        return panel;
      }
      await library.start();
      if (disposing || openingRevision !== lifecycleRevision || embedded?.ownerWindow.isDestroyed()) return null;
      await catalogue.start();
      if (disposing || openingRevision !== lifecycleRevision || embedded?.ownerWindow.isDestroyed()) return null;
      await downloads.start();
      if (disposing || openingRevision !== lifecycleRevision || embedded?.ownerWindow.isDestroyed()) return null;
      const window = embedded?.ownerWindow ?? new BrowserWindow({ width: 1250, height: 850, minWidth: 900, minHeight: 660, show: false, title: 'ChartsHub — Clone Hero Companion', backgroundColor: '#10121a', icon: path.join(__dirname, '..', 'icon.ico'), webPreferences: preferences });
      const view = embedded ? new WebContentsView({ webPreferences: preferences }) : null;
      const contents = view?.webContents ?? window.webContents;
      panel = window;
      panelContents = contents;
      panelView = view;
      const closed = () => {
        if (panelContents !== contents) return;
        panel = null; panelContents = null; panelView = null;
        if (!disposing) void stop();
      };
      if (embedded) { hardenContents(contents, 'index.html'); contents.once('destroyed', closed); }
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
      await stop(); await reshadeSetup.dispose(); await reshade.dispose(); await filters.dispose();
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
  return { open, stop, snapshot, services, integration, registry, setOverlay, setStream, setFiltersWidget, saveSettings, library, catalogue, downloads, filters, reshade, reshadeSetup,
    getPanel: () => panel, getPanelContents: () => panelContents, getPanelView: () => panelView, getOverlay: () => overlay, getFiltersWidget: () => filtersWidget, dispose
  };
}
module.exports = { registerCompanionScheme, createCompanionHost };
