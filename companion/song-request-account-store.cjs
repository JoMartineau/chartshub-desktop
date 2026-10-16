'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

const MAX_BYTES = 64 * 1024;
const MAX_PLAINTEXT = 32 * 1024;
const CREDENTIAL_KEYS = ['accessToken', 'refreshToken', 'expiresAt', 'clientId', 'userId', 'login', 'displayName', 'scopes'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).length === allowed.length
  && Object.keys(value).every(key => allowed.includes(key));
const safeError = code => Object.assign(new Error('Song Request account storage is unavailable.'), { code: 'SONG_REQUEST_ACCOUNT_STORE_SAFE', reason: code });
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const identity = stat => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const folderIdentity = stat => `${stat.dev}:${stat.ino}:${stat.mode}`;
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');
const ascii = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum && /^[\x21-\x7e]+$/.test(value);

function credential(value) {
  if (!keys(value, CREDENTIAL_KEYS) || !ascii(value.accessToken, 8192)
      || !(value.refreshToken === null || ascii(value.refreshToken, 8192))
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0
      || !ascii(value.clientId, 128) || !/^[a-zA-Z0-9]+$/.test(value.clientId)
      || typeof value.userId !== 'string' || !/^[0-9]{1,32}$/.test(value.userId)
      || typeof value.login !== 'string' || !/^[a-z0-9_]{1,25}$/.test(value.login)
      || typeof value.displayName !== 'string' || value.displayName.length > 80 || !value.displayName.trim()
      || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value.displayName)
      || !Array.isArray(value.scopes) || value.scopes.length > 32 || new Set(value.scopes).size !== value.scopes.length
      || !value.scopes.every(scope => typeof scope === 'string' && /^[a-z][a-z0-9_:]{0,127}$/.test(scope))) {
    throw safeError('invalid_credential');
  }
  return { accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt: value.expiresAt,
    clientId: value.clientId, userId: value.userId, login: value.login, displayName: value.displayName,
    scopes: [...value.scopes] };
}
function document(value) {
  if (object(value) && Number.isFinite(value.version) && value.version > 1) throw safeError('future_version');
  if (!keys(value, ['version', 'accounts']) || value.version !== 1 || !object(value.accounts)
      || Object.keys(value.accounts).some(key => key !== 'twitch')) throw safeError('unreadable');
  return { version: 1, accounts: Object.hasOwn(value.accounts, 'twitch') ? { twitch: credential(value.accounts.twitch) } : {} };
}

