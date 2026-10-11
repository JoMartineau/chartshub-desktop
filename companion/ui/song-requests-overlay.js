const params = new URLSearchParams(location.search), token = params.get('token');
const queue = document.querySelector('#request-queue'), status = document.querySelector('#request-status');
let stopped = false, timer;
let language = 'fr';
async function refresh() {
  if (stopped) return;
  try {
    if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw Error();
    const response = await fetch('/state?token=' + token, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw Error();
    const state = await response.json();
    language = state.language === 'en' ? 'en' : 'fr'; document.documentElement.lang = language;
    if (!Array.isArray(state.requests)) throw Error();
    const rows = state.requests.slice(0, 5);
    const fragment = document.createDocumentFragment();
    for (const [index, request] of rows.entries()) {
      const row = document.createElement('li'), title = document.createElement('strong'), artist = document.createElement('span'), viewer = document.createElement('span');
      title.className = 'request-title'; artist.className = 'request-artist'; viewer.className = 'request-viewer';
      title.textContent = `${index + 1}. ${request.title}`; artist.textContent = request.artist;
      viewer.textContent = `${request.viewerName} · ${request.platform} · ${request.votes} vote${request.votes > 1 ? 's' : ''}${request.status === 'accepted' ? ' · ✓' : ''}`;
      row.append(title, artist, viewer); fragment.append(row);
    }
    queue.replaceChildren(fragment); status.textContent = state.enabled ? `${state.requests.length} ${language === 'en' ? 'request' : 'demande'}${state.requests.length === 1 ? '' : 's'}` : language === 'en' ? 'Requests closed' : 'Demandes fermées';
  } catch { queue.replaceChildren(); status.textContent = language === 'en' ? 'Connection unavailable' : 'Connexion indisponible'; }
  finally { if (!stopped) timer = setTimeout(refresh, 1000); }
}
addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); });
void refresh();
