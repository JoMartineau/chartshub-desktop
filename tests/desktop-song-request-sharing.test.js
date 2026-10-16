'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSongRequestSharing } = require('../desktop/song-request-sharing.cjs');
const { ORIGIN } = require('../download');
const { createHash } = require('node:crypto');
const uploadId = '11111111-1111-4111-8111-111111111111';

const account = () => ({ id: 'fixture-account-id', emailVerified: true });
const library = () => ({ token: 'a'.repeat(64), count: 2, updatedAt: '2026-10-10T20:00:00.000Z' });
const payload = () => ({ songs: [{ id: 'b'.repeat(64), title: 'Installed title', artist: 'Artist', charter: 'Charter', durationMs: 180000, tracks: [{ instrument: 'guitar', difficulty: 'expert' }] }], rules: { maxDurationMinutes: 10, instrument: 'guitar', difficulty: 'expert' } });
function fixture(overrides = {}) {
  const calls = [], current = { user: account(), generation: 0 };
  const client = createSongRequestSharing({
    readAccount: async () => current.user, generation: () => current.generation,
    fetcher: async (url, options) => {
      calls.push({ url, options });
      const body = options.body ? JSON.parse(options.body) : null;
      if (url.endsWith('/uploads')) { current.upload = { id: uploadId, count: body.count, received: 0, batches: 0, expiresAt: new Date(Date.now() + 86400000).toISOString(), batchSize: 500, maxBatchBytes: 786432 }; return { ok: true, json: async () => ({ upload: { ...current.upload } }) }; }
      if (/\/batches\/\d+$/.test(url)) { current.upload.received += body.songs.length; current.upload.batches++; return { ok: true, json: async () => ({ upload: { ...current.upload } }) }; }
      if (url.endsWith('/commit')) return { ok: true, json: async () => ({ library: { ...library(), count: current.upload.count, revision: uploadId } }) };
      return { ok: true, json: async () => options.method === 'DELETE' ? { library: null } : { library: library() } };
    },
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

test('publication stages batches then commits; removal returns only the public projection', async () => {
  const f = fixture(); const input = payload(); await f.client.publish(input); await f.client.remove();
  assert.deepEqual(f.calls.map(call => call.options.method), ['POST', 'PUT', 'POST', 'DELETE']);
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { count: input.songs.length, rules: input.rules });
  assert.deepEqual(JSON.parse(f.calls[1].options.body), { songs: input.songs }); assert.equal(f.calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(Object.hasOwn(f.calls[3].options, 'body'), false);
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
  for (const changes of [{ token: ['a'.repeat(64)] }, { token: null }, { token: '../private' }, { token: 'A'.repeat(64) }, { token: 'a'.repeat(63) }, { count: -1 }, { count: 200001 }, { count: 0.5 }, { count: '2' }, { updatedAt: 'Private invalid date' }, { updatedAt: null }]) {
    const f = fixture({ fetcher: async () => ({ ok: true, json: async () => ({ library: { ...library(), ...changes } }) }) });
    await assert.rejects(f.client.status(), genericFailure);
  }
});

test('UTF-8 metadata uses byte-packed bounded batches and invalid metadata never starts an upload', async () => {
  const f = fixture(), input = payload(), progress = [];
  input.songs = Array.from({ length: 600 }, (_, index) => ({ id: createHash('sha256').update(String(index)).digest('hex'), title: '漢'.repeat(512), artist: '漢'.repeat(512), charter: '漢'.repeat(512) }));
  const result = await f.client.publish(input, undefined, { onProgress: value => progress.push(value) });
  assert.equal(result.count, 600);
  const batches = f.calls.filter(call => call.options.method === 'PUT'); assert.ok(batches.length >= 4);
  assert.equal(batches.reduce((sum, call) => sum + JSON.parse(call.options.body).songs.length, 0), 600);
  for (const call of batches) { assert.ok(Buffer.byteLength(call.options.body) <= 786432); assert.ok(JSON.parse(call.options.body).songs.length <= 500); }
  assert.equal(progress.at(-1).phase, 'committing'); assert.equal(progress.at(-1).processed, 600);
  const invalid = fixture(); await assert.rejects(invalid.client.publish({ ...input, songs: [{ ...input.songs[0], relativePath: 'private/song' }] }), { code: 'SHARE_METADATA_INVALID' }); assert.equal(invalid.calls.length, 0);
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
  await f.client.publish(payload(), context); assert.equal(f.calls.length, 3);
  f.current.generation++;
  await assert.rejects(f.client.publish(payload(), context), genericFailure); await assert.rejects(f.client.remove(context), genericFailure);
  assert.equal(f.calls.length, 3);
  f.current.generation = 0; f.current.user = { ...account(), id: 'second-account' };
  await assert.rejects(f.client.publish(payload(), context), genericFailure); assert.equal(f.calls.length, 3);
});

test('83,401 metadata rows publish completely in bounded batches with no truncation', async () => {
  const f = fixture(), input = payload();
  input.songs = Array.from({ length: 83401 }, (_, index) => ({ id: createHash('sha256').update(String(index)).digest('hex'), title: `Song ${index}`, artist: 'Band', charter: 'Mapper' }));
  const result = await f.client.publish(input); assert.equal(result.count, 83401);
  const batches = f.calls.filter(call => call.options.method === 'PUT'); assert.equal(batches.length, 167);
  assert.equal(batches.reduce((sum, call) => sum + JSON.parse(call.options.body).songs.length, 0), 83401);
  assert.equal(JSON.parse(batches.at(-1).options.body).songs.at(-1).id, input.songs.at(-1).id);
});

test('oversized total metadata and count fail before network activity', async () => {
  const f = fixture(), input = payload(), text = '漢'.repeat(512);
  input.songs = Array.from({ length: 30000 }, (_, index) => ({ id: createHash('sha256').update(String(index)).digest('hex'), title: text, artist: text, charter: text }));
  await assert.rejects(f.client.publish(input), { code: 'SHARE_METADATA_LIMIT' }); assert.equal(f.calls.length, 0);
  input.songs = Array(200001).fill(input.songs[0]);
  await assert.rejects(f.client.publish(input), { code: 'SHARE_LIBRARY_LIMIT' }); assert.equal(f.calls.length, 0);
});

test('changed local scope prevents atomic commit and removes only the unfinished stage', async () => {
  const f = fixture(); let current = true;
  await assert.rejects(f.client.publish(payload(), undefined, { isCurrent: () => current, onProgress: value => { if (value.processed === 1) current = false; } }), { code: 'SHARE_LIBRARY_CHANGED' });
  assert.equal(f.calls.some(call => call.url.endsWith('/commit')), false);
  assert.equal(f.calls.at(-1).url.endsWith('/uploads/' + uploadId), true); assert.equal(f.calls.at(-1).options.method, 'DELETE');
  assert.equal(f.calls.some(call => call.options.method === 'DELETE' && call.url === ORIGIN + '/api/account/song-request-library'), false);
});

test('site update, rate limit, network errors and oversized summaries have safe fixed reasons', async () => {
  for (const [status, code] of [[403, 'SHARE_ACCESS_DENIED'], [404, 'SHARE_SERVER_UPDATE_REQUIRED'], [405, 'SHARE_SERVER_UPDATE_REQUIRED'], [413, 'SHARE_METADATA_LIMIT'], [429, 'SHARE_RATE_LIMIT']]) {
    const f = fixture({ fetcher: async () => ({ ok: false, status }) }); await assert.rejects(f.client.publish(payload()), { code });
  }
  await assert.rejects(fixture({ fetcher: async () => { throw Error('private token'); } }).client.publish(payload()), { code: 'SHARE_NETWORK' });
  const response = new Response('x'.repeat(65537));
  await assert.rejects(fixture({ fetcher: async () => response }).client.status(), { code: 'SHARE_RESPONSE_INVALID' });
});

test('unverified local accounts remain distinct from an authenticated HTTP permission refusal', async () => {
  const f = fixture(); f.current.user.emailVerified = false;
  await assert.rejects(f.client.capture(), { code: 'SHARE_ACCOUNT_UNVERIFIED' }); assert.equal(f.calls.length, 0);
  const denied = fixture({ fetcher: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(denied.client.status(), { code: 'SHARE_ACCESS_DENIED' });
});

test('an in-flight upload observes cancellation and cannot send its commit', async () => {
  const calls = [], controller = new AbortController();
  const f = fixture({ fetcher: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/uploads')) return { ok: true, json: async () => ({ upload: { id: uploadId, count: 1, received: 0, batches: 0, expiresAt: new Date(Date.now() + 86400000).toISOString(), batchSize: 500, maxBatchBytes: 786432 } }) };
    if (options.method === 'PUT') return new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(Error('private aborted transport')), { once: true }); controller.abort(); });
    return { ok: true, json: async () => ({ upload: null }) };
  } });
  await assert.rejects(f.client.publish(payload(), undefined, { signal: controller.signal }), { code: 'SHARE_CANCELLED' });
  assert.equal(calls.some(call => call.url.endsWith('/commit')), false);
  assert.equal(calls.at(-1).options.method, 'DELETE');
});

test('account changes after a batch prevent both commit and cleanup under another account', async () => {
  const f = fixture();
  await assert.rejects(f.client.publish(payload(), undefined, { onProgress: value => { if (value.processed === 1) f.current.generation++; } }), { code: 'SHARE_ACCOUNT_CHANGED' });
  assert.deepEqual(f.calls.map(call => call.options.method), ['POST', 'PUT']);
});

test('wrong staged acknowledgements and a mismatched committed revision cannot be accepted', async () => {
  for (const stage of ['batch', 'commit']) {
    // A fresh controlled transport supplies malformed state without any server details.
    let received = 0;
    const client = createSongRequestSharing({ readAccount: async () => account(), fetcher: async (url, options) => {
      if (options.method === 'DELETE') return { ok: true, json: async () => ({ upload: null }) };
      if (url.endsWith('/commit')) return { ok: true, json: async () => ({ library: { ...library(), count: 1, revision: '22222222-2222-4222-8222-222222222222' } }) };
      if (options.method === 'PUT') received = stage === 'batch' ? 0 : 1;
      return { ok: true, json: async () => ({ upload: { id: uploadId, count: 1, received, batches: options.method === 'PUT' ? 1 : 0,
        expiresAt: new Date(Date.now() + 86400000).toISOString(), batchSize: 500, maxBatchBytes: 786432 } }) };
    } });
    await assert.rejects(client.publish(payload()), { code: 'SHARE_RESPONSE_INVALID' });
  }
});
