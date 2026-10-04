import type { RawCloneHeroSong } from '../../integrations/clonehero/CloneHeroTypes.js';
import type { NowPlayingState } from '../types/NowPlaying.js';
import { validateColoredTextSegments } from '../types/ColoredText.js';

export function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || /^(?:n\/?a|null|undefined|unknown|none|-+)$/i.test(text)) return undefined;
  return text;
}

function normalizeNumber(value: unknown, integer = false, positive = false): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (positive && number === 0) || (integer && !Number.isInteger(number))) return undefined;
  return number;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true' || text === '1') return true;
    if (text === 'false' || text === '0') return false;
  }
  return undefined;
}

/** Missing data remains absent so widgets can resolve capabilities accurately. */
export function normalizeSong(raw: RawCloneHeroSong | null): NowPlayingState | null {
  if (!raw) return null;
  const song: NowPlayingState = {};
  const texts = ['songId', 'title', 'artist', 'album', 'charter', 'instrument', 'difficulty', 'artworkUrl'] as const;
  for (const field of texts) {
    const value = normalizeText(raw[field]);
    if (value !== undefined) song[field] = value;
  }
  if (song.charter) {
    const segments = validateColoredTextSegments(raw.charterSegments, song.charter);
    if (segments) song.charterSegments = segments;
  }
  const counts = ['noteCount', 'score', 'combo', 'maxCombo', 'misses'] as const;
  for (const field of counts) {
    const value = normalizeNumber(raw[field], true);
    if (value !== undefined) song[field] = value;
  }
  for (const field of ['bpm', 'elapsedMs', 'durationMs', 'accuracy'] as const) {
    const value = normalizeNumber(raw[field], false, field === 'bpm' || field === 'durationMs');
    if (value !== undefined && (field !== 'accuracy' || value <= 100)) song[field] = value;
  }
  const verified = normalizeBoolean(raw.verifiedCharter);
  if (verified !== undefined) song.verifiedCharter = verified;
  return Object.keys(song).length ? song : null;
}
