'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { TextDecoder } = require('node:util');

const MAX_BYTES = 8192;
const problem = () => Object.assign(Error('QUICK_IMPORT_PREFERENCES'), { code: 'QUICK_IMPORT_PREFERENCES' });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const equal = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const stamp = stat => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const directoryStamp = stat => `${stat.dev}:${stat.ino}:${stat.mode}`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function localPath(value) {
  if (typeof value !== 'string' || !value.length || value.length > 230 || !path.isAbsolute(value)
      || /[\x00-\x1f\x7f]/.test(value) || /^(?:\\\\|\/\/)/.test(value)
      || value.split(/[\\/]/).some(part => /[. ]$/.test(part))
      || (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':')))) throw problem();
  return path.resolve(value);
}
function document(value) {
  if (!plain(value) || value.version !== 1 || Object.keys(value).sort().join(',') !== 'gameRoot,version') throw problem();
  return { version: 1, gameRoot: value.gameRoot === null ? null : localPath(value.gameRoot) };
}

// A private local choice only. Enabled state and transport capabilities are never
// persisted. Unsafe, changed or future files remain untouched and become read-only.
function createQuickImportPreferences({ dataDirectory } = {}) {
  const directory = localPath(dataDirectory);
  const file = path.join(directory, 'quick-import-settings.json');
  const lockFile = path.join(directory, '.quick-import-settings.lock');
  let value = { version: 1, gameRoot: null }, loaded = false, loading = null;
  let canWrite = true, fingerprint = null, fileIdentity = null, directoryIdentity = null, serial = Promise.resolve();
  const status = () => ({ ...value, canWrite });
  const protect = () => { canWrite = false; return problem(); };

  async function checkedDirectory(create = false) {
    const root = path.parse(directory).root;
    let current = root;
    for (const part of directory.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let stat;
      try { stat = await fs.lstat(current, { bigint: true }); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!create) return null;
        try { await fs.mkdir(current); } catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
        stat = await fs.lstat(current, { bigint: true });
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw protect();
    }
    if (!equal(await fs.realpath(directory), directory)) throw protect();
    return directoryStamp(await fs.lstat(directory, { bigint: true }));
  }
  async function checkedFile() {
    try {
      const stat = await fs.lstat(file, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 1n
          || stat.size > BigInt(MAX_BYTES) || !equal(await fs.realpath(file), file)) throw protect();
      return stat;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function read() {
    const folderId = await checkedDirectory();
    if (folderId === null) return null;
    const before = await checkedFile();
    if (!before) return { value: null, fingerprint: null, identity: null, folderId };
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (stamp(await handle.stat({ bigint: true })) !== stamp(before)) throw protect();
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < bytes.length) {
        const part = await handle.read(bytes, length, bytes.length - length, length);
        if (!part.bytesRead) break;
        length += part.bytesRead;
      }
      const after = await checkedFile();
      if (length !== Number(before.size) || !after || stamp(after) !== stamp(before)
          || stamp(await handle.stat({ bigint: true })) !== stamp(before)
          || await checkedDirectory() !== folderId) throw protect();
      const contents = bytes.subarray(0, length);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(contents).replace(/^\uFEFF/, '');
      return { value: document(JSON.parse(text)), fingerprint: digest(contents), identity: stamp(before), folderId };
    } finally { await handle.close(); }
  }
  function load() {
    if (loaded) return Promise.resolve(status());
    if (loading) return loading;
    loading = (async () => {
      try {
        const prior = await read();
        if (prior) {
          if (prior.value !== null) value = prior.value;
          fingerprint = prior.fingerprint;
          fileIdentity = prior.identity; directoryIdentity = prior.folderId;
        }
      } catch { canWrite = false; }
      loaded = true; return status();
    })();
    return loading;
  }
  async function persist(candidate, guard) {
    const bytes = Buffer.from(JSON.stringify(candidate) + '\n');
    let lock = null, lockId = null, folderId = null, temporary = null, temporaryId = null;
    async function checkLock() {
      const stat = await fs.lstat(lockFile, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stamp(stat) !== lockId
          || stamp(await lock.stat({ bigint: true })) !== lockId) throw protect();
    }
    try {
      guard();
      folderId = await checkedDirectory(directoryIdentity === null);
      if (directoryIdentity !== null && folderId !== directoryIdentity) throw protect();
      lock = await fs.open(lockFile, 'wx', 0o600);
      const acquired = await lock.stat({ bigint: true });
      lockId = stamp(acquired);
      if (!acquired.isFile() || acquired.nlink !== 1n || acquired.size !== 0n) throw protect();
      const prior = await read();
      if ((prior?.fingerprint ?? null) !== fingerprint || (prior?.identity ?? null) !== fileIdentity) throw protect();
      guard();
      temporary = path.join(directory, `.quick-import-${randomBytes(16).toString('hex')}.tmp`);
      const handle = await fs.open(temporary, 'wx+', 0o600);
      try {
        temporaryId = stamp(await handle.stat({ bigint: true }));
        await handle.writeFile(bytes); await handle.sync();
        const written = await handle.stat({ bigint: true });
        const actual = Buffer.alloc(bytes.length + 1);
        const checked = await handle.read(actual, 0, actual.length, 0);
        if (!written.isFile() || written.nlink !== 1n || written.size !== BigInt(bytes.length)
            || checked.bytesRead !== bytes.length || !actual.subarray(0, checked.bytesRead).equals(bytes)) throw protect();
        temporaryId = stamp(written);
      } finally {
        temporaryId = await handle.stat({ bigint: true }).then(stamp, () => temporaryId);
        await handle.close();
      }
      const current = await checkedFile(), candidateStat = await fs.lstat(temporary, { bigint: true });
      await checkLock();
      if ((current ? stamp(current) : null) !== (prior?.identity ?? null)
          || await checkedDirectory() !== folderId || !candidateStat.isFile() || candidateStat.isSymbolicLink()
          || candidateStat.nlink !== 1n || stamp(candidateStat) !== temporaryId) throw protect();
      guard();
      await fs.rename(temporary, file); temporary = null;
      const committed = await read();
      if (!committed || committed.fingerprint !== digest(bytes) || committed.folderId !== folderId) throw protect();
      value = candidate; fingerprint = committed.fingerprint;
      fileIdentity = committed.identity; directoryIdentity = folderId;
    } catch (error) {
      if (error.code === 'QUICK_IMPORT_CANCELLED') throw error;
      throw problem();
    } finally {
      if (temporary && temporaryId) {
        try { if (await checkedDirectory() === folderId && stamp(await fs.lstat(temporary, { bigint: true })) === temporaryId) await fs.unlink(temporary); } catch { /* Preserve files we cannot prove ownership of. */ }
      }
      if (lock) {
        try { if (await checkedDirectory() === folderId && stamp(await fs.lstat(lockFile, { bigint: true })) === lockId
            && stamp(await lock.stat({ bigint: true })) === lockId) await fs.unlink(lockFile); } catch { /* Never remove a foreign lock. */ }
        await lock.close().catch(() => {});
      }
    }
  }
  function save(next, guard = () => {}) {
    let candidate;
    try { candidate = document(next); } catch { return Promise.reject(problem()); }
    const task = serial.then(async () => {
      await load();
      if (!canWrite) throw problem();
      await persist(candidate, guard);
      return status();
    });
    serial = task.catch(() => {}); return task;
  }
  return Object.freeze({ load, save, status, flush: () => serial });
}

module.exports = { createQuickImportPreferences, validateLocalQuickImportPath: localPath };
