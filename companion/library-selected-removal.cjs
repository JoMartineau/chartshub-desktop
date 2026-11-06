'use strict';

const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { inspectReportedBundle } = require('./chart-bundle.cjs');

const MAX_SELECTION = 1000, PAGE_SIZE = 50;
const ID = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
const rootKey = root => digest(canonical(path.resolve(root)));
const normalize = value => String(value || '').normalize('NFC').toLowerCase();
const contains = (parent, child) => { const left = canonical(parent), right = canonical(child); return left === right || right.startsWith(left + '/'); };
const validRelative = value => typeof value === 'string' && value.length > 0 && value.length <= 32768 && !path.isAbsolute(value)
  && !/[\\:\u0000-\u001f\u007f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
const failure = () => Object.assign(Error('La sélection ou les fichiers ont changé. Préparez une nouvelle sélection avant de la mettre à la corbeille.'), { code: 'LIBRARY_SELECTED_REMOVAL_SAFE' });

function fields(value, names) { return object(value) && Object.keys(value).every(key => names.includes(key)); }
function snapshotDigest(identity) { return digest('chartshub-selected-removal-v1\n' + JSON.stringify(identity)); }
function protectedTarget(rootPath, relative, protectedDirectory) {
  if (relative.split('/').some(part => /^\.chartshub-(?:companion|partial|sync|backup)(?:-|$)/i.test(part))) return true;
  if (!protectedDirectory) return false;
  const target = path.resolve(rootPath, ...relative.split('/')), data = path.resolve(protectedDirectory);
  const covers = (parent, child) => { const rel = path.relative(parent, child); return rel === '' || !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep); };
  return covers(target, data) || covers(data, target);
}

/** Explicit selections are checked by filesystem identity; deleting large audio
 * does not require reading every audio byte first. Only native recycling is used. */
