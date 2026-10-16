'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTwitchSongRequestConnection } = require('../companion/song-request-twitch.cjs');

const CLIENT = 'fixtureclient', USER = '123';
const SCOPES = ['user:read:chat', 'user:write:chat'];
const OLD_ACCESS = 'fixture-old-access', OLD_REFRESH = 'fixture-old-refresh';
const NEW_ACCESS = 'fixture-new-access', NEW_REFRESH = 'fixture-new-refresh';
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const flush = async () => { for (let i = 0; i < 4; ++i) await new Promise(resolve => setImmediate(resolve)); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function clock() {
  let value = 1000000;
  const tasks = new Set();
  return {
    now: () => value,
    sleep: (milliseconds, signal) => new Promise((resolve, reject) => {
      const task = { at: value + milliseconds, resolve: () => { tasks.delete(task); signal.removeEventListener('abort', abort); resolve(); } };
      const abort = () => { tasks.delete(task); signal.removeEventListener('abort', abort); reject(Error('cancelled')); };
      if (signal.aborted) return abort();
      tasks.add(task); signal.addEventListener('abort', abort, { once: true });
    }),
    advance: async milliseconds => {
      value += milliseconds;
      for (const task of [...tasks]) if (task.at <= value) task.resolve();
      await flush();
    },
    pending: () => tasks.size
  };
}
const credential = () => ({ clientId: CLIENT, accessToken: OLD_ACCESS, refreshToken: OLD_REFRESH,
  expiresAt: 1000000 + 3600000, userId: USER, login: 'broadcaster', displayName: 'Broadcaster', scopes: [...SCOPES] });
const validation = (extra = {}) => ({ client_id: CLIENT, user_id: USER, login: 'broadcaster', scopes: [...SCOPES], expires_in: 3600, ...extra });
const tokens = (extra = {}) => ({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 3600, scope: [...SCOPES], ...extra });
const device = (extra = {}) => ({ device_code: 'private-device-code', user_code: 'ABCD1234', expires_in: 600, interval: 1,
  verification_uri: 'https://www.twitch.tv/activate?public=true&device-code=ABCD1234', ...extra });
function welcome(socket, session = 'fixture-session', seconds = 10) {
  socket.frame({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: session, status: 'connected', keepalive_timeout_seconds: seconds } } });
}
function notice(extra = {}) {
  return { metadata: { message_type: 'notification', subscription_type: 'channel.chat.message', subscription_version: '1' }, payload: {
    subscription: { type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: USER, user_id: USER } },
    event: { broadcaster_user_id: USER, chatter_user_id: '456', chatter_user_name: 'Viewer', message_id: 'fixture-message-id', message: { text: '!queue' }, ...extra }
  } };
}
async function fixture(t, options = {}) {
  const time = clock(), requests = [], states = [], messages = [], sockets = [], opened = [], writes = [];
  let stored = options.stored === undefined ? credential() : structuredClone(options.stored), reads = 0;
  const fetcher = async (url, init) => {
    const request = { url, init, form: typeof init.body === 'string' && init.headers?.['Content-Type'] === 'application/x-www-form-urlencoded' ? new URLSearchParams(init.body) : null,
      body: typeof init.body === 'string' && init.headers?.['Content-Type'] === 'application/json' ? JSON.parse(init.body) : null };
    requests.push(request);
    const result = await options.handle?.(request);
    if (result !== undefined) return result;
    if (url === 'https://id.twitch.tv/oauth2/validate') return json(validation());
    if (url === 'https://id.twitch.tv/oauth2/device') return json(device());
    if (url === 'https://id.twitch.tv/oauth2/token') return json(tokens());
    if (url === 'https://api.twitch.tv/helix/eventsub/subscriptions') return json({ data: [{ ...request.body, status: 'enabled', id: 'fixture-subscription' }] }, 202);
    if (url === 'https://api.twitch.tv/helix/chat/messages') return json({ data: [{ is_sent: true, message_id: 'fixture-reply-id', drop_reason: null }] });
    assert.fail(`Unexpected offline test URL: ${url}`);
  };
  class Socket extends EventEmitter {
    constructor(url) { super(); this.url = url; this.closed = false; sockets.push(this); }
    close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
    frame(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
  }
  const provider = createTwitchSongRequestConnection({ clientId: options.clientId === undefined ? CLIENT : options.clientId,
    accountStore: {
      get: async platform => { assert.equal(platform, 'twitch'); ++reads; if (options.getError) throw Error('PRIVATE account path'); return structuredClone(stored); },
      set: async (platform, value) => { assert.equal(platform, 'twitch'); if (options.setError) throw Error('PRIVATE account path');
        await options.beforeWrite?.(value); writes.push(structuredClone(value)); stored = structuredClone(value); }
    },
    openExternal: async url => { opened.push(url); await options.openExternal?.(url); }, fetch: fetcher,
    createWebSocket: options.createWebSocket ?? (url => new Socket(url)), now: time.now, sleep: time.sleep,
    onStatus: state => states.push(state), onMessage: message => { messages.push(message); return options.onMessage?.(message); }
  });
  t.after(async () => { await provider.stop(); await flush(); assert.equal(time.pending(), 0); });
  return { provider, time, requests, states, messages, sockets, opened, writes, stored: () => structuredClone(stored), reads: () => reads,
    byPath: path => requests.filter(row => new URL(row.url).pathname === path) };
}
async function connectChat(f) {
  await f.provider.connect(); await f.provider.setReceiving(true);
  assert.equal(f.sockets.length, 1); welcome(f.sockets[0]); await flush();
  assert.equal(f.provider.status().state, 'connected');
  return f.sockets[0];
}

test('construct/load performs no account read or network; missing app registration is a stable setup error', async t => {
  const f = await fixture(t, { clientId: '' });
  assert.deepEqual(f.provider.status(), { state: 'disconnected', displayName: null, error: null });
  await f.provider.setReceiving(true); await flush();
  assert.equal(f.reads(), 0); assert.equal(f.requests.length, 0); assert.equal(f.sockets.length, 0);
  assert.equal((await f.provider.connect()).error, 'setup_required');
  assert.equal(f.requests.length, 0); assert.equal(f.opened.length, 0);
});

test('stored broadcaster authorization is validated, but no chat socket or POST is created until receiving is enabled', async t => {
  const f = await fixture(t);
  const state = await f.provider.connect();
  assert.equal(state.state, 'connected'); assert.equal(state.displayName, 'Broadcaster');
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, 'https://id.twitch.tv/oauth2/validate');
  assert.equal(f.requests[0].init.headers.Authorization, `OAuth ${OLD_ACCESS}`);
  assert.equal(f.sockets.length, 0); assert.equal(f.opened.length, 0);
  assert.deepEqual(await f.provider.sendReply('Hello'), { ok: false, code: 'disconnected' });
  assert.equal(f.byPath('/helix/chat/messages').length, 0);
  await f.provider.setReceiving(true); assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].url, 'wss://eventsub.wss.twitch.tv/ws');
  welcome(f.sockets[0]); await flush();
  const subscription = f.byPath('/helix/eventsub/subscriptions')[0];
  assert.deepEqual(subscription.body, { type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: USER, user_id: USER },
    transport: { method: 'websocket', session_id: 'fixture-session' } });
  assert.equal(subscription.init.redirect, 'error'); assert.equal(subscription.init.headers['Client-Id'], CLIENT);
  await f.provider.setReceiving(false); assert.equal(f.sockets[0].closed, true); assert.equal(f.provider.status().state, 'connected');
  assert.ok(f.stored().accessToken); assert.equal(f.opened.length, 0);
});

