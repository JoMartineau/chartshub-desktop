'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

const FILE = 'library-cleanup-history.json';
const MAX_ENTRIES = 200, MAX_BYTES = 2 * 1024 * 1024, MAX_TARGETS = 10000;
const HEX = /^[a-f0-9]{64}$/, TOKEN = /^[a-f0-9]{32}$/;
const FAILED = 'La mise à la corbeille n’a pas pu être vérifiée ou effectuée.';
const UNAVAILABLE = 'L’historique des nettoyages est indisponible. Les résultats du nettoyage restent inchangés.';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (left, right) => canonical(left) === canonical(right);
const error = () => Object.assign(new Error(UNAVAILABLE), { code: 'LIBRARY_CLEANUP_HISTORY' });
const identity = stat => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const directoryIdentity = stat => `${stat.dev}:${stat.ino}:${stat.mode}`;
function relative(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !path.isAbsolute(value)
    && !/[\\:\u0000-\u001f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part));
}
const contains = (parent, child) => samePath(parent, child) || canonical(child).startsWith(canonical(parent) + '/');
const overlaps = (left, right) => contains(left, right) || contains(right, left);
function target(value) {
  if (!object(value) || !HEX.test(value.id) || !relative(value.relativePath) || !relative(value.targetRelativePath) || !contains(value.targetRelativePath, value.relativePath)) throw error();
  return { id: value.id, relativePath: value.relativePath, targetRelativePath: value.targetRelativePath };
}
function rootKey(rootPath) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || rootPath.includes('\0')) throw error();
  return createHash('sha256').update(canonical(path.resolve(rootPath))).digest('hex');
}
function validRecord(value) {
  try {
    if (!keys(value, ['id', 'rootKey', 'at', 'mode', 'keep', 'candidates', 'cancelled']) || !TOKEN.test(value.id) || !HEX.test(value.rootKey)
      || typeof value.at !== 'string' || new Date(value.at).toISOString() !== value.at || !['normal', 'force'].includes(value.mode)
      || typeof value.cancelled !== 'boolean' || !Array.isArray(value.candidates) || !value.candidates.length || value.candidates.length > MAX_TARGETS) return false;
    if (!keys(value.keep, ['id', 'relativePath', 'targetRelativePath'])) return false;
    const keep = target(value.keep), ids = new Set([keep.id]);
    for (const candidate of value.candidates) {
      if (!keys(candidate, ['id', 'relativePath', 'targetRelativePath', 'status', 'reason'])) return false;
      const current = target(candidate);
      if (ids.has(current.id) || overlaps(keep.targetRelativePath, current.targetRelativePath) || !['recycled', 'failed', 'not-attempted'].includes(candidate.status)
        || candidate.reason !== (candidate.status === 'failed' ? FAILED : null)) return false;
      ids.add(current.id);
    }
    return true;
  } catch (_) { return false; }
}

