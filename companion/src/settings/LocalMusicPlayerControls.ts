export interface LocalPlayerSelection {
  id: string; title: string; artist: string; charter?: string; album?: string; year?: string | number; genre?: string;
  durationMs?: number; artworkUrl?: string | null; mediaUrls?: Array<{ name: string; url: string }>;
  videoUrl?: string | null; videoStartTimeMs?: number; videoUnavailable?: string | null;
  tracks?: Array<{ instrument: string; difficulty: string }>;
}
export interface LocalPlayerState {
  revision: number; available: boolean; selection: LocalPlayerSelection | null; playing: boolean;
  currentTime: number; duration: number; volume: number; error: string | null; widgetEnabled: boolean;
  canPrevious?: boolean; canNext?: boolean; loading?: boolean;
  videoEnabled?: boolean;
  appearance?: PlayerAppearance;
  appearanceCanWrite?: boolean; preferencesError?: string | null;
  shuffle?: boolean; playlists?: PlayerPlaylist[]; activePlaylistId?: string | null; queuePosition?: number; queueLength?: number;
  playbackEpoch?: number;
}
interface PlayerPlaylist { id: string; name: string; songIds: string[]; items: Array<{ id: string; title: string; artist: string; available: boolean }> }
interface PlayerAppearance { backgroundColor: string; textColor: string; accentColor: string; secondaryColor: string; spectrumModel: 'bars' | 'curve' | 'circle' | 'mirror' }
const defaultAppearance: PlayerAppearance = { backgroundColor: '#0b1322', textColor: '#eaf2ff', accentColor: '#22d3ee', secondaryColor: '#a855f7', spectrumModel: 'bars' };
const instruments = ['all', 'guitar', 'bass', 'drums', 'pro-drums', 'keys', 'vocals', 'rhythm', 'guitar-coop', 'guitar-6fret', 'bass-6fret', 'rhythm-6fret', 'guitar-coop-6fret'];
const difficulties = ['all', 'easy', 'medium', 'hard', 'expert'];
interface Snapshot { language?: string; player?: LocalPlayerState; library?: { revision?: number; status: string; count: number } }
interface Options { root: HTMLElement; command: (name: string, payload: unknown) => Promise<unknown>; compact?: boolean }
interface Response { ok?: boolean; playlistId?: string; result?: { items: LocalPlayerSelection[]; total: number; offset: number; limit: number } }
const songId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const playlistId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export const localArtworkUrl = (value: unknown): value is string => typeof value === 'string' && /^chartshub-companion:\/\/app\/music-artwork\/[a-f0-9]{64}$/.test(value);
export function formatPlayerTime(value: number): string {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Both surfaces send explicit commands; only the dedicated window owns audio. */
export class LocalMusicPlayerControls {
  private readonly abort = new AbortController();
  private listAbort = new AbortController();
  private state: LocalPlayerState | null = null;
  private nodes = new Map<string, HTMLElement>();
  private items: LocalPlayerSelection[] = [];
  private total = 0;
  private query = '';
  private filters = { artist: '', charter: '', album: '', year: '', audio: 'all', format: 'all', genre: '', instrument: 'all', difficulty: 'all' };
  private searchSerial = 0;
  private loading = false;
  private busy = false;
  private disposed = false;
  private readiness = '';
  private language = '';
  private artwork = '';
  private actionError = false;
  private dragging = new Set<string>();
  private videoSource = '';
  private videoFailed = false;
  private videoGeneration = 0;
  private spectrumContext: CanvasRenderingContext2D | null = null;
  private appearanceDirty = false;
  private playlistAbort = new AbortController();
  private selectedPlaylistId: string | null = null;
  private playlistKey = '';

  constructor(private readonly options: Options) {
    const root = options.root, signal = this.abort.signal;
    root.classList.toggle('local-player-compact', !!options.compact);
    root.setAttribute('translate', 'no');
    const heading = this.make('div', 'heading', 'local-player-heading');
    heading.append(this.make('h2', 'heading-title'), this.button('widget'));
    const now = this.make('div', 'now', 'local-player-now');
    const cover = this.make('div', 'cover', 'local-player-cover');
    const image = this.make('img', 'artwork') as HTMLImageElement; image.alt = ''; image.hidden = true;
    image.addEventListener('error', () => { image.hidden = true; this.get('placeholder').hidden = false; }, { signal });
    const placeholder = this.make('span', 'placeholder'); placeholder.textContent = '♫'; placeholder.setAttribute('aria-hidden', 'true');
    cover.append(image, placeholder);
    const info = this.make('div', 'info', 'local-player-info');
    info.append(this.make('h3', 'title'), this.make('p', 'artist'), this.make('p', 'details'));
    now.append(cover, info);
    const video = this.make('video', 'video', 'local-player-video'); video.muted = true; video.defaultMuted = true; video.playsInline = true; video.preload = 'auto'; video.hidden = true;
    video.addEventListener('error', () => { this.videoFailed = true; video.hidden = true; video.pause(); this.get('cover').hidden = false; this.renderVideoError(); }, { signal });
    video.addEventListener('loadedmetadata', () => this.syncVideo(), { signal });
    const videoOption = this.make('label', 'video-option', 'local-player-video-option');
    const videoEnabled = this.make('input', 'video-enabled'); videoEnabled.type = 'checkbox';
    videoEnabled.addEventListener('change', () => { if (!videoEnabled.disabled) void this.send('player.video', { enabled: videoEnabled.checked }); }, { signal });
    videoOption.append(videoEnabled, this.make('span', 'video-label'));
    const videoError = this.make('p', 'video-error', 'local-player-video-error'); videoError.hidden = true;
    const spectrum = this.make('canvas', 'spectrum', 'local-player-spectrum'); spectrum.width = 640; spectrum.height = 80; spectrum.setAttribute('aria-hidden', 'true');
    this.spectrumContext = spectrum.getContext?.('2d') ?? null;
    const appearance = this.make('details', 'appearance', 'local-player-appearance');
    appearance.append(this.make('summary', 'appearance-label'));
    const appearanceForm = this.make('form', 'appearance-form');
    for (const name of ['backgroundColor', 'textColor', 'accentColor', 'secondaryColor']) {
      const label = this.make('label', 'color-' + name + '-field');
      const input = this.make('input', 'color-' + name); input.type = 'color';
      input.addEventListener('input', () => { this.appearanceDirty = true; }, { signal });
      label.append(this.make('span', 'color-' + name + '-label'), input); appearanceForm.append(label);
    }
    const modelLabel = this.make('label', 'spectrum-model-field'), model = this.make('select', 'spectrum-model');
    for (const name of ['bars', 'curve', 'circle', 'mirror']) { const option = this.make('option', 'spectrum-model-' + name); option.value = name; model.append(option); }
    model.addEventListener('change', () => { this.appearanceDirty = true; }, { signal });
    modelLabel.append(this.make('span', 'spectrum-model-label'), model); appearanceForm.append(modelLabel);
    const saveAppearance = this.button('appearance-save'); saveAppearance.type = 'submit'; appearanceForm.append(saveAppearance); appearance.append(appearanceForm);
    appearanceForm.addEventListener('submit', event => {
      event.preventDefault();
      if (this.busy || this.disposed || !this.state || this.state.appearanceCanWrite === false) return;
      const values = Object.fromEntries(['backgroundColor', 'textColor', 'accentColor', 'secondaryColor'].map(name => [name, this.get<HTMLInputElement>('color-' + name).value]));
      const spectrumModel = model.value;
      if (Object.values(values).every(value => /^#[a-f0-9]{6}$/i.test(value)) && ['bars', 'curve', 'circle', 'mirror'].includes(spectrumModel)) void this.send('player.appearance', { appearance: { ...values, spectrumModel } });
    }, { signal });
    const transport = this.make('div', 'transport', 'local-player-transport');
    for (const action of ['previous', 'play', 'pause', 'stop', 'next']) {
      const button = this.button(action); transport.append(button);
      button.addEventListener('click', () => { if (!button.disabled) void this.send('player.control', { action }); }, { signal });
    }
    const timeline = this.make('div', 'timeline', 'local-player-timeline');
    timeline.append(this.make('span', 'current-time'), this.range('seek', 0, 0, .1), this.make('span', 'duration'));
    const volume = this.make('label', 'volume-field', 'local-player-volume');
    volume.append(this.make('span', 'volume-label'), this.range('volume', 0, 1, .01), this.make('output', 'volume-value'));
    for (const action of ['seek', 'volume']) {
      const range = this.get<HTMLInputElement>(action);
      range.addEventListener('input', () => { this.dragging.add(action); if (action === 'seek') this.get('current-time').textContent = formatPlayerTime(Number(range.value)); else this.get('volume-value').textContent = `${Math.round(Number(range.value) * 100)} %`; }, { signal });
      range.addEventListener('change', () => {
        this.dragging.delete(action);
        const value = Number(range.value), max = action === 'volume' ? 1 : this.state?.duration ?? 0;
        if (!range.disabled && Number.isFinite(value) && value >= 0 && value <= max) void this.send('player.control', { action, value });
      }, { signal });
      range.addEventListener('blur', () => { this.dragging.delete(action); this.render(); }, { signal });
    }
    const status = this.make('p', 'status', 'local-player-status'); status.setAttribute('role', 'status');
    const error = this.make('p', 'error', 'local-player-error'); error.setAttribute('role', 'alert'); error.hidden = true;
    const form = this.make('form', 'search-form', 'local-player-search');
    const searchLabel = this.make('label', 'query-label'); searchLabel.setAttribute('for', 'local-player-query');
    const input = this.make('input', 'query') as HTMLInputElement; input.type = 'search'; input.maxLength = 200; input.autocomplete = 'off';
    const search = this.button('search'); search.type = 'submit'; form.append(searchLabel, input, search);
    const filters = this.make('details', 'filters', 'local-player-filters'); filters.append(this.make('summary', 'filters-label'));
    const fields = this.make('div', 'filter-fields');
    for (const name of ['artist', 'charter', 'album', 'year', 'audio', 'format', 'genre', 'instrument', 'difficulty'] as const) {
      const label = this.make('label', 'filter-' + name + '-field'); label.append(this.make('span', 'filter-' + name + '-label'));
      if (name === 'audio' || name === 'format' || name === 'instrument' || name === 'difficulty') {
        const select = this.make('select', 'filter-' + name);
        const choices = name === 'audio' ? ['all', 'present', 'missing', 'unknown'] : name === 'format' ? ['all', 'chart', 'midi', 'sng'] : name === 'instrument' ? instruments : difficulties;
        for (const value of choices) { const option = this.make('option', 'filter-' + name + '-' + value); option.value = value; option.textContent = value; select.append(option); }
        select.value = 'all'; label.append(select);
      } else { const field = this.make('input', 'filter-' + name); field.type = 'search'; field.maxLength = 200; label.append(field); }
      fields.append(label);
    }
    filters.append(fields); form.append(filters);
    form.addEventListener('submit', event => {
      event.preventDefault(); this.query = input.value.trim().slice(0, 200);
      for (const name of ['artist', 'charter', 'album', 'year', 'audio', 'format', 'genre', 'instrument', 'difficulty'] as const) this.filters[name] = this.get<HTMLInputElement>('filter-' + name).value.trim().slice(0, 200);
      if (!['all', 'present', 'missing', 'unknown'].includes(this.filters.audio) || !['all', 'chart', 'midi', 'sng'].includes(this.filters.format) || !instruments.includes(this.filters.instrument) || !difficulties.includes(this.filters.difficulty)) return;
      void this.search(false);
    }, { signal });
    const count = this.make('p', 'count', 'local-player-count'); count.setAttribute('role', 'status');
    const results = this.make('div', 'results', 'local-player-results'); results.setAttribute('role', 'list');
    const more = this.button('more'); more.addEventListener('click', () => { if (!more.disabled) void this.search(true); }, { signal });
    const playlist = this.make('details', 'playlists', 'local-player-playlists'); playlist.append(this.make('summary', 'playlists-label'));
    const playlistTools = this.make('div', 'playlist-tools', 'local-player-playlist-tools');
    const choose = this.make('label', 'playlist-select-field'), select = this.make('select', 'playlist-select');
    choose.append(this.make('span', 'playlist-select-label'), select);
    select.addEventListener('change', () => {
      this.selectedPlaylistId = this.state?.playlists?.some(item => item.id === select.value) ? select.value : null;
      this.get<HTMLInputElement>('playlist-name').value = this.selectedPlaylist?.name ?? ''; this.playlistKey = ''; this.renderResults(); this.render();
    }, { signal });
    const startPlaylist = this.button('playlist-play'); startPlaylist.addEventListener('click', () => { if (!startPlaylist.disabled) void this.send('player.playPlaylist', { id: this.selectedPlaylistId }); }, { signal });
    const shuffle = this.make('label', 'shuffle-field'), shuffleInput = this.make('input', 'shuffle'); shuffleInput.type = 'checkbox';
    shuffleInput.addEventListener('change', () => { if (!shuffleInput.disabled) void this.send('player.shuffle', { enabled: shuffleInput.checked }); }, { signal }); shuffle.append(shuffleInput, this.make('span', 'shuffle-label'));
    const nameLabel = this.make('label', 'playlist-name-field'), name = this.make('input', 'playlist-name'); name.type = 'text'; name.maxLength = 100;
    name.addEventListener('input', () => this.render(), { signal }); nameLabel.append(this.make('span', 'playlist-name-label'), name);
    const actions = this.make('div', 'playlist-actions', 'local-player-playlist-actions');
    for (const [action, command] of [['create', 'playlistCreate'], ['rename', 'playlistRename'], ['delete', 'playlistDelete']] as const) {
      const button = this.button('playlist-' + action); actions.append(button);
      button.addEventListener('click', () => {
        if (button.disabled) return;
        const value = name.value.trim();
        if (action !== 'delete' && (!value || value.length > 100 || /[\x00-\x1f\x7f]/.test(value))) return;
        if (action !== 'create' && !this.selectedPlaylist) return;
        void this.send('player.' + command, action === 'create' ? { name: value } : action === 'rename' ? { id: this.selectedPlaylistId, name: value } : { id: this.selectedPlaylistId });
      }, { signal });
    }
    const playlistItems = this.make('div', 'playlist-items', 'local-player-playlist-items'); playlistItems.setAttribute('role', 'list');
    playlistTools.append(choose, startPlaylist, shuffle, nameLabel, actions, playlistItems); playlist.append(playlistTools);
    const queue = this.make('p', 'queue-status', 'local-player-status');
    this.get('widget').addEventListener('click', () => { if (!this.get<HTMLButtonElement>('widget').disabled) void this.send('player.widget', { enabled: options.compact ? false : !this.state?.widgetEnabled }); }, { signal });
    root.append(heading, now, video, videoOption, videoError, spectrum, transport, timeline, volume, status, queue, error, playlist, appearance, form, count, results, more);
    root.ownerDocument.defaultView?.addEventListener('chartshub:languagechange', () => { this.render(); this.renderResults(); }, { signal });
    this.render();
  }
  private make<K extends keyof HTMLElementTagNameMap>(tag: K, id: string, className = ''): HTMLElementTagNameMap[K] {
    const element = this.options.root.ownerDocument.createElement(tag); element.id = 'local-player-' + id; element.className = className;
    this.nodes.set(id, element); return element;
  }
  private button(id: string): HTMLButtonElement { const node = this.make('button', id, 'button secondary'); node.type = 'button'; return node; }
  private range(id: string, min: number, max: number, step: number): HTMLInputElement { const node = this.make('input', id); node.type = 'range'; node.min = String(min); node.max = String(max); node.step = String(step); return node; }
  private get<T extends HTMLElement = HTMLElement>(id: string): T { return this.nodes.get(id) as T; }
  private tr(fr: string, en: string): string { return this.options.root.ownerDocument.documentElement.lang.startsWith('fr') ? fr : en; }
  private instrumentName(value: string): string {
    const names = this.tr('Tous|Guitare|Basse|Batterie|Pro Drums|Clavier|Voix|Rythmique|Guitare coop|Guitare 6 frettes|Basse 6 frettes|Rythmique 6 frettes|Guitare coop 6 frettes', 'All|Guitar|Bass|Drums|Pro Drums|Keys|Vocals|Rhythm|Guitar Co-op|Guitar 6-fret|Bass 6-fret|Rhythm 6-fret|Guitar Co-op 6-fret').split('|');
    return names[instruments.indexOf(value)] ?? '';
  }
  private difficultyName(value: string): string { return this.tr('Toutes|Facile|Moyen|Difficile|Expert', 'All|Easy|Medium|Hard|Expert').split('|')[difficulties.indexOf(value)] ?? ''; }
  private trackText(item: LocalPlayerSelection): string {
    if (!Array.isArray(item.tracks)) return '';
    return [...new Set(item.tracks.filter(track => track && track.instrument !== 'all' && track.difficulty !== 'all' && instruments.includes(track.instrument) && difficulties.includes(track.difficulty)).map(track => `${this.instrumentName(track.instrument)} · ${this.difficultyName(track.difficulty)}`))].join(' / ');
  }
  update(snapshot: Snapshot): void {
    if (this.disposed) return;
    this.state = snapshot.player ?? null;
    const readiness = JSON.stringify([!!this.state?.available, snapshot.library?.revision, snapshot.library?.status]);
    if (readiness !== this.readiness) {
      this.readiness = readiness; this.searchSerial++; this.loading = false; this.items = []; this.total = 0;
      this.renderResults();
      if (this.state?.available) void this.search(false);
    }
    this.render();
  }
  dispose(): void { this.disposed = true; this.searchSerial++; this.abort.abort(); this.listAbort.abort(); this.playlistAbort.abort(); this.releaseVideo(); }
  private get selectedPlaylist(): PlayerPlaylist | undefined { return this.state?.playlists?.find(item => item.id === this.selectedPlaylistId); }
  spectrum(frame: { revision: number; bands: number[] }): void {
    if (this.disposed || frame.revision !== this.state?.revision || !Array.isArray(frame.bands) || frame.bands.length !== 32 || frame.bands.some(value => !Number.isFinite(value) || value < 0 || value > 1)) return;
    const context = this.spectrumContext; if (!context) return;
    const canvas = this.get<HTMLCanvasElement>('spectrum'); context.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.state.playing || !frame.bands.some(value => value > 0)) return;
    const style = this.state.appearance ?? defaultAppearance, model = style.spectrumModel;
    const gradient = context.createLinearGradient(0, 0, canvas.width, 0); gradient.addColorStop(0, /^#[a-f0-9]{6}$/i.test(style.accentColor) ? style.accentColor : defaultAppearance.accentColor); gradient.addColorStop(1, /^#[a-f0-9]{6}$/i.test(style.secondaryColor) ? style.secondaryColor : defaultAppearance.secondaryColor);
    context.fillStyle = gradient; context.strokeStyle = gradient; context.lineWidth = 2; context.lineCap = 'round';
    if (model === 'curve') {
      context.beginPath(); context.moveTo(0, 78);
      for (let index = 0; index < 32; index++) { const x = index * 20 + 10, y = 78 - frame.bands[index]! * 72; const next = frame.bands[index + 1] ?? frame.bands[index]!; context.quadraticCurveTo(x, y, x + 10, 78 - (frame.bands[index]! + next) * 36); }
      context.stroke();
    } else if (model === 'circle') {
      for (let index = 0; index < 32; index++) {
        const angle = index / 32 * Math.PI * 2 - Math.PI / 2, magnitude = frame.bands[index]! * 20;
        if (!magnitude) continue; context.beginPath(); context.moveTo(320 + Math.cos(angle) * 17, 40 + Math.sin(angle) * 17); context.lineTo(320 + Math.cos(angle) * (17 + magnitude), 40 + Math.sin(angle) * (17 + magnitude)); context.stroke();
      }
    } else {
      for (let index = 0; index < 32; index++) { const height = frame.bands[index]! * (model === 'mirror' ? 37 : 76); if (height > 0) context.fillRect(index * 20 + 2, model === 'mirror' ? 40 - height : 80 - height, 14, model === 'mirror' ? height * 2 : height); }
    }
  }
  private releaseVideo(): void {
    this.videoGeneration++; this.videoSource = ''; const video = this.get<HTMLVideoElement>('video');
    video.pause?.(); video.removeAttribute('src'); video.load?.(); video.hidden = true;
  }
  private syncVideo(): void {
    const state = this.state, video = this.get<HTMLVideoElement>('video');
    const url = state?.selection?.videoUrl;
    const source = state?.videoEnabled !== false && typeof url === 'string' && /^chartshub-companion:\/\/app\/music-video\/[a-f0-9]{64}$/.test(url) ? url : '';
    if (source !== this.videoSource) {
      this.releaseVideo(); this.videoFailed = false; this.videoSource = source;
      if (source) { video.muted = true; video.defaultMuted = true; video.src = source; video.load?.(); }
    }
    video.hidden = !source || this.videoFailed;
    this.get('cover').hidden = !!source && !this.videoFailed;
    if (source && !this.videoFailed && video.readyState >= 1 && state) {
      const offset = Number.isFinite(state.selection?.videoStartTimeMs) ? state.selection!.videoStartTimeMs! / 1000 : 0;
      const rawTime = state.currentTime + offset, desired = Math.max(0, rawTime), target = Number.isFinite(video.duration) ? Math.min(desired, video.duration) : desired;
      if (Math.abs(video.currentTime - target) > .3) { try { video.currentTime = target; } catch { /* Wait for seekable data. */ } }
      if (state.playing && rawTime >= 0 && !video.ended) {
        const generation = this.videoGeneration;
        if (video.paused) void video.play().catch(() => { if (generation === this.videoGeneration && !this.disposed) { this.videoFailed = true; video.hidden = true; this.get('cover').hidden = false; this.renderVideoError(); } });
      } else video.pause?.();
    } else video.pause?.();
    this.renderVideoError();
  }
  private renderVideoError(): void {
    const node = this.get('video-error'); node.hidden = !(this.state?.videoEnabled !== false && (this.videoFailed || this.state?.selection?.videoUnavailable));
    node.textContent = this.tr('Vidéo indisponible. La pochette et la lecture audio restent disponibles.', 'Video unavailable. Album artwork and audio playback remain available.');
  }
  private async send(name: string, payload: unknown): Promise<void> {
    if (this.disposed || this.busy || !this.state) return;
    this.busy = true; this.actionError = false; this.render();
    try {
      const response = await this.options.command(name, payload) as Response;
      if (!this.disposed) {
        this.actionError = response?.ok !== true;
        if (name === 'player.appearance' && response?.ok === true) this.appearanceDirty = false;
        if (name === 'player.playlistCreate' && response?.ok === true && playlistId(response.playlistId)) this.selectedPlaylistId = response.playlistId;
        if (name === 'player.playlistDelete' && response?.ok === true) { this.selectedPlaylistId = null; this.get<HTMLInputElement>('playlist-name').value = ''; }
        if (name.startsWith('player.playlist') && response?.ok === true) { this.playlistKey = ''; this.renderResults(); }
      }
    } catch { if (!this.disposed) this.actionError = true; }
    finally { this.busy = false; if (!this.disposed) this.render(); }
  }
  private async search(append: boolean): Promise<void> {
    if (this.disposed || !this.state?.available || (append && (this.loading || this.items.length >= this.total))) return;
    const serial = ++this.searchSerial, offset = append ? this.items.length : 0;
    if (!append) { this.items = []; this.total = 0; this.renderResults(); }
    this.loading = true; this.actionError = false; this.render();
    try {
      const response = await this.options.command('player.search', { query: this.query, offset, limit: 50, filters: { ...this.filters } }) as Response;
      if (this.disposed || serial !== this.searchSerial) return;
      const result = response?.result;
      if (!response?.ok || !result || !Array.isArray(result.items) || result.items.length > 50 || result.items.some(item => !songId(item?.id) || typeof item.title !== 'string' || typeof item.artist !== 'string') || result.offset !== offset || !Number.isSafeInteger(result.total) || result.total < offset + result.items.length) throw Error('Invalid player search');
      const seen = new Set(this.items.map(item => item.id));
      this.items.push(...result.items.filter(item => !seen.has(item.id))); this.total = result.total; this.renderResults();
    } catch { if (!this.disposed && serial === this.searchSerial) this.actionError = true; }
    finally { if (!this.disposed && serial === this.searchSerial) { this.loading = false; this.render(); } }
  }
  private renderResults(): void {
    this.listAbort.abort(); this.listAbort = new AbortController();
    const results = this.get('results'); results.textContent = '';
    for (const item of this.items) {
      const document = results.ownerDocument, card = document.createElement('article'); card.className = 'local-player-song'; card.dataset.songId = item.id; card.setAttribute('role', 'listitem');
      const text = document.createElement('div'), title = document.createElement('strong'), artist = document.createElement('span');
      title.textContent = item.title; artist.textContent = item.artist; text.append(title, artist);
      const metadata = document.createElement('small'); metadata.className = 'local-player-song-metadata'; metadata.textContent = [item.genre, this.trackText(item)].filter(Boolean).join(' · '); text.append(metadata);
      const listen = document.createElement('button'); listen.type = 'button'; listen.className = 'button secondary local-player-listen'; listen.textContent = this.tr('Écouter', 'Listen'); listen.setAttribute('aria-label', `${listen.textContent} : ${item.title}`);
      listen.addEventListener('click', () => { if (!listen.disabled && this.state?.available) void this.send('player.select', { id: item.id }); }, { signal: this.listAbort.signal });
      const actions = document.createElement('div'); actions.className = 'local-player-song-actions'; actions.append(listen);
      const playlist = this.selectedPlaylist;
      if (playlist) {
        const add = document.createElement('button'); add.type = 'button'; add.className = 'button secondary local-player-add-playlist'; add.textContent = playlist.songIds.includes(item.id) ? this.tr('Dans la playlist', 'In playlist') : this.tr('Ajouter', 'Add'); add.dataset.unavailable = String(playlist.songIds.includes(item.id));
        add.setAttribute('aria-label', this.tr(`Ajouter ${item.title} à ${playlist.name}`, `Add ${item.title} to ${playlist.name}`));
        add.addEventListener('click', () => { const current = this.selectedPlaylist; if (!add.disabled && current && !current.songIds.includes(item.id)) void this.send('player.playlistAdd', { id: current.id, songId: item.id }); }, { signal: this.listAbort.signal }); actions.append(add);
      }
      card.append(text, actions); results.append(card);
    }
  }
  private renderPlaylists(): void {
    const playlists = this.state?.playlists ?? [], language = this.options.root.ownerDocument.documentElement.lang;
    if (this.selectedPlaylistId && !playlists.some(item => item.id === this.selectedPlaylistId)) this.selectedPlaylistId = null;
    const key = JSON.stringify([language, playlists, this.selectedPlaylistId]);
    if (key !== this.playlistKey) {
      this.playlistKey = key; this.playlistAbort.abort(); this.playlistAbort = new AbortController();
      const select = this.get<HTMLSelectElement>('playlist-select'), list = this.get('playlist-items'), document = list.ownerDocument;
      select.textContent = ''; list.textContent = '';
      const all = document.createElement('option'); all.value = ''; all.textContent = this.tr('Toute la bibliothèque', 'Entire library'); select.append(all);
      for (const playlist of playlists) { const option = document.createElement('option'); option.value = playlist.id; option.textContent = `${playlist.name} (${playlist.songIds.length})`; select.append(option); }
      select.value = this.selectedPlaylistId ?? '';
      const playlist = this.selectedPlaylist;
      for (const item of playlist?.items ?? []) {
        const row = document.createElement('div'); row.className = 'local-player-playlist-item'; row.dataset.songId = item.id; row.setAttribute('role', 'listitem');
        const label = document.createElement('span'); label.textContent = item.available ? [item.title, item.artist].filter(Boolean).join(' — ') : this.tr('Morceau indisponible', 'Song unavailable');
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button secondary'; remove.textContent = this.tr('Retirer', 'Remove'); remove.setAttribute('aria-label', `${remove.textContent} : ${label.textContent}`);
        remove.addEventListener('click', () => { if (!remove.disabled && playlist && this.selectedPlaylist?.id === playlist.id) void this.send('player.playlistRemove', { id: playlist.id, songId: item.id }); }, { signal: this.playlistAbort.signal }); row.append(label, remove); list.append(row);
      }
      this.renderResults();
    }
    const unavailable = this.busy || !this.state, name = this.get<HTMLInputElement>('playlist-name').value.trim(), writable = !unavailable && this.state?.appearanceCanWrite !== false;
    const validName = !!name && name.length <= 100 && !/[\x00-\x1f\x7f]/.test(name);
    this.get<HTMLButtonElement>('playlist-create').disabled = !writable || !this.state?.available || !validName;
    this.get<HTMLButtonElement>('playlist-rename').disabled = !writable || !this.selectedPlaylist || !validName;
    this.get<HTMLButtonElement>('playlist-delete').disabled = !writable || !this.selectedPlaylist;
    this.get<HTMLButtonElement>('playlist-play').disabled = unavailable || !this.state?.available || (!!this.selectedPlaylistId && !this.selectedPlaylist?.items.some(item => item.available));
    this.get<HTMLSelectElement>('playlist-select').disabled = unavailable;
    this.get<HTMLInputElement>('playlist-name').disabled = !writable;
    this.get<HTMLInputElement>('shuffle').disabled = !writable; this.get<HTMLInputElement>('shuffle').checked = !!this.state?.shuffle;
    for (const button of Array.from(this.get('playlist-items').querySelectorAll<HTMLButtonElement>('button'))) button.disabled = !writable;
  }
  private render(): void {
    if (this.disposed) return;
    const state = this.state, selection = state?.selection, unavailable = !state || this.busy;
    const language = this.options.root.ownerDocument.documentElement.lang;
    if (language !== this.language) { this.language = language; this.renderResults(); }
    const labels: Record<string, string> = {
      'heading-title': this.tr('Lecteur Songs', 'Songs player'), previous: '⏮', play: '▶', pause: 'Ⅱ', stop: '■', next: '⏭',
      'volume-label': this.tr('Volume', 'Volume'), 'query-label': this.tr('Rechercher dans Songs', 'Search Songs'), search: this.tr('Rechercher', 'Search'), more: this.tr('Afficher plus', 'Show more'),
      'video-label': this.tr('Afficher la vidéo du morceau', 'Show song video'),
      'appearance-label': this.tr('Apparence du lecteur', 'Player appearance'), 'appearance-save': this.tr('Enregistrer l’apparence', 'Save appearance'),
      'color-backgroundColor-label': this.tr('Fond', 'Background'), 'color-textColor-label': this.tr('Texte', 'Text'), 'color-accentColor-label': this.tr('Couleur principale', 'Primary color'), 'color-secondaryColor-label': this.tr('Couleur secondaire', 'Secondary color'),
      'spectrum-model-label': this.tr('Style du spectre', 'Spectrum style'), 'spectrum-model-bars': this.tr('Barres', 'Bars'), 'spectrum-model-curve': this.tr('Courbe', 'Curve'), 'spectrum-model-circle': this.tr('Cercle', 'Circle'), 'spectrum-model-mirror': this.tr('Miroir', 'Mirror'),
      'filters-label': this.tr('Filtres de la bibliothèque', 'Library filters'), 'filter-artist-label': this.tr('Artiste', 'Artist'), 'filter-charter-label': this.tr('Créateur', 'Charter'), 'filter-album-label': this.tr('Album', 'Album'), 'filter-year-label': this.tr('Année', 'Year'), 'filter-audio-label': this.tr('Audio', 'Audio'), 'filter-format-label': this.tr('Format', 'Format'),
      'filter-genre-label': this.tr('Genre', 'Genre'), 'filter-instrument-label': this.tr('Instrument', 'Instrument'), 'filter-difficulty-label': this.tr('Difficulté', 'Difficulty'),
      'playlists-label': this.tr('Playlists et lecture aléatoire', 'Playlists and shuffle'), 'playlist-select-label': this.tr('Liste à écouter', 'Playlist to play'), 'playlist-play': this.tr('Lire la playlist', 'Play playlist'), 'shuffle-label': this.tr('Lecture aléatoire', 'Shuffle'), 'playlist-name-label': this.tr('Nom de la playlist', 'Playlist name'), 'playlist-create': this.tr('Créer', 'Create'), 'playlist-rename': this.tr('Renommer', 'Rename'), 'playlist-delete': this.tr('Supprimer la playlist', 'Delete playlist'),
      'filter-audio-all': this.tr('Tous', 'All'), 'filter-audio-present': this.tr('Présent', 'Present'), 'filter-audio-missing': this.tr('Absent', 'Missing'), 'filter-audio-unknown': this.tr('Inconnu', 'Unknown'), 'filter-format-all': this.tr('Tous', 'All'),
      widget: this.options.compact ? '×' : state?.widgetEnabled ? this.tr('Masquer le lecteur flottant', 'Hide floating player') : this.tr('Ouvrir le lecteur flottant', 'Open floating player'),
    };
    for (const [name, label] of Object.entries(labels)) this.get(name).textContent = label;
    for (const value of instruments) this.get('filter-instrument-' + value).textContent = this.instrumentName(value);
    for (const value of difficulties) this.get('filter-difficulty-' + value).textContent = this.difficultyName(value);
    const style = state?.appearance ?? defaultAppearance;
    for (const [field, variable] of [['backgroundColor', '--background'], ['textColor', '--text'], ['accentColor', '--accent'], ['secondaryColor', '--accent-violet']] as const) {
      const value = /^#[a-f0-9]{6}$/i.test(style[field]) ? style[field] : defaultAppearance[field];
      this.options.root.style.setProperty(variable, value);
      if (!this.appearanceDirty) this.get<HTMLInputElement>('color-' + field).value = value;
      this.get<HTMLInputElement>('color-' + field).disabled = unavailable;
    }
    if (!this.appearanceDirty) this.get<HTMLSelectElement>('spectrum-model').value = style.spectrumModel;
    this.get<HTMLSelectElement>('spectrum-model').disabled = unavailable;
    this.get<HTMLButtonElement>('appearance-save').disabled = unavailable || state?.appearanceCanWrite === false;
    const accessible: Record<string, string> = { previous: this.tr('Morceau précédent', 'Previous song'), play: this.tr('Lire', 'Play'), pause: this.tr('Pause', 'Pause'), stop: this.tr('Arrêter', 'Stop'), next: this.tr('Morceau suivant', 'Next song'), seek: this.tr('Position de lecture', 'Playback position'), volume: this.tr('Volume', 'Volume'), widget: this.options.compact ? this.tr('Masquer le lecteur flottant', 'Hide floating player') : labels.widget! };
    for (const [name, label] of Object.entries(accessible)) { this.get(name).setAttribute('aria-label', label); this.get(name).title = label; }
    this.get('title').textContent = selection?.title || this.tr('Choisissez un morceau', 'Choose a song');
    this.get('artist').textContent = selection?.artist ?? '';
    this.get('details').textContent = [selection?.album, selection?.year, selection?.genre, selection?.charter, selection ? this.trackText(selection) : ''].filter(value => value !== undefined && value !== null && value !== '').join(' · ');
    const artwork = localArtworkUrl(selection?.artworkUrl) ? selection.artworkUrl : '';
    if (artwork !== this.artwork) { this.artwork = artwork; const image = this.get<HTMLImageElement>('artwork'); image.hidden = !artwork; this.get('placeholder').hidden = !!artwork; if (artwork) image.src = artwork; else image.removeAttribute('src'); }
    const duration = Number.isFinite(state?.duration) ? Math.max(0, state!.duration) : 0, time = Number.isFinite(state?.currentTime) ? Math.min(duration, Math.max(0, state!.currentTime)) : 0;
    if (!this.dragging.has('seek')) { this.get<HTMLInputElement>('seek').value = String(time); this.get('current-time').textContent = formatPlayerTime(time); }
    this.get<HTMLInputElement>('seek').max = String(duration); this.get('duration').textContent = formatPlayerTime(duration);
    if (!this.dragging.has('volume')) { const value = Number.isFinite(state?.volume) ? Math.min(1, Math.max(0, state!.volume)) : 1; this.get<HTMLInputElement>('volume').value = String(value); this.get('volume-value').textContent = `${Math.round(value * 100)} %`; }
    this.get('status').textContent = !state?.available ? this.tr('Choisissez et scannez votre dossier Songs dans la bibliothèque locale.', 'Choose and scan your Songs folder in the local library.') : state.loading ? this.tr('Préparation du morceau…', 'Preparing song…') : state.playing ? this.tr('Lecture en cours', 'Playing') : selection ? this.tr('Lecture en pause', 'Paused') : this.tr('Choisissez un morceau à écouter. Aucun morceau ne démarre automatiquement.', 'Choose a song to listen to. Playback never starts automatically.');
    const active = state?.playlists?.find(item => item.id === state.activePlaylistId)?.name ?? this.tr('Bibliothèque', 'Library');
    this.get('queue-status').textContent = state?.queueLength ? `${active} · ${state.queuePosition ?? 0} / ${state.queueLength}` : '';
    this.get('error').hidden = !this.actionError && !state?.error && !state?.preferencesError;
    this.get('error').textContent = state?.preferencesError ? this.tr('Les réglages du lecteur ne peuvent pas être enregistrés. Le fichier original est conservé.', 'Player settings cannot be saved. The original file is preserved.') : state?.error === 'unsupported' ? this.tr('Ce format audio ne peut pas être lu.', 'This audio format cannot be played.') : this.tr('Lecture indisponible. Vérifiez les fichiers du morceau, puis réessayez.', 'Playback unavailable. Check the song files, then try again.');
    for (const name of ['play', 'pause', 'stop', 'seek']) this.get<HTMLButtonElement>(name).disabled = unavailable || !selection || !!state?.loading || (name === 'seek' && duration <= 0);
    this.get('play').hidden = !!state?.playing; this.get('pause').hidden = !state?.playing;
    this.get<HTMLButtonElement>('previous').disabled = unavailable || !state?.canPrevious;
    this.get<HTMLButtonElement>('next').disabled = unavailable || !state?.canNext;
    this.get<HTMLInputElement>('volume').disabled = unavailable;
    this.get<HTMLButtonElement>('widget').disabled = unavailable || (!this.options.compact && !state?.available && !state?.widgetEnabled);
    this.get<HTMLButtonElement>('search').disabled = !state?.available || this.loading;
    this.get<HTMLInputElement>('query').disabled = !state?.available;
    this.get<HTMLButtonElement>('more').disabled = !state?.available || this.loading;
    this.get('more').hidden = this.items.length >= this.total;
    this.get('count').textContent = this.loading ? this.tr('Recherche…', 'Searching…') : this.items.length ? this.tr(`${this.items.length} / ${this.total} morceaux`, `${this.items.length} / ${this.total} songs`) : this.tr('Aucun morceau affiché.', 'No songs displayed.');
    this.get('results').setAttribute('aria-busy', String(this.loading));
    this.get<HTMLInputElement>('video-enabled').checked = state?.videoEnabled !== false;
    this.get<HTMLInputElement>('video-enabled').disabled = unavailable;
    this.syncVideo();
    if (!state?.playing) this.spectrum({ revision: state?.revision ?? -1, bands: Array(32).fill(0) });
    this.renderPlaylists();
    for (const button of Array.from(this.get('results').querySelectorAll<HTMLButtonElement>('button'))) button.disabled = unavailable || !state?.available || button.dataset.unavailable === 'true' || (button.className.includes('local-player-add-playlist') && state?.appearanceCanWrite === false);
  }
}
