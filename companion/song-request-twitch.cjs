'use strict';

const DEVICE_URL = 'https://id.twitch.tv/oauth2/device';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const HELIX = 'https://api.twitch.tv/helix';
const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
const SCOPES = ['user:read:chat', 'user:write:chat'];
const CONTROLS = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const MAX_RESPONSE = 128 * 1024;
const REQUEST_TIMEOUT = 15000;
const HOURLY = 60 * 60 * 1000;

function failure(code) { const error = Error(code); error.code = code; return error; }
function boundedString(value, maximum = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !CONTROLS.test(value);
}
function opaque(value, maximum = 4096) { return boundedString(value, maximum) && /^[\x21-\x7e]+$/.test(value); }
function numericId(value) { return typeof value === 'string' && /^\d{1,32}$/.test(value); }
function scopesValid(scopes) { return Array.isArray(scopes) && scopes.length <= 64 && SCOPES.every(scope => scopes.includes(scope)) && scopes.every(scope => opaque(scope, 128)); }
function copyAccount(account) { return account ? { ...account, scopes: [...account.scopes] } : null; }
function accountValid(account, clientId) {
  return account && typeof account === 'object' && !Array.isArray(account) && account.clientId === clientId
    && opaque(account.accessToken) && opaque(account.refreshToken) && Number.isSafeInteger(account.expiresAt) && account.expiresAt > 0
    && numericId(account.userId) && typeof account.login === 'string' && /^[a-z0-9_]{1,32}$/.test(account.login)
    && boundedString(account.displayName, 256) && scopesValid(account.scopes);
}
function abortableSleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(failure('cancelled'));
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(failure('cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    timer.unref?.(); signal?.addEventListener('abort', abort, { once: true });
  });
}
function verificationURL(value, userCode) {
  if (!boundedString(value, 2048)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'www.twitch.tv' || url.port || url.username || url.password
      || url.hash || url.pathname !== '/activate') return null;
    if ([...url.searchParams.keys()].some(key => !['public', 'device-code'].includes(key))
      || url.searchParams.getAll('public').length > 1 || url.searchParams.getAll('device-code').length > 1
      || (url.searchParams.has('public') && url.searchParams.get('public') !== 'true')
      || (url.searchParams.has('device-code') && url.searchParams.get('device-code') !== userCode)) return null;
    return url.href;
  } catch { return null; }
}
function reconnectURL(value) {
  if (!boundedString(value, 4096)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'wss:' && url.hostname === 'eventsub.wss.twitch.tv' && !url.port && !url.username && !url.password
      && !url.hash && ['/', '/ws'].includes(url.pathname) ? url.href : null;
  } catch { return null; }
}

