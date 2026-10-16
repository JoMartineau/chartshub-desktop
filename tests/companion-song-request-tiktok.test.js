'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTikTokSongRequestConnection, normalizeUsername, normalizeMessage, createDefaultConnection } = require('../companion/song-request-tiktok.cjs');

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const chat = (id = '123', changes = {}) => ({ common: { msgId: id }, user: { userId: '456', uniqueId: 'viewer', nickname: 'Viewer' }, comment: '!sr Artist Song', ...changes });

class FakeClient extends EventEmitter {
  constructor({ pending = null, failure = null, emitConnected = true } = {}) { super(); this.pending = pending; this.failure = failure; this.emitConnected = emitConnected; this.connectCount = 0; this.disconnectCount = 0; this.terminated = 0; this.wsClient = { terminate: () => { this.terminated += 1; } }; }
  async connect() { this.connectCount += 1; if (this.pending) await this.pending.promise; if (this.failure) throw this.failure; if (this.emitConnected) this.emit('connected', { roomId: 'private-provider-data' }); return { isConnected: true }; }
  async disconnect() { this.disconnectCount += 1; }
}

function fixture(t, options = {}) {
  const calls = [], messages = [], statuses = [], clients = [];
  const service = createTikTokSongRequestConnection({
    createConnection: async (username, config) => { calls.push({ username, config }); const client = options.client ?? new FakeClient(); clients.push(client); return client; },
    onMessage: message => { messages.push(message); return options.onMessage?.(message); },
    onStatus: status => { statuses.push(status); options.onStatus?.(status); },
    ...options
  });
  t.after(() => service.stop());
  return { service, calls, messages, statuses, clients };
}

test('only a bounded conventional public TikTok handle is accepted', () => {
  assert.equal(normalizeUsername(' @Some.Creator_12 '), 'some.creator_12');
  assert.equal(normalizeUsername('a'), 'a');
  assert.equal(normalizeUsername('a'.repeat(24)), 'a'.repeat(24));
  for (const input of [null, undefined, {}, 123, '', '@', 'a'.repeat(25), '@@name', 'name.', '.name', 'some/name', 'a:b', 'user name', 'https://www.tiktok.com/@name/live', 'user\0name', 'éname', '../a', 'a\r\nb']) assert.equal(normalizeUsername(input), null, String(input));
});

test('messages use provider numeric identities and ignore ordinary chat', () => {
  assert.deepEqual(normalizeMessage(chat()), { platform: 'tiktok', eventId: '123', viewerId: '456', viewerName: 'Viewer', query: '!sr Artist Song' });
  assert.deepEqual(normalizeMessage(chat(123n, { user: { userId: 456, uniqueId: 'viewer' }, comment: '  !QUEUE  ' })), { platform: 'tiktok', eventId: '123', viewerId: '456', viewerName: 'viewer', query: '!QUEUE' });
  assert.equal(normalizeMessage(chat('1', { user: { userId: '2' }, comment: '!song' })).viewerName, '2');
  assert.equal(normalizeMessage(chat('1', { user: { userId: '2', nickname: '\0A\x7fB\r' } })).viewerName, 'AB');
  assert.equal(normalizeMessage(chat('1', { user: { userId: '2', nickname: 'x'.repeat(1000) } })).viewerName.length, 80);
  for (const data of [null, {}, [], chat('0'), chat('x'), chat('1'.repeat(65)), chat(1.5), chat(Number.MAX_SAFE_INTEGER + 1), chat('1', { user: {} }), chat('1', { user: { userId: 1.2 } }), chat('1', { comment: 'hello' }), chat('1', { comment: '!srequest Song' }), chat('1', { comment: '!sr a\nb' }), chat('1', { comment: '!sr ' + 'x'.repeat(253) })]) assert.equal(normalizeMessage(data), null);
  for (const command of ['!queue', '!song', '!sr Song', '!vote Song', '!SR Song']) assert.equal(normalizeMessage(chat('1', { comment: command })).query, command);
});

