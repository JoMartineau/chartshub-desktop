'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CHART_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/;
const MANIFEST = /^\/api\/charts\/[a-f0-9-]{36}\/[A-Za-z0-9_-]{10,200}\/download-manifest$/;
const STATES = ['Queued', 'Downloading', 'Paused', 'Completed', 'Failed', 'Cancelled'];
const MAX_ITEMS = 100, MAX_STATE_BYTES = 12 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const safe = message => Object.assign(new Error(message), { code: 'DOWNLOAD_SAFE' });
const stopped = () => safe('La file a été arrêtée. Rouvrez le panneau avant de continuer.');
const text = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 512) : '';
const samePath = (a, b) => path.relative(a, b) === '';
const absolute = value => typeof value === 'string' && value.length <= 32768 && !value.includes('\0') && path.isAbsolute(value);
function endpoint(value) {
  return typeof value === 'string' && value.length <= 512 && MANIFEST.test(value);
}
function descriptor(value) {
  if (!object(value) || Object.keys(value).some(key => !['chartId', 'title', 'artist', 'charter', 'endpoint'].includes(key)) || typeof value.chartId !== 'string' || !CHART_ID.test(value.chartId) || !endpoint(value.endpoint) || ['title', 'artist', 'charter'].some(key => typeof value[key] !== 'string' || value[key].length > 512)) throw safe('Le téléchargement demandé n’est pas valide.');
  return { chartId: value.chartId, title: text(value.title), artist: text(value.artist), charter: text(value.charter), endpoint: value.endpoint };
}
function downloadError(problem) {
  const messages = {
    DOWNLOAD_INVALID: 'Le manifeste du chart est invalide ou dépasse les limites autorisées.',
    DOWNLOAD_TIMEOUT: 'Le serveur met trop de temps à répondre. Réessayez.',
    DOWNLOAD_NETWORK: 'La connexion au serveur a échoué. Réessayez.',
    DOWNLOAD_HTTP: 'Le serveur ne permet pas de télécharger ce chart pour le moment.',
    DOWNLOAD_INTEGRITY: 'Un fichier téléchargé ne correspond pas au manifeste. Réessayez.',
    DOWNLOAD_PATH: 'Le dossier de téléchargement a changé ou n’est pas sûr.',
    DOWNLOAD_BUSY: 'Le dossier temporaire est déjà utilisé. Réessayez.',
    DOWNLOAD_IO: 'Impossible de lire ou d’écrire les fichiers du téléchargement.',
    ENOSPC: 'L’espace disque disponible est insuffisant.'
  };
  return messages[problem?.code] ?? 'Le téléchargement a échoué. Les fichiers partiels validés sont conservés.';
}
function validateDocument(value) {
  if (!object(value) || value.version !== 1 || !(value.rootPath === null || absolute(value.rootPath)) || !Array.isArray(value.items) || value.items.length > MAX_ITEMS || !nonnegative(value.revision)) throw Error('Invalid download state');
  const ids = new Set(), items = value.items.map(item => {
    if (!object(item) || !ID.test(item.id) || ids.has(item.id) || !absolute(item.rootPath) || !STATES.includes(item.state) || !nonnegative(item.receivedBytes) || !nonnegative(item.completedFiles) || !(item.totalBytes === null || nonnegative(item.totalBytes)) || !(item.totalFiles === null || nonnegative(item.totalFiles)) || (item.totalBytes !== null && item.receivedBytes > item.totalBytes) || (item.totalFiles !== null && item.completedFiles > item.totalFiles) || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string' || item.createdAt.length > 50 || item.updatedAt.length > 50 || !Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.updatedAt))) throw Error('Invalid download item');
    const metadata = descriptor({ chartId: item.chartId, title: item.title, artist: item.artist, charter: item.charter, endpoint: item.endpoint }); ids.add(item.id);
    if (item.state === 'Completed' && (!absolute(item.destination) || !samePath(path.dirname(item.destination), item.rootPath) || path.basename(item.destination) !== item.folderName)) throw Error('Invalid completed destination');
    return { id: item.id, ...metadata, rootPath: item.rootPath, state: ['Queued', 'Downloading'].includes(item.state) ? 'Paused' : item.state,
      receivedBytes: item.receivedBytes, totalBytes: item.totalBytes, completedFiles: item.completedFiles, totalFiles: item.totalFiles, currentFile: null,
      error: item.state === 'Failed' ? downloadError({ code: item.errorCode }) : null, errorCode: typeof item.errorCode === 'string' ? item.errorCode : null,
      ...(item.state === 'Completed' ? { destination: item.destination, folderName: item.folderName } : {}), createdAt: item.createdAt, updatedAt: item.updatedAt };
  });
  return { version: 1, rootPath: value.rootPath, items, revision: value.revision };
}

/** One transfer at a time. Only explicit queue/resume/retry actions may cause traffic. */
function createDownloadService({ dataDirectory, worker, onChange } = {}) {
  if (!absolute(dataDirectory) || ['run', 'discard', 'resolveCompleted'].some(key => typeof worker?.[key] !== 'function')) throw safe('Configuration des téléchargements invalide.');
  const filename = path.join(dataDirectory, 'download-state.json');
  let document = { version: 1, rootPath: null, items: [], revision: 0 }, loaded = false, loadTask = null, protectedFile = null;
  let active = false, epoch = 0, rootTicket = 0, error = null, diskFailed = false, current = null, stopTask = null;
  let serial = Promise.resolve(); const commands = new Set(), cleaning = new Set();
  function publicItem(item) {
    const keys = ['id', 'chartId', 'title', 'artist', 'charter', 'rootPath', 'state', 'receivedBytes', 'totalBytes', 'completedFiles', 'totalFiles', 'currentFile', 'error', 'destination', 'folderName', 'createdAt', 'updatedAt'];
    return Object.fromEntries(keys.filter(key => item[key] !== undefined).map(key => [key, item[key]]));
  }
  function status() { return { revision: document.revision, rootPath: document.rootPath, items: document.items.map(publicItem), error }; }
  function notify() { try { onChange?.(status()); } catch { console.warn('La notification des téléchargements a échoué.'); } }
  function queue(action) { const task = serial.then(action); serial = task.catch(() => {}); return task; }
  function item(id) { if (typeof id !== 'string' || !ID.test(id)) throw safe('Téléchargement invalide.'); const value = document.items.find(entry => entry.id === id); if (!value) throw safe('Ce téléchargement n’existe plus dans la file.'); return value; }
  function check(expected) {
    if (protectedFile) throw safe(protectedFile === 'future' ? 'La file provient d’une version plus récente et reste protégée.' : 'La file de téléchargements est illisible. Le fichier original est conservé.');
    if (!active || expected !== epoch) throw stopped();
  }
  function action(callback) {
    const expected = epoch;
    const operation = (async () => { await load(); check(expected); return callback(expected); })();
    commands.add(operation); operation.then(() => commands.delete(operation), () => commands.delete(operation)); return operation;
  }
  async function write(next, guard = () => {}) {
    const bytes = JSON.stringify(next);
    if (Buffer.byteLength(bytes) > MAX_STATE_BYTES) throw safe('La file de téléchargements dépasse la taille autorisée.');
    await fs.mkdir(dataDirectory, { recursive: true }); const temporary = filename + '.' + randomUUID() + '.tmp'; let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(bytes, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      guard(); try { await fs.copyFile(filename, filename + '.bak'); } catch (problem) { if (problem?.code !== 'ENOENT') throw problem; }
      guard(); await fs.rename(temporary, filename);
    } finally { await handle?.close().catch(() => {}); await fs.unlink(temporary).catch(problem => { if (problem?.code !== 'ENOENT') console.warn('Le fichier temporaire des téléchargements n’a pas pu être nettoyé.'); }); }
  }
  async function commit(items, rootPath = document.rootPath, guard = () => {}) {
    const next = { version: 1, rootPath, items, revision: document.revision + 1 };
    try { await write(next, guard); }
    catch (problem) {
      if (problem?.code === 'DOWNLOAD_SAFE') throw problem;
      diskFailed = true; error = 'Impossible d’enregistrer la file de téléchargements. Le fichier précédent est conservé.'; notify(); throw safe(error);
    }
    // Progress can publish while an unrelated root/queue edit is being saved.
    // Never let that completed write move the live revision backwards.
    next.revision = Math.max(next.revision, document.revision + 1);
    document = next; diskFailed = false; error = null; notify();
  }
  async function replace(id, changes, guard) { await commit(document.items.map(entry => entry.id === id ? { ...entry, ...changes, updatedAt: new Date().toISOString() } : entry), document.rootPath, guard); }
  async function load() {
    if (loaded) return status(); if (loadTask) return loadTask;
    loadTask = (async () => {
      try {
        const stat = await fs.stat(filename); if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw Error('Invalid state size');
        const value = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (object(value) && Number.isInteger(value.version) && value.version > 1) { protectedFile = 'future'; throw Error('Future state'); }
        document = validateDocument(value);
      } catch (problem) {
        if (problem?.code !== 'ENOENT') { protectedFile ||= 'corrupt'; error = protectedFile === 'future' ? 'La file provient d’une version plus récente et reste protégée.' : 'La file de téléchargements est illisible. Le fichier original est conservé.'; }
      }
      loaded = true; notify(); return status();
    })();
    return loadTask;
  }
  async function start() {
    if (stopTask) await stopTask;
    const expected = epoch; await load(); if (expected === epoch) active = true;
    // Persisted pending entries were restored as Paused. Never resume them here.
    return status();
  }
  function progress(run, update) {
    if (current !== run || run.intent || run.controller.signal.aborted || run.epoch !== epoch || !object(update)) return;
    const target = document.items.find(entry => entry.id === run.id); if (!target || target.state !== 'Downloading') return;
    for (const key of ['receivedBytes', 'completedFiles']) if (nonnegative(update[key])) target[key] = update[key];
    for (const key of ['totalBytes', 'totalFiles']) if (update[key] === null || nonnegative(update[key])) target[key] = update[key];
    if (target.totalBytes !== null) target.receivedBytes = Math.min(target.receivedBytes, target.totalBytes);
    if (target.totalFiles !== null) target.completedFiles = Math.min(target.completedFiles, target.totalFiles);
    target.currentFile = text(update.currentFile) || null;
    if (Date.now() - run.lastProgress >= 100) { run.lastProgress = Date.now(); document.revision++; notify(); }
  }
  async function execute(run) {
    try {
      let started = false;
      await queue(async () => {
        const target = document.items.find(entry => entry.id === run.id);
        if (!active || run.epoch !== epoch || run.intent || !target || target.state !== 'Queued' || cleaning.has(run.id)) return;
        await replace(run.id, { state: 'Downloading', error: null, errorCode: null, currentFile: null }, () => check(run.epoch)); started = true;
      });
      if (!started || run.intent || run.controller.signal.aborted) return;
      const result = await worker.run({ id: run.id, endpoint: run.endpoint, rootPath: run.rootPath, signal: run.controller.signal, onProgress: update => progress(run, update) });
      if (!object(result) || !absolute(result.destination) || !samePath(path.dirname(result.destination), run.rootPath) || typeof result.folderName !== 'string' || path.basename(result.destination) !== result.folderName || !nonnegative(result.files) || result.files < 1 || !nonnegative(result.totalBytes)) throw Object.assign(Error('Invalid completion'), { code: 'DOWNLOAD_PATH' });
      const canonical = await worker.resolveCompleted({ rootPath: run.rootPath, destination: result.destination });
      if (!absolute(canonical) || !samePath(canonical, result.destination)) throw Object.assign(Error('Missing completed folder'), { code: 'DOWNLOAD_PATH' });
      // The worker's final promotion is not cancellable. An actual published
      // directory wins over a pause/cancel that arrived after that boundary.
      await queue(async () => {
        if (current !== run || !document.items.some(entry => entry.id === run.id)) return;
        const changes = { state: 'Completed', destination: canonical, folderName: result.folderName, receivedBytes: result.totalBytes, totalBytes: result.totalBytes, completedFiles: result.files, totalFiles: result.files, currentFile: null, error: null, errorCode: null };
        try { await replace(run.id, changes); }
        catch (problem) {
          // Keep the published folder represented in memory even if the disk
          // holding queue history fails; stop() will attempt another save.
          Object.assign(item(run.id), changes, { updatedAt: new Date().toISOString() }); document.revision++; notify(); throw problem;
        }
      });
    } catch (problem) {
      await queue(async () => {
        const target = document.items.find(entry => entry.id === run.id);
        if (current !== run || !target || target.state === 'Completed') return;
        const interrupted = run.controller.signal.aborted || problem?.name === 'AbortError' || problem?.code === 'ABORT_ERR';
        if (interrupted && run.intent === 'Cancelled') return;
        if (interrupted && target.state !== 'Downloading') return;
        const changes = interrupted ? { state: 'Paused', currentFile: null, error: null, errorCode: null }
          : { state: 'Failed', currentFile: null, error: downloadError(problem), errorCode: problem?.code ?? null };
        try { await replace(run.id, changes); }
        catch { Object.assign(target, changes); document.revision++; notify(); }
      });
    } finally { if (current === run) current = null; pump(); }
  }
  function pump() {
    if (!active || current || protectedFile || diskFailed) return;
    const target = document.items.find(entry => entry.state === 'Queued'); if (!target || cleaning.has(target.id)) return;
    const run = { id: target.id, rootPath: target.rootPath, endpoint: target.endpoint, epoch, intent: null, controller: new AbortController(), lastProgress: 0, promise: null };
    current = run; run.promise = Promise.resolve().then(() => execute(run));
  }
  async function stop() {
    if (stopTask) return stopTask;
    active = false; epoch++; rootTicket++;
    const running = current;
    if (running) { running.intent ||= 'Paused'; running.controller.abort(); }
    stopTask = (async () => {
      await queue(async () => {
        if (!loaded || protectedFile) return;
        const items = document.items.map(entry => ['Queued', 'Downloading'].includes(entry.state) ? { ...entry, state: 'Paused', currentFile: null, error: null, errorCode: null, updatedAt: new Date().toISOString() } : entry);
        if (items.some((entry, index) => entry !== document.items[index])) {
          try { await commit(items); } catch { document.items = items; document.revision++; notify(); }
        }
      });
      if (running) await running.promise;
      await Promise.allSettled([...commands]); await serial;
      if (loaded && !protectedFile && (document.items.length || document.rootPath)) { try { await queue(() => commit(document.items)); } catch { /* status.error reports the failed save. */ } }
      notify(); return status();
    })();
    try { return await stopTask; } finally { stopTask = null; }
  }
  function selectRoot(selected) {
    const ticket = ++rootTicket;
    return action(async expected => {
      if (!absolute(selected)) throw safe('Dossier de téléchargement invalide.');
      let canonical;
      try { canonical = await fs.realpath(selected); if (!(await fs.stat(canonical)).isDirectory()) throw Error(); }
      catch { throw safe('Le dossier de téléchargement est introuvable ou inaccessible.'); }
      await queue(async () => { check(expected); if (ticket !== rootTicket) throw stopped(); if (document.rootPath && samePath(document.rootPath, canonical)) return; await commit(document.items, canonical, () => { check(expected); if (ticket !== rootTicket) throw stopped(); }); });
      return status();
    });
  }
  function enqueue(value) {
    return action(async expected => {
      const clean = descriptor(value); let id;
      await queue(async () => {
        check(expected); if (!document.rootPath) throw safe('Choisissez d’abord un dossier de téléchargement.');
        const existing = document.items.find(entry => entry.chartId === clean.chartId && samePath(entry.rootPath, document.rootPath) && entry.state !== 'Cancelled');
        if (existing) { id = existing.id; return; }
        if (document.items.length >= MAX_ITEMS) throw safe('La file accepte au maximum 100 téléchargements. Retirez des éléments de l’historique.');
        id = randomUUID(); const now = new Date().toISOString();
        const next = { id, ...clean, rootPath: document.rootPath, state: 'Queued', receivedBytes: 0, totalBytes: null, completedFiles: 0, totalFiles: null, currentFile: null, error: null, errorCode: null, createdAt: now, updatedAt: now };
        await commit([...document.items, next], document.rootPath, () => check(expected));
      });
      pump(); return { id };
    });
  }
  function pause(id) {
    return action(async expected => {
      let running;
      await queue(async () => {
        check(expected); const target = item(id);
        if (!['Queued', 'Downloading'].includes(target.state)) throw safe('Seul un téléchargement en attente ou en cours peut être mis en pause.');
        running = current?.id === id ? current : null;
        if (running) { running.intent = 'Paused'; running.controller.abort(); }
        await replace(id, { state: 'Paused', currentFile: null, error: null, errorCode: null }, () => check(expected));
      });
      if (running) await running.promise; pump(); return status();
    });
  }
  function schedule(id, retrying) {
    return action(async expected => {
      await queue(async () => {
        check(expected); const target = item(id), allowed = retrying ? ['Failed', 'Cancelled'] : ['Paused'];
        if (!allowed.includes(target.state)) throw safe(retrying ? 'Seul un téléchargement échoué ou annulé peut être réessayé.' : 'Seul un téléchargement en pause peut être repris.');
        if (cleaning.has(id)) throw safe('Le nettoyage de ce téléchargement est encore en cours.');
        if (document.items.some(entry => entry.id !== id && entry.chartId === target.chartId && samePath(entry.rootPath, target.rootPath) && entry.state !== 'Cancelled')) throw safe('Ce chart possède déjà un téléchargement dans ce dossier. Utilisez l’élément existant.');
        await replace(id, { state: 'Queued', currentFile: null, error: null, errorCode: null }, () => check(expected));
      });
      pump(); return status();
    });
  }
  function clean(id, removing) {
    return action(async expected => {
      let running, target;
      await queue(() => {
        check(expected); target = item(id);
        const allowed = removing ? ['Paused', 'Completed', 'Failed', 'Cancelled'] : ['Queued', 'Downloading', 'Paused', 'Failed'];
        if (!allowed.includes(target.state)) throw safe(removing ? 'Mettez ce téléchargement en pause avant de le retirer.' : 'Ce téléchargement ne peut pas être annulé dans son état actuel.');
        if (cleaning.has(id)) throw safe('Le nettoyage de ce téléchargement est encore en cours.');
        cleaning.add(id); running = current?.id === id ? current : null;
        if (running) { running.intent = 'Cancelled'; running.controller.abort(); }
      });
      try {
        if (running) await running.promise;
        await queue(async () => {
          target = item(id);
          // discard owns only this UUID's staging/receipt, never the published
          // destination. Removing completed history also removes its receipt.
          if (removing || target.state !== 'Completed') {
            try { await worker.discard({ id, rootPath: target.rootPath }); }
            catch { throw safe('Impossible de nettoyer les fichiers temporaires de ce téléchargement.'); }
          }
          if (removing) await commit(document.items.filter(entry => entry.id !== id));
          else if (target.state !== 'Completed') await replace(id, { state: 'Cancelled', receivedBytes: 0, completedFiles: 0, currentFile: null, error: null, errorCode: null });
        });
      } catch (problem) {
        await queue(async () => {
          const retained = document.items.find(entry => entry.id === id);
          if (retained?.state === 'Downloading') { try { await replace(id, { state: 'Failed', currentFile: null, error: 'Le nettoyage des fichiers temporaires a échoué.', errorCode: 'DOWNLOAD_IO' }); } catch { /* The storage failure is already exposed in status. */ } }
        });
        throw problem?.code === 'DOWNLOAD_SAFE' ? problem : safe('Impossible de retirer ce téléchargement.');
      } finally { cleaning.delete(id); pump(); }
      return status();
    });
  }
  async function resolveFolder(id) {
    await load(); const target = item(id);
    if (target.state !== 'Completed') throw safe('Le dossier est disponible uniquement après un téléchargement terminé.');
    try { const canonical = await worker.resolveCompleted({ rootPath: target.rootPath, destination: target.destination }); if (!absolute(canonical) || !samePath(path.dirname(canonical), target.rootPath) || !samePath(canonical, target.destination)) throw Error(); return canonical; }
    catch { throw safe('Le dossier téléchargé est indisponible ou a changé.'); }
  }
  return { load, start, stop, status, selectRoot, enqueue, pause, resume: id => schedule(id, false), cancel: id => clean(id, false), retry: id => schedule(id, true), remove: id => clean(id, true), resolveFolder };
}
module.exports = { createDownloadService };
