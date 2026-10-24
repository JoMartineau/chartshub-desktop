const token = new URLSearchParams(location.search).get('token');
const element = id => document.querySelector('#request-' + id);
const queue = element('queue'), status = element('status'), nodes = new Map(), seen = new Set();
const MAX_RESPONSE_BYTES = 512 * 1024;
let stopped = false, timer, activeRequest = null, language = 'fr', initialized = false, lastRender = null;
const tr = (fr, en) => language === 'en' ? en : fr;
const text = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 512) : '';
const platforms = { twitch: 'Twitch', tiktok: 'TikTok', youtube: 'YouTube', website: 'Site web' };
const defaultWidget = Object.freeze({ accentColor: '#38bdf8', fontSize: 24, upcomingCount: 3, showNowPlaying: true, showViewerNames: true });
function widgetSettings(value) {
  if (value === undefined) return { ...defaultWidget };
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 5 || Object.keys(value).some(key => !Object.hasOwn(defaultWidget, key))
      || typeof value.accentColor !== 'string' || !/^#[a-f0-9]{6}$/i.test(value.accentColor)
      || !Number.isSafeInteger(value.fontSize) || value.fontSize < 16 || value.fontSize > 48
      || !Number.isSafeInteger(value.upcomingCount) || value.upcomingCount < 1 || value.upcomingCount > 10
      || typeof value.showNowPlaying !== 'boolean' || typeof value.showViewerNames !== 'boolean') throw Error();
  return { ...value, accentColor: value.accentColor.toLowerCase() };
}
function currentSong(value, widget) {
  if (!widget.showNowPlaying || value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['title', 'artist', 'state', 'viewerName'].includes(key))
      || !['playing', 'exported'].includes(value.state)
      || typeof value.title !== 'string' || value.title.length > 512 || !text(value.title).trim()
      || typeof value.artist !== 'string' || value.artist.length > 512
      || (value.viewerName !== undefined && (typeof value.viewerName !== 'string' || value.viewerName.length > 512))) throw Error();
  return { title: text(value.title), artist: text(value.artist), state: value.state,
    viewerName: widget.showViewerNames ? text(value.viewerName) : '' };
}
function renderCurrent(song) {
  element('current').hidden = song === null;
  element('current-label').textContent = song ? song.state === 'exported'
    ? tr('Dernier morceau exporté', 'Last exported song') : tr('En cours', 'Now playing') : '';
  element('current-title').textContent = song?.title ?? '';
  element('current-artist').textContent = song?.artist ?? '';
  element('current-viewer').hidden = !song?.viewerName;
  element('current-viewer').textContent = song?.viewerName ? tr('Demandé par ', 'Requested by ') + song.viewerName : '';
}

