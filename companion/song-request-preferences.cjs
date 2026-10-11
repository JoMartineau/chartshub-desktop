'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { INSTRUMENTS, DIFFICULTIES, DEFAULT_RULES } = require('./song-requests.cjs');

const MAX_BYTES = 8 * 1024;
const TOKEN = /^[a-f0-9]{64}$/;
const INVALID = 'Les réglages Song Request sont invalides.';
const UNREADABLE = 'Les réglages Song Request sont illisibles ou non sûrs. Le fichier original est conservé.';
const FUTURE = 'Les réglages Song Request proviennent d’une version plus récente. Le fichier original est conservé.';
const CHANGED = 'Les réglages Song Request ont changé sur disque. Rouvrez le Companion pour les recharger.';
const WRITE_FAILED = 'Les réglages Song Request n’ont pas pu être enregistrés. Le fichier original est conservé.';
const safe = message => Object.assign(new Error(message), { code: 'SONG_REQUEST_PREFERENCES_SAFE' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key));
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const identity = stat => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const folderIdentity = stat => `${stat.dev}:${stat.ino}:${stat.mode}`;
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');

function settings(value) {
  if (!keys(value, ['port', 'rules']) || !Number.isSafeInteger(value.port) || value.port < 1024 || value.port > 65535
      || !keys(value.rules, ['maxDurationMinutes', 'instrument', 'difficulty'])) throw safe(INVALID);
  const rules = value.rules;
  if ((rules.maxDurationMinutes !== null && (!Number.isSafeInteger(rules.maxDurationMinutes) || rules.maxDurationMinutes < 1 || rules.maxDurationMinutes > 60))
      || !INSTRUMENTS.includes(rules.instrument) || !DIFFICULTIES.includes(rules.difficulty)) throw safe(INVALID);
  return { port: value.port, rules: { maxDurationMinutes: rules.maxDurationMinutes, instrument: rules.instrument, difficulty: rules.difficulty } };
}
function validateDocument(value) {
  if (!keys(value, ['version', 'port', 'rules', 'ingestToken', 'readToken']) || value.version !== 1
      || typeof value.ingestToken !== 'string' || typeof value.readToken !== 'string'
      || !TOKEN.test(value.ingestToken) || !TOKEN.test(value.readToken) || value.ingestToken === value.readToken) throw safe(INVALID);
  return { version: 1, ...settings({ port: value.port, rules: value.rules }), ingestToken: value.ingestToken, readToken: value.readToken };
}

