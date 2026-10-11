import type { LocalPlayerState } from '../settings/LocalMusicPlayerControls.js';
export interface PlayerAction { revision: number; epoch?: number; action: 'play' | 'pause' | 'stop' | 'seek' | 'volume'; value?: number }
export interface PlayerReport { revision: number; playing: boolean; currentTime: number; duration: number; volume: number; errorCode?: 'unavailable' | 'unsupported' | 'playback' }
interface Options {
  report: (state: PlayerReport) => Promise<unknown> | void;
  spectrum?: (state: { revision: number; bands: number[] }) => Promise<unknown> | void;
  ended?: (state: { revision: number; epoch: number }) => Promise<unknown> | void;
  createAudio?: () => HTMLAudioElement; createAudioContext?: () => AudioContext;
  requestFrame?: (callback: FrameRequestCallback) => number; cancelFrame?: (id: number) => void;
}
const mediaUrl = (value: unknown): value is string => typeof value === 'string' && /^chartshub-companion:\/\/app\/music-media\/[a-f0-9]{64}\/(?:0|[1-9]\d*)$/.test(value);

/** One isolated window mixes the local stems; other surfaces never create audio. */
export class LocalMusicPlayerEngine {
  private revision = -1;
  private epoch = 0;
  private selectionKey = '';
  private awaitingSelection = false;
  private tracks: HTMLAudioElement[] = [];
  private abort = new AbortController();
  private timer: ReturnType<typeof setInterval> | null = null;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: PlayerAction[] = [];
  private disposed = false;
  private ready = false;
  private wanted = false;
  private starting = false;
  private generation = 0;
  private time = 0;
  private duration = 0;
  private volume = 1;
  private error: PlayerReport['errorCode'];
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sources: MediaElementAudioSourceNode[] = [];
  private frame: number | null = null;
  private lastSpectrumAt = -Infinity;
  constructor(private readonly options: Options) {}
  update(state: LocalPlayerState): void {
    const key = JSON.stringify([state.selection?.id, state.selection?.mediaUrls]);
    if (this.disposed || state.revision < this.revision || (state.revision === this.revision && key === this.selectionKey)) return;
    this.release(); this.revision = state.revision; this.error = undefined; this.time = 0; this.duration = 0;
    this.epoch = Number.isSafeInteger(state.playbackEpoch) && state.playbackEpoch! >= 0 ? state.playbackEpoch! : 0;
    this.selectionKey = key;
    this.awaitingSelection = !state.selection && !!state.loading;
    this.volume = Number.isFinite(state.volume) ? Math.max(0, Math.min(1, state.volume)) : 1;
    this.pending = this.pending.filter(action => action.revision >= this.revision);
    if (!state.selection) { if (!state.loading) this.pending = []; return; }
    const urls = state.selection.mediaUrls;
    if (!urls?.length || urls.length > 32 || urls.some(item => !mediaUrl(item.url)) || new Set(urls.map(item => item.url)).size !== urls.length) { this.fail('unavailable'); return; }
    const signal = this.abort.signal;
    try {
      this.tracks = urls.map(() => this.options.createAudio?.() ?? new Audio());
      for (const [index, track] of this.tracks.entries()) {
        track.preload = 'auto'; track.volume = this.volume;
        track.addEventListener('error', () => this.fail(track.error?.code === 4 ? 'unsupported' : 'playback'), { signal });
        track.addEventListener('loadedmetadata', () => this.loaded(), { signal });
        track.addEventListener('canplay', () => this.loaded(), { signal });
        track.addEventListener('ended', () => {
          if (this.ready && this.wanted && track === this.master() && track.ended && !track.seeking && track.currentTime >= this.duration - .25) {
            this.wanted = false; this.pause(); this.time = this.duration;
            if (this.options.ended) {
              const revision = this.revision, epoch = this.epoch;
              try { void Promise.resolve(this.options.ended({ revision, epoch })).catch(() => { if (!this.disposed && revision === this.revision && epoch === this.epoch) this.report(); }); } catch { this.report(); }
            } else this.report();
          }
        }, { signal });
        track.src = urls[index]!.url; track.load();
      }
      this.loadTimer = setTimeout(() => { if (!this.ready) this.fail('unavailable'); }, 15000);
      this.timer = setInterval(() => this.progress(), 1000);
      const queued = this.pending.filter(action => action.revision === this.revision); this.pending = this.pending.filter(action => action.revision > this.revision);
      for (const action of queued) this.action(action);
      this.loaded();
    } catch { this.fail('playback'); }
  }
  action(event: PlayerAction): void {
    if (this.disposed || !Number.isSafeInteger(event.revision) || event.revision < this.revision) return;
    if (event.revision > this.revision || this.awaitingSelection) { this.pending.push(event); if (this.pending.length > 32) this.pending.shift(); return; }
    if (event.action === 'volume') {
      if (!Number.isFinite(event.value) || event.value! < 0 || event.value! > 1) return;
      this.volume = event.value!; for (const track of this.tracks) track.volume = this.volume; this.report(); return;
    }
    const epoch = event.epoch ?? 0;
    if (!Number.isSafeInteger(epoch) || epoch < this.epoch) return;
    this.epoch = epoch;
    if (!this.tracks.length || this.error) return;
    if (event.action === 'play') { this.wanted = true; void this.play(); }
    else if (event.action === 'pause' || event.action === 'stop') {
      this.wanted = false; this.pause(); if (event.action === 'stop') this.seek(0); this.report();
    } else if (event.action === 'seek' && Number.isFinite(event.value) && event.value! >= 0 && event.value! <= 86400) {
      this.time = this.ready ? Math.min(this.duration, event.value!) : event.value!;
      if (this.ready) {
        if (this.time >= this.duration) { this.wanted = false; this.pause(); }
        this.seek(this.time); if (this.wanted) void this.play();
      }
      this.report();
    }
  }
  dispose(): void { this.disposed = true; this.pending = []; this.release(); }
  private loaded(): void {
    if (this.disposed || this.error || this.ready || !this.tracks.length || this.tracks.some(track => track.readyState < 2 || !Number.isFinite(track.duration) || track.duration <= 0 || track.duration > 86400)) return;
    this.ready = true; this.duration = Math.max(...this.tracks.map(track => track.duration));
    if (this.loadTimer) clearTimeout(this.loadTimer); this.loadTimer = null;
    this.seek(Math.min(this.time, this.duration)); this.report(); if (this.wanted) void this.play();
  }
  private master(): HTMLAudioElement | undefined { return this.tracks.find(track => track.duration === this.duration) ?? this.tracks[0]; }
  private seek(value: number): void {
    this.time = value;
    for (const track of this.tracks) { if (track.readyState >= 1) { try { track.currentTime = Math.min(value, Number.isFinite(track.duration) ? track.duration : value); } catch { this.fail('playback'); return; } } }
  }
  private pause(): void {
    this.generation++; this.starting = false; for (const track of this.tracks) track.pause();
    if (this.frame !== null) (this.options.cancelFrame ?? cancelAnimationFrame)(this.frame); this.frame = null;
    this.emitSpectrum(Array(32).fill(0));
  }
  private async play(): Promise<void> {
    if (!this.ready || !this.wanted || this.starting || this.error || this.disposed) return;
    if (this.time >= this.duration) this.seek(0);
    const generation = ++this.generation, tracks = this.tracks; this.starting = true;
    try {
      if (!this.context) {
        this.context = this.options.createAudioContext?.() ?? new AudioContext();
        this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 2048; this.analyser.smoothingTimeConstant = .55;
        this.analyser.connect(this.context.destination);
        this.sources = tracks.map(track => { const source = this.context!.createMediaElementSource(track); source.connect(this.analyser!); return source; });
      }
      await this.context.resume();
      if (generation !== this.generation || this.disposed || !this.wanted) return;
      await Promise.all(tracks.filter(track => this.time < track.duration).map(track => track.play()));
      if (generation !== this.generation || this.disposed) return;
      this.starting = false; if (!this.wanted) this.pause(); else this.startSpectrum(); this.report();
    } catch { if (generation === this.generation && !this.disposed) { this.starting = false; this.fail('playback'); } }
  }
  private progress(): void {
    if (!this.ready || this.disposed || this.error) return;
    const master = this.master(); if (!master) return;
    this.time = Math.min(this.duration, Math.max(0, master.currentTime));
    if (this.wanted && !master.paused && !master.seeking) {
      for (const track of this.tracks) if (track !== master && this.time < track.duration && !track.seeking && Math.abs(track.currentTime - this.time) > .12) {
        try { track.currentTime = this.time; } catch { this.fail('playback'); return; }
      }
    }
    this.report();
  }
  private fail(code: PlayerReport['errorCode']): void { this.error = code; this.wanted = false; this.pause(); if (this.loadTimer) clearTimeout(this.loadTimer); this.loadTimer = null; this.report(); }
  private emitSpectrum(bands: number[]): void {
    if (this.disposed || this.revision < 0) return;
    try { void Promise.resolve(this.options.spectrum?.({ revision: this.revision, bands })).catch(() => {}); } catch { /* A closed observer cannot affect playback. */ }
  }
  private startSpectrum(): void {
    if (this.frame !== null || !this.analyser || !this.context || !this.wanted || this.disposed) return;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    const measure = (timestamp: number): void => {
      this.frame = null;
      if (!this.wanted || this.disposed || !this.analyser || !this.context) return;
      if (timestamp - this.lastSpectrumAt >= 100) {
        this.lastSpectrumAt = timestamp; this.analyser.getByteFrequencyData(data);
        const hz = this.context.sampleRate / this.analyser.fftSize;
        const bands = Array.from({ length: 32 }, (_, index) => {
          const lower = Math.max(1, Math.floor(40 * Math.pow(400, index / 32) / hz));
          const upper = Math.min(data.length, Math.max(lower + 1, Math.ceil(40 * Math.pow(400, (index + 1) / 32) / hz)));
          let maximum = 0; for (let bin = lower; bin < upper; bin++) maximum = Math.max(maximum, data[bin] ?? 0);
          return Math.round(maximum / 255 * 1000) / 1000;
        });
        this.emitSpectrum(bands);
      }
      this.frame = (this.options.requestFrame ?? requestAnimationFrame)(measure);
    };
    this.lastSpectrumAt = -Infinity; this.frame = (this.options.requestFrame ?? requestAnimationFrame)(measure);
  }
  private report(): void {
    if (this.disposed || this.revision < 0) return;
    const report: PlayerReport = { revision: this.revision, playing: this.ready && this.wanted && !this.error && this.tracks.some(track => !track.paused), currentTime: this.time, duration: this.duration, volume: this.volume, ...(this.error ? { errorCode: this.error } : {}) };
    try { void Promise.resolve(this.options.report(report)).catch(() => {}); } catch { /* Host disposal must not keep audio running. */ }
  }
  private release(): void {
    this.pause(); this.abort.abort(); this.abort = new AbortController();
    if (this.timer) clearInterval(this.timer); if (this.loadTimer) clearTimeout(this.loadTimer); this.timer = null; this.loadTimer = null;
    for (const track of this.tracks) { track.removeAttribute('src'); track.load(); }
    for (const source of this.sources) source.disconnect(); this.sources = [];
    this.analyser?.disconnect(); this.analyser = null;
    if (this.context) void this.context.close().catch(() => {}); this.context = null;
    this.tracks = []; this.ready = false; this.wanted = false;
  }
}
