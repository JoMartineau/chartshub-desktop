'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSongRequestSharing } = require('../desktop/song-request-sharing.cjs');
const { ORIGIN } = require('../download');

const account = () => ({ id: 'fixture-account-id', emailVerified: true });
const library = () => ({ token: 'a'.repeat(64), count: 2, updatedAt: '2026-10-10T20:00:00.000Z' });
const payload = () => ({ songs: [{ id: 'b'.repeat(64), title: 'Installed title', artist: 'Artist', charter: 'Charter', durationMs: 180000, tracks: [{ instrument: 'guitar', difficulty: 'expert' }] }], rules: { maxDurationMinutes: 10, instrument: 'guitar', difficulty: 'expert' } });
function fixture(overrides = {}) {
  const calls = [], current = { user: account(), generation: 0 };
  const client = createSongRequestSharing({
    readAccount: async () => current.user, generation: () => current.generation,
    fetcher: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ library: library() }) }; },
    ...overrides,
  });
  return { client, calls, current };
}
const genericFailure = error => error instanceof Error && /partage est indisponible/.test(error.message) && !/Private|secret/.test(error.message);

test('library sharing is inert until called and sends account-bound credentialed requests only to the fixed route', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0); const result = await f.client.status();
  assert.deepEqual(result, { url: ORIGIN + '/song-requests.html?library=' + 'a'.repeat(64), count: 2, updatedAt: library().updatedAt });
  assert.equal(f.calls.length, 1); const { url, options } = f.calls[0];
  assert.equal(url, ORIGIN + '/api/account/song-request-library'); assert.equal(options.method, 'GET');
  assert.equal(options.credentials, 'include'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
  assert.deepEqual(options.headers, { Origin: ORIGIN, 'X-ChartsHub-Account-Id': account().id });
  assert.equal(Object.hasOwn(options, 'body'), false); assert.ok(options.signal instanceof AbortSignal);
});

test('publishing and removal use explicit PUT and DELETE and return only the public projection', async () => {
  const f = fixture(); const input = payload(); await f.client.publish(input); await f.client.remove();
  assert.deepEqual(f.calls.map(call => call.options.method), ['PUT', 'DELETE']);
  assert.deepEqual(JSON.parse(f.calls[0].options.body), input); assert.equal(f.calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(Object.hasOwn(f.calls[1].options, 'body'), false);
  const empty = fixture({ fetcher: async () => ({ ok: true, json: async () => ({ library: null, private: 'must-not-return' }) }) });
  assert.deepEqual(await empty.client.status(), { url: null, count: 0, updatedAt: null });
});

test('anonymous, unverified and missing-ID accounts cannot read, publish or remove a share', async () => {
  for (const user of [null, undefined, {}, { id: 'fixture' }, { id: 'fixture', emailVerified: false }, { id: '', emailVerified: true }]) {
    const f = fixture(); f.current.user = user;
    for (const operation of [() => f.client.status(), () => f.client.publish(payload()), () => f.client.remove()]) await assert.rejects(operation(), genericFailure);
    assert.equal(f.calls.length, 0);
  }
});

test('an account generation change while reading authentication blocks the request', async () => {
  let generation = 0, calls = 0;
  const client = createSongRequestSharing({ generation: () => generation, readAccount: async () => { generation++; return account(); }, fetcher: async () => { calls++; } });
  await assert.rejects(client.publish(payload()), genericFailure); assert.equal(calls, 0);
});

test('logout or account switches during the network request or JSON decoding cannot commit a stale result', async () => {
  for (const stage of ['response', 'json', 'account', 'verification']) {
    let generation = 0, user = account(), reads = 0;
    const client = createSongRequestSharing({ generation: () => generation, readAccount: async () => { reads++; return user; },
      fetcher: async () => {
        if (stage === 'response') generation++;
        return { ok: true, json: async () => {
          if (stage === 'json') generation++;
          if (stage === 'account') user = { ...account(), id: 'different-account' };
          if (stage === 'verification') user = { ...account(), emailVerified: false };
          return { library: library() };
        } };
      } });
    await assert.rejects(client.publish(payload()), genericFailure); assert.ok(reads >= 1);
  }
});

test('non-success responses and invalid public capabilities, counts or dates are refused', async () => {
  const refused = fixture({ fetcher: async () => ({ ok: false, json: async () => { throw Error('Must not parse denied response'); } }) });
  await assert.rejects(refused.client.status(), genericFailure);
  for (const changes of [{ token: ['a'.repeat(64)] }, { token: null }, { token: '../private' }, { token: 'A'.repeat(64) }, { token: 'a'.repeat(63) }, { count: -1 }, { count: 10001 }, { count: 0.5 }, { count: '2' }, { updatedAt: 'Private invalid date' }, { updatedAt: null }]) {
    const f = fixture({ fetcher: async () => ({ ok: true, json: async () => ({ library: { ...library(), ...changes } }) }) });
    await assert.rejects(f.client.status(), genericFailure);
  }
});

test('the publication limit measures UTF-8 bytes and refuses an oversized body before any fetch', async () => {
  const f = fixture(); const exact = { text: '' }; const overhead = Buffer.byteLength(JSON.stringify(exact));
  exact.text = 'a'.repeat(5 * 1024 * 1024 - overhead); await f.client.publish(exact); assert.equal(f.calls.length, 1);
  await assert.rejects(f.client.publish({ text: exact.text + 'a' }), genericFailure); assert.equal(f.calls.length, 1);
  await assert.rejects(f.client.publish({ text: 'é'.repeat(3 * 1024 * 1024) }), genericFailure); assert.equal(f.calls.length, 1);
});

test('public responses cannot supply a different URL or expose account authoring data', async () => {
  const f = fixture({ fetcher: async () => ({ ok: true, json: async () => ({ library: { ...library(), url: 'https://private.invalid', tokenSecret: 'private-authoring' }, accountToken: 'private-cookie' }) }) });
  const result = await f.client.status(); assert.deepEqual(Object.keys(result).sort(), ['count', 'updatedAt', 'url']);
  assert.equal(result.url, ORIGIN + '/song-requests.html?library=' + 'a'.repeat(64)); assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('captured account identity binds the whole local preparation to the publishing account', async () => {
  const f = fixture(); const context = await f.client.capture();
  assert.ok(Object.isFrozen(context)); assert.deepEqual(context, { generation: 0, userId: account().id });
  assert.equal(f.calls.length, 0, 'capturing local authentication does not publish');
  await f.client.publish(payload(), context); assert.equal(f.calls.length, 1);
  f.current.generation++;
  await assert.rejects(f.client.publish(payload(), context), genericFailure); await assert.rejects(f.client.remove(context), genericFailure);
  assert.equal(f.calls.length, 1);
  f.current.generation = 0; f.current.user = { ...account(), id: 'second-account' };
  await assert.rejects(f.client.publish(payload(), context), genericFailure); assert.equal(f.calls.length, 1);
});
