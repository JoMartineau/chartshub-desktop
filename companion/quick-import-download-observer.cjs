'use strict';

// Main-process adapter only. It observes download notifications; it never scans,
// reads history from disk, manages the client, or changes a successful download.
const path = require('node:path');

const DOWNLOAD_STATES = new Set(['Queued', 'Downloading', 'Paused', 'Completed', 'Failed', 'Cancelled']);
const REMOTE_STATES = new Set(['queued', 'importing', 'ready', 'failed', 'cancelled']);
const MAX_ITEMS = 100;
const MAX_PENDING = 32;
const MAX_RECORDS = 64;
const MAX_COMPLETIONS = 128;
const ACTIVE_STATES = new Set(['waiting', 'resolving', 'submitting']);
const ERROR_CODES = new Set([
  'CANCELLED', 'DISPOSED', 'NOT_ENABLED', 'CLIENT_QUEUE_FULL', 'CLIENT_BUSY',
  'CONNECTION_CHANGED', 'CONNECTION_UNAVAILABLE', 'TIMEOUT', 'INVALID_COMPLETION',
  'OUTSIDE_SONGS_ROOT', 'LINKED_PATH', 'CHART_CHANGED', 'CHART_MISSING_OR_TOO_LARGE',
  'CHART_DIGEST_CHANGED', 'DOWNLOAD_INCOMPLETE', 'AUDIO_MISSING', 'METADATA_MISSING',
  'QUEUE_FULL', 'IMPORT_NOT_VALIDATED', 'UNVERIFIED_BUILD', 'NATIVE_IMPORT_FAILED',
  'NATIVE_IMPORT_NOT_COMPLETE', 'LOCAL_UNAVAILABLE', 'PROTOCOL', 'PROVIDER_REFUSED'
]);

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function uuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value);
}
function safeCode(error, fallback) {
  try { return ERROR_CODES.has(error?.code) ? error.code : fallback; }
  catch { return fallback; }
}

