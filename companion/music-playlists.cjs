'use strict';
const { randomUUID } = require('node:crypto');
const PLAYLIST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SONG_ID = /^[a-f0-9]{64}$/;
const validPlaylistName = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 100 && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value);
const fail = message => Object.assign(Error(message), { code: 'MUSIC_PLAYLIST_SAFE' });

/** Only opaque song IDs from the current installed library enter a playlist. */
function changeMusicPlaylist(preferences, action, payload, library) {
  if (!SONG_ID.test(library?.rootKey ?? '') || !Array.isArray(library.items)) throw fail('Choisissez et scannez votre dossier Songs avant de modifier une playlist.');
  const playlists = structuredClone(preferences.playlists ?? []);
  const sameName = (name, except) => playlists.some(list => list.rootKey === library.rootKey && list.id !== except && list.name.normalize('NFKC').toLowerCase() === name.normalize('NFKC').toLowerCase());
  if (action === 'create') {
    if (!validPlaylistName(payload?.name)) throw fail('Choisissez un nom de playlist de 1 à 100 caractères.');
    const name = payload.name.trim();
    if (sameName(name)) throw fail('Une playlist porte déjà ce nom dans ce dossier Songs.');
    if (playlists.length >= 20) throw fail('La limite de 20 playlists est atteinte.');
    const id = randomUUID(); playlists.push({ id, name, rootKey: library.rootKey, songIds: [] });
    return { playlists, playlistId: id };
  }
  const list = playlists.find(value => value.id === payload?.id && value.rootKey === library.rootKey);
  if (!PLAYLIST_ID.test(payload?.id ?? '') || !list) throw fail('Cette playlist n’est plus disponible dans ce dossier Songs.');
  if (action === 'rename') {
    if (!validPlaylistName(payload.name)) throw fail('Choisissez un nom de playlist de 1 à 100 caractères.');
    const name = payload.name.trim();
    if (sameName(name, list.id)) throw fail('Une playlist porte déjà ce nom dans ce dossier Songs.');
    list.name = name;
  } else if (action === 'delete') return { playlists: playlists.filter(value => value.id !== list.id), playlistId: list.id };
  else if (action === 'add' || action === 'remove') {
    if (!SONG_ID.test(payload.songId ?? '')) throw fail('Morceau invalide.');
    if (action === 'add') {
      if (!library.items.some(item => item.id === payload.songId)) throw fail('Ce morceau n’est plus disponible dans la bibliothèque.');
      if (!list.songIds.includes(payload.songId)) {
        if (list.songIds.length >= 500 || playlists.reduce((count, value) => count + value.songIds.length, 0) >= 2500) throw fail('La limite de morceaux enregistrés dans les playlists est atteinte.');
        list.songIds.push(payload.songId);
      }
    } else list.songIds = list.songIds.filter(id => id !== payload.songId);
  } else throw fail('Action de playlist invalide.');
  return { playlists, playlistId: list.id };
}
module.exports = { changeMusicPlaylist, PLAYLIST_ID, validPlaylistName };