test('pinned connector v3 protobuf chat dispatch preserves numeric identity and command content', async t => {
  // Exercise the real dependency's protobuf decoder and event dispatcher without
  // calling its network connect(), rather than mirroring a guessed SDK payload.
  const { TikTokLiveConnection, WebcastChatMessage, CommonMessageData, User } = await import('tiktok-live-connector');
  const input = { ...WebcastChatMessage.decode(new Uint8Array()),
    common: { ...CommonMessageData.decode(new Uint8Array()), msgId: '9007199254740993123' },
    user: { ...User.decode(new Uint8Array()), id: '9007199254740993456', displayId: 'viewer_handle', nickname: 'Real Viewer' },
    content: '!sr Artist Song' };
  const decoded = WebcastChatMessage.decode(WebcastChatMessage.encode(input).finish());
  assert.equal(decoded.comment, undefined); assert.equal(decoded.user.userId, undefined);
  const client = new TikTokLiveConnection('fixturecreator', { processInitialData: false });
  client.connect = async () => { client.emit('connected'); return { isConnected: true }; };
  const f = fixture(t, { client });
  await f.service.setReceiving(true); await f.service.connect({ username: 'fixturecreator' });
  await client.processDecodedData({ type: 'WebcastChatMessage', data: decoded });
  assert.deepEqual(f.messages, [{ platform: 'tiktok', eventId: '9007199254740993123', viewerId: '9007199254740993456', viewerName: 'Real Viewer', query: '!sr Artist Song' }]);
  decoded.user.nickname = '';
  assert.equal(normalizeMessage(decoded).viewerName, 'viewer_handle');
  decoded.user.id = '0';
  assert.equal(normalizeMessage(decoded), null);
});

test('actual signing requests use a bounded anonymous client independent of inherited SDK globals', async () => {
  const { SignConfig } = await import('tiktok-live-connector');
  const inherited = { ...SignConfig }, controller = new AbortController();
  try {
    SignConfig.basePath = 'https://untrusted.fixture.invalid';
    SignConfig.apiKey = 'private-inherited-sign-key';
    const client = await createDefaultConnection('fixturecreator', { processInitialData: false,
      authenticateWs: false, useMobile: false, webClientOptions: { signal: controller.signal }, wsClientOptions: { signal: controller.signal } });
    let request;
    client.apiClient.rooms.axios = { defaults: {}, request: async config => { request = config; return { status: 401, data: {} }; } };
    await client.apiClient.rooms.fetchWebcastURL('123', 'ttlive-node');
    assert.equal(new URL(request.url).origin, 'https://api.eulerstream.com');
    assert.equal(request.timeout, 10000); assert.equal(request.maxRedirects, 0);
    assert.equal(request.maxContentLength, 1024 * 1024); assert.equal(request.maxBodyLength, 64 * 1024);
    assert.equal(request.signal, controller.signal);
    const serialized = JSON.stringify(request);
    for (const privateValue of ['private-inherited-sign-key', 'untrusted.fixture.invalid', 'sessionid', 'tt-target-idc']) assert.equal(serialized.includes(privateValue), false);
    assert.equal(Object.keys(request.headers).some(key => /^(?:authorization|cookie|x-api-key)$/i.test(key)), false);
    assert.equal(client.options.authenticateWs, false); assert.equal(client.options.useMobile, false);
    controller.abort(); assert.equal(request.signal.aborted, true);
    await client.disconnect();
    const cancelled = await createDefaultConnection('fixturecreator', { processInitialData: false,
      authenticateWs: false, useMobile: false, webClientOptions: { signal: controller.signal }, wsClientOptions: { signal: controller.signal } });
    // Real Axios rejects before any transport is dispatched when the host has
    // cancelled reception, including a sign request created after cancellation.
    await assert.rejects(cancelled.apiClient.rooms.fetchWebcastURL('123', 'ttlive-node'), cause => cause.code === 'ERR_CANCELED');
    await cancelled.disconnect();
  } finally {
    for (const key of Object.keys(SignConfig)) delete SignConfig[key];
    Object.assign(SignConfig, inherited);
  }
});

test('choosing a handle while reception is off does not instantiate a network client', async t => {
  const f = fixture(t);
  assert.deepEqual(f.service.status(), { state: 'disconnected', displayName: null, error: null, canReply: false });
  assert.deepEqual(await f.service.connect({ username: '@Creator' }), { state: 'disconnected', displayName: '@creator', error: null, canReply: false });
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.sendReply, undefined);
  await f.service.stop();
  assert.equal(f.service.status().displayName, '@creator');
});

