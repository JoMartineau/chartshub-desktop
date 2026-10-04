const test = require('node:test');
const assert = require('node:assert/strict');
const { createChartsHubClient } = require('../companion/catalogue-client.cjs');

const ORIGIN = 'https://chartshub.ca';
const folder = '12345678-1234-1234-1234-123456789012';
const creator = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const cover = `/api/charts/${folder}/SongFolderabcdefghij/cover`;
const json = (value, options = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...options });
function chart(patch = {}) {
  // Shape from server/drive.js chartFromMetadata and server/index.js publicChart.
  return {
    id: 'drive:DriveRoot1234567890:SongFolderabcdefghij', title: 'A song', artist: 'An artist', charter: 'A charter',
    creatorId: creator, sourceFolderId: 'DriveRoot1234567890', sourceFileId: 'SongFolderabcdefghij',
    album: 'Album', year: 2004, genre: 'Rock', instruments: ['Guitar', 'Drums'],
    instrumentDifficulties: { Guitar: ['Hard', 'Expert'], Drums: ['Medium'] }, difficulty: 'Expert',
    coverUrl: cover, downloadUrl: `/api/charts/${folder}/SongFolderabcdefghij/source`, contentHash: 'a'.repeat(64), ...patch
  };
}
function fixture({ charts = [chart()], creators = [{ id: creator, verifiedCharter: true }], demo = false, chartsResponse, creatorsResponse, timeoutMs } = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url === ORIGIN + '/api/charts') return chartsResponse ? chartsResponse(options) : json({ charts, demo });
    if (url === ORIGIN + '/api/creators') return creatorsResponse ? creatorsResponse(options) : json({ creators });
    throw Error('Unexpected request ' + url);
  };
  return { calls, client: createChartsHubClient({ fetcher, ...(timeoutMs ? { timeoutMs } : {}) }) };
}

test('ChartsHub client reads two public full snapshots and joins verified creators by ID', async () => {
  const { client, calls } = fixture(); const result = await client.load({ revision: 'previous' });
  assert.deepEqual(result, {
    items: [{ id: chart().id, title: 'A song', artist: 'An artist', charter: 'A charter', verified: true, album: 'Album', year: '2004', genre: 'Rock',
      instruments: ['Guitar', 'Drums'], difficulties: ['Medium', 'Hard', 'Expert'], instrumentDifficulties: { Guitar: ['Hard', 'Expert'], Drums: ['Medium'] }, artworkUrl: ORIGIN + cover,
      viewUrl: `${ORIGIN}/index.html?chart=${encodeURIComponent(chart().id)}&share=2`, downloadEndpoint: `/api/charts/${folder}/SongFolderabcdefghij/download-manifest`, contentHash: 'a'.repeat(64) }],
    revision: null, demo: false, source: 'live'
  });
  assert.deepEqual(calls.map(call => call.url).sort(), [ORIGIN + '/api/charts', ORIGIN + '/api/creators']);
  for (const { options } of calls) {
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store'); assert.equal(options.referrerPolicy, 'no-referrer');
    assert.deepEqual(options.headers, { Accept: 'application/json' });
  }
});

test('ChartsHub client never derives badges from charter text or chart flags', async () => {
  const cases = [
    { creators: [{ id: creator, verifiedCharter: false }], expected: false },
    { creators: [{ id: creator, verifiedCharter: 'true' }], expected: null },
    { creators: [{ id: 'different-id', verifiedCharter: true }], expected: null },
    { creators: [{ id: creator, verifiedCharter: true }, { id: creator, verifiedCharter: false }], expected: null },
    { creators: [], expected: null },
    { creatorsResponse: () => json({ error: 'private upstream message' }, { status: 503 }), expected: null },
    { creatorsResponse: () => { throw Error('private upstream URL'); }, expected: null },
    { creatorsResponse: () => json({ creators: 'invalid' }), expected: null }
  ];
  for (const entry of cases) {
    const { client } = fixture({ ...entry, charts: [chart({ verified: true, verifiedCharter: true, charter: 'Verified Administrator' })] });
    assert.equal((await client.load()).items[0].verified, entry.expected);
  }
});