test('device authorization polls pending/slow_down at the requested interval and saves only validated credentials', async t => {
  let polls = 0;
  const f = await fixture(t, { stored: null, handle: request => {
    if (request.form?.get('device_code')) {
      ++polls;
      if (polls === 1) return json({ error: 'authorization_pending' }, 400);
      if (polls === 2) return json({ error: 'slow_down' }, 400);
    }
  } });
  const pending = f.provider.connect(); await flush();
  assert.equal(f.provider.status().state, 'authorizing'); assert.equal(f.provider.status().userCode, 'ABCD1234');
  assert.deepEqual(f.opened, [device().verification_uri]);
  await f.time.advance(1000); assert.equal(polls, 1);
  await f.time.advance(1000); assert.equal(polls, 2);
  await f.time.advance(5000); assert.equal(polls, 2);
  await f.time.advance(1000);
  assert.equal((await pending).state, 'connected'); assert.equal(polls, 3);
  assert.equal(f.stored().accessToken, NEW_ACCESS); assert.equal(f.stored().refreshToken, NEW_REFRESH);
  assert.equal(f.stored().userId, USER); assert.equal(f.sockets.length, 0);
  assert.equal(f.byPath('/oauth2/device')[0].form.get('scopes'), SCOPES.join(' '));
  const snapshot = JSON.stringify(f.states);
  for (const secret of [OLD_ACCESS, OLD_REFRESH, NEW_ACCESS, NEW_REFRESH, 'private-device-code']) assert.ok(!snapshot.includes(secret));
  assert.ok(!snapshot.includes('accessToken')); assert.equal(f.provider.status().verificationUrl, undefined);
});