test('enabling reception creates an anonymous client with history disabled and bounded network options', async t => {
  const f = fixture(t);
  await f.service.connect({ username: '@Creator' });
  assert.equal((await f.service.setReceiving(true)).state, 'connected');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].username, 'creator');
  const signal = f.calls[0].config.webClientOptions.signal;
  assert.ok(signal instanceof AbortSignal); assert.equal(signal.aborted, false);
  assert.deepEqual(f.calls[0].config, { processInitialData: false, fetchRoomInfoOnConnect: true, enableExtendedGiftInfo: false, authenticateWs: false, useMobile: false, webClientOptions: { timeout: { request: 10000 }, retry: { limit: 0 }, signal }, wsClientOptions: { handshakeTimeout: 10000, maxPayload: 1024 * 1024, signal } });
  assert.equal(f.calls[0].config.session, undefined); assert.equal(f.calls[0].config.signApiKey, undefined);
  assert.deepEqual(f.statuses.map(s => s.state).slice(-2), ['connecting', 'connected']);
  assert.equal((await f.service.setReceiving(true)).state, 'connected'); assert.equal(f.calls.length, 1);
});

test('only connected current transport delivers deduplicated command envelopes', async t => {
  const pending = deferred(), client = new FakeClient({ pending }), f = fixture(t, { client });
  await f.service.setReceiving(true);
  const task = f.service.connect({ username: 'creator' }); await tick();
  client.emit('chat', chat('1')); assert.equal(f.messages.length, 0);
  pending.resolve(); await task;
  client.emit('chat', chat('1')); client.emit('chat', chat('1')); client.emit('chat', chat('2', { comment: 'hello' })); client.emit('chat', chat('3', { comment: '!queue' }));
  assert.deepEqual(f.messages.map(message => message.eventId), ['1', '3']);
  assert.equal(Object.hasOwn(f.messages[0], 'user'), false); assert.equal(Object.hasOwn(f.messages[0], 'common'), false);
  await f.service.stop(); client.emit('chat', chat('4')); assert.equal(f.messages.length, 2);
});

test('invalid handles never become provider URLs or disrupt an established transport', async t => {
  const f = fixture(t); await f.service.setReceiving(true); await f.service.connect({ username: 'creator' });
  const before = f.service.status();
  for (const username of ['https://evil.test/@a', 'a/b', '', null]) assert.equal((await f.service.connect({ username })).error, 'invalid_username');
  assert.deepEqual(f.service.status(), before); assert.equal(f.calls.length, 1); assert.equal(f.clients[0].disconnectCount, 0);
});

test('disabling reception retains the handle, closes the transport and excludes replay when resumed', async t => {
  const f = fixture(t); await f.service.setReceiving(true); await f.service.connect({ username: 'creator' });
  const first = f.clients[0]; first.emit('chat', chat('1'));
  assert.equal((await f.service.setReceiving(false)).state, 'disconnected');
  assert.equal(f.service.status().displayName, '@creator'); assert.equal(first.disconnectCount, 1); assert.equal(first.terminated, 1);
  await f.service.setReceiving(true);
  assert.equal(f.clients.length, 2); first.emit('chat', chat('2')); f.clients[1].emit('chat', chat('1')); f.clients[1].emit('chat', chat('3'));
  assert.deepEqual(f.messages.map(message => message.eventId), ['1', '3']);
});

test('disconnect forgets the account and never resumes it on later reception', async t => {
  const f = fixture(t); await f.service.setReceiving(true); await f.service.connect({ username: 'creator' });
  assert.deepEqual(await f.service.disconnect(), { state: 'disconnected', displayName: null, error: null, canReply: false });
  await f.service.setReceiving(true); assert.equal(f.calls.length, 1);
});

test('a changed handle fences the old provider and only the new account can supply commands', async t => {
  const f = fixture(t); await f.service.setReceiving(true); await f.service.connect({ username: 'first' }); const old = f.clients[0];
  await f.service.connect({ username: 'second' });
  old.emit('chat', chat('1')); old.emit('error', new Error('private old provider')); old.emit('disconnected');
  f.clients[1].emit('chat', chat('1'));
  assert.equal(f.service.status().displayName, '@second'); assert.equal(f.service.status().state, 'connected'); assert.equal(f.messages.length, 1); assert.equal(old.disconnectCount, 1);
});

