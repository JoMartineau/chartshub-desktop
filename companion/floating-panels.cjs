'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

const MAX_BYTES = 16 * 1024;
const PANELS = ['catalogue', 'filters'];
const FONTS = ['system', 'arial', 'verdana', 'georgia', 'consolas'];
const DEFAULT_APPEARANCE = Object.freeze({ backgroundColor: '#151719e6', textColor: '#eef1f2', fontFamily: 'system', fontSize: 14 });
const INVALID = 'Les réglages de la fenêtre flottante sont invalides.';
const UNREADABLE = 'Les réglages des fenêtres flottantes sont illisibles ou invalides. Le fichier original est conservé.';
const FUTURE = 'Les réglages des fenêtres flottantes proviennent d’une version plus récente. Le fichier original est conservé.';
const CHANGED = 'Les réglages des fenêtres flottantes ont changé sur disque. Rouvrez le Companion pour les recharger.';
const WRITE_FAILED = 'Les réglages des fenêtres flottantes n’ont pas pu être enregistrés. Les réglages précédents sont conservés.';
const safe = message => Object.assign(new Error(message), { code: 'FLOATING_PANELS_SAFE' });
const stale = () => Object.assign(new Error('Les réglages des fenêtres flottantes ont changé. Rechargez-les avant de réessayer.'), { code: 'STALE_FLOATING_PANELS' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key));
const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (left, right) => canonical(left) === canonical(right);
const identity = stat => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const folderIdentity = stat => `${stat.dev}:${stat.ino}:${stat.mode}`;
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');

