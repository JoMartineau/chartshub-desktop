'use strict';
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const runtime = require('../assets/locale-runtime.js');
const MAX_PACK_BYTES = 1024 * 1024;
const unavailable = new Set();
function readPack(value) {
  const locale = runtime.canonicalize(value); if (!locale || locale === 'en') return null;
  const filename = path.join(__dirname, '..', 'assets', `locale.${locale}.json`);
  try {
    const info = fs.lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PACK_BYTES) return null;
    const bytes = fs.readFileSync(filename);
    if (bytes.length > MAX_PACK_BYTES) return null;
    const pack = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return pack?.version === 1 && pack.locale === locale && pack.catalogueSha256 === runtime.catalogueSha256 ? pack : null;
  } catch { return null; }
}
function loadLanguage(value) {
  const locale = runtime.canonicalize(value);
  if (!locale) return null;
  if (runtime.hasPack(locale) || unavailable.has(locale)) return locale;
  try {
    const pack = readPack(locale);
    if (pack) runtime.installPack(pack); else unavailable.add(locale);
  } catch { unavailable.add(locale); }
  return locale;
}
function pair(language, french, english, values) {
  const locale = loadLanguage(language) || 'en';
  return runtime.pair(locale, french, english, values);
}
function translate(language, english, values) { const locale = loadLanguage(language) || 'en'; return runtime.t(locale, english, values); }
function createLanguagePreferences({ filename, preferredLanguages = () => ['en'], io = fs.promises } = {}) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw TypeError('Absolute language preference path required');
  let locale = runtime.negotiate(preferredLanguages()), tail = Promise.resolve(), revision = 0, savedLocale = null;
  async function load() {
    const ticket = revision;
    try {
      const info = await io.lstat(filename);
      if (info.isFile() && !info.isSymbolicLink() && info.size <= 1024) {
        const value = JSON.parse(await io.readFile(filename, 'utf8'));
        const next = value && Object.keys(value).length === 2 && value.version === 1 ? runtime.canonicalize(value.locale) : null;
        if (next && ticket === revision) locale = savedLocale = next;
      }
    } catch { /* Missing or invalid preferences fall back to the operating system. */ }
    loadLanguage(locale); return locale;
  }
  function set(value) {
    const next = runtime.canonicalize(value); if (!next) return Promise.resolve(false);
    revision++; locale = next; loadLanguage(next);
    const saved = JSON.stringify({ version: 1, locale: next }) + '\n';
    tail = tail.catch(() => {}).then(async () => {
      if (savedLocale === next) return;
      await io.mkdir(path.dirname(filename), { recursive: true });
      const temporary = filename + '.' + randomUUID() + '.tmp';
      await io.writeFile(temporary, saved, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      try { await io.rename(temporary, filename); savedLocale = next; }
      finally { await io.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    });
    return tail.then(() => true, () => false);
  }
  return { load, set, hasSaved: () => savedLocale !== null, flush: () => tail.catch(() => {}) };
}
module.exports = { runtime, loadLanguage, readPack, pair, translate, createLanguagePreferences };
