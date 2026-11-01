'use strict';

// Main-process client only. No scanner, game writer, process launcher or renderer
// endpoint is present here. Construction deliberately performs no I/O.
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { constants } = require('node:fs');
const { TextDecoder } = require('node:util');

const MAX_BYTES = 8192;
const MAX_CHART_BYTES = 134217728;
const MAX_JOBS = 64;
const MAX_COMPLETIONS = 128;
const STATES = new Set(['queued', 'importing', 'ready', 'failed', 'cancelled']);
const TERMINAL = new Set(['ready', 'failed', 'cancelled']);
const PROVIDER_CODES = new Set([
  'INVALID_REQUEST', 'UNAUTHORIZED', 'UNKNOWN_COMMAND', 'IMPORT_NOT_VALIDATED',
  'STOPPED', 'QUEUE_FULL', 'UNKNOWN_JOB', 'REQUEST_ID_CONFLICT',
  'INVALID_PATH', 'LINKED_PATH', 'OUTSIDE_SONGS_ROOT', 'SONGS_ROOT_MISSING',
  'CHART_FOLDER_MISSING', 'TOO_MANY_CHART_FILES', 'CHART_CHANGED',
  'DOWNLOAD_INCOMPLETE', 'AUDIO_MISSING', 'METADATA_MISSING',
  'CHART_MISSING_OR_TOO_LARGE', 'CHART_DIGEST_CHANGED',
  'NATIVE_IMPORT_NOT_COMPLETE', 'NATIVE_IMPORT_FAILED', 'MAIN_THREAD_REQUIRED'
]);
const CLIENT_CODES = new Set([
  'PROTOCOL', 'INVALID_CONFIGURATION', 'INVALID_DESCRIPTOR', 'CONNECTION_CHANGED',
  'CONNECTION_UNAVAILABLE', 'CLIENT_BUSY', 'CLIENT_QUEUE_FULL', 'CANCELLED',
  'TIMEOUT', 'DISPOSED', 'NOT_ENABLED', 'EXPLICIT_OPT_IN_REQUIRED',
  'WINDOWS_REQUIRED', 'UNVERIFIED_BUILD', 'INVALID_COMPLETION', 'PROVIDER_REFUSED',
  'LOCAL_UNAVAILABLE'
]);

function fail(code) { const error = new Error(code); error.code = code; return error; }
function ownObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value, names) {
  return ownObject(value) && Object.keys(value).length === names.length
    && names.every(name => Object.hasOwn(value, name));
}
function guid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value);
}
function sameStamp(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

// JSON.parse alone silently accepts duplicate names. Check the bounded grammar
// first, including nested result objects, before using the parsed value.
function parseBounded(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) throw fail('PROTOCOL');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw fail('PROTOCOL'); }
  let at = 0;
  const space = () => { while (/\s/.test(text[at] || '') && at < text.length) at++; };
  function string() {
    if (text[at] !== '"') throw fail('PROTOCOL');
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === '\\') { at++; continue; }
      if (c === '"') {
        try { return JSON.parse(text.slice(start, at)); }
        catch { throw fail('PROTOCOL'); }
      }
      if (c.charCodeAt(0) < 32) throw fail('PROTOCOL');
    }
    throw fail('PROTOCOL');
  }
  function value(depth) {
    if (depth > 4) throw fail('PROTOCOL');
    space();
    if (text[at] === '{') {
      at++; space(); const names = new Set();
      if (text[at] === '}') { at++; return; }
      while (at < text.length) {
        space(); const name = string();
        if (names.has(name)) throw fail('PROTOCOL');
        names.add(name); space();
        if (text[at++] !== ':') throw fail('PROTOCOL');
        value(depth + 1); space(); const end = text[at++];
        if (end === '}') return;
        if (end !== ',') throw fail('PROTOCOL');
      }
    } else if (text[at] === '[') {
      at++; space();
      if (text[at] === ']') { at++; return; }
      while (at < text.length) {
        value(depth + 1); space(); const end = text[at++];
        if (end === ']') return;
        if (end !== ',') throw fail('PROTOCOL');
      }
    } else if (text[at] === '"') { string(); return; }
    else {
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
      if (match) { at += match[0].length; return; }
    }
    throw fail('PROTOCOL');
  }
  value(0); space();
  if (at !== text.length) throw fail('PROTOCOL');
  try { return JSON.parse(text); } catch { throw fail('PROTOCOL'); }
}

