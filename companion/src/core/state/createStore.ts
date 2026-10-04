import type { AppState } from './AppState.js';
import type { WidgetInstance } from '../types/Widget.js';
import { createGameplaySession } from '../types/GameplayState.js';
import { consoleLogger, log, type Logger } from '../logging/Logger.js';

export interface AppStore {
  getState(): AppState;
  subscribe(listener: () => void): () => void;
  setState(updater: (state: AppState) => AppState): void;
}

export function createInitialState(initialWidgets: WidgetInstance[] = []): AppState {
  return {
    gameplay: createGameplaySession('idle'),
    nowPlaying: null,
    serviceHealth: {
      cloneHero: { status: 'idle' },
      gameplay: { status: 'idle' },
      nowPlaying: { status: 'idle' },
    },
    widgets: { instances: initialWidgets },
  };
}

/** Updates replace immutable snapshots; subscribers read the latest complete snapshot. */
export function createStore(initial = createInitialState(), logger: Logger = consoleLogger): AppStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setState(updater) {
      const next = updater(state);
      if (Object.is(next, state)) return;
      state = next;
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue;
        try {
          listener();
        } catch {
          log(logger, 'error', 'State subscriber failed');
        }
      }
    },
  };
}