function createQuickImportDownloadObserver(options) {
  if (!plain(options) || typeof options.context !== 'function'
      || typeof options.resolveCompletion !== 'function'
      || typeof options.client?.newCompleted !== 'function'
      || (options.pendingCount !== undefined && typeof options.pendingCount !== 'function')
      || (options.onChange !== undefined && typeof options.onChange !== 'function')) {
    throw new TypeError('INVALID_OBSERVER_CONFIGURATION');
  }
  const platform = options.platform ?? process.platform;
  const paths = options.pathApi ?? (platform === 'win32' ? path.win32 : path);
  const equal = (a, b) => platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const client = options.client;
  let run = null, observed = null, inFlight = null, queue = [], records = new Map();
  let disposed = false, notifying = false, contextSuppression = 0;
  let fault = null, ignored = 0, generation = 0, observationEpoch = 0;

  function canonical(value) {
    if (typeof value !== 'string' || !value.length || value.length > 230
        || /[\x00-\x1f\x7f]/.test(value) || !paths.isAbsolute(value)
        || /^(?:\\\\|\/\/)/.test(value)) throw Error('INVALID_PATH');
    if (paths === path.win32 && (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':')
        || value.split(/[\\/]/).slice(1).some(part => /[. ]$/.test(part)))) throw Error('INVALID_PATH');
    return paths.resolve(value);
  }
  function within(root, destination) {
    const relative = paths.relative(root, destination);
    return !!relative && relative !== '..' && !relative.startsWith('..' + paths.sep) && !paths.isAbsolute(relative);
  }
  function context() {
    try {
      const value = options.context();
      if (!plain(value) || value.enabled !== true) return null;
      const lifecycle = value.lifecycle;
      if (!(Number.isSafeInteger(lifecycle) && lifecycle >= 0)
          && !(typeof lifecycle === 'string' && lifecycle.length > 0 && lifecycle.length <= 96
            && !/[\x00-\x1f\x7f]/.test(lifecycle))) return null;
      return { root: canonical(value.root), lifecycle, available: value.available === true };
    } catch { return null; }
  }
  function snapshot() {
    return {
      schema: 1,
      phase: disposed ? 'disposed' : !run ? 'disabled' : run.available ? 'observing' : 'waiting-for-client',
      pending: queue.length + (inFlight ? 1 : 0), fault, ignored,
      // This is local delivery status, not a substitute for the client's mod jobs.
      jobs: [...records.values()].map(value => ({
        id: value.id, state: value.state, code: value.code,
        mayHaveReachedMod: value.mayHaveReachedMod,
        confirmed: value.confirmed, remoteState: value.remoteState
      }))
    };
  }
  function notify() {
    if (notifying || !options.onChange) return;
    notifying = true;
    try { options.onChange(snapshot()); } catch { /* Download notifications must remain successful. */ }
    finally { notifying = false; }
  }
  function replaceRun(current) {
    const prior = run;
    // Publish the replacement before abort(): AbortSignal listeners may re-enter
    // observe/update. Their newer baseline must not be erased by the outer call.
    run = current ? { ...current, generation: ++generation, controller: new AbortController(), completions: new Set() } : null;
    observed = null; queue = [];
    for (const value of records.values()) {
      if (value.owner !== prior) continue;
      value.confirmed = false;
      if (ACTIVE_STATES.has(value.state)) {
        value.state = value.mayHaveReachedMod ? 'unconfirmed' : 'cancelled';
        value.code = 'CANCELLED';
      }
      // Submitted work can remain queued remotely: there is no remote cancel API.
    }
    if (prior) prior.controller.abort();
    return run;
  }
  function syncContext() {
    if (disposed || contextSuppression) return null;
    const current = context();
    if (!current) { if (run) replaceRun(null); return run; }
    if (!run || !equal(run.root, current.root) || run.lifecycle !== current.lifecycle) {
      fault = null;
      return replaceRun(current);
    } else run.available = current.available;
    return run;
  }
  function alive(owner) { return !disposed && run === owner && !owner.controller.signal.aborted; }
  function refreshOwner(owner) { if (run === owner) syncContext(); }
  function remember(value) {
    if (records.size >= MAX_RECORDS) {
      const finished = [...records].find(([, prior]) => prior !== inFlight && !ACTIVE_STATES.has(prior.state));
      if (finished) records.delete(finished[0]);
    }
    // At most 32 active records exist, so one terminal slot is always available.
    records.set(value.id, value);
  }
  function completion(raw, item, owner) {
    if (!plain(raw) || Object.keys(raw).length !== 3
        || !['id', 'folder', 'chartFile'].every(key => Object.hasOwn(raw, key))
        || !uuid(raw.id) || raw.id.toLowerCase() !== item.id
        || !['notes.chart', 'notes.mid'].includes(raw.chartFile)) throw Error('INVALID_COMPLETION');
    const folder = canonical(raw.folder);
    if (!equal(folder, item.destination) || !within(owner.root, folder)) throw Error('INVALID_COMPLETION');
    return Object.freeze({ id: item.id, folder, chartFile: raw.chartFile });
  }
  function pump() {
    if (inFlight || !run?.available || disposed || !queue.length) return;
    const value = queue.shift(), owner = value.owner;
    if (!alive(owner)) return;
    inFlight = value;
    value.state = value.resolved ? 'submitting' : 'resolving'; notify();
    // One physical task remains in flight even after revocation. An ignored
    // AbortSignal cannot create concurrent hash/enqueue calls in a new session.
    void Promise.resolve().then(async () => {
      try {
        refreshOwner(owner);
        if (!alive(owner)) return;
        if (!value.resolved) {
          const resolved = await options.resolveCompletion(Object.freeze({ ...value.item }), {
            signal: owner.controller.signal
          });
          refreshOwner(owner);
          if (!alive(owner)) return;
          value.resolved = completion(resolved, value.item, owner);
        }
        refreshOwner(owner);
        if (!alive(owner)) return;
        if (!owner.available) { value.state = 'waiting'; queue.unshift(value); return; }
        value.state = 'submitting';
        notify();
        refreshOwner(owner);
        if (!alive(owner)) return;
        if (!owner.available) { value.state = 'waiting'; queue.unshift(value); return; }
        value.mayHaveReachedMod = true;
        // The client owns hashing and the private pipe. Once handed off we cannot
        // promise remote cancellation, even if an acknowledgement is lost.
        const delivery = client.newCompleted(value.resolved);
        notify();
        const result = await delivery;
        refreshOwner(owner);
        if (!alive(owner)) return;
        value.state = 'submitted'; value.code = null;
        value.confirmed = result?.confirmed === true;
        value.remoteState = REMOTE_STATES.has(result?.state) ? result.state : 'unknown';
      } catch (error) {
        refreshOwner(owner);
        if (!alive(owner)) return;
        value.state = 'failed';
        value.code = safeCode(error, value.mayHaveReachedMod ? 'IMPORT_DELIVERY_FAILED' : 'COMPLETION_RESOLUTION_FAILED');
      } finally {
        if (inFlight === value) inFlight = null;
        notify();
        // Availability and leases may have changed while an injected resolver or
        // client was awaiting I/O. Re-check before admitting the next local task.
        if (run) syncContext();
        pump();
      }
    });
  }
  function update() {
    syncContext(); pump(); notify(); return snapshot();
  }
  function items(value) {
    if (!plain(value) || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) throw Error('INVALID_DOWNLOAD_STATUS');
    const result = new Map();
    for (const raw of value.items) {
      if (!plain(raw) || !uuid(raw.id) || !DOWNLOAD_STATES.has(raw.state)) throw Error('INVALID_DOWNLOAD_STATUS');
      const id = raw.id.toLowerCase(), rootPath = canonical(raw.rootPath);
      if (result.has(id)) throw Error('INVALID_DOWNLOAD_STATUS');
      const item = { id, state: raw.state, rootPath };
      if (raw.state === 'Completed') {
        item.destination = canonical(raw.destination);
        if (!within(rootPath, item.destination) || !equal(paths.dirname(item.destination), rootPath)
            || typeof raw.folderName !== 'string' || paths.basename(item.destination) !== raw.folderName) {
          throw Error('INVALID_DOWNLOAD_STATUS');
        }
        item.folderName = raw.folderName;
      }
      result.set(id, item);
    }
    return result;
  }
  function observe(value) {
    const epoch = ++observationEpoch;
    const owner = syncContext();
    // A newer notification delivered inside abort/context callbacks wins over
    // this older invocation; never overwrite its baseline with stale items.
    if (epoch !== observationEpoch) return snapshot();
    if (!owner) { notify(); return snapshot(); }
    let next;
    try { next = items(value); }
    catch { fault = 'INVALID_DOWNLOAD_STATUS'; notify(); return snapshot(); }
    fault = null;
    if (observed !== null) for (const item of next.values()) {
      const prior = observed.get(item.id);
      // Unknown Completed IDs are history, including IDs first appearing after
      // the baseline. They never prove an observed completion transition.
      if (item.state !== 'Completed' || !prior || prior.state === 'Completed'
          || !equal(prior.rootPath, item.rootPath) || !equal(item.rootPath, owner.root)
          || owner.completions.has(item.id)) continue;
      if (owner.completions.size >= MAX_COMPLETIONS) { fault = 'OBSERVER_SESSION_LIMIT'; continue; }
      owner.completions.add(item.id);
      const record = { id: item.id, owner, item, resolved: null, state: 'waiting', code: null,
        mayHaveReachedMod: false, confirmed: false, remoteState: 'unknown' };
      const localPending = queue.length + (inFlight ? 1 : 0);
      let sharedPending = localPending;
      try { if (options.pendingCount) sharedPending = options.pendingCount(); } catch { sharedPending = MAX_PENDING; }
      if (localPending >= MAX_PENDING || !Number.isSafeInteger(sharedPending) || sharedPending < 0 || sharedPending >= MAX_PENDING) {
        record.state = 'failed'; record.code = 'OBSERVER_QUEUE_FULL'; ignored = Math.min(Number.MAX_SAFE_INTEGER, ignored + 1);
      } else queue.push(record);
      remember(record);
    }
    observed = next;
    pump(); notify(); return snapshot();
  }
  function stop() {
    contextSuppression++;
    try { replaceRun(null); fault = null; }
    finally { contextSuppression--; }
    notify(); return snapshot();
  }
  function dispose() { disposed = true; replaceRun(null); fault = null; notify(); return snapshot(); }
  return Object.freeze({ observe, update, stop, dispose, snapshot });
}

module.exports = { createQuickImportDownloadObserver, MAX_PENDING, MAX_RECORDS };
