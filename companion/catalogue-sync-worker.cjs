'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ORIGIN, DOWNLOAD_FILE_HEADERS, safePart, validateManifest, validateDestination, songFolderName } = require('../download.js');
const { rootContext, readJsonFile, writeNew, statOrNull, identity } = require('./download-worker.cjs');

const ENDPOINT = /^\/api\/charts\/[a-f0-9-]{36}\/[A-Za-z0-9_-]{10,200}\/download-manifest$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const EXACT_IDENTITY = /^u64:(?:0|[1-9][0-9]*):(?:0|[1-9][0-9]*)$/;
const VIDEO = /^(?:video|background)\.(?:mp4|webm|avi|vp8|ogv|mpeg|mpg|mov|m4v|mkv)$/i;
const OWNER = 'ChartsHub catalogue synchronization v1';
const MARKER = '.chartshub-companion-installing';
const STAMP = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink'];
const BUFFER_BYTES = 256 * 1024;
// At most1000 files, six180-unit names each, may appear in the staged map and
// both previous/next receipts. Keep the full journal bounded while allowing
// that valid worst case to survive a restart.
const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const running = new Set();
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const keyOf = parts => parts.join('/').normalize('NFC').toLowerCase();
const fileKey = file => digest(JSON.stringify(file.parts));
const safeFolder = value => safePart(value) && !value.startsWith('.');
const safeFolderPath = value => typeof value === 'string' && value.length <= 32700 && !path.isAbsolute(value)
  && value.split('/').length <= 32 && value.split('/').every(safeFolder);
const validParts = parts => Array.isArray(parts) && parts.length > 0 && parts.length <= 6 && parts.every(part => safePart(part) && part.toLowerCase() !== MARKER);
const safeSize = value => Number.isSafeInteger(value) && value >= 0 && value <= 2147483644;
function fail(code = 'SYNC_IO') { return Object.assign(Error(code), { code }); }
function abort(signal) { if (signal?.aborted) throw Object.assign(Error('Synchronization paused.'), { name: 'AbortError', code: 'ABORT_ERR' }); }
function stamp(stat) { return Object.fromEntries(STAMP.map(key => [key, String(stat[key])])); }
function sameStamp(left, right) { return STAMP.every(key => left?.[key] === right?.[key]); }
function validStamp(value, size) {
  return plain(value) && Object.keys(value).length === STAMP.length && STAMP.every(key => typeof value[key] === 'string' && /^-?(?:0|[1-9][0-9]*)$/.test(value[key]) && value[key].length <= 30)
    && value.size === String(size) && value.nlink === '1' && !['dev', 'ino', 'mode'].some(key => value[key].startsWith('-'));
}

/** Provenance belongs to one exact root and folder. A title match never authorizes writes. */
function validateSyncRecord(value) {
  if (!plain(value) || value.version !== 1 || !ENDPOINT.test(value.endpoint) || !safeFolderPath(value.folderName) || !EXACT_IDENTITY.test(value.folderIdentity)
      || !EXACT_IDENTITY.test(value.rootIdentity) || !HASH.test(value.revision) || typeof value.includeVideo !== 'boolean' || !Array.isArray(value.files) || !value.files.length || value.files.length > 1000) throw fail('SYNC_INVALID');
  const parents = value.parentIdentities ?? [];
  if (!Array.isArray(parents) || parents.length !== value.folderName.split('/').length - 1 || parents.some(parent => !EXACT_IDENTITY.test(parent))) throw fail('SYNC_INVALID');
  const keys = new Set(); let bytes = 0;
  const files = value.files.map(file => {
    if (!plain(file) || !validParts(file.parts) || !safeSize(file.size) || !HASH.test(file.sha256) || !(file.remoteSignature === null || HASH.test(file.remoteSignature))
        || !validStamp(file.stamp, file.size) || keys.has(keyOf(file.parts))) throw fail('SYNC_INVALID');
    keys.add(keyOf(file.parts)); bytes += file.size;
    return { parts: [...file.parts], size: file.size, sha256: file.sha256, remoteSignature: file.remoteSignature, stamp: { ...file.stamp } };
  });
  if (bytes > 4000000000) throw fail('SYNC_INVALID');
  for (const key of keys) { const parts = key.split('/'); while (parts.length > 1) { parts.pop(); if (keys.has(parts.join('/'))) throw fail('SYNC_INVALID'); } }
  return { version: 1, endpoint: value.endpoint, folderName: value.folderName, folderIdentity: value.folderIdentity, rootIdentity: value.rootIdentity,
    revision: value.revision, includeVideo: value.includeVideo, files, ...(parents.length ? { parentIdentities: [...parents] } : {}) };
}

/** Nested library folders must retain every parent identity throughout promotion.
 * No parent is created here, and a junction or replaced parent is never followed. */
async function folderParentContext(context, folderName, expected) {
  if (!safeFolderPath(folderName)) throw fail('SYNC_INVALID');
  const parents = folderName.split('/').slice(0, -1), identities = [];
  if (expected !== undefined && (!Array.isArray(expected) || expected.length !== parents.length)) throw fail('SYNC_CONFLICT');
  let directory = context.root;
  for (let index = 0; index < parents.length; index++) {
    directory = path.join(directory, parents[index]);
    const exact = identity(await context.checked(directory, { directory: true }));
    if (expected && exact !== expected[index]) throw fail('SYNC_CONFLICT');
    identities.push(exact);
  }
  const guard = async () => {
    await context.guard(); let current = context.root;
    for (let index = 0; index < parents.length; index++) {
      current = path.join(current, parents[index]);
      if (identity(await context.checked(current, { directory: true })) !== identities[index]) throw fail('SYNC_CONFLICT');
    }
  };
  await guard(); return { identities, guard };
}

function remoteSignature(file) {
  if (HASH.test(file.sha256 || '')) return digest(JSON.stringify(['sha256', file.parts, file.size, file.sha256]));
  if (HASH.test(file.revision || '')) return digest(JSON.stringify(['inventory-revision', file.parts, file.size, file.revision]));
  if (typeof file.version === 'string' && /^[0-9]{1,30}$/.test(file.version) && typeof file.modifiedTime === 'string'
      && file.modifiedTime.length < 50 && Number.isFinite(Date.parse(file.modifiedTime))) {
    return digest(JSON.stringify(['source-version', file.parts, file.size, file.url, file.version, file.modifiedTime]));
  }
  return null;
}