function createSelectedLibraryRemoval({ getDocument, recycle, onCleaned = async () => {}, onChange, protectedDirectory } = {}) {
  if (typeof getDocument !== 'function' || typeof recycle !== 'function' || typeof onCleaned !== 'function'
      || protectedDirectory !== undefined && (typeof protectedDirectory !== 'string' || !path.isAbsolute(protectedDirectory))) throw failure();
  let plan = null, task = null, stopping = false, progress = { phase: 'idle', processed: 0, total: 0 }, cache = null;
  const notify = () => { try { onChange?.(status()); } catch {} };
  const status = () => ({ ...progress });
  function invalidate() { plan?.controller.abort(); plan = null; if (!task) { progress = { phase: 'idle', processed: 0, total: 0 }; notify(); } }
  function documentReady() {
    const document = getDocument();
    if (!object(document) || !Array.isArray(document.items) || typeof document.settings?.rootPath !== 'string' || !path.isAbsolute(document.settings.rootPath)
        || !Number.isSafeInteger(document.revision) || document.revision < 0 || stopping) throw failure();
    return document;
  }
  function current(value) {
    const document = documentReady();
    if (value.controller.signal.aborted || value.items !== document.items || value.revision !== document.revision || value.rootPath !== document.settings.rootPath) throw failure();
    return document;
  }
  function index() {
    const document = documentReady(), root = document.settings.rootPath;
    if (!cache || cache.items !== document.items || cache.revision !== document.revision || cache.root !== root) {
      const byId = new Map();
      for (const item of document.items) if (typeof item?.id === 'string') byId.set(item.id, item);
      const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
      const order = document.items.map((_, position) => position);
      order.sort((a, b) => collator.compare(document.items[a].title, document.items[b].title) || collator.compare(document.items[a].relativePath, document.items[b].relativePath));
      cache = { root, rootKey: rootKey(root), revision: document.revision, items: document.items, byId, order, matches: new Map() };
    }
    return cache;
  }
  function filters(options = {}, paging = true) {
    if (!fields(options, paging ? ['query', 'artist', 'album', 'offset', 'limit'] : ['query', 'artist', 'album'])) throw failure();
    const { query = '', artist = '', album = '', offset = 0, limit = PAGE_SIZE } = options;
    if ([query, artist, album].some(value => typeof value !== 'string' || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value))
        || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE) throw failure();
    return { query: normalize(query.trim()), artist: normalize(artist.trim()), album: normalize(album.trim()), offset, limit };
  }
  function matching(options, paging) {
    const selected = filters(options, paging), state = index(), key = JSON.stringify([selected.query, selected.artist, selected.album]);
    let matches = state.matches.get(key);
    if (!matches) {
      matches = state.order.filter(position => {
        const item = state.items[position];
        return (!selected.artist || normalize(item.artist).includes(selected.artist)) && (!selected.album || normalize(item.album).includes(selected.album))
          && (!selected.query || [item.title, item.artist, item.album, item.charter, item.relativePath].some(value => normalize(value).includes(selected.query)));
      });
      state.matches.set(key, matches); if (state.matches.size > 4) state.matches.delete(state.matches.keys().next().value);
    }
    return { selected, state, matches };
  }
  function query(options = {}) {
    const { selected, state, matches } = matching(options, true);
    return { rootKey: state.rootKey, revision: state.revision, total: matches.length, offset: selected.offset, limit: selected.limit,
      items: matches.slice(selected.offset, selected.offset + selected.limit).map(position => {
        const item = state.items[position]; return { id: item.id, title: item.title, artist: item.artist, album: item.album, relativePath: item.relativePath };
      }) };
  }
  function ids(options = {}) {
    const { state, matches } = matching(options, false);
    return { rootKey: state.rootKey, revision: state.revision, total: matches.length, ids: matches.slice(0, MAX_SELECTION).map(position => state.items[position].id), truncated: matches.length > MAX_SELECTION };
  }
  const publicEntry = entry => ({ id: entry.id, title: entry.title, artist: entry.artist, album: entry.album, relativePath: entry.relativePath,
    targetRelativePath: entry.targetRelativePath, kind: entry.kind, bytes: entry.bundle?.bytes ?? null, eligible: entry.eligible, blocked: entry.blocked });
  function publicPlan(value, full = false) {
    const eligible = value.entries.filter(entry => entry.eligible), entries = full ? eligible : value.entries.slice(0, PAGE_SIZE);
    return { planId: value.planId, rootKey: value.rootKey, revision: value.revision, count: value.entries.length, eligibleCount: eligible.length,
      blockedCount: value.entries.length - eligible.length, totalBytes: eligible.reduce((sum, entry) => sum + entry.bundle.bytes, 0),
      entries: entries.map(publicEntry), ...(full ? { rootPath: value.rootPath } : { previewTruncated: value.entries.length > entries.length }) };
  }
  function prepare(options) {
    if (task || stopping || !fields(options, ['ids', 'revision', 'rootKey']) || Object.keys(options).length !== 3 || !Array.isArray(options.ids)
        || !options.ids.length || options.ids.length > MAX_SELECTION || options.ids.some(id => typeof id !== 'string' || !ID.test(id))
        || new Set(options.ids).size !== options.ids.length || !Number.isSafeInteger(options.revision) || options.revision < 0 || !ID.test(options.rootKey)) throw failure();
    const chosen = [...options.ids], selectedIndex = index();
    if (selectedIndex.rootKey !== options.rootKey || selectedIndex.revision !== options.revision || chosen.some(id => !selectedIndex.byId.has(id))) throw failure();
    invalidate();
    const value = { planId: randomUUID(), rootKey: selectedIndex.rootKey, revision: selectedIndex.revision, rootPath: selectedIndex.root,
      items: selectedIndex.items, entries: [], controller: new AbortController() };
    plan = value; progress = { phase: 'preparing', processed: 0, total: chosen.length };
    const operation = Promise.resolve().then(async () => {
      try {
        const selected = chosen.map(id => selectedIndex.byId.get(id)), targets = new Set(), targetCounts = new Map();
        for (const item of selected) {
          const target = item.format === 'sng' ? item.relativePath : path.posix.dirname(item.relativePath);
          if (validRelative(target)) targets.add(canonical(target));
        }
        // One bounded pass over the existing index protects shared folders and
        // packs, instead of rescanning100,000 entries for every selected song.
        for (const item of value.items) {
          let target = item.relativePath;
          while (validRelative(target)) {
            const key = canonical(target); if (targets.has(key)) targetCounts.set(key, (targetCounts.get(key) || 0) + 1);
            const next = path.posix.dirname(target); if (next === target || next === '.') break; target = next;
          }
        }
        for (const item of selected) {
          current(value);
          const kind = item.format === 'sng' ? 'sng' : 'folder', targetRelativePath = kind === 'sng' ? item.relativePath : path.posix.dirname(item.relativePath);
          let blocked = !validRelative(item.relativePath) || item.id !== digest(item.relativePath) || !['chart', 'midi', 'sng'].includes(item.format) || !validRelative(targetRelativePath) ? 'unsafe'
            : protectedTarget(value.rootPath, targetRelativePath, protectedDirectory) ? 'protected'
            : (targetCounts.get(canonical(targetRelativePath)) || 0) !== 1 ? 'shared' : null;
          let bundle = null;
          if (!blocked) {
            bundle = await inspectReportedBundle({ rootPath: value.rootPath, targetRelativePath, kind, identityOnly: true, signal: value.controller.signal });
            current(value);
            if (!bundle) blocked = 'unsafe';
            else bundle = { ...bundle, digest: snapshotDigest(bundle.identity) };
          }
          value.entries.push({ id: item.id, title: item.title, artist: item.artist, album: item.album, relativePath: item.relativePath,
            targetRelativePath, kind, bundle, eligible: !blocked, blocked });
          progress.processed++; notify();
          if (progress.processed % 16 === 0) await new Promise(resolve => setImmediate(resolve));
        }
        const eligible = value.entries.filter(entry => entry.eligible);
        for (const entry of eligible) if (eligible.some(other => other !== entry && (contains(entry.targetRelativePath, other.targetRelativePath) || contains(other.targetRelativePath, entry.targetRelativePath)))) {
          entry.eligible = false; entry.blocked = 'shared';
        }
        current(value); progress.phase = 'ready'; notify(); return publicPlan(value);
      } catch { if (plan === value) invalidate(); throw failure(); }
    });
    task = operation;
    return operation.finally(() => { if (task === operation) task = null; if (plan !== value) { progress = { phase: 'idle', processed: 0, total: 0 }; notify(); } });
  }
  function selected(options) {
    if (!fields(options, ['planId', 'rootKey', 'revision']) || Object.keys(options).length !== 3 || !UUID.test(options.planId)
        || !ID.test(options.rootKey) || !Number.isSafeInteger(options.revision) || options.revision < 0 || !plan
        || plan.planId !== options.planId || plan.rootKey !== options.rootKey || plan.revision !== options.revision) throw failure();
    current(plan); return plan;
  }
  async function review(options) {
    if (task || stopping) throw failure(); const value = selected(options);
    if (!value.entries.some(entry => entry.eligible)) throw failure();
    // Review contains exactly the immutable targets the native dialog approves.
    return publicPlan(value, true);
  }
  function execute(options) {
    if (task || stopping) throw failure(); const value = selected(options), entries = value.entries.filter(entry => entry.eligible);
    if (!entries.length) throw failure();
    progress = { phase: 'executing', processed: 0, total: entries.length };
    const result = { recycledIds: [], recycledTargets: [], failed: [], cancelled: false, refreshRequested: false };
    const operation = Promise.resolve().then(async () => {
      try {
        for (const entry of entries) {
          current(value);
          const checked = await inspectReportedBundle({ rootPath: value.rootPath, targetRelativePath: entry.targetRelativePath, kind: entry.kind,
            expected: entry.bundle, identityOnly: true, signal: value.controller.signal });
          current(value); if (!checked || snapshotDigest(checked.identity) !== entry.bundle.digest) throw failure();
          await recycle(path.resolve(value.rootPath, ...entry.targetRelativePath.split('/')), { type: 'selected-removal', rootPath: value.rootPath,
            rootKey: value.rootKey, planId: value.planId, id: entry.id, targetRelativePath: entry.targetRelativePath, kind: entry.kind, expected: entry.bundle });
          result.recycledIds.push(entry.id); result.recycledTargets.push(entry.targetRelativePath); progress.processed++; notify();
        }
      } catch {
        if (value.controller.signal.aborted || stopping) result.cancelled = true;
        else result.failed.push({ id: entries[result.recycledIds.length]?.id, reason: 'changed-or-unavailable' });
      } finally {
        if (result.recycledIds.length) {
          try { await onCleaned({ rootPath: value.rootPath, revision: value.revision, items: value.items,
            recycledIds: [...result.recycledIds], recycledTargets: [...result.recycledTargets] }); result.refreshRequested = true; }
          catch { result.indexWarning = true; }
        }
        if (plan === value) invalidate();
      }
      return result;
    });
    task = operation;
    return operation.finally(() => { if (task === operation) task = null; progress = { phase: 'idle', processed: 0, total: 0 }; notify(); });
  }
  async function stop() {
    stopping = true; invalidate();
    try { await task?.catch(() => {}); } finally { stopping = false; progress = { phase: 'idle', processed: 0, total: 0 }; notify(); }
  }
  return { query, ids, prepare, review, execute, invalidate, busy: () => !!task, status, stop };
}

