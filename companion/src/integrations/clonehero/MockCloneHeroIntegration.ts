import { createGameplaySession, type GameplayState, type GameplaySessionState } from '../../core/types/GameplayState.js';
import { consoleLogger, log } from '../../core/logging/Logger.js';
import type { CloneHeroIntegration } from './CloneHeroIntegration.js';
import type { CloneHeroEvent, RawCloneHeroSong } from './CloneHeroTypes.js';

export const MOCK_SCENARIO: readonly GameplayState[] = ['menu', 'loading', 'playing', 'paused', 'playing', 'results', 'menu'];
const SAMPLE_SONG: Readonly<RawCloneHeroSong> = Object.freeze({
  songId: 'mock-everlong',
  title: '  Everlong  ',
  artist: ' Foo   Fighters ',
  charter: ' ExampleCharter ',
  instrument: ' Guitar ',
  difficulty: ' Expert ',
});

/** Manual, deterministic simulation. No polling or timers and no real game detection. */
export class MockCloneHeroIntegration implements CloneHeroIntegration {
  private connected = false;
  private state: GameplayState = 'menu';
  private stepIndex = 0;
  private readonly listeners = new Set<(event: CloneHeroEvent) => void>();

  async connect(): Promise<void> { this.connected = true; }
  async disconnect(): Promise<void> { this.connected = false; }

  async getCurrentSong(): Promise<RawCloneHeroSong | null> {
    // Deliberately retained in menu/results: gameplay must govern active metadata.
    return { ...SAMPLE_SONG };
  }

  async getGameplayState(): Promise<GameplaySessionState> {
    return createGameplaySession(this.connected ? this.state : 'idle');
  }

  subscribe(listener: (event: CloneHeroEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  transition(state: GameplayState): void {
    const index = MOCK_SCENARIO.indexOf(state);
    if (index >= 0) this.stepIndex = index;
    this.state = state;
    this.publish();
  }

  step(): void {
    this.stepIndex = (this.stepIndex + 1) % MOCK_SCENARIO.length;
    this.state = MOCK_SCENARIO[this.stepIndex] ?? 'menu';
    this.publish();
  }

  reset(): void {
    this.stepIndex = 0;
    this.state = 'menu';
    this.publish();
  }

  private publish(): void {
    if (!this.connected) return;
    this.emit({ type: 'gameplay', gameplay: createGameplaySession(this.state) });
    this.emit({ type: 'song', song: { ...SAMPLE_SONG } });
  }

  private emit(event: CloneHeroEvent): void {
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue;
      try {
        listener(event);
      } catch {
        log(consoleLogger, 'error', 'Clone Hero integration listener failed', { event: event.type });
      }
    }
  }
}