function identicalRemoteFiles(remote, record) {
  if (remote.files.length !== record.files.length) return false;
  const previous = new Map(record.files.map(file => [keyOf(file.parts), file]));
  return remote.files.every(file => {
    const local = previous.get(keyOf(file.parts)), signature = remoteSignature(file);
    return local && JSON.stringify(local.parts) === JSON.stringify(file.parts) && local.size === file.size
      && (HASH.test(file.sha256 || '') && file.sha256 === local.sha256 || signature !== null && signature === local.remoteSignature);
  });
}

async function fileStat(context, target) {
  const checked = await context.checked(target), current = await fs.lstat(target, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || identity(current) !== identity(checked) || current.size > BigInt(Number.MAX_SAFE_INTEGER)) throw fail('SYNC_CONFLICT');
  return current;
}

async function hashFile(context, target, expectedSize, signal) {
  abort(signal); const before = await fileStat(context, target);
  if (before.size !== BigInt(expectedSize)) throw fail('SYNC_CONFLICT');
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (!sameStamp(stamp(before), stamp(await handle.stat({ bigint: true })))) throw fail('SYNC_CONFLICT');
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(BUFFER_BYTES); let total = 0;
    for (;;) {
      abort(signal); const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break; total += bytesRead; if (total > expectedSize) throw fail('SYNC_CONFLICT'); hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await fileStat(context, target);
    if (total !== expectedSize || !sameStamp(stamp(before), stamp(after)) || !sameStamp(stamp(before), stamp(await handle.stat({ bigint: true })))) throw fail('SYNC_CONFLICT');
    return { sha256: hash.digest('hex'), stamp: stamp(after) };
  } finally { await handle.close(); }
}

/** This walks only the selected chart folder, never the Songs tree. */
async function folderInventory(context, directory, expectedFiles, signal, { marker = false, allowMissing = false } = {}) {
  const expected = new Set(expectedFiles.map(file => keyOf(file.parts))), expectedDirectories = new Set();
  for (const file of expectedFiles) for (let length = 1; length < file.parts.length; length++) expectedDirectories.add(keyOf(file.parts.slice(0, length)));
  const found = new Map(); let directories = 0;
  async function walk(current, parts = []) {
    abort(signal); await context.checked(current, { directory: true });
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      abort(signal);
      if (marker && !parts.length && entry.name === MARKER) continue;
      if (!safePart(entry.name) || entry.isSymbolicLink()) throw fail('SYNC_CONFLICT');
      const names = [...parts, entry.name], key = keyOf(names), target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (++directories > 6000 || names.length >= 6 || !expectedDirectories.has(key)) throw fail('SYNC_CONFLICT');
        await walk(target, names);
      } else {
        if (!expected.has(key) || found.has(key)) throw fail('SYNC_CONFLICT');
        found.set(key, { parts: names, stamp: stamp(await fileStat(context, target)) });
      }
    }
  }
  await walk(directory);
  if (!allowMissing && found.size !== expected.size) throw fail('SYNC_CONFLICT');
  // Compare spelling too: a case-folded match must not open another OS path.
  for (const file of expectedFiles) if ((!allowMissing || found.has(keyOf(file.parts))) && JSON.stringify(found.get(keyOf(file.parts))?.parts) !== JSON.stringify(file.parts)) throw fail('SYNC_CONFLICT');
  return found;
}

async function checkLocal(context, record, signal, full = false) {
  if (record.rootIdentity !== context.rootIdentity) throw fail('SYNC_CONFLICT');
  const parents = await folderParentContext(context, record.folderName, record.parentIdentities ?? []);
  const directory = path.join(context.root, record.folderName), info = await statOrNull(directory);
  if (!info) return null;
  if (identity(await context.checked(directory, { directory: true })) !== record.folderIdentity) throw fail('SYNC_CONFLICT');
  const inventory = await folderInventory(context, directory, record.files, signal), files = [];
  for (const file of record.files) {
    const current = inventory.get(keyOf(file.parts));
    if (current.stamp.size !== String(file.size)) throw fail('SYNC_CONFLICT');
    if (full || !sameStamp(file.stamp, current.stamp)) {
      const checked = await hashFile(context, path.join(directory, ...file.parts), file.size, signal);
      if (checked.sha256 !== file.sha256) throw fail('SYNC_CONFLICT');
      files.push({ ...file, stamp: checked.stamp });
    } else files.push(file);
  }
  await parents.guard(); return { directory, record: { ...record, files } };
}

