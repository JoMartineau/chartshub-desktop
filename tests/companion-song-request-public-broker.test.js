'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSongRequestPublicBroker } = require('../companion/song-request-public-broker.cjs');
const { createSongRequests } = require('../companion/song-requests.cjs');
const uuid = number => '11111111-1111-4111-8111-' + String(number).padStart(12, '0');
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(options = {}) {
  const state = { active: false, key: 'synthetic-root-and-revision', revision: uuid(1) }, calls = { poll: [], ack: [], receive: [], resolve: [] };
  let generation = 0, sequence = 100, clock = 1000, ackFailures = options.ackFailures ?? 0;
  const jobs = new Map(); let timerId = 0;
  const event = { id: uuid(2), libraryRevision: state.revision, songId: 'a'.repeat(64), viewerId: 'anonymous-fixture-viewer', viewerName: 'Spectateur web' };
  const song = { id: event.songId, title: 'Synthetic song', artist: 'Synthetic band', durationMs: 180000,
    tracks: [{ instrument: 'guitar', difficulty: 'expert' }] };
  const core = createSongRequests({ getLibrarySnapshot: () => ({ rootKey: 'b'.repeat(64), revision: 1, items: [song] }),
    searchSongs: async () => { throw Error('An exact website request must not perform text search.'); },
    resolveSong: async (...args) => { calls.resolve.push(args); if (options.resolving) await options.resolving.promise; return song; }, now: () => clock });
  core.configure({ enabled: true, ...(options.rules ? { rules: options.rules } : {}) });
  const client = {
    capture: async () => Object.freeze({ userId: 'synthetic-owner', generation }),
    isCurrentAccount: captured => captured.generation === generation,
    pollRequests: async (input, account, settings) => {
      calls.poll.push({ input, account, settings });
      if (options.poll) return options.poll(input, account, settings);
      return { sessionId: input.sessionId, libraryRevision: state.revision, events: input.receiving ? [event] : [] };
    },
    ackRequests: async (input, account, settings) => {
      calls.ack.push({ input, account, settings });
      if (ackFailures-- > 0) throw Object.assign(Error('Private exception must not escape'), { code: 'SHARE_NETWORK' });
      return { sessionId: input.sessionId, acknowledged: input.results.map(result => result.id) };
    }
  };
  const broker = createSongRequestPublicBroker({ client, context: () => ({ ...state }),
    receive: async (input, settings) => { calls.receive.push(input); return core.receive(input, settings); }, now: () => clock,
    sessionId: () => uuid(sequence++), setTimer: fn => { jobs.set(++timerId, fn); return timerId; }, clearTimer: id => jobs.delete(id) });
  return { broker, core, state, event, calls, song, jobs, changeAccount: () => generation++,
    advanceWithoutTimers: ms => { clock += ms; },
    start: async () => { state.active = true; broker.update(); await flush(); },
    tick: async () => { clock += 5000; const scheduled = [...jobs.values()]; jobs.clear(); for (const fn of scheduled) fn(); await flush(); } };
}
test('public reception is inert until a published revision and explicit active context exist', async () => {
  const f = fixture(); f.broker.update(); await flush(); assert.equal(f.calls.poll.length, 0);
  f.state.active = true; f.state.revision = undefined; f.broker.update(); await flush(); assert.equal(f.calls.poll.length, 0);
  f.state.revision = uuid(1); await f.start(); assert.equal(f.broker.status().connected, true);
  await f.broker.stop(); assert.equal(f.jobs.size, 0); assert.equal(f.calls.poll.at(-1).input.receiving, false);
});
test('a slow installed-file check renews the lease without processing repeated events concurrently', async () => {
  const resolving = deferred(), f = fixture({ resolving }); await f.start();
  for (let i = 0; i < 8; i++) await f.tick();
  assert.equal(f.calls.poll.filter(call => call.input.receiving).length, 9);
  assert.equal(f.calls.receive.length, 1); assert.equal(f.calls.ack.length, 0);
  resolving.resolve(); await flush();
  assert.equal(f.core.snapshot().requests.length, 1); assert.equal(f.calls.ack.length, 1);
  await f.broker.stop(); assert.equal(f.jobs.size, 0);
});
test('a paused event loop cannot commit a request after its locally fenced lease expires', async () => {
  const resolving = deferred(), f = fixture({ resolving }); await f.start();
  f.advanceWithoutTimers(30001); resolving.resolve(); await flush();
  assert.equal(f.core.snapshot().requests.length, 0); assert.equal(f.calls.ack.length, 0);
  assert.equal(f.broker.status().active, false); await f.broker.stop();
});
test('an initial poll response delayed twenty-six seconds cannot enter the installed-file receiver', async () => {
  const polled = deferred();
  const f = fixture({ poll: input => input.receiving ? polled.promise : { sessionId: input.sessionId, libraryRevision: null, events: [] } });
  await f.start(); const input = f.calls.poll[0].input;
  f.advanceWithoutTimers(26000);
  assert.equal(f.broker.status().active, false, 'the unknown initial response cannot create an unlimited lease');
  polled.resolve({ sessionId: input.sessionId, libraryRevision: f.state.revision, events: [f.event] }); await flush();
  assert.equal(f.calls.receive.length, 0); assert.equal(f.calls.resolve.length, 0);
  assert.equal(f.core.snapshot().requests.length, 0); assert.equal(f.calls.ack.length, 0);
  await f.broker.stop();
});
test('a delayed successful heartbeat extends only to twenty-five seconds after its dispatch', async () => {
  const resolving = deferred(), renewal = deferred(); let polls = 0;
  const f = fixture({ resolving, poll: input => {
    if (!input.receiving) return { sessionId: input.sessionId, libraryRevision: null, events: [] };
    if (++polls === 1) return { sessionId: input.sessionId, libraryRevision: uuid(1), events: [f.event] };
    return renewal.promise;
  } });
  await f.start(); await f.tick(); const input = f.calls.poll[1].input;
  f.advanceWithoutTimers(8000);
  renewal.resolve({ sessionId: input.sessionId, libraryRevision: f.state.revision, events: [] }); await flush();
  assert.equal(f.broker.status().active, true, 'renewal before the previous deadline is allowed');
  f.advanceWithoutTimers(18000); resolving.resolve(); await flush();
  assert.equal(f.core.snapshot().requests.length, 0, 'reply latency cannot be added to the renewed lease');
  assert.equal(f.calls.ack.length, 0); assert.equal(f.broker.status().active, false);
  await f.broker.stop();
});
test('an outstanding heartbeat cannot extend or revive the old lease after that lease expires', async () => {
  const resolving = deferred(), renewal = deferred(); let polls = 0;
  const f = fixture({ resolving, poll: input => {
    if (!input.receiving) return { sessionId: input.sessionId, libraryRevision: null, events: [] };
    if (++polls === 1) return { sessionId: input.sessionId, libraryRevision: uuid(1), events: [f.event] };
    return renewal.promise;
  } });
  await f.start(); await f.tick(); const input = f.calls.poll[1].input;
  f.advanceWithoutTimers(20001);
  assert.equal(f.broker.status().active, false, 'sending a heartbeat alone does not move the fence');
  renewal.resolve({ sessionId: input.sessionId, libraryRevision: f.state.revision, events: [] }); await flush();
  assert.equal(f.broker.status().active, false, 'a late heartbeat cannot revive an expired fence');
  resolving.resolve(); await flush();
  assert.equal(f.core.snapshot().requests.length, 0); assert.equal(f.calls.ack.length, 0);
  await f.broker.stop();
});
test('exact public requests resolve installed charts before an acknowledgement and remain distinct from Twitch', async () => {
  const f = fixture(); await f.start();
  assert.equal(f.calls.receive.length, 1); assert.equal(f.calls.receive[0].platform, 'website');
  assert.equal(f.calls.resolve.length, 1); assert.equal(f.calls.resolve[0][0], f.event.songId);
  assert.equal(f.core.snapshot().requests[0].platform, 'website');
  const result = f.calls.ack[0].input.results[0]; assert.equal(result.ok, true); assert.equal(result.code, 'request_added');
  assert.equal(result.requestId, f.core.snapshot().requests[0].id); assert.equal(result.action, 'request');
  assert.equal(Object.hasOwn(result, 'viewerId'), false); assert.equal(Object.hasOwn(result, 'title'), false);
  await f.broker.stop();
});
test('lost acknowledgements retry the cached result without re-enqueuing or adding a vote', async () => {
  const f = fixture({ ackFailures: 1 }); await f.start();
  assert.equal(f.broker.status().pendingAcknowledgements, 1); assert.equal(f.broker.status().connected, false);
  const first = structuredClone(f.calls.ack[0].input.results);
  await f.tick(); assert.equal(f.calls.receive.length, 1); assert.equal(f.core.snapshot().requests.length, 1);
  assert.equal(f.core.snapshot().requests[0].votes, 1); assert.deepEqual(f.calls.ack[1].input.results, first);
  assert.equal(f.broker.status().pendingAcknowledgements, 0); await f.broker.stop();
});
test('current local rules and unknown IDs are authoritative even after public submission', async () => {
  const f = fixture({ rules: { maxDurationMinutes: 1 } }); await f.start();
  assert.equal(f.calls.ack[0].input.results[0].code, 'duration_limit'); assert.equal(f.core.snapshot().requests.length, 0);
  await f.broker.stop();
  const unknown = fixture(); unknown.event.songId = 'f'.repeat(64); await unknown.start();
  assert.equal(unknown.calls.ack[0].input.results[0].code, 'song_unavailable'); assert.equal(unknown.calls.resolve.length, 0);
  await unknown.broker.stop();
});
test('events for an earlier public revision are rejected without any installed file resolution', async () => {
  const f = fixture(); f.event.libraryRevision = uuid(9); await f.start();
  assert.equal(f.calls.receive.length, 0); assert.equal(f.calls.resolve.length, 0);
  assert.deepEqual(f.calls.ack[0].input.results, [{ id: f.event.id, ok: false, code: 'library_revision_changed' }]);
  await f.broker.stop();
});
test('closing or disabling reception during installed-file validation prevents both mutation and success receipts', async () => {
  const resolving = deferred(), f = fixture({ resolving }); await f.start(); assert.equal(f.calls.resolve.length, 1);
  f.state.active = false; await f.broker.stop(); resolving.resolve(); await flush();
  assert.equal(f.core.snapshot().requests.length, 0); assert.equal(f.calls.ack.length, 0);
  assert.equal(f.broker.status().active, false); assert.equal(f.jobs.size, 0);
});
test('account switching fences late events and cannot revoke using a different account', async () => {
  const polled = deferred();
  const f = fixture({ poll: input => input.receiving ? polled.promise : ({ sessionId: input.sessionId, libraryRevision: uuid(1), events: [] }) });
  await f.start(); const input = f.calls.poll[0].input; f.changeAccount(); f.broker.update();
  polled.resolve({ sessionId: input.sessionId, libraryRevision: uuid(1), events: [f.event] }); await flush();
  assert.equal(f.calls.receive.length, 0); assert.equal(f.calls.ack.length, 0);
  assert.equal(f.calls.poll.some(call => !call.input.receiving && call.account.generation === 0), false);
  f.state.active = false; await f.broker.stop();
});
test('malformed or forged broker responses fail closed with a safe error', async () => {
  for (const response of [input => ({ sessionId: uuid(999), libraryRevision: uuid(1), events: [] }),
    input => ({ sessionId: input.sessionId, libraryRevision: uuid(1), events: [{ id: uuid(2), libraryRevision: uuid(1), songId: 'a'.repeat(64), viewerId: 'someone', viewerName: 'Twitch moderator' }] }),
    input => ({ sessionId: input.sessionId, libraryRevision: uuid(1), events: [], privatePath: 'PRIVATE' })]) {
    const f = fixture({ poll: async input => response(input) }); await f.start();
    assert.equal(f.calls.receive.length, 0); assert.equal(f.calls.ack.length, 0); assert.equal(f.broker.status().connected, false);
    assert.doesNotMatch(JSON.stringify(f.broker.status()), /PRIVATE|moderator/); await f.broker.stop();
  }
});
