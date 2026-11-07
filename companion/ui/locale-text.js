export function languageCode(value, fallback = 'fr') {
  return globalThis.ChartshubDesktopLocale?.runtime.canonicalize(value) ?? (['fr', 'en'].includes(value) ? value : fallback);
}
export function languageKey(language) {
  return language + ':' + (globalThis.ChartshubDesktopLocale?.runtime.hasPack(language) ? 'ready' : 'fallback');
}
export function wordsFor(words, language) {
  return globalThis.ChartshubDesktopLocale?.dictionary(words.fr, words.en, language) ?? (language === 'fr' ? words.fr : words.en);
}
export function localizedPair(language, french, english, values) {
  const context = globalThis.ChartshubDesktopLocale;
  if (context) return context.pair(french, english, values, language);
  const message = language.startsWith('fr') ? french : english;
  return values ? message.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (slot, key) => Object.hasOwn(values, key) ? String(values[key]) : slot) : message;
}
