import type { EventBus } from './EventBus.js';

/** Compiled by the normal typecheck; never invoked at runtime. */
export function verifyEventPayloadTypes(bus: EventBus): void {
  bus.emit('gameplay.stateChanged', { state: 'playing', isChartActive: true });
  bus.emit('nowPlaying.cleared', undefined);
  // @ts-expect-error Event names must be registered in AppEvents.
  bus.emit('unsupported.event', undefined);
  // @ts-expect-error Gameplay is a structured session, not a string.
  bus.emit('gameplay.stateChanged', 'playing');
  // @ts-expect-error Song metrics are normalized numbers.
  bus.emit('nowPlaying.changed', { score: '123' });
  // @ts-expect-error Cleared events cannot retain a song payload.
  bus.emit('nowPlaying.cleared', { title: 'Old song' });
  // @ts-expect-error Listener payloads are checked against the selected event.
  bus.on('nowPlaying.changed', (state: { score: string }) => { void state; });
}
