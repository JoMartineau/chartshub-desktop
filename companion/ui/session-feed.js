// OBS display only: no IPC, devices, connections, commands, links or storage.
const root = document.getElementById('feed'), list = document.getElementById('items');
const kind = location.pathname === '/chat' ? 'chat' : location.pathname === '/activity' ? 'activity' : null;
const query = new URLSearchParams(location.search), tokens = query.getAll('token');
const allowed = kind && location.protocol === 'http:' && location.hostname === '127.0.0.1' && tokens.length === 1 && /^[a-f0-9]{64}$/i.test(tokens[0]) && [...query.keys()].every(key => key === 'token');
const labels = { fr: { chat: 'Chat du stream', activity: 'Activité du stream', added: 'Nouvelle demande', accepted: 'Demande acceptée', played: 'Morceau joué', completed: 'Téléchargement terminé' }, en: { chat: 'Stream chat', activity: 'Stream activity', added: 'New request', accepted: 'Request accepted', played: 'Song played', completed: 'Download completed' } };
let active = true, signature = '', timer = null, request = null;
function node(tag, className, text) { const result = document.createElement(tag); result.className = className; result.textContent = text; return result; }
function render(value) {
  const valid = value?.enabled === true && ['fr', 'en'].includes(value.language) && Number.isInteger(value.settings?.fontSize) && value.settings.fontSize >= 12 && value.settings.fontSize <= 48 && /^#[a-f0-9]{6}$/i.test(value.settings.accent) && Array.isArray(value.items) && value.items.length <= 20;
  const next = valid ? JSON.stringify(value) : '';
  if (next === signature) return;
  signature = next; list.replaceChildren();
  if (!valid) return;
  document.documentElement.lang = value.language; root.setAttribute('aria-label', labels[value.language][kind]); root.style.fontSize = value.settings.fontSize + 'px'; root.style.setProperty('--feed-accent', value.settings.accent);
  for (const item of value.items) {
    const row = node('li', 'feed-item', '');
    if (kind === 'chat') { const heading = node('p', 'feed-heading', ''); heading.append(node('span', 'feed-name', String(item.name ?? '').slice(0, 80)), node('span', 'feed-platform', String(item.platform ?? '').slice(0, 20))); row.append(heading, node('p', 'feed-message', String(item.text ?? '').slice(0, 500))); }
    else { row.append(node('span', 'feed-action', labels[value.language][item.action] ?? ''), node('span', 'feed-title', String(item.title ?? '').slice(0, 200))); if (value.settings.showViewerNames && item.name) row.append(node('p', 'feed-name', String(item.name).slice(0, 80))); }
    list.append(row);
  }
}
async function poll() {
  if (!active || !allowed) return;
  const controller = request = new AbortController(), deadline = setTimeout(() => controller.abort(), 3000);
  try { const url = new URL('/session-state', location.origin); url.searchParams.set('kind', kind); url.searchParams.set('token', tokens[0]); const response = await fetch(url, { signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' }); if (!response.ok) throw Error('Unavailable'); const value = await response.json(); if (active && request === controller) render(value); }
  catch { if (active && request === controller) render(null); }
  finally { clearTimeout(deadline); if (request === controller) request = null; if (active) timer = setTimeout(poll, 500); }
}
window.addEventListener('unload', () => { active = false; clearTimeout(timer); request?.abort(); }, { once: true });
if (allowed) void poll();