/** Installed broadcaster bot: a public Twitch client, never a bundled client secret. */
function createTwitchSongRequestConnection({ clientId, accountStore, openExternal, fetch: fetcher = globalThis.fetch,
  createWebSocket = url => new (require('ws'))(url, { maxPayload: MAX_RESPONSE, handshakeTimeout: REQUEST_TIMEOUT }),
  now = Date.now, sleep = abortableSleep, onStatus, onMessage } = {}) {
  const configured = typeof clientId === 'string' && /^[a-zA-Z0-9]{1,128}$/.test(clientId)
    && typeof accountStore?.get === 'function' && typeof accountStore?.set === 'function'
    && typeof openExternal === 'function' && typeof fetcher === 'function' && typeof createWebSocket === 'function';
  let generation = 0, context = null, account = null, receiving = false, connectTask = null, storeSerial = Promise.resolve();
  let publicState = { state: 'disconnected', displayName: null, error: null };
  const status = () => ({ ...publicState });
  const active = ctx => context === ctx && !ctx.controller.signal.aborted;
  const streamActive = (ctx, stream) => active(ctx) && receiving && ctx.stream === stream && !stream.controller.signal.aborted;
  function publish(state, error = null, extra = {}) {
    publicState = { state, displayName: account?.displayName ?? null, error, ...extra };
    try { onStatus?.(status()); } catch {}
    return status();
  }
  function cancelChannel(channel) {
    if (!channel || channel.cancelled) return;
    channel.cancelled = true; channel.controller.abort();
    try { channel.socket.close(); } catch {}
  }
  function stopStream(ctx) {
    const stream = ctx?.stream;
    if (!stream) return;
    ctx.stream = null; stream.controller.abort();
    cancelChannel(stream.current); cancelChannel(stream.pending); stream.current = stream.pending = null;
  }
  function cancelContext() {
    const previous = context; context = null; ++generation;
    if (previous) { previous.controller.abort(); stopStream(previous); }
    connectTask = null;
  }
  function ensure(ctx) { if (!active(ctx)) throw failure('cancelled'); }
  async function wait(ctx, milliseconds, signal = ctx.controller.signal) {
    ensure(ctx);
    if (signal.aborted) throw failure('cancelled');
    let abort;
    const aborted = new Promise((_resolve, reject) => { abort = () => reject(failure('cancelled')); signal.addEventListener('abort', abort, { once: true }); });
    try { await Promise.race([Promise.resolve().then(() => sleep(milliseconds, signal)), aborted]); ensure(ctx); }
    finally { signal.removeEventListener('abort', abort); }
  }
  async function persist(ctx, value) {
    const task = storeSerial.then(async () => {
      ensure(ctx);
      try { await accountStore.set('twitch', copyAccount(value)); } catch { throw failure('storage_error'); }
      ensure(ctx); account = copyAccount(value);
    });
    storeSerial = task.catch(() => {}); await task;
  }
  async function forget() {
    const task = storeSerial.then(async () => {
      try { await accountStore.set('twitch', null); } catch { throw failure('storage_error'); }
    });
    storeSerial = task.catch(() => {}); await task;
  }
  async function request(ctx, url, options = {}, parentSignal = ctx.controller.signal) {
    ensure(ctx);
    if (parentSignal.aborted) throw failure('cancelled');
    const controller = new AbortController();
    let timedOut = false, rejectAbort;
    const abort = () => controller.abort();
    parentSignal.addEventListener('abort', abort, { once: true });
    const aborted = new Promise((_resolve, reject) => {
      rejectAbort = () => reject(failure(timedOut ? 'request_timeout' : 'cancelled'));
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT); timer.unref?.();
    const perform = async () => {
      const response = await fetcher(url, { ...options, signal: controller.signal, redirect: 'error', cache: 'no-store' });
      if (controller.signal.aborted) throw failure(timedOut ? 'request_timeout' : 'cancelled');
      if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599
        || !/^application\/json(?:\s*;|$)/i.test(response.headers?.get?.('content-type') ?? '')) throw failure('response_invalid');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE)) throw failure('response_invalid');
      const chunks = []; let size = 0;
      const reader = response.body?.getReader?.();
      if (!reader) throw failure('response_invalid');
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) throw failure(timedOut ? 'request_timeout' : 'cancelled');
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE) throw failure('response_invalid');
          chunks.push(Buffer.from(value));
        }
      } finally {
        try { if (controller.signal.aborted || size > MAX_RESPONSE) await reader.cancel(); } catch {}
        try { reader.releaseLock(); } catch {}
      }
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw failure('response_invalid'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('response_invalid');
      return { status: response.status, body };
    };
    try {
      const result = await Promise.race([perform(), aborted]); ensure(ctx); return result;
    } catch (error) {
      if (!active(ctx) || parentSignal.aborted) throw failure('cancelled');
      if (timedOut) throw failure('request_timeout');
      if (['response_invalid', 'cancelled'].includes(error?.code)) throw error;
      throw failure('network_error');
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', rejectAbort); parentSignal.removeEventListener('abort', abort);
      controller.abort();
    }
  }
  const form = value => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(value).toString() });
  function tokenPair(body, previous) {
    if (!opaque(body.access_token) || !opaque(body.refresh_token) || !Number.isSafeInteger(body.expires_in)
      || body.expires_in <= 0 || body.expires_in > 365 * 24 * 60 * 60 || !scopesValid(body.scope)) throw failure('auth_invalid');
    return { ...previous, clientId, accessToken: body.access_token, refreshToken: body.refresh_token,
      expiresAt: now() + body.expires_in * 1000, scopes: [...body.scope] };
  }
  async function validate(ctx, candidate, previousUserId) {
    const response = await request(ctx, VALIDATE_URL, { headers: { Authorization: `OAuth ${candidate.accessToken}` } });
    if (response.status === 401) throw failure('auth_expired');
    if (response.status !== 200) throw failure(response.status === 429 ? 'rate_limited' : 'auth_invalid');
    const value = response.body;
    if (value.client_id !== clientId || !numericId(value.user_id) || (previousUserId && value.user_id !== previousUserId)
      || typeof value.login !== 'string' || !/^[a-z0-9_]{1,32}$/.test(value.login) || !scopesValid(value.scopes)
      || !Number.isSafeInteger(value.expires_in) || value.expires_in < 0 || value.expires_in > 365 * 24 * 60 * 60) throw failure('auth_invalid');
    return { ...candidate, userId: value.user_id, login: value.login,
      displayName: candidate.login === value.login && boundedString(candidate.displayName, 256) ? candidate.displayName : value.login,
      expiresAt: now() + value.expires_in * 1000, scopes: [...value.scopes] };
  }
  async function refresh(ctx, previous = account) {
    ensure(ctx);
    if (ctx.refreshTask) return ctx.refreshTask;
    // Another request may have finished rotating the token before this older 401 arrived.
    if (ctx.authorized && accountValid(account, clientId) && previous?.accessToken !== account.accessToken) return copyAccount(account);
    const task = (async () => {
      if (!accountValid(previous, clientId)) throw failure('auth_expired');
      const response = await request(ctx, TOKEN_URL, form({ client_id: clientId, grant_type: 'refresh_token', refresh_token: previous.refreshToken }));
      if (response.status === 400 || response.status === 401) throw failure('auth_revoked');
      if (response.status !== 200) throw failure(response.status === 429 ? 'rate_limited' : 'network_error');
      const next = await validate(ctx, tokenPair(response.body, previous), previous.userId);
      await persist(ctx, next); return copyAccount(next);
    })();
    ctx.refreshTask = task;
    try { return await task; } finally { if (ctx.refreshTask === task) ctx.refreshTask = null; }
  }
  async function authorize(ctx) {
    publish('authorizing');
    const response = await request(ctx, DEVICE_URL, form({ client_id: clientId, scopes: SCOPES.join(' ') }));
    if (response.status !== 200) throw failure(response.status === 429 ? 'rate_limited' : 'auth_invalid');
    const value = response.body;
    if (!opaque(value.device_code) || typeof value.user_code !== 'string' || !/^[A-Z0-9-]{4,64}$/.test(value.user_code)
      || !Number.isSafeInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > 1800
      || !Number.isSafeInteger(value.interval) || value.interval < 1 || value.interval > 60) throw failure('auth_invalid');
    const url = verificationURL(value.verification_uri, value.user_code);
    if (!url) throw failure('auth_invalid');
    const deadline = now() + value.expires_in * 1000;
    publish('authorizing', null, { userCode: value.user_code, verificationUrl: url });
    try { await openExternal(url); } catch { throw failure('browser_unavailable'); }
    ensure(ctx);
    let interval = value.interval * 1000;
    while (now() < deadline) {
      await wait(ctx, Math.min(interval, deadline - now()));
      if (now() >= deadline) break;
      const token = await request(ctx, TOKEN_URL, form({ client_id: clientId, scopes: SCOPES.join(' '),
        device_code: value.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }));
      if (token.status === 200) return validate(ctx, tokenPair(token.body));
      // Twitch's documented device endpoint uses message instead of OAuth's error
      // field. Match only exact known codes; provider text never enters our status.
      const code = typeof token.body.error === 'string' ? token.body.error : token.body.message;
      if (code === 'authorization_pending' && token.status === 400) continue;
      if (code === 'slow_down' && [400, 429].includes(token.status)) { interval = Math.min(60000, interval + 5000); continue; }
      if (['access_denied', 'authorization_declined'].includes(code)) throw failure('auth_denied');
      if (['expired_token', 'invalid_device_code', 'invalid device code'].includes(code)) throw failure('auth_expired');
      throw failure(token.status === 429 ? 'rate_limited' : 'auth_invalid');
    }
    throw failure('auth_expired');
  }
  async function fail(ctx, code, clearAccount = false) {
    if (!active(ctx)) return;
    // End chat capability before waiting for disk I/O; a revocation must fence queued callbacks immediately.
    cancelContext();
    const ticket = generation;
    if (clearAccount) account = null;
    publish('error', code);
    if (clearAccount) {
      try { await forget(); } catch (error) { code = error.code ?? 'storage_error'; }
    }
    if (generation === ticket && publicState.error !== code) publish('error', code);
  }
  async function validationLoop(ctx) {
    try {
      while (active(ctx)) {
        await wait(ctx, HOURLY);
        const observed = copyAccount(account);
        let next;
        try { next = await validate(ctx, observed, observed.userId); }
        catch (error) {
          if (error.code !== 'auth_expired') throw error;
          if (account.accessToken !== observed.accessToken) continue;
          next = await refresh(ctx, observed);
        }
        ensure(ctx);
        if (account.accessToken === observed.accessToken || account.accessToken === next.accessToken) account = copyAccount(next);
      }
    } catch (error) {
      if (active(ctx)) await fail(ctx, error.code ?? 'network_error', ['auth_expired', 'auth_invalid', 'auth_revoked'].includes(error.code));
    }
  }
  function channelCurrent(ctx, stream, channel) {
    return streamActive(ctx, stream) && !channel.cancelled && (stream.current === channel || stream.pending === channel);
  }
  function scheduleReconnect(ctx, stream) {
    if (!streamActive(ctx, stream) || stream.reconnecting) return;
    const old = stream.current, pending = stream.pending; stream.current = stream.pending = null;
    cancelChannel(old); cancelChannel(pending);
    if (stream.attempts >= 5) { stopStream(ctx); publish('error', 'chat_unavailable'); return; }
    const delay = Math.min(30000, 1000 * 2 ** stream.attempts++);
    publish('connecting');
    const task = (async () => {
      try {
        await wait(ctx, delay, stream.controller.signal);
        if (stream.reconnecting === task) stream.reconnecting = null;
        if (streamActive(ctx, stream)) openChannel(ctx, stream, EVENTSUB_URL);
      }
      catch { /* Cancellation owns the final state. */ }
    })();
    stream.reconnecting = task;
    void task.finally(() => { if (stream.reconnecting === task) stream.reconnecting = null; });
  }
  function listen(socket, event, callback) {
    if (typeof socket.on === 'function') socket.on(event, callback);
    else if (typeof socket.addEventListener === 'function') socket.addEventListener(event, callback);
    else throw failure('chat_unavailable');
  }
  function openChannel(ctx, stream, url, handoff = false) {
    if (!streamActive(ctx, stream)) return;
    let socket;
    try { socket = createWebSocket(url); } catch { scheduleReconnect(ctx, stream); return; }
    const channel = { socket, controller: new AbortController(), cancelled: false, welcomed: false, subscribed: false,
      lastActivity: now(), keepaliveMs: 10000, handoff, messages: Promise.resolve() };
    if (handoff) stream.pending = channel; else stream.current = channel;
    const lost = () => { if (channelCurrent(ctx, stream, channel)) scheduleReconnect(ctx, stream); };
    try {
      listen(socket, 'error', lost); listen(socket, 'close', lost);
      listen(socket, 'message', raw => {
        channel.messages = channel.messages.then(() => handleFrame(ctx, stream, channel, raw)).catch(error => {
          if (channelCurrent(ctx, stream, channel)) {
            if (['auth_revoked', 'auth_invalid', 'auth_expired'].includes(error?.code)) void fail(ctx, error.code, true);
            else scheduleReconnect(ctx, stream);
          }
        });
      });
    } catch { lost(); }
    void (async () => {
      try { await wait(ctx, 10000, channel.controller.signal); if (channelCurrent(ctx, stream, channel) && !channel.welcomed) lost(); }
      catch {}
    })();
  }
  async function keepaliveLoop(ctx, stream, channel) {
    try {
      while (channelCurrent(ctx, stream, channel)) {
        await wait(ctx, Math.max(1, channel.keepaliveMs - (now() - channel.lastActivity)), channel.controller.signal);
        if (channelCurrent(ctx, stream, channel) && now() - channel.lastActivity >= channel.keepaliveMs) { scheduleReconnect(ctx, stream); return; }
      }
    } catch {}
  }
  async function subscribe(ctx, stream, channel, sessionId) {
    const current = copyAccount(account);
    const response = await request(ctx, `${HELIX}/eventsub/subscriptions`, { method: 'POST',
      headers: { Authorization: `Bearer ${current.accessToken}`, 'Client-Id': clientId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: current.userId, user_id: current.userId },
        transport: { method: 'websocket', session_id: sessionId } }) }, channel.controller.signal);
    if (!channelCurrent(ctx, stream, channel)) return;
    if (response.status === 401) { await refresh(ctx, current); throw failure('subscription_expired'); }
    if (response.status !== 202 || !Array.isArray(response.body.data) || response.body.data.length !== 1
      || response.body.data[0]?.status !== 'enabled' || response.body.data[0]?.type !== 'channel.chat.message'
      || response.body.data[0]?.version !== '1' || response.body.data[0]?.condition?.broadcaster_user_id !== current.userId
      || response.body.data[0]?.condition?.user_id !== current.userId
      || response.body.data[0]?.transport?.method !== 'websocket' || response.body.data[0]?.transport?.session_id !== sessionId) throw failure('subscription_invalid');
    channel.subscribed = true; stream.attempts = 0; publish('connected');
  }
  async function handleFrame(ctx, stream, channel, raw) {
    if (!channelCurrent(ctx, stream, channel)) return;
    let bytes;
    try {
      const value = raw?.data !== undefined ? raw.data : raw;
      if (typeof value === 'string') {
        if (Buffer.byteLength(value, 'utf8') > MAX_RESPONSE) throw failure('response_invalid');
        bytes = Buffer.from(value, 'utf8');
      } else if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) {
        if (value.byteLength > MAX_RESPONSE) throw failure('response_invalid');
        bytes = Buffer.from(value);
      }
      else return;
      if (bytes.length > MAX_RESPONSE) throw failure('response_invalid');
    } catch { throw failure('response_invalid'); }
    let frame;
    try { frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw failure('response_invalid'); }
    if (!frame || typeof frame !== 'object' || !frame.metadata || !frame.payload) throw failure('response_invalid');
    const kind = frame.metadata.message_type;
    if (kind === 'session_welcome') {
      const session = frame.payload.session;
      if (channel.welcomed || !opaque(session?.id, 256) || session.status !== 'connected'
        || !Number.isInteger(session.keepalive_timeout_seconds) || session.keepalive_timeout_seconds < 10 || session.keepalive_timeout_seconds > 600) throw failure('response_invalid');
      channel.welcomed = true; channel.keepaliveMs = session.keepalive_timeout_seconds * 1000; channel.lastActivity = now();
      if (channel.handoff) {
        if (stream.pending !== channel || !stream.current?.subscribed) throw failure('subscription_invalid');
        const old = stream.current; stream.current = channel; stream.pending = null; channel.subscribed = true;
        cancelChannel(old); stream.attempts = 0; publish('connected');
      } else await subscribe(ctx, stream, channel, session.id);
      if (channelCurrent(ctx, stream, channel)) void keepaliveLoop(ctx, stream, channel);
      return;
    }
    if (!channel.welcomed || stream.current !== channel) return;
    if (kind === 'session_keepalive') { channel.lastActivity = now(); return; }
    if (kind === 'session_reconnect') {
      if (!channel.subscribed) return;
      const target = reconnectURL(frame.payload.session?.reconnect_url);
      if (!target) { stopStream(ctx); publish('error', 'reconnect_invalid'); return; }
      channel.lastActivity = now(); if (!stream.pending) openChannel(ctx, stream, target, true);
      return;
    }
    if (kind === 'revocation') {
      const sub = frame.payload.subscription;
      if (sub?.type !== 'channel.chat.message' || sub.condition?.user_id !== account.userId || sub.condition?.broadcaster_user_id !== account.userId) return;
      await fail(ctx, 'authorization_revoked' === sub.status || sub.status === 'user_removed' ? 'auth_revoked' : 'subscription_revoked',
        ['authorization_revoked', 'user_removed'].includes(sub.status)); return;
    }
    if (kind !== 'notification' || !channel.subscribed || frame.metadata.subscription_type !== 'channel.chat.message'
      || frame.metadata.subscription_version !== '1') return;
    const sub = frame.payload.subscription, event = frame.payload.event;
    if (sub?.type !== 'channel.chat.message' || sub.version !== '1' || sub.condition?.user_id !== account.userId
      || sub.condition?.broadcaster_user_id !== account.userId || event?.broadcaster_user_id !== account.userId) return;
    // All legitimate notifications count as transport activity, even if their
    // chat content is unsuitable for a local song-request command.
    channel.lastActivity = now();
    if (!numericId(event.chatter_user_id) || !opaque(event.message_id, 256) || !boundedString(event.chatter_user_name, 256)
      || !boundedString(event.message?.text, 500)) return;
    if (stream.seen.has(event.message_id)) return;
    stream.seen.add(event.message_id); if (stream.seen.size > 2048) stream.seen.delete(stream.seen.values().next().value);
    if (!channelCurrent(ctx, stream, channel) || !receiving) return;
    try {
      // Chat replies may await HTTP. They must not hold up EventSub keepalives or a revocation.
      void Promise.resolve(onMessage?.({ platform: 'twitch', eventId: event.message_id, viewerId: event.chatter_user_id,
        viewerName: event.chatter_user_name, query: event.message.text })).catch(() => {});
    } catch { /* A queue failure must not replay the same incoming chat message. */ }
  }
  function startStream(ctx) {
    if (!active(ctx) || !receiving || !accountValid(account, clientId) || ctx.stream) return;
    const stream = { controller: new AbortController(), current: null, pending: null, attempts: 0, reconnecting: null, seen: new Set() };
    ctx.stream = stream; publish('connecting'); openChannel(ctx, stream, EVENTSUB_URL);
  }
  function connect() {
    if (!configured) return Promise.resolve(publish('error', 'setup_required'));
    if (connectTask) return connectTask;
    if (context && active(context) && accountValid(account, clientId) && context.authorized) {
      if (receiving) startStream(context); return Promise.resolve(status());
    }
    cancelContext();
    const ctx = { generation, controller: new AbortController(), stream: null, refreshTask: null, authorized: false }; context = ctx;
    const task = (async () => {
      try {
        let stored;
        try { await storeSerial; ensure(ctx); stored = await accountStore.get('twitch'); }
        catch (error) { if (error.code === 'cancelled') throw error; throw failure('storage_error'); }
        ensure(ctx);
        let next;
        if (accountValid(stored, clientId)) {
          publish('connecting');
          try { next = await validate(ctx, copyAccount(stored), stored.userId); }
          catch (error) {
            if (error.code === 'auth_expired') {
              try { next = await refresh(ctx, copyAccount(stored)); }
              catch (refreshError) { if (refreshError.code !== 'auth_revoked') throw refreshError; }
            } else if (error.code !== 'auth_invalid') throw error;
          }
        }
        if (!next) { account = null; next = await authorize(ctx); }
        await persist(ctx, next); ensure(ctx); ctx.authorized = true;
        publish('connected'); void validationLoop(ctx); if (receiving) startStream(ctx);
      } catch (error) { if (active(ctx)) await fail(ctx, error.code ?? 'network_error'); }
      return status();
    })();
    connectTask = task; void task.finally(() => { if (connectTask === task) connectTask = null; });
    return task;
  }
  function setReceiving(value) {
    receiving = value === true;
    if (context?.authorized && active(context)) {
      if (receiving) startStream(context);
      else { stopStream(context); publish('connected'); }
    }
    return Promise.resolve(status());
  }
  function stop() { receiving = false; cancelContext(); return Promise.resolve(publish('disconnected')); }
  async function disconnect() {
    receiving = false; cancelContext(); account = null;
    const ticket = generation;
    try { if (typeof accountStore?.set === 'function') await forget(); if (generation === ticket) publish('disconnected'); }
    catch { if (generation === ticket) publish('error', 'storage_error'); }
    return status();
  }
  async function sendReply(message) {
    if (typeof message !== 'string' || !message.trim() || Array.from(message).length > 500 || CONTROLS.test(message)) return { ok: false, code: 'invalid_message' };
    const ctx = context;
    if (!ctx || !active(ctx) || !ctx.authorized || !receiving || !accountValid(account, clientId)
      || !ctx.stream?.current?.subscribed || !streamActive(ctx, ctx.stream)) return { ok: false, code: 'disconnected' };
    try {
      const current = copyAccount(account);
      const response = await request(ctx, `${HELIX}/chat/messages`, { method: 'POST',
        headers: { Authorization: `Bearer ${current.accessToken}`, 'Client-Id': clientId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ broadcaster_id: current.userId, sender_id: current.userId, message }) }, ctx.stream?.controller.signal ?? ctx.controller.signal);
      if (!receiving || !active(ctx)) return { ok: false, code: 'cancelled' };
      if (response.status === 401) {
        try { await refresh(ctx, current); } catch (error) { if (active(ctx)) await fail(ctx, error.code ?? 'auth_expired', ['auth_revoked', 'auth_invalid', 'auth_expired'].includes(error.code)); }
        return { ok: false, code: 'auth_expired' }; // A POST with an uncertain outcome is never replayed.
      }
      if (response.status === 429) return { ok: false, code: 'rate_limited' };
      if (response.status !== 200 || !Array.isArray(response.body.data) || response.body.data.length !== 1
        || response.body.data[0]?.is_sent !== true || !opaque(response.body.data[0]?.message_id, 256)) return { ok: false, code: 'chat_rejected' };
      return { ok: true };
    } catch (error) { return { ok: false, code: error.code ?? 'network_error' }; }
  }
  return { status, connect, setReceiving, stop, disconnect, sendReply };
}

module.exports = { createTwitchSongRequestConnection };
