'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const FAILED = 'Le service de bibliothèque est indisponible. Rouvrez le Companion pour recharger l’index.';
const STOPPED = 'Le service de bibliothèque est arrêté.';
const initialStatus = () => ({ settings: { rootPath: null, watch: false, refreshOnStart: true }, status: 'idle', mode: null,
  progress: { visited: 0, processed: 0, discovered: 0 }, count: 0, lastScanAt: null, changes: { added: 0, removed: 0, modified: 0 },
  warningCount: 0, skippedCount: 0, error: null, watcher: 'off', revision: 0 });
const copyStatus = value => ({ ...value, settings: { ...value.settings }, progress: { ...value.progress }, changes: { ...value.changes } });
function freezeMatching(value) {
  for (const item of value.items) Object.freeze(item);
  Object.freeze(value.items);
  return Object.freeze(value);
}

/** Only small status and committed matching snapshots live in the main process. */
function createBackgroundLibraryService({ dataDirectory, onChange, recycle, workerFactory = (filename, options) => new Worker(filename, options) } = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) throw Error('Dossier de données de bibliothèque invalide.');
  let cachedStatus = initialStatus();
  let cachedMatching = freezeMatching({ rootKey: null, revision: 0, items: [] });
  let current = null, lifecycle = 'new', stopTask = null, nextId = 0;
  const nativeRecycles = new Set();

  function status() { return copyStatus(cachedStatus); }
  function notify() { try { onChange?.(status()); } catch { console.warn('La notification de bibliothèque a échoué.'); } }
  function update(state) {
    if (state.matching) cachedMatching = freezeMatching(state.matching);
    cachedStatus = state.status;
  }
  function fail(connection) {
    if (current !== connection) return;
    current = null; lifecycle = 'failed';
    for (const pending of connection.pending.values()) pending.reject(Error(FAILED));
    connection.pending.clear();
    cachedStatus = { ...cachedStatus, status: 'error', mode: null, error: FAILED, watcher: 'off' };
    notify();
    connection.worker?.unref();
    connection.worker?.terminate().catch(() => {});
  }
  function spawn() {
    const connection = { worker: null, pending: new Map(), stopping: false, recycleIds: new Set(), recycling: false };
    current = connection; lifecycle = 'open';
    try {
      const worker = workerFactory(path.join(__dirname, 'library-worker.cjs'), { workerData: { dataDirectory } });
      connection.worker = worker;
      worker.on('message', message => {
        // Old workers can still have messages queued during termination/reopen.
        if (current !== connection) return;
        if (message.type === 'recycle') {
          const parent = connection.pending.get(message.requestId);
          const allowed = !connection.stopping && !connection.recycling && ['recycleDuplicates', 'forceRecycleDuplicate'].includes(parent?.method)
            && Number.isSafeInteger(message.id) && message.id > 0 && !connection.recycleIds.has(message.id)
            && typeof recycle === 'function' && typeof message.target === 'string' && path.isAbsolute(message.target) && !message.target.includes('\0');
          const reply = ok => { try { worker.postMessage({ type: 'recycle-result', id: message.id, ok }); } catch {} };
          if (!allowed) { reply(false); return; }
          connection.recycleIds.add(message.id); connection.recycling = true;
          const task = Promise.resolve().then(() => {
            if (current !== connection || connection.stopping || connection.pending.get(message.requestId) !== parent) throw Error(STOPPED);
            return recycle(message.target, message.proof);
          }).then(() => reply(true), () => reply(false)).finally(() => { connection.recycling = false; nativeRecycles.delete(task); });
          nativeRecycles.add(task);
          return;
        }
        if (message.type === 'change') { update(message.state); notify(); return; }
        if (message.type !== 'reply') return;
        const pending = connection.pending.get(message.id);
        if (!pending) return;
        update(message.state);
        connection.pending.delete(message.id);
        if (!connection.pending.size && !connection.stopping) worker.unref();
        if (message.ok) pending.resolve(message.result);
        else pending.reject(Object.assign(Error(message.error), ['LIBRARY_COMPARISON_SAFE', 'LIBRARY_CLEANUP_SAFE', 'LIBRARY_CLEANUP_HISTORY'].includes(message.code) ? { code: message.code } : {}));
      });
      worker.on('error', () => fail(connection));
      worker.on('exit', () => { if (current === connection) fail(connection); });
      worker.unref();
      return connection;
    } catch {
      fail(connection);
      throw Error(FAILED);
    }
  }
  function request(connection, method, args) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      connection.pending.set(id, { resolve, reject, method });
      connection.worker.ref();
      try { connection.worker.postMessage({ id, method, args }); }
      catch {
        connection.pending.delete(id);
        if (!connection.pending.size && !connection.stopping) connection.worker.unref();
        reject(Error('Requête de bibliothèque invalide.'));
      }
    });
  }
  async function call(method, args, reopen = false) {
    if (stopTask) {
      if (!reopen) throw Error(STOPPED);
      await stopTask;
    }
    if (!current && !reopen && lifecycle !== 'new') throw Error(lifecycle === 'failed' ? FAILED : STOPPED);
    const connection = current || spawn();
    return request(connection, method, args);
  }
  async function stop() {
    if (stopTask) return stopTask;
    if (!current) {
      if (lifecycle !== 'failed') lifecycle = 'stopped';
      stopTask = (async () => { await Promise.allSettled([...nativeRecycles]); return status(); })();
      try { return await stopTask; } finally { stopTask = null; }
    }
    const connection = current;
    connection.stopping = true;
    stopTask = (async () => {
      try {
        // The worker acknowledges only after scans, earlier operations and writes drain.
        await request(connection, 'stop', []);
      } catch {
        // Shutdown remains safe after a worker crash; fail() has rejected its RPCs
        // and retained the last committed index for the next explicit reload.
        fail(connection);
      } finally {
        await Promise.allSettled([...nativeRecycles]);
        if (current === connection) { current = null; lifecycle = 'stopped'; }
        await connection.worker.terminate().catch(() => {});
      }
      return status();
    })();
    try { return await stopTask; } finally { stopTask = null; }
  }
  return {
    status, matchingSnapshot: () => cachedMatching, stop,
    load: () => call('load', [], true), start: () => call('start', [], true),
    selectRoot: root => call('selectRoot', [root]), configure: options => call('configure', [options]),
    requestScan: mode => call('requestScan', [mode]), cancel: () => call('cancel', []),
    verifyAllDuplicates: () => call('verifyAllDuplicates', []),
    cancelDuplicateVerification: () => call('cancelDuplicateVerification', []),
    cleanupHistory: options => call('cleanupHistory', [options]),
    compareDuplicates: options => call('compareDuplicates', [options]), chooseDuplicate: options => call('chooseDuplicate', [options]),
    prepareCleanup: options => call('prepareCleanup', [options]), cleanupReview: options => call('cleanupReview', [options]), cleanupForceReview: options => call('cleanupForceReview', [options]),
    recycleDuplicates: options => call('recycleDuplicates', [options]), forceRecycleDuplicate: options => call('forceRecycleDuplicate', [options]),
    query: options => call('query', [options]), resolveSongFolder: id => call('resolveSongFolder', [id])
  };
}

module.exports = { createBackgroundLibraryService };