function labels() {
  document.documentElement.lang = language;
  element('heading').textContent = tr('Prochaines demandes', 'Upcoming requests');
  element('count-label').textContent = tr('en attente', 'waiting');
  element('footer-prompt').textContent = tr('Dans le chat', 'In chat');
  element('command').textContent = tr('!sr artiste titre', '!sr artist title');
}
function empty(unavailable, enabled) {
  element('empty').hidden = false;
  element('empty-title').textContent = unavailable ? tr('Connexion interrompue', 'Connection interrupted')
    : enabled ? tr('Choisissez le prochain morceau', 'Choose the next song') : tr('Les demandes reprendront bientôt', 'Requests will return soon');
  element('empty-help').textContent = unavailable ? tr('Laissez ChartsHub ouvert pour afficher la file.', 'Keep ChartsHub open to display the queue.')
    : enabled ? tr('Demandez un morceau dans le chat.', 'Request a song in chat.') : tr('Revenez quand la réception sera active.', 'Come back when requests are open.');
}
function createRow() {
  const row = document.createElement('li'), rank = document.createElement('span'), content = document.createElement('div');
  const next = document.createElement('p'), title = document.createElement('h2'), artist = document.createElement('p');
  const viewer = document.createElement('p'), platform = document.createElement('span'), by = document.createElement('span'), name = document.createElement('span'), votes = document.createElement('span');
  rank.className = 'request-rank'; content.className = 'request-content'; next.className = 'request-next-label';
  title.className = 'request-title'; artist.className = 'request-artist'; viewer.className = 'request-viewer';
  platform.className = 'request-platform'; name.className = 'request-viewer-name'; votes.className = 'request-votes';
  viewer.append(platform, by, name); content.append(next, title, artist, viewer); row.append(rank, content, votes);
  row.addEventListener('animationend', () => row.classList.remove('is-new'));
  return { row, rank, next, title, artist, viewer, platform, by, name, votes };
}
function render(state) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.requests) || state.requests.length > 50) throw Error();
  language = state.language === 'en' ? 'en' : 'fr';
  const widget = widgetSettings(state.widget), playing = currentSong(state.nowPlaying, widget);
  const unique = new Set();
  const requests = state.requests.filter(request => request && ['pending', 'accepted'].includes(request.status)).map(request => ({
    id: text(request.id), title: text(request.title), artist: text(request.artist), viewerName: text(request.viewerName),
    platform: Object.hasOwn(platforms, request.platform) ? request.platform : '',
    votes: Number.isSafeInteger(request.votes) && request.votes >= 0 ? Math.min(request.votes, 1000) : 0
  })).filter(request => request.id && !unique.has(request.id) && unique.add(request.id));
  const enabled = state.enabled === true, signature = JSON.stringify([language, enabled, requests, widget, playing]);
  if (signature === lastRender) return;
  lastRender = signature; labels();
  document.documentElement.style.setProperty('--request-accent', widget.accentColor);
  document.documentElement.style.setProperty('--request-font-size', widget.fontSize + 'px');
  renderCurrent(playing);
  status.dataset.state = enabled ? 'open' : 'closed'; status.textContent = tr(enabled ? 'Demandes ouvertes' : 'Demandes fermées', enabled ? 'Requests open' : 'Requests closed');
  element('count').textContent = String(requests.length); element('empty').hidden = requests.length > 0;
  const visible = requests.slice(0, widget.upcomingCount), visibleIds = new Set(visible.map(request => request.id));
  for (const [id, entry] of nodes) if (!visibleIds.has(id)) { entry.row.remove(); nodes.delete(id); }
  for (const [index, request] of visible.entries()) {
    let entry = nodes.get(request.id);
    if (!entry) { entry = createRow(); nodes.set(request.id, entry); }
    const { row } = entry, isNew = initialized && !seen.has(request.id);
    row.className = 'request-card' + (index === 0 ? ' is-next' : '') + (isNew ? ' is-new' : '');
    entry.rank.textContent = String(index + 1).padStart(2, '0'); entry.next.hidden = index !== 0;
    entry.next.textContent = tr('À jouer ensuite', 'Up next');
    entry.title.textContent = request.title || tr('Morceau sans titre', 'Untitled song'); entry.artist.textContent = request.artist;
    entry.viewer.hidden = !widget.showViewerNames || !request.viewerName;
    entry.platform.textContent = request.platform === 'website' ? tr('Site web', 'Website') : platforms[request.platform] ?? '';
    entry.platform.hidden = !request.platform; entry.platform.dataset.platform = request.platform;
    entry.by.textContent = tr('Demandé par', 'Requested by');
    entry.name.textContent = widget.showViewerNames ? request.platform === 'website' && request.viewerName === 'Spectateur web'
      ? tr('Spectateur web', 'Web viewer') : request.viewerName : '';
    entry.votes.textContent = `${request.votes} vote${request.votes === 1 ? '' : 's'}`;
    if (queue.children[index] !== row) queue.insertBefore(row, queue.children[index] ?? null);
  }
  for (const request of requests) seen.add(request.id);
  while (seen.size > 1000) seen.delete(seen.values().next().value);
  initialized = true;
  if (!requests.length) empty(false, enabled);
  const remaining = Math.max(0, requests.length - visible.length);
  element('remaining').hidden = remaining === 0;
  element('remaining').textContent = remaining ? tr(`+ ${remaining} autre${remaining === 1 ? '' : 's'} demande${remaining === 1 ? '' : 's'} dans la file`, `+ ${remaining} more request${remaining === 1 ? '' : 's'} in the queue`) : '';
}
function unavailable() {
  lastRender = null; nodes.clear(); queue.replaceChildren(); labels();
  renderCurrent(null);
  status.dataset.state = 'unavailable'; status.textContent = tr('Connexion indisponible', 'Connection unavailable');
  element('count').textContent = '—'; element('remaining').hidden = true; element('remaining').textContent = ''; empty(true, false);
}
async function readState(response) {
  if (!response.ok || !response.body?.getReader) throw Error();
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw Error(); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function refresh() {
  if (stopped) return;
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) { unavailable(); stopped = true; return; }
  const controller = new AbortController(); activeRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch('/state?token=' + token, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal });
    const state = await readState(response);
    if (!stopped && !controller.signal.aborted) render(state);
  } catch { if (!stopped) unavailable(); }
  finally {
    clearTimeout(timeout); if (activeRequest === controller) activeRequest = null;
    if (!stopped) timer = setTimeout(refresh, 1000);
  }
}
addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); activeRequest?.abort(); });
void refresh();
