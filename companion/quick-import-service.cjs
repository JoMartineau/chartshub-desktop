'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createQuickImportClient } = require('./quick-import-client.cjs');
const { createQuickImportDownloadObserver } = require('./quick-import-download-observer.cjs');
const { createQuickImportPreferences, validateLocalQuickImportPath } = require('./quick-import-preferences.cjs');

const COMMANDS = new Set(['quickImport.chooseGame', 'quickImport.connect', 'quickImport.disable', 'quickImport.refresh']);
const STATES = new Set(['queued', 'importing', 'ready', 'failed', 'cancelled', 'waiting', 'resolving', 'submitting', 'submitted', 'unconfirmed']);
const CODES = new Set([
  'QUICK_IMPORT_COMMAND', 'QUICK_IMPORT_UNAVAILABLE', 'QUICK_IMPORT_BUSY', 'QUICK_IMPORT_CANCELLED',
  'QUICK_IMPORT_WINDOWS_REQUIRED', 'QUICK_IMPORT_NOT_VALIDATED', 'QUICK_IMPORT_GAME_REQUIRED',
  'QUICK_IMPORT_GAME_INVALID', 'QUICK_IMPORT_SONGS_REQUIRED', 'QUICK_IMPORT_PREFERENCES', 'QUICK_IMPORT_FAILED',
  'CANCELLED', 'DISPOSED', 'NOT_ENABLED', 'CLIENT_QUEUE_FULL', 'CLIENT_BUSY', 'CONNECTION_CHANGED',
  'CONNECTION_UNAVAILABLE', 'TIMEOUT', 'INVALID_COMPLETION', 'OUTSIDE_SONGS_ROOT', 'LINKED_PATH',
  'CHART_CHANGED', 'CHART_MISSING_OR_TOO_LARGE', 'CHART_DIGEST_CHANGED', 'DOWNLOAD_INCOMPLETE',
  'AUDIO_MISSING', 'METADATA_MISSING', 'QUEUE_FULL', 'IMPORT_NOT_VALIDATED', 'UNVERIFIED_BUILD',
  'NATIVE_IMPORT_FAILED', 'NATIVE_IMPORT_NOT_COMPLETE', 'LOCAL_UNAVAILABLE', 'PROTOCOL', 'PROVIDER_REFUSED',
  'INVALID_DESCRIPTOR', 'INVALID_REQUEST', 'UNAUTHORIZED', 'MAIN_THREAD_REQUIRED', 'UNKNOWN_JOB',
  'REQUEST_ID_CONFLICT', 'INVALID_PATH', 'SONGS_ROOT_MISSING', 'CHART_FOLDER_MISSING', 'TOO_MANY_CHART_FILES',
  'OBSERVER_SESSION_LIMIT', 'OBSERVER_QUEUE_FULL', 'INVALID_DOWNLOAD_STATUS',
  'COMPLETION_RESOLUTION_FAILED', 'IMPORT_DELIVERY_FAILED'
]);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const error = code => Object.assign(Error(code), { code });
function safeCode(value, fallback = 'QUICK_IMPORT_FAILED') {
  try { return CODES.has(value?.code) ? value.code : fallback; } catch { return fallback; }
}
function validQuickImportCommand(name, payload) {
  return COMMANDS.has(name) && plain(payload) && Object.keys(payload).length === 0;
}

