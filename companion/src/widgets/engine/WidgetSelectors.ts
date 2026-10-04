import type { AppState } from '../../core/state/AppState.js';

export type WidgetTextSelector = (state: AppState) => string | null;

/** Metadata comes only from the state store. Empty/sentinel values are not UI. */
export function meaningfulText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!text || /^(?:undefined|null|n\/?a|unknown)$/i.test(text)) return null;
  return text;
}

export const selectSongTitle: WidgetTextSelector = state => meaningfulText(state.nowPlaying?.title);
export const selectArtist: WidgetTextSelector = state => meaningfulText(state.nowPlaying?.artist);
export const selectCharter: WidgetTextSelector = state => meaningfulText(state.nowPlaying?.charter);
export const selectInstrument: WidgetTextSelector = state => meaningfulText(state.nowPlaying?.instrument);
export const selectDifficulty: WidgetTextSelector = state => meaningfulText(state.nowPlaying?.difficulty);
