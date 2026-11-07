export function localizedPair(language: string, french: string, english: string, values?: Record<string, unknown>): string {
  const context = globalThis.ChartshubDesktopLocale;
  const locale = context?.runtime.canonicalize(language);
  if (context && locale) return context.pair(french, english, values, locale);
  const message = language.startsWith('fr') ? french : english;
  return values ? message.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (slot, key: string) => Object.hasOwn(values, key) ? String(values[key]) : slot) : message;
}