test('Twitch documented message-field pending responses keep device authorization open', async t => {
  let polls = 0;
  const f = await fixture(t, { stored: null, handle: request => {
    if (request.form?.get('device_code') && ++polls === 1) return json({ status: 400, message: 'authorization_pending' }, 400);
  } });
  const pending = f.provider.connect(); await flush(); await f.time.advance(1000);
  assert.equal(f.provider.status().state, 'authorizing'); assert.equal(polls, 1); assert.equal(f.writes.length, 0);
  await f.time.advance(1000); assert.equal((await pending).state, 'connected'); assert.equal(polls, 2);
  assert.equal(f.stored().accessToken, NEW_ACCESS);
});

test('malicious verification URIs and mismatched activation codes are never opened', async t => {
  for (const verification_uri of ['https://evil.example/activate', 'https://www.twitch.tv.evil.example/activate',
    'http://www.twitch.tv/activate', 'https://user:password@www.twitch.tv/activate', 'https://www.twitch.tv:444/activate',
    'https://www.twitch.tv/activate?device-code=OTHER', 'https://www.twitch.tv/activate?redirect=https://evil.example',
    'https://www.twitch.tv/activate#secret']) {
    await t.test(verification_uri, async t => {
      const f = await fixture(t, { stored: null, handle: request => request.url.endsWith('/device') ? json(device({ verification_uri })) : undefined });
      const state = await f.provider.connect(); assert.equal(state.state, 'error'); assert.equal(state.error, 'auth_invalid');
      assert.equal(f.opened.length, 0); assert.equal(f.byPath('/oauth2/token').length, 0); assert.equal(f.writes.length, 0);
    });
  }
});

test('denied consent, expired device codes and missing scopes never become connected accounts', async t => {
  for (const [body, status, code] of [[{ error: 'access_denied' }, 400, 'auth_denied'], [{ error: 'expired_token' }, 400, 'auth_expired'],
    [{ status: 400, message: 'invalid device code' }, 400, 'auth_expired'], [{ status: 400, message: 'access_denied' }, 400, 'auth_denied'],
    [{ status: 400, message: 'PRIVATE provider token detail' }, 400, 'auth_invalid'],
    [tokens({ scope: ['user:read:chat'] }), 200, 'auth_invalid']]) {
    await t.test(code, async t => {
      const f = await fixture(t, { stored: null, handle: request => request.form?.get('device_code') ? json(body, status) : undefined });
      const pending = f.provider.connect(); await flush(); await f.time.advance(1000);
      assert.equal((await pending).error, code); assert.equal(f.stored(), null); assert.equal(f.sockets.length, 0);
    });
  }
});

test('stop cancels pending consent and ignores an HTTP result from a fetch implementation that disregards abort', async t => {
  const gate = deferred();
  const f = await fixture(t, { stored: null, handle: request => request.form?.get('device_code') ? gate.promise : undefined });
  const pending = f.provider.connect(); await flush(); await f.time.advance(1000);
  assert.equal(f.byPath('/oauth2/token').length, 1);
  await f.provider.stop(); assert.equal((await pending).state, 'disconnected');
  assert.equal(f.byPath('/oauth2/token')[0].init.signal.aborted, true);
  gate.resolve(json(tokens())); await flush();
  assert.equal(f.writes.length, 0); assert.equal(f.stored(), null); assert.equal(f.sockets.length, 0);
  assert.equal(f.provider.status().state, 'disconnected');
});