test('ChartsHub download descriptors trust only server-provided public source routes, never creator IDs', async () => {
  const source = `/api/charts/${folder}/SongFolderabcdefghij/source`;
  for (const downloadUrl of [source, ORIGIN + source]) {
    const item = (await fixture({ charts: [chart({ downloadUrl, creatorId: creator })] }).client.load()).items[0];
    assert.equal(item.downloadEndpoint, source.replace(/source$/, 'download-manifest'));
    assert.ok(!item.downloadEndpoint.includes(creator));
  }
  for (const downloadUrl of [undefined, null, '', source + '?x=1', source + '#x', source + '/..',
    source.replace('/api/charts/', '/api/admin/charts/'), source.replace('/source', '/download-manifest'),
    'https://drive.google.com/drive/folders/SongFolderabcdefghij', 'http://chartshub.ca' + source,
    'https://chartshub.ca:443' + source, 'https://evil.invalid' + source, '//chartshub.ca' + source,
    'https://user:password@chartshub.ca' + source, source.replace('/api/', '/%61pi/'), 'file:///private']) {
    const item = (await fixture({ charts: [chart({ downloadUrl })] }).client.load()).items[0];
    assert.equal(item.downloadEndpoint, null, String(downloadUrl));
  }
});

test('ChartsHub client reports an unavailable creator status separately from false and unknown badges', async () => {
  for (const creatorsResponse of [() => json({ error: 'private details' }, { status: 503 }), () => json({ creators: 'malformed' }), () => json({ creators: [{ id: creator, verifiedCharter: 'true' }] })]) {
    const result = await fixture({ creatorsResponse }).client.load();
    assert.equal(result.items.length, 1); assert.equal(result.items[0].verified, null);
    assert.equal(result.warning, 'Le statut des créateurs vérifiés est temporairement indisponible.');
  }
  assert.equal((await fixture({ creators: [{ id: creator, verifiedCharter: false }] }).client.load()).warning, undefined);
});

test('ChartsHub client preserves instrument-specific difficulties without inventing cross-instrument matches', async () => {
  const result = await fixture({ charts: [chart({ instruments: ['Guitar', 'Bass'], instrumentDifficulties: { Guitar: ['Expert'], Bass: ['Easy'], Unsupported: ['Medium'] } })] }).client.load();
  assert.deepEqual(result.items[0].difficulties, ['Easy', 'Expert']);
  assert.deepEqual(result.items[0].instrumentDifficulties, { Guitar: ['Expert'], Bass: ['Easy'] });
  assert.equal(result.items[0].instrumentDifficulties.Guitar.includes('Easy'), false);
  const unknown = await fixture({ charts: [chart({ instrumentDifficulties: null, difficulty: 'Expert' })] }).client.load();
  assert.deepEqual(unknown.items[0].instrumentDifficulties, {}); assert.deepEqual(unknown.items[0].difficulties, ['Expert']);
});

test('ChartsHub client sanitizes fields, restricts instruments and preserves unknown metadata', async () => {
  const { client } = fixture({ demo: true, charts: [chart({ title: '<color=#fff>' + 'x'.repeat(700) + '</color>', artist: 'Band\u0000 name', charter: '<b>Charter</b>',
    year: null, album: null, genre: { private: true }, instruments: ['Guitar', 'Guitar', 'Unsupported'],
    instrumentDifficulties: { Guitar: ['Expert', 'Expert', 'Impossible'], Unsupported: ['Easy'] },
    contentHash: 'not-a-hash', coverUrl: 'https://private.invalid/image.png', source: 'private', downloadUrl: 'file:///private', logs: ['secret'] })] });
  const result = await client.load(), item = result.items[0];
  assert.equal(result.demo, true); assert.equal(item.title.length, 512); assert.equal(item.artist, 'Band  name'); assert.equal(item.charter, 'Charter');
  assert.deepEqual(item.instruments, ['Guitar']); assert.deepEqual(item.difficulties, ['Expert']);
  assert.equal(item.year, ''); assert.equal(item.album, ''); assert.equal(item.genre, ''); assert.equal(item.contentHash, null); assert.equal(item.artworkUrl, null);
  assert.doesNotMatch(JSON.stringify(item), /secret|private|file:|<color|<b>/);
});

