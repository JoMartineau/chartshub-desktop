'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Official 16 px favicon from https://rhythmverse.co/assets/media/logos/favicon.ico, encoded as PNG.
const rhythmVerseLogo = 'data:image/png;base64,' + [
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAKD',
  'SURBVDhP1ZHrS5NxFMe/v+d55nVEZJoEBppkkqFu2kUrb12QgqJAjSjsZoFCIRX5IjCiF5G+0kBiOk0rwmt5WZG5pWs6lbxl6XIRZrVoWrs921B3Qn',
  'shSX9AfeBw3pzPl8M5wP+DjgAtSfCaUtDrLkCPmIm+2RXLx/6OngA1CXgrFgivJiy+DzSiUNdtF9oG78CjBNzlCLNXsXPfa/kb7194X9QP++1QG6X+',
  'XWNSVBqjAeMMYLDt4SaMVumjpq5Vt8oSJYqWwvBnSivcCuxzKzDiVsDjUoLs1YymWiTWQb1vq27U/6B+xEeKCmL4ZirnDcNzfuUNh0IalUhoL864Mnb',
  'g80LAgFsJctaCxCcgsQnkrMf8TDNH4zpvZ98bX43KsPZ6sqnMGD15f6ZoKClb+8krv9EU1PPc7nN5Yf05Zz3I0QKylbJ5azGrcbThiLMVGVYVu/Shn6',
  'vuG/AbVWuD6elQsKg2S/QaG6vudCG9lyCBqxI/HI9BlqscTScKX8wxQsR0nLB4O+NRGW5CBW1AVmFnYBY1h2b21yki13UT+A4P0EEAXDVosJUwMicKN',
  'B0vWMTdfKptF4+vW8OhwWm8RHZUJ06ON+MslSDvXjbyuSLkLX3I9RDJP89wU2a5QOZ4gcQ0TkeHWQplIWQyIia9kz+ua0QOlbBc120uN6OIy8VdnxNL',
  'AQ4Csyfwp+xyftoi58m2jSdnqpfFELXpo0qaaa/icqjS9xg1B+ytbg9KkqpWpy3JC1DsYvEeGds/L2OaeRlzzMYKZNq4ht6FbiDD+jCzKTKwdFYuBIub',
  'fUAVf/q/Q2QMHhlb6Cs9MpbqkbELJMc1isN52gI57YQXbV9u/Sv8AjWeL+0CbVunAAAAAElFTkSuQmCC',
].join('');

if (process.isMainFrame && location.origin === 'https://chartshub.ca' && ['/', '/index.html'].includes(location.pathname)) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}

