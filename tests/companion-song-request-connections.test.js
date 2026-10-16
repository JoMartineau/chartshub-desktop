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
