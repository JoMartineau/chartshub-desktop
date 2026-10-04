import type { AppEvents } from './AppEvents.js';
import { consoleLogger, log, type Logger } from '../logging/Logger.js';

export class EventBus<Events extends object = AppEvents> {
  private readonly listeners = new Map<keyof Events, Set<(payload: unknown) => void>>();

  constructor(private readonly logger: Logger = consoleLogger) {}

  on<Key extends keyof Events>(event: Key, listener: (payload: Events[Key]) => void): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    const callback = listener as (payload: unknown) => void;
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
      if (listeners.size === 0 && this.listeners.get(event) === listeners) this.listeners.delete(event);
    };
  }

  emit<Key extends keyof Events>(event: Key, payload: NoInfer<Events[Key]>): void {
    const listeners = this.listeners.get(event);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener(payload);
      } catch {
        log(this.logger, 'error', 'Event listener failed', { event: String(event) });
      }
    }
  }
}
