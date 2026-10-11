'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const DEFAULT_APPEARANCE = Object.freeze({ backgroundColor: '#0b1322', textColor: '#eaf2ff', accentColor: '#22d3ee', secondaryColor: '#a855f7', spectrumModel: 'bars' });

const MAX_BYTES = 256 * 1024;
const PLAYLIST_LIMITS = Object.freeze({ playlists: 20, songsPerPlaylist: 500, totalSongReferences: 2500, nameLength: 100 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SONG_ID = /^[a-f0-9]{64}$/;
const INVALID = 'Les réglages du lecteur sont invalides.';
const UNREADABLE = 'Les réglages du lecteur sont illisibles ou non sûrs. Le fichier original est conservé.';
const FUTURE = 'Les réglages du lecteur proviennent d’une version plus récente. Le fichier original est conservé.';
const CHANGED = 'Les réglages du lecteur ont changé sur disque. Rouvrez le Companion pour les recharger.';
const WRITE_FAILED = 'Les réglages du lecteur n’ont pas pu être enregistrés. Le fichier original est conservé.';
const safe = message => Object.assign(new Error(message), { code: 'MUSIC_PLAYER_PREFERENCES_SAFE' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key));
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const identity = stat => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const folderIdentity = stat => `${stat.dev}:${stat.ino}:${stat.mode}`;
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');

function validateAppearance(value) {
  if (!keys(value, Object.keys(DEFAULT_APPEARANCE)) || !['backgroundColor','textColor','accentColor','secondaryColor'].every(key => typeof value[key] === 'string' && /^#[a-fA-F0-9]{6}$/.test(value[key]))
      || !['bars','curve','circle','mirror'].includes(value.spectrumModel)) throw safe(INVALID);
  return { ...Object.fromEntries(['backgroundColor','textColor','accentColor','secondaryColor'].map(key => [key,value[key].toLowerCase()])), spectrumModel: value.spectrumModel };
}
function settings(value) {
  if (!object(value) || !['appearance','videoEnabled','volume'].every(key => Object.hasOwn(value,key))
      || Object.keys(value).some(key => !['appearance','videoEnabled','volume','shuffle','playlists'].includes(key))
      || typeof value.videoEnabled !== 'boolean' || !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 1
      || (Object.hasOwn(value,'shuffle') && typeof value.shuffle !== 'boolean')) throw safe(INVALID);
  return { appearance: validateAppearance(value.appearance), videoEnabled: value.videoEnabled, volume: value.volume,
    ...(Object.hasOwn(value,'shuffle') ? { shuffle: value.shuffle } : {}),
    ...(Object.hasOwn(value,'playlists') ? { playlists: validatePlaylists(value.playlists) } : {}) };
}
function validatePlaylists(value) {
  if (!Array.isArray(value) || value.length > PLAYLIST_LIMITS.playlists) throw safe(INVALID);
  let total = 0; const ids = new Set();
  return value.map(playlist => {
    if (!keys(playlist,['id','name','rootKey','songIds']) || typeof playlist.id !== 'string' || !UUID.test(playlist.id) || ids.has(playlist.id)
        || typeof playlist.name !== 'string' || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(playlist.name)
        || !playlist.name.trim() || playlist.name.trim().length > PLAYLIST_LIMITS.nameLength
        || typeof playlist.rootKey !== 'string' || !SONG_ID.test(playlist.rootKey)
        || !Array.isArray(playlist.songIds) || playlist.songIds.length > PLAYLIST_LIMITS.songsPerPlaylist
        || playlist.songIds.some(id => typeof id !== 'string' || !SONG_ID.test(id)) || new Set(playlist.songIds).size !== playlist.songIds.length
        || (total += playlist.songIds.length) > PLAYLIST_LIMITS.totalSongReferences) throw safe(INVALID);
    ids.add(playlist.id);
    return { id: playlist.id, name: playlist.name.trim(), rootKey: playlist.rootKey, songIds: [...playlist.songIds] };
  });
}
function validateDocument(value) {
  const legacy = keys(value, ['version','appearance','videoEnabled','volume']);
  if ((!legacy && !keys(value, ['version','appearance','videoEnabled','volume','shuffle','playlists'])) || value.version !== 1) throw safe(INVALID);
  return { version: 1, shuffle: false, playlists: [], ...settings({appearance:value.appearance,videoEnabled:value.videoEnabled,volume:value.volume,
    ...(legacy ? {} : {shuffle:value.shuffle,playlists:value.playlists})}) };
}

/** Only reader preferences and opaque library-scoped playlists persist; no automatic playback. */
function createMusicPlayerPreferences({ dataDirectory } = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory) || dataDirectory.includes('\0')) throw safe(INVALID);
  const directory = path.resolve(dataDirectory), filename = path.join(directory, 'music-player-preferences.json');
  const lockPath = path.join(directory, '.music-player-preferences.lock');
  let document = { version: 1, appearance: { ...DEFAULT_APPEARANCE }, videoEnabled: true, volume: .7, shuffle: false, playlists: [] };
  let loaded = false, loadTask = null, protectedFile = false, error = null;
  let diskFingerprint = null, diskIdentity = null, directoryIdentity = null, serial = Promise.resolve();
  const status = () => ({ appearance: { ...document.appearance }, videoEnabled: document.videoEnabled, volume: document.volume,
    shuffle: document.shuffle, playlists: structuredClone(document.playlists), error, canWrite: !protectedFile });

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
    let lock = null, lockIdentity = null, directoryId = null, temporary = null, temporaryId = null;
    async function checkLock() {
      try {
        const current = await fs.lstat(lockPath, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || identity(current) !== lockIdentity
            || identity(await lock.stat({ bigint: true })) !== lockIdentity) throw protect(CHANGED);
      } catch (problem) { if (problem.code === 'ENOENT') throw protect(CHANGED); throw problem; }
    }
    try {
      directoryId = await checkedDirectory(directoryIdentity === null);
      if (directoryIdentity !== null && directoryId !== directoryIdentity) throw protect(CHANGED);
      lock = await fs.open(lockPath, 'wx', 0o600);
      const acquired = await lock.stat({ bigint: true });
      lockIdentity = identity(acquired);
      if (!acquired.isFile() || acquired.nlink !== 1n || acquired.size !== 0n) throw protect(CHANGED);
      await checkLock();
      const prior = await read();
      if ((prior?.fingerprint ?? null) !== diskFingerprint || (prior?.identity ?? null) !== diskIdentity) throw protect(CHANGED);
      temporary = path.join(directory, `.music-player-preferences-${randomBytes(16).toString('hex')}.tmp`);
      const handle = await fs.open(temporary, 'wx+', 0o600);
      try {
        temporaryId = identity(await handle.stat({ bigint: true }));
        await handle.writeFile(bytes); await handle.sync();
        const written = await handle.stat({ bigint: true });
        if (!written.isFile() || written.nlink !== 1n || written.size !== BigInt(bytes.length)) throw protect(CHANGED);
        const actual = Buffer.alloc(bytes.length + 1); let length = 0;
        while (length < actual.length) {
          const part = await handle.read(actual, length, actual.length - length, length);
          if (!part.bytesRead) break;
          length += part.bytesRead;
        }
        if (length !== bytes.length || !actual.subarray(0, length).equals(bytes)
            || identity(await handle.stat({ bigint: true })) !== identity(written)) throw protect(CHANGED);
      } finally {
        temporaryId = await handle.stat({ bigint: true }).then(identity, () => temporaryId);
        await handle.close();
      }
      const current = await checkedFile();
      await checkLock();
      const candidate = await fs.lstat(temporary, { bigint: true });
      if ((current ? identity(current) : null) !== (prior?.identity ?? null) || await checkedDirectory() !== directoryId
          || !candidate.isFile() || candidate.isSymbolicLink() || candidate.nlink !== 1n || candidate.size !== BigInt(bytes.length)
          || identity(candidate) !== temporaryId) throw protect(CHANGED);
      await fs.rename(temporary, filename); temporary = null;
      const committed = await read();
      if (!committed || committed.fingerprint !== fingerprint(bytes) || committed.directoryId !== directoryId) throw protect(CHANGED);
      document = next; diskFingerprint = committed.fingerprint; diskIdentity = committed.identity; directoryIdentity = directoryId; error = null;
    } catch (problem) {
      if (problem.code === 'MUSIC_PLAYER_PREFERENCES_SAFE') {
        if (problem.message === UNREADABLE) protectedFile = true;
        error = problem.message; throw safe(error);
      }
      error = WRITE_FAILED; throw safe(error);
    } finally {
      if (temporary && temporaryId) {
        try { if (await checkedDirectory() === directoryId && identity(await fs.lstat(temporary, { bigint: true })) === temporaryId) await fs.unlink(temporary); } catch { /* Preserve replacements whose ownership is no longer provable. */ }
      }
      if (lock) {
        try { if (await checkedDirectory() === directoryId && identity(await fs.lstat(lockPath, { bigint: true })) === lockIdentity
            && identity(await lock.stat({ bigint: true })) === lockIdentity) await fs.unlink(lockPath); } catch { /* Never remove another writer's lock. */ }
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
          directoryIdentity = await checkedDirectory();
        }
      } catch (problem) {
        protectedFile = true;
        error = problem.code === 'MUSIC_PLAYER_PREFERENCES_SAFE' && [FUTURE, CHANGED, WRITE_FAILED].includes(problem.message) ? problem.message : UNREADABLE;
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

module.exports = { createMusicPlayerPreferences, DEFAULT_APPEARANCE, validateAppearance, PLAYLIST_LIMITS };