test('stop resolves a pending connection immediately and closes any late success', async t => {
  const pending = deferred(), client = new FakeClient({ pending }), f = fixture(t, { client });
  await f.service.setReceiving(true); const task = f.service.connect({ username: 'creator' }); await tick();
  assert.equal(f.service.status().state, 'connecting'); await f.service.stop();
  assert.equal((await task).state, 'disconnected');
  assert.equal(f.calls[0].config.webClientOptions.signal.aborted, true);
  assert.equal(f.calls[0].config.wsClientOptions.signal.aborted, true);
  pending.resolve(); await tick(); client.emit('chat', chat('1')); client.emit('error', new Error('late failure'));
  assert.equal(f.service.status().state, 'disconnected'); assert.equal(f.messages.length, 0); assert.ok(client.disconnectCount >= 2);
});

test('stop before asynchronous provider loading returns cannot open that provider', async t => {
  const loading = deferred(), client = new FakeClient(), f = fixture(t, { createConnection: () => loading.promise });
  await f.service.setReceiving(true); const task = f.service.connect({ username: 'creator' });
  await f.service.stop(); await task; loading.resolve(client); await tick();
  assert.equal(client.connectCount, 0); assert.equal(client.disconnectCount, 1); assert.equal(f.service.status().state, 'disconnected');
});

test('provider exceptions are reduced to stable local codes without leaking their content', async t => {
  class UserOfflineError extends Error {} class SignatureRateLimitError extends Error {} class ConnectTimeoutError extends Error {}
  const cases = [[new UserOfflineError('private URL'), 'not_live'], [new SignatureRateLimitError('private key'), 'rate_limited'], [new ConnectTimeoutError('private path'), 'connection_timeout'], [Object.assign(new Error('private module path'), { code: 'ERR_MODULE_NOT_FOUND' }), 'provider_unavailable'], [new Error('private response and token'), 'connection_failed']];
  for (const [failure, expected] of cases) {
    const f = fixture(t, { client: new FakeClient({ failure }) }); await f.service.setReceiving(true); const result = await f.service.connect({ username: 'creator' });
    assert.equal(result.state, 'error'); assert.equal(result.error, expected); assert.equal(JSON.stringify(f.statuses).includes('private'), false); assert.equal(f.clients[0].disconnectCount, 1);
  }
});

test('connection timeout settles even a hung provider, with no reconnect loop', async t => {
  const pending = deferred(), client = new FakeClient({ pending }), f = fixture(t, { client, connectTimeoutMs: 10 });
  await f.service.setReceiving(true); const result = await f.service.connect({ username: 'creator' });
  assert.equal(result.state, 'error'); assert.equal(result.error, 'connection_timeout'); assert.equal(f.calls.length, 1);
  pending.resolve(); await tick(); assert.equal(f.service.status().state, 'error'); assert.equal(f.calls.length, 1);
});

test('live end and disconnect become explicit retryable statuses without automatic network requests', async t => {
  const f = fixture(t); await f.service.setReceiving(true); await f.service.connect({ username: 'creator' });
  f.clients[0].emit('streamEnd', { action: 3 }); assert.equal(f.service.status().error, 'not_live'); await tick(); assert.equal(f.calls.length, 1);
  await f.service.connect({ username: 'creator' }); f.clients[1].emit('disconnected', { reason: 'private provider data' });
  assert.equal(f.service.status().error, 'connection_closed'); assert.equal(f.service.status().displayName, '@creator');
});

test('readiness from the provider connect promise is supported without a connected event', async t => {
  const f = fixture(t, { client: new FakeClient({ emitConnected: false }) }); await f.service.setReceiving(true);
  assert.equal((await f.service.connect({ username: 'creator' })).state, 'connected');
});

test('host callbacks cannot cause uncaught provider failures or alter authoritative status', async t => {
  const f = fixture(t, { onMessage: async () => { throw new Error('host command failure'); }, onStatus: status => { status.state = 'modified'; throw new Error('host render failure'); } });
  await f.service.setReceiving(true); await f.service.connect({ username: 'creator' }); f.clients[0].emit('chat', chat('1')); await tick();
  const status = f.service.status(); status.displayName = 'modified'; assert.equal(f.service.status().state, 'connected'); assert.equal(f.service.status().displayName, '@creator');
});

test('deduplication storage stays bounded while filtering recent repeated messages', async t => {
  const f = fixture(t); await f.service.setReceiving(true); await f.service.connect({ username: 'creator' }); const client = f.clients[0];
  for (let i = 1; i <= 1001; i += 1) client.emit('chat', chat(String(i)));
  client.emit('chat', chat('1001')); assert.equal(f.messages.length, 1001);
  client.emit('chat', chat('1')); assert.equal(f.messages.length, 1002);
});