test('expired stored access is refreshed once, rotated and validated against the same account', async t => {
  const f = await fixture(t, { handle: request => request.url.endsWith('/validate') && request.init.headers.Authorization.includes(OLD_ACCESS)
    ? json({ message: 'PRIVATE provider token detail' }, 401) : undefined });
  const pending = f.provider.connect(); assert.equal(f.provider.connect(), pending);
  assert.equal((await pending).state, 'connected');
  const refresh = f.byPath('/oauth2/token'); assert.equal(refresh.length, 1);
  assert.equal(refresh[0].form.get('refresh_token'), OLD_REFRESH); assert.equal(refresh[0].form.has('client_secret'), false);
  assert.equal(f.stored().refreshToken, NEW_REFRESH); assert.equal(f.byPath('/oauth2/validate').length, 2);
  assert.equal(f.sockets.length, 0); assert.equal(f.opened.length, 0);
});

test('a refreshed token that belongs to a different Twitch user is refused', async t => {
  const f = await fixture(t, { handle: request => {
    if (request.url.endsWith('/validate')) return request.init.headers.Authorization.includes(OLD_ACCESS)
      ? json({ status: 401 }, 401) : json(validation({ user_id: '999' }));
  } });
  assert.equal((await f.provider.connect()).error, 'auth_invalid');
  assert.equal(f.writes.length, 0); assert.equal(f.opened.length, 0); assert.equal(f.sockets.length, 0);
});

test('EventSub normalizes authorized messages, ignores foreign/malformed messages and de-duplicates repeats', async t => {
  const f = await fixture(t), socket = await connectChat(f);
  socket.frame(notice()); socket.frame(notice());
  socket.frame(notice({ message_id: 'foreign', broadcaster_user_id: '999' }));
  socket.frame(notice({ message_id: 'bad-user', chatter_user_id: 'not-numeric' }));
  socket.frame(notice({ message_id: 'bad-control', message: { text: '!queue\u0000' } }));
  const wrongSub = notice({ message_id: 'wrong-sub' }); wrongSub.payload.subscription.condition.user_id = '999'; socket.frame(wrongSub);
  await flush();
  assert.deepEqual(f.messages, [{ platform: 'twitch', eventId: 'fixture-message-id', viewerId: '456', viewerName: 'Viewer', query: '!queue' }]);
  assert.ok(!JSON.stringify(f.states).includes(OLD_ACCESS));
});

test('notifications excluded by command validation still keep the EventSub transport healthy', async t => {
  const f = await fixture(t), socket = await connectChat(f);
  await f.time.advance(9000);
  socket.frame(notice({ message: { text: '🎵'.repeat(500) } })); await flush();
  assert.equal(f.messages.length, 0);
  await f.time.advance(9000);
  assert.equal(socket.closed, false); assert.equal(f.sockets.length, 1);
  assert.equal(f.provider.status().state, 'connected');
});

test('slow queue/reply handling does not block keepalives or authorization revocation', async t => {
  const gate = deferred(), f = await fixture(t, { onMessage: () => gate.promise }), socket = await connectChat(f);
  socket.frame(notice()); await flush(); assert.equal(f.messages.length, 1);
  socket.frame({ metadata: { message_type: 'revocation' }, payload: { subscription: { type: 'channel.chat.message',
    condition: { broadcaster_user_id: USER, user_id: USER }, status: 'authorization_revoked' } } });
  await flush();
  assert.equal(f.provider.status().state, 'error'); assert.equal(f.provider.status().error, 'auth_revoked');
  assert.equal(f.stored(), null); assert.equal(socket.closed, true);
  socket.frame(notice({ message_id: 'stale' })); gate.resolve(); await flush(); assert.equal(f.messages.length, 1);
});

test('disabling reception fences old socket callbacks and stop retains credentials while disconnect forgets them', async t => {
  const f = await fixture(t), old = await connectChat(f);
  await f.provider.setReceiving(false); old.frame(notice()); await flush(); assert.equal(f.messages.length, 0);
  await f.provider.setReceiving(true); const next = f.sockets[1]; welcome(next, 'next-session'); await flush();
  old.frame(notice({ message_id: 'late-old' })); next.frame(notice({ message_id: 'next' })); await flush();
  assert.deepEqual(f.messages.map(row => row.eventId), ['next']);
  await f.provider.stop(); assert.equal(next.closed, true); assert.equal(f.stored().refreshToken, OLD_REFRESH);
  assert.equal(f.provider.status().state, 'disconnected');
  await f.provider.disconnect(); assert.equal(f.stored(), null); assert.equal(f.provider.status().displayName, null);
  assert.equal(f.byPath('/oauth2/revoke').length, 0);
});

