'use strict';
(() => {
  const runtime = globalThis.ChartshubLocale;
  if (!runtime) return;
  const assetBase = new URL('../../assets/', document.currentScript?.src || location.href);
  let language = runtime.canonicalize(globalThis.ChartsHubCompanion?.initialLanguage || globalThis.ChartsHubInputViewer?.language || globalThis.ChartsHubInputViewerOutput?.language || document.documentElement.lang) || 'en';
  let revision = 0, pending = Promise.resolve(), requested = '';
  const unavailable = new Set();
  function applyDocument() { const definition = runtime.definition(language); document.documentElement.lang = language; document.documentElement.dir = definition?.dir || 'ltr'; }
  function notify() { globalThis.dispatchEvent(new CustomEvent('chartshub:locale-ready', { detail: { language } })); }
  function set(value) {
    const next = runtime.canonicalize(value); if (!next) return language;
    if (next !== language) { revision++; requested = ''; pending = Promise.resolve(); }
    language = next; applyDocument();
    if (runtime.hasPack(next) || unavailable.has(next) || requested === next) return language;
    const ticket = ++revision; requested = next;
    pending = (async () => {
      try {
        let pack;
        if (globalThis.chartsHubShell?.localePack) pack = await globalThis.chartsHubShell.localePack(next);
        else {
          const response = await fetch(new URL('locale.' + next + '.json', assetBase), { cache: 'force-cache', credentials: 'omit' });
          if (!response.ok || !response.body) throw Error('Language unavailable');
          const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
          let bytes = 0, body = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 1024 * 1024 || ticket !== revision) { await reader.cancel(); throw Error('Language pack no longer needed'); }
            body += decoder.decode(value, { stream: true });
          }
          pack = JSON.parse(body + decoder.decode());
        }
        if (ticket !== revision || next !== language) return;
        if (runtime.canonicalize(pack?.locale) !== next) throw Error('Language pack mismatch');
        runtime.installPack(pack); notify();
      } catch { if (ticket === revision) unavailable.add(next); }
      finally { if (ticket === revision) requested = ''; }
    })();
    return language;
  }
  const t = (source, values, locale = language) => runtime.t(locale, source, values);
  const pair = (fr, en, values, locale = language) => runtime.pair(locale, fr, en, values);
  let dictionaries = new WeakMap();
  function dictionary(fr, en, locale = language) {
    if (!en || typeof en !== 'object') return typeof en === 'string' ? pair(fr, en, undefined, locale) : en;
    const previous = dictionaries.get(en); if (previous?.locale === locale) return previous.value;
    const value = Array.isArray(en) ? en.map((item, index) => typeof item === 'string' ? pair(fr?.[index] ?? item, item, undefined, locale) : dictionary(fr?.[index], item, locale))
      : Object.fromEntries(Object.entries(en).map(([key, item]) => [key, typeof item === 'string' ? pair(fr?.[key] ?? item, item, undefined, locale) : item && typeof item === 'object' ? dictionary(fr?.[key], item, locale) : item]));
    dictionaries.set(en, { locale, value }); return value;
  }
  globalThis.addEventListener('chartshub:locale-ready', () => { dictionaries = new WeakMap(); });
  globalThis.ChartshubDesktopLocale = Object.freeze({ get: () => language, set, t, pair, dictionary, ready: () => pending, runtime, intl: () => runtime.definition(language)?.intl || 'en-US', direction: () => runtime.definition(language)?.dir || 'ltr' });
  set(language);
})();