test('ChartsHub client preserves public stable IDs and rebuilds details URLs instead of trusting remote URLs', async () => {
  const { client } = fixture({ charts: [chart({ viewUrl: 'javascript:alert(1)', downloadUrl: '//evil.invalid', contentHash: 'B'.repeat(64), instrumentDifficulties: {}, difficulty: 'Hard' })] });
  const item = (await client.load()).items[0];
  assert.equal(item.id, chart().id); assert.equal(new URL(item.viewUrl).origin, ORIGIN);
  assert.equal(new URL(item.viewUrl).searchParams.get('chart'), item.id); assert.equal(new URL(item.viewUrl).searchParams.get('share'), '2');
  assert.equal(item.artworkUrl, ORIGIN + cover); assert.equal(item.contentHash, 'b'.repeat(64)); assert.deepEqual(item.difficulties, ['Hard']);
});

test('ChartsHub client rejects invalid snapshots and duplicate identities instead of inventing rows', async () => {
  for (const body of [null, [], { charts: [], demo: 'true' }, { charts: 'invalid', demo: false }, { charts: [chart(), chart()], demo: false },
    { charts: [chart({ id: '../private' })], demo: false }, { charts: [chart({ id: 'x'.repeat(513) })], demo: false },
    { charts: [chart({ title: {} })], demo: false }, { charts: [chart({ artist: '' })], demo: false }]) {
    const { client } = fixture({ chartsResponse: () => json(body) });
    await assert.rejects(client.load(), { code: 'CATALOGUE_INVALID' });
  }
  assert.deepEqual((await fixture({ charts: [] }).client.load()).items, []);
});

test('ChartsHub client enforces the item and declared response byte limits', async () => {
  const largeList = fixture({ charts: Array(20001).fill(chart()) });
  await assert.rejects(largeList.client.load(), { code: 'CATALOGUE_LIMIT' });
  const oversized = fixture({ chartsResponse: () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(24 * 1024 * 1024 + 1) } }) });
  await assert.rejects(oversized.client.load(), { code: 'CATALOGUE_LIMIT' });
});

