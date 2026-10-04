'use strict';
const fs = require('node:fs/promises');
const { watch, constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { scanLibrary } = require('./library-scanner.cjs');
const { createLibraryQuery } = require('./library-query.cjs');
const { createLibraryDuplicates } = require('./library-duplicates.cjs');
const { createLibraryCleanup } = require('./library-cleanup.cjs');

const VERSION = 1;
const TEXT_FIELDS = ['title', 'artist', 'charter', 'album', 'year'];
const PUBLIC_FIELDS = ['id', 'relativePath', ...TEXT_FIELDS, 'format', 'audio'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const samePath = (a, b) => path.relative(a, b) === '';
const within = (root, filename) => { const rel = path.relative(root, filename); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); };
const count = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => createHash('sha256').update(value).digest('hex');
const safeError = message => new Error(message);
function relative(value, empty = false) {
  return typeof value === 'string' && value.length <= 32768 && ((empty && value === '') || (value.length > 0 && !/[\\:\u0000-\u001f\u007f]/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..')));
}
function settings(value) {
  if (!object(value) || Object.keys(value).some(key => !['rootPath', 'watch', 'refreshOnStart'].includes(key)) || !(value.rootPath === null || (typeof value.rootPath === 'string' && value.rootPath.length <= 32768 && !value.rootPath.includes('\0') && path.isAbsolute(value.rootPath))) || typeof value.watch !== 'boolean' || typeof value.refreshOnStart !== 'boolean') throw Error('Invalid library settings');
  return { rootPath: value.rootPath, watch: value.watch, refreshOnStart: value.refreshOnStart };
}
function validateItem(value) {
  if (!object(value) || !relative(value.relativePath) || value.id !== digest(value.relativePath) || !relative(value.folderRelativePath, true) || value.folderRelativePath !== (path.posix.dirname(value.relativePath) === '.' ? '' : path.posix.dirname(value.relativePath)) || !['chart', 'midi', 'sng'].includes(value.format) || !['present', 'missing', 'unknown'].includes(value.audio) || typeof value.signature !== 'string' || value.signature.length > 8192 || TEXT_FIELDS.some(key => typeof value[key] !== 'string' || value[key].length > 512)) throw Error('Invalid library item');
  return Object.fromEntries([...PUBLIC_FIELDS, 'signature', 'folderRelativePath'].map(key => [key, value[key]]));
}
function validateDocument(value) {
  if (!object(value) || value.version !== VERSION || !Array.isArray(value.items) || !count(value.revision) || !(value.lastScanAt === null || (typeof value.lastScanAt === 'string' && value.lastScanAt.length < 50 && Number.isFinite(Date.parse(value.lastScanAt))))) throw Error('Invalid library index');
  const items = value.items.map(validateItem);
  if (new Set(items.map(item => item.id)).size !== items.length) throw Error('Duplicate library item');
  const cleanSettings = settings(value.settings);
  if (!cleanSettings.rootPath && items.length) throw Error('Library index has no root');
  return { version: VERSION, settings: cleanSettings, items, lastScanAt: value.lastScanAt, revision: value.revision,
    changes: object(value.changes) && ['added', 'removed', 'modified'].every(key => count(value.changes[key])) ? { added: value.changes.added, removed: value.changes.removed, modified: value.changes.modified } : { added: 0, removed: 0, modified: 0 },
    warningCount: count(value.warningCount) ? value.warningCount : 0, skippedCount: count(value.skippedCount) ? value.skippedCount : 0 };
}

/** Main-process index. Queries and status never expose signatures or absolute song paths. */
function createInstalledLibraryService({ dataDirectory, onChange, recycle } = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) throw safeError('Dossier de données de bibliothèque invalide.');
  const filename = path.join(dataDirectory, 'library.json');
  let document = { version: VERSION, settings: { rootPath: null, watch: false, refreshOnStart: true }, items: [], lastScanAt: null, revision: 0, changes: { added: 0, removed: 0, modified: 0 }, warningCount: 0, skippedCount: 0 };
  let phase = 'idle', mode = null, progress = { visited: 0, processed: 0, discovered: 0 }, error = null;
  let loaded = false, loadTask, blocked = null, active = false, epoch = 0, rootTicket = 0;
  let run = null, queuedMode = null, serial = Promise.resolve(), startTask = null, stopTask = null;
  let watcher = null, watcherState = 'off', debounce = null;
  let matchingCache = null, matchingRoot = null;
  const queryIndex = createLibraryQuery({ textFields: TEXT_FIELDS, publicFields: PUBLIC_FIELDS });
  const duplicates = createLibraryDuplicates({ dataDirectory, getDocument: () => document });
  let deferredCleanupScan = false;
  const cleanup = createLibraryCleanup({ getDocument: () => document,
    getContext: options => duplicates.cleanupContext(options), recycle: recycle ?? (async () => { throw Error('Corbeille indisponible.'); }),
    onCleaned: () => { if (stopTask) throw Error('Bibliothèque arrêtée.'); deferredCleanupScan = false; requestScan('quick'); } });
  function requireCleanupIdle() {
    if (cleanup.busy()) throw Object.assign(Error('Attendez la fin de la vérification ou du nettoyage des copies.'), { code: 'LIBRARY_CLEANUP_SAFE' });
  }
  function status() {
    return { settings: { ...document.settings }, status: phase, mode, progress: { ...progress }, count: document.items.length,
      lastScanAt: document.lastScanAt, changes: { ...document.changes }, warningCount: document.warningCount, skippedCount: document.skippedCount,
      error, watcher: watcherState, revision: document.revision };
  }
  function notify() { try { onChange?.(status()); } catch { console.warn('La notification de bibliothèque a échoué.'); } }
  function enqueue(action) { const task = serial.then(action); serial = task.catch(() => {}); return task; }
  function ensureMutable() {
    if (!loaded) throw safeError('La bibliothèque n’est pas encore chargée.');
    if (blocked === 'future') throw safeError('Cet index provient d’une version plus récente et reste protégé.');
    if (blocked) throw safeError('L’index est illisible. Sélectionnez à nouveau le dossier pour le reconstruire.');
  }
  async function write(next) {
    await fs.mkdir(dataDirectory, { recursive: true });
    const temporary = filename + '.' + randomUUID() + '.tmp'; let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      // Keep the existing JSON format while writing bounded batches. A large
      // library need not become one additional giant string in the main process.
      const { items, ...header } = next;
      await handle.writeFile(JSON.stringify(header).slice(0, -1) + ',"items":[', 'utf8');
      for (let offset = 0; offset < items.length; offset += 256) {
        const batch = JSON.stringify(items.slice(offset, offset + 256)).slice(1, -1);
        await handle.writeFile((offset ? ',' : '') + batch, 'utf8');
      }
      await handle.writeFile(']}\n', 'utf8'); await handle.sync(); await handle.close(); handle = null;
      try { await fs.copyFile(filename, filename + '.bak'); } catch (failure) { if (failure?.code !== 'ENOENT') throw failure; }
      await fs.rename(temporary, filename);
    } finally { await handle?.close().catch(() => {}); await fs.unlink(temporary).catch(failure => { if (failure?.code !== 'ENOENT') console.warn('Le fichier temporaire de bibliothèque n’a pas pu être nettoyé.'); }); }
  }
  async function load() {
    if (loaded) return status();
    if (loadTask) return loadTask;
    loadTask = (async () => {
      try {
        const stat = await fs.stat(filename);
        if (!stat.isFile()) throw Error('Invalid library index');
        const value = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (object(value) && Number.isInteger(value.version) && value.version > VERSION) { blocked = 'future'; throw Error('Future version'); }
        document = validateDocument(value); duplicates.invalidate(); phase = document.lastScanAt ? 'ready' : 'idle';
      } catch (failure) {
        if (failure?.code !== 'ENOENT') { blocked ||= 'corrupt'; phase = 'error'; error = blocked === 'future' ? 'Cet index provient d’une version plus récente et reste protégé.' : 'L’index de bibliothèque est illisible. Le fichier original est conservé.'; }
      }
      loaded = true; notify(); return status();
    })();
    return loadTask;
  }
  function closeWatcher() {
    if (debounce) clearTimeout(debounce); debounce = null;
    watcher?.close(); watcher = null; watcherState = 'off';
  }
  function updateWatcher() {
    closeWatcher();
    if (!active || blocked || !document.settings.watch || !document.settings.rootPath) return;
    const root = document.settings.rootPath;
    try {
      watcher = watch(root, { recursive: true }, (_event, name) => {
        if (!active || !watcher) return;
        if (name) {
          if (String(name).split(/[\\/]/).some(part => /^\.chartshub-companion-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(part))) return;
          const changed = path.resolve(root, String(name));
          if (within(root, dataDirectory) && !samePath(root, dataDirectory) && within(dataDirectory, changed)) return;
          if (samePath(path.dirname(changed), dataDirectory) && /^library\.json(?:$|\.bak$|\.[a-f0-9-]+\.tmp$|\.corrupt-[a-f0-9-]+\.bak$)/i.test(path.basename(changed))) return;
        }
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = null;
          if (!active || blocked) return;
          if (cleanup.busy()) { deferredCleanupScan = true; return; }
          try { requestScan('quick'); } catch { watcherState = 'unavailable'; notify(); }
        }, 750);
        debounce.unref?.();
      });
      watcher.on('error', () => { closeWatcher(); watcherState = 'unavailable'; notify(); });
      watcherState = 'watching';
    } catch { watcher = null; watcherState = 'unavailable'; }
  }
  function changes(items) {
    const old = new Map(document.items.map(item => [item.id, item])); let added = 0, modified = 0;
    for (const item of items) { const previous = old.get(item.id); if (!previous) added++; else if (previous.signature !== item.signature || PUBLIC_FIELDS.some(key => previous[key] !== item[key])) modified++; old.delete(item.id); }
    return { added, removed: old.size, modified };
  }
  function beginScan(nextMode) {
    cleanup.invalidate(); duplicates.invalidate();
    const current = { controller: new AbortController(), epoch, root: document.settings.rootPath, committing: false, promise: null };
    run = current; phase = 'scanning'; mode = nextMode; error = null; progress = { visited: 0, processed: 0, discovered: 0 }; notify();
    current.promise = (async () => {
      try {
        const result = await scanLibrary({ rootPath: current.root, previousItems: document.items, mode: nextMode, signal: current.controller.signal,
          onProgress: value => { if (run === current && !current.controller.signal.aborted) { progress = { visited: value.visited, processed: value.processed, discovered: value.discovered }; notify(); } } });
        if (current.controller.signal.aborted || current.epoch !== epoch) return;
        await enqueue(async () => {
          if (current.controller.signal.aborted || current.epoch !== epoch || current.root !== document.settings.rootPath) return;
          current.committing = true;
          const items = result.items.map(validateItem);
          if (new Set(items.map(item => item.id)).size !== items.length) throw Error('Invalid scan output');
          const next = { ...document, items, revision: document.revision + 1, lastScanAt: new Date().toISOString(), changes: changes(items), warningCount: result.warningCount, skippedCount: result.skippedCount };
          await write(next); document = next; duplicates.invalidate(); phase = 'ready'; error = null;
        });
      } catch (failure) {
        if (current.controller.signal.aborted || failure?.name === 'AbortError') { phase = 'cancelled'; error = null; }
        else { phase = 'error'; error = 'Impossible de terminer l’analyse. L’index précédent est conservé.'; }
      } finally {
        if (run === current) {
          if (current.controller.signal.aborted && phase === 'scanning') phase = 'cancelled';
          run = null; notify();
          const next = queuedMode; queuedMode = null;
          // cancel() clears older requests. A request queued afterwards is an
          // explicit restart and must survive the aborted scan's cleanup.
          if (next && current.epoch === epoch) beginScan(next);
        }
      }
    })();
  }
  function requestScan(nextMode = 'quick') {
    requireCleanupIdle();
    ensureMutable();
    if (!['full', 'quick'].includes(nextMode)) throw safeError('Mode d’analyse invalide.');
    if (!document.settings.rootPath) throw safeError('Sélectionnez d’abord un dossier de chansons.');
    if (run) queuedMode = queuedMode === 'full' || nextMode === 'full' ? 'full' : 'quick';
    else beginScan(nextMode);
    return true;
  }
  function cancel() {
    queuedMode = null; if (debounce) clearTimeout(debounce); debounce = null;
    if (!run || run.committing) return false;
    run.controller.abort(); phase = 'cancelled'; error = null; notify(); return true;
  }
  async function start() {
    if (startTask) return startTask;
    startTask = (async () => {
      if (stopTask) await stopTask;
      if (active) return status();
      const requestedEpoch = epoch; await load();
      if (requestedEpoch !== epoch) return status();
      active = true; updateWatcher(); notify();
      if (!blocked && document.settings.rootPath && document.settings.refreshOnStart) requestScan('quick');
      return status();
    })();
    try { return await startTask; } finally { startTask = null; }
  }
  async function stop() {
    if (stopTask) return stopTask;
    active = false; epoch++; rootTicket++; closeWatcher(); cancel();
    deferredCleanupScan = false;
    const cleanupStopped = cleanup.stop();
    const comparisonsStopped = duplicates.stop();
    stopTask = (async () => { if (run) await run.promise; await serial; await cleanupStopped; await comparisonsStopped; notify(); return status(); })();
    try { return await stopTask; } finally { stopTask = null; }
  }
  async function selectRoot(selected) {
    requireCleanupIdle();
    const requestedEpoch = epoch, ticket = ++rootTicket;
    await load();
    if (blocked === 'future') ensureMutable();
    if (typeof selected !== 'string' || !path.isAbsolute(selected) || selected.includes('\0')) throw safeError('Dossier de chansons invalide.');
    let root;
    try { root = await fs.realpath(selected); if (!(await fs.stat(root)).isDirectory()) throw Error(); }
    catch { throw safeError('Le dossier de chansons est introuvable ou inaccessible.'); }
    if (requestedEpoch !== epoch || ticket !== rootTicket) return status();
    requireCleanupIdle();
    cancel(); if (run) await run.promise;
    await enqueue(async () => {
      if (requestedEpoch !== epoch || ticket !== rootTicket) return;
      requireCleanupIdle(); cleanup.invalidate();
      // Picking the same folder refreshes its last committed index.
      if (!blocked && document.settings.rootPath && samePath(document.settings.rootPath, root)) return;
      const next = { ...document, settings: { ...document.settings, rootPath: root }, items: [], lastScanAt: null, revision: document.revision + 1, changes: { added: 0, removed: 0, modified: 0 }, warningCount: 0, skippedCount: 0 };
      try {
        if (blocked === 'corrupt') {
          // Unlike the rotating atomic-write backup, this recovery copy must
          // survive the following scan commit and all subsequent edits.
          const backup = filename + '.corrupt-' + Date.now() + '-' + randomUUID() + '.bak';
          try { await fs.copyFile(filename, backup, constants.COPYFILE_EXCL); } catch (failure) { if (failure?.code !== 'ENOENT') throw failure; }
        }
        await write(next);
      } catch { throw safeError('Impossible d’enregistrer le dossier de bibliothèque.'); }
      document = next; duplicates.invalidate(); blocked = null; phase = 'idle'; error = null; progress = { visited: 0, processed: 0, discovered: 0 }; mode = null;
    });
    if (requestedEpoch === epoch && ticket === rootTicket) { updateWatcher(); requestScan('full'); }
    notify(); return status();
  }
  async function configure(options) {
    requireCleanupIdle();
    const requestedEpoch = epoch; await load(); ensureMutable();
    if (!object(options) || Object.keys(options).some(key => !['watch', 'refreshOnStart'].includes(key) || typeof options[key] !== 'boolean')) throw safeError('Options de bibliothèque invalides.');
    await enqueue(async () => {
      if (requestedEpoch !== epoch) return;
      requireCleanupIdle(); cleanup.invalidate();
      const nextSettings = { ...document.settings, ...options };
      if (nextSettings.watch === document.settings.watch && nextSettings.refreshOnStart === document.settings.refreshOnStart) return;
      const next = { ...document, settings: nextSettings };
      try { await write(next); } catch { throw safeError('Impossible d’enregistrer les options de bibliothèque.'); }
      document = next;
    });
    if (requestedEpoch === epoch) updateWatcher(); notify(); return status();
  }
  function query(options = {}) {
    return queryIndex(document, options);
  }
  function requireComparisonReady() {
    ensureMutable();
    requireCleanupIdle();
    if (run || stopTask) throw Object.assign(Error('Attendez la fin de l’analyse puis relancez la comparaison.'), { code: 'LIBRARY_COMPARISON_SAFE' });
  }
  async function compareDuplicates(options) { requireComparisonReady(); cleanup.invalidate(); return duplicates.compare(options); }
  async function chooseDuplicate(options) { requireComparisonReady(); cleanup.invalidate(); return duplicates.choose(options); }
  async function cleanupOperation(method, options) {
    requireComparisonReady();
    try { return await cleanup[method](options); }
    finally {
      if (deferredCleanupScan && !cleanup.busy() && !stopTask) {
        deferredCleanupScan = false; requestScan('quick');
      }
    }
  }
  async function resolveSongFolder(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw safeError('Chanson de bibliothèque invalide.');
    const item = document.items.find(value => value.id === id), root = document.settings.rootPath;
    if (!item || !root) throw safeError('Cette chanson n’est plus disponible dans la bibliothèque.');
    try {
      if (!samePath(root, await fs.realpath(root)) || (await fs.lstat(root)).isSymbolicLink()) throw Error();
      let folder = root;
      for (const part of item.folderRelativePath.split('/').filter(Boolean)) {
        folder = path.join(folder, part); const stat = await fs.lstat(folder);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error();
      }
      const canonical = await fs.realpath(folder);
      if (!within(root, canonical) || !samePath(folder, canonical) || !(await fs.stat(canonical)).isDirectory()) throw Error();
      return canonical;
    } catch { throw safeError('Le dossier de cette chanson est indisponible ou a changé.'); }
  }
  function matchingSnapshot() {
    const root = document.settings.rootPath;
    if (matchingCache && matchingCache.revision === document.revision && matchingRoot === root) return matchingCache;
    matchingRoot = root;
    matchingCache = Object.freeze({
      rootKey: root ? digest(process.platform === 'win32' ? root.toLowerCase() : root) : null,
      revision: document.revision,
      items: Object.freeze(document.items.map(item => Object.freeze({
        id: item.id, title: item.title, artist: item.artist, charter: item.charter,
        fingerprint: digest(JSON.stringify([item.relativePath, item.signature, item.title, item.artist, item.charter]))
      })))
    });
    return matchingCache;
  }
  return { load, start, stop, status, selectRoot, requestScan, cancel, configure, query, compareDuplicates, chooseDuplicate, resolveSongFolder, matchingSnapshot,
    prepareCleanup: options => cleanupOperation('prepare', options), cleanupReview: options => cleanupOperation('review', options),
    recycleDuplicates: options => cleanupOperation('execute', options) };
}
module.exports = { createInstalledLibraryService };
