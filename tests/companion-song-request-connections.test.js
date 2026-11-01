'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSongRequestConnections } = require('../companion/song-request-connections.cjs');
const { createSongRequests } = require('../companion/song-requests.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture({ receive } = {}) {
  const accounts = { status: () => ({ persistent: true, error: null }), flush: async () => {} };
  const providers = {}, replies = [], received = [];
  let ready = true, clock = 1000;
  const create = platform => options => {
    let state = 'disconnected', receiving = false;
    const provider = { status: () => ({ state, displayName: state === 'connected' ? 'Fixture' : null, error: null, token: 'SECRET_PROVIDER' }),
      connect: async () => { state = 'connected'; }, disconnect: async () => { state = 'disconnected'; receiving = false; },
      setReceiving: async value => { receiving = value; }, stop: async () => { state = 'disconnected'; receiving = false; },
      receiving: () => receiving,
      sendReply: async message => { replies.push({ platform, message }); return { ok: true }; }, emit: options.onMessage };
    providers[platform] = provider; return provider;
  };
  const service = createSongRequestConnections({ accountStore: accounts, createTwitch: create('twitch'), createTikTok: create('tiktok'),
    receive: async input => { received.push(input); return receive ? receive(input) : { ok: true, command: 'queue', items: [] }; },
    canReceive: () => ready, now: () => clock });
  let next = 0;
  const emit = (platform, query = '!queue', patch = {}) => providers[platform].emit({ platform, eventId: `event-${++next}`, viewerId: '123', viewerName: 'Viewer', query, ...patch });
  return { service, providers, replies, received, emit, ready: value => { ready = value; }, advance: value => { clock += value; } };
}

test('native reception is explicit, ignores ordinary chat and isolates provider identities', async () => {
  const f = fixture();
  f.emit('twitch'); assert.equal(f.received.length, 0);
  await f.service.connect('twitch'); f.emit('twitch'); await tick(); assert.equal(f.received.length, 0);
  await f.service.setReceiving(true);
  for (const query of ['hello', '!queue extra', '!sr', 'x'.repeat(257)]) f.emit('twitch', query);
  f.emit('twitch', '!queue', { platform: 'tiktok' });
  f.emit('twitch'); await tick();
  assert.equal(f.received.length, 1); assert.equal(f.replies[0].message, 'La file est vide.');
  assert.equal(f.received[0].platform, 'twitch');
  assert.doesNotMatch(JSON.stringify(f.service.status()), /SECRET_PROVIDER|accessToken|refreshToken/);
  await f.service.stop();
});

test('reconnecting after disconnect or cancelling consent restores active session reception', async () => {
  for (const platform of ['twitch', 'tiktok']) {
    const f = fixture(); await f.service.setReceiving(true); await f.service.connect(platform, { username: 'fixture' });
    assert.equal(f.providers[platform].receiving(), true);
    await f.service.disconnect(platform); assert.equal(f.providers[platform].receiving(), false);
    await f.service.connect(platform, { username: 'fixture' }); assert.equal(f.providers[platform].receiving(), true);
    if (platform === 'twitch') {
      await f.service.cancelAuth(platform); assert.equal(f.providers[platform].receiving(), false);
      await f.service.connect(platform); assert.equal(f.providers[platform].receiving(), true);
    }
    f.emit(platform); await tick(); assert.equal(f.received.length, 1);
    await f.service.stop();
  }
});

test('TikTok commands use the same real installed-song queue and show local feedback without posting chat', async () => {
  const song = { id: 'a'.repeat(64), title: 'One', artist: 'Metallica', charter: 'Fixture', durationMs: 420000, tracks: [{ instrument: 'guitar', difficulty: 'expert' }] };
  const queue = createSongRequests({ getLibrarySnapshot: () => ({ rootKey: 'b'.repeat(64), revision: 1, items: [song] }),
    searchSongs: async () => ({ items: [song], total: 1, revision: 1 }), resolveSong: async () => song });
  queue.configure({ enabled: true });
  const f = fixture({ receive: input => queue.receive(input) });
  await f.service.connect('tiktok', { username: 'fixture' }); await f.service.setReceiving(true);
  f.emit('tiktok', '!sr Metallica One'); await tick(); await tick();
  assert.equal(queue.snapshot().requests.length, 1); assert.equal(queue.snapshot().requests[0].platform, 'tiktok');
  assert.match(f.service.status().lastResponse.message, /Demande ajoutée.*One/); assert.deepEqual(f.replies, []);
  f.emit('tiktok', '!vote Metallica One', { viewerId: '456' }); await tick(); await tick();
  assert.equal(queue.snapshot().requests[0].votes, 2);
  await f.service.stop();
});

test('event redelivery never repeats queue work or replies and reply bursts are bounded', async () => {
  const f = fixture(); await f.service.connect('twitch'); await f.service.setReceiving(true);
  f.emit('twitch', '!queue', { eventId: 'same' }); f.emit('twitch', '!queue', { eventId: 'same' }); await tick();
  assert.equal(f.received.length, 1); assert.equal(f.replies.length, 1);
  for (let i = 0; i < 18; i++) f.emit('twitch'); await tick(); await tick();
  assert.equal(f.replies.length, 10);
  f.advance(30001); f.emit('twitch'); await tick(); assert.equal(f.replies.length, 11);
  await f.service.stop();
});

