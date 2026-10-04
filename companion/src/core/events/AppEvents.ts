import type { GameplaySessionState } from '../types/GameplayState.js';
import type { NowPlayingState } from '../types/NowPlaying.js';
import type { ServiceHealth } from '../types/ServiceHealth.js';

/** Only implemented domains belong here; future services extend this contract. */
export interface AppEvents {
  'gameplay.stateChanged': GameplaySessionState;
  'nowPlaying.changed': NowPlayingState;
  'nowPlaying.cleared': undefined;
  'service.healthChanged': { service: string; health: ServiceHealth };
}
