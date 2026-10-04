'use strict';

const SEARCH_KEYS = ['query', 'sort', 'offset', 'limit', 'audio', 'duplicates'];
const SORTS = ['title', 'artist', 'charter'];
const AUDIO = ['all', 'missing', 'present', 'unknown'];
const MAX_RESULTS = 8;
const normalize = value => value.normalize('NFC').toLowerCase();
const completeField = value => value.trim().replace(/\s+/gu, ' ');

/** Caches belong to one committed index; returned pages never share cached objects. */
function createLibraryQuery({ textFields, publicFields }) {
  const searchFields = [...textFields, 'relativePath'];
  const duplicateFields = ['title', 'artist', 'charter'].map(field => searchFields.indexOf(field));
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  let cache;

  function index(document) {
    if (cache?.items === document.items && cache.revision === document.revision && cache.root === document.settings.rootPath) return cache;
    const items = document.items, groups = new Map();
    const search = items.map((item, itemIndex) => {
      const fields = searchFields.map(field => normalize(item[field]));
      const identity = duplicateFields.map(field => completeField(fields[field]));
      // Unknown metadata must never turn unrelated charts into duplicate groups.
      if (identity.every(Boolean)) {
        const key = JSON.stringify(identity), group = groups.get(key);
        if (group === undefined) groups.set(key, itemIndex);
        else if (typeof group === 'number') groups.set(key, [group, itemIndex]);
        else group.push(itemIndex);
      }
      return fields;
    });
    const duplicates = new Map();
    for (const group of groups.values()) {
      if (typeof group === 'number') continue;
      const count = new Set(group.map(itemIndex => items[itemIndex].relativePath)).size;
      if (count > 1) for (const itemIndex of group) duplicates.set(itemIndex, count);
    }
    cache = { items, revision: document.revision, root: document.settings.rootPath, search, duplicates, orders: new Map(), results: new Map() };
    return cache;
  }

  function ordered(state, sort) {
    if (!state.orders.has(sort)) {
      const { items } = state;
      const order = Array.from({ length: items.length }, (_, i) => i);
      order.sort((a, b) => collator.compare(items[a][sort], items[b][sort]) || collator.compare(items[a].title, items[b].title) || collator.compare(items[a].relativePath, items[b].relativePath));
      state.orders.set(sort, order);
    }
    return state.orders.get(sort);
  }

  return function query(document, options = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !SEARCH_KEYS.includes(key))) throw Error('Recherche de bibliothèque invalide.');
    const { query: text = '', sort = 'title', offset = 0, limit = 50, audio = 'all', duplicates = 'all' } = options;
    if (typeof text !== 'string' || text.length > 512 || !SORTS.includes(sort) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100 || !AUDIO.includes(audio) || !['all', 'possible'].includes(duplicates)) throw Error('Recherche de bibliothèque invalide.');
    const needle = normalize(text.trim());
    const state = index(document), key = JSON.stringify([needle, sort, audio, duplicates]);
    let matches = state.results.get(key);
    if (matches) state.results.delete(key);
    else {
      const order = ordered(state, sort);
      matches = !needle && audio === 'all' && duplicates === 'all' ? order : order.filter(itemIndex =>
        (audio === 'all' || state.items[itemIndex].audio === audio) &&
        (duplicates === 'all' || state.duplicates.has(itemIndex)) &&
        (!needle || state.search[itemIndex].some(field => field.includes(needle))));
    }
    // Offset/limit are deliberately excluded: every page reuses the same result.
    state.results.set(key, matches);
    if (state.results.size > MAX_RESULTS) state.results.delete(state.results.keys().next().value);
    return {
      items: matches.slice(offset, offset + limit).map(itemIndex => {
        const item = state.items[itemIndex];
        const result = Object.fromEntries(publicFields.map(field => [field, item[field]]));
        const duplicateCount = state.duplicates.get(itemIndex);
        if (duplicateCount) result.duplicateCount = duplicateCount;
        return result;
      }),
      total: matches.length, offset, limit, revision: document.revision
    };
  };
}

module.exports = { createLibraryQuery };