function createQuickImportService({ dataDirectory, getContext = () => ({ active: false, root: null, lifecycle: 0 }),
  chooseGame = async () => null, onChange = () => {}, expectedBuild = null,
  clientFactory = createQuickImportClient, platform = process.platform, preferences } = {}) {
  if (typeof getContext !== 'function' || typeof chooseGame !== 'function' || typeof onChange !== 'function'
      || typeof clientFactory !== 'function'
      || !(expectedBuild === null || typeof expectedBuild === 'string' && expectedBuild.length > 0
        && expectedBuild.length <= 96 && !/[\x00-\x1f\x7f]/.test(expectedBuild))) throw error('QUICK_IMPORT_FAILED');
  const prefs = preferences ?? createQuickImportPreferences({ dataDirectory });
  const same = (a, b) => a === null || b === null ? a === b
    : platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const supported = platform === 'win32';
  let gameRoot = null, enabled = false, connection = null, busyLease = null;
  let fault = null, loaded = false, loading = null, disposed = false, intent = 0;
  let lastDownloads = { items: [] }, notifying = false, retiredJobs = [];

  function notify() {
    if (disposed || notifying) return;
    notifying = true;
    try { onChange(); } catch { /* UI notifications cannot break a completed download. */ }
    finally { notifying = false; }
  }
  function context() {
    try {
      const value = getContext(), lifecycle = value?.lifecycle;
      if (!plain(value) || value.active !== true
          || !(Number.isSafeInteger(lifecycle) && lifecycle >= 0
            || typeof lifecycle === 'string' && lifecycle.length > 0 && lifecycle.length <= 96
              && !/[\x00-\x1f\x7f]/.test(lifecycle))) return null;
      return { root: value.root === null || value.root === undefined ? null : validateLocalQuickImportPath(value.root), lifecycle };
    } catch { return null; }
  }
  function sameScope(left, right) {
    return left !== null && right !== null && same(left.root, right.root) && left.lifecycle === right.lifecycle;
  }
  function clientStatus(value = connection) {
    try { return value?.client.snapshot() ?? null; } catch { return null; }
  }
  function jobsFor(candidate) {
    const values = new Map(), current = clientStatus(candidate);
    const add = value => {
      if (!plain(value) || !uuid(value.id) || !STATES.has(value.state)) return;
      values.set(value.id.toLowerCase(), {
        id: value.id.toLowerCase(), state: value.state,
        code: typeof value.code === 'string' && CODES.has(value.code) ? value.code : null,
        confirmed: value.confirmed === true,
        deduplicated: value.deduplicated === true,
        waitingForSafeMenu: value.state === 'queued' && value.waitingForSafeMenu === true,
        mayHaveReachedMod: value.mayHaveReachedMod === true || ['queued', 'importing', 'ready'].includes(value.state)
      });
    };
    try {
      for (const observer of [candidate?.observer, candidate?.webObserver]) {
        const local = observer?.snapshot();
        if (Array.isArray(local?.jobs)) for (const value of local.jobs.slice(-64)) add(value);
      }
      if (Array.isArray(current?.jobs)) for (const value of current.jobs.slice(-64)) add(value);
    } catch { /* A malformed injected dependency never enters the public DTO. */ }
    return [...values.values()].slice(-64);
  }
  function jobs() {
    const values = new Map(retiredJobs.map(value => [value.id, value]));
    for (const value of jobsFor(connection)) values.set(value.id, value);
    return [...values.values()].slice(-64).map(value => ({ ...value }));
  }
  function status() {
    let savedCanWrite = false;
    try { savedCanWrite = prefs.status().canWrite === true; } catch {}
    return { supported, selected: gameRoot !== null, gameName: gameRoot !== null ? 'Clone Hero' : null,
      busy: busyLease !== null, connected: enabled && clientStatus()?.phase === 'available', enabled,
      error: fault, jobs: jobs(), savedCanWrite };
  }
  function load() {
    if (disposed) return Promise.resolve(status());
    if (loaded) return Promise.resolve(status());
    if (loading) return loading;
    loading = (async () => {
      try {
        const value = await prefs.load();
        if (!disposed) {
          gameRoot = value.gameRoot === null ? null : validateLocalQuickImportPath(value.gameRoot);
          if (value.canWrite !== true) fault = 'QUICK_IMPORT_PREFERENCES';
        }
      } catch { if (!disposed) fault = 'QUICK_IMPORT_PREFERENCES'; }
      loaded = true; notify(); return status();
    })();
    return loading;
  }
  function disable(clearError = true) {
    intent++; enabled = false;
    const prior = connection;
    connection = null;
    // Abort the client's pending hash/pipe first, then cancel unsent local work.
    try { prior?.client.disable(); } catch {}
    try { prior?.observer.stop(); } catch {}
    try { prior?.webObserver.stop(); } catch {}
    try { prior?.client.dispose(); } catch {}
    if (prior) {
      const values = new Map(retiredJobs.map(value => [value.id, value]));
      for (const value of jobsFor(prior)) values.set(value.id, { ...value, confirmed: false });
      retiredJobs = [...values.values()].slice(-64);
    }
    if (clearError) fault = null;
    notify(); return status();
  }
  function requireActive() {
    const value = context();
    if (disposed || !value) throw error('QUICK_IMPORT_UNAVAILABLE');
    return value;
  }
  function guard(ticket, captured) {
    if (disposed || ticket !== intent || !sameScope(captured, context())) throw error('QUICK_IMPORT_CANCELLED');
  }
  function begin() {
    if (busyLease) throw error('QUICK_IMPORT_BUSY');
    const lease = { ticket: ++intent };
    busyLease = lease; notify(); return lease;
  }
  function finish(lease) { if (busyLease === lease) busyLease = null; notify(); }

  async function noLinks(candidate, directory) {
    const canonical = validateLocalQuickImportPath(candidate);
    let at = canonical;
    for (;;) {
      const stat = await fs.lstat(at);
      if (stat.isSymbolicLink() || (at === canonical ? directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) {
        throw error('LINKED_PATH');
      }
      const next = path.dirname(at);
      if (next === at) break;
      at = next;
    }
    if (!same(await fs.realpath(canonical), canonical)) throw error('LINKED_PATH');
    return canonical;
  }
  async function game(executable) {
    let selected;
    try { selected = validateLocalQuickImportPath(executable); }
    catch { throw error('QUICK_IMPORT_GAME_INVALID'); }
    if (path.basename(selected).toLowerCase() !== 'clone hero.exe') throw error('QUICK_IMPORT_GAME_INVALID');
    try { return path.dirname(await noLinks(selected, false)); }
    catch { throw error('QUICK_IMPORT_GAME_INVALID'); }
  }
  async function resolveCompletion(item, { signal }) {
    const check = () => { if (signal.aborted) throw error('CANCELLED'); };
    check();
    const folder = await noLinks(item.destination, true);
    check();
    const candidates = [];
    // Two fixed names in this new download only; no directory enumeration or
    // library lookup. Ambiguous input is refused instead of choosing silently.
    for (const chartFile of ['notes.chart', 'notes.mid']) {
      try {
        await noLinks(path.join(folder, chartFile), false);
        candidates.push(chartFile);
      } catch (problem) { if (problem.code !== 'ENOENT') throw problem; }
      check();
    }
    if (candidates.length !== 1) throw error(candidates.length ? 'TOO_MANY_CHART_FILES' : 'CHART_MISSING_OR_TOO_LARGE');
    return { id: item.id, folder, chartFile: candidates[0] };
  }
  async function choose() {
    const captured = requireActive();
    if (!supported) throw error('QUICK_IMPORT_WINDOWS_REQUIRED');
    if (prefs.status().canWrite !== true) throw error('QUICK_IMPORT_PREFERENCES');
    if (busyLease) throw error('QUICK_IMPORT_BUSY');
    disable();
    const lease = begin();
    try {
      guard(lease.ticket, captured);
      const executable = await chooseGame(); guard(lease.ticket, captured);
      if (executable === null || executable === undefined) return status();
      const selected = await game(executable); guard(lease.ticket, captured);
      await prefs.save({ version: 1, gameRoot: selected }, () => guard(lease.ticket, captured));
      guard(lease.ticket, captured);
      gameRoot = selected; fault = null; return status();
    } catch (problem) {
      if (lease.ticket === intent && !disposed) fault = safeCode(problem);
      throw error(safeCode(problem));
    } finally { finish(lease); }
  }
  async function connect() {
    const captured = requireActive();
    if (!supported) throw error('QUICK_IMPORT_WINDOWS_REQUIRED');
    if (expectedBuild === null) throw error('QUICK_IMPORT_NOT_VALIDATED');
    if (!gameRoot) throw error('QUICK_IMPORT_GAME_REQUIRED');
    if (!captured.root) throw error('QUICK_IMPORT_SONGS_REQUIRED');
    if (busyLease) throw error('QUICK_IMPORT_BUSY');
    disable();
    const lease = begin(), selected = gameRoot;
    let candidate = null;
    try {
      guard(lease.ticket, captured);
      await game(path.join(selected, 'Clone Hero.exe')); guard(lease.ticket, captured);
      await noLinks(captured.root, true); guard(lease.ticket, captured);
      const client = clientFactory({ gameRoot: selected, songsRoot: captured.root, expectedBuild, platform });
      if (!client || ['enable', 'disable', 'dispose', 'snapshot', 'newCompleted', 'refreshStatus'].some(name => typeof client[name] !== 'function')) throw error('QUICK_IMPORT_FAILED');
      candidate = { client, root: captured.root, lifecycle: captured.lifecycle, gameRoot: selected,
        observer: null, webObserver: null, deliveryTail: Promise.resolve() };
      // The independent Web/Companion histories share one hash/enqueue lane.
      // Neither stream may overlap client.newCompleted with the other stream.
      const deliveryClient = { newCompleted: value => {
        const task = candidate.deliveryTail.then(() => {
          if (disposed || !enabled || connection !== candidate || !sameScope(captured, context())) throw error('CANCELLED');
          return client.newCompleted(value);
        });
        candidate.deliveryTail = task.catch(() => {}); return task;
      } };
      const observerOptions = { client: deliveryClient, resolveCompletion,
        pendingCount: () => (candidate.observer?.snapshot().pending ?? 0) + (candidate.webObserver?.snapshot().pending ?? 0),
        onChange: () => {
        if (connection !== candidate) return;
        for (const observer of [candidate.observer, candidate.webObserver]) {
          const value = observer?.snapshot();
          const failed = value?.jobs?.findLast(item => item.code !== null);
          if (value?.fault && CODES.has(value.fault)) fault = value.fault;
          else if (failed?.code && CODES.has(failed.code)) fault = failed.code;
        }
        notify();
      }, context: () => {
        const current = context();
        return { enabled: !disposed && enabled && connection === candidate && sameScope(captured, current),
          available: clientStatus(candidate)?.phase === 'available', root: captured.root, lifecycle: captured.lifecycle };
      } };
      candidate.observer = createQuickImportDownloadObserver(observerOptions);
      candidate.webObserver = createQuickImportDownloadObserver(observerOptions);
      enabled = true; connection = candidate;
      candidate.observer.observe(lastDownloads);
      await client.enable({ consent: true }); guard(lease.ticket, captured);
      if (connection !== candidate || clientStatus(candidate)?.phase !== 'available') throw error('CONNECTION_UNAVAILABLE');
      candidate.observer.update(); candidate.webObserver.update(); fault = null; return status();
    } catch (problem) {
      const report = lease.ticket === intent;
      if (candidate && connection === candidate) disable(false);
      else if (candidate) {
        try { candidate.client.disable(); } catch {}
        try { candidate.observer?.stop(); candidate.webObserver?.stop(); } catch {}
        try { candidate.client.dispose(); } catch {}
      }
      if (!disposed && report) fault = safeCode(problem);
      throw error(safeCode(problem));
    } finally { finish(lease); }
  }
  async function refresh() {
    const captured = requireActive();
    if (!connection || !enabled) throw error('NOT_ENABLED');
    const candidate = connection, lease = begin();
    try {
      guard(lease.ticket, captured);
      const known = clientStatus(candidate)?.jobs;
      for (const job of (Array.isArray(known) ? known.slice(0, 64) : [])) {
        if (!uuid(job?.id)) continue;
        guard(lease.ticket, captured);
        await candidate.client.refreshStatus(job.id); guard(lease.ticket, captured);
        if (connection !== candidate) throw error('QUICK_IMPORT_CANCELLED');
      }
      candidate.observer.update(); candidate.webObserver.update(); fault = null; return status();
    } catch (problem) {
      if (lease.ticket === intent && !disposed) fault = safeCode(problem);
      throw error(safeCode(problem));
    } finally { finish(lease); }
  }
  function update() {
    if (connection && (!sameScope(connection, context()) || !same(connection.gameRoot, gameRoot))) disable();
    try { connection?.observer.update(); connection?.webObserver.update(); } catch { fault = 'QUICK_IMPORT_FAILED'; }
    return status();
  }
  function observeDownloads(value) {
    if (disposed) return status();
    try {
      if (!plain(value) || !Array.isArray(value.items) || value.items.length > 100) throw error('INVALID_DOWNLOAD_STATUS');
      lastDownloads = { items: value.items.map(item => ({
        id: item.id, state: item.state, rootPath: item.rootPath,
        ...(item.state === 'Completed' ? { destination: item.destination, folderName: item.folderName } : {})
      })) };
      update(); connection?.observer.observe(lastDownloads);
    } catch { fault = 'INVALID_DOWNLOAD_STATUS'; }
    return status();
  }
  // Trusted main only: this method is deliberately absent from command()/IPC.
  // Main emits a fresh UUID only after a successful Web catalogue folder write.
  function observeCompletedDownload(value) {
    const candidate = connection;
    if (disposed || !enabled || !candidate || clientStatus(candidate)?.phase !== 'available') return status();
    if (!sameScope(candidate, context())) { update(); return status(); }
    try {
      if (!plain(value) || Object.keys(value).sort().join(',') !== 'destination,id' || !uuid(value.id)
          || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value.id)) throw error('INVALID_COMPLETION');
      const destination = validateLocalQuickImportPath(value.destination);
      if (same(destination, candidate.root) || !same(path.dirname(destination), candidate.root)) throw error('INVALID_COMPLETION');
      const item = { id: value.id.toLowerCase(), rootPath: candidate.root, state: 'Downloading' };
      candidate.webObserver.observe({ items: [item] });
      if (connection !== candidate || !enabled || !sameScope(candidate, context())) return status();
      candidate.webObserver.observe({ items: [{ ...item, state: 'Completed', destination, folderName: path.basename(destination) }] });
    } catch { fault = 'INVALID_COMPLETION'; }
    return status();
  }
  async function command(name, payload) {
    if (!validQuickImportCommand(name, payload)) throw error('QUICK_IMPORT_COMMAND');
    if (name === 'quickImport.disable') return disable();
    if (disposed) throw error('QUICK_IMPORT_UNAVAILABLE');
    const enteringIntent = intent;
    await load();
    if (disposed || enteringIntent !== intent) throw error('QUICK_IMPORT_CANCELLED');
    const task = name === 'quickImport.chooseGame' ? choose()
      : name === 'quickImport.connect' ? connect() : refresh();
    // Async methods execute their synchronous begin() before returning. Capture
    // that lease, rather than allowing a late rejection to overwrite a disable
    // or the error belonging to a newer command.
    const ownerIntent = intent;
    try {
      return await task;
    } catch (problem) {
      if (!disposed && ownerIntent === intent
          && !['QUICK_IMPORT_CANCELLED', 'QUICK_IMPORT_BUSY'].includes(safeCode(problem))) fault = safeCode(problem);
      notify(); throw error(safeCode(problem));
    }
  }
  function stop() { return disable(); }
  async function dispose() {
    if (disposed) return;
    disposed = true; disable();
    await prefs.flush().catch(() => {});
  }
  return Object.freeze({ load, status, command, observeDownloads, observeCompletedDownload, update, stop, dispose });
}

module.exports = { createQuickImportService, validQuickImportCommand, PUBLIC_QUICK_IMPORT_CODES: Object.freeze([...CODES]) };
