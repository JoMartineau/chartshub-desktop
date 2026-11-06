'use strict';
const path = require('node:path');
const { normalizeMetadata } = require('./chart-matching.cjs');

// Metadata only locates candidates. The worker must still prove every source
// file byte before adoption; a name match never authorizes an overwrite.
function createSyncCandidateResolver({ getSnapshot, getRoot, resolveFolder }) {
  let source = null, bySong = new Map();
  const key = row => JSON.stringify([normalizeMetadata(row.artist), normalizeMetadata(row.title)]);
  return async ({ descriptor, rootPath, signal }) => {
    signal?.throwIfAborted();
    if (getRoot() !== rootPath) return null;
    const snapshot = getSnapshot();
    if (!snapshot?.rootKey || !Array.isArray(snapshot.items)) return null;
    if (source !== snapshot) {
      const index = new Map();
      for (const row of snapshot.items) {
        if (!normalizeMetadata(row.artist) || !normalizeMetadata(row.title)) continue;
        const song = key(row); let candidates = index.get(song);
        if (!candidates) index.set(song, candidates = []);
        if (candidates.length < 9) candidates.push(row);
      }
      bySong = index; source = snapshot;
    }
    const candidates = bySong.get(key(descriptor)); if (!candidates?.length) return null;
    const charter = normalizeMetadata(descriptor.charter);
    const exact = charter ? candidates.filter(row => normalizeMetadata(row.charter) === charter) : [];
    const matches = exact.length ? exact : candidates;
    if (matches.length !== 1) return { conflict: true };
    try {
      const folder = await resolveFolder(matches[0].id); signal?.throwIfAborted();
      if (getRoot() !== rootPath || getSnapshot() !== snapshot || typeof folder !== 'string' || !path.isAbsolute(folder)) return { conflict: true };
      const relative = path.relative(rootPath, folder);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return { conflict: true };
      return { candidateFolder: relative.split(path.sep).join('/') };
    } catch { signal?.throwIfAborted(); return { conflict: true }; }
  };
}
module.exports = { createSyncCandidateResolver };
