'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '../companion/ui/session-feed.js'), 'utf8'), token = 'ed'.repeat(32);
class Element { constructor() { this.children = []; this.textContent = ''; this.style = { setProperty() {} }; this.attributes = {}; } append(...nodes) { this.children.push(...nodes); } replaceChildren(...nodes) { this.children = nodes; } setAttribute(key, value) { this.attributes[key] = value; } set innerHTML(_) { throw Error('HTML interpretation forbidden'); } }
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
async function fixture(kind = 'chat', search = '?token=' + token) {
  const feed = new Element(), list = new Element(), calls = [], timers = new Map(), unload = []; let value = { enabled: true, language: 'fr', settings: { fontSize: 18, maxItems: 6, accent: '#49bbff', showViewerNames: false }, items: [{ id: '1', name: '<b>Viewer</b>', text: '<script>literal</script>', platform: 'twitch' }] }, id = 0;
  const document = { getElementById: name => name === 'feed' ? feed : list, createElement: () => new Element(), documentElement: {} };
  const scope = { document, URL, URLSearchParams, AbortController, location: { pathname: '/' + kind, search, protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1:12345' }, window: { addEventListener: (name, callback) => { if (name === 'unload') unload.push(callback); } }, fetch: async (url, options) => { calls.push({ url: String(url), options }); return { ok: true, json: async () => value }; }, setTimeout: (callback, ms) => { timers.set(++id, { callback, ms }); return id; }, clearTimeout: timer => timers.delete(timer) };
  vm.runInNewContext(code, scope); await settle();
  return { feed, list, document, calls, timers, set: next => { value = next; }, unload: () => unload.forEach(callback => callback()), poll: async () => { const next = [...timers].find(([, timer]) => timer.ms === 500); assert(next); timers.delete(next[0]); next[1].callback(); await settle(); } };
}
test('OBS polls only its own read-only tokenized feed, renders HTML-looking messages literally, and clears when sharing stops', async () => {
  const f = await fixture(); assert.equal(f.calls.length, 1); const request = f.calls[0]; assert.equal(new URL(request.url).origin, 'http://127.0.0.1:12345'); assert.equal(new URL(request.url).pathname, '/session-state'); assert.equal(new URL(request.url).searchParams.get('kind'), 'chat'); assert.equal(request.options.credentials, 'omit'); assert.equal(request.options.redirect, 'error');
  assert.equal(f.list.children[0].children[0].children[0].textContent, '<b>Viewer</b>'); assert.equal(f.list.children[0].children[1].textContent, '<script>literal</script>');
  f.set({ enabled: false }); await f.poll(); assert.equal(f.list.children.length, 0); f.unload(); assert.equal(f.timers.size, 0);
});
test('Activity labels translate and viewer names are absent unless the display projection permits them', async () => {
  const f = await fixture('activity'), value = { enabled: true, language: 'en', settings: { fontSize: 22, accent: '#abcdef', showViewerNames: false }, items: [{ id: '2', action: 'completed', title: 'Signal fictif', name: 'Private viewer' }] };
  f.set(value); await f.poll(); assert.equal(f.list.children[0].children.length, 2); assert.equal(f.list.children[0].children[0].textContent, 'Download completed'); assert.equal(f.document.documentElement.lang, 'en');
  value.settings.showViewerNames = true; await f.poll(); assert.equal(f.list.children[0].children[2].textContent, 'Private viewer'); f.unload();
});
test('Malformed display URLs never poll and repeated identical feeds retain row identity', async () => {
  for (const query of ['', '?token=wrong', '?token=' + token + '&token=' + token, '?token=' + token + '&source=device']) { const bad = await fixture('chat', query); assert.equal(bad.calls.length, 0); bad.unload(); }
  const f = await fixture(), rows = f.list.children; await f.poll(); assert.equal(f.list.children, rows); f.unload(); assert.equal(f.timers.size, 0);
});
