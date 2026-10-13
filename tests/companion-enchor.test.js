'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { createChartsHubClient } = require('../companion/catalogue-client.cjs');
const { createCatalogueService } = require('../companion/catalogue-service.cjs');
const { createExternalCatalogue } = require('../companion/catalogue-external.cjs');
const { validCommand, trustedCatalogueWidgetCommand } = require('../companion/security.cjs');
const md5 = index => index.toString(16).padStart(32, '0');
function external(index = 1, patch = {}) { return { id: 'enchor:' + md5(index), md5: md5(index), externalChartId: index, title: 'Metallica song ' + index, artist: 'Metallica', charter: 'Charter', source: 'chorusencore', sourceUrl: 'https://enchor.us/chart/' + md5(index), coverUrl: 'https://files.enchor.us/' + md5(index) + '.jpg', instruments: ['Guitar'], instrumentDifficulties: { Guitar: ['Expert'] }, ...patch }; }
const result = (charts, page = 1, found = charts.length, hasMore = false) => ({ source: 'chorusencore', page, perPage: 25, found, hasMore, charts });
const json = (value, options = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...options });
const selected = patch => ({ query: 'Metallica', artist: '', charter: '', genre: '', year: '', instrument: '', difficulty: '', verified: 'all', installed: 'all', favorites: 'all', page: 1, source: 'all', externalSearch: true, ...patch });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-companion-enchor-')), calls = [];
  const native = (options.native || []).map((row, index) => ({ id: 'native:' + index, title: 'Metallica song', artist: 'Metallica', charter: 'Charter', verified: true, instruments: ['Guitar'], difficulties: ['Expert'], instrumentDifficulties: { Guitar: ['Expert'] }, viewUrl: `https://chartshub.ca/index.html?chart=native%3A${index}&share=2`, ...row }));
  const client = { load: async () => ({ items: native, demo: false }), enchorStatus: async () => ({ enabled: true, suspended: false, retryAfterSeconds: 0 }), enchorSearch: async request => { calls.push(request); return options.search ? options.search(request) : result([external()]); }, ...options.client };
  const service = createCatalogueService({ dataDirectory: directory, client, getLibrary: () => ({ rootKey: null, revision: 0, items: [] }) });
  t.after(async () => { await service.stop(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  return { service, calls, client, directory };
}

test('provider traffic requires explicit search; all mode returns native matches before attributed external records', async t => {
  const f = await fixture(t, { native: [{}] }); await f.service.start();
  const initial = await f.service.search(selected({ externalSearch: false })); assert.equal(initial.items.length, 1); assert.equal(f.calls.length, 0);
  const page = await f.service.search(selected()); assert.deepEqual(page.items.map(item => item.source), ['chartshub', 'chorusencore']); assert.equal(page.pageSize, 20);
  const chart = page.items[1]; for (const key of ['favorite', 'verified', 'staffRole', 'installed', 'creatorId', 'contentHash', 'downloadEndpoint', 'previewUrl']) assert.equal(Object.hasOwn(chart, key), false, key);
  assert.equal(chart.artworkUrl, null); assert.equal(await f.service.openUrl(chart.id), external().sourceUrl); assert.equal(f.service.downloadDescriptor(chart.id).endpoint, chart.id);
  await assert.rejects(f.service.favorite({ chartId: chart.id, favorite: true }));
  const cached = await f.service.search(selected({ externalSearch: false })); assert.equal(cached.items[1].id, chart.id); assert.equal(f.calls.length, 1);
  await f.service.search(selected({ query: 'Other', externalSearch: false })); await assert.rejects(f.service.openUrl(chart.id)); assert.throws(() => f.service.downloadDescriptor(chart.id));
});

test('global pages remain bounded, exhaust native rows first and fetch only one next provider page when needed', async t => {
  const f = await fixture(t, { native: Array.from({ length: 24 }, () => ({})), search: ({ body }) => body.page === 1 ? result(Array.from({ length: 25 }, (_, index) => external(index + 1)), 1, 60, true) : result([external(25), ...Array.from({ length: 25 }, (_, index) => external(index + 26))], 2, 60, true) });
  const first = await f.service.search(selected()); assert.equal(first.items.length, 20); assert.ok(first.items.every(item => item.source === 'chartshub')); assert.equal(f.calls.length, 1);
  const second = await f.service.search(selected({ page: 2 })); assert.equal(second.items.length, 20); assert.ok(second.items.slice(0, 4).every(item => item.source === 'chartshub')); assert.equal(f.calls.length, 1);
  const third = await f.service.search(selected({ page: 3 })); assert.equal(third.items.length, 20); assert.equal(f.calls.length, 2); assert.deepEqual(f.calls.map(call => call.body.page), [1, 2]);
  assert.equal(new Set([...second.items, ...third.items].filter(item => item.source === 'chorusencore').map(item => item.id)).size, 36, 'overlapping upstream pages do not duplicate displayed IDs');
  const previous = await f.service.search(selected({ page: 2 })); assert.deepEqual(previous.items.map(item => item.id), second.items.map(item => item.id)); assert.equal(f.calls.length, 2);
});

test('sparse local filters and zero-match intermediate pages never skip later matching rows', async t => {
  const f = await fixture(t, { search: ({ body }) => result(Array.from({ length: 25 }, (_, index) => external((body.page - 1) * 25 + index + 1, { artist: body.page !== 2 && index < 5 ? 'Metallica' : 'Other' })), body.page, 200, body.page < 8) });
  const pages = [], ids = [];
  for (let page = 1; page <= 8; page++) {
    const before = f.calls.length, response = await f.service.search(selected({ source: 'chorusencore', artist: 'Metallica', page })); assert.equal(response.page, page); assert.ok(response.items.length <= 20); assert.equal(f.calls.length, before + 1); pages.push(response); ids.push(...response.items.map(item => item.id));
    if (page < 8) assert.equal(response.hasMore, true, 'an empty upstream page is not a definitive empty search'); else assert.equal(response.hasMore, false);
  }
  assert.equal(pages[1].items.length, 0); assert.equal(ids.length, 35); assert.equal(new Set(ids).size, 35);
  for (let page = 8; page >= 1; page--) { const response = await f.service.search(selected({ source: 'chorusencore', artist: 'Metallica', page })); assert.deepEqual(response.items.map(item => item.id), pages[page - 1].items.map(item => item.id)); }
  assert.equal(f.calls.length, 8, 'revisiting an already displayed sparse page uses its frozen window');
});

test('113 native matches precede partial external pages without losing external rows at their boundary', async t => {
  const f = await fixture(t, { native: Array.from({ length: 113 }, () => ({})), search: ({ body }) => result(Array.from({ length: 25 }, (_, index) => external((body.page - 1) * 25 + index + 1, { artist: index < 5 ? 'Metallica' : 'Other' })), body.page, 75, body.page < 3) });
  const ids = [], nativeIds = []; let page = 1, response;
  do {
    response = await f.service.search(selected({ artist: 'Metallica', page })); assert.equal(response.page, page); assert.ok(response.items.length <= 20);
    ids.push(...response.items.filter(item => item.source === 'chorusencore').map(item => item.id)); nativeIds.push(...response.items.filter(item => item.source === 'chartshub').map(item => item.id));
    if (page <= 5) assert.equal(f.calls.length, 1, 'native-only pages do not advance the provider'); page++;
  } while (response.hasMore && page < 20);
  assert.equal(new Set(nativeIds).size, 113); assert.equal(nativeIds.length, 113); assert.equal(ids.length, 15); assert.equal(new Set(ids).size, 15); assert.equal(f.calls.length, 3);
});

test('a failed sparse Next does not freeze an empty page or suppress its later explicit retry', async () => {
  let stamp = 0, calls = 0;
  const catalogue = createExternalCatalogue({ now: () => stamp, client: { enchorStatus: async () => ({ enabled: true, suspended: false, retryAfterSeconds: 0 }), enchorSearch: async ({ body }) => { calls++; if (calls === 2) throw Object.assign(Error('limited'), { code: 'ENCHOR_RATE_LIMITED', retryAfterSeconds: 10 }); return result(Array.from({ length: 25 }, (_, index) => external((body.page - 1) * 25 + index + 1, { artist: index < 5 ? 'Metallica' : 'Other' })), body.page, 50, body.page < 2); } } });
  await catalogue.search(selected({ source: 'chorusencore', artist: 'Metallica' }), 0);
  const failed = await catalogue.search(selected({ source: 'chorusencore', artist: 'Metallica', page: 2 }), 0); assert.equal(failed.external.status, 'cooldown'); assert.equal(failed.limit, 0); assert.equal(calls, 2);
  await catalogue.search(selected({ source: 'chorusencore', artist: 'Metallica', page: 2 }), 0); assert.equal(calls, 2);
  stamp = 11000; const retried = await catalogue.search(selected({ source: 'chorusencore', artist: 'Metallica', page: 2 }), 0); assert.equal(calls, 3); assert.equal(retried.external.page, 2); assert.equal(retried.offset, 5); assert.equal(retried.limit, 5); catalogue.stop();
});

test('a definitive fully filtered search reports zero instead of the unfiltered provider count', async t => {
  const f = await fixture(t, { search: ({ body }) => result([external(1, { artist: 'Other' })], body.page, 10, false) });
  const page = await f.service.search(selected({ source: 'chorusencore', artist: 'Metallica' })); assert.equal(page.items.length, 0); assert.equal(page.total, 0); assert.equal(page.externalTotal, 0); assert.equal(page.hasMore, false);
});

test('native-only filters exclude external records; supported queryless filters use advanced search and mixed fields are disclosed', async t => {
  const f = await fixture(t, { native: [{}] });
  for (const filters of [{ verified: 'yes' }, { favorites: 'yes' }, { installed: 'linked' }, { instrument: 'Vocals' }]) {
    const page = await f.service.search(selected(filters)); assert.equal(page.externalTotal, 0); assert.ok(page.external.unsupported.length); assert.ok(page.items.every(item => item.source === 'chartshub'));
  }
  assert.equal(f.calls.length, 0);
  await f.service.search(selected({ query: '', artist: 'Metallica', instrument: 'Guitar', difficulty: 'Expert' })); const request = f.calls[0]; assert.equal(request.endpoint, '/api/external/enchor/advanced'); assert.deepEqual(request.body.artist, { value: 'Metallica', exact: false, exclude: false }); assert.equal(request.body.instrument, 'guitar');
  const mixed = await f.service.search(selected({ artist: 'Wrong artist' })); assert.deepEqual(mixed.external.localFilters, ['artist']); assert.equal(mixed.items.length, 0);
  const empty = await f.service.search(selected({ query: '', source: 'chorusencore' })); assert.equal(empty.external.status, 'idle'); assert.match(empty.external.error, /titre.*artiste.*charter/); assert.equal(f.calls.length, 2);
});

test('changed criteria and stop fence abort-ignoring responses; the next explicit request runs once', async t => {
  const pending = deferred(); let firstSignal;
  const f = await fixture(t, { search: request => { if (request.body.search === 'Metallica') { firstSignal = request.signal; return pending.promise; } return result([external(2)]); } });
  const old = f.service.search(selected()); const rejected = assert.rejects(old, { name: 'AbortError' });
  while (!firstSignal) await new Promise(resolve => setImmediate(resolve));
  const changed = await f.service.search(selected({ query: 'Megadeth', externalSearch: false })); assert.equal(firstSignal.aborted, true); assert.equal(changed.items.length, 0); await rejected;
  const next = await f.service.search(selected({ query: 'Megadeth' })); assert.equal(next.items[0].id, external(2).id); assert.equal(f.calls.length, 2);
  pending.resolve(result([external()])); await new Promise(resolve => setImmediate(resolve)); assert.throws(() => f.service.downloadDescriptor(external().id));
  await f.service.stop(); await assert.rejects(f.service.openUrl(external(2).id));
});

test('provider failures preserve native matching results and native failures still allow an explicit external search', async t => {
  const f = await fixture(t, { native: [{}], search: () => { throw Object.assign(Error('private provider diagnostics'), { code: 'ENCHOR_UNAVAILABLE' }); } });
  const page = await f.service.search(selected()); assert.equal(page.items.length, 1); assert.equal(page.items[0].source, 'chartshub'); assert.equal(page.external.status, 'error'); assert.doesNotMatch(page.external.error, /private/);
  const externalOnly = await fixture(t, { client: { load: async () => { throw Error('native unavailable'); } } });
  const fallback = await externalOnly.service.search(selected()); assert.equal(fallback.items[0].source, 'chorusencore'); assert.equal(externalOnly.service.status().status, 'error');
});

test('trusted surfaces keep independent results while transports serialize and shutdown cancels pending searches', async t => {
  const pending = deferred(); let signal, secondStarted = false;
  const f = await fixture(t, { search: request => { if (request.body.search === 'Metallica') { signal = request.signal; return pending.promise; } secondStarted = true; return result([external(2)]); } });
  const first = f.service.search(selected(), { scope: 'panel' }), cancelled = assert.rejects(first, { name: 'AbortError' });
  while (!signal) await new Promise(resolve => setImmediate(resolve));
  const second = f.service.search(selected({ query: 'Megadeth' }), { scope: 'widget' }), stopped = assert.rejects(second, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(secondStarted, false, 'another surface cannot overlap the active provider transport');
  await f.service.stop(); await cancelled; await stopped; assert.equal(signal.aborted, true); pending.resolve(result([external()]));
  await f.service.start(); const clean = await f.service.search(selected({ query: 'Megadeth', externalSearch: false })); assert.equal(clean.externalTotal, 0); assert.equal(secondStarted, false);
});

test('closing a widget while the native snapshot loads prevents its later provider request', async t => {
  const pending = deferred(), f = await fixture(t, { client: { load: () => pending.promise } });
  const search = f.service.search(selected(), { scope: 'widget' }), rejected = assert.rejects(search, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve)); f.service.cancelSearch('widget'); pending.resolve({ items: [], demo: false }); await rejected; assert.equal(f.calls.length, 0);
});

test('a concurrent local rerender with the same criteria shares native loading without cancelling the explicit provider search', async t => {
  const pending = deferred(), f = await fixture(t, { client: { load: () => pending.promise } });
  const explicit = f.service.search(selected()), local = f.service.search(selected({ externalSearch: false }));
  await new Promise(resolve => setImmediate(resolve)); pending.resolve({ items: [], demo: false });
  const [searched, cached] = await Promise.all([explicit, local]); assert.equal(searched.items[0].source, 'chorusencore'); assert.equal(cached.page, 1); assert.equal(f.calls.length, 1);
});

test('disabled, suspended and Retry-After prevent provider searches and have no automatic retry', async () => {
  for (const availability of [{ enabled: false, suspended: false, retryAfterSeconds: 0 }, { enabled: true, suspended: true, retryAfterSeconds: 0 }]) {
    let searches = 0; const catalogue = createExternalCatalogue({ client: { enchorStatus: async () => availability, enchorSearch: async () => { searches++; } } });
    const page = await catalogue.search(selected(), 0); assert.equal(searches, 0); assert.equal(page.external.status, availability.enabled ? 'suspended' : 'disabled'); catalogue.stop();
  }
  let stamp = 0, reads = 0, searches = 0;
  const catalogue = createExternalCatalogue({ now: () => stamp, client: { enchorStatus: async () => { reads++; return { enabled: true, suspended: false, retryAfterSeconds: 0 }; }, enchorSearch: async () => { searches++; throw Object.assign(Error('private'), { code: 'ENCHOR_RATE_LIMITED', retryAfterSeconds: 60 }); } } });
  const first = await catalogue.search(selected(), 0); assert.equal(first.external.retryAfterSeconds, 60); assert.equal(first.external.status, 'cooldown'); assert.doesNotMatch(first.external.error, /private/);
  await catalogue.search(selected({ query: 'Other' }), 0); assert.equal(searches, 1); assert.equal(reads, 1);
  stamp = 61000; await catalogue.search(selected({ query: 'Other', externalSearch: false }), 0); assert.equal(searches, 1); await catalogue.search(selected({ query: 'Other' }), 0); assert.equal(searches, 2); catalogue.stop();
});

test('proxy transport is fixed, credential-free and normalized; malformed identity/URL/redirects fail closed', async () => {
  const calls = [], client = createChartsHubClient({ fetcher: async (url, options) => { calls.push({ url, options }); return url.endsWith('/status') ? json({ enabled: true, suspended: false, retryAfterSeconds: 0 }) : json(result([external(1, { verified: true, favorite: true, owner: 'forged', charterSegments: [{ text: 'Char', color: 'red' }, { text: 't', color: '#abc' }, { text: 'e', color: '#abcd' }, { text: 'r', color: 'url(https://evil.example)' }] })])); } });
  await client.enchorStatus(); const page = await client.enchorSearch({ endpoint: '/api/external/enchor/search', body: { page: 1, search: 'Metallica' } }); assert.equal(page.charts[0].verified, undefined);
  assert.deepEqual(page.charts[0].charterSegments, [{ text: 'Char', color: 'red' }, { text: 't', color: '#abc' }, { text: 'e', color: '#abcd' }, { text: 'r' }]);
  for (const call of calls) { assert.ok(call.url.startsWith('https://chartshub.ca/api/external/enchor/')); assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.redirect, 'error'); assert.equal(call.options.cache, 'no-store'); assert.equal(call.options.headers.Authorization, undefined); }
  assert.equal(calls[1].options.headers.Origin, 'https://chartshub.ca'); assert.deepEqual(JSON.parse(calls[1].options.body), { page: 1, search: 'Metallica' });
  for (const patch of [{ id: 'native:1' }, { md5: md5(2) }, { sourceUrl: 'https://evil.example/' }, { externalChartId: 0 }]) {
    const bad = createChartsHubClient({ fetcher: async () => json(result([external(1, patch)])) }); await assert.rejects(bad.enchorSearch({ endpoint: '/api/external/enchor/search', body: { page: 1, search: 'Metallica' } }), { code: 'ENCHOR_INVALID_RESPONSE' });
  }
  await assert.rejects(client.enchorSearch({ endpoint: 'https://api.enchor.us/search', body: { page: 1 } }), { code: 'ENCHOR_INVALID_QUERY' });
});

test('proxy Retry-After survives HTML errors and status deadlines/cancellation bound stalled transports', async () => {
  const limited = createChartsHubClient({ fetcher: async () => new Response('private html', { status: 429, headers: { 'content-type': 'text/html', 'retry-after': '90' } }) });
  await assert.rejects(limited.enchorStatus(), error => error.code === 'ENCHOR_RATE_LIMITED' && error.retryAfterSeconds === 90 && !error.message.includes('private'));
  const late = deferred(), timeout = createChartsHubClient({ timeoutMs: 20, fetcher: () => late.promise }); await assert.rejects(timeout.enchorStatus(), { code: 'ENCHOR_TIMEOUT' }); late.resolve(json({ enabled: true, suspended: false, retryAfterSeconds: 0 }));
  const controller = new AbortController(), client = createChartsHubClient({ fetcher: () => new Promise(() => {}) }), request = client.enchorStatus({ signal: controller.signal }); controller.abort(); await assert.rejects(request, { name: 'AbortError' });
});

test('IPC validates source and explicit-search values while continuing to reject provider URLs and external ownership mutations', () => {
  assert.equal(validCommand('catalogue.search', selected()), true);
  for (const patch of [{ source: 'api.enchor.us' }, { externalSearch: 1 }, { endpoint: '/api/external/enchor/search' }, { query: 'secret\n' }]) assert.equal(validCommand('catalogue.search', selected(patch)), false);
  assert.equal(validCommand('downloads.enqueue', { chartId: external().id }), true); assert.equal(validCommand('downloads.enqueue', { chartId: external().id, md5: md5(2) }), false);
  const contents = { mainFrame: { url: 'chartshub-companion://app/ui/catalogue-widget.html' } }, window = { webContents: contents, isDestroyed: () => false }, event = { sender: contents, senderFrame: contents.mainFrame };
  assert.equal(trustedCatalogueWidgetCommand(event, window, 'catalogue.open', { chartId: external().id }), true);
  assert.equal(trustedCatalogueWidgetCommand(event, window, 'catalogue.open', { chartId: 'native:1' }), false);
  assert.equal(trustedCatalogueWidgetCommand({ ...event, senderFrame: { ...contents.mainFrame } }, window, 'catalogue.open', { chartId: external().id }), false);
});
