'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createInstalledLibraryService } = require('./library-service.cjs');

const METHODS = new Set(['load', 'start', 'stop', 'selectRoot', 'configure', 'requestScan', 'cancel', 'query', 'compareDuplicates', 'chooseDuplicate', 'resolveSongFolder', 'prepareCleanup', 'cleanupReview', 'recycleDuplicates']);
let lastRoot, lastRevision, stopping = false;
const pending = new Set();
const requests = new AsyncLocalStorage(), recycleRequests = new Map();
let nextRecycleId = 0;
const service = createInstalledLibraryService({ dataDirectory: workerData.dataDirectory,
  recycle: target => new Promise((resolve, reject) => {
    const request = requests.getStore();
    if (stopping || request?.method !== 'recycleDuplicates') return reject(Error('Nettoyage arrêté.'));
    const id = ++nextRecycleId;
    recycleRequests.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'recycle', id, requestId: request.id, target });
  }), onChange: () => {
  parentPort.postMessage({ type: 'change', state: snapshot() });
} });

function snapshot() {
  const status = service.status(), state = { status };
  // Progress and settings changes do not clone the full matching index.
  if (lastRoot !== status.settings.rootPath || lastRevision !== status.revision) {
    state.matching = service.matchingSnapshot();
    lastRoot = status.settings.rootPath; lastRevision = status.revision;
  }
  return state;
}
async function execute(method, args) {
  if (!METHODS.has(method) || !Array.isArray(args)) throw Error('Requête de bibliothèque invalide.');
  if (stopping) throw Error('Le service de bibliothèque est arrêté.');
  if (method !== 'stop') return service[method](...args);
  stopping = true;
  // Do not serialize all requests: stop/cancel must interrupt a running scan.
  // Capturing earlier RPCs also covers a load/selectRoot still awaiting the filesystem.
  const earlier = [...pending];
  await service.stop();
  await Promise.allSettled(earlier);
  await service.stop();
  return service.status();
}
parentPort.on('message', message => {
  if (message.type === 'recycle-result') {
    const request = recycleRequests.get(message.id);
    if (request) { recycleRequests.delete(message.id); if (message.ok) request.resolve(); else request.reject(Error('La Corbeille Windows n’a pas accepté cette copie.')); }
    return;
  }
  const task = requests.run({ id: message.id, method: message.method }, () => execute(message.method, message.args));
  pending.add(task);
  task.then(result => {
    parentPort.postMessage({ type: 'reply', id: message.id, ok: true, result, state: snapshot() });
  }, failure => {
    parentPort.postMessage({ type: 'reply', id: message.id, ok: false,
      ...(['LIBRARY_COMPARISON_SAFE', 'LIBRARY_CLEANUP_SAFE'].includes(failure?.code) ? { code: failure.code } : {}),
      error: typeof failure?.message === 'string' ? failure.message : 'Requête de bibliothèque invalide.', state: snapshot() });
  }).finally(() => pending.delete(task));
});
