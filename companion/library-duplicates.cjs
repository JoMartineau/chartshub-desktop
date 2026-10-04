'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { fingerprintChart } = require('./chart-fingerprint.cjs');

const VERSION = 1;
const HEX = /^[a-f0-9]{64}$/;
const CONTEXT = /^[a-f0-9]{32}$/;
const STORE_KEY = /^[a-f0-9]{64}:[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const signature = value => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
const identity = item => {
  const fields = ['title', 'artist', 'charter'].map(field => item[field].normalize('NFC').toLowerCase().trim().replace(/\s+/gu, ' '));
  return fields.every(Boolean) ? JSON.stringify(fields) : null;
};
const safeError = message => Object.assign(new Error(message), { code: 'LIBRARY_COMPARISON_SAFE' });
const staleError = () => safeError('Cette comparaison n’est plus à jour. Recomparez les versions avant de choisir.');
const blockedError = kind => kind === 'changed'
  ? 'Les choix enregistrés ont changé sur disque. Rouvrez Companion pour les recharger sans les écraser.'
  : kind === 'future'
  ? 'Les choix proviennent d’une version plus récente et restent protégés.'
  : 'Les choix enregistrés sont illisibles. Le fichier original est conservé.';

function validateStore(value) {
  if (!object(value) || value.version !== VERSION || Object.keys(value).some(key => !['version', 'choices'].includes(key)) || !object(value.choices)) throw Error('Invalid duplicate choices');
  const choices = Object.create(null);
  for (const [key, choice] of Object.entries(value.choices)) {
    if (!STORE_KEY.test(key) || !object(choice) || Object.keys(choice).length !== 3 || typeof choice.id !== 'string' || !HEX.test(choice.id) || typeof choice.hash !== 'string' || !HEX.test(choice.hash) || !['chart', 'midi'].includes(choice.format)) throw Error('Invalid duplicate choice');
    choices[key] = { id: choice.id, hash: choice.hash, format: choice.format };
  }
  return { version: VERSION, choices };
}

function publicNotes(result) {
  return {
    status: result.status, format: result.format, bytes: result.bytes, modifiedAt: result.modifiedAt,
    reason: result.status === 'readable' ? null : result.status === 'unsupported'
      ? 'Le contenu de notes de cette version ne peut pas être comparé.'
      : 'Le contenu de notes est inaccessible, illisible ou a changé pendant la lecture.'
  };
}

/** Metadata finds candidates; only equal note bytes and format establish a group. */
function createLibraryDuplicates({ dataDirectory, getDocument } = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory) || dataDirectory.includes('\0') || typeof getDocument !== 'function') throw safeError('Configuration de comparaison invalide.');
  const filename = path.join(dataDirectory, 'library-duplicate-choices.json');
  let store = { version: VERSION, choices: Object.create(null) }, loaded = false, loading = null, blocked = null, diskFingerprint = null;
  let context = null, serial = Promise.resolve(), stopping = null;
  const pending = new Set();

  function track(task) {
    pending.add(task);
    task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  }
  function invalidate() {
    context?.controller.abort();
    context = null;
  }
  function assertCurrent(current) {
    const document = getDocument();
    if (context !== current || current.controller.signal.aborted || document.revision !== current.revision || document.settings.rootPath !== current.root || document.items !== current.items) throw staleError();
    return document;
  }
  function ensureReady() {
    if (stopping) throw safeError('La bibliothèque est en cours d’arrêt. Réessayez après son redémarrage.');
  }
  async function readStore(current) {
    const check = () => { if (current) assertCurrent(current); };
    let handle;
    try {
      const before = await fs.lstat(filename, { bigint: true }); check();
      if (!before.isFile() || before.isSymbolicLink()) throw Error('Invalid duplicate choice file');
      handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); check();
      const opened = await handle.stat({ bigint: true }); check();
      if (signature(opened) !== signature(before)) throw Error('Duplicate choice file changed');
      const bytes = await handle.readFile(); check();
      const after = await handle.stat({ bigint: true }); check();
      const final = await fs.lstat(filename, { bigint: true }); check();
      if (signature(after) !== signature(before) || signature(final) !== signature(before) || final.isSymbolicLink()) throw Error('Duplicate choice file changed');
      return { bytes, fingerprint: digest(bytes) };
    } finally { await handle?.close().catch(() => {}); }
  }
  async function load() {
    if (loaded) return;
    if (!loading) loading = (async () => {
      try {
        const source = await readStore();
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes));
        if (object(value) && Number.isInteger(value.version) && value.version > VERSION) { blocked = 'future'; return; }
        store = validateStore(value); diskFingerprint = source.fingerprint;
      } catch (failure) { if (failure?.code !== 'ENOENT') blocked = 'corrupt'; }
      finally { loaded = true; }
    })();
    await loading;
  }
  async function fingerprint(current, item) {
    try {
      const result = await fingerprintChart({ rootPath: current.root, relativePath: item.relativePath, format: item.format, signal: current.controller.signal });
      assertCurrent(current);
      return result;
    } catch (failure) {
      assertCurrent(current);
      if (failure?.name === 'AbortError') throw staleError();
      // A filesystem exception must never expose an absolute song path.
      throw safeError('Impossible de comparer les fichiers de notes. Recomparez les versions.');
    }
  }
  async function unchangedStore(current) {
    let previous = null;
    try { previous = await readStore(current); }
    catch (failure) {
      if (failure?.code === 'LIBRARY_COMPARISON_SAFE') throw failure;
      if (failure?.code !== 'ENOENT') { blocked = 'changed'; throw safeError(blockedError(blocked)); }
    }
    assertCurrent(current);
    if ((previous?.fingerprint ?? null) !== diskFingerprint) { blocked = 'changed'; throw safeError(blockedError(blocked)); }
    return previous;
  }
  async function write(next, current) {
    const temporary = filename + '.' + randomUUID() + '.tmp', backup = filename + '.' + randomUUID() + '.bak.tmp';
    let handle;
    try {
      const previous = await unchangedStore(current); assertCurrent(current);
      const bytes = JSON.stringify(next);
      await fs.mkdir(dataDirectory, { recursive: true }); assertCurrent(current);
      handle = await fs.open(temporary, 'wx', 0o600); assertCurrent(current);
      await handle.writeFile(bytes, 'utf8'); assertCurrent(current);
      await handle.sync(); assertCurrent(current);
      await handle.close(); handle = null; assertCurrent(current);
      if (previous) {
        handle = await fs.open(backup, 'wx', 0o600); assertCurrent(current);
        await handle.writeFile(previous.bytes); assertCurrent(current);
        await handle.sync(); assertCurrent(current);
        await handle.close(); handle = null; assertCurrent(current);
      }
      // Syncing can be slow: preserve edits made by another process during
      // preparation, before publishing either the backup or the main file.
      await unchangedStore(current); assertCurrent(current);
      if (previous) { await fs.rename(backup, filename + '.bak'); assertCurrent(current); }
      await fs.rename(temporary, filename);
      // The atomic rename commits the preference. Record it even if a later
      // invalidation prevents the caller from receiving an old context result.
      store = next; diskFingerprint = digest(bytes);
      assertCurrent(current);
    } finally {
      await handle?.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
      await fs.unlink(backup).catch(() => {});
    }
  }
  async function runComparison(options) {
    ensureReady();
    if (!object(options) || Object.keys(options).some(key => !['id', 'revision'].includes(key)) || typeof options.id !== 'string' || !HEX.test(options.id) || !Number.isSafeInteger(options.revision) || options.revision < 0) throw safeError('Demande de comparaison invalide.');
    const document = getDocument();
    if (options.revision !== document.revision) throw staleError();
    const selected = document.items.find(item => item.id === options.id);
    if (!selected || !document.settings.rootPath) throw staleError();
    const group = identity(selected);
    if (!group) throw safeError('Le titre, l’artiste et le charter doivent être complets pour comparer ces versions.');
    const members = document.items.filter(item => identity(item) === group);
    if (new Set(members.map(item => item.relativePath)).size < 2) throw safeError('Cette chanson ne possède plus de doublon potentiel. Recomparez la bibliothèque.');
    invalidate();
    const current = {
      contextId: randomBytes(16).toString('hex'), revision: document.revision, root: document.settings.rootPath,
      items: document.items, controller: new AbortController(), group,
      key: digest(process.platform === 'win32' ? document.settings.rootPath.toLowerCase() : document.settings.rootPath) + ':' + digest(group),
      members: new Map(members.map(item => [item.id, { id: item.id, relativePath: item.relativePath, format: item.format, audio: item.audio }])),
      fingerprints: new Map(), complete: false
    };
    context = current;
    try {
      await load(); assertCurrent(current);
      // Finish any earlier serialized choice before reading the preference.
      await serial; assertCurrent(current);
      const groups = new Map(), variants = [];
      let readable = 0;
      for (const item of current.members.values()) {
        const notes = await fingerprint(current, item); assertCurrent(current);
        current.fingerprints.set(item.id, notes);
        let noteGroup = null;
        if (notes.status === 'readable') {
          readable++;
          const key = notes.format + ':' + notes.sha256;
          let matching = groups.get(key);
          if (!matching) { matching = { number: groups.size + 1, variants: [] }; groups.set(key, matching); }
          noteGroup = matching.number; matching.variants.push(variants.length);
        }
        variants.push({ ...item, notes: publicNotes(notes), noteGroup, identicalCount: notes.status === 'readable' ? 1 : 0 });
      }
      let identicalGroups = 0;
      for (const matching of groups.values()) {
        if (matching.variants.length > 1) identicalGroups++;
        for (const index of matching.variants) variants[index].identicalCount = matching.variants.length;
      }
      const choice = store.choices[current.key];
      const chosen = choice && current.fingerprints.get(choice.id);
      const preferredId = !blocked && chosen?.status === 'readable' && chosen.sha256 === choice.hash && chosen.format === choice.format ? choice.id : null;
      const selectionError = blocked ? blockedError(blocked) : choice && !preferredId
        ? 'La version à conserver a changé ou est indisponible. Choisissez à nouveau après comparaison.' : null;
      assertCurrent(current); current.complete = true;
      return {
        contextId: current.contextId, revision: current.revision, title: selected.title, artist: selected.artist, charter: selected.charter,
        preferredId, selectionError, canChoose: !blocked,
        summary: { total: variants.length, readable, noteGroups: groups.size, identicalGroups, unverified: variants.length - readable }, variants
      };
    } catch (failure) {
      if (context === current) invalidate();
      if (failure?.code === 'LIBRARY_COMPARISON_SAFE') throw failure;
      throw safeError('Impossible de comparer les versions. Recomparez la bibliothèque.');
    }
  }
  async function runChoice(options) {
    ensureReady();
    if (!object(options) || Object.keys(options).some(key => !['contextId', 'revision', 'id'].includes(key)) || typeof options.contextId !== 'string' || !CONTEXT.test(options.contextId) || !Number.isSafeInteger(options.revision) || options.revision < 0 || !(options.id === null || (typeof options.id === 'string' && HEX.test(options.id)))) throw safeError('Choix de version invalide.');
    const { contextId, revision, id } = options;
    const current = context;
    if (!current?.complete || current.contextId !== contextId || current.revision !== revision) throw staleError();
    assertCurrent(current);
    const task = serial.then(async () => {
      assertCurrent(current);
      if (blocked) throw safeError(blockedError(blocked));
      let choice = null;
      if (id !== null) {
        const item = current.members.get(id);
        const live = assertCurrent(current).items.find(value => value.id === id);
        const previous = current.fingerprints.get(id);
        if (!item || !live || identity(live) !== current.group || live.relativePath !== item.relativePath || live.format !== item.format) throw staleError();
        if (previous?.status !== 'readable') throw safeError('Cette version ne peut pas être choisie car ses notes n’ont pas pu être vérifiées.');
        const checked = await fingerprint(current, item); assertCurrent(current);
        if (checked.status !== 'readable' || checked.sha256 !== previous.sha256 || checked.format !== previous.format) {
          invalidate(); throw safeError('Les notes de cette version ont changé ou sont indisponibles. Recomparez les versions.');
        }
        choice = { id, hash: checked.sha256, format: checked.format };
      }
      const choices = { ...store.choices };
      if (choice) choices[current.key] = choice; else delete choices[current.key];
      try { await write({ version: VERSION, choices }, current); }
      catch (failure) {
        if (failure?.code === 'LIBRARY_COMPARISON_SAFE') throw failure;
        throw safeError('Impossible d’enregistrer la version à conserver. Le choix précédent est conservé.');
      }
      assertCurrent(current);
      return { contextId: current.contextId, revision: current.revision, preferredId: choice?.id ?? null };
    });
    serial = task.catch(() => {});
    return task;
  }
  async function stop() {
    if (stopping) return stopping;
    invalidate();
    stopping = (async () => { await Promise.allSettled([...pending]); await serial; })();
    try { await stopping; } finally { stopping = null; }
  }
  // Internal only: cleanup never accepts caller-supplied file paths or a merely
  // displayed preference. It requires the current complete comparison and the
  // unchanged preference that was actually persisted for this root and group.
  async function cleanupContext(options) {
    ensureReady();
    if (!object(options) || Object.keys(options).some(key => !['contextId', 'revision', 'keepId'].includes(key)) || typeof options.contextId !== 'string' || !CONTEXT.test(options.contextId) || !Number.isSafeInteger(options.revision) || options.revision < 0 || typeof options.keepId !== 'string' || !HEX.test(options.keepId)) throw staleError();
    const { contextId, revision, keepId } = options, current = context, preferenceToken = serial;
    if (!current?.complete || current.contextId !== contextId || current.revision !== revision) throw staleError();
    assertCurrent(current);
    await preferenceToken;
    assertCurrent(current);
    if (serial !== preferenceToken || blocked) throw staleError();
    await unchangedStore(current);
    const document = assertCurrent(current), choice = store.choices[current.key], notes = current.fingerprints.get(keepId);
    if (serial !== preferenceToken || blocked || choice?.id !== keepId || notes?.status !== 'readable' || notes.sha256 !== choice.hash || notes.format !== choice.format) throw staleError();
    const live = document.items.filter(item => identity(item) === current.group);
    if (live.length !== current.members.size || live.some(item => {
      const previous = current.members.get(item.id);
      return !previous || previous.relativePath !== item.relativePath || previous.format !== item.format;
    })) throw staleError();
    return {
      contextId, revision, rootPath: current.root, keepId, keepHash: choice.hash, keepFormat: choice.format,
      preferenceToken, members: [...current.members.values()].map(({ id, relativePath, format }) => ({ id, relativePath, format }))
    };
  }
  return { compare: options => track(runComparison(options)), choose: options => track(runChoice(options)), cleanupContext: options => track(cleanupContext(options)), invalidate, stop };
}

module.exports = { createLibraryDuplicates };
