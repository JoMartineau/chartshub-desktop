import { languageCode, languageKey, wordsFor, localizedPair } from './locale-text.js';
// Read-only summary. Navigation is the only capability supplied to this view.
const clean = (value, limit = 180) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, limit) : '';
const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1e9) : 0;
const jobs = value => Array.isArray(value) ? value.slice(0, 500) : [];
const phase = value => ['active', 'connected', 'running', 'waiting', 'idle', 'stopped', 'error', 'unavailable', 'connecting', 'authorizing'].includes(value) ? value : 'idle';
const activeDownload = value => ['Queued', 'Downloading', 'Paused'].includes(value);
const downloadState = value => ['Queued', 'Downloading', 'Paused', 'Completed', 'Failed', 'Cancelled'].includes(value) ? value : 'Queued';
export function projectHomeSnapshot(snapshot = {}) {
  if (!snapshot || typeof snapshot !== 'object') snapshot = {};
  const requests = jobs(snapshot.songRequests?.requests).filter(item => ['pending', 'accepted'].includes(item?.status));
  const downloads = jobs(snapshot.downloads?.items), song = snapshot.state?.nowPlaying;
  return {
    language: languageCode(snapshot.language, 'en'),
    song: { title: clean(song?.title), artist: clean(song?.artist), charter: clean(song?.charter), demonstration: snapshot.cloneHero?.mode !== 'live' },
    requests: { enabled: snapshot.songRequests?.enabled === true, total: requests.length, rows: requests.slice(0, 3).map(item => ({ title: clean(item.title ?? item.song?.title), artist: clean(item.artist ?? item.song?.artist), status: item.status })) },
    downloads: { total: downloads.filter(item => activeDownload(item?.state)).length, rows: downloads.slice(-3).reverse().map(item => ({ title: clean(item?.title), state: downloadState(item?.state), percent: Number.isFinite(item?.totalBytes) && item.totalBytes > 0 && Number.isFinite(item?.receivedBytes) ? Math.max(0, Math.min(100, Math.floor(item.receivedBytes / item.totalBytes * 100))) : null })) },
    connections: { game: phase(snapshot.cloneHero?.status), demonstration: snapshot.cloneHero?.mode !== 'live', stream: snapshot.stream?.enabled === true, clients: count(snapshot.stream?.clients), twitch: phase(snapshot.songRequests?.connections?.twitch?.state), tiktok: phase(snapshot.songRequests?.connections?.tiktok?.state) },
    statistics: { songs: count(snapshot.library?.count), pending: requests.length, downloaded: downloads.filter(item => item?.state === 'Completed').length }
  };
}
const words = {
  fr: { song: 'Morceau affiché', requests: 'Prochaines demandes', downloads: 'Téléchargements', connections: 'Connexions', statistics: 'En un coup d’œil', shortcuts: 'Raccourcis', noSong: 'Aucun morceau affiché', noRequests: 'La file est vide.', noDownloads: 'Aucun téléchargement récent.', demonstration: 'Aperçu de démonstration', exported: 'Dernier morceau exporté par Clone Hero', receiving: 'Réception active', paused: 'Réception arrêtée', waiting: 'en attente', active: 'en cours', game: 'Clone Hero', stream: 'Serveur OBS', enabled: 'Activé', disabled: 'Arrêté', songs: 'morceaux dans la bibliothèque', pending: 'demandes actives', downloaded: 'téléchargements terminés', open: 'Ouvrir', states: { active: 'Connecté', connected: 'Connecté', running: 'Connecté', waiting: 'En attente', idle: 'Non connecté', stopped: 'Arrêté', error: 'À vérifier', unavailable: 'Indisponible', connecting: 'Connexion…', authorizing: 'Autorisation…' }, downloadStates: { Queued: 'En attente', Downloading: 'Téléchargement', Paused: 'En pause', Completed: 'Terminé', Failed: 'À vérifier', Cancelled: 'Annulé' }, destinations: { library: 'Bibliothèque', catalogue: 'Catalogue', requests: 'Demandes', stream: 'Stream / OBS', drums: 'Batterie / VST', status: 'État des connexions' } },
  en: { song: 'Displayed song', requests: 'Next requests', downloads: 'Downloads', connections: 'Connections', statistics: 'At a glance', shortcuts: 'Shortcuts', noSong: 'No song displayed', noRequests: 'The queue is empty.', noDownloads: 'No recent downloads.', demonstration: 'Demonstration preview', exported: 'Last song exported by Clone Hero', receiving: 'Receiving requests', paused: 'Reception stopped', waiting: 'waiting', active: 'active', game: 'Clone Hero', stream: 'OBS server', enabled: 'Enabled', disabled: 'Stopped', songs: 'songs in your library', pending: 'active requests', downloaded: 'completed downloads', open: 'Open', states: { active: 'Connected', connected: 'Connected', running: 'Connected', waiting: 'Waiting', idle: 'Not connected', stopped: 'Stopped', error: 'Needs attention', unavailable: 'Unavailable', connecting: 'Connecting…', authorizing: 'Authorizing…' }, downloadStates: { Queued: 'Queued', Downloading: 'Downloading', Paused: 'Paused', Completed: 'Completed', Failed: 'Needs attention', Cancelled: 'Cancelled' }, destinations: { library: 'Library', catalogue: 'Catalogue', requests: 'Requests', stream: 'Stream / OBS', drums: 'Drums / VST', status: 'Connection status' } }
};
export class HomeControls {
  constructor({ root, navigate = () => {} }) {
    this.root = root; this.document = root.ownerDocument; this.navigate = navigate; this.disposed = false;
    this.nodes = {}; this.cards = {}; this.signatures = new Map(); this.listeners = [];
    for (const kind of ['song', 'requests', 'downloads', 'connections', 'statistics', 'shortcuts']) {
      const card = this.node('article', 'home-card home-' + kind), title = this.node('h2'), body = this.node('div', 'home-card-body');
      title.id = 'home-' + kind + '-title'; card.setAttribute('aria-labelledby', title.id); card.append(title, body); root.append(card); this.cards[kind] = { card, title, body };
    }
    this.nodes.songTitle = this.node('strong', 'home-song-title'); this.nodes.songArtist = this.node('p'); this.nodes.songSource = this.node('p', 'home-muted');
    this.cards.song.body.append(this.nodes.songTitle, this.nodes.songArtist, this.nodes.songSource);
    for (const kind of ['requests', 'downloads']) { this.nodes[kind + 'Summary'] = this.node('p', 'home-muted'); this.nodes[kind + 'Rows'] = this.node('ul', 'home-rows'); this.cards[kind].body.append(this.nodes[kind + 'Summary'], this.nodes[kind + 'Rows']); }
    this.nodes.connectionRows = this.node('ul', 'home-rows'); this.cards.connections.body.append(this.nodes.connectionRows);
    this.nodes.statisticsRows = this.node('div', 'home-statistics'); this.cards.statistics.body.append(this.nodes.statisticsRows);
    for (const destination of Object.keys(words.en.destinations)) {
      const button = this.node('button', 'button secondary'); button.type = 'button'; button.dataset.homeDestination = destination;
      const listener = () => { if (!this.disposed) this.navigate(destination); }; button.addEventListener('click', listener); this.listeners.push([button, listener]); this.nodes[destination + 'Shortcut'] = button; this.cards.shortcuts.body.append(button);
    }
    this.update({});
  }
  node(tag, className = '', text = '') { const node = this.document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; }
  update(snapshot) {
    if (this.disposed) return;
    const model = projectHomeSnapshot(snapshot), text = wordsFor(words, model.language);
    const localeKey = languageKey(model.language);
    if (this.language !== localeKey) { this.language = localeKey; this.root.setAttribute('aria-label', localizedPair(model.language, 'Accueil', 'Overview')); }
    for (const kind of Object.keys(this.cards)) {
      const value = model[kind] ?? null, signature = JSON.stringify([localeKey, value]);
      if (signature === this.signatures.get(kind)) continue;
      this.signatures.set(kind, signature); this.cards[kind].title.textContent = text[kind];
      if (kind === 'song') { this.nodes.songTitle.textContent = value.title || text.noSong; this.nodes.songArtist.textContent = [value.artist, value.charter].filter(Boolean).join(' · '); this.nodes.songSource.textContent = value.demonstration ? text.demonstration : text.exported; }
      if (kind === 'requests') { this.nodes.requestsSummary.textContent = (value.enabled ? text.receiving : text.paused) + ' · ' + value.total + ' ' + text.waiting; this.nodes.requestsRows.replaceChildren(...(value.rows.length ? value.rows.map(item => this.node('li', '', [item.title, item.artist].filter(Boolean).join(' — ') || '—')) : [this.node('li', 'home-muted', text.noRequests)])); }
      if (kind === 'downloads') { this.nodes.downloadsSummary.textContent = value.total + ' ' + text.active; this.nodes.downloadsRows.replaceChildren(...(value.rows.length ? value.rows.map(item => this.node('li', '', (item.title || '—') + ' · ' + text.downloadStates[item.state] + (item.state === 'Downloading' && item.percent !== null ? ' ' + item.percent + '%' : ''))) : [this.node('li', 'home-muted', text.noDownloads)])); }
      if (kind === 'connections') { const rows = [[text.game, value.demonstration ? text.demonstration : text.states[value.game]], [text.stream, (value.stream ? text.enabled : text.disabled) + ' · ' + value.clients], ['Twitch', text.states[value.twitch]], ['TikTok', text.states[value.tiktok]]]; this.nodes.connectionRows.replaceChildren(...rows.map(([label, status]) => { const row = this.node('li'); row.append(this.node('span', '', label), this.node('strong', '', status)); return row; })); }
      if (kind === 'statistics') { this.nodes.statisticsRows.replaceChildren(...[['songs', text.songs], ['pending', text.pending], ['downloaded', text.downloaded]].map(([key, label]) => { const block = this.node('div'); block.append(this.node('strong', '', value[key].toLocaleString(model.language)), this.node('span', '', label)); return block; })); }
      if (kind === 'shortcuts') for (const [destination, label] of Object.entries(text.destinations)) { const button = this.nodes[destination + 'Shortcut']; button.textContent = label; button.setAttribute('aria-label', text.open + ' · ' + label); }
    }
  }
  dispose() { if (this.disposed) return; this.disposed = true; for (const [button, listener] of this.listeners) button.removeEventListener('click', listener); this.listeners = []; }
}