test('ChartsHub client stops an unbounded streamed response at the byte limit', async () => {
  let cancelled = false, chunks = 0;
  const { client } = fixture({ chartsResponse: () => new Response(new ReadableStream({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(8 * 1024 * 1024)); },
    cancel() { cancelled = true; }
  }), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(client.load(), { code: 'CATALOGUE_LIMIT' });
  assert.equal(cancelled, true); assert.ok(chunks <= 5);
});

test('ChartsHub client rejects HTML, malformed JSON, redirects and foreign response URLs', async () => {
  const cases = [
    () => new Response('<html>maintenance</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('invalid JSON', { headers: { 'content-type': 'application/json' } }),
    () => new Response('', { status: 302, headers: { location: 'https://private.invalid' } }),
    () => { const response = json({ charts: [], demo: false }); Object.defineProperty(response, 'redirected', { value: true }); return response; },
    () => { const response = json({ charts: [], demo: false }); Object.defineProperty(response, 'url', { value: 'https://private.invalid/api/charts' }); return response; }
  ];
  for (const chartsResponse of cases) await assert.rejects(fixture({ chartsResponse }).client.load(), error => /CATALOGUE_(?:HTTP|INVALID)/.test(error.code));
});

test('ChartsHub client exposes only generic HTTP and network failures', async () => {
  for (const chartsResponse of [() => json({ error: 'private upstream token' }, { status: 403 }), () => { throw Error('https://private.invalid/?secret'); }, () => { throw Object.assign(Error('secret message'), { code: 'CATALOGUE_NETWORK' }); }]) {
    await assert.rejects(fixture({ chartsResponse }).client.load(), error => {
      assert.doesNotMatch(error.message, /private|secret|token|https:/); return ['CATALOGUE_HTTP', 'CATALOGUE_NETWORK'].includes(error.code);
    });
  }
});

test('ChartsHub client deadlines include stalled fetch and body; creator timeout leaves verification unknown', async () => {
  await assert.rejects(fixture({ timeoutMs: 20, chartsResponse: () => new Promise(() => {}) }).client.load(), { code: 'CATALOGUE_TIMEOUT' });
  let cancelled = false;
  const body = fixture({ timeoutMs: 20, chartsResponse: () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(body.client.load(), { code: 'CATALOGUE_TIMEOUT' }); assert.equal(cancelled, true);
  const partial = fixture({ timeoutMs: 20, creatorsResponse: () => new Promise(() => {}) });
  assert.equal((await partial.client.load()).items[0].verified, null);
});

test('ChartsHub client cancellation reaches both requests and is not replaced by a partial result', async () => {
  const controller = new AbortController(), calls = [];
  const client = createChartsHubClient({ fetcher: async (_url, options) => { calls.push(options.signal); return new Promise(() => {}); } });
  const pending = client.load({ signal: controller.signal }); controller.abort('private reason');
  await assert.rejects(pending, error => error.name === 'AbortError' && error.code === 'ABORT_ERR' && !error.message.includes('private'));
  assert.equal(calls.length, 2); assert.ok(calls.every(signal => signal.aborted));
  await assert.rejects(client.load({ signal: controller.signal }), { name: 'AbortError' }); assert.equal(calls.length, 2);
});

test('ChartsHub artwork accepts only exact first-party cover routes and sends no credentials', async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), calls = [];
  const client = createChartsHubClient({ fetcher: async (url, options) => { calls.push({ url, options }); return new Response(bytes, { headers: { 'content-type': 'image/png' } }); } });
  assert.deepEqual(await client.artwork(cover), { bytes, contentType: 'image/png' });
  assert.deepEqual(await client.artwork(ORIGIN + cover), { bytes, contentType: 'image/png' });
  for (const url of ['https://evil.invalid' + cover, '//chartshub.ca' + cover, 'http://chartshub.ca' + cover, 'https://chartshub.ca.evil.invalid' + cover,
    'https://user:password@chartshub.ca' + cover, 'https://chartshub.ca:443' + cover, ORIGIN + cover + '?redirect=evil', cover + '#x', cover + '/..',
    cover.replace('/api/', '/%61pi/'), '/api/admin/charts/' + folder + '/SongFolderabcdefghij/cover', '/api/auth/me', '/private/file.png', 'file:///image.png', 'data:image/png;base64,AAAA']) {
    assert.equal(await client.artwork(url), null, url);
  }
  assert.equal(calls.length, 2);
  for (const call of calls) { assert.equal(call.url, ORIGIN + cover); assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.redirect, 'error'); }
});

test('ChartsHub artwork validates raster MIME and signature and rejects SVG, redirects and oversize bodies', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  for (const [bytes, mime] of [[Buffer.from([255, 216, 255, 217]), 'image/jpeg'], [Buffer.from('RIFF0000WEBP'), 'image/webp']]) {
    const client = createChartsHubClient({ fetcher: async () => new Response(bytes, { headers: { 'content-type': mime } }) });
    assert.deepEqual(await client.artwork(cover), { bytes, contentType: mime });
  }
  for (const response of [() => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
    () => new Response('<html>error</html>', { headers: { 'content-type': 'image/png' } }),
    () => new Response(png, { headers: { 'content-type': 'image/jpeg' } }),
    () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(3 * 1024 * 1024 + 1) } }),
    () => new Response(Buffer.alloc(3 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }),
    () => new Response('', { status: 302, headers: { location: 'https://evil.invalid' } }),
    () => new Response('', { status: 404 })]) {
    assert.equal(await createChartsHubClient({ fetcher: async () => response() }).artwork(cover), null);
  }
});

test('ChartsHub artwork fails quietly offline but honors cancellation', async () => {
  assert.equal(await createChartsHubClient({ fetcher: async () => { throw Error('private failure'); } }).artwork(cover), null);
  assert.equal(await createChartsHubClient({ timeoutMs: 20, fetcher: async () => new Promise(() => {}) }).artwork(cover), null);
  const controller = new AbortController();
  const pending = createChartsHubClient({ fetcher: async () => new Promise(() => {}) }).artwork(cover, { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
});