test('a pending subscription result cannot reactivate reception after it was turned off', async t => {
  const gate = deferred();
  const f = await fixture(t, { handle: request => request.url.endsWith('/eventsub/subscriptions') ? gate.promise : undefined });
  await f.provider.connect(); await f.provider.setReceiving(true); welcome(f.sockets[0]); await flush();
  await f.provider.setReceiving(false);
  gate.resolve(json({ data: [{ type: 'channel.chat.message', version: '1', status: 'enabled', condition: { broadcaster_user_id: USER, user_id: USER },
    transport: { method: 'websocket', session_id: 'fixture-session' } }] }, 202));
  f.sockets[0].frame(notice()); await flush();
  assert.equal(f.messages.length, 0); assert.equal(f.provider.status().state, 'connected'); assert.equal(f.sockets.length, 1);
});

test('server reconnect hands over only to the Twitch allowlist and does not duplicate subscriptions', async t => {
  const f = await fixture(t), old = await connectChat(f);
  const target = 'wss://eventsub.wss.twitch.tv/ws?session=fixture';
  old.frame({ metadata: { message_type: 'session_reconnect' }, payload: { session: { reconnect_url: target } } }); await flush();
  assert.equal(f.sockets.length, 2); assert.equal(f.sockets[1].url, target); assert.equal(old.closed, false);
  old.frame(notice({ message_id: 'during-handoff' })); await flush();
  welcome(f.sockets[1], 'handoff-session'); await flush(); assert.equal(old.closed, true);
  assert.equal(f.byPath('/helix/eventsub/subscriptions').length, 1);
  old.frame(notice({ message_id: 'stale-old' })); f.sockets[1].frame(notice({ message_id: 'new-socket' })); await flush();
  assert.deepEqual(f.messages.map(row => row.eventId), ['during-handoff', 'new-socket']);
  f.sockets[1].frame({ metadata: { message_type: 'session_reconnect' }, payload: { session: { reconnect_url: 'wss://evil.example/ws' } } }); await flush();
  assert.equal(f.sockets.length, 2); assert.equal(f.provider.status().error, 'reconnect_invalid'); assert.equal(f.sockets[1].closed, true);
});

test('keepalive timeout reconnects with bounded delay; stopping cancels scheduled attempts', async t => {
  const f = await fixture(t), old = await connectChat(f);
  await f.time.advance(9000);
  old.frame({ metadata: { message_type: 'session_keepalive' }, payload: {} }); await flush();
  await f.time.advance(1000); assert.equal(old.closed, false);
  await f.time.advance(9000); assert.equal(old.closed, true); assert.equal(f.sockets.length, 1);
  await f.time.advance(999); assert.equal(f.sockets.length, 1);
  await f.time.advance(1); assert.equal(f.sockets.length, 2);
  f.sockets[1].emit('error', Error('PRIVATE socket error'));
  await f.provider.stop(); await f.time.advance(30000); assert.equal(f.sockets.length, 2);
  assert.equal(f.provider.status().state, 'disconnected'); assert.ok(!JSON.stringify(f.states).includes('PRIVATE'));
});

test('hourly validation while active refreshes the session and never opens chat after reception is disabled', async t => {
  let validations = 0;
  const f = await fixture(t, { handle: request => {
    if (request.url.endsWith('/validate') && ++validations === 2) return json({ message: 'expired' }, 401);
  } });
  await f.provider.connect();
  await f.time.advance(3600000);
  assert.equal(f.byPath('/oauth2/validate').length, 3); assert.equal(f.byPath('/oauth2/token').length, 1);
  assert.equal(f.stored().refreshToken, NEW_REFRESH); assert.equal(f.sockets.length, 0); assert.equal(f.opened.length, 0);
  await f.provider.stop(); const count = f.requests.length; await f.time.advance(3600000); assert.equal(f.requests.length, count);
});

test('chat writes enforce 500 Unicode characters and verify Twitch delivery rather than trusting HTTP 200', async t => {
  let writes = 0;
  const f = await fixture(t, { handle: request => {
    if (request.url.endsWith('/chat/messages') && ++writes === 2) return json({ data: [{ is_sent: false, message_id: '', drop_reason: { message: 'PRIVATE reason' } }] });
  } });
  await connectChat(f);
  for (const message of ['', ' ', 'x'.repeat(501), 'line\nline', '\u202eHello']) assert.equal((await f.provider.sendReply(message)).code, 'invalid_message');
  assert.equal(writes, 0);
  assert.deepEqual(await f.provider.sendReply('🎵'.repeat(500)), { ok: true });
  const sent = f.byPath('/helix/chat/messages')[0];
  assert.equal(sent.body.broadcaster_id, USER); assert.equal(sent.body.sender_id, USER); assert.equal(Array.from(sent.body.message).length, 500);
  assert.deepEqual(await f.provider.sendReply('Other reply'), { ok: false, code: 'chat_rejected' });
  assert.equal(writes, 2); assert.ok(!JSON.stringify(f.states).includes('PRIVATE'));
});

