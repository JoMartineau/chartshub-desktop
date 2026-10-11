'use strict';
const { INSTRUMENTS, DIFFICULTIES } = require('./song-requests.cjs');
const DEFAULT_FILTERS = Object.freeze({ artist: '', charter: '', album: '', year: '', genre: '', audio: 'all', format: 'all', instrument: 'all', difficulty: 'all' });
const FIELDS = ['id','title','artist','charter','album','year','genre','tracks','format','audio'];
const normalize = text => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
function queryMusicLibrary(document, options) {
  const { query = '', offset = 0, limit = 50, filters: supplied = DEFAULT_FILTERS } = options ?? {};
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['query','offset','limit','filters'].includes(key))
      || typeof query !== 'string' || query.length > 200 || /[\x00-\x1f\x7f]/.test(query)
      || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50
      || !supplied || typeof supplied !== 'object' || Array.isArray(supplied) || Object.keys(supplied).some(key => !Object.hasOwn(DEFAULT_FILTERS, key))) throw Error('Invalid music search');
  const filters = { ...DEFAULT_FILTERS, ...supplied };
  if (!['artist','charter','album','year','genre'].every(key => typeof filters[key] === 'string' && filters[key].length <= 200 && !/[\x00-\x1f\x7f]/.test(filters[key]))
      || !['all','present','missing','unknown'].includes(filters.audio) || !['all','chart','midi','sng'].includes(filters.format)
      || !INSTRUMENTS.includes(filters.instrument) || !DIFFICULTIES.includes(filters.difficulty)) throw Error('Invalid music filters');
  const tokens = normalize(query).split(/\s+/).filter(Boolean), textFilters = ['artist','charter','album','year','genre'].map(key => [key, normalize(filters[key])]);
  const songs = document.items.filter(item => {
    const text = ['title','artist','charter','album','year','genre'].map(key => normalize(item[key] || '')).join(' ');
    return tokens.every(token => text.includes(token)) && textFilters.every(([key,value]) => !value || normalize(item[key] || '').includes(value))
      && (filters.audio === 'all' || item.audio === filters.audio) && (filters.format === 'all' || item.format === filters.format)
      && ((filters.instrument === 'all' && filters.difficulty === 'all') || (Array.isArray(item.tracks) && item.tracks.some(track =>
        (filters.instrument === 'all' || track.instrument === filters.instrument) && (filters.difficulty === 'all' || track.difficulty === filters.difficulty))));
  });
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  songs.sort((a,b) => collator.compare(a.title,b.title) || collator.compare(a.artist,b.artist) || a.id.localeCompare(b.id));
  return { total: songs.length, offset, limit, revision: document.revision,
    items: songs.slice(offset,offset+limit).map(item => Object.fromEntries(FIELDS.filter(key => item[key] !== undefined).map(key => [key,structuredClone(item[key])]))) };
}
module.exports = { queryMusicLibrary, DEFAULT_FILTERS };
