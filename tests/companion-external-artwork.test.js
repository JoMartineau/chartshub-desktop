'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createChartsHubClient } = require('../companion/catalogue-client.cjs');
const { createCatalogueService } = require('../companion/catalogue-service.cjs');
const { externalArtworkUrl } = require('../companion/catalogue-enchor-client.cjs');
const ORIGIN = 'https://chartshub.ca';
const first = 'a'.repeat(32), second = 'b'.repeat(32);
const cover = hash => `https://files.enchor.us/${hash}.jpg`;
const digest = value => createHash('sha256').update(value).digest('hex');
const image = Buffer.from([255, 216, 255, 224, 0, 0]);
const nativeCover = ORIGIN + '/api/charts/11111111-1111-4111-8111-111111111111/NativeArtwork00/cover';
const selected = query => ({ source: 'chorusencore', query, externalSearch: true });
function chart(hash, patch = {}) {
  return { source: 'chorusencore', id: 'enchor:' + hash, md5: hash, sourceUrl: 'https://enchor.us/chart/' + hash, externalChartId: hash === first ? 1 : 2,
    title: 'Synthetic cover test', artist: 'Synthetic artist', charter: 'Synthetic charter', instruments: ['Guitar'], instrumentDifficulties: { Guitar: ['Expert'] }, coverUrl: cover(hash), ...patch };
}
async function fixture(t, { rows, artworkResponse } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-artwork-'));
  const calls = [], native = { id: 'native-art', title: 'Native cover test', artist: 'Synthetic artist', coverUrl: nativeCover,
    viewUrl: ORIGIN + '/index.html?chart=native-art&share=2', downloadUrl: '/api/charts/11111111-1111-4111-8111-111111111111/NativeArtwork00/source' };
  const client = createChartsHubClient({ fetcher: async (url, options) => {
    calls.push({ url, options });
    if (url === ORIGIN + '/api/charts') return Response.json({ charts: [native], demo: false });
    if (url === ORIGIN + '/api/creators') return Response.json({ creators: [] });
    if (url === ORIGIN + '/api/external/enchor/status') return Response.json({ enabled: true, suspended: false, retryAfterSeconds: 0 });
    if (url === ORIGIN + '/api/external/enchor/search') {
      const request = JSON.parse(options.body), charts = rows ? rows(request.search) : [chart(request.search === 'second' ? second : first)];
      return Response.json({ source: 'chorusencore', charts, page: request.page, perPage: 25, found: charts.length, hasMore: false });
    }
    if (url === nativeCover || externalArtworkUrl(url)) return artworkResponse ? artworkResponse(url, options) : new Response(image, { headers: { 'content-type': 'image/jpeg' } });
    throw Error('Unexpected request in synthetic artwork fixture: ' + url);
  } });
  const service = createCatalogueService({ dataDirectory: directory, client, getLibrary: () => ({ rootKey: null, revision: 0, items: [] }) });
  t.after(async () => { await service.stop(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  return { service, client, calls };
}

test('external covers use the existing local artwork proxy and load only after an image request', async t => {
  const f = await fixture(t);
  assert.equal(await f.service.artwork(digest(cover(first))), null);
  const result = await f.service.search(selected('first'), { scope: 'widget' });
  assert.equal(result.items[0].artworkUrl, 'chartshub-companion://app/catalogue-artwork/' + digest(cover(first)));
  assert.equal(Object.hasOwn(result.items[0], 'coverUrl'), false);
  assert.doesNotMatch(JSON.stringify(result), /files\.enchor\.us/);
  assert.equal(f.calls.some(call => call.url === cover(first)), false, 'searching does not fetch image bytes');
  assert.deepEqual(await f.service.artwork(digest(cover(first))), { bytes: image, contentType: 'image/jpeg' });
  assert.deepEqual(await f.service.artwork(digest(cover(first))), { bytes: image, contentType: 'image/jpeg' });
  const requests = f.calls.filter(call => call.url === cover(first)); assert.equal(requests.length, 1, 'same bounded cache is reused');
  assert.equal(requests[0].options.credentials, 'omit'); assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.referrerPolicy, 'no-referrer'); assert.equal(requests[0].options.cache, 'no-store');
  assert.deepEqual(Object.keys(requests[0].options.headers), ['Accept']);
});

test('replacing and clearing searches revoke old cover hashes but preserve the other surface and native art', async t => {
  const f = await fixture(t);
  await f.service.search({ source: 'chartshub' });
  await f.service.search(selected('first'), { scope: 'widget' });
  await f.service.search(selected('first'), { scope: 'panel' });
  await f.service.artwork(digest(cover(first)));
  await f.service.search(selected('second'), { scope: 'widget' });
  assert.ok(await f.service.artwork(digest(cover(first))), 'panel still owns the first image');
  assert.ok(await f.service.artwork(digest(cover(second))));
  f.service.cancelSearch('panel', true);
  assert.equal(await f.service.artwork(digest(cover(first))), null);
  assert.ok(await f.service.artwork(digest(nativeCover)), 'native registry survives provider search changes');
  f.service.cancelSearch('widget', true);
  assert.equal(await f.service.artwork(digest(cover(second))), null);
  assert.ok(await f.service.artwork(digest(nativeCover)));
});

test('unseen, absent and unsafe external covers never become authorized image requests', async t => {
  const unsafe = ['', 'http://files.enchor.us/' + first + '.jpg', 'https://files.enchor.us.evil.invalid/' + first + '.jpg',
    'https://user@files.enchor.us/' + first + '.jpg', cover(first) + '?x=1', cover(first) + '#x', cover(first).replace('.jpg', '.svg'),
    'https://files.enchor.us/../' + first + '.jpg', 'https://files.enchor.us/%2e%2e/' + first + '.jpg', 'file:///private.jpg', 'data:image/png;base64,AAA'];
  for (const value of unsafe) {
    assert.equal(externalArtworkUrl(value), null);
    const f = await fixture(t, { rows: () => [chart(first, { coverUrl: value })] });
    const result = await f.service.search(selected('unsafe'), { scope: 'widget' });
    assert.equal(result.items[0].artworkUrl, null);
    assert.equal(await f.service.artwork(digest(value)), null);
    const count = f.calls.length; assert.equal(await f.client.artwork(value), null); assert.equal(f.calls.length, count);
  }
});

test('external cover bytes keep raster, redirect and maximum-size checks', async t => {
  const responses = [
    () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
    () => new Response('not a JPEG', { headers: { 'content-type': 'image/jpeg' } }),
    () => new Response(image, { headers: { 'content-type': 'image/jpeg', 'content-length': String(3 * 1024 * 1024 + 1) } }),
    () => { const response = new Response(image, { headers: { 'content-type': 'image/jpeg' } }); Object.defineProperty(response, 'redirected', { value: true }); return response; },
    () => { const response = new Response(image, { headers: { 'content-type': 'image/jpeg' } }); Object.defineProperty(response, 'url', { value: 'https://private.invalid/cover' }); return response; }
  ];
  for (const response of responses) {
    const f = await fixture(t, { artworkResponse: response }); await f.service.search(selected('first'), { scope: 'widget' });
    assert.equal(await f.service.artwork(digest(cover(first))), null);
  }
});

test('closing a provider search fences an image response already in flight', async t => {
  let resolveImage, requested;
  const pending = new Promise(resolve => { requested = resolve; });
  const f = await fixture(t, { artworkResponse: () => { requested(); return new Promise(resolve => { resolveImage = resolve; }); } });
  await f.service.search(selected('first'), { scope: 'widget' });
  const job = f.service.artwork(digest(cover(first))); await pending;
  f.service.cancelSearch('widget', true);
  resolveImage(new Response(image, { headers: { 'content-type': 'image/jpeg' } }));
  assert.equal(await job, null); assert.equal(await f.service.artwork(digest(cover(first))), null);
});

test('closing a search cancels active cover reads and drops queued covers before transport starts', async t => {
  const hashes = ['a', 'b', 'c', 'd', 'e'].map(value => value.repeat(32)), started = [], aborted = [];
  const f = await fixture(t, { rows: () => hashes.map(hash => chart(hash)), artworkResponse: (url, options) => {
    started.push(url);
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { aborted.push(url); reject(Object.assign(Error('synthetic cancelled cover'), { name: 'AbortError' })); }, { once: true }));
  } });
  await f.service.search(selected('many covers'), { scope: 'widget' });
  const jobs = hashes.map(hash => f.service.artwork(digest(cover(hash))));
  for (let i = 0; i < 50 && started.length < 4; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 4); f.service.cancelSearch('widget', true);
  assert.deepEqual(await Promise.all(jobs), Array(5).fill(null));
  assert.equal(started.length, 4, 'the queued fifth cover was never fetched'); assert.equal(aborted.length, 4);
});
