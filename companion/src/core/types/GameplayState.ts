export const GAMEPLAY_STATES = ['idle', 'menu', 'loading', 'playing', 'paused', 'results'] as const;
export type GameplayState = (typeof GAMEPLAY_STATES)[number];

export interface GameplaySessionState {
  state: GameplayState;
  isChartActive: boolean;
}

/** Activity is derived from gameplay, never from retained song metadata. */
export function createGameplaySession(state: GameplayState): GameplaySessionState {
  return { state, isChartActive: state === 'playing' || state === 'paused' };
}
