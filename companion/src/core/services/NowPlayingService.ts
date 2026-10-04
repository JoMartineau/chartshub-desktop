import type { CloneHeroIntegration } from '../../integrations/clonehero/CloneHeroIntegration.js';
import type { RawCloneHeroSong } from '../../integrations/clonehero/CloneHeroTypes.js';
import type { EventBus } from '../events/EventBus.js';
import { consoleLogger, log, logServiceError, type Logger } from '../logging/Logger.js';
import type { NowPlayingState } from '../types/NowPlaying.js';
import type { Service } from './Service.js';
import { normalizeSong } from './normalizeSong.js';

export { normalizeSong } from './normalizeSong.js';

export class NowPlayingService implements Service {
  private running = false;
  private active = false;
  private revision = 0;
  private song: NowPlayingState | null = null;
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly integration: CloneHeroIntegration, private readonly bus: EventBus, private readonly logger: Logger = consoleLogger) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.active = false;
    ++this.revision;
    try {
      this.unsubscribers.push(this.bus.on('gameplay.stateChanged', session => {
        if (!this.running) return;
        this.active = session.state === 'playing' || session.state === 'paused';
        ++this.revision;
        if (this.active) void this.refresh();
        else this.clear();
      }));
      this.unsubscribers.push(this.integration.subscribe(event => {
        if (!this.running) return;
        if (event.type === 'song' && this.active) {
          ++this.revision;
          this.publish(event.song);
        } else if (event.type === 'error') {
          ++this.revision;
          this.clear();
          this.failed();
        }
      }));
      this.healthy();
      log(this.logger, 'info', 'Service started', { service: 'nowPlaying' });
    } catch {
      this.failed();
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.active = false;
    ++this.revision;
    for (const unsubscribe of this.unsubscribers) {
      try { unsubscribe(); } catch { logServiceError(this.logger, 'nowPlaying'); }
    }
    this.unsubscribers = [];
    this.clear();
    this.bus.emit('service.healthChanged', { service: 'nowPlaying', health: { status: 'stopped' } });
  }

  private async refresh(): Promise<void> {
    const revision = ++this.revision;
    try {
      const song = await this.integration.getCurrentSong();
      if (!this.running || !this.active || revision !== this.revision) return;
      this.publish(song);
    } catch {
      if (!this.running || !this.active || revision !== this.revision) return;
      this.clear();
      this.failed();
    }
  }

  private publish(raw: RawCloneHeroSong | null): void {
    const revision = this.revision;
    const song = normalizeSong(raw);
    this.healthy();
    if (!this.running || !this.active || revision !== this.revision) return;
    if (!song) { this.clear(); return; }
    if (JSON.stringify(song) === JSON.stringify(this.song)) return;
    this.song = song;
    log(this.logger, 'info', 'Song detected');
    this.bus.emit('nowPlaying.changed', song);
  }

  private clear(): void {
    const hadSong = this.song !== null;
    this.song = null;
    if (hadSong) log(this.logger, 'info', 'Song cleared');
    this.bus.emit('nowPlaying.cleared', undefined);
  }

  private healthy(): void {
    this.bus.emit('service.healthChanged', { service: 'nowPlaying', health: { status: 'running' } });
  }

  private failed(): void {
    logServiceError(this.logger, 'nowPlaying');
    this.bus.emit('service.healthChanged', { service: 'nowPlaying', health: { status: 'error', message: 'Song metadata is unavailable.' } });
  }
}