test('stopping, disconnecting or losing the library fences replies awaiting queue work', async () => {
  for (const action of ['disable', 'disconnect', 'library', 'stop']) {
    const gate = deferred(), f = fixture({ receive: () => gate.promise });
    await f.service.connect('twitch'); await f.service.setReceiving(true); f.emit('twitch'); await tick();
    let stopped;
    if (action === 'disable') await f.service.setReceiving(false);
    if (action === 'disconnect') await f.service.disconnect('twitch');
    if (action === 'library') f.ready(false);
    if (action === 'stop') stopped = f.service.stop();
    gate.resolve({ ok: true, command: 'queue', items: [] }); await tick(); await stopped;
    assert.deepEqual(f.replies, [], action);
    assert.equal(f.service.status().lastResponse, null, action);
    if (action === 'disconnect') { f.emit('twitch'); await tick(); assert.equal(f.received.length, 1); }
    await f.service.stop();
  }
});

test('pending event work is bounded during a slow library lookup', async () => {
  const gate = deferred(), f = fixture({ receive: () => gate.promise });
  await f.service.connect('twitch'); await f.service.setReceiving(true);
  for (let i = 0; i < 100; i++) f.emit('twitch'); await tick();
  assert.equal(f.received.length, 1);
  gate.resolve({ ok: true, command: 'queue', items: [] }); await tick(); await tick();
  assert.equal(f.received.length, 20); assert.equal(f.replies.length, 10);
  await f.service.stop();
});

function chatFixture() {
  const providers = {}, feed = [], statuses = [], received = [], calls = [];
  let authorized = true;
  const make = platform => options => {
    let state = 'disconnected', physical = false;
    const provider = { status: () => ({ state, displayName: 'Public', error: null, token: 'NEVER_PUBLISH' }),
      connect: async () => { calls.push(platform + ':connect'); state = 'connected'; options.onStatus?.(); },
      disconnect: async () => { state = 'disconnected'; physical = false; options.onStatus?.(); },
      setReceiving: async value => { physical = value; }, stop: async () => { state = 'disconnected'; physical = false; options.onStatus?.(); },
      sendReply: async () => ({ ok: true }), physical: () => physical,
      emit: event => { if (platform === 'twitch') options.onMessage(event); else { options.onChatMessage?.(event); if (event.query.startsWith('!')) options.onMessage(event); } },
      fail: () => { state = 'error'; options.onStatus?.(); } };
    providers[platform] = provider; return provider;
  };
  const service = createSongRequestConnections({ accountStore: { status: () => ({ persistent: true }), flush: async () => {} },
    createTwitch: make('twitch'), createTikTok: make('tiktok'), canReceive: () => authorized, canChat: () => authorized,
    onChatMessage: value => feed.push(value), onChatConnection: (platform, value) => statuses.push({ platform, ...value }),
    receive: async value => { received.push(value); return { ok: true, command: 'queue', items: [] }; } });
  let id = 0;
  const emit = (platform, query = 'Hello') => providers[platform].emit({ platform, eventId: String(++id), viewerName: 'Viewer', viewerId: 'private-id', query, token: 'NEVER_PUBLISH' });
  return { service, providers, feed, statuses, received, calls, emit, revoke: () => { authorized = false; } };
}

test('local chat is a separate explicit opt-in and never starts provider authorization itself', async () => {
  const f = chatFixture(); assert.deepEqual(f.calls, []); assert.equal(f.service.status().chatEnabled, false);
  await f.service.setChatEnabled(true); assert.deepEqual(f.calls, []);
  for (const platform of ['twitch', 'tiktok']) {
    const prior = f.feed.length; f.emit(platform); assert.equal(f.feed.length, prior);
    await f.service.connect(platform, { username: 'fixture' }); f.emit(platform);
  }
  assert.equal(f.feed.length, 2); assert.equal(f.received.length, 0);
  assert.deepEqual(Object.keys(f.feed[0]), ['platform', 'eventId', 'viewerName', 'query']);
  assert.doesNotMatch(JSON.stringify(f.feed) + JSON.stringify(f.statuses), /private-id|NEVER_PUBLISH|token/);
  await f.service.stop();
});

test('turning off song requests keeps an opted-in chat transport, and turning off chat keeps active requests', async () => {
  const f = chatFixture(); await f.service.connect('twitch'); await f.service.setChatEnabled(true); await f.service.setReceiving(true);
  await f.service.setReceiving(false); assert.equal(f.providers.twitch.physical(), true);
  f.emit('twitch', '!queue'); await tick(); assert.equal(f.feed.length, 1); assert.equal(f.received.length, 0);
  await f.service.setReceiving(true); await f.service.setChatEnabled(false); assert.equal(f.providers.twitch.physical(), true);
  f.emit('twitch', '!queue'); await tick(); assert.equal(f.feed.length, 1); assert.equal(f.received.length, 1);
  await f.service.setReceiving(false); assert.equal(f.providers.twitch.physical(), false); await f.service.stop();
});

test('disconnect, revoked host access and full stop fence the local feed', async () => {
  const f = chatFixture(); await f.service.setChatEnabled(true); await f.service.connect('twitch'); await f.service.connect('tiktok', { username: 'fixture' });
  f.emit('twitch'); await f.service.disconnect('twitch'); f.emit('twitch'); f.emit('tiktok'); assert.equal(f.feed.length, 2);
  assert.equal(f.statuses.filter(value => value.platform === 'twitch').at(-1).state, 'disconnected');
  f.revoke(); f.emit('tiktok'); assert.equal(f.feed.length, 2);
  await f.service.stop(); f.emit('tiktok'); assert.equal(f.feed.length, 2); assert.equal(f.service.status().chatEnabled, false);
});