/** Platform credentials stay in the main process; only status() is suitable for renderer snapshots. */
function createSongRequestAccountStore({ dataDirectory, safeStorage } = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory) || dataDirectory.includes('\0')) throw safeError('invalid_directory');
  const directory = path.resolve(dataDirectory);
  const filename = path.join(directory, 'song-request-accounts.enc');
  const lockPath = path.join(directory, '.song-request-accounts.lock');
  let state = { version: 1, accounts: {} }, loaded = false, loadTask = null, serial = Promise.resolve();
  let sessionOnly = false, protectedFile = false, error = null;
  let diskFingerprint = null, diskIdentity = null, directoryIdentity = null;

  function encryptionAvailable() {
    try {
      return typeof safeStorage?.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable() === true
        && typeof safeStorage.encryptString === 'function' && typeof safeStorage.decryptString === 'function'
        && !(typeof safeStorage.getSelectedStorageBackend === 'function' && safeStorage.getSelectedStorageBackend() === 'basic_text');
    } catch { return false; }
  }
  const status = () => ({ persistent: !sessionOnly && !protectedFile && encryptionAvailable(), error });
  function protect(code) { protectedFile = true; error = code; return safeError(code); }

  async function checkedDirectory(create = false) {
    const root = path.parse(directory).root; let current = root;
    for (const part of directory.slice(root.length).split(path.sep).filter(Boolean)) {
      if (/[. ]$/.test(part)) throw safeError('unreadable');
      current = path.join(current, part);
      let stat;
      try { stat = await fs.lstat(current, { bigint: true }); }
      catch (problem) {
        if (problem.code !== 'ENOENT') throw problem;
        if (!create) return null;
        try { await fs.mkdir(current); } catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
        stat = await fs.lstat(current, { bigint: true });
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw safeError('unreadable');
    }
    if (!samePath(await fs.realpath(directory), directory)) throw safeError('unreadable');
    return folderIdentity(await fs.lstat(directory, { bigint: true }));
  }
  async function checkedFile() {
    try {
      const stat = await fs.lstat(filename, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 1n || stat.size > BigInt(MAX_BYTES)
          || !samePath(await fs.realpath(filename), filename)) throw safeError('unreadable');
      return stat;
    } catch (problem) { if (problem.code === 'ENOENT') return null; throw problem; }
  }
  async function read() {
    const directoryId = await checkedDirectory();
    if (directoryId === null) return { directoryId, file: null };
    const before = await checkedFile();
    if (!before) return { directoryId, file: null };
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (identity(await handle.stat({ bigint: true })) !== identity(before)) throw safeError('unreadable');
      const bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
      while (length < bytes.length) {
        const part = await handle.read(bytes, length, bytes.length - length, length);
        if (!part.bytesRead) break;
        length += part.bytesRead;
      }
      const after = await checkedFile();
      if (length !== Number(before.size) || !after || identity(after) !== identity(before)
          || identity(await handle.stat({ bigint: true })) !== identity(before)
          || await checkedDirectory() !== directoryId) throw safeError('unreadable');
      const contents = bytes.subarray(0, length);
      return { directoryId, file: { bytes: contents, fingerprint: fingerprint(contents), identity: identity(before) } };
    } finally { await handle.close(); }
  }
  async function persist(next) {
    let lock = null, directoryId = null, temporary = null, temporaryId = null;
    try {
      const plaintext = JSON.stringify(next);
      if (Buffer.byteLength(plaintext) > MAX_PLAINTEXT) throw safeError('invalid_credential');
      if (!encryptionAvailable()) { sessionOnly = true; error = 'encryption_unavailable'; state = next; return; }
      const bytes = safeStorage.encryptString(plaintext);
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) throw safeError('write_failed');
      directoryId = await checkedDirectory(directoryIdentity === null);
      if (directoryIdentity !== null && directoryId !== directoryIdentity) throw protect('changed');
      lock = await fs.open(lockPath, 'wx', 0o600);
      const prior = await read();
      if (prior.directoryId !== directoryId || (prior.file?.fingerprint ?? null) !== diskFingerprint
          || (prior.file?.identity ?? null) !== diskIdentity) throw protect('changed');
      temporary = path.join(directory, `.song-request-accounts-${randomBytes(16).toString('hex')}.tmp`);
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        temporaryId = identity(await handle.stat({ bigint: true }));
        await handle.writeFile(bytes); await handle.sync();
      } finally {
        temporaryId = await handle.stat({ bigint: true }).then(identity, () => temporaryId);
        await handle.close();
      }
      const current = await checkedFile();
      if ((current ? identity(current) : null) !== (prior.file?.identity ?? null)
          || await checkedDirectory() !== directoryId
          || identity(await fs.lstat(temporary, { bigint: true })) !== temporaryId) throw protect('changed');
      await fs.rename(temporary, filename); temporary = null;
      const committed = await read();
      if (!committed.file || committed.file.fingerprint !== fingerprint(bytes) || committed.directoryId !== directoryId) throw protect('changed');
      state = next; diskFingerprint = committed.file.fingerprint; diskIdentity = committed.file.identity;
      directoryIdentity = directoryId; error = null;
    } catch (problem) {
      if (problem.code === 'SONG_REQUEST_ACCOUNT_STORE_SAFE') {
        if (problem.reason === 'unreadable') protectedFile = true;
        error = problem.reason;
      } else error = 'write_failed';
      throw safeError(error);
    } finally {
      if (temporary && temporaryId) {
        try { if (await checkedDirectory() === directoryId && identity(await fs.lstat(temporary, { bigint: true })) === temporaryId) await fs.unlink(temporary); } catch { /* Preserve any unprovable replacement. */ }
      }
      if (lock) {
        try { if (await checkedDirectory() === directoryId && identity(await fs.lstat(lockPath, { bigint: true })) === identity(await lock.stat({ bigint: true }))) await fs.unlink(lockPath); } catch { /* Never remove another writer's lock. */ }
        await lock.close().catch(() => {});
      }
    }
  }
  async function load() {
    if (loaded) return;
    if (loadTask) return loadTask;
    loadTask = (async () => {
      if (!encryptionAvailable()) { sessionOnly = true; error = 'encryption_unavailable'; loaded = true; return; }
      try {
        const source = await read();
        if (source.file) {
          const plaintext = safeStorage.decryptString(source.file.bytes);
          if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > MAX_PLAINTEXT) throw safeError('unreadable');
          state = document(JSON.parse(plaintext));
        }
        diskFingerprint = source.file?.fingerprint ?? null; diskIdentity = source.file?.identity ?? null;
        directoryIdentity = source.directoryId; error = null;
      } catch (problem) {
        protectedFile = true;
        error = problem.code === 'SONG_REQUEST_ACCOUNT_STORE_SAFE' && problem.reason === 'future_version' ? 'future_version' : 'unreadable';
      }
      loaded = true;
    })();
    try { await loadTask; } finally { loadTask = null; }
  }
  function get(provider) {
    if (provider !== 'twitch') throw safeError('invalid_provider');
    return state.accounts.twitch ? credential(state.accounts.twitch) : null;
  }
  function set(provider, value) {
    let captured;
    try {
      if (provider !== 'twitch') throw safeError('invalid_provider');
      captured = value === null ? null : credential(value);
    } catch { return Promise.reject(safeError('invalid_credential')); }
    const task = serial.then(async () => {
      await load();
      if (protectedFile) throw safeError(error ?? 'unreadable');
      const next = { version: 1, accounts: captured === null ? {} : { twitch: captured } };
      if (sessionOnly) { state = next; return; }
      await persist(next);
    });
    serial = task.catch(() => {}); return task;
  }
  async function flush() { await serial; if (loadTask) await loadTask; }
  return { load, get, set, status, flush };
}

module.exports = { createSongRequestAccountStore };
