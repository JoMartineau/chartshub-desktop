'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { searchRhythmVerse, searchRhythmVersePage } = require('../desktop/rhythmverse-client.cjs');

const chartId = 'f5722315293645d5ad03f17c0fa5defe';
const result = (songs, records) => Response.json({ status: 'success', data: { songs, records } });

test('sends a public form request and preserves authored difficulties for this exact chart', async () => {
  const rows = await searchRhythmVerse('  Through the Fire and Flames  ', {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://rhythmverse.co/api/ch/songfiles/search/live');
      assert.equal(options.method, 'POST');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['X-Requested-With'], 'XMLHttpRequest');
      assert.deepEqual(Object.fromEntries(options.body), {
        text: 'Through the Fire and Flames', data_type: 'full', records: '12', page: '1',
      });
      return result([{ data: {
        title: 'Through the Fire and Flames', artist: 'DragonForce', album: 'Inhuman Rampage',
        year: 2006, genre: 'Metal', diff_bass: 5,
      }, file: {
        file_id: chartId, charter: '<color=#fc0>Peddy</color>', author: { name: 'Uploader' },
        gameformat: 'ch', file_year: '2005', file_song_length: '442',
        diff_guitar: '7', diff_drums: 0, diff_keys: 2,
        difficulties: { guitar: { x: '1' }, guitar_coop: [], drums: { all: true } },
        download_url: 'https://drive.google.com/file/d/test/view', download_page_url: '/download/example',
      } }]);
    },
  });

  assert.deepEqual(rows, [{
    id: chartId, title: 'Through the Fire and Flames', artist: 'DragonForce', charter: 'Peddy', format: 'ch',
    album: 'Inhuman Rampage', year: 2005, genre: 'Metal', duration: 442,
    instruments: [
      { name: 'Guitare', available: ['Expert'], rank: 7 },
      { name: 'Batterie', available: ['Facile', 'Moyen', 'Difficile', 'Expert'], rank: null },
      { name: 'Clavier', available: [], rank: 2 },
    ],
    downloadUrl: 'https://drive.google.com/file/d/test/view', pageUrl: 'https://rhythmverse.co/download/example',
  }]);
});

test('keeps safe page fallbacks and omits links unsafe for the system browser', async () => {
  const invalidLinks = [
    'none', 'javascript:alert(1)', 'file:///C:/Windows', '//malicious.example/file',
    'https://user@example.com/file', 'https://example.com:8443/file', 'https://127.1/file',
    'https://[::1]/file', 'https://api.home.local/file', 'https://example.com/%0a%00x',
    'https://example.com/\r\nfile', 'https:\\example.com\\file',
  ];
  const rows = await searchRhythmVerse('test', { fetchImpl: async () => result(invalidLinks.map((link, index) => ({
    file: { file_id: index + 1, author: { name: 'Uploader' }, download_url: link,
      download_page_url_full: 'mailto:someone@example.com', external_url: 'https://mediafire.com/download/test' },
  }))) });
  assert.equal(rows.length, invalidLinks.length);
  for (const row of rows) {
    assert.equal(row.charter, 'Uploader');
    assert.equal(row.downloadUrl, null);
    assert.equal(row.pageUrl, 'https://mediafire.com/download/test');
  }
});

test('caps response rows and metadata and ignores malformed or duplicate chart IDs', async () => {
  const rows = await searchRhythmVerse('test', { fetchImpl: async () => result([
    null, { file: { file_id: '../not-an-id' } },
    { data: { title: 'a'.repeat(2000) }, file: { file_id: chartId } },
    { file: { file_id: chartId } },
    ...Array.from({ length: 20 }, (_, index) => ({ file: { file_id: index + 1 } })),
  ]) });
  assert.equal(rows.length, 9);
  assert.equal(rows[0].title.length, 240);
  assert.equal(rows[0].id, chartId);
  assert.equal(rows[1].id, '1');
  assert.equal(rows[0].downloadUrl, null);
});

test('propagates a cancelled search and avoids fetching an already-cancelled search', async () => {
  const controller = new AbortController();
  const reason = new Error('Superseded by another search');
  const pending = searchRhythmVerse('test', { signal: controller.signal, fetchImpl: async (_url, { signal }) => {
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  controller.abort(reason);
  await assert.rejects(pending, reason);
  await assert.rejects(searchRhythmVerse('test', { signal: controller.signal, fetchImpl: () => {
    assert.fail('Should not request a cancelled search');
  } }), reason);
});

test('browses the latest Clone Hero charts when the query is empty', async () => {
  const rows = await searchRhythmVerse(' ', { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://rhythmverse.co/api/ch/songfiles/list');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(Object.fromEntries(options.body), {
      data_type: 'full', records: '12', page: '1', 'sort[0][sort_by]': 'update_date', 'sort[0][sort_order]': 'DESC',
    });
    return result([{ data: { title: 'Latest chart' }, file: { file_id: chartId, gameformat: 'ch' } }]);
  } });
  assert.equal(rows[0].title, 'Latest chart');
  assert.equal(rows[0].format, 'ch');
});