/** Records completed executor attempts only. It never reads, opens or restores charts. */
function createLibraryCleanupHistory({ directory } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) throw error();
  const folder = path.resolve(directory), file = path.join(folder, FILE), lockPath = path.join(folder, '.library-cleanup-history.lock');
  let queue = Promise.resolve();
  const serial = task => { const result = queue.then(task, task); queue = result.catch(() => {}); return result; };

  async function checkedDirectory() {
    const parsed = path.parse(folder); let current = parsed.root;
    for (const part of folder.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      if (/[. ]$/.test(part)) throw error();
      current = path.join(current, part);
      const stat = await fs.lstat(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw error();
    }
    if (!samePath(await fs.realpath(folder), folder)) throw error();
    return directoryIdentity(await fs.lstat(folder, { bigint: true }));
  }
  async function checkFile() {
    try {
      const stat = await fs.lstat(file, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(MAX_BYTES) || !samePath(await fs.realpath(file), file)) throw error();
      return stat;
    } catch (failure) { if (failure.code === 'ENOENT') return null; throw failure; }
  }
  async function read() {
    const folderId = await checkedDirectory(), before = await checkFile();
    if (!before) return { records: [], folderId, fileId: null };
    const handle = await fs.open(file, 'r');
    try {
      if (identity(await handle.stat({ bigint: true })) !== identity(before)) throw error();
      // A concurrent writer cannot turn the bounded history read into an
      // unbounded allocation by growing the file after the first stat.
      const buffer = Buffer.alloc(Number(before.size) + 1); let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== Number(before.size) || identity(await handle.stat({ bigint: true })) !== identity(before)) throw error();
      const source = buffer.subarray(0, length).toString('utf8');
      const after = await checkFile();
      if (!after || identity(after) !== identity(before) || await checkedDirectory() !== folderId) throw error();
      const document = JSON.parse(source);
      if (!keys(document, ['version', 'entries']) || document.version !== 1 || !Array.isArray(document.entries) || document.entries.length > MAX_ENTRIES
        || !document.entries.every(validRecord) || new Set(document.entries.map(entry => entry.id)).size !== document.entries.length) throw error();
      return { records: document.entries, folderId, fileId: identity(before) };
    } finally { await handle.close(); }
  }
  function record(input) {
    if (!object(input) || !['normal', 'force'].includes(input.mode) || !object(input.result) || typeof input.result.cancelled !== 'boolean'
      || !Array.isArray(input.candidates) || !input.candidates.length || input.candidates.length > MAX_TARGETS
      || !Array.isArray(input.result.recycledIds) || !Array.isArray(input.result.failed)) throw error();
    const keep = target(input.keep), candidates = input.candidates.map(target), ids = new Set(candidates.map(value => value.id));
    if (ids.size !== candidates.length || ids.has(keep.id)) throw error();
    const recycled = new Set(input.result.recycledIds), failed = new Set(input.result.failed.map(value => value?.id));
    if (recycled.size !== input.result.recycledIds.length || failed.size !== input.result.failed.length
      || [...recycled, ...failed].some(id => !ids.has(id)) || [...recycled].some(id => failed.has(id))) throw error();
    const value = { id: randomBytes(16).toString('hex'), rootKey: rootKey(input.rootPath), at: new Date().toISOString(), mode: input.mode, keep,
      candidates: candidates.map(candidate => ({ ...candidate, status: recycled.has(candidate.id) ? 'recycled' : failed.has(candidate.id) ? 'failed' : 'not-attempted', reason: failed.has(candidate.id) ? FAILED : null })),
      cancelled: input.result.cancelled };
    if (!validRecord(value)) throw error();
    return value;
  }
  async function append(input) {
    // Snapshot all caller-owned values before entering the asynchronous writer queue.
    let entry;
    try { entry = record(input); } catch (_) { return { recorded: false, error: UNAVAILABLE }; }
    return serial(async () => {
      let lock = null, temporary = null, temporaryId = null, folderId = null;
      try {
        folderId = await checkedDirectory();
        lock = await fs.open(lockPath, 'wx', 0o600);
        const current = await read();
        if (current.folderId !== folderId) throw error();
        const entries = [entry, ...current.records].slice(0, MAX_ENTRIES);
        let content = JSON.stringify({ version: 1, entries });
        while (Buffer.byteLength(content) > MAX_BYTES && entries.length > 1) { entries.pop(); content = JSON.stringify({ version: 1, entries }); }
        if (Buffer.byteLength(content) > MAX_BYTES) throw error();
        temporary = path.join(folder, `.library-cleanup-history-${randomBytes(16).toString('hex')}.tmp`);
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(content, 'utf8'); await handle.sync(); temporaryId = identity(await handle.stat({ bigint: true })); }
        finally { await handle.close(); }
        const previous = await checkFile();
        if ((previous ? identity(previous) : null) !== current.fileId || await checkedDirectory() !== folderId
          || identity(await fs.lstat(temporary, { bigint: true })) !== temporaryId) throw error();
        await fs.rename(temporary, file); temporary = null;
        return { recorded: true, id: entry.id };
      } catch (_) { return { recorded: false, error: UNAVAILABLE }; }
      finally {
        if (temporary && temporaryId) {
          try { if (await checkedDirectory() === folderId && identity(await fs.lstat(temporary, { bigint: true })) === temporaryId) await fs.unlink(temporary); } catch (_) { /* Preserve any ambiguous replacement. */ }
        }
        if (lock) {
          try { if (await checkedDirectory() === folderId && identity(await fs.lstat(lockPath, { bigint: true })) === identity(await lock.stat({ bigint: true }))) await fs.unlink(lockPath); } catch (_) { /* Never remove another writer's lock. */ }
          await lock.close().catch(() => {});
        }
      }
    });
  }
  async function list({ rootPath, offset = 0, limit = 10 } = {}) {
    try {
      const key = rootKey(rootPath);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw error();
      return await serial(async () => {
        const { records } = await read(), filtered = records.filter(entry => entry.rootKey === key);
        return { entries: filtered.slice(offset, offset + limit).map(({ rootKey: _rootKey, ...entry }) => entry), total: filtered.length, offset, limit, maxEntries: MAX_ENTRIES };
      });
    } catch (_) { throw error(); }
  }
  return { append, list };
}

module.exports = { createLibraryCleanupHistory };