function createQuickImportClient(options) {
  if (!ownObject(options)) throw fail('INVALID_CONFIGURATION');
  const platform = options.platform ?? process.platform;
  const paths = options.pathApi ?? (platform === 'win32' ? path.win32 : path);
  const io = options.fs ?? fs;
  const connect = options.connect ?? (pipePath => net.createConnection({ path: pipePath }));
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000
      || typeof options.expectedBuild !== 'string' || !options.expectedBuild.length
      || options.expectedBuild.length > 96 || /[\x00-\x1f\x7f]/.test(options.expectedBuild)) {
    throw fail('INVALID_CONFIGURATION');
  }
  const expectedBuild = options.expectedBuild;
  function canonical(value) {
    if (typeof value !== 'string' || value.length > 230 || !value.trim()
        || /[\x00-\x1f\x7f]/.test(value) || !paths.isAbsolute(value)
        || /^(?:\\\\|\/\/)/.test(value)) throw fail('INVALID_PATH');
    // Reject Windows alternate streams, device paths and Win32 trailing-dot/space
    // aliases. The drive colon itself is allowed.
    if (paths === path.win32) {
      if (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':')
          || value.split(/[\\/]/).slice(1).some(part => /[. ]$/.test(part))) throw fail('INVALID_PATH');
    }
    return paths.resolve(value);
  }
  const gameRoot = canonical(options.gameRoot);
  const songsRoot = canonical(options.songsRoot);
  const descriptorPath = paths.join(gameRoot, 'UserData', 'ChartsHubQuickImport', 'connection.json');
  const equalPath = (a, b) => platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  function inside(folder) {
    const relative = paths.relative(songsRoot, folder);
    return relative !== '' && relative !== '..' && !relative.startsWith('..' + paths.sep)
      && !paths.isAbsolute(relative);
  }
  let generation = 0, active = null, disposed = false, phase = 'disabled', fault = null, build = null;
  const jobs = new Map(), jobOwners = new Map(), completions = new Map();
  function current(run) {
    if (disposed || active !== run || !run || run.generation !== generation) throw fail('CANCELLED');
  }
  function requireReady() {
    if (disposed) throw fail('DISPOSED');
    if (!active?.ready || phase !== 'available') throw fail('NOT_ENABLED');
    return active;
  }
  function retire(run, nextPhase, code) {
    if (active !== run) return;
    active = null; generation++; phase = nextPhase; fault = code; build = null;
    run.ready = false; run.descriptor = null;
    for (const abort of [...run.aborters]) abort();
    for (const job of jobs.values()) job.confirmed = false;
  }
  async function noLinks(file, run) {
    for (let cursor = file; ; cursor = paths.dirname(cursor)) {
      current(run);
      const stat = await io.lstat(cursor); current(run);
      if (stat.isSymbolicLink()) throw fail('LINKED_PATH');
      const parent = paths.dirname(cursor);
      if (parent === cursor) break;
    }
    const real = await io.realpath(file); current(run);
    if (!equalPath(real, file)) throw fail('LINKED_PATH');
  }
  async function smallFile(file, run) {
    await noLinks(file, run);
    const before = await io.lstat(file); current(run);
    if (!before.isFile() || before.size < 1 || before.size > MAX_BYTES) throw fail('INVALID_DESCRIPTOR');
    const handle = await io.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      current(run); const opened = await handle.stat(); current(run);
      if (!sameStamp(before, opened)) throw fail('CONNECTION_CHANGED');
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); current(run);
      const after = await handle.stat(); current(run);
      if (!sameStamp(opened, after) || bytesRead !== opened.size) throw fail('CONNECTION_CHANGED');
      await noLinks(file, run);
      const final = await io.lstat(file); current(run);
      if (!sameStamp(opened, final)) throw fail('CONNECTION_CHANGED');
      return bytes.subarray(0, bytesRead);
    } finally { await handle.close(); }
  }
  async function descriptor(run) {
    const raw = parseBounded(await smallFile(descriptorPath, run));
    if (!exact(raw, ['schema', 'provider', 'version', 'pid', 'pipeName', 'token', 'importValidated', 'fullScanFallback'])
        || raw.schema !== 1 || raw.provider !== 'chartshub.quick-import'
        || typeof raw.version !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(raw.version)
        || !Number.isInteger(raw.pid) || raw.pid < 1 || raw.pid > 2147483647
        || typeof raw.pipeName !== 'string' || !/^ChartsHub\.QuickImport\.v1\.[0-9a-f]{32}$/.test(raw.pipeName)
        || typeof raw.token !== 'string' || !/^[0-9a-f]{64}$/.test(raw.token)
        || raw.fullScanFallback !== false || typeof raw.importValidated !== 'boolean') throw fail('INVALID_DESCRIPTOR');
    if (!raw.importValidated) throw fail('IMPORT_NOT_VALIDATED');
    return raw;
  }
  async function fresh(run) {
    let next;
    try { next = await descriptor(run); }
    catch (error) {
      if (['CANCELLED', 'IMPORT_NOT_VALIDATED'].includes(error?.code)) throw error;
      throw fail('CONNECTION_CHANGED');
    }
    current(run);
    const old = run.descriptor;
    if (!old || Object.keys(old).some(key => old[key] !== next[key])) throw fail('CONNECTION_CHANGED');
  }
  function response(bytes) {
    const value = parseBounded(bytes);
    if (!ownObject(value) || value.schema !== 1 || typeof value.ok !== 'boolean') throw fail('PROTOCOL');
    if (!value.ok) {
      if (!exact(value, ['schema', 'ok', 'code'])) throw fail('PROTOCOL');
      throw fail(PROVIDER_CODES.has(value.code) ? value.code : 'PROVIDER_REFUSED');
    }
    if (!exact(value, ['schema', 'ok', 'result']) || !ownObject(value.result)) throw fail('PROTOCOL');
    return value.result;
  }
  function exchangeNow(run, command, fields, remainingMs) {
    current(run);
    const bytes = Buffer.from(JSON.stringify({ schema: 1, token: run.descriptor.token, command, ...fields }) + '\n');
    if (bytes.length - 1 > MAX_BYTES) return Promise.reject(fail('PROTOCOL'));
    return new Promise((resolve, reject) => {
      let socket, settled = false, incoming = Buffer.alloc(0);
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); run.aborters.delete(abort);
        // Keep an error listener until the closed socket is collected. No late
        // data or errors can change state after the lease has ended.
        socket?.removeAllListeners('data'); socket?.removeAllListeners('connect');
        socket?.destroy(); error ? reject(error) : resolve(value);
      };
      const abort = () => finish(fail('CANCELLED'));
      const timer = setTimeout(() => finish(fail('TIMEOUT')), remainingMs);
      run.aborters.add(abort);
      try {
        socket = connect('\\\\.\\pipe\\' + run.descriptor.pipeName);
        socket.on('error', () => finish(fail('CONNECTION_UNAVAILABLE')));
        socket.on('close', () => finish(fail('CONNECTION_UNAVAILABLE')));
        socket.on('end', () => finish(fail('PROTOCOL')));
        socket.on('connect', () => {
          try { current(run); socket.write(bytes); }
          catch { finish(fail('CANCELLED')); }
        });
        socket.on('data', chunk => {
          if (settled) return;
          try {
            current(run);
            if (!Buffer.isBuffer(chunk) || incoming.length + chunk.length > MAX_BYTES + 1) throw fail('PROTOCOL');
            incoming = Buffer.concat([incoming, chunk]);
            const newline = incoming.indexOf(10);
            if (newline === -1) return;
            if (newline !== incoming.length - 1 || newline > MAX_BYTES) throw fail('PROTOCOL');
            finish(null, response(incoming.subarray(0, newline)));
          } catch (error) { finish(error); }
        });
      } catch { finish(fail('CONNECTION_UNAVAILABLE')); }
    });
  }
  // LocalPipeHost permits one current-user connection at a time. Serialize its
  // bounded requests rather than dropping a fifth concurrent completed download.
  function pumpExchange(run) {
    if (active !== run || run.exchanging || !run.exchanges.length) return;
    const next = run.exchanges.shift();
    run.aborters.delete(next.abort); clearTimeout(next.timer);
    const remainingMs = next.deadline - Date.now();
    if (remainingMs <= 0) { next.reject(fail('TIMEOUT')); pumpExchange(run); return; }
    run.exchanging = true;
    let operation;
    try { operation = exchangeNow(run, next.command, next.fields, remainingMs); }
    catch (error) { operation = Promise.reject(error); }
    operation.then(next.resolve, next.reject).finally(() => {
      run.exchanging = false;
      pumpExchange(run);
    });
  }
  function exchange(run, command, fields = {}) {
    current(run);
    if (run.exchanges.length >= 32) return Promise.reject(fail('CLIENT_BUSY'));
    return new Promise((resolve, reject) => {
      const queued = { command, fields: { ...fields }, resolve, reject, deadline: Date.now() + timeoutMs };
      queued.abort = () => {
        const index = run.exchanges.indexOf(queued);
        if (index < 0) return;
        run.exchanges.splice(index, 1); clearTimeout(queued.timer);
        run.aborters.delete(queued.abort); reject(fail('CANCELLED'));
      };
      queued.timer = setTimeout(() => {
        const index = run.exchanges.indexOf(queued);
        if (index < 0) return;
        run.exchanges.splice(index, 1); run.aborters.delete(queued.abort);
        reject(fail('TIMEOUT'));
      }, timeoutMs);
      run.exchanges.push(queued); run.aborters.add(queued.abort);
      pumpExchange(run);
    });
  }
  async function hashChart(folder, chartFile, run) {
    if (!inside(folder)) throw fail('OUTSIDE_SONGS_ROOT');
    await noLinks(folder, run);
    const directory = await io.lstat(folder); current(run);
    if (!directory.isDirectory()) throw fail('CHART_FOLDER_MISSING');
    const file = paths.join(folder, chartFile);
    await noLinks(file, run);
    const before = await io.lstat(file); current(run);
    if (!before.isFile() || before.size < 1 || before.size > MAX_CHART_BYTES) throw fail('CHART_MISSING_OR_TOO_LARGE');
    const handle = await io.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      current(run); const opened = await handle.stat(); current(run);
      if (!sameStamp(before, opened)) throw fail('CHART_CHANGED');
      const digest = crypto.createHash('sha256'), bytes = Buffer.alloc(65536);
      let total = 0;
      while (total < opened.size) {
        const { bytesRead } = await handle.read(bytes, 0, Math.min(bytes.length, opened.size - total), total);
        current(run);
        if (!bytesRead) throw fail('CHART_CHANGED');
        digest.update(bytes.subarray(0, bytesRead)); total += bytesRead;
      }
      const after = await handle.stat(); current(run);
      if (!sameStamp(opened, after)) throw fail('CHART_CHANGED');
      await noLinks(file, run);
      const final = await io.lstat(file); current(run);
      if (!sameStamp(opened, final)) throw fail('CHART_CHANGED');
      return digest.digest('hex');
    } finally { await handle.close(); }
  }
  function jobResult(raw, requestedId, allowDeduplicatedId) {
    if (!exact(raw, ['Id', 'State', 'Code', 'Deduplicated']) || !guid(raw.Id)
        || !STATES.has(raw.State) || typeof raw.Deduplicated !== 'boolean'
        || (raw.Code !== null && !PROVIDER_CODES.has(raw.Code))
        || (raw.Id.toLowerCase() !== requestedId && !(allowDeduplicatedId && raw.Deduplicated))) throw fail('PROTOCOL');
    if (raw.State === 'failed' && raw.Code === null) throw fail('PROTOCOL');
    if (['queued', 'importing', 'ready'].includes(raw.State) && raw.Code !== null) throw fail('PROTOCOL');
    return { id: raw.Id.toLowerCase(), state: raw.State, code: raw.Code,
      deduplicated: raw.Deduplicated, confirmed: true, waitingForSafeMenu: raw.State === 'queued' };
  }
  function storeJob(job, run) {
    if (!jobs.has(job.id) && jobs.size >= MAX_JOBS) {
      const old = [...jobs].find(([id, value]) => jobOwners.get(id) !== run && !value.confirmed)
        ?? [...jobs].find(([, value]) => TERMINAL.has(value.state));
      if (!old) throw fail('CLIENT_QUEUE_FULL');
      jobs.delete(old[0]); jobOwners.delete(old[0]);
    }
    jobs.set(job.id, job); jobOwners.set(job.id, run);
    return { ...job };
  }
  function publicFailure(run, error) {
    const candidate = error?.code;
    const code = (CLIENT_CODES.has(candidate) || PROVIDER_CODES.has(candidate)) && error.message === candidate
      ? candidate : 'LOCAL_UNAVAILABLE';
    if (['PROTOCOL', 'TIMEOUT', 'CONNECTION_UNAVAILABLE', 'CONNECTION_CHANGED',
      'IMPORT_NOT_VALIDATED', 'INVALID_DESCRIPTOR', 'UNAUTHORIZED'].includes(code)) retire(run, 'unavailable', code);
    // Raw filesystem, socket and provider messages never cross this boundary.
    return fail(code);
  }
  async function enable(consent) {
    if (disposed) throw fail('DISPOSED');
    if (!exact(consent, ['consent']) || consent.consent !== true) throw fail('EXPLICIT_OPT_IN_REQUIRED');
    if (platform !== 'win32') throw fail('WINDOWS_REQUIRED');
    if (active?.ready) return snapshot();
    if (active?.opening) return active.opening;
    const run = { generation: ++generation, ready: false, descriptor: null, aborters: new Set(),
      exchanges: [], exchanging: false };
    active = run; phase = 'connecting'; fault = null; build = null;
    run.opening = (async () => {
      try {
        await noLinks(gameRoot, run); await noLinks(songsRoot, run);
        const gameStat = await io.lstat(gameRoot); current(run);
        const songsStat = await io.lstat(songsRoot); current(run);
        if (!gameStat.isDirectory() || !songsStat.isDirectory()) throw fail('INVALID_PATH');
        run.descriptor = await descriptor(run);
        const hello = await exchange(run, 'hello'); current(run);
        if (!exact(hello, ['schema', 'importValidated', 'build', 'phase', 'fullScanFallback'])
            || hello.schema !== 1 || hello.importValidated !== true || hello.fullScanFallback !== false
            || hello.phase !== 'available' || hello.build !== expectedBuild) throw fail('UNVERIFIED_BUILD');
        await fresh(run);
        run.ready = true; phase = 'available'; build = expectedBuild; fault = null;
        return snapshot();
      } catch (error) {
        const safe = publicFailure(run, error);
        if (active === run) retire(run, 'unavailable', safe.code);
        throw safe;
      }
    })();
    return run.opening;
  }
  function disable() {
    if (active) retire(active, 'disabled', null);
    else { generation++; phase = 'disabled'; fault = null; build = null; }
    return snapshot();
  }
  async function newCompleted(raw) {
    const run = requireReady();
    if (!exact(raw, ['id', 'folder', 'chartFile']) || !guid(raw.id)
        || !['notes.chart', 'notes.mid'].includes(raw.chartFile)) throw fail('INVALID_COMPLETION');
    const id = raw.id.toLowerCase(), folder = canonical(raw.folder), chartFile = raw.chartFile;
    const identity = (platform === 'win32' ? folder.toLowerCase() : folder) + '\n' + chartFile;
    if (!inside(folder)) throw fail('OUTSIDE_SONGS_ROOT');
    const prior = completions.get(id);
    if (prior) {
      if (prior.identity !== identity) throw fail('REQUEST_ID_CONFLICT');
      return prior.promise.then(result => {
        const latest = jobs.get(result.id);
        return latest ? { ...latest } : { ...result, confirmed: false };
      });
    }
    const outstanding = [...jobs.values()].filter(job => jobOwners.get(job.id) === run && !TERMINAL.has(job.state)).length
      + [...completions.values()].filter(record => record.owner === run && record.pending).length;
    if (outstanding >= 32) throw fail('CLIENT_QUEUE_FULL');
    if (completions.size >= MAX_COMPLETIONS) {
      const finished = [...completions].find(([, value]) => !value.pending);
      if (!finished) throw fail('CLIENT_QUEUE_FULL');
      completions.delete(finished[0]);
    }
    const record = { identity, promise: null, pending: true, owner: run };
    // Register before the first await: duplicate completion events never hash or
    // enqueue concurrently. Disable/re-enable never replays completed history.
    record.promise = (async () => {
      try {
        await fresh(run);
        const chartSha256 = await hashChart(folder, chartFile, run);
        await fresh(run); current(run);
        const result = await exchange(run, 'enqueue', { id, folder, chartFile, chartSha256 });
        current(run); return storeJob(jobResult(result, id, true), run);
      } catch (error) { throw publicFailure(run, error); }
      finally { record.pending = false; }
    })();
    completions.set(id, record);
    return record.promise;
  }
  async function refreshStatus(id) {
    const run = requireReady();
    if (!guid(id) || !jobs.has(id.toLowerCase())) throw fail('UNKNOWN_JOB');
    id = id.toLowerCase();
    try {
      await fresh(run);
      const result = await exchange(run, 'status', { id }); current(run);
      return storeJob(jobResult(result, id, false), run);
    } catch (error) {
      const known = jobs.get(id);
      if (known && jobOwners.get(id) === run) known.confirmed = false;
      throw publicFailure(run, error);
    }
  }
  function snapshot() {
    return { schema: 1, phase, enabled: Boolean(active?.ready), build,
      fault, gamePhase: 'unknown', fullScanFallback: false,
      jobs: [...jobs.values()].map(job => ({ ...job })) };
  }
  function dispose() { disable(); disposed = true; }
  return Object.freeze({ enable, disable, dispose, newCompleted, refreshStatus, snapshot });
}

module.exports = { createQuickImportClient, parseBounded, MAX_BYTES };