test('validates the query and upstream payload and bounds streamed response bytes', async () => {
  await assert.rejects(searchRhythmVerse(' a ', { fetchImpl: () => assert.fail('No fetch for a one-character query') }), /Invalid RhythmVerse search/);
  await assert.rejects(searchRhythmVerse('x'.repeat(121)), /Invalid RhythmVerse search/);
  await assert.rejects(searchRhythmVerse('test', { fetchImpl: async () => new Response(null, { status: 429 }) }), /HTTP 429/);
  await assert.rejects(searchRhythmVerse('test', { fetchImpl: async () => Response.json({ status: 'success' }) }), /Invalid RhythmVerse response/);
  await assert.rejects(searchRhythmVerse('test', { fetchImpl: async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)) }), /response too large/);
});

test('uses RhythmVerse update dates for catalogue sorting and falls back to release dates', async () => {
  const rows = [
    { file: { file_id: 1, update_date: '2026-11-07 23:01:38', release_date: '2026-11-07 22:57:35' } },
    { file: { file_id: 2, update_date: '0000-00-00 00:00:00', release_date: '2026-11-06 21:00:56' } },
    { file: { file_id: 3, update_date: 'invalid' } },
  ];
  const fetchImpl = async () => result(rows);
  const { items } = await searchRhythmVersePage('', { fetchImpl });
  assert.deepEqual(items.map(item => item.modifiedAt), ['2026-11-07T23:01:38Z', '2026-11-06T21:00:56Z', null]);
  assert.ok((await searchRhythmVerse('', { fetchImpl })).every(item => !Object.hasOwn(item, 'modifiedAt')));
});

test('sends a 24-chart page to the right endpoint and derives the remaining pages from the filtered total', async () => {
  const rows = Array.from({ length: 24 }, (_, index) => ({ file: { file_id: index + 1 } }));
  const { items, total, hasMore } = await searchRhythmVersePage(' ', { page: 2, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://rhythmverse.co/api/ch/songfiles/list');
    assert.deepEqual(Object.fromEntries(options.body), {
      data_type: 'full', records: '24', page: '2', 'sort[0][sort_by]': 'update_date', 'sort[0][sort_order]': 'DESC',
    });
    return result(rows, { total_available: 133861, total_filtered: '49', returned: 24 });
  } });
  assert.equal(items.length, 24);
  assert.equal(total, 49);
  assert.equal(hasMore, true);

  const last = await searchRhythmVersePage('test', { page: 3, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://rhythmverse.co/api/ch/songfiles/search/live');
    assert.deepEqual(Object.fromEntries(options.body), { data_type: 'full', records: '24', page: '3', text: 'test' });
    return result(rows.slice(0, 1), { total_available: 133861, total_filtered: 49, returned: 1 });
  } });
  assert.equal(last.items.length, 1);
  assert.equal(last.total, 49);
  assert.equal(last.hasMore, false);
});

test('normalizes album artwork from song or chart data without exposing it in the legacy array', async () => {
  const rows = [
    { data: { album_art: '/assets/album_art/t/track.png' }, file: { file_id: 1, album_art: '/assets/album_art/author/track.png' } },
    { data: { album_art: 'http://rhythmverse.co/track.png' }, file: { file_id: 2, album_art: 'https://rhythmverse.co/assets/album_art/author/track.png' } },
    { data: { album_art: 'file:///C:/Windows' }, file: { file_id: 3, album_art: '//malicious.example/image.png' } },
  ];
  const { items, total, hasMore } = await searchRhythmVersePage('test', { fetchImpl: async () => result(rows) });
  assert.deepEqual(items.map(item => item.artworkUrl), [
    'https://rhythmverse.co/assets/album_art/t/track.png', 'https://rhythmverse.co/assets/album_art/author/track.png', null,
  ]);
  assert.equal(total, 3);
  assert.equal(hasMore, false);
  const legacy = await searchRhythmVerse('test', { fetchImpl: async () => result(rows) });
  assert.ok(legacy.every(item => !Object.hasOwn(item, 'artworkUrl')));
});

test('bounds page numbers and stops pagination after an empty result or the maximum page', async () => {
  for (const page of [0, 1.5, 251, '2']) {
    await assert.rejects(searchRhythmVersePage('', { page, fetchImpl: () => assert.fail('No fetch for an invalid page') }), /Invalid RhythmVerse page/);
  }
  const empty = await searchRhythmVersePage('test', { fetchImpl: async () => result([], { total_filtered: 0 }) });
  assert.deepEqual(empty, { items: [], total: 0, hasMore: false });
  const maximum = await searchRhythmVersePage('', { page: 250, fetchImpl: async () => result([{ file: { file_id: 1 } }], { total_filtered: 90000 }) });
  assert.equal(maximum.hasMore, false);
});