async function verifyNativeSelectedRemoval({ root, target, proof } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof target !== 'string' || !path.isAbsolute(target) || !object(proof)
      || proof.type !== 'selected-removal' || proof.rootPath !== root || proof.rootKey !== rootKey(root) || !UUID.test(proof.planId) || !ID.test(proof.id)
      || !validRelative(proof.targetRelativePath) || path.resolve(root, ...proof.targetRelativePath.split('/')) !== target || !['folder', 'sng'].includes(proof.kind)
      || !object(proof.expected) || !object(proof.expected.identity) || !ID.test(proof.expected.digest) || !Number.isSafeInteger(proof.expected.bytes) || proof.expected.bytes < 0
      || proof.expected.kind !== proof.kind || proof.expected.targetRelativePath !== proof.targetRelativePath
      || proof.expected.identity.kind !== proof.kind || proof.expected.identity.targetRelativePath !== proof.targetRelativePath
      || snapshotDigest(proof.expected.identity) !== proof.expected.digest) throw failure();
  if (!await inspectReportedBundle({ rootPath: root, targetRelativePath: proof.targetRelativePath, kind: proof.kind, expected: proof.expected, identityOnly: true })) throw failure();
}

module.exports = { createSelectedLibraryRemoval, verifyNativeSelectedRemoval, MAX_SELECTION, PAGE_SIZE };
