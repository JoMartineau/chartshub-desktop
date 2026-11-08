'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRhythmVerseArtwork, rhythmVerseArtworkUrl } = require('../desktop/rhythmverse-artwork.cjs');

const coverPath = '/assets/album_art/a/alf-theme-111825.png';
const coverUrl = 'https://rhythmverse.co' + coverPath;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yhZkAAAAASUVORK5CYII=', 'base64');
const jpegHeader = Buffer.from('ffd8ffc0000b080001000101011100ffd9', 'hex');
const response = (bytes = png, mime = 'image/png') => new Response(bytes, { headers: { 'Content-Type': mime } });

test('authorizes only the official album art HTTPS paths', () => {
  assert.equal(rhythmVerseArtworkUrl(coverPath), coverUrl);
  assert.equal(rhythmVerseArtworkUrl(coverUrl), coverUrl);
  for (const value of [
    'http://rhythmverse.co' + coverPath, 'https://rhythmverse.co:444' + coverPath,
    'https://rhythmverse.co.evil.test' + coverPath, 'https://user@rhythmverse.co' + coverPath,
    '//rhythmverse.co' + coverPath, coverUrl + '?token=secret', coverUrl + '#fragment',
    '/assets/album_art/a%2fexample.png', '/assets/album_art/a/../../unrelated.png', '/assets/album_art/test.svg',
  ]) assert.equal(rhythmVerseArtworkUrl(value), null, value);
});

test('shares pending work and caches raster data using the signature rather than a misleading header', async () => {
  const calls = [];
  const service = createRhythmVerseArtwork({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response(jpegHeader, 'image/png');
  } });
  const expected = 'data:image/jpeg;base64,' + jpegHeader.toString('base64');
  assert.deepEqual(await Promise.all([service.load(coverUrl), service.load(coverPath)]), [expected, expected]);
  assert.equal(await service.load(coverUrl), expected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'manual');
});

test('allows a checked local redirect and refuses redirects out of the cover route', async () => {
  const urls = [];
  const service = createRhythmVerseArtwork({ fetchImpl: async url => {
    urls.push(url);
    return urls.length === 1 ? new Response(null, { status: 302, headers: { Location: '../b/cover.jpg' } }) : response();
  } });
  assert.equal(await service.load(coverUrl), 'data:image/png;base64,' + png.toString('base64'));
  assert.deepEqual(urls, [coverUrl, 'https://rhythmverse.co/assets/album_art/b/cover.jpg']);

  let attempts = 0;
  const denied = createRhythmVerseArtwork({ fetchImpl: async () => {
    attempts++;
    return new Response(null, { status: 302, headers: { Location: 'https://example.test' + coverPath } });
  } });
  assert.equal(await denied.load(coverUrl), null);
  assert.equal(attempts, 1);
});

test('rejects active content, disguised bytes, excessive image dimensions and oversized streams', async () => {
  const hugePng = Buffer.from(png);
  hugePng.writeUInt32BE(50_000, 16);
  for (const reply of [
    response('<svg />', 'image/svg+xml'), response('<html />'), response(hugePng), response(Buffer.alloc(512 * 1024 + 1)),
  ]) {
    const service = createRhythmVerseArtwork({ fetchImpl: async () => reply });
    assert.equal(await service.load(coverUrl), null);
  }
});

test('caps concurrent requests and clear aborts active and queued image loads', async () => {
  const started = [];
  const service = createRhythmVerseArtwork({ fetchImpl: async (url, { signal }) => {
    started.push({ url, signal });
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw signal.reason;
  } });
  const pending = Array.from({ length: 8 }, (_, index) => service.load(`/assets/album_art/a/image-${index}.png`));
  assert.equal(started.length, 6);
  service.clear();
  assert.deepEqual(await Promise.all(pending), Array(8).fill(null));
  assert.ok(started.every(entry => entry.signal.aborted));
});

test('a superseded query drops its queued covers and frees the active slots for new work', async () => {
  const started = [];
  const old = new AbortController();
  const service = createRhythmVerseArtwork({ fetchImpl: async (url, { signal }) => {
    started.push({ url, signal });
    if (url === coverUrl) return response();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw signal.reason;
  } });
  const pending = Array.from({ length: 8 }, (_, index) => service.load(`/assets/album_art/a/old-${index}.png`, { signal: old.signal }));
  assert.equal(started.length, 6);
  old.abort();
  assert.deepEqual(await Promise.all(pending), Array(8).fill(null));
  assert.ok(started.every(entry => entry.signal.aborted));
  assert.equal(await service.load(coverUrl), 'data:image/png;base64,' + png.toString('base64'));
  assert.equal(started.length, 7);
});

test('canceling a caller does not interrupt a shared cover request that still has a consumer', async () => {
  const first = new AbortController();
  let finish, activeSignal;
  const service = createRhythmVerseArtwork({ fetchImpl: async (_url, { signal }) => {
    activeSignal = signal;
    return new Promise(resolve => { finish = resolve; });
  } });
  const canceled = service.load(coverPath, { signal: first.signal });
  const shared = service.load(coverUrl);
  first.abort();
  assert.equal(await canceled, null);
  assert.equal(activeSignal.aborted, false);
  finish(response());
  assert.equal(await shared, 'data:image/png;base64,' + png.toString('base64'));
});