test('concurrent unauthorized sends serialize refresh and never replay either chat POST', async t => {
  const gate = deferred();
  const f = await fixture(t, { handle: request => {
    if (request.url.endsWith('/chat/messages')) return json({ message: 'PRIVATE token detail' }, 401);
    if (request.form?.get('grant_type') === 'refresh_token') return gate.promise;
  } });
  await connectChat(f);
  const a = f.provider.sendReply('first'), b = f.provider.sendReply('second'); await flush();
  assert.equal(f.byPath('/oauth2/token').length, 1); gate.resolve(json(tokens()));
  assert.deepEqual(await Promise.all([a, b]), [{ ok: false, code: 'auth_expired' }, { ok: false, code: 'auth_expired' }]);
  assert.equal(f.byPath('/helix/chat/messages').length, 2); assert.equal(f.stored().refreshToken, NEW_REFRESH);
});

test('response bodies and errors are bounded and sanitized before reaching owner status', async t => {
  for (const mode of ['oversized', 'wrong-type', 'fetch-error', 'invalid-scope', 'invalid-client']) {
    await t.test(mode, async t => {
      const f = await fixture(t, { handle: request => {
        if (!request.url.endsWith('/validate')) return;
        if (mode === 'oversized') return json({ private: 'x'.repeat(128 * 1024) });
        if (mode === 'wrong-type') return new Response('PRIVATE token page', { headers: { 'Content-Type': 'text/html' } });
        if (mode === 'fetch-error') throw Error(`PRIVATE ${OLD_ACCESS} C:/private/account`);
        if (mode === 'invalid-scope') return json(validation({ scopes: ['user:read:chat'] }));
        if (mode === 'invalid-client') return json(validation({ client_id: 'otherclient' }));
      } });
      const pending = f.provider.connect(); await flush();
      // Invalid previously stored authorization requests a fresh consent; cancel that operation.
      if (f.provider.status().state === 'authorizing') await f.provider.stop();
      const state = await pending;
      assert.notEqual(state.state, 'connected'); assert.equal(f.sockets.length, 0);
      assert.ok(!JSON.stringify(f.states).includes('PRIVATE')); assert.ok(!JSON.stringify(f.states).includes(OLD_ACCESS));
    });
  }
});

test('account persistence failures stop authorization without opening a chat transport', async t => {
  const f = await fixture(t, { getError: true });
  assert.equal((await f.provider.connect()).error, 'storage_error'); assert.equal(f.requests.length, 0);
  const other = await fixture(t, { setError: true });
  assert.equal((await other.provider.connect()).error, 'storage_error');
  assert.equal(other.sockets.length, 0); assert.ok(!JSON.stringify(other.states).includes('PRIVATE'));
});

test('revocation closes chat before a slow credential deletion and cannot process later frames', async t => {
  const gate = deferred();
  const f = await fixture(t, { beforeWrite: value => value === null ? gate.promise : undefined }), socket = await connectChat(f);
  socket.frame({ metadata: { message_type: 'revocation' }, payload: { subscription: { type: 'channel.chat.message',
    condition: { broadcaster_user_id: USER, user_id: USER }, status: 'authorization_revoked' } } });
  await flush();
  assert.equal(socket.closed, true); assert.equal(f.provider.status().error, 'auth_revoked');
  assert.deepEqual(await f.provider.sendReply('Too late'), { ok: false, code: 'disconnected' });
  socket.frame(notice({ message_id: 'late-before-disk' })); await flush(); assert.equal(f.messages.length, 0);
  gate.resolve(); await flush(); assert.equal(f.stored(), null);
});

