'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/, MAX_IDS = 20000, MAX_BYTES = MAX_IDS * 515 + 64;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
const unchanged = (a, b) => a.kind === b.kind && (!a.directory || a.directory === b.directory)
  && (a.kind === 'missing' || a.identity === b.identity && a.sha256 === b.sha256 && a.size === b.size && a.mtime === b.mtime);
function validateFavorites(value) {
  if (!object(value) || Object.keys(value).length !== 2 || value.version !== 1 || !Array.isArray(value.ids) || value.ids.length > MAX_IDS
    || value.ids.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(value.ids).size !== value.ids.length) throw Error('Invalid favorites');
  return new Set(value.ids);
}

/** Local preferences only. An unreadable/newer/externally changed file is never replaced. */
function createCatalogueFavorites({ dataDirectory, io = fs } = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) throw Error('Dossier des favoris invalide.');
  const directory = path.resolve(dataDirectory), filename = path.join(directory, 'favorites.json');
  let ids = new Set(), baseline = null, loaded = false, loading = null, serial = Promise.resolve(), active = true, epoch = 0, warning = null;
  async function safeDirectory(create = false) {
    let current = path.parse(directory).root, stat = await io.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe favorites directory');
    for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { stat = await io.lstat(current); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!create) return null;
        await io.mkdir(current); stat = await io.lstat(current);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe favorites directory');
    }
    return identity(stat);
  }
  async function readSnapshot() {
    const directoryIdentity = await safeDirectory();
    if (!directoryIdentity) return { kind: 'missing', directory: null };
    let before;
    try { before = await io.lstat(filename); }
    catch (error) { if (error.code === 'ENOENT') return { kind: 'missing', directory: directoryIdentity }; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES) throw Error('Unsafe favorites file');
    const handle = await io.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || identity(opened) !== identity(before) || opened.size !== before.size) throw Error('Favorites changed while opening');
      const chunks = []; let size = 0;
      for (;;) {
        const bytes = Buffer.alloc(Math.min(65536, MAX_BYTES + 1 - size));
        const read = await handle.read(bytes, 0, bytes.length, null);
        if (!read.bytesRead) break;
        size += read.bytesRead; if (size > MAX_BYTES) throw Error('Favorites file too large');
        chunks.push(bytes.subarray(0, read.bytesRead));
      }
      const after = await handle.stat(), bytes = Buffer.concat(chunks);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size || await safeDirectory() !== directoryIdentity) throw Error('Favorites changed while reading');
      return { kind: 'file', directory: directoryIdentity, identity: identity(after), size: bytes.length, mtime: after.mtimeMs, sha256: hash(bytes), bytes };
    } finally { await handle.close(); }
  }
  async function load() {
    if (loaded) return status();
    if (loading) return loading;
    loading = (async () => {
      try {
        baseline = await readSnapshot();
        if (baseline.kind === 'file') {
          const value = JSON.parse(baseline.bytes.toString('utf8'));
          if (object(value) && Number.isInteger(value.version) && value.version > 1) {
            warning = 'Les favoris proviennent d’une version plus récente. Leur fichier reste protégé.';
          } else ids = validateFavorites(value);
        }
      } catch { warning = 'Le fichier des favoris est illisible ou son chemin est invalide. Il reste protégé.'; }
      loaded = true; return status();
    })();
    return loading;
  }
  function status() { return { warning, count: ids.size }; }
  function has(id) { return ids.has(id); }
  function assertActive(expected, guard) {
    if (!active || epoch !== expected) throw Error('Les favoris sont arrêtés. Rouvrez le panneau pour continuer.');
    guard?.();
    if (warning) throw Error(warning);
  }
  async function checkBaseline() {
    const current = await readSnapshot();
    if (!baseline || !unchanged(baseline, current)) {
      warning = 'Le fichier des favoris a changé depuis son chargement. Il reste conservé ; redémarrez le Companion.';
      throw Error(warning);
    }
    return current;
  }
  async function removeOwned(target, expectedIdentity) {
    if (!expectedIdentity) return;
    try {
      const stat = await io.lstat(target);
      if (stat.isFile() && !stat.isSymbolicLink() && identity(stat) === expectedIdentity) await io.unlink(target);
    } catch (error) { if (error.code !== 'ENOENT') console.warn('Le fichier temporaire des favoris reste conservé.'); }
  }
  function set(payload, guard) {
    if (!object(payload) || Object.keys(payload).length !== 2 || Object.keys(payload).some(key => !['chartId', 'favorite'].includes(key))) return Promise.reject(Error('Favori invalide.'));
    const { chartId, favorite } = payload;
    if (typeof chartId !== 'string' || !ID.test(chartId) || typeof favorite !== 'boolean') return Promise.reject(Error('Favori invalide.'));
    const expected = epoch;
    const operation = serial.then(async () => {
      assertActive(expected, guard); await load(); assertActive(expected, guard);
      await checkBaseline(); assertActive(expected, guard);
      if (ids.has(chartId) === favorite) return { chartId, favorite, changed: false };
      const next = new Set(ids); if (favorite) next.add(chartId); else next.delete(chartId);
      if (next.size > MAX_IDS) throw Error('La limite de 20 000 favoris est atteinte.');
      const bytes = Buffer.from(JSON.stringify({ version: 1, ids: [...next].sort() }) + '\n');
      const directoryIdentity = await safeDirectory(true);
      if (baseline.directory && baseline.directory !== directoryIdentity) throw Error('Le dossier des favoris a changé.');
      const temporary = filename + '.' + randomUUID() + '.tmp', lock = filename + '.lock';
      let lockHandle, handle, temporaryIdentity, lockIdentity;
      try {
        lockHandle = await io.open(lock, 'wx', 0o600); lockIdentity = identity(await lockHandle.stat());
        assertActive(expected, guard); await checkBaseline(); assertActive(expected, guard);
        handle = await io.open(temporary, 'wx', 0o600); temporaryIdentity = identity(await handle.stat());
        await handle.writeFile(bytes); await handle.sync();
        const written = await handle.stat(); await handle.close(); handle = null;
        assertActive(expected, guard); await checkBaseline(); assertActive(expected, guard);
        if (await safeDirectory() !== directoryIdentity) throw Error('Le dossier des favoris a changé.');
        assertActive(expected, guard);
        if (baseline.kind === 'missing') {
          // Exclusive publication refuses a file created by another process.
          await io.link(temporary, filename);
        } else await io.rename(temporary, filename);
        ids = next;
        baseline = { kind: 'file', directory: directoryIdentity, identity: identity(written), size: bytes.length, mtime: written.mtimeMs, sha256: hash(bytes) };
        return { chartId, favorite, changed: true };
      } finally {
        await handle?.close().catch(() => {});
        await lockHandle?.close().catch(() => {});
        await removeOwned(temporary, temporaryIdentity); await removeOwned(lock, lockIdentity);
      }
    });
    serial = operation.catch(() => {}); return operation;
  }
  async function stop() {
    active = false; const stopped = ++epoch; await serial; await loading;
    if (epoch === stopped) { loaded = false; loading = null; baseline = null; ids = new Set(); warning = null; }
    return status();
  }
  async function start() { active = true; epoch++; await load(); return status(); }
  return { load, start, stop, status, has, set };
}
module.exports = { createCatalogueFavorites, validateFavorites, MAX_IDS };
