import type { CloneHeroIntegration } from '../../integrations/clonehero/CloneHeroIntegration.js';
import type { EventBus } from '../events/EventBus.js';
import { consoleLogger, log, logServiceError, type Logger } from '../logging/Logger.js';
import { createGameplaySession, type GameplaySessionState } from '../types/GameplayState.js';
import type { Service } from './Service.js';

export class GameplaySessionService implements Service {
  private running = false;
  private revision = 0;
  private unsubscribe: (() => void) | null = null;
  private pending: Promise<void> | null = null;
  private session = createGameplaySession('idle');

  constructor(private readonly integration: CloneHeroIntegration, private readonly bus: EventBus, private readonly logger: Logger = consoleLogger) {}

  start(): Promise<void> {
    if (this.running) return this.pending ?? Promise.resolve();
    this.running = true;
    const revision = ++this.revision;
    this.bus.emit('service.healthChanged', { service: 'gameplay', health: { status: 'starting' } });
    this.pending = this.initialize(revision);
    return this.pending;
  }

  private async initialize(revision: number): Promise<void> {
    try {
      this.unsubscribe = this.integration.subscribe(event => {
        if (!this.running) return;
        if (event.type === 'gameplay') {
          ++this.revision;
          this.apply(event.gameplay);
          this.healthy();
        } else if (event.type === 'error') {
          ++this.revision;
          this.apply(createGameplaySession('idle'));
          this.failed();
        }
      });
      const session = await this.integration.getGameplayState();
      // A live transition always supersedes the initial asynchronous snapshot.
      if (!this.running || revision !== this.revision) return;
      this.apply(session);
      this.healthy();
      log(this.logger, 'info', 'Service started', { service: 'gameplay' });
    } catch {
      if (!this.running || revision !== this.revision) return;
      this.apply(createGameplaySession('idle'));
      this.failed();
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    ++this.revision;
    try { this.unsubscribe?.(); } catch { logServiceError(this.logger, 'gameplay'); }
    this.unsubscribe = null;
    this.pending = null;
    this.apply(createGameplaySession('idle'));
    this.bus.emit('service.healthChanged', { service: 'gameplay', health: { status: 'stopped' } });
  }

  private apply(session: GameplaySessionState): void {
    const next = createGameplaySession(session.state);
    if (next.state === this.session.state && next.isChartActive === this.session.isChartActive) return;
    this.session = next;
    log(this.logger, 'info', 'Gameplay state changed', { state: next.state });
    this.bus.emit('gameplay.stateChanged', next);
  }

  private healthy(): void {
    this.bus.emit('service.healthChanged', { service: 'gameplay', health: { status: 'running' } });
  }

  private failed(): void {
    logServiceError(this.logger, 'gameplay');
    this.bus.emit('service.healthChanged', { service: 'gameplay', health: { status: 'error', message: 'Gameplay state is unavailable.' } });
  }
}