test('an old hourly validation cannot replace freshly rotated credentials in memory', async t => {
  const gate = deferred(); let checks = 0, posts = 0;
  const f = await fixture(t, { handle: request => {
    if (request.url.endsWith('/validate') && ++checks === 2) return gate.promise;
    if (request.url.endsWith('/chat/messages') && ++posts === 1) return json({ message: 'expired' }, 401);
  } });
  await connectChat(f);
  // The local chat transport is stopped during the hourly check, then restarted for the send race.
  await f.provider.setReceiving(false); await f.time.advance(3600000);
  assert.equal(checks, 2);
  await f.provider.setReceiving(true); welcome(f.sockets[1], 'race-session'); await flush();
  assert.equal((await f.provider.sendReply('rotate')).code, 'auth_expired'); assert.equal(f.stored().accessToken, NEW_ACCESS);
  gate.resolve(json(validation({ expires_in: 100 }))); await flush();
  assert.deepEqual(await f.provider.sendReply('use-new-token'), { ok: true });
  const requests = f.byPath('/helix/chat/messages'); assert.equal(requests.length, 2);
  assert.equal(requests[1].init.headers.Authorization, `Bearer ${NEW_ACCESS}`);
  assert.equal(f.byPath('/oauth2/token').length, 1);
});

test('a delayed old-token 401 does not rotate the already refreshed token a second time', async t => {
  const gate = deferred(); let posts = 0;
  const f = await fixture(t, { handle: request => {
    if (request.url.endsWith('/chat/messages')) return ++posts === 1 ? json({ status: 401 }, 401) : gate.promise;
  } });
  await connectChat(f);
  const first = f.provider.sendReply('first'), late = f.provider.sendReply('late');
  assert.equal((await first).code, 'auth_expired'); assert.equal(f.stored().refreshToken, NEW_REFRESH);
  gate.resolve(json({ status: 401 }, 401)); assert.equal((await late).code, 'auth_expired');
  assert.equal(f.byPath('/oauth2/token').length, 1); assert.equal(posts, 2);
});

test('a connection after disconnect waits for deletion and a late disconnect cannot overwrite new authorization status', async t => {
  const gate = deferred();
  const f = await fixture(t, { beforeWrite: value => value === null ? gate.promise : undefined });
  await f.provider.connect();
  const disconnect = f.provider.disconnect(), pending = f.provider.connect(); await flush();
  assert.equal(f.reads(), 1); gate.resolve(); await disconnect; await flush();
  assert.equal(f.provider.status().state, 'authorizing'); assert.equal(f.reads(), 2);
  await f.time.advance(1000); assert.equal((await pending).state, 'connected'); assert.equal(f.stored().accessToken, NEW_ACCESS);
});

test('repeated socket creation failures stop after bounded reconnects without polling forever', async t => {
  let attempts = 0;
  const f = await fixture(t, { createWebSocket: () => { ++attempts; throw Error('PRIVATE endpoint failure'); } });
  await f.provider.connect(); await f.provider.setReceiving(true); assert.equal(attempts, 1);
  for (const delay of [1000, 2000, 4000, 8000, 16000]) await f.time.advance(delay);
  assert.equal(attempts, 6); assert.equal(f.provider.status().error, 'chat_unavailable');
  await f.time.advance(30000); assert.equal(attempts, 6); assert.equal(f.byPath('/helix/eventsub/subscriptions').length, 0);
  assert.ok(!JSON.stringify(f.states).includes('PRIVATE'));
});

test('hourly revocation forgets only the Twitch account and never starts a fresh consent automatically', async t => {
  let checks = 0;
  const f = await fixture(t, { handle: request => {
    if (request.url.endsWith('/validate') && ++checks > 1) return json({ message: 'revoked' }, 401);
    if (request.form?.get('grant_type') === 'refresh_token') return json({ error: 'invalid refresh token' }, 400);
  } });
  await f.provider.connect(); await f.time.advance(3600000);
  assert.equal(f.provider.status().error, 'auth_revoked'); assert.equal(f.stored(), null);
  assert.equal(f.byPath('/oauth2/device').length, 0); assert.equal(f.opened.length, 0);
});

test('a hung HTTP response is cancelled at the bounded request deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred(), f = await fixture(t, { handle: () => gate.promise });
  const pending = f.provider.connect(); await flush(); assert.equal(f.requests.length, 1);
  t.mock.timers.tick(15000); await flush();
  assert.equal((await pending).error, 'request_timeout'); assert.equal(f.requests[0].init.signal.aborted, true);
  gate.resolve(json(validation())); await flush(); assert.equal(f.writes.length, 0);
});
