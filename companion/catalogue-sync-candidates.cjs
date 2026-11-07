'use strict';
const path = require('node:path');
const { normalizeMetadata } = require('./chart-matching.cjs');
const { safePart } = require('../download.js');
const MAX_CANDIDATES = 32;

// Metadata only locates candidates. The worker must still prove every source
// file byte before adoption; a name match never authorizes an overwrite.
function createSyncCandidateResolver({ getSnapshot, getRoot, resolveFolder }) {
  let source = null, bySong = new Map();
  const key = row => {
    const artist = normalizeMetadata(row?.artist), title = normalizeMetadata(row?.title);
    return artist && title ? JSON.stringify([artist, title]) : null;
  };
  function addVariant(group, row) {
    group.count++;
    if (group.first.length < MAX_CANDIDATES) group.first.push(row);
    const charter = normalizeMetadata(row.charter);
    if (!charter) return;
    let exact = group.byCharter.get(charter);
    if (!exact) group.byCharter.set(charter, exact = []);
    if (exact.length < MAX_CANDIDATES) exact.push(row);
  }
  return async ({ descriptor, rootPath, signal }) => {
    signal?.throwIfAborted();
    if (getRoot() !== rootPath) return null;
    const snapshot = getSnapshot();
    if (!snapshot?.rootKey || !Array.isArray(snapshot.items)) return null;
    if (source !== snapshot) {
      const index = new Map();
      for (const row of snapshot.items) {
        const song = key(row);
        if (!song || typeof row.id !== 'string' || !row.id) continue;
        const entry = index.get(song);
        if (!entry) { index.set(song, row); continue; }
        if (entry.byCharter) { addVariant(entry, row); continue; }
        const group = { first: [], byCharter: new Map(), count: 0 };
        addVariant(group, entry);
        addVariant(group, row);
        index.set(song, group);
      }
      bySong = index; source = snapshot;
    }
    const entry = bySong.get(key(descriptor));
    if (!entry) return null;
    const exact = entry.byCharter?.get(normalizeMetadata(descriptor?.charter)) ?? [];
    const matches = [...new Set([...exact, ...(entry.first ?? [entry])])].slice(0, MAX_CANDIDATES);
    const candidates = new Map();
    let incomplete = (entry.count ?? 1) > matches.length;
    for (const row of matches) {
      signal?.throwIfAborted();
      let folder;
      try { folder = await resolveFolder(row.id); } catch { incomplete = true; }
      signal?.throwIfAborted();
      if (getRoot() !== rootPath || getSnapshot() !== snapshot) return { conflict: true };
      if (typeof folder !== 'string' || !path.isAbsolute(folder)) { incomplete = true; continue; }
      const relative = path.relative(rootPath, folder), parts = relative.split(path.sep);
      if (!relative || path.isAbsolute(relative) || relative.length >= 32700 || parts.length > 32
          || parts.some(part => !safePart(part) || part.startsWith('.'))) { incomplete = true; continue; }
      const name = parts.join('/'), identity = process.platform === 'win32' ? name.toLowerCase() : name;
      if (!candidates.has(identity)) candidates.set(identity, name);
    }
    const candidateFolders = [...candidates.values()];
    if (!candidateFolders.length) return { conflict: true };
    if (candidateFolders.length === 1 && !incomplete) return { candidateFolder: candidateFolders[0] };
    return { candidateFolders, ...(incomplete ? { incomplete: true } : {}) };
  };
}
module.exports = { createSyncCandidateResolver, MAX_CANDIDATES };