/** Persistent local capabilities and preferences only; reception and queue remain session state. */
function createSongRequestPreferences({ dataDirectory } = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory) || dataDirectory.includes('\0')) throw safe(INVALID);
  const directory = path.resolve(dataDirectory), filename = path.join(directory, 'song-request-access.json');
  const lockPath = path.join(directory, '.song-request-access.lock');
  let document = { version: 1, port: 38474, rules: { ...DEFAULT_RULES }, ingestToken: null, readToken: null };
  let loaded = false, loadTask = null, protectedFile = false, error = null;
  let diskFingerprint = null, diskIdentity = null, directoryIdentity = null, serial = Promise.resolve();
  const status = () => ({ port: document.port, rules: { ...document.rules }, ingestToken: document.ingestToken, readToken: document.readToken, error });

  async function checkedDirectory(create = false) {
    const root = path.parse(directory).root; let current = root;
    for (const part of directory.slice(root.length).split(path.sep).filter(Boolean)) {
      if (/[. ]$/.test(part)) throw safe(UNREADABLE);
      current = path.join(current, part);
      let stat;
      try { stat = await fs.lstat(current, { bigint: true }); }
      catch (problem) {
        if (problem.code !== 'ENOENT') throw problem;
        if (!create) return null;
        try { await fs.mkdir(current); } catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
        stat = await fs.lstat(current, { bigint: true });
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw safe(UNREADABLE);
    }
    if (!samePath(await fs.realpath(directory), directory)) throw safe(UNREADABLE);
    return folderIdentity(await fs.lstat(directory, { bigint: true }));
  }
  async function checkedFile() {
    try {
      const stat = await fs.lstat(filename, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(MAX_BYTES)
          || !samePath(await fs.realpath(filename), filename)) throw safe(UNREADABLE);
      return stat;
    } catch (problem) { if (problem.code === 'ENOENT') return null; throw problem; }
  }
  async function read() {
    const directoryId = await checkedDirectory();
    if (directoryId === null) return null;
    const before = await checkedFile();
    if (!before) return null;
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (identity(await handle.stat({ bigint: true })) !== identity(before)) throw safe(UNREADABLE);
      const bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
      while (length < bytes.length) {
        const part = await handle.read(bytes, length, bytes.length - length, length);
        if (!part.bytesRead) break;
        length += part.bytesRead;
      }
      const after = await checkedFile();
      if (length !== Number(before.size) || !after || identity(after) !== identity(before)
          || identity(await handle.stat({ bigint: true })) !== identity(before) || await checkedDirectory() !== directoryId) throw safe(UNREADABLE);
      const contents = bytes.subarray(0, length);
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(contents).replace(/^\uFEFF/, ''); }
      catch { throw safe(UNREADABLE); }
      return { fingerprint: fingerprint(contents), identity: identity(before), directoryId,
        text };
    } finally { await handle.close(); }
  }
  function protect(message) { protectedFile = true; error = message; return safe(message); }
  async function persist(next) {
    const bytes = Buffer.from(JSON.stringify(next) + '\n', 'utf8');
    if (bytes.length > MAX_BYTES) throw safe(INVALID);
    let lock = null, directoryId = null, temporary = null, temporaryId = null;
    try {
      directoryId = await checkedDirectory(directoryIdentity === null);
      if (directoryIdentity !== null && directoryId !== directoryIdentity) throw protect(CHANGED);
      lock = await fs.open(lockPath, 'wx', 0o600);
      const prior = await read();
      if ((prior?.fingerprint ?? null) !== diskFingerprint || (prior?.identity ?? null) !== diskIdentity) throw protect(CHANGED);
      temporary = path.join(directory, `.song-request-access-${randomBytes(16).toString('hex')}.tmp`);
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        temporaryId = identity(await handle.stat({ bigint: true }));
        await handle.writeFile(bytes); await handle.sync();
      } finally {
        temporaryId = await handle.stat({ bigint: true }).then(identity, () => temporaryId);
        await handle.close();
      }
      const current = await checkedFile();
      if ((current ? identity(current) : null) !== (prior?.identity ?? null) || await checkedDirectory() !== directoryId
          || identity(await fs.lstat(temporary, { bigint: true })) !== temporaryId) throw protect(CHANGED);
      await fs.rename(temporary, filename); temporary = null;
      const committed = await read();
      if (!committed || committed.fingerprint !== fingerprint(bytes) || committed.directoryId !== directoryId) throw protect(CHANGED);
      document = next; diskFingerprint = committed.fingerprint; diskIdentity = committed.identity; directoryIdentity = directoryId; error = null;
    } catch (problem) {
      if (problem.code === 'SONG_REQUEST_PREFERENCES_SAFE') {
        if (problem.message === UNREADABLE) protectedFile = true;
        error = problem.message; throw safe(error);
      }
      error = WRITE_FAILED; throw safe(error);
    } finally {
      if (temporary && temporaryId) {
        try { if (await checkedDirectory() === directoryId && identity(await fs.lstat(temporary, { bigint: true })) === temporaryId) await fs.unlink(temporary); } catch { /* Preserve replacements whose ownership is no longer provable. */ }
      }
      if (lock) {
        try { if (await checkedDirectory() === directoryId && identity(await fs.lstat(lockPath, { bigint: true })) === identity(await lock.stat({ bigint: true }))) await fs.unlink(lockPath); } catch { /* Never remove another writer's lock. */ }
        await lock.close().catch(() => {});
      }
    }
  }
  async function load() {
    if (loaded) return status();
    if (loadTask) return loadTask;
    loadTask = (async () => {
      try {
        const source = await read();
        if (source) {
          const value = JSON.parse(source.text);
          if (object(value) && Number.isFinite(value.version) && value.version > 1) throw protect(FUTURE);
          document = validateDocument(value); diskFingerprint = source.fingerprint; diskIdentity = source.identity; directoryIdentity = source.directoryId;
        } else {
          const ingestToken = randomBytes(32).toString('hex');
          let readToken; do { readToken = randomBytes(32).toString('hex'); } while (readToken === ingestToken);
          await persist({ ...document, rules: { ...document.rules }, ingestToken, readToken });
        }
      } catch (problem) {
        protectedFile = true;
        error = problem.code === 'SONG_REQUEST_PREFERENCES_SAFE' && [FUTURE, CHANGED, WRITE_FAILED].includes(problem.message) ? problem.message : UNREADABLE;
      }
      loaded = true; return status();
    })();
    try { return await loadTask; } finally { loadTask = null; }
  }
  function save(input) {
    let nextSettings;
    try { nextSettings = settings(structuredClone(input)); } catch { return Promise.reject(safe(INVALID)); }
    const task = serial.then(async () => {
      await load();
      if (protectedFile) throw safe(error ?? UNREADABLE);
      await persist({ ...document, ...nextSettings });
      return status();
    });
    serial = task.catch(() => {}); return task;
  }
  async function flush() { await serial; if (loadTask) await loadTask; return status(); }
  return { load, status, save, flush };
}

module.exports = { createSongRequestPreferences };