function mount() {
  const byId = id => document.getElementById(id);
  const catalogue = byId('results');
  const tabs = byId('catalogue-source-tabs');
  const native = byId('native-catalogue-results');
  const nativeGrid = byId('chart-grid');
  const scrollRegion = byId('catalogue-scroll-region');
  const nativeMoreWrap = byId('load-more-wrap');
  const nativeMore = byId('load-more');
  const mode = byId('catalogue-source-mode');
  const input = byId('filter-search');
  const resultControls = catalogue?.querySelector('.catalogue-result-controls');
  if (!catalogue || !tabs || !native || !nativeGrid || !mode || !input || !resultControls || byId('rhythmverse-catalogue-source')) return;

  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const button = (className, text) => {
    const element = node('button', className, text);
    element.type = 'button';
    return element;
  };
  const fr = () => document.documentElement.lang.toLowerCase().startsWith('fr');
  const tr = (en, french) => fr() ? french : en;
  const sourceButton = button('', 'RhythmVerse');
  sourceButton.id = 'rhythmverse-catalogue-source';
  sourceButton.setAttribute('aria-pressed', 'false');
  sourceButton.setAttribute('aria-controls', 'rhythmverse-catalogue-results');
  tabs.append(sourceButton);

  const controls = node('div');
  controls.id = 'rhythmverse-catalogue-controls';
  controls.hidden = true;
  const search = button('button button-primary');
  search.id = 'rhythmverse-catalogue-search';
  const folder = button('button button-ghost');
  folder.id = 'rhythmverse-catalogue-folder';
  folder.hidden = process.platform !== 'win32';
  const help = node('p', 'muted');
  controls.append(search, folder, help);
  resultControls.before(controls);

  const meta = node('div', 'results-meta');
  meta.id = 'rhythmverse-catalogue-meta';
  meta.hidden = true;
  const status = node('p');
  status.id = 'rhythmverse-catalogue-status';
  status.setAttribute('role', 'status');
  const sourceLabel = node('span', 'data-label', 'RhythmVerse');
  meta.append(status, sourceLabel);
  const progress = node('p', 'download-status');
  progress.id = 'rhythmverse-catalogue-progress';
  progress.setAttribute('role', 'status');
  const cancel = button('button button-ghost');
  cancel.hidden = true;
  const retry = button('button button-ghost');
  retry.hidden = true;
  meta.append(progress, cancel, retry);
  resultControls.prepend(meta);

  const panel = node('div');
  panel.id = 'rhythmverse-catalogue-results';
  panel.hidden = true;
  const header = node('div', 'catalogue-list-head');
  header.setAttribute('aria-hidden', 'true');
  const grid = node('div', 'chart-grid');
  grid.id = 'rhythmverse-chart-grid';
  const moreWrap = node('div', 'load-more-wrap');
  moreWrap.hidden = true;
  const more = button('button button-ghost');
  more.id = 'rhythmverse-catalogue-more';
  more.setAttribute('aria-controls', grid.id);
  moreWrap.append(more);
  panel.append(header, grid, moreWrap);
  native.after(panel);

  const downloadDialog = node('dialog', 'catalogue-action-dialog');
  downloadDialog.id = 'rhythmverse-download-dialog';
  downloadDialog.setAttribute('aria-labelledby', 'rhythmverse-download-title');
  document.body.append(downloadDialog);

  webFrame.insertCSS(`
    #rhythmverse-catalogue-controls { grid-column: 1 / -1; }
    #rhythmverse-catalogue-controls .button { min-height: 32px; padding: 6px 9px; font-size: 11px; margin-inline-end: 6px; }
    #rhythmverse-catalogue-controls p { margin: 6px 0 0; font-size: 11px; }
    #rhythmverse-catalogue-meta { flex-wrap: wrap; }
    #rhythmverse-catalogue-meta[hidden], #rhythmverse-catalogue-controls[hidden], #rhythmverse-catalogue-results[hidden], #rhythmverse-catalogue-folder[hidden] { display: none !important; }
    #rhythmverse-catalogue-results { --rhythmverse-list-columns: minmax(0,1.45fr) minmax(0,.7fr) minmax(0,1.25fr) 108px 46px 107px; }
    #results[data-rhythmverse-mixed] :is(#enchor-search, #enchor-status-refresh) { display: none !important; }
    #results[data-rhythmverse-active] :is(#native-catalogue-results,#enchor-search-controls,#enchor-results,.favorites-sync-bar,.catalogue-group-settings,.results-toolbar,#guest-favorites-note,.results-meta:not(#rhythmverse-catalogue-meta),#active-filters,#catalogue-advanced-filters,.legacy-filter-fields,#filters .advanced-fields) { display: none !important; }
    #results #rhythmverse-chart-grid[data-layout=list] { grid-template-columns: minmax(0,1fr); gap: 5px; align-items: start; }
    #results #rhythmverse-chart-grid[data-layout=small] { grid-template-columns: repeat(auto-fill,minmax(min(100%,210px),1fr)); gap: 12px; }
    #results #rhythmverse-chart-grid[data-layout=large] { grid-template-columns: repeat(auto-fill,minmax(min(100%,320px),1fr)); gap: 20px; }
    :is(#rhythmverse-chart-grid, #chart-grid .chart-card[data-catalogue-source=rhythmverse]) .card-cover { --cover-a: #174463; --cover-b: #263350; }
    :is(#rhythmverse-chart-grid, #chart-grid .chart-card[data-catalogue-source=rhythmverse]) .card-cover .album-art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .card-cover[data-rhythmverse-artwork=ready] > :is(.cover-glyph,.cover-lines) { visibility: hidden; }
    #rhythmverse-chart-grid[data-layout=small] .card-cover { height: 115px; }
    #rhythmverse-chart-grid[data-layout=large] .card-cover { height: 215px; }
    #rhythmverse-chart-grid .card-body { gap: 8px; }
    #rhythmverse-chart-grid .card-title, #rhythmverse-chart-grid .card-artist { margin: 0; overflow-wrap: anywhere; }
    #rhythmverse-chart-grid .chart-instruments { display: flex; flex-wrap: wrap; gap: 4px; margin: 0; }
    #rhythmverse-chart-grid .chart-actions { display: flex; flex-wrap: wrap; gap: 5px; margin: 0; }
    #rhythmverse-chart-grid .chart-actions button { min-height: 32px; font-size: 12px; }
    #results #rhythmverse-chart-grid .catalogue-row-source > .catalogue-source-label { white-space: nowrap; font-size: 11px; }
    #rhythmverse-chart-grid .chart-actions .chart-download-options { width: 32px; padding: 0; font-size: 16px; }
    #results #chart-grid [data-catalogue-source=rhythmverse] .chart-download-options { flex: 0 0 30px; width: 30px; padding: 0; }
    #results .chart-card .catalogue-source-label[data-catalogue-source=rhythmverse] { --provider-icon: url('${rhythmVerseLogo}'); }
    #results .chart-card .catalogue-source-label:is([data-catalogue-source=chorusencore], [data-source=chorusencore]) { --provider-icon: url('https://chartshub.ca/assets/enchor-logo.png'); }
    #results .chart-card .catalogue-source-label:is([data-catalogue-source=rhythmverse], [data-catalogue-source=chorusencore], [data-source=chorusencore]):not(:has(img, svg))::before {
      content: ''; display: block; width: 14px; height: 14px; flex: 0 0 14px; background: var(--provider-icon) center / contain no-repeat;
    }
    #results .chart-card .external-source-label > img.external-source-icon { width: 14px; height: 14px; flex: 0 0 14px; object-fit: contain; }
    #rhythmverse-chart-grid[data-layout=list] .chart-card { display: grid; grid-template-columns: 96px minmax(0,1fr); align-items: center; gap: 12px; min-height: 112px; padding: 12px; border-radius: 6px; }
    #rhythmverse-chart-grid[data-layout=list] .card-cover { width: 96px; height: 96px; min-height: 0; border-radius: 5px; }
    #rhythmverse-chart-grid[data-layout=list] .cover-glyph { font-size: 30px; }
    #rhythmverse-chart-grid[data-layout=list] .card-body { display: grid; grid-template-columns: var(--rhythmverse-list-columns); align-items: center; min-width: 0; padding: 0; gap: 8px 12px; }
    #rhythmverse-chart-grid[data-layout=list] .card-body > * { min-width: 0; overflow-wrap: anywhere; }
    #rhythmverse-chart-grid .catalogue-row-title .catalogue-row-meta { color: var(--muted); font-size: 11px; }
    #results #rhythmverse-catalogue-results .catalogue-list-head { grid-template-columns: 96px var(--rhythmverse-list-columns); }
    @media(max-width: 1060px) {
      #rhythmverse-chart-grid[data-layout=list] .chart-card { grid-template-columns: 58px minmax(0,1fr); }
      #rhythmverse-chart-grid[data-layout=list] .card-cover { width: 58px; height: 58px; }
      #rhythmverse-chart-grid[data-layout=list] .card-body { grid-template-columns: repeat(3,minmax(0,1fr)); }
      #rhythmverse-catalogue-results .catalogue-list-head { display: none; }
    }
    @media(max-width: 690px) { #rhythmverse-chart-grid[data-layout=list] .card-body { grid-template-columns: repeat(2,minmax(0,1fr)); } }
  `);

  let active = false, mixed = false, items = [], searched = null, requested = null, revision = 0, downloading = null;
  let mixedTimer = 0, queuedMixedQuery = null, mixedFailedQuery = null, mixedPayload = '', mixedObservedQuery = null;
  let loadedPage = 0, total = null, hasMore = false, failedNextPage = 0;
  let scrollIntentUntil = 0, scrollFrame = 0, lastRegionScrollTop = 0, nativeHidden = native.hidden;
  let cardLayout, cardLanguage;
  const cards = new Map();
  const mixedCards = new Map();
  let mixedItems = new Map();
  const artworkCache = new Map();
  const artworkPending = new Set();
  const visibleCovers = new Set();
  let artworkCacheBytes = 0;
  const coverIds = new WeakMap();
  const artworkObserver = new IntersectionObserver(entries => {
    for (const { target, isIntersecting } of entries) {
      if (isIntersecting && target.isConnected) visibleCovers.add(target);
      else visibleCovers.delete(target);
    }
    loadVisibleArtwork();
  }, { root: scrollRegion || null, rootMargin: '240px 0px 640px' });
  let downloadOrigin = null;
  const instruments = {
    Guitare: 'Guitar', 'Guitare coop': 'Guitar Co-op', 'Guitare 6 touches': 'Guitar 6-fret',
    'Guitare rythmique': 'Rhythm Guitar', Basse: 'Bass', 'Basse 6 touches': 'Bass 6-fret',
    Batterie: 'Drums', 'Batterie pro': 'Pro Drums', Clavier: 'Keys', Chant: 'Vocals',
    'Guitare pro': 'Pro Guitar', 'Basse pro': 'Pro Bass', 'Clavier pro': 'Pro Keys'
  };
  const levels = { Facile: 'Easy', Moyen: 'Medium', Difficile: 'Hard', Expert: 'Expert' };
  const supportedFilters = new Set(['filter-difficulty', 'filter-genre', 'filter-game', 'sort-by']);
  const text = {
    pending: query => query ? tr('Searching RhythmVerse…', 'Recherche RhythmVerse en cours…') : tr('Loading recent charts…', 'Chargement des charts récents…'),
    idle: () => tr('Search by song or artist, or leave the field empty for recent charts.', 'Recherche par titre ou artiste, ou laisse le champ vide pour voir les charts récents.'),
    invalid: () => tr('Enter 2 to 120 characters.', 'Saisis de 2 à 120 caractères.'),
    error: () => tr('RhythmVerse search is unavailable.', 'La recherche RhythmVerse est indisponible.'),
    morePending: () => tr('Loading more charts…', 'Chargement d’autres charts…'),
    moreError: () => tr('Could not load more charts. Try again.', 'Impossible de charger la suite. Réessaie.'),
  };

  function updateLabels() {
    search.textContent = tr('Search RhythmVerse', 'Rechercher sur RhythmVerse');
    folder.textContent = tr('Change download folder', 'Changer le dossier de téléchargement');
    help.textContent = tr('Filters apply to loaded results.', 'Les filtres s’appliquent aux résultats chargés.');
    cancel.textContent = tr('Cancel download', 'Annuler le téléchargement');
    more.textContent = tr('Load more', 'Charger plus');
    retry.textContent = tr('Retry RhythmVerse', 'Réessayer RhythmVerse');
    header.replaceChildren(...[
      tr('Title / Artist', 'Titre / Artiste'), 'Charter', tr('Instrument / Difficulty', 'Instrument / Difficulté'),
      'Source', tr('Duration', 'Durée'), 'Actions'
    ].map(label => node('span', '', label)));
  }

  function matching() {
    const instrument = byId('instrument-options')?.querySelector('[data-instrument][aria-pressed="true"]')?.dataset.instrument || 'all';
    const difficultyControl = byId('filter-difficulty');
    const selectedDifficulty = difficultyControl?.value?.trim();
    const difficulty = levels[selectedDifficulty] || Object.values(levels).find(level => level.toLowerCase() === selectedDifficulty?.toLowerCase())
      || ['all', 'Easy', 'Medium', 'Hard', 'Expert'][difficultyControl?.selectedIndex] || 'all';
    const genre = byId('filter-genre')?.value || 'all';
    const game = byId('filter-game')?.value || 'all';
    const selected = items.filter(item => {
      if (game !== 'all' && game !== 'Clone Hero' || genre !== 'all' && item.genre?.toLowerCase() !== genre.toLowerCase()) return false;
      if (instrument === 'all' && difficulty === 'all') return true;
      return item.instruments.some(track => (instrument === 'all' || instruments[track.name] === instrument)
        && (difficulty === 'all' || track.available.some(level => levels[level] === difficulty)));
    });
    const sort = byId('sort-by')?.value;
    if (sort === 'title' || sort === 'artist') selected.sort((left, right) => left[sort].localeCompare(right[sort]));
    else if (sort === 'year') selected.sort((left, right) => (right.year || 0) - (left.year || 0));
    return selected;
  }

  function trackRow(item) {
    const tracks = node('div', 'chart-instruments');
    for (const track of item.instruments) {
      const label = fr() ? track.name : instruments[track.name] || track.name;
      const trackLevels = track.available.map(level => fr() ? level : levels[level] || level);
      const badge = node('span', 'chart-instrument');
      badge.title = [label, track.rank && `${tr('Intensity', 'Intensité')} ${track.rank}`, trackLevels.join(', ')].filter(Boolean).join(' · ');
      badge.setAttribute('aria-label', badge.title);
      badge.append(node('span', 'instrument-name', label), node('b', 'instrument-intensity', track.rank || '—'));
      if (trackLevels.length) {
        const indicators = node('span', 'instrument-levels');
        indicators.setAttribute('aria-hidden', 'true');
        for (const level of trackLevels) {
          const indicator = node('span', 'available', level === 'Expert' ? 'X' : level[0]);
          indicator.title = level;
          indicators.append(indicator);
        }
        badge.append(indicators);
      }
      tracks.append(badge);
    }
    return tracks;
  }

  function showArtwork(cover, source) {
    artworkObserver.unobserve(cover);
    visibleCovers.delete(cover);
    cover.dataset.rhythmverseArtwork = source ? 'loading' : 'unavailable';
    if (!source) return;
    const image = node('img', 'album-art');
    image.alt = '';
    image.decoding = 'async';
    image.addEventListener('load', () => { cover.dataset.rhythmverseArtwork = 'ready'; }, { once: true });
    image.addEventListener('error', () => { image.remove(); cover.dataset.rhythmverseArtwork = 'unavailable'; }, { once: true });
    image.src = source;
    cover.append(image);
  }

  function catalogueViewport() {
    const innerScroll = scrollRegion && /^(auto|scroll|overlay)$/.test(getComputedStyle(scrollRegion).overflowY);
    if (!innerScroll) return { top: 0, bottom: window.innerHeight };
    const top = scrollRegion.getBoundingClientRect().top + scrollRegion.clientTop;
    return { top: Math.max(0, top), bottom: Math.min(window.innerHeight, top + scrollRegion.clientHeight) };
  }

  function loadVisibleArtwork() {
    if (!active) return;
    const viewport = catalogueViewport();
    const covers = Array.from(visibleCovers, cover => {
      const rect = cover.getBoundingClientRect();
      return { cover, distance: Math.max(0, viewport.top - rect.bottom, rect.top - viewport.bottom) };
    }).sort((left, right) => left.distance - right.distance);
    for (const { cover } of covers) {
      const id = coverIds.get(cover);
      if (!cover.isConnected || !id || cover.dataset.rhythmverseArtwork) {
        visibleCovers.delete(cover);
        continue;
      }
      if (artworkCache.has(id)) {
        showArtwork(cover, artworkCache.get(id));
        continue;
      }
      if (artworkPending.has(id) || artworkPending.size >= 6) continue;
      artworkPending.add(id);
      void ipcRenderer.invoke('chartshub-rhythmverse:artwork', id).catch(() => null).then(result => {
        const source = typeof result === 'string' && result.length <= 2 * 1024 * 1024
          && /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[a-z0-9+/]+=*$/i.test(result) ? result : null;
        // A navigation or replaced result can finish an old request after its
        // row is gone. Do not cache a stale miss for a new copy of that chart.
        const current = (cards.get(id) || mixedCards.get(id))?.querySelector('.card-cover');
        if (!source) {
          if (current === cover) showArtwork(cover, null);
          return;
        }
        artworkCache.set(id, source);
        artworkCacheBytes += source?.length || 0;
        while (artworkCache.size > 64 || artworkCacheBytes > 8 * 1024 * 1024) {
          const oldest = artworkCache.keys().next().value;
          artworkCacheBytes -= artworkCache.get(oldest)?.length || 0;
          artworkCache.delete(oldest);
        }
      }).finally(() => {
        artworkPending.delete(id);
        loadVisibleArtwork();
      });
    }
  }

  function preference(key) {
    try { return localStorage.getItem(`chartshub-download-${key}`); }
    catch { return null; }
  }

  function rememberDownload(format, includeVideo) {
    const preferences = { format, video: includeVideo ? 'always' : 'never' };
    for (const [key, value] of Object.entries(preferences)) {
      try { localStorage.setItem(`chartshub-download-${key}`, value); } catch { /* Storage can be unavailable. */ }
      const control = byId(`catalogue-download-${key}`);
      if (control && control.value !== value) {
        control.value = value;
        control.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  function showDownloadOptions(event, item) {
    if (!event.isTrusted || !active || downloading || downloadDialog.open) return;
    downloadOrigin = event.currentTarget;
    const heading = node('h2', '', tr('Download chart', 'Télécharger la chart'));
    heading.id = 'rhythmverse-download-title';
    const song = node('p', 'catalogue-action-song', `${item.artist} · ${item.title}`);
    const content = node('div', 'catalogue-action-content');
    const option = (id, labelText) => {
      const input = node('input');
      input.id = id;
      input.type = 'checkbox';
      const label = node('label', 'catalogue-video-option');
      label.append(input, node('span', '', labelText));
      content.append(label);
      return input;
    };
    const video = option('rhythmverse-download-video', tr('Include video (if available)', 'Inclure la vidéo (si disponible)'));
    video.checked = preference('video') !== 'never';
    const remember = option('rhythmverse-download-remember', tr('Remember my download choices', 'Mémoriser mes choix de téléchargement'));
    const choice = (format, className, label) => {
      const control = button(className, label);
      control.dataset.downloadFormat = format;
      control.addEventListener('click', choiceEvent => {
        if (!choiceEvent.isTrusted || !active || downloading || !downloadDialog.open) return;
        const origin = downloadOrigin;
        const includeVideo = video.checked;
        if (remember.checked) rememberDownload(format, includeVideo);
        downloadDialog.close();
        void activateItem(choiceEvent, item, 'download', { origin, format, includeVideo });
      });
      return control;
    };
    const zip = choice('zip', 'button button-primary', tr('Download ZIP', 'Télécharger ZIP'));
    const sng = choice('sng', 'button button-primary', tr('Download SNG', 'Télécharger SNG'));
    const formats = node('div', 'chart-download-formats');
    formats.append(zip, sng);
    const toFolder = choice('folder', 'button button-ghost', tr('Download to my export folder', 'Télécharger dans mon dossier d’export'));
    content.append(formats, toFolder);
    const close = button('button button-ghost', tr('Close', 'Fermer'));
    close.addEventListener('click', () => downloadDialog.close());
    downloadDialog.replaceChildren(heading, song, content, close);
    downloadDialog.showModal();
    const savedFormat = preference('format');
    const initial = savedFormat === 'zip' ? zip : savedFormat === 'sng' ? sng : toFolder;
    initial.focus();
  }

  function startDownload(event, item) {
    const format = preference('format');
    const video = preference('video');
    if (['zip', 'sng', 'folder'].includes(format) && ['always', 'never'].includes(video)) {
      void activateItem(event, item, 'download', { format, includeVideo: video === 'always' });
    } else {
      showDownloadOptions(event, item);
    }
  }

  async function activateItem(event, item, kind, { origin, format, includeVideo } = {}) {
    if (!event.isTrusted || !active || kind === 'download' && downloading) return;
    const action = origin || event.currentTarget;
    meta.hidden = false;
    if (kind === 'download') {
      downloading = item.id;
      cancel.hidden = false;
      progress.textContent = format === 'folder'
        ? tr('Downloading and extracting…', 'Téléchargement et extraction en cours…')
        : `${tr('Preparing download', 'Préparation du téléchargement')} ${format.toUpperCase()}…`;
    } else progress.textContent = tr('Opening…', 'Ouverture…');
    action.disabled = true;
    try {
      const request = { id: item.id, kind };
      if (kind === 'download') Object.assign(request, { format, includeVideo });
      const result = await ipcRenderer.invoke('chartshub-rhythmverse:open', request);
      if (result?.cancelled) progress.textContent = tr('Download cancelled.', 'Téléchargement annulé.');
      else if (!result?.ok) progress.textContent = result?.error || tr('Action unavailable.', 'Action indisponible.');
      else if (kind === 'download' && format !== 'folder') progress.textContent = [
        `${tr('Download complete', 'Téléchargement terminé')} ${format.toUpperCase()}`, result.folderName,
      ].filter(Boolean).join(' · ');
      else if (kind === 'download' && result.openFailed) progress.textContent = tr('Chart extracted. The folder could not be opened.', 'Chart extraite. Le dossier n’a pas pu être ouvert.');
      else if (kind === 'download') progress.textContent = result.folderName
        ? `${tr('Chart folder opened', 'Dossier du chart ouvert')} · ${result.folderName}`
        : tr('Chart folder opened.', 'Dossier du chart ouvert.');
      else progress.textContent = tr('Opened in the browser.', 'Ouvert dans le navigateur.');
    } catch {
      progress.textContent = tr('Action unavailable.', 'Action indisponible.');
    } finally {
      if (kind === 'download') { downloading = null; cancel.hidden = true; }
      action.disabled = false;
    }
  }

  function card(item, layout, inline = false) {
    const article = node('article', 'chart-card');
    article.dataset.chartId = item.id;
    article.dataset.catalogueSource = 'rhythmverse';
    const cover = node('div', 'card-cover');
    const lines = node('div', 'cover-lines');
    const glyph = node('span', 'cover-glyph', '♫');
    lines.setAttribute('aria-hidden', 'true');
    glyph.setAttribute('aria-hidden', 'true');
    cover.append(lines, glyph);
    if (item.canDownload) {
      const label = node('label', 'chart-select');
      const checkbox = node('input');
      checkbox.type = 'checkbox';
      checkbox.disabled = true;
      label.title = tr('Select ', 'Sélectionner ') + item.title;
      checkbox.setAttribute('aria-label', label.title);
      label.append(checkbox, node('span', '', tr('Select', 'Sélectionner')));
      cover.append(label);
    }
    if (item.hasArtwork) coverIds.set(cover, item.id);
    const body = node('div', 'card-body');
    const title = node('div', 'catalogue-row-title');
    title.append(node('h3', 'card-title', item.title), node('p', 'card-artist', item.artist));
    const metadata = [item.format === 'ch' ? 'Clone Hero' : item.format, item.album, item.year, item.genre].filter(Boolean).join(' · ');
    const info = node('div', 'catalogue-row-info');
    if (metadata) (inline && layout === 'list' ? info : title).append(node('div', 'catalogue-row-meta', metadata));
    const charter = node('div', 'catalogue-row-creator');
    charter.append(node('span', 'charter', item.charter || tr('Unknown charter', 'Charter inconnu')));
    const tracks = node('div', 'catalogue-row-tracks');
    tracks.append(trackRow(item));
    const origin = node('div', 'catalogue-row-source');
    const badge = node('span', 'catalogue-source-label catalogue-source-external', 'RhythmVerse');
    badge.dataset.catalogueSource = 'rhythmverse';
    origin.append(badge);
    const seconds = item.duration > 0 ? Math.floor(item.duration) : null;
    const duration = node('div', 'catalogue-row-duration', seconds === null ? '—' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
    const actions = node('div', 'chart-actions catalogue-row-actions');
    if (item.canDownload) {
      const download = button('button button-primary chart-download-trigger', tr('↓ Download', '↓ Télécharger'));
      download.dataset.rhythmverseAction = 'download';
      download.setAttribute('aria-haspopup', 'dialog');
      download.addEventListener('click', event => startDownload(event, item));
      const options = button('button button-ghost chart-download-options', '⚙');
      const optionsLabel = tr('Download options', 'Options de téléchargement');
      options.title = optionsLabel;
      options.setAttribute('aria-label', optionsLabel);
      options.setAttribute('aria-haspopup', 'dialog');
      options.dataset.rhythmverseAction = 'options';
      options.addEventListener('click', event => showDownloadOptions(event, item));
      actions.append(download, options);
    } else if (item.canDownloadInBrowser) {
      const download = button('button button-primary chart-download-trigger', tr('Download ↗', 'Télécharger ↗'));
      download.title = tr('Download from the host in your browser', 'Télécharger chez l’hébergeur dans le navigateur');
      download.dataset.rhythmverseAction = 'browser-download';
      download.addEventListener('click', event => void activateItem(event, item, 'browser-download'));
      actions.append(download);
    }
    if (item.canOpenPage) {
      const open = button('button button-ghost', tr('Page ↗', 'Fiche ↗'));
      open.title = tr('Open in the browser', 'Ouvrir dans le navigateur');
      open.dataset.rhythmverseAction = 'page';
      open.addEventListener('click', event => void activateItem(event, item, 'page'));
      actions.append(open);
    }
    if (inline && layout === 'list') {
      actions.classList.remove('catalogue-row-actions');
      const actionColumn = node('div', 'catalogue-row-actions');
      const quick = node('div', 'catalogue-row-quick');
      quick.append(...actions.querySelectorAll('[data-rhythmverse-action="options"], [data-rhythmverse-action="page"]'));
      if (actions.children.length) actionColumn.append(actions);
      if (quick.children.length) actionColumn.append(quick);
      body.append(title, charter, tracks, origin, duration, info, actionColumn);
    } else if (layout === 'list') body.append(title, charter, tracks, origin, duration, actions);
    else body.append(title, charter, origin, tracks, duration, actions);
    article.append(cover, body);
    return article;
  }

  function discardRow(row) {
    const cover = row.querySelector('.card-cover');
    artworkObserver.unobserve(cover);
    visibleCovers.delete(cover);
    row.remove();
  }

  function resetRows() {
    for (const row of cards.values()) discardRow(row);
    cards.clear();
  }

  function hydrateMixedCards() {
    if (!mixed) return;
    const visible = new Set();
    for (const slot of nativeGrid.querySelectorAll(':scope > [data-catalogue-source="rhythmverse"]')) {
      const id = slot.dataset.rhythmverseRow || slot.dataset.chartId;
      const item = mixedItems.get(id);
      if (!item) continue;
      visible.add(id);
      let row = mixedCards.get(id);
      if (!row) {
        row = card(item, cardLayout, true);
        row.dataset.catalogueKey = slot.dataset.catalogueKey;
        mixedCards.set(id, row);
      }
      if (row !== slot) slot.replaceWith(row);
      const cover = row.querySelector('.card-cover');
      if (coverIds.has(cover) && !cover.dataset.rhythmverseArtwork) artworkObserver.observe(cover);
    }
    for (const [id, row] of mixedCards) {
      if (!visible.has(id)) { discardRow(row); mixedCards.delete(id); }
    }
  }

  function publishCatalogue(visible) {
    const query = input.value.trim();
    const current = mixed && searched === query;
    const solo = active && !mixed;
    const charts = current || solo ? visible ?? matching() : [];
    mixedItems = new Map((current ? charts : []).map(item => [item.id, item]));
    const payload = {
      enabled: mixed,
      solo,
      query,
      page: current ? loadedPage : 0,
      hasMore: current && hasMore,
      pending: requested !== null || queuedMixedQuery !== null,
      items: charts.map(({ id, title, artist, year, modifiedAt, canDownload }) => ({ id, title, artist, year, modifiedAt, canDownload })),
    };
    const signature = JSON.stringify(payload);
    if (signature === mixedPayload) return;
    try {
      if (contextBridge.executeInMainWorld({ func: updateRhythmVerseInline, args: [payload] })) mixedPayload = signature;
    } catch {
      // Keep the standalone source usable if the hosted catalogue changes.
    }
  }

  function paint(message, preserveScroll = false) {
    if (!active) return;
    const layout = ['small', 'large'].includes(nativeGrid.dataset.layout) ? nativeGrid.dataset.layout : 'list';
    const language = document.documentElement.lang;
    if (cardLayout !== layout || cardLanguage !== language) {
      resetRows();
      for (const row of mixedCards.values()) {
        const cover = row.querySelector('.card-cover');
        artworkObserver.unobserve(cover);
        visibleCovers.delete(cover);
      }
      mixedCards.clear();
      cardLayout = layout;
      cardLanguage = language;
    }
    const query = input.value.trim();
    const pending = requested ? (requested.page > 1 ? text.morePending() : text.pending(requested.query))
      : queuedMixedQuery !== null ? text.pending(queuedMixedQuery) : null;
    if (mixed) {
      const failed = mixedFailedQuery === query && requested === null;
      status.textContent = message ?? pending ?? (failed ? text.error() : '');
      retry.hidden = !failed;
      meta.hidden = !status.textContent && !progress.textContent;
      publishCatalogue();
      hydrateMixedCards();
      return;
    }
    grid.dataset.layout = layout;
    const visibleCharts = matching();
    header.hidden = layout !== 'list' || visibleCharts.length === 0;
    const scrollTop = scrollRegion?.scrollTop || 0;
    const regionTop = preserveScroll && scrollRegion?.getBoundingClientRect().top;
    const anchor = preserveScroll && scrollRegion && Array.from(grid.children).find(row => row.getBoundingClientRect().bottom > regionTop);
    const anchorTop = anchor && anchor.getBoundingClientRect().top;
    const shownIds = new Set(visibleCharts.map(item => item.id));
    for (const [id, row] of cards) {
      if (!shownIds.has(id)) { discardRow(row); cards.delete(id); }
    }
    let cursor = grid.firstElementChild;
    for (const item of visibleCharts) {
      let row = cards.get(item.id);
      if (!row) { row = card(item, layout); cards.set(item.id, row); }
      if (row === cursor) cursor = cursor.nextElementSibling;
      else grid.insertBefore(row, cursor);
      const cover = row.querySelector('.card-cover');
      if (coverIds.has(cover) && !cover.dataset.rhythmverseArtwork) artworkObserver.observe(cover);
    }
    if (preserveScroll && scrollRegion) {
      scrollRegion.scrollTop = anchor?.isConnected ? scrollRegion.scrollTop + anchor.getBoundingClientRect().top - anchorTop : scrollTop;
    }
    if (scrollRegion) lastRegionScrollTop = scrollRegion.scrollTop;
    const loaded = `${items.length}${total === null ? '' : ` / ${total}`} ${searched ? tr('charts loaded', 'charts chargées') : tr('recent charts', 'charts récents')}`;
    const count = visibleCharts.length === items.length ? loaded : `${loaded} · ${visibleCharts.length} ${tr('shown', 'affichées')}`;
    const empty = items.length ? tr('No charts match the selected filters.', 'Aucun chart ne correspond aux filtres sélectionnés.') : tr('No charts found.', 'Aucun chart trouvé.');
    status.textContent = [searched === null ? '' : items.length ? count : empty, message ?? pending].filter(Boolean).join(' · ')
      || text.idle();
    more.hidden = moreWrap.hidden = !hasMore;
    more.disabled = requested !== null || query !== searched;
    search.disabled = requested !== null;
    publishCatalogue(visibleCharts);
  }

  function clearMixedTimer() {
    if (mixedTimer) clearTimeout(mixedTimer);
    mixedTimer = 0;
    queuedMixedQuery = null;
  }

  function setPresentation(presentation) {
    const wasSolo = active && !mixed;
    const wasMixed = mixed;
    const show = presentation !== 'hidden';
    const asMixed = presentation === 'mixed';
    if (active === show && mixed === asMixed) return;
    if (wasSolo) native.hidden = nativeHidden;
    clearMixedTimer();
    active = show;
    mixed = asMixed;
    const solo = active && !mixed;
    sourceButton.setAttribute('aria-pressed', String(solo));
    catalogue.toggleAttribute('data-rhythmverse-active', solo);
    catalogue.toggleAttribute('data-rhythmverse-mixed', mixed);
    panel.hidden = !solo;
    meta.hidden = !solo;
    sourceLabel.hidden = !solo;
    retry.hidden = true;
    controls.hidden = !solo;
    if (wasSolo) resetRows();
    if (!active) {
      scrollIntentUntil = 0;
      if (downloadDialog.open) downloadDialog.close();
      revision++;
      requested = null;
      artworkObserver.disconnect();
      visibleCovers.clear();
      publishCatalogue();
      mixedCards.clear();
      return;
    }
    if (solo) {
      nativeHidden = native.hidden;
      native.hidden = true;
      if (mode.value !== 'chartshub') {
        mode.value = 'chartshub';
        mode.dispatchEvent(new Event('change', { bubbles: true }));
      }
      for (const existing of tabs.querySelectorAll('[data-catalogue-source-mode][aria-pressed="true"]')) existing.setAttribute('aria-pressed', 'false');
    }
    updateLabels();
    paint();
    if (wasMixed) {
      for (const row of mixedCards.values()) discardRow(row);
      mixedCards.clear();
    }
  }

  function queueMixedSearch(delay = 350) {
    if (!mixed) return;
    const query = input.value.trim();
    mixedObservedQuery = query;
    if (queuedMixedQuery === query) return;
    clearMixedTimer();
    if (mixedFailedQuery !== query) mixedFailedQuery = null;
    if (requested && requested.query !== query) {
      revision++;
      requested = null;
    }
    if (query.length === 1 || query.length > 120) { paint(text.invalid()); return; }
    if (query === searched || requested?.query === query || mixedFailedQuery === query) { paint(); return; }
    queuedMixedQuery = query;
    paint();
    mixedTimer = setTimeout(() => {
      clearMixedTimer();
      if (mixed && input.value.trim() === query && searched !== query) void submit(query);
    }, delay);
  }

  function syncNativeMode() {
    if (active && !mixed) return;
    if (mode.value === 'all') {
      setPresentation('mixed');
      queueMixedSearch(0);
    } else if (mixed) setPresentation('hidden');
  }

  async function submit(query, page = 1) {
    if (!active || requested !== null) return;
    if (query.length === 1 || query.length > 120) { paint(text.invalid()); input.focus(); return; }
    const append = page > 1;
    if (append && (query !== searched || !hasMore || page !== loadedPage + 1)) return;
    const request = ++revision;
    requested = { query, page };
    paint();
    try {
      const result = await ipcRenderer.invoke('chartshub-rhythmverse:search', { query, page });
      if (!active || request !== revision) return;
      if (!result?.ok || result.page !== page || !Array.isArray(result.items)) throw Error();
      folder.hidden = result.nativeArchiveSupport === false || process.platform !== 'win32';
      const distinct = new Map((append ? items : []).map(item => [item.id, item]));
      for (const item of result.items) if (!distinct.has(item.id)) distinct.set(item.id, item);
      if (!append) {
        resetRows();
        for (const row of mixedCards.values()) {
          const cover = row.querySelector('.card-cover');
          artworkObserver.unobserve(cover);
          visibleCovers.delete(cover);
        }
        mixedCards.clear();
        mixedFailedQuery = null;
      }
      items = Array.from(distinct.values());
      searched = query;
      loadedPage = page;
      failedNextPage = 0;
      total = Number.isSafeInteger(result.total) && result.total >= 0 ? Math.max(result.total, items.length) : null;
      hasMore = result.hasMore === true;
      requested = null;
      if (!append && scrollRegion && !mixed) { scrollIntentUntil = 0; scrollRegion.scrollTop = 0; }
      paint(undefined, append);
    } catch {
      if (!active || request !== revision) return;
      requested = null;
      if (append) failedNextPage = page;
      else if (mixed) mixedFailedQuery = query;
      paint(append ? text.moreError() : text.error());
    }
  }

  function scheduleScrollPage() {
    if (scrollFrame || !active || performance.now() > scrollIntentUntil) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      const page = loadedPage + 1;
      if (!active || document.hidden || downloadDialog.open || requested !== null || !hasMore
        || failedNextPage === page || input.value.trim() !== searched || performance.now() > scrollIntentUntil) return;
      const sentinel = mixed ? nativeMoreWrap : moreWrap;
      if (!sentinel || sentinel.hidden || mixed && !sentinel.hasAttribute('data-rhythmverse-next')) return;
      const { top, bottom } = catalogueViewport();
      const end = sentinel.getBoundingClientRect();
      if (bottom <= top || end.bottom < top || end.top > bottom + 350) return;
      scrollIntentUntil = 0;
      void submit(searched, page);
    });
  }

  function scrollInput(event) {
    if (!active || !event.isTrusted || downloadDialog.open || event.target?.closest?.('dialog,[role="dialog"]')) return;
    if (event.type === 'wheel' && event.deltaY <= 0) return;
    if (event.type === 'keydown' && (!['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)
      || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(event.target?.tagName || '') || event.target?.isContentEditable)) return;
    scrollIntentUntil = performance.now() + 650;
    scheduleScrollPage();
  }

  const scrollTarget = scrollRegion || window;
  for (const type of ['wheel', 'touchmove', 'keydown']) scrollTarget.addEventListener(type, scrollInput, { passive: true });
  scrollRegion?.addEventListener('scroll', event => {
    const position = scrollRegion.scrollTop;
    // A scrollbar drag or touch momentum may move the list without a wheel event.
    if (active && !mixed && event.isTrusted && position > lastRegionScrollTop && requested === null) scrollIntentUntil = performance.now() + 650;
    lastRegionScrollTop = position;
    scheduleScrollPage();
  }, { passive: true });
  window.addEventListener('scroll', scheduleScrollPage, { passive: true });

  sourceButton.addEventListener('click', event => {
    if (!event.isTrusted) return;
    setPresentation('solo');
    input.focus();
    const query = input.value.trim();
    const initialQuery = query.length >= 2 && query.length <= 120 ? query : '';
    if (searched !== initialQuery) void submit(initialQuery);
  });
  search.addEventListener('click', event => { if (event.isTrusted) void submit(input.value.trim()); });
  retry.addEventListener('click', event => {
    if (!mixed || !event.isTrusted) return;
    mixedFailedQuery = null;
    void submit(input.value.trim());
  });
  more.addEventListener('click', event => {
    if (event.isTrusted && input.value.trim() === searched) void submit(searched, loadedPage + 1);
  });
  nativeMore?.addEventListener('click', event => {
    if (event.isTrusted && mixed && nativeMoreWrap?.hasAttribute('data-rhythmverse-next') && input.value.trim() === searched) {
      void submit(searched, loadedPage + 1);
    }
  }, true);
  byId('catalogue-refresh')?.addEventListener('click', event => {
    if (!mixed || !event.isTrusted) return;
    clearMixedTimer();
    void submit(input.value.trim());
    try { contextBridge.executeInMainWorld({ func: retryChorusSearch }); } catch { /* Hosted UI may differ. */ }
  }, true);
  tabs.addEventListener('click', event => {
    const target = event.target?.closest?.('[data-catalogue-source-mode]');
    if (!event.isTrusted || !target) return;
    if (!active || mixed) { queueMicrotask(syncNativeMode); return; }
    const toMixed = target.dataset.catalogueSourceMode === 'all';
    setPresentation(toMixed ? 'mixed' : 'hidden');
    if (toMixed) queueMicrotask(syncNativeMode);
    // Other source buttons already refresh through the native mode change.
    if (mode.value === target.dataset.catalogueSourceMode) input.dispatchEvent(new Event('input', { bubbles: true }));
  }, true);
  mode.addEventListener('change', () => queueMicrotask(syncNativeMode));
  document.addEventListener('keydown', event => {
    if (!active || !event.isTrusted || event.target !== input || event.key !== 'Enter' || event.isComposing) return;
    if (mixed) {
      try { contextBridge.executeInMainWorld({ func: retryChorusSearch }); } catch { /* Hosted UI may differ. */ }
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    void submit(input.value.trim());
  }, true);
  document.addEventListener('input', event => {
    if (!active || event.target !== input) return;
    if (mixed) {
      if (event.isTrusted && !event.isComposing) queueMixedSearch();
      return;
    }
    event.stopImmediatePropagation();
    if (requested && requested.query !== input.value.trim()) {
      revision++;
      requested = null;
    }
    paint();
  }, true);
  document.addEventListener('compositionend', event => {
    if (mixed && event.target === input && event.isTrusted) queueMixedSearch();
  }, true);
  document.addEventListener('submit', event => {
    if (mixed && event.target?.id === 'hero-search-form' && event.isTrusted) queueMicrotask(() => queueMixedSearch());
  }, true);
  document.addEventListener('change', event => { if (active && supportedFilters.has(event.target.id)) queueMicrotask(() => paint()); });
  document.addEventListener('click', event => {
    if (!active || !event.target?.closest?.('#instrument-options [data-instrument], #reset-filters')) return;
    queueMicrotask(() => {
      if (mixed && event.target?.closest?.('#reset-filters')) queueMixedSearch();
      else paint();
    });
  });
  folder.addEventListener('click', async event => {
    if (!event.isTrusted || !active) return;
    folder.disabled = true;
    try {
      const result = await ipcRenderer.invoke('chartshub:folder', true);
      if (result?.ok) progress.textContent = `${tr('Download folder', 'Dossier de téléchargement')} · ${result.folderName}`;
      else if (!result?.cancelled) progress.textContent = result?.error || tr('Folder unavailable.', 'Dossier indisponible.');
    } catch {
      progress.textContent = tr('Folder unavailable.', 'Dossier indisponible.');
    } finally { folder.disabled = false; }
  });
  cancel.addEventListener('click', event => {
    if (event.isTrusted && active && downloading) void ipcRenderer.invoke('chartshub:cancel').catch(() => {});
  });
  downloadDialog.addEventListener('close', () => {
    const origin = downloadOrigin;
    downloadOrigin = null;
    if (active && origin?.isConnected && !origin.disabled) origin.focus();
  });
  new MutationObserver(() => {
    if (active && !mixed) for (const existing of tabs.querySelectorAll('[data-catalogue-source-mode][aria-pressed="true"]')) existing.setAttribute('aria-pressed', 'false');
    else if (mixed !== (mode.value === 'all')) syncNativeMode();
  }).observe(tabs, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
  new MutationObserver(mutations => {
    if (mutations.some(mutation => mutation.type === 'attributes')) paint();
    if (mixed && mixedObservedQuery !== input.value.trim()) queueMixedSearch();
    hydrateMixedCards();
  }).observe(nativeGrid, { childList: true, attributes: true, attributeFilter: ['data-layout'] });
  new MutationObserver(() => { if (active) { updateLabels(); paint(); } }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  setTimeout(() => {
    publishCatalogue();
    syncNativeMode();
  }, 0);
}

function retryChorusSearch() {
  if (document.getElementById('catalogue-source-mode')?.value !== 'all' || typeof enchorCatalogue === 'undefined') return;
  const state = enchorCatalogue?.snapshot?.();
  if (!state || state.enabled === false || state.suspended || state.remaining || ['status', 'searching'].includes(state.phase)) return;
  if (state.error || state.dirty || !state.result) enchorCatalogue.dirty({ userInitiated: true });
}

function updateRhythmVerseInline(payload) {
  // This function is evaluated in the hosted catalogue's main world. It only
  // receives display metadata and never exposes a native IPC capability.
  const marker = Symbol.for('chartshub.desktop.rhythmverse-inline.v1');
  const nativeRows = window.catalogueRows;
  if (typeof nativeRows?.[marker] === 'function') return nativeRows[marker](payload);

  const nativeCard = window.card;
  const nativeLoading = window.updateCatalogueLoading;
  const list = window.ChartshubCatalogueList;
  if (typeof nativeRows !== 'function' || typeof nativeCard !== 'function' || typeof nativeLoading !== 'function'
    || typeof window.render !== 'function' || typeof list?.compare !== 'function' || typeof list.key !== 'function') return false;

  const byId = id => document.getElementById(id);
  let state = { enabled: false, solo: false, query: '', items: [], page: 0, hasMore: false, pending: false };
  let signature = JSON.stringify(state);
  let selectable = new Map();
  const inAll = () => state.enabled && byId('catalogue-source-mode')?.value === 'all'
    && !document.querySelector('#results [data-tab="favorites"][aria-pressed="true"]');
  const inSolo = () => state.solo && byId('results')?.hasAttribute('data-rhythmverse-active');
  const representative = row => row.kind === 'song-group' && row.versions?.length ? row.versions[0] : row;
  const isRhythmVerse = chart => chart?.source === 'rhythmverse';
  const rhythmVerseTarget = chart => chart.canDownload && /^rhythmverse:[a-z\d_-]{1,80}$/i.test(chart.id) ? chart.id : null;
  const nativeBatchTarget = window.batchTarget;
  const nativeBatchIdentity = window.batchTargetIdentity;
  const nativeBatchQuery = window.batchQuerySignature;
  const nativeBatchVisible = window.currentBatchVisible;
  const nativeBatchControls = window.renderBatchControls;
  const canSelect = typeof batchSelection !== 'undefined' && [
    nativeBatchTarget, nativeBatchIdentity, nativeBatchQuery, nativeBatchVisible, nativeBatchControls,
    window.bindBatchCheckbox, window.setBatchVisible,
  ].every(method => typeof method === 'function');

  if (canSelect) {
    window.batchTarget = chart => isRhythmVerse(chart) ? rhythmVerseTarget(chart) : nativeBatchTarget(chart);
    window.batchTargetIdentity = chart => isRhythmVerse(chart) ? rhythmVerseTarget(chart) : nativeBatchIdentity(chart);
    window.batchQuerySignature = () => (inSolo() ? 'rhythmverse:' : '') + nativeBatchQuery();
    window.currentBatchVisible = () => inSolo() ? [...selectable.values()] : nativeBatchVisible();
    window.renderBatchControls = (...args) => {
      nativeBatchControls(...args);
      const bar = byId('batch-download-bar');
      if (bar?.hidden && (batchVisible.some(isRhythmVerse) || [...batchSelection.values()].some(isRhythmVerse))) bar.hidden = false;
    };

    // The hosted catalogue reconciles its published IDs through keys().
    // Provider selections remain valid across that ChartsHub-only refresh.
    const selectedKeys = batchSelection.keys;
    batchSelection.keys = function* () {
      for (const id of selectedKeys.call(this)) {
        if (!isRhythmVerse(this.get(id))) yield id;
      }
    };

    const observer = new MutationObserver(mutations => {
      for (const { addedNodes } of mutations) {
        for (const row of addedNodes) {
          if (row.dataset?.catalogueSource !== 'rhythmverse') continue;
          const chart = selectable.get(row.dataset.chartId);
          const checkbox = row.querySelector('.chart-select input');
          if (chart && checkbox && checkbox.isConnected) window.bindBatchCheckbox(chart, checkbox);
        }
      }
    });
    for (const id of ['chart-grid', 'rhythmverse-chart-grid']) {
      const grid = byId(id);
      if (grid) observer.observe(grid, { childList: true });
    }
  }

  function rows(...args) {
    const original = nativeRows.apply(this, args);
    if (!inAll() || !state.items.length) return original;
    const sort = byId('sort-by')?.value || 'latest';
    // Add independently after the native grouping step. Native song groups,
    // favorite IDs and batch downloads retain their existing meaning.
    return [...original, ...state.items].sort((a, b) => list.compare(representative(a), representative(b), sort));
  }

  function card(chart, ...args) {
    if (chart?.source !== 'rhythmverse') return nativeCard.call(this, chart, ...args);
    const row = document.createElement('article');
    row.className = 'chart-card';
    row.dataset.chartId = chart.id;
    row.dataset.catalogueSource = 'rhythmverse';
    row.dataset.catalogueKey = list.key(chart);
    row.dataset.rhythmverseRow = chart.id.slice('rhythmverse:'.length);
    // Keep the native card shape for the virtual window's pre-hydration bounds.
    const cover = document.createElement('div');
    cover.className = 'card-cover';
    const body = document.createElement('div');
    body.className = 'card-body';
    const title = document.createElement('h3');
    title.className = 'card-title';
    title.textContent = chart.title;
    const artist = document.createElement('p');
    artist.className = 'card-artist';
    artist.textContent = chart.artist;
    body.append(title, artist);
    row.append(cover, body);
    return row;
  }

  function updateLoading(...args) {
    const outcome = nativeLoading.apply(this, args);
    const active = inAll();
    const wrap = byId('load-more-wrap');
    const more = byId('load-more');
    const next = active && state.hasMore && typeof displayed === 'number' && typeof catalogueResultCount === 'number'
      && displayed >= catalogueResultCount;
    wrap?.toggleAttribute('data-rhythmverse-next', next);
    if (next && wrap && more && (wrap.hidden || more.disabled)) {
      wrap.hidden = false;
      more.disabled = state.pending;
      if (!state.pending) more.textContent = typeof window.catalogueSay === 'function'
        ? window.catalogueSay('Charger plus de charts ↓', 'Load more charts ↓') : 'Load more charts ↓';
    }

    const count = byId('results-count');
    const label = byId('data-label');
    if (count) {
      const base = count.textContent.replace(/ · \d+ RhythmVerse$/, '');
      const nextCount = active ? `${base} · ${state.items.length} RhythmVerse` : base;
      if (count.textContent !== nextCount) count.textContent = nextCount;
    }
    if (label) {
      const base = label.textContent.replace(/ \+ RhythmVerse$/, '');
      const nextLabel = active && base ? `${base} + RhythmVerse` : base;
      if (label.textContent !== nextLabel) label.textContent = nextLabel;
    }
    const chorusStatus = byId('enchor-status');
    if (active && chorusStatus) {
      const previous = chorusStatus.textContent;
      const combined = previous
        .replace(/^Recherche dans les deux sources\. Les charts ChartsHub apparaissent en premier\. /, 'Recherche dans les trois sources. ')
        .replace(/^Searching both sources\. ChartsHub charts appear first\. /, 'Searching all three sources. ');
      if (previous !== combined) chorusStatus.textContent = combined;
    }
    return outcome;
  }

  function update(next) {
    const enabled = next?.enabled === true;
    const solo = next?.solo === true;
    const query = enabled || solo ? String(next.query ?? '').slice(0, 120) : '';
    const items = [];
    const seen = new Set();
    if ((enabled || solo) && Array.isArray(next.items)) {
      for (const entry of next.items) {
        if (typeof entry?.id !== 'string' || !/^[a-z\d_-]{1,80}$/i.test(entry.id) || seen.has(entry.id)
          || typeof entry.title !== 'string' || typeof entry.artist !== 'string') continue;
        seen.add(entry.id);
        items.push({
          id: `rhythmverse:${entry.id}`, source: 'rhythmverse',
          canDownload: entry.canDownload === true,
          title: entry.title.slice(0, 240), artist: entry.artist.slice(0, 240),
          year: Number.isSafeInteger(entry.year) && entry.year > 0 && entry.year <= 9999 ? entry.year : null,
          modifiedAt: typeof entry.modifiedAt === 'string' && entry.modifiedAt.length <= 32
            && Number.isFinite(Date.parse(entry.modifiedAt)) ? new Date(entry.modifiedAt).toISOString() : null,
        });
      }
    }
    const page = enabled && Number.isSafeInteger(next.page) && next.page > 0 ? next.page : 0;
    const replacement = { enabled, solo, query, items, page, hasMore: enabled && next.hasMore === true, pending: enabled && next.pending === true };
    const key = JSON.stringify(replacement);
    if (key === signature) return true;
    selectable = new Map(items.filter(chart => chart.canDownload).map(chart => [chart.id.slice('rhythmverse:'.length), chart]));
    if (enabled === state.enabled && solo === state.solo && page === state.page && (solo || JSON.stringify(items) === JSON.stringify(state.items))) {
      signature = key;
      state = replacement;
      updateLoading();
      if (solo && canSelect) window.setBatchVisible('native', []);
      return true;
    }
    if (typeof cataloguePendingAnchor !== 'undefined' && cataloguePendingAnchor === null
      && typeof window.rememberCatalogueAnchor === 'function') {
      cataloguePendingAnchor = window.rememberCatalogueAnchor();
    }
    if (enabled && state.enabled && state.page >= 1 && page > state.page
      && typeof displayed === 'number' && typeof catalogueResultCount === 'number' && displayed >= catalogueResultCount) {
      displayed += Math.max(0, items.length - state.items.length);
    }
    signature = key;
    state = replacement;
    window.render();
    if (solo && canSelect) window.setBatchVisible('native', []);
    return true;
  }

  Object.defineProperty(rows, marker, { value: update });
  window.catalogueRows = rows;
  window.card = card;
  window.updateCatalogueLoading = updateLoading;
  // A speculative page must not reserve a shared upstream ChorusEncore slot.
  // The hosted catalogue still loads later pages on deliberate scroll or click.
  if (typeof window.canPrefetchFirstBrowsePage === 'function') window.canPrefetchFirstBrowsePage = () => false;
  return update(payload);
}
