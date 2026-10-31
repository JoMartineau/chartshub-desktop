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

// Translate the displayed vocabulary only. Source metadata and capability selectors
// retain their original values, including unknown custom instrument names.
const instruments: readonly (readonly [string, string])[] = [
  ['Guitar', 'Guitare'], ['Bass', 'Basse'], ['Drums', 'Batterie'],
  ['Pro Drums', 'Batterie pro'], ['Vocals', 'Chant'], ['Keys', 'Clavier'],
  ['Guitar Co-op', 'Guitare coop'], ['Rhythm', 'Guitare rythmique'],
  ['Guitar 6-fret', 'Guitare 6 frettes'], ['Guitar Co-op 6-fret', 'Guitare coop 6 frettes'],
  ['Rhythm 6-fret', 'Rythmique 6 frettes'], ['Bass 6-fret', 'Basse 6 frettes'],
];
const difficulties: readonly (readonly [string, string])[] = [
  ['Easy', 'Facile'], ['Medium', 'Moyen'], ['Hard', 'Difficile'], ['Expert', 'Expert'],
];
function localized(value: string | null, state: AppState, vocabulary: readonly (readonly [string, string])[]): string | null {
  if (value === null || !state.performance?.language) return value;
  const match = vocabulary.find(([en, fr]) => en.toLowerCase() === value.toLowerCase() || fr.toLowerCase() === value.toLowerCase());
  return match ? match[state.performance.language === 'fr' ? 1 : 0] : value;
}
export const selectLocalizedInstrument: WidgetTextSelector = state => localized(selectInstrument(state), state, instruments);
export const selectLocalizedDifficulty: WidgetTextSelector = state => localized(selectDifficulty(state), state, difficulties);
