import type { ColoredTextSegment } from './ColoredText.js';

export interface NowPlayingState {
  songId?: string;
  title?: string;
  artist?: string;
  album?: string;
  charter?: string;
  charterSegments?: ColoredTextSegment[];
  verifiedCharter?: boolean;
  instrument?: string;
  difficulty?: string;
  bpm?: number;
  noteCount?: number;
  artworkUrl?: string;
  score?: number;
  accuracy?: number;
  combo?: number;
  maxCombo?: number;
  misses?: number;
  elapsedMs?: number;
  durationMs?: number;
}
