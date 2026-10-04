'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const MAX_BYTES = 5 * 1024 * 1024, MAX_PROFILES = 20;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const safe = message => Object.assign(Error(message), { code: 'PROFILE_SAFE' });
const stale = () => Object.assign(Error('Les profils ont changé. Rechargez leur liste avant de réessayer.'), { code: 'STALE_PROFILES' });
const signature = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
const fingerprint = contents => createHash('sha256').update(contents).digest('hex');
const clone = value => structuredClone(value);

function profileName(value) {
  if (typeof value !== 'string' || /\p{Cc}/u.test(value)) throw safe('Le nom du profil doit contenir de 1 à 40 caractères sans caractère de contrôle.');
  const name = value.normalize('NFC').trim();
  if (!name || name.length > 40) throw safe('Le nom du profil doit contenir de 1 à 40 caractères sans caractère de contrôle.');
  return name;
}

/** Canonical JSON compares settings independent of object-key order. */
function canonical(value) {
  const visiting = new Set(); let count = 0;
  function normalized(entry, depth) {
    if (++count > 100000 || depth > 64) throw Error('Profile document limit');
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'string') return entry;
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    if (typeof entry !== 'object' || visiting.has(entry) || (!Array.isArray(entry) && ![Object.prototype, null].includes(Object.getPrototypeOf(entry)))) throw Error('Invalid profile JSON');
    visiting.add(entry);
    const result = Array.isArray(entry) ? entry.map(item => normalized(item, depth + 1)) : Object.fromEntries(Object.keys(entry).sort().map(key => [key, normalized(entry[key], depth + 1)]));
    visiting.delete(entry); return result;
  }
  return JSON.stringify(normalized(value, 0));
}

