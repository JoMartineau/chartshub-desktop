import type { EventBus } from '../events/EventBus.js';
import type { AppStore } from './createStore.js';

/** The only events-to-state binding layer; renderers subscribe to the store. */
export function bindStore(bus: EventBus, store: AppStore): () => void {
  const unsubscribe = [
    bus.on('gameplay.stateChanged', gameplay => {
      store.setState(state => ({
        ...state,
        gameplay,
        // Clear atomically so no subscriber can observe inactive, stale metadata.
        nowPlaying: gameplay.isChartActive ? state.nowPlaying : null,
      }));
    }),
    bus.on('nowPlaying.changed', nowPlaying => {
      store.setState(state => state.gameplay.isChartActive ? { ...state, nowPlaying } : state);
    }),
    bus.on('nowPlaying.cleared', () => {
      store.setState(state => state.nowPlaying === null ? state : { ...state, nowPlaying: null });
    }),
    bus.on('service.healthChanged', ({ service, health }) => {
      store.setState(state => ({ ...state, serviceHealth: { ...state.serviceHealth, [service]: health } }));
    }),
  ];
  return () => { unsubscribe.forEach(stop => stop()); };
}
