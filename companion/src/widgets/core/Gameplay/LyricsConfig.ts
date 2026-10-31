export interface LyricsConfig { showNextLine: boolean; }
export function validateLyricsConfig(value: unknown): LyricsConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'showNextLine')
    || ('showNextLine' in value && typeof value.showNextLine !== 'boolean')) throw Error('Configuration des paroles invalide.');
  return { showNextLine: 'showNextLine' in value ? value.showNextLine as boolean : false };
}
