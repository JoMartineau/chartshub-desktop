'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../companion/ui/song-requests-overlay.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../companion/ui/song-requests.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../companion/ui/song-requests-overlay.css'), 'utf8');
const TOKEN = 'a'.repeat(64);
const tick = () => new Promise(resolve => setImmediate(resolve));
const song = (id, changes = {}) => ({ id, title: 'Song ' + id, artist: 'Fixture artist', viewerName: 'Fixture viewer', platform: 'twitch', votes: 2, status: 'pending', ...changes });

function fixture(t, { state = { enabled: true, language: 'fr', requests: [] }, fetcher, token = TOKEN } = {}) {
  const document = { documentElement: { lang: 'fr' }, writes: 0 };
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.parent = null; this.text = ''; this.className = ''; this.dataset = {}; this.hidden = false; this.events = new Map(); }
    set textContent(value) { document.writes++; this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(_) { throw Error('Overlay text cannot become HTML'); }
    append(...children) { for (const child of children) { child.remove(); child.parent = this; this.children.push(child); } document.writes++; }
    remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; document.writes++; } }
    insertBefore(child, before) { child.remove(); const index = before ? this.children.indexOf(before) : this.children.length; this.children.splice(index, 0, child); child.parent = this; document.writes++; }
    replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this.append(...children); }
    addEventListener(name, callback) { this.events.set(name, callback); }
    get classList() { return { remove: value => { this.className = this.className.split(' ').filter(name => name !== value).join(' '); } }; }
  }
  document.createElement = tag => new Element(tag);
  const root = new Element('main'), elements = new Map();
  for (const [, tag, id] of html.matchAll(/<(\w+)\b[^>]*\bid="(request-[^"]+)"/g)) {
    const node = new Element(tag); elements.set(id, node); root.append(node);
  }
  document.querySelector = selector => elements.get(selector.slice(1)) ?? null;
  let current = state, sequence = 0;
  const timers = new Map(), events = new Map(), requests = [];
  const context = vm.createContext({ document, location: { search: '?token=' + token }, URLSearchParams, AbortController, Uint8Array, TextDecoder,
    fetch: (url, options) => { requests.push({ url, options }); return fetcher ? fetcher(url, options) : Promise.resolve(new Response(JSON.stringify(current))); },
    setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id),
    addEventListener: (name, callback) => events.set(name, callback) });
  vm.runInContext(source, context, { filename: 'song-requests-overlay.js' });
  const poll = async next => {
    if (next !== undefined) current = next;
    await tick();
    const scheduled = [...timers].find(([, value]) => value.delay === 1000);
    assert.ok(scheduled, 'a completed poll schedules exactly one next poll');
    timers.delete(scheduled[0]); scheduled[1].callback(); await tick();
  };
  const close = () => events.get('pagehide')();
  t.after(close);
  return { document, root, elements, requests, timers, poll, close,
    get: name => elements.get('request-' + name),
    rows: () => elements.get('request-queue').children,
    timeout: () => { const scheduled = [...timers].find(([, value]) => value.delay === 4000); assert.ok(scheduled); timers.delete(scheduled[0]); scheduled[1].callback(); } };
}

test('OBS shows the first five active requests in exact queue order, a featured next song, waiting total and remaining count', async t => {
  const requests = [song('one', { title: 'One', artist: 'Metallica', viewerName: 'Jo', votes: 8, status: 'accepted' }),
    ...Array.from({ length: 7 }, (_, index) => song('following-' + index, { platform: index % 2 ? 'tiktok' : 'youtube' }))];
  const ui = fixture(t, { state: { enabled: true, language: 'fr', requests: [...requests, song('done', { status: 'played' })], token: 'never-render-private-field' } });
  await tick();
  assert.equal(ui.rows().length, 5); assert.equal(ui.get('count').textContent, '8');
  assert.match(ui.rows()[0].textContent, /À jouer ensuiteOneMetallicaTwitchDemandé parJo8 votes/);
  assert.match(ui.rows()[0].className, /is-next/); assert.doesNotMatch(ui.rows()[1].className, /is-next/);
  assert.equal(ui.rows()[0].children[1].children[0].hidden, false);
  assert.equal(ui.rows()[1].children[1].children[0].hidden, true);
  assert.equal(ui.rows()[1].children[1].children[1].textContent, 'Song following-0');
  assert.match(ui.get('remaining').textContent, /3 autres demandes/);
  assert.equal(ui.get('command').textContent, '!sr artiste titre');
  assert.doesNotMatch(ui.root.textContent, /En cours|Now playing|never-render-private-field|aaaaaaaaaaaaaaaa/);
  assert.ok(ui.rows().every(row => !row.className.includes('is-new')), 'opening OBS does not animate the entire queue');
});