function createOverlayProfiles({ dataDirectory, validateSettings } = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory) || dataDirectory.includes('\0') || typeof validateSettings !== 'function') throw safe('Configuration des profils invalide.');
  const filename = path.join(dataDirectory, 'overlay-profiles.json');
  let document = { version: 1, revision: 0, items: [] }, loaded = false, loadTask = null, diskFingerprint = null;
  let error = null, protectedFile = false, serial = Promise.resolve();

  function project(input, saved = false) {
    try {
      if (!object(input) || !object(input.stream) || (!saved && input.version !== 3) || (saved && (!keys(input, ['widgets', 'theme', 'stream']) || !keys(input.stream, ['canvas', 'layout'])))) throw Error('Invalid profile document');
      const normalized = validateSettings({ version: 3, widgets: clone(input.widgets), theme: clone(input.theme), stream: { port: 38473, canvas: clone(input.stream.canvas), layout: clone(input.stream.layout) } });
      const result = { widgets: clone(normalized.widgets), theme: clone(normalized.theme), stream: { canvas: clone(normalized.stream.canvas), layout: clone(normalized.stream.layout) } };
      if (Buffer.byteLength(canonical(result)) > MAX_BYTES) throw Error('Profile document limit');
      return result;
    } catch { throw safe('Les réglages de ce profil sont invalides ou trop volumineux.'); }
  }
  function matchingKey(value) { return canonical({ ...value, widgets: value.widgets.map(widget => ({ ...widget, locked: widget.locked ?? false })) }); }
  function status(currentDoc, preferredId) {
    let activeId = null;
    if (currentDoc !== undefined) {
      try {
        const current = matchingKey(project(currentDoc));
        const matching = document.items.filter(item => matchingKey(item.document) === current);
        activeId = matching.find(item => item.id === preferredId)?.id ?? matching[0]?.id ?? null;
      } catch { /* Invalid current settings cannot identify an active profile. */ }
    }
    return { revision: document.revision, items: document.items.map(({ id, name, updatedAt }) => ({ id, name, updatedAt })), activeId, error, canWrite: !protectedFile };
  }
  function validateStored(value) {
    if (!keys(value, ['version', 'revision', 'items']) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.items) || value.items.length > MAX_PROFILES) throw Error('Invalid profiles file');
    const ids = new Set(), names = new Set();
    const items = value.items.map(item => {
      if (!keys(item, ['id', 'name', 'updatedAt', 'document']) || typeof item.id !== 'string' || !UUID.test(item.id) || ids.has(item.id) || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt)) || new Date(item.updatedAt).toISOString() !== item.updatedAt) throw Error('Invalid saved profile');
      const name = profileName(item.name), nameKey = name.toLowerCase();
      if (name !== item.name || names.has(nameKey)) throw Error('Invalid profile names');
      ids.add(item.id); names.add(nameKey);
      return { id: item.id, name, updatedAt: item.updatedAt, document: project(item.document, true) };
    });
    return { version: 1, revision: value.revision, items };
  }
  async function readFile() {
    const before = await fs.lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES) throw Error('Invalid profiles file');
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (signature(await handle.stat()) !== signature(before)) throw Error('Profiles changed');
      const bytes = Buffer.alloc(before.size + 1); let offset = 0;
      while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
      const final = await fs.lstat(filename);
      if (offset !== before.size || signature(await handle.stat()) !== signature(before) || signature(final) !== signature(before) || final.isSymbolicLink()) throw Error('Profiles changed');
      const content = bytes.subarray(0, offset);
      return { bytes: content, text: new TextDecoder('utf-8', { fatal: true }).decode(content).replace(/^\uFEFF/, ''), fingerprint: fingerprint(content) };
    } finally { await handle.close(); }
  }
  async function load() {
    if (loaded) return status();
    if (loadTask) return loadTask;
    loadTask = (async () => {
      try {
        const source = await readFile(), value = JSON.parse(source.text);
        if (object(value) && Number.isFinite(value.version) && value.version > 1) {
          protectedFile = true; error = 'Les profils proviennent d’une version plus récente. Le fichier original est conservé.';
        } else { document = validateStored(value); diskFingerprint = source.fingerprint; }
      } catch (problem) {
        if (problem?.code !== 'ENOENT') { protectedFile = true; error = 'Le fichier des profils est illisible ou invalide. Le fichier original est conservé.'; }
      }
      loaded = true; return status();
    })();
    try { return await loadTask; } finally { loadTask = null; }
  }
  function check(revision) {
    if (protectedFile) throw safe(error);
    if (!Number.isSafeInteger(revision) || revision !== document.revision) throw stale();
  }
  function queue(input, action) {
    let snapshot;
    try { snapshot = clone(input); } catch { return Promise.reject(safe('La demande de profil est invalide.')); }
    const task = serial.then(async () => { await load(); check(snapshot?.revision); return action(snapshot); });
    serial = task.catch(() => {}); return task;
  }
  function find(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw safe('Identifiant de profil invalide.');
    const item = document.items.find(item => item.id === id);
    if (!item) throw safe('Ce profil n’existe plus.');
    return item;
  }
  async function temporary(target, contents) {
    const handle = await fs.open(target, 'wx', 0o600);
    try { await handle.writeFile(contents, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  }
  async function persist(next) {
    const text = JSON.stringify(next);
    if (Buffer.byteLength(text) > MAX_BYTES) throw safe('L’ensemble des profils dépasse la limite de 5 Mo.');
    const nextFingerprint = fingerprint(text);
    const mainTemp = filename + '.' + randomUUID() + '.tmp', backupTemp = filename + '.' + randomUUID() + '.bak.tmp';
    try {
      let previous = null;
      try { previous = await readFile(); } catch (problem) { if (problem?.code !== 'ENOENT') throw problem; }
      if ((previous?.fingerprint ?? null) !== diskFingerprint) {
        protectedFile = true; error = 'Le fichier des profils a changé sur disque. Rouvrez Companion pour le recharger sans l’écraser.'; throw safe(error);
      }
      await fs.mkdir(dataDirectory, { recursive: true });
      await temporary(mainTemp, text);
      if (previous) { await temporary(backupTemp, previous.bytes); await fs.rename(backupTemp, filename + '.bak'); }
      await fs.rename(mainTemp, filename);
      // The rename is the commit point. No fallible filesystem operation may
      // report failure after the new document has replaced the previous one.
      document = next; diskFingerprint = nextFingerprint; error = null;
    } catch (problem) {
      if (problem?.code === 'PROFILE_SAFE') throw problem;
      error = 'Impossible d’enregistrer les profils. Les réglages précédents sont conservés.';
      throw safe(error);
    } finally {
      for (const target of [mainTemp, backupTemp]) await fs.unlink(target).catch(problem => { if (problem?.code !== 'ENOENT') console.warn('Un fichier temporaire des profils n’a pas pu être nettoyé.'); });
    }
  }
  function save(input) {
    return queue(input, async value => {
      if (!keys(value, ['revision', 'id', 'name', 'document'])) throw safe('La demande de profil est invalide.');
      const name = profileName(value.name), existing = value.id === undefined ? null : find(value.id), snapshot = project(value.document);
      if (document.items.some(item => item.id !== existing?.id && item.name.toLowerCase() === name.toLowerCase())) throw safe('Un profil porte déjà ce nom.');
      if (!existing && document.items.length >= MAX_PROFILES) throw safe('Vous pouvez conserver au maximum 20 profils.');
      if (document.revision >= Number.MAX_SAFE_INTEGER) throw safe('La révision des profils a atteint sa limite.');
      const saved = { id: existing?.id ?? randomUUID(), name, updatedAt: new Date().toISOString(), document: snapshot };
      await persist({ version: 1, revision: document.revision + 1, items: [saved, ...document.items.filter(item => item.id !== saved.id)] });
      return { id: saved.id, ...status(value.document, saved.id) };
    });
  }
  function remove(input) {
    return queue(input, async value => {
      if (!keys(value, ['revision', 'id'])) throw safe('La demande de profil est invalide.');
      const item = find(value.id);
      if (document.revision >= Number.MAX_SAFE_INTEGER) throw safe('La révision des profils a atteint sa limite.');
      await persist({ version: 1, revision: document.revision + 1, items: document.items.filter(candidate => candidate.id !== item.id) });
      return status();
    });
  }
  function get(input) {
    return queue(input, value => {
      if (!keys(value, ['revision', 'id'])) throw safe('La demande de profil est invalide.');
      return clone(project(find(value.id).document, true));
    });
  }
  return { load, status, save, remove, get };
}

module.exports = { createOverlayProfiles };
