import { charterSegments, instrumentNames, difficultyNames, instrumentPaths } from './catalogue-card-data.js';

const localArtwork = value => typeof value === 'string' && /^chartshub-companion:\/\/app\/catalogue-artwork\/[a-f0-9]{64}$/.test(value);
const rank = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000 ? value : null;
const badgePaths = {
  administrator: 'M3 6 7 11 12 3 17 11 21 6 19 20H5Z',
  moderator: 'M12 2 3 6v6c0 6 9 10 9 10s9-4 9-10V6ZM8 12l3 3 5-6',
  verified: 'M9 3h6l2 3 4 2v8l-4 2-2 3H9l-2-3-4-2V8l4-2ZM8 12l3 3 5-6'
};

/** Main-catalogue presentation, built from text nodes and fixed SVG paths only. */
export function createCatalogueCard(document, item, { locale, demo, signal, expanded, onToggle }) {
  const fr = locale.startsWith('fr'), tr = (french, english) => fr ? french : english;
  const make = (tag, content = '', className = '') => {
    const node = document.createElement(tag); node.className = className;
    if (content !== '') node.textContent = String(content); return node;
  };
  const safeText = value => typeof value === 'string' ? value.slice(0, 512) : '';
  const icon = pathValue => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    path.setAttribute('d', pathValue); svg.append(path); return svg;
  };
  const artwork = (url, className, fallback) => {
    const box = make('span', '', className), placeholder = make('span', fallback); box.setAttribute('aria-hidden', 'true'); box.append(placeholder);
    if (localArtwork(url)) {
      const image = make('img'); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
      // Match the site's bounded retry for cold artwork generation. Reuse the
      // exact local proxy URL; never accept a replacement URL from an error.
      let attempts = 0, timer;
      const clearRetry = () => { clearTimeout(timer); timer = undefined; };
      signal?.addEventListener('abort', clearRetry, { once: true });
      image.addEventListener('load', () => { clearRetry(); image.hidden = false; placeholder.hidden = true; }, { signal });
      image.addEventListener('error', () => {
        clearRetry(); image.hidden = true; image.removeAttribute('src'); placeholder.hidden = false;
        if (attempts >= 2 || signal?.aborted) return;
        timer = setTimeout(() => { timer = undefined; if (!signal?.aborted) { image.hidden = false; image.src = url; } }, [65000, 120000][attempts++]);
        timer.unref?.();
      }, { signal });
      image.src = url; box.append(image);
    }
    return box;
  };
  const card = make('article', '', 'catalogue-item floating-catalogue-item'); card.dataset.chartId = item.id;
  const body = make('div', '', 'catalogue-card-body');
  body.append(make('h3', safeText(item.title) || '—'), make('p', safeText(item.artist) || '—', 'catalogue-item-artist'));
  const tags = make('div', '', 'catalogue-card-tags');
  if (Array.isArray(item.game) && item.game.includes('Clone Hero')) tags.append(make('span', 'Clone Hero', 'catalogue-game-badge'));
  body.append(tags);

  const instruments = make('div', '', 'catalogue-card-instruments');
  for (const key of Object.keys(instrumentNames).filter(key => Array.isArray(item.instruments) && item.instruments.includes(key))) {
    const label = fr ? instrumentNames[key] : key, intensity = rank(item.instrumentIntensities?.[key]);
    const available = Object.keys(difficultyNames).filter(level => Array.isArray(item.instrumentDifficulties?.[key]) && item.instrumentDifficulties[key].includes(level));
    const instrument = make('span', '', 'catalogue-instrument'); instrument.dataset.instrument = key;
    instrument.title = `${label} · ${tr('Intensité', 'Intensity')} : ${intensity ?? tr('inconnue', 'unknown')} · ${available.length ? available.map(level => fr ? difficultyNames[level] : level).join(', ') : tr('difficulté inconnue', 'difficulty unknown')}`;
    instrument.setAttribute('aria-label', instrument.title);
    const family = key === 'Pro Drums' ? 'Drums' : key.startsWith('Bass') ? 'Bass' : key.startsWith('Guitar') || key.startsWith('Rhythm') ? 'Guitar' : key;
    instrument.append(icon(instrumentPaths[family]), make('span', label, 'catalogue-instrument-name'), make('b', intensity ?? '—', 'catalogue-instrument-intensity'));
    const levels = make('span', '', 'catalogue-instrument-levels'); levels.setAttribute('aria-hidden', 'true');
    for (const level of Object.keys(difficultyNames)) {
      const marker = make('span', level === 'Expert' ? 'X' : level[0], available.includes(level) ? 'available' : '');
      marker.title = fr ? difficultyNames[level] : level; levels.append(marker);
    }
    instrument.append(levels); instruments.append(instrument);
  }
  body.append(instruments);

  const identity = make('div', '', 'catalogue-card-charter');
  const charter = safeText(item.charter), name = make('span', '', 'catalogue-charter-name catalogue-item-details');
  const segments = charterSegments(charter, item.charterSegments);
  if (segments) for (const part of segments) { const span = make('span', part.text); if (part.color) span.style.color = part.color; name.append(span); }
  else name.textContent = charter || '—';
  identity.append(artwork(item.charterIconUrl, 'catalogue-charter-avatar', charter.slice(0, 2).toUpperCase() || '♪'), name);
  const badge = role => {
    const label = role === 'administrator' ? 'Admin' : role === 'moderator' ? tr('Modérateur', 'Moderator') : tr('Charter vérifié', 'Verified Charter');
    const node = make('span', '', 'catalogue-staff-badge catalogue-staff-' + role); node.append(icon(badgePaths[role]), make('span', label)); return node;
  };
  if (!demo && ['administrator', 'moderator'].includes(item.staffRole)) identity.append(badge(item.staffRole));
  if (!demo && item.verified === true) identity.append(badge('verified'));
  body.append(identity);

  const details = make('details', '', 'catalogue-card-details'); details.open = expanded;
  details.append(make('summary', tr('Voir les détails', 'View details')));
  const values = make('dl');
  const add = (label, value) => { const pair = make('div'); pair.append(make('dt', label), make('dd', value, 'catalogue-item-details')); values.append(pair); };
  for (const [key, label] of [['album', 'Album'], ['year', tr('Année', 'Year')], ['genre', 'Genre']]) if (safeText(item[key])) add(label, safeText(item[key]));
  if (Number.isSafeInteger(item.duration) && item.duration >= 0) add(tr('Durée', 'Length'), `${Math.floor(item.duration / 60)}:${String(item.duration % 60).padStart(2, '0')}`);
  if (!values.children.length) details.append(make('p', tr('Aucun détail supplémentaire.', 'No additional details.'))); else details.append(values);
  details.addEventListener('toggle', () => onToggle(details.open), { signal });
  body.append(details);
  card.append(artwork(item.artworkUrl, 'catalogue-card-artwork', '♪'), body);
  return { card, body };
}