test('unchanged polls do not rerender; only new IDs animate and votes, language changes or reorders do not animate existing songs', async t => {
  const first = song('first'), second = song('second');
  const ui = fixture(t, { state: { enabled: true, language: 'fr', requests: [first, second] } }); await tick();
  const initialRows = [...ui.rows()], writes = ui.document.writes;
  await ui.poll(); assert.equal(ui.document.writes, writes); assert.equal(ui.rows()[0], initialRows[0]);
  await ui.poll({ enabled: true, language: 'fr', requests: [first, song('new'), second] });
  assert.match(ui.rows()[1].className, /is-new/); assert.equal(ui.rows()[0], initialRows[0]); assert.equal(ui.rows()[2], initialRows[1]);
  await ui.poll({ enabled: true, language: 'en', requests: [{ ...second, votes: 3 }, first, song('new')] });
  assert.equal(ui.rows()[0], initialRows[1]); assert.ok(ui.rows().every(row => !row.className.includes('is-new')));
  assert.match(ui.rows()[0].textContent, /Up next/); assert.equal(ui.get('heading').textContent, 'Upcoming requests');
  assert.equal(ui.get('command').textContent, '!sr artist title'); assert.equal(ui.document.documentElement.lang, 'en');
  assert.match(css, /prefers-reduced-motion:\s*reduce/); assert.match(css, /animation:\s*none/);
});

test('empty and closed queues invite viewers honestly in both languages and all remote text stays plain text', async t => {
  const ui = fixture(t); await tick();
  assert.equal(ui.get('empty').hidden, false); assert.match(ui.get('empty-help').textContent, /dans le chat/);
  await ui.poll({ enabled: false, language: 'en', requests: [] });
  assert.equal(ui.get('status').textContent, 'Requests closed'); assert.equal(ui.get('empty-title').textContent, 'Requests will return soon');
  await ui.poll({ enabled: true, language: 'en', requests: [song('plain', { title: '<script>unsafe()</script>', viewerName: '<img src=x>', artist: 'bad\nname\u202e', votes: Infinity, platform: 'private-provider' })] });
  assert.match(ui.rows()[0].textContent, /<script>unsafe\(\)<\/script>/); assert.match(ui.rows()[0].textContent, /<img src=x>/);
  assert.doesNotMatch(ui.rows()[0].textContent, /private-provider|\u202e|\n/);
  assert.equal(ui.rows()[0].children[2].textContent, '0 votes');
  assert.equal(ui.get('empty').hidden, true); assert.equal(ui.get('remaining').hidden, true);
  assert.doesNotMatch(html + css, /<img\b|<iframe\b|https?:\/\/|url\(/i);
});

test('only the private readonly local state endpoint is polled, without cookies, redirects, overlapping polls or rendered token', async t => {
  const ui = fixture(t); await tick();
  assert.equal(ui.requests.length, 1); assert.equal(ui.requests[0].url, '/state?token=' + TOKEN);
  assert.equal(ui.requests[0].options.credentials, 'omit'); assert.equal(ui.requests[0].options.redirect, 'error'); assert.equal(ui.requests[0].options.cache, 'no-store');
  assert.equal(ui.requests[0].options.method, undefined); assert.doesNotMatch(ui.root.textContent, new RegExp(TOKEN));
  assert.equal([...ui.timers.values()].filter(timer => timer.delay === 1000).length, 1);
  const invalid = fixture(t, { token: 'not-a-read-capability' }); await tick();
  assert.equal(invalid.requests.length, 0); assert.equal(invalid.timers.size, 0); assert.equal(invalid.get('status').textContent, 'Connexion indisponible');
});

test('oversized state responses and invalid queues clear stale rows without exposing response text', async t => {
  let oversized = false;
  const ui = fixture(t, { fetcher: async () => new Response(oversized ? JSON.stringify({ private: 'SECRET'.repeat(100000) }) : JSON.stringify({ enabled: true, requests: [song('first')] })) });
  await tick(); assert.equal(ui.rows().length, 1);
  oversized = true; await ui.poll(); assert.equal(ui.rows().length, 0); assert.equal(ui.get('count').textContent, '—');
  assert.equal(ui.get('status').textContent, 'Connexion indisponible'); assert.doesNotMatch(ui.root.textContent, /SECRET/);
  const malformed = fixture(t, { state: { enabled: true, requests: Array.from({ length: 51 }, (_, index) => song('row-' + index)) } }); await tick();
  assert.equal(malformed.rows().length, 0); assert.equal(malformed.get('status').dataset.state, 'unavailable');
});

test('the four second deadline aborts a request and pagehide aborts in-flight work without late rendering or polling', async t => {
  const timed = fixture(t, { fetcher: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('Private provider timeout')))) });
  assert.equal(timed.requests.length, 1); assert.equal([...timed.timers.values()].filter(timer => timer.delay === 1000).length, 0);
  timed.timeout(); await tick(); assert.equal(timed.requests[0].options.signal.aborted, true);
  assert.equal(timed.get('status').textContent, 'Connexion indisponible'); assert.doesNotMatch(timed.root.textContent, /Private provider/);
  let finish;
  const closed = fixture(t, { fetcher: () => new Promise(resolve => { finish = resolve; }) });
  const writes = closed.document.writes; closed.close(); assert.equal(closed.requests[0].options.signal.aborted, true);
  finish(new Response(JSON.stringify({ enabled: true, requests: [song('late')] }))); await tick();
  assert.equal(closed.document.writes, writes); assert.equal(closed.rows().length, 0); assert.equal(closed.timers.size, 0);
});