function createCatalogueSyncWorker({ fetcher = globalThis.fetch, manifestTimeoutMs = 30000, idleTimeoutMs = 60000, headerTimeoutMs = 1800000 } = {}) {
  if (typeof fetcher !== 'function' || ![manifestTimeoutMs, idleTimeoutMs, headerTimeoutMs].every(value => Number.isInteger(value) && value > 0 && value <= 1800000)) throw fail('SYNC_INVALID');

  async function request(endpoint, { signal, size, consume } = {}) {
    abort(signal); const controller = new AbortController(); let timeout = false, timer, reader, response, closed = false;
    let interrupt;
    const interrupted = new Promise((_, reject) => { interrupt = () => reject(timeout ? fail('SYNC_TIMEOUT') : Object.assign(Error('Paused'), { name: 'AbortError', code: 'ABORT_ERR' })); });
    interrupted.catch(() => {}); controller.signal.addEventListener('abort', interrupt, { once: true });
    const relay = () => controller.abort(), wait = promise => Promise.race([promise, interrupted]);
    signal?.addEventListener('abort', relay, { once: true });
    const touch = delay => { clearTimeout(timer); timer = setTimeout(() => { timeout = true; controller.abort(); }, delay); };
    try {
      touch(size === undefined ? manifestTimeoutMs : headerTimeoutMs);
      const url = ORIGIN + endpoint;
      const pending = Promise.resolve().then(() => fetcher(url, { method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
        headers: size === undefined ? { Accept: 'application/json' } : { Accept: 'application/octet-stream', ...DOWNLOAD_FILE_HEADERS } }));
      void pending.then(value => { if (closed && value?.body) void value.body.cancel().catch(() => {}); }, () => {});
      try { response = await wait(pending); } catch (error) { if (controller.signal.aborted) throw error; throw fail('SYNC_NETWORK'); }
      if (!response || response.status !== 200 || response.redirected || response.url && response.url !== url) throw fail(response?.status === 429 ? 'SYNC_RATE_LIMITED' : 'SYNC_HTTP');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || (size === undefined ? Number(length) > 2000000 : Number(length) !== size))) throw fail('SYNC_INTEGRITY');
      if (size === undefined && (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw fail('SYNC_INVALID');
      if (!response.body || typeof response.body.getReader !== 'function') throw fail('SYNC_HTTP');
      reader = response.body.getReader(); touch(idleTimeoutMs); const chunks = []; let total = 0;
      for (;;) {
        let next;
        try { next = await wait(reader.read()); } catch (error) { if (controller.signal.aborted) throw error; throw fail('SYNC_NETWORK'); }
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) throw fail('SYNC_INVALID');
        total += next.value.byteLength;
        if (total > (size ?? 2000000)) throw fail('SYNC_INTEGRITY');
        touch(idleTimeoutMs);
        if (consume) await consume(next.value, total); else chunks.push(Buffer.from(next.value));
        abort(signal);
      }
      if (size !== undefined) { if (total !== size) throw fail('SYNC_INTEGRITY'); return; }
      try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')); } catch { throw fail('SYNC_INVALID'); }
    } finally {
      closed = true; clearTimeout(timer); signal?.removeEventListener('abort', relay); controller.signal.removeEventListener('abort', interrupt); controller.abort();
      if (reader) void reader.cancel().catch(() => {}); else if (response?.body) void response.body.cancel().catch(() => {});
    }
  }

  async function manifest(endpoint, includeVideo, signal) {
    if (!ENDPOINT.test(endpoint) || typeof includeVideo !== 'boolean') throw fail('SYNC_INVALID');
    const raw = await request(endpoint, { signal });
    try { validateManifest(raw, endpoint); } catch { throw fail('SYNC_INVALID'); }
    const files = raw.files.filter(file => includeVideo || !VIDEO.test(file.parts.at(-1))).map(file => ({ parts: [...file.parts], size: file.size, url: file.url,
      ...(file.sha256 ? { sha256: file.sha256 } : {}), ...(HASH.test(file.revision || '') ? { revision: file.revision } : {}), ...(typeof file.version === 'string' ? { version: file.version } : {}), ...(typeof file.modifiedTime === 'string' ? { modifiedTime: file.modifiedTime } : {}) }));
    if (!files.length || new Set(files.map(file => keyOf(file.parts))).size !== files.length || files.some(file => !validParts(file.parts))) throw fail('SYNC_INVALID');
    const folderName = songFolderName(raw);
    if (!safeFolder(folderName)) throw fail('SYNC_INVALID');
    const revision = HASH.test(raw.contentRevision || '') ? raw.contentRevision : digest(JSON.stringify([includeVideo, files.map(file => [file.parts, file.size, remoteSignature(file)]).sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0])))]));
    return { folderName, files, revision, totalBytes: files.reduce((sum, file) => sum + file.size, 0), reliable: files.every(file => remoteSignature(file) !== null) };
  }

  function recordFor(context, endpoint, includeVideo, remote, folderName, folderIdentity, files, parentIdentities = []) {
    return validateSyncRecord({ version: 1, endpoint, folderName, folderIdentity, rootIdentity: context.rootIdentity, revision: remote.revision, includeVideo, files,
      ...(parentIdentities.length ? { parentIdentities } : {}) });
  }

  async function inspectLoaded(context, endpoint, record, includeVideo, remote, signal, candidateFolder) {
    const result = { revision: remote.revision, totalBytes: remote.totalBytes, files: remote.files.length };
    try {
      if (record) {
        const clean = validateSyncRecord(record);
        if (clean.endpoint !== endpoint) throw fail('SYNC_CONFLICT');
        const local = await checkLocal(context, clean, signal);
        if (!local) return { ...result, state: 'new', reason: 'LOCAL_MISSING', record: null };
        if (remote.reliable && clean.revision === remote.revision && clean.includeVideo === includeVideo) return { ...result, state: 'unchanged', reason: 'IDENTICAL', record: local.record };
        if (identicalRemoteFiles(remote, local.record)) {
          const byPath = new Map(remote.files.map(file => [keyOf(file.parts), file]));
          return { ...result, state: 'unchanged', reason: 'IDENTICAL', record: { ...local.record, revision: remote.revision, includeVideo,
            files: local.record.files.map(file => ({ ...file, remoteSignature: remoteSignature(byPath.get(keyOf(file.parts))) })) } };
        }
        return { ...result, state: 'update', reason: remote.reliable ? 'SOURCE_CHANGED' : 'SOURCE_RECHECK_REQUIRED', record: local.record };
      }
      if (candidateFolder !== undefined && !safeFolderPath(candidateFolder)) throw fail('SYNC_INVALID');
      const folderName = candidateFolder ?? remote.folderName, directory = path.join(context.root, folderName);
      const parents = await folderParentContext(context, folderName);
      if (!await statOrNull(directory)) return { ...result, state: 'new', reason: 'NOT_INSTALLED', record: null };
      if (!remote.files.every(file => HASH.test(file.sha256 || ''))) return { ...result, state: 'conflict', reason: 'UNTRACKED_FOLDER' };
      const folderIdentity = identity(await context.checked(directory, { directory: true }));
      await folderInventory(context, directory, remote.files, signal);
      const files = [];
      for (const file of remote.files) {
        const checked = await hashFile(context, path.join(directory, ...file.parts), file.size, signal);
        if (checked.sha256 !== file.sha256) throw fail('SYNC_CONFLICT');
        files.push({ parts: file.parts, size: file.size, sha256: checked.sha256, remoteSignature: remoteSignature(file), stamp: checked.stamp });
      }
      if (identity(await context.checked(directory, { directory: true })) !== folderIdentity) throw fail('SYNC_CONFLICT');
      await parents.guard();
      return { ...result, state: 'unchanged', reason: 'ADOPTED_IDENTICAL', record: recordFor(context, endpoint, includeVideo, remote, folderName, folderIdentity, files, parents.identities) };
    } catch (error) {
      abort(signal);
      if (['SYNC_CONFLICT', 'DOWNLOAD_PATH', 'ENOENT', 'ENOTDIR'].includes(error?.code)) return { ...result, state: 'conflict', reason: 'LOCAL_CHANGED' };
      throw error;
    }
  }

  async function inspect({ endpoint, rootPath, record = null, includeVideo = false, signal, remote: hint, candidateFolder } = {}) {
    if (!ENDPOINT.test(endpoint) || typeof includeVideo !== 'boolean') throw fail('SYNC_INVALID');
    abort(signal); const context = await rootContext(rootPath);
    if (record) {
      const clean = validateSyncRecord(record);
      if (clean.endpoint !== endpoint) throw fail('SYNC_INVALID');
      if (HASH.test(hint?.contentRevision || '') && clean.revision === hint.contentRevision && clean.includeVideo === includeVideo) {
        const result = { revision: clean.revision, totalBytes: clean.files.reduce((sum, file) => sum + file.size, 0), files: clean.files.length };
        try {
          const local = await checkLocal(context, clean, signal);
          return local ? { ...result, state: 'unchanged', reason: 'IDENTICAL', record: local.record } : { ...result, state: 'new', reason: 'LOCAL_MISSING', record: null };
        } catch (error) {
          abort(signal);
          if (['SYNC_CONFLICT', 'DOWNLOAD_PATH', 'ENOENT', 'ENOTDIR'].includes(error?.code)) return { ...result, state: 'conflict', reason: 'LOCAL_CHANGED' };
          throw error;
        }
      }
    }
    const remote = await manifest(endpoint, includeVideo, signal);
    return inspectLoaded(context, endpoint, record, includeVideo, remote, signal, candidateFolder);
  }

  async function openStage(context, id, endpoint) {
    const directory = path.join(context.root, '.chartshub-companion-' + id), ownerPath = path.join(directory, 'owner.json');
    let info = await statOrNull(directory);
    if (!info) {
      await context.guard(); await fs.mkdir(directory, { mode: 0o700 });
      await writeNew(context, ownerPath, JSON.stringify({ owner: OWNER, version: 1, id, endpoint, rootIdentity: context.rootIdentity }));
      info = await context.checked(directory, { directory: true });
    }
    const stageIdentity = identity(await context.checked(directory, { directory: true })), owner = await readJsonFile(context, ownerPath, 4096);
    if (owner.owner !== OWNER || owner.version !== 1 || owner.id !== id || owner.endpoint !== endpoint || owner.rootIdentity !== context.rootIdentity) throw fail('SYNC_CONFLICT');
    const guard = async () => { await context.guard(); if (identity(await context.checked(directory, { directory: true })) !== stageIdentity) throw fail('SYNC_CONFLICT'); };
    const statePath = path.join(directory, 'checkpoint.json'); let state = { version: 1, files: {}, transaction: null };
    if (await statOrNull(statePath)) state = await readJsonFile(context, statePath, MAX_CHECKPOINT_BYTES);
    if (!plain(state) || state.version !== 1 || !plain(state.files) || Object.keys(state.files).length > 1000) throw fail('SYNC_CONFLICT');
    for (const [key, file] of Object.entries(state.files)) {
      if (!HASH.test(key) || !plain(file) || !validParts(file.parts) || key !== fileKey(file) || !safeSize(file.size) || !HASH.test(file.sha256) || !(file.remoteSignature === null || HASH.test(file.remoteSignature))) throw fail('SYNC_CONFLICT');
    }
    if (state.transaction !== null) {
      const tx = state.transaction;
      if (!plain(tx) || !['prepared', 'backed-up', 'promoted', 'complete', 'verified-unchanged', 'rolled-back'].includes(tx.phase) || !safeFolderPath(tx.folderName)
          || !(tx.previousIdentity === null || EXACT_IDENTITY.test(tx.previousIdentity)) || !EXACT_IDENTITY.test(tx.nextIdentity)) throw fail('SYNC_CONFLICT');
      if (tx.phase === 'verified-unchanged' && (!EXACT_IDENTITY.test(tx.readyIdentity) || tx.previousIdentity !== null || tx.previousRecord !== null)) throw fail('SYNC_CONFLICT');
      const next = validateSyncRecord(tx.record);
      if (next.endpoint !== endpoint || next.folderName !== tx.folderName || next.folderIdentity !== tx.nextIdentity || next.rootIdentity !== context.rootIdentity) throw fail('SYNC_CONFLICT');
      if (tx.previousRecord) {
        const previous = validateSyncRecord(tx.previousRecord);
        if (previous.endpoint !== endpoint || previous.folderName !== tx.folderName || previous.folderIdentity !== tx.previousIdentity || previous.rootIdentity !== context.rootIdentity
            || JSON.stringify(previous.parentIdentities ?? []) !== JSON.stringify(next.parentIdentities ?? [])) throw fail('SYNC_CONFLICT');
      } else if (tx.previousIdentity !== null) throw fail('SYNC_CONFLICT');
    }
    async function save() {
      const bytes = JSON.stringify(state);
      if (Buffer.byteLength(bytes) > MAX_CHECKPOINT_BYTES) throw fail('SYNC_INVALID');
      await guard(); const temporary = path.join(directory, 'checkpoint-' + crypto.randomUUID() + '.tmp');
      await writeNew(context, temporary, bytes);
      try { await guard(); await context.checked(statePath, { missing: true }); await fs.rename(temporary, statePath); }
      finally { if (await statOrNull(temporary)) { await context.checked(temporary); await fs.unlink(temporary); } }
    }
    return { directory, ready: path.join(directory, 'ready'), backup: path.join(directory, 'backup'), state, guard, save };
  }

  async function markerOwned(context, directory, id, endpoint) {
    const marker = path.join(directory, MARKER), info = await statOrNull(marker);
    if (!info) return false;
    const owner = await readJsonFile(context, marker, 4096);
    if (owner.owner !== OWNER || owner.id !== id || owner.endpoint !== endpoint) throw fail('SYNC_CONFLICT');
    return true;
  }

  async function verifiedRecordAt(context, directory, record, signal, marker = false) {
    if (identity(await context.checked(directory, { directory: true })) !== record.folderIdentity) throw fail('SYNC_CONFLICT');
    await folderInventory(context, directory, record.files, signal, { marker });
    const files = [];
    for (const file of record.files) {
      const checked = await hashFile(context, path.join(directory, ...file.parts), file.size, signal);
      if (checked.sha256 !== file.sha256) throw fail('SYNC_CONFLICT');
      files.push({ ...file, stamp: checked.stamp });
    }
    return { ...record, files };
  }

  async function completion(context, stage, id, endpoint, tx, receivedBytes = 0) {
    const destination = path.join(context.root, tx.folderName);
    const parents = await folderParentContext(context, tx.folderName, tx.record.parentIdentities ?? []);
    const record = await verifiedRecordAt(context, destination, tx.record, undefined, await markerOwned(context, destination, id, endpoint));
    if (await markerOwned(context, destination, id, endpoint)) { await stage.guard(); await parents.guard(); await context.checked(path.join(destination, MARKER)); await fs.unlink(path.join(destination, MARKER)); }
    tx.record = record; tx.phase = 'complete'; await stage.save();
    return { destination, folderName: tx.folderName, files: record.files.length, totalBytes: record.files.reduce((sum, file) => sum + file.size, 0), receivedBytes,
      record, changed: true, ...(tx.previousIdentity ? { backupPath: stage.backup } : {}) };
  }

  /** Recover from filesystem reality and exact identities, not a phase flag alone. */
  async function recover(context, stage, id, endpoint) {
    const tx = stage.state.transaction;
    if (!tx || tx.phase === 'rolled-back') return null;
    const parents = await folderParentContext(context, tx.folderName, tx.record.parentIdentities ?? []);
    if (tx.phase === 'verified-unchanged') {
      const local = await checkLocal(context, tx.record, undefined, true);
      if (!local) throw fail('SYNC_CONFLICT');
      // The installed receipt is already authoritative. Optional staged copies
      // may have been partly cleaned after that durable boundary; they never
      // authorize replacing the installed chart during recovery.
      await parents.guard(); tx.record = local.record; await stage.save();
      return { destination: local.directory, folderName: tx.folderName, files: local.record.files.length,
        totalBytes: local.record.files.reduce((sum, file) => sum + file.size, 0), receivedBytes: 0, record: local.record, changed: false };
    }
    await stage.guard(); const destination = path.join(context.root, tx.folderName), present = await statOrNull(destination), ready = await statOrNull(stage.ready), backup = await statOrNull(stage.backup);
    if (present && identity(await context.checked(destination, { directory: true })) === tx.nextIdentity) return completion(context, stage, id, endpoint, tx);
    if (tx.phase === 'complete') throw fail('SYNC_CONFLICT');
    if (present) {
      if (tx.previousIdentity === null || backup || identity(await context.checked(destination, { directory: true })) !== tx.previousIdentity) throw fail('SYNC_CONFLICT');
      // No promotion began; leave the previous chart untouched and let run retry.
      await checkLocal(context, tx.previousRecord, undefined, true); tx.phase = 'rolled-back'; await stage.save(); return null;
    }
    if (tx.previousIdentity !== null) {
      if (!backup || identity(await context.checked(stage.backup, { directory: true })) !== tx.previousIdentity) throw fail('SYNC_CONFLICT');
      await verifiedRecordAt(context, stage.backup, tx.previousRecord, undefined);
    } else if (backup) throw fail('SYNC_CONFLICT');
    if (ready && identity(await context.checked(stage.ready, { directory: true })) === tx.nextIdentity) {
      await verifiedRecordAt(context, stage.ready, tx.record, undefined, await markerOwned(context, stage.ready, id, endpoint));
      await stage.guard(); await parents.guard(); if (await statOrNull(destination)) throw fail('SYNC_CONFLICT');
      await fs.rename(stage.ready, destination); tx.phase = 'promoted'; await stage.save(); return completion(context, stage, id, endpoint, tx);
    }
    // An incomplete new chart never replaces a verified backup.
    if (tx.previousIdentity !== null) {
      await stage.guard(); await parents.guard(); if (await statOrNull(destination)) throw fail('SYNC_CONFLICT');
      await fs.rename(stage.backup, destination); tx.phase = 'rolled-back'; await stage.save();
    }
    throw fail('SYNC_CONFLICT');
  }

  async function makeParents(context, stage, target) {
    const parent = path.dirname(target);
    if (parent !== stage.ready) await context.mkdir(parent);
    await stage.guard(); await context.checked(stage.ready, { directory: true });
  }

  async function removeEmptyStageDirectories(context, stage, directory = stage.ready, depth = 0, visited = { count: 0 }) {
    if (depth > 5 || ++visited.count > 6000) throw fail('SYNC_CONFLICT');
    await stage.guard(); await context.checked(directory, { directory: true });
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!safePart(entry.name) || entry.isSymbolicLink()) throw fail('SYNC_CONFLICT');
      if (!entry.isDirectory()) continue;
      const child = path.join(directory, entry.name); await removeEmptyStageDirectories(context, stage, child, depth + 1, visited);
      await context.checked(child, { directory: true });
      if (!(await fs.readdir(child)).length) { await stage.guard(); await fs.rmdir(child); }
    }
  }

  async function copyChecked(context, stage, source, target, file, signal) {
    const before = await fileStat(context, source), handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let output;
    try {
      if (before.size !== BigInt(file.size) || !sameStamp(stamp(before), stamp(await handle.stat({ bigint: true })))) throw fail('SYNC_CONFLICT');
      await makeParents(context, stage, target); await context.checked(target, { missing: true });
      output = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(BUFFER_BYTES); let total = 0;
      for (;;) {
        abort(signal); await stage.guard(); const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break; total += bytesRead; if (total > file.size) throw fail('SYNC_CONFLICT'); hash.update(buffer.subarray(0, bytesRead));
        let offset = 0; while (offset < bytesRead) { const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset); if (!bytesWritten) throw fail('SYNC_IO'); offset += bytesWritten; }
      }
      const sha256 = hash.digest('hex');
      if (total !== file.size || sha256 !== file.sha256 || !sameStamp(stamp(before), stamp(await handle.stat({ bigint: true }))) || !sameStamp(stamp(before), stamp(await fileStat(context, source)))) throw fail('SYNC_CONFLICT');
      await output.sync(); return sha256;
    } finally { await output?.close(); await handle.close(); }
  }

  async function run({ id, endpoint, rootPath, record = null, includeVideo = false, signal, onProgress = () => {}, candidateFolder } = {}) {
    if (!UUID.test(id) || !ENDPOINT.test(endpoint) || typeof includeVideo !== 'boolean') throw fail('SYNC_INVALID');
    const lock = (process.platform === 'win32' ? String(rootPath).toLowerCase() : String(rootPath)) + ':' + endpoint;
    if (running.has(lock)) throw fail('SYNC_BUSY'); running.add(lock);
    let activePart = null, context, stage;
    try {
      abort(signal); context = await rootContext(rootPath);
      if (await statOrNull(path.join(context.root, '.chartshub-companion-' + id))) {
        stage = await openStage(context, id, endpoint);
        const recovered = await recover(context, stage, id, endpoint); if (recovered) return recovered;
      }
      const remote = await manifest(endpoint, includeVideo, signal), inspected = await inspectLoaded(context, endpoint, record, includeVideo, remote, signal, candidateFolder);
      if (inspected.state === 'conflict') throw fail('SYNC_CONFLICT');
      if (inspected.state === 'unchanged') return { destination: path.join(context.root, inspected.record.folderName), folderName: inspected.record.folderName,
        files: remote.files.length, totalBytes: remote.totalBytes, receivedBytes: 0, record: inspected.record, changed: false };
      const prior = inspected.record;
      const folderName = prior?.folderName ?? remote.folderName, destination = path.join(context.root, folderName);
      const parents = await folderParentContext(context, folderName, prior?.parentIdentities);
      try { validateDestination(context.root, folderName, remote.files); } catch { throw fail('SYNC_INVALID'); }
      if (!prior && await statOrNull(destination)) throw fail('SYNC_CONFLICT');
      // Reserve enough space for the prepared chart; the original remains available.
      if (typeof fs.statfs === 'function') {
        const available = await fs.statfs(context.root, { bigint: true });
        if (available.bavail * available.bsize < BigInt(remote.totalBytes)) throw fail('ENOSPC');
      }
      stage ??= await openStage(context, id, endpoint);
      if (!await statOrNull(stage.ready)) { await stage.guard(); await fs.mkdir(stage.ready, { mode: 0o700 }); }
      await context.checked(stage.ready, { directory: true });
      // A previous unpromoted prepared transaction is resumable, never deleted.
      if (await statOrNull(path.join(stage.ready, MARKER))) {
        await markerOwned(context, stage.ready, id, endpoint); await fs.unlink(path.join(stage.ready, MARKER));
      }
      const expectedKeys = new Set(remote.files.map(fileKey));
      for (const [key, saved] of Object.entries(stage.state.files)) if (!expectedKeys.has(key)) {
        const target = path.join(stage.ready, ...saved.parts);
        if (await statOrNull(target)) {
          const checked = await hashFile(context, target, saved.size, signal);
          if (checked.sha256 !== saved.sha256) throw fail('SYNC_CONFLICT');
          await stage.guard(); await context.checked(target); await fs.unlink(target);
        }
        delete stage.state.files[key];
      }
      await removeEmptyStageDirectories(context, stage);
      stage.state.transaction = null; await stage.save();
      const previousFiles = new Map((prior?.files ?? []).map(file => [keyOf(file.parts), file]));
      let receivedBytes = 0, completedBytes = 0, completedFiles = 0, lastProgress = 0;
      const progress = (currentFile = null, extra = 0, force = false) => {
        if (!force && Date.now() - lastProgress < 100) return; lastProgress = Date.now();
        try { onProgress({ receivedBytes: receivedBytes + extra, completedBytes: completedBytes + extra, totalBytes: remote.totalBytes, completedFiles, totalFiles: remote.files.length, currentFile }); } catch {}
      };
      for (const file of remote.files) {
        abort(signal); await stage.guard(); const key = fileKey(file), target = path.join(stage.ready, ...file.parts), signature = remoteSignature(file), saved = stage.state.files[key];
        let sha256 = null;
        if (saved && signature !== null && saved.remoteSignature === signature && saved.size === file.size && await statOrNull(target)) {
          const checked = await hashFile(context, target, file.size, signal);
          if (checked.sha256 !== saved.sha256 || file.sha256 && checked.sha256 !== file.sha256) throw fail('SYNC_CONFLICT');
          sha256 = checked.sha256;
        } else {
          if (await statOrNull(target)) {
            if (!saved) throw fail('SYNC_CONFLICT');
            const checked = await hashFile(context, target, saved.size, signal);
            if (checked.sha256 !== saved.sha256) throw fail('SYNC_CONFLICT');
            await context.checked(target); await fs.unlink(target);
          }
          if (saved) { delete stage.state.files[key]; await stage.save(); }
          const previous = previousFiles.get(keyOf(file.parts));
          if (previous && previous.size === file.size && (file.sha256 === previous.sha256 || signature !== null && signature === previous.remoteSignature)) {
            activePart = path.join(stage.directory, 'active.part');
            if (await statOrNull(activePart)) { await context.checked(activePart); await fs.unlink(activePart); }
            sha256 = await copyChecked(context, stage, path.join(destination, ...previous.parts), activePart, previous, signal);
            stage.state.files[key] = { parts: file.parts, size: file.size, sha256, remoteSignature: signature }; await stage.save();
            abort(signal); await stage.guard(); await makeParents(context, stage, target); await context.checked(target, { missing: true }); await context.checked(activePart);
            await fs.rename(activePart, target); activePart = null;
          } else {
            activePart = path.join(stage.directory, 'active.part');
            if (await statOrNull(activePart)) { await context.checked(activePart); await fs.unlink(activePart); }
            await stage.guard(); await context.checked(activePart, { missing: true });
            const handle = await fs.open(activePart, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600), hash = crypto.createHash('sha256');
            try {
              await request(file.url, { signal, size: file.size, consume: async (bytes, count) => {
                await stage.guard(); hash.update(bytes);
                for (let offset = 0; offset < bytes.byteLength;) {
                  const length = Math.min(BUFFER_BYTES, bytes.byteLength - offset), { bytesWritten } = await handle.write(bytes, offset, length);
                  if (!bytesWritten) throw fail('SYNC_IO'); offset += bytesWritten;
                }
                progress(file.parts.join('/'), count);
              } });
              await handle.sync();
            } finally { await handle.close(); }
            sha256 = hash.digest('hex');
            if (file.sha256 && sha256 !== file.sha256) throw fail('SYNC_INTEGRITY');
            stage.state.files[key] = { parts: file.parts, size: file.size, sha256, remoteSignature: signature }; await stage.save();
            abort(signal); await stage.guard(); await makeParents(context, stage, target); await context.checked(target, { missing: true }); await context.checked(activePart);
            await fs.rename(activePart, target); activePart = null; receivedBytes += file.size;
          }
        }
        completedBytes += file.size; completedFiles++; progress(file.parts.join('/'), 0, true);
      }
      await folderInventory(context, stage.ready, remote.files, signal);
      const files = [];
      for (const file of remote.files) {
        const saved = stage.state.files[fileKey(file)], checked = await hashFile(context, path.join(stage.ready, ...file.parts), file.size, signal);
        if (!saved || checked.sha256 !== saved.sha256 || file.sha256 && checked.sha256 !== file.sha256) throw fail('SYNC_INTEGRITY');
        files.push({ parts: file.parts, size: file.size, sha256: checked.sha256, remoteSignature: remoteSignature(file), stamp: checked.stamp });
      }
      // A weak remote manifest may still prove identical after downloading its bytes.
      if (prior && prior.files.length === files.length && files.every(file => previousFiles.get(keyOf(file.parts))?.sha256 === file.sha256 && previousFiles.get(keyOf(file.parts))?.size === file.size)) {
        const verified = await checkLocal(context, prior, signal, true);
        if (!verified) throw fail('SYNC_CONFLICT');
        const next = { ...verified.record, revision: remote.revision, includeVideo,
          files: verified.record.files.map(file => ({ ...file, remoteSignature: files.find(next => keyOf(next.parts) === keyOf(file.parts)).remoteSignature })) };
        const unchanged = validateSyncRecord(next);
        stage.state.transaction = { phase: 'verified-unchanged', folderName, previousIdentity: null, nextIdentity: unchanged.folderIdentity,
          previousRecord: null, record: unchanged, readyIdentity: identity(await context.checked(stage.ready, { directory: true })) };
        await stage.save();
        return { destination, folderName, files: files.length, totalBytes: remote.totalBytes, receivedBytes, record: unchanged, changed: false };
      }
      if (prior && !await checkLocal(context, prior, signal, true)) throw fail('SYNC_CONFLICT');
      if (!prior && await statOrNull(destination)) throw fail('SYNC_CONFLICT');
      const nextIdentity = identity(await context.checked(stage.ready, { directory: true }));
      const next = recordFor(context, endpoint, includeVideo, remote, folderName, nextIdentity, files, parents.identities);
      await writeNew(context, path.join(stage.ready, MARKER), JSON.stringify({ owner: OWNER, id, endpoint }));
      stage.state.transaction = { phase: 'prepared', folderName, previousIdentity: prior?.folderIdentity ?? null, nextIdentity, previousRecord: prior, record: next }; await stage.save();
      abort(signal); await stage.guard();
      // The short rename transaction is not cancellable. An installed folder wins over a late pause.
      if (prior) {
        if (await statOrNull(stage.backup)) throw fail('SYNC_CONFLICT');
        await parents.guard();
        if (identity(await context.checked(destination, { directory: true })) !== prior.folderIdentity) throw fail('SYNC_CONFLICT');
        await fs.rename(destination, stage.backup); stage.state.transaction.phase = 'backed-up'; await stage.save();
      }
      await stage.guard(); await parents.guard(); if (await statOrNull(destination)) throw fail('SYNC_CONFLICT');
      await fs.rename(stage.ready, destination); stage.state.transaction.phase = 'promoted'; await stage.save();
      const result = await completion(context, stage, id, endpoint, stage.state.transaction, receivedBytes);
      progress(null, 0, true); return result;
    } catch (error) {
      const tx = stage?.state.transaction;
      // Roll back only a proven owned backup. An unexpected replacement is never removed.
      if (tx && tx.phase !== 'complete' && tx.previousIdentity) {
        try {
          const destination = path.join(context.root, tx.folderName);
          const parents = await folderParentContext(context, tx.folderName, tx.record.parentIdentities ?? []);
          if (!await statOrNull(destination) && identity(await context.checked(stage.backup, { directory: true })) === tx.previousIdentity) {
            await verifiedRecordAt(context, stage.backup, tx.previousRecord, undefined);
            await stage.guard(); await parents.guard(); if (await statOrNull(destination)) throw fail('SYNC_CONFLICT');
            await fs.rename(stage.backup, destination); tx.phase = 'rolled-back'; await stage.save();
          }
        } catch { /* The journal and backup remain for explicit recovery. */ }
      }
      if ((signal?.aborted && !tx) || error?.name === 'AbortError') throw Object.assign(Error('Synchronization paused.'), { name: 'AbortError', code: 'ABORT_ERR' });
      if (error?.code?.startsWith('SYNC_') || error?.code === 'ENOSPC') throw error;
      if (error?.code?.startsWith('DOWNLOAD_')) throw fail('SYNC_CONFLICT');
      throw fail('SYNC_IO');
    } finally {
      if (activePart && context && stage) { try { await stage.guard(); await context.checked(activePart); await fs.unlink(activePart); } catch {} }
      running.delete(lock);
    }
  }

  /** Called only after the service durably stores the installed receipt. Never
   * delete an old-chart backup, an unknown entry, or an uncompleted journal. */
  async function finalize({ id, endpoint, rootPath, record } = {}) {
    if (!UUID.test(id) || !ENDPOINT.test(endpoint)) throw fail('SYNC_INVALID');
    const clean = validateSyncRecord(record);
    if (clean.endpoint !== endpoint) throw fail('SYNC_INVALID');
    const lock = (process.platform === 'win32' ? String(rootPath).toLowerCase() : String(rootPath)) + ':' + endpoint;
    if (running.has(lock)) throw fail('SYNC_BUSY'); running.add(lock);
    try {
      const context = await rootContext(rootPath), directory = path.join(context.root, '.chartshub-companion-' + id);
      if (!await statOrNull(directory)) return { cleaned: false, reason: 'NO_STAGE' };
      const snapshots = new Map();
      for (const name of ['checkpoint.json', 'owner.json']) {
        const target = path.join(directory, name);
        if (await statOrNull(target)) snapshots.set(name, stamp(await fileStat(context, target)));
      }
      const stage = await openStage(context, id, endpoint), tx = stage.state.transaction;
      if (!tx || !['complete', 'verified-unchanged'].includes(tx.phase)) return { cleaned: false, reason: 'INCOMPLETE' };
      if (tx.previousIdentity !== null || await statOrNull(stage.backup)) return { cleaned: false, reason: 'BACKUP_PRESERVED' };
      if (JSON.stringify(validateSyncRecord(tx.record)) !== JSON.stringify(clean)) throw fail('SYNC_CONFLICT');
      const names = (await fs.readdir(directory)).sort();
      const unchanged = tx.phase === 'verified-unchanged', hasReady = unchanged && await statOrNull(stage.ready), expectedNames = ['checkpoint.json', 'owner.json', ...(hasReady ? ['ready'] : [])];
      if (JSON.stringify(names) !== JSON.stringify(expectedNames)) return { cleaned: false, reason: 'EXTRA_FILES' };
      const local = await checkLocal(context, clean);
      if (!local || JSON.stringify(local.record) !== JSON.stringify(clean)) throw fail('SYNC_CONFLICT');
      if (hasReady) {
        if (identity(await context.checked(stage.ready, { directory: true })) !== tx.readyIdentity) throw fail('SYNC_CONFLICT');
        if (Object.keys(stage.state.files).length !== clean.files.length || clean.files.some(file => {
          const saved = stage.state.files[fileKey(file)];
          return !saved || JSON.stringify(saved.parts) !== JSON.stringify(file.parts) || saved.size !== file.size || saved.sha256 !== file.sha256;
        })) throw fail('SYNC_CONFLICT');
        // Missing owned copies may come from an interrupted previous cleanup.
        // Every remaining member must still match its checkpoint and receipt.
        const found = await folderInventory(context, stage.ready, clean.files, undefined, { allowMissing: true }), staged = [];
        for (const file of clean.files) if (found.has(keyOf(file.parts))) {
          const checked = await hashFile(context, path.join(stage.ready, ...file.parts), file.size);
          if (checked.sha256 !== file.sha256) throw fail('SYNC_CONFLICT');
          staged.push({ ...file, stamp: checked.stamp });
        }
        // Preflight the entire owned copy before the first deletion. Unknown
        // members or changed identities preserve all staged and installed files.
        const inventory = await folderInventory(context, stage.ready, clean.files, undefined, { allowMissing: true });
        if (inventory.size !== staged.length || staged.some(file => !sameStamp(file.stamp, inventory.get(keyOf(file.parts))?.stamp))) throw fail('SYNC_CONFLICT');
        await stage.guard();
        if (identity(await context.checked(stage.ready, { directory: true })) !== tx.readyIdentity) throw fail('SYNC_CONFLICT');
        for (const file of staged) {
          await stage.guard();
          if (identity(await context.checked(stage.ready, { directory: true })) !== tx.readyIdentity) throw fail('SYNC_CONFLICT');
          const target = path.join(stage.ready, ...file.parts);
          if (!sameStamp(file.stamp, stamp(await fileStat(context, target)))) throw fail('SYNC_CONFLICT');
          await fs.unlink(target);
        }
        await removeEmptyStageDirectories(context, stage);
        await stage.guard();
        if (identity(await context.checked(stage.ready, { directory: true })) !== tx.readyIdentity || (await fs.readdir(stage.ready)).length) throw fail('SYNC_CONFLICT');
        await fs.rmdir(stage.ready);
      }
      await stage.guard();
      const metadata = ['checkpoint.json', 'owner.json'];
      if (JSON.stringify((await fs.readdir(directory)).sort()) !== JSON.stringify(metadata)) return { cleaned: false, reason: 'EXTRA_FILES' };
      for (const name of metadata) if (!sameStamp(snapshots.get(name), stamp(await fileStat(context, path.join(directory, name))))) throw fail('SYNC_CONFLICT');
      // Detach only the now-empty metadata stage atomically. A crash between
      // metadata unlinks cannot leave the job's old stage looking incomplete;
      // its durable installed receipt remains available for the next run.
      const retired = directory + '-finalized', stageIdentity = identity(await context.checked(directory, { directory: true }));
      if (await statOrNull(retired)) return { cleaned: false, reason: 'EXTRA_FILES' };
      await stage.guard(); await context.checked(retired, { missing: true }); await fs.rename(directory, retired);
      const retiredGuard = async () => { await context.guard(); if (identity(await context.checked(retired, { directory: true })) !== stageIdentity) throw fail('SYNC_CONFLICT'); };
      // These are the two fully parsed owned metadata files only. rmdir refuses
      // a late unknown entry; no recursive removal or real chart unlink occurs.
      for (const name of metadata) {
        await retiredGuard(); const target = path.join(retired, name);
        if (!sameStamp(snapshots.get(name), stamp(await fileStat(context, target)))) throw fail('SYNC_CONFLICT');
        await fs.unlink(target);
      }
      await retiredGuard(); await fs.rmdir(retired);
      return { cleaned: true };
    } catch (error) {
      if (error?.code?.startsWith('SYNC_')) throw error;
      if (error?.code?.startsWith('DOWNLOAD_') || ['ENOENT', 'ENOTDIR', 'ENOTEMPTY'].includes(error?.code)) throw fail('SYNC_CONFLICT');
      throw fail('SYNC_IO');
    } finally { running.delete(lock); }
  }

  return { inspect, run, finalize };
}

module.exports = { createCatalogueSyncWorker, validateSyncRecord };