/** Independent appearance settings: overlay widgets, themes and profiles are never changed. */
function createFloatingPanels({ dataDirectory } = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory) || dataDirectory.includes('\0')) throw safe(INVALID);
  const directory = path.resolve(dataDirectory), filename = path.join(directory, 'floating-panels.json'), lockPath = path.join(directory, '.floating-panels.lock');
  let document = { version: 1, revision: 0, appearance: { catalogue: { ...DEFAULT_APPEARANCE }, filters: { ...DEFAULT_APPEARANCE } } };
  let loaded = false, loadTask = null, protectedFile = false, diskFingerprint = null, error = null, serial = Promise.resolve(), normalizeColor;

  function status() { return { revision: document.revision, appearance: structuredClone(document.appearance), error, canWrite: !protectedFile }; }
  function appearance(value) {
    if (!keys(value, ['backgroundColor', 'textColor', 'fontFamily', 'fontSize']) || typeof value.backgroundColor !== 'string' || typeof value.textColor !== 'string'
      || !FONTS.includes(value.fontFamily) || !Number.isInteger(value.fontSize) || value.fontSize < 10 || value.fontSize > 24) throw safe(INVALID);
    const backgroundColor = normalizeColor(value.backgroundColor), textColor = normalizeColor(value.textColor);
    if (!backgroundColor || !textColor || textColor.length !== 7) throw safe(INVALID);
    return { backgroundColor, textColor, fontFamily: value.fontFamily, fontSize: value.fontSize };
  }
  function validateDocument(value) {
    if (!keys(value, ['version', 'revision', 'appearance']) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !keys(value.appearance, PANELS)) throw safe(INVALID);
    return { version: 1, revision: value.revision, appearance: { catalogue: appearance(value.appearance.catalogue), filters: appearance(value.appearance.filters) } };
  }
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
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(MAX_BYTES) || !samePath(await fs.realpath(filename), filename)) throw safe(UNREADABLE);
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
      while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, length); if (!result.bytesRead) break; length += result.bytesRead; }
      const after = await checkedFile();
      if (length !== Number(before.size) || identity(await handle.stat({ bigint: true })) !== identity(before) || !after || identity(after) !== identity(before) || await checkedDirectory() !== directoryId) throw safe(UNREADABLE);
      const contents = bytes.subarray(0, length);
      return { fingerprint: fingerprint(contents), identity: identity(before), text: new TextDecoder('utf-8', { fatal: true }).decode(contents).replace(/^\uFEFF/, '') };
    } finally { await handle.close(); }
  }
  async function load() {
    if (loaded) return status();
    if (loadTask) return loadTask;
    loadTask = (async () => {
      try {
        ({ normalizeColor } = await import('./dist/themes/normalizeColor.js'));
        const source = await read();
        if (source) {
          const value = JSON.parse(source.text);
          if (object(value) && Number.isFinite(value.version) && value.version > 1) { protectedFile = true; error = FUTURE; }
          else { document = validateDocument(value); diskFingerprint = source.fingerprint; }
        }
      } catch (_) { protectedFile = true; error = UNREADABLE; }
      loaded = true; return status();
    })();
    try { return await loadTask; } finally { loadTask = null; }
  }
  async function persist(next) {
    let lock = null, directoryId = null, temporary = null, temporaryId = null;
    const text = JSON.stringify(next) + '\n';
    if (Buffer.byteLength(text) > MAX_BYTES) throw safe(INVALID);
    try {
      directoryId = await checkedDirectory(true);
      lock = await fs.open(lockPath, 'wx', 0o600);
      const prior = await read();
      if ((prior?.fingerprint ?? null) !== diskFingerprint) { protectedFile = true; error = CHANGED; throw safe(error); }
      temporary = path.join(directory, `.floating-panels-${randomBytes(16).toString('hex')}.tmp`);
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(text, 'utf8'); await handle.sync(); temporaryId = identity(await handle.stat({ bigint: true })); }
      finally { await handle.close(); }
      const current = await checkedFile();
      if ((current ? identity(current) : null) !== (prior?.identity ?? null) || await checkedDirectory() !== directoryId
        || identity(await fs.lstat(temporary, { bigint: true })) !== temporaryId) { protectedFile = true; error = CHANGED; throw safe(error); }
      await fs.rename(temporary, filename); temporary = null;
      // Renaming is the commit point; cleanup failures never negate a saved setting.
      document = next; diskFingerprint = fingerprint(text); error = null;
    } catch (problem) {
      if (problem.code === 'FLOATING_PANELS_SAFE') { error ||= WRITE_FAILED; throw safe(error); }
      error = WRITE_FAILED; throw safe(error);
    } finally {
      if (temporary && temporaryId) {
        try { if (await checkedDirectory() === directoryId && identity(await fs.lstat(temporary, { bigint: true })) === temporaryId) await fs.unlink(temporary); } catch (_) { /* Preserve ambiguous replacements. */ }
      }
      if (lock) {
        try { if (await checkedDirectory() === directoryId && identity(await fs.lstat(lockPath, { bigint: true })) === identity(await lock.stat({ bigint: true }))) await fs.unlink(lockPath); } catch (_) { /* Never remove another writer's lock. */ }
        await lock.close().catch(() => {});
      }
    }
  }
  function update(input) {
    let snapshot;
    try { snapshot = structuredClone(input); } catch (_) { return Promise.reject(safe(INVALID)); }
    const task = serial.then(async () => {
      await load();
      if (protectedFile) throw safe(error ?? UNREADABLE);
      if (!keys(snapshot, ['revision', 'panel', 'appearance']) || !PANELS.includes(snapshot.panel)) throw safe(INVALID);
      if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw safe(INVALID);
      if (snapshot.revision !== document.revision) throw stale();
      const value = appearance(snapshot.appearance);
      if (document.revision === Number.MAX_SAFE_INTEGER) throw safe(INVALID);
      await persist({ version: 1, revision: document.revision + 1, appearance: { ...document.appearance, [snapshot.panel]: value } });
      return status();
    });
    serial = task.catch(() => {}); return task;
  }
  async function flush() { await serial; if (loadTask) await loadTask; return status(); }
  return { load, status, update, flush };
}

module.exports = { createFloatingPanels };
