'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSongRequestSharing } = require('../desktop/song-request-sharing.cjs');
const { ORIGIN } = require('../download');
const sessionId = '11111111-1111-4111-8111-111111111111', eventId = '22222222-2222-4222-8222-222222222222';
const event = () => ({ id: eventId, libraryRevision: sessionId, songId: 'a'.repeat(64), viewerId: 'opaque-synthetic-viewer', viewerName: 'Spectateur web' });
function fixture(options = {}) {
  let generation = 1, user = { id: 'synthetic-owner', emailVerified: true }; const calls = [];
  const client = createSongRequestSharing({ generation: () => generation, readAccount: async () => user,
    fetcher: async (url, settings) => {
      calls.push({ url, settings }); const body = JSON.parse(settings.body ?? '{}');
      const value = url.endsWith('/poll') ? { sessionId, libraryRevision: sessionId, events: body.receiving ? [event()] : [] }
        : { sessionId, acknowledged: body.results.map(result => result.id) };
      return options.fetcher ? options.fetcher(url, settings) : { ok: true, json: async () => value };
    } });
  return { client, calls, switch: () => generation++, unverify: () => { user = { ...user, emailVerified: false }; } };
}
test('poll and acknowledgement retain the verified owner session, fixed route and account-generation guards', async () => {
  const f = fixture(), account = await f.client.capture();
  assert.equal(f.calls.length, 0); assert.equal(f.client.isCurrentAccount(account), true);
  assert.deepEqual((await f.client.pollRequests({ sessionId, receiving: true }, account)).events, [event()]);
  const results = [{ id: eventId, ok: false, code: 'song_unavailable' }];
  assert.deepEqual(await f.client.ackRequests({ sessionId, results }, account), { sessionId, acknowledged: [eventId] });
  for (const [index, call] of f.calls.entries()) {
    assert.equal(call.url, ORIGIN + '/api/account/song-request-library/requests/' + (index ? 'ack' : 'poll'));
    assert.equal(call.settings.credentials, 'include'); assert.equal(call.settings.redirect, 'error'); assert.equal(call.settings.method, 'POST');
    assert.equal(call.settings.headers.Origin, ORIGIN); assert.equal(call.settings.headers['X-ChartsHub-Account-Id'], 'synthetic-owner');
    assert.equal(Object.hasOwn(call.settings.headers, 'Authorization'), false);
  }
  f.switch(); assert.equal(f.client.isCurrentAccount(account), false);
  await assert.rejects(f.client.pollRequests({ sessionId, receiving: true }, account), { code: 'SHARE_ACCOUNT_CHANGED' });
  assert.equal(f.calls.length, 2);
});
test('unverified accounts, forged identities and excessive result batches cannot start a lease', async () => {
  const f = fixture(); f.unverify();
  await assert.rejects(f.client.pollRequests({ sessionId, receiving: true }), { code: 'SHARE_ACCOUNT_UNVERIFIED' });
  assert.equal(f.calls.length, 0);
  const valid = fixture();
  for (const input of [{ sessionId, receiving: 'true' }, { sessionId, receiving: true, token: 'local-secret' }, { sessionId: '../other', receiving: true }, { sessionId: [sessionId], receiving: true }]) {
    await assert.rejects(valid.client.pollRequests(input), { code: 'SHARE_RESPONSE_INVALID' });
  }
  await assert.rejects(valid.client.ackRequests({ sessionId, results: Array.from({ length: 21 }, () => ({ id: eventId, ok: false, code: 'disabled' })) }), { code: 'SHARE_RESPONSE_INVALID' });
  assert.equal(valid.calls.length, 0);
});
test('oversized, extra-field and wrong-session responses never reach the native queue', async () => {
  for (const value of [{ sessionId: eventId, libraryRevision: sessionId, events: [] },
    { sessionId, libraryRevision: sessionId, events: [event()], credentials: 'PRIVATE' },
    { sessionId, libraryRevision: [sessionId], events: [] },
    { sessionId, libraryRevision: sessionId, events: [{ ...event(), id: [eventId] }] },
    { sessionId, libraryRevision: sessionId, events: [{ ...event(), songId: ['a'.repeat(64)] }] },
    { sessionId, libraryRevision: sessionId, events: Array.from({ length: 21 }, event) }, { value: 'x'.repeat(65537) }]) {
    const f = fixture({ fetcher: async () => ({ ok: true, json: async () => value }) });
    await assert.rejects(f.client.pollRequests({ sessionId, receiving: true }), { code: 'SHARE_RESPONSE_INVALID' });
  }
});
test('a closed lease may return no publication revision but cannot carry any events', async () => {
  const f = fixture({ fetcher: async () => ({ ok: true, json: async () => ({ sessionId, libraryRevision: null, events: [] }) }) });
  assert.deepEqual(await f.client.pollRequests({ sessionId, receiving: false }), { sessionId, libraryRevision: null, events: [] });
  await assert.rejects(f.client.pollRequests({ sessionId, receiving: true }), { code: 'SHARE_RESPONSE_INVALID' });
  const forged = fixture({ fetcher: async () => ({ ok: true, json: async () => ({ sessionId, libraryRevision: null, events: [event()] }) }) });
  await assert.rejects(forged.client.pollRequests({ sessionId, receiving: false }), { code: 'SHARE_RESPONSE_INVALID' });
});
