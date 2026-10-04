import type { GameplaySessionState } from '../../core/types/GameplayState.js';
import type { CloneHeroEvent, RawCloneHeroSong } from './CloneHeroTypes.js';

export interface CloneHeroIntegration {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getCurrentSong(): Promise<RawCloneHeroSong | null>;
  getGameplayState(): Promise<GameplaySessionState>;
  subscribe(listener: (event: CloneHeroEvent) => void): () => void;
}
