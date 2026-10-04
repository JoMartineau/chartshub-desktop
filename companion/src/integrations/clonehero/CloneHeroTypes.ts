import type { GameplaySessionState } from '../../core/types/GameplayState.js';

/** External metadata is untrusted until NowPlayingService normalizes it. */
export interface RawCloneHeroSong {
  songId?: unknown;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  charter?: unknown;
  charterSegments?: unknown;
  verifiedCharter?: unknown;
  instrument?: unknown;
  difficulty?: unknown;
  bpm?: unknown;
  noteCount?: unknown;
  artworkUrl?: unknown;
  score?: unknown;
  accuracy?: unknown;
  combo?: unknown;
  maxCombo?: unknown;
  misses?: unknown;
  elapsedMs?: unknown;
  durationMs?: unknown;
}

export type CloneHeroEvent =
  | { type: 'gameplay'; gameplay: GameplaySessionState }
  | { type: 'song'; song: RawCloneHeroSong | null }
  | { type: 'error' };
