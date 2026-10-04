import type { CloneHeroIntegration } from '../../integrations/clonehero/CloneHeroIntegration.js';
import { EventBus } from '../events/EventBus.js';
import { consoleLogger, log, logServiceError, type Logger } from '../logging/Logger.js';
import { bindStore } from '../state/bindStore.js';
import { createInitialState, createStore, type AppStore } from '../state/createStore.js';
import type { WidgetInstance } from '../types/Widget.js';
import { GameplaySessionService } from './GameplaySessionService.js';
import { NowPlayingService } from './NowPlayingService.js';

export interface ServiceContainerOptions {
  integration: CloneHeroIntegration;
  initialWidgets?: WidgetInstance[];
  logger?: Logger;
}

export class ServiceContainer {
  readonly store: AppStore;
  readonly bus: EventBus;
  readonly cloneHero: CloneHeroIntegration;
  readonly gameplay: GameplaySessionService;
  readonly nowPlaying: NowPlayingService;
  private readonly logger: Logger;
  private wanted = false;
  private revision = 0;
  private startTask: Promise<void> | null = null;
  private connectionTask: Promise<void> | null = null;
  private stopTask: Promise<void> | null = null;
  private unbind: (() => void) | null = null;

  constructor({ integration, initialWidgets = [], logger = consoleLogger }: ServiceContainerOptions) {
    this.logger = logger;
    this.cloneHero = integration;
    this.bus = new EventBus(logger);
    this.store = createStore(createInitialState(initialWidgets), logger);
    this.gameplay = new GameplaySessionService(integration, this.bus, logger);
    this.nowPlaying = new NowPlayingService(integration, this.bus, logger);
  }

  start(): Promise<void> {
    if (this.wanted) return this.startTask ?? Promise.resolve();
    this.wanted = true;
    const revision = ++this.revision;
    const previous = this.stopTask ?? this.startTask;
    const task = (async () => {
      if (previous) {
        try { await previous; } catch { /* The prior lifecycle already reported its failure. */ }
      }
      if (!this.current(revision)) return;
      await this.startServices(revision);
    })();
    this.startTask = task;
    void task.then(() => { if (this.startTask === task) this.startTask = null; }, () => { if (this.startTask === task) this.startTask = null; });
    return task;
  }

  stop(): Promise<void> {
    if (!this.wanted && this.stopTask) return this.stopTask;
    if (!this.wanted && !this.startTask && !this.unbind) return Promise.resolve();
    this.wanted = false;
    ++this.revision;
    // Invalidate in-flight reads and hide the overlay before awaiting the transport.
    this.gameplay.stop();
    this.nowPlaying.stop();
    const pendingConnection = this.connectionTask;
    // A slow metadata/snapshot read must not delay teardown or a subsequent start.
    this.startTask = null;
    const previousStop = this.stopTask;
    const task = (async () => {
      if (previousStop) await previousStop;
      if (pendingConnection) {
        try { await pendingConnection; } catch { /* The cancelled startup no longer changes state. */ }
      }
      try {
        await this.cloneHero.disconnect();
        this.bus.emit('service.healthChanged', { service: 'cloneHero', health: { status: 'stopped' } });
        log(this.logger, 'info', 'Clone Hero integration stopped');
      } catch {
        logServiceError(this.logger, 'cloneHero');
        this.bus.emit('service.healthChanged', { service: 'cloneHero', health: { status: 'error', message: 'Clone Hero could not disconnect cleanly.' } });
      }
      this.unbind?.();
      this.unbind = null;
    })();
    this.stopTask = task;
    void task.then(() => { if (this.stopTask === task) this.stopTask = null; });
    return task;
  }

  setWidgets(instances: WidgetInstance[]): void {
    this.store.setState(state => ({ ...state, widgets: { ...state.widgets, instances } }));
  }

  private current(revision: number): boolean { return this.wanted && revision === this.revision; }

  private async startServices(revision: number): Promise<void> {
    this.unbind = bindStore(this.bus, this.store);
    this.bus.emit('service.healthChanged', { service: 'cloneHero', health: { status: 'starting' } });
    try {
      const connection = this.cloneHero.connect();
      this.connectionTask = connection;
      try { await connection; } finally { if (this.connectionTask === connection) this.connectionTask = null; }
      if (!this.current(revision)) return;
      this.bus.emit('service.healthChanged', { service: 'cloneHero', health: { status: 'running' } });
      log(this.logger, 'info', 'Clone Hero integration started');
      // Bind song visibility before the gameplay service emits its first snapshot.
      await this.nowPlaying.start();
      if (!this.current(revision)) return;
      await this.gameplay.start();
    } catch {
      if (!this.current(revision)) return;
      this.wanted = false;
      ++this.revision;
      this.gameplay.stop();
      this.nowPlaying.stop();
      logServiceError(this.logger, 'cloneHero');
      this.bus.emit('service.healthChanged', { service: 'cloneHero', health: { status: 'error', message: 'Clone Hero integration could not start.' } });
      try { await this.cloneHero.disconnect(); } catch { logServiceError(this.logger, 'cloneHero'); }
      this.unbind?.();
      this.unbind = null;
      throw new Error('Clone Hero integration could not start.');
    }
  }
}
