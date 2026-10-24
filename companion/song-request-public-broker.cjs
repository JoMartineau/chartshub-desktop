'use strict';
const { randomUUID } = require('node:crypto');
const { UUID, ACK_CODES, MAX_EVENTS, pollOutput, ackOutput } = require('./song-request-public-contract.cjs');

// An outbound, owner-authenticated lease; never an Internet-facing local server.
// A receipt is acknowledged only after the normal installed-chart resolver has
// committed its result. Lost acknowledgements retry the cached result, not receive().
function createSongRequestPublicBroker({ client, context, receive, onChange = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, sessionId = randomUUID, now = Date.now,
  pollMs = 5000, maxCached = 1000, cacheLifetimeMs = 600000 } = {}) {
  if (typeof context !== 'function' || typeof receive !== 'function') throw TypeError('Invalid public request broker.');
  const supported = ['capture', 'pollRequests', 'ackRequests', 'isCurrentAccount'].every(key => typeof client?.[key] === 'function');
  let session = null, timer = null, epoch = 0, error = null, connected = false, lastStatus = '';
  const releases = new Set();
  function current() { try { return context() ?? {}; } catch { return {}; } }
  function available(value) { return supported && value.active === true && typeof value.key === 'string' && !!value.key && typeof value.revision === 'string' && UUID.test(value.revision); }
  function live(value) {
    const state = current();
    return session === value && value.epoch === epoch && !value.controller.signal.aborted
      && available(state) && state.key === value.key && state.revision === value.revision
      && now() < value.validUntil
      && (!value.account || client.isCurrentAccount(value.account) === true);
  }
  function status() {
    return { supported, active: !!session && live(session), connected: !!session && live(session) && connected,
      error, pendingAcknowledgements: session ? [...session.results.values()].filter(item => item.pending).length : 0 };
  }
  function notify() {
    const state = status(), serialized = JSON.stringify(state);
    if (serialized === lastStatus) return; lastStatus = serialized;
    try { onChange(state); } catch { /* UI observers cannot authorize receiving. */ }
  }
  function clear() { if (timer !== null) clearTimer(timer); timer = null; }
  function revoke(value) {
    if (!value?.account || !client.isCurrentAccount(value.account)) return Promise.resolve();
    // A changed account cannot send a revocation using the new owner's cookies.
    const task = Promise.resolve().then(() => client.pollRequests({ sessionId: value.id, receiving: false }, value.account,
      { signal: AbortSignal.timeout(3000) })).catch(() => {});
    releases.add(task); void task.finally(() => releases.delete(task)); return task;
  }
  function retire() {
    const previous = session; session = null; epoch++; clear(); connected = false;
    if (previous) { clearHeartbeat(previous); previous.controller.abort(); previous.results.clear(); }
    notify(); return revoke(previous);
  }
  function schedule(value) {
    if (!live(value)) return;
    timer = setTimer(() => { timer = null; void tick(value); }, pollMs);
    timer?.unref?.();
  }
  function clearHeartbeat(value) {
    value.heartbeatEpoch++;
    if (value.heartbeat !== null) clearTimer(value.heartbeat);
    value.heartbeat = null;
  }
  function heartbeat(value) {
    if (!live(value) || !value.running) return;
    const ticket = ++value.heartbeatEpoch;
    value.heartbeat = setTimer(async () => {
      value.heartbeat = null;
      if (!live(value) || !value.running || ticket !== value.heartbeatEpoch) return;
      try {
        const validUntil = now() + 25000;
        const output = pollOutput(await client.pollRequests({ sessionId: value.id, receiving: true }, value.account,
          { signal: value.controller.signal, isCurrent: () => live(value) && value.running && ticket === value.heartbeatEpoch }), value.id);
        if (!live(value) || now() >= validUntil || !value.running || ticket !== value.heartbeatEpoch) return;
        if (output.libraryRevision !== value.revision) throw Error('The public library revision changed.');
        // Leave delivered events pending on the server; only the serial main
        // poll processes them. This renewal exists solely for slow file checks.
        value.validUntil = validUntil; heartbeat(value);
      } catch {
        if (session === value && value.running && ticket === value.heartbeatEpoch) {
          error = 'SHARE_NETWORK'; void retire();
        }
      }
    }, pollMs);
    value.heartbeat?.unref?.();
  }
  function prune(value) {
    const threshold = now() - cacheLifetimeMs;
    for (const [id, result] of value.results) if (!result.pending && result.at < threshold) value.results.delete(id);
    while (value.results.size >= maxCached) {
      const removable = [...value.results].find(([, result]) => !result.pending);
      if (!removable) throw Error('Public acknowledgement cache is full.');
      value.results.delete(removable[0]);
    }
  }
  function resultFor(id, result) {
    if (result?.ok === true && typeof result.request?.id === 'string' && UUID.test(result.request.id) && ['request', 'vote'].includes(result.action)) {
      return { id, ok: true, code: result.action === 'request' ? 'request_added' : 'vote_added', requestId: result.request.id, action: result.action };
    }
    return { id, ok: false, code: ACK_CODES.includes(result?.code) && !['request_added', 'vote_added'].includes(result.code) ? result.code : 'invalid_request' };
  }
  async function acknowledge(value) {
    const results = [...value.results.values()].filter(item => item.pending).slice(0, MAX_EVENTS).map(item => item.result);
    if (!results.length || !live(value)) return;
    const input = { sessionId: value.id, results };
    const output = ackOutput(await client.ackRequests(input, value.account,
      { signal: value.controller.signal, isCurrent: () => live(value) }), input);
    if (!live(value)) return;
    for (const id of output.acknowledged) value.results.get(id).pending = false;
  }
  async function tick(value) {
    if (!live(value) || value.running) return;
    value.running = true;
    try {
      if (!value.account) value.account = await client.capture();
      if (!live(value)) return;
      const validUntil = now() + 25000;
      // The first lease is bounded from request dispatch, not from response
      // arrival. Further attempts retain the old fence until renewal succeeds.
      if (!value.pollSent) { value.pollSent = true; value.validUntil = validUntil; }
      const output = pollOutput(await client.pollRequests({ sessionId: value.id, receiving: true }, value.account,
        { signal: value.controller.signal, isCurrent: () => live(value) }), value.id);
      if (!live(value) || now() >= validUntil) return;
      if (output.libraryRevision !== value.revision) { error = 'SHARE_LIBRARY_CHANGED'; connected = false; await retire(); return; }
      connected = true; error = null; value.validUntil = validUntil; heartbeat(value);
      for (const event of output.events) {
        if (!live(value)) return;
        const fingerprint = JSON.stringify(event), cached = value.results.get(event.id);
        if (cached) {
          if (cached.fingerprint !== fingerprint) throw Error('A public event changed identity.');
          cached.pending = true; continue;
        }
        prune(value);
        let result;
        if (event.libraryRevision !== value.revision) result = { ok: false, code: 'library_revision_changed' };
        else result = await receive({ platform: 'website', eventId: event.id, songId: event.songId,
          viewerId: event.viewerId, viewerName: event.viewerName }, { isCurrent: () => live(value) });
        if (!live(value)) return;
        value.results.set(event.id, { fingerprint, result: resultFor(event.id, result), pending: true, at: now() });
      }
      await acknowledge(value);
    } catch (failure) {
      if (live(value)) {
        connected = false;
        error = ['SHARE_ACCOUNT_REQUIRED', 'SHARE_ACCOUNT_UNVERIFIED', 'SHARE_ACCOUNT_CHANGED', 'SHARE_ACCESS_DENIED',
          'SHARE_SERVER_UPDATE_REQUIRED', 'SHARE_RATE_LIMIT', 'SHARE_RESPONSE_INVALID'].includes(failure?.code) ? failure.code : 'SHARE_NETWORK';
      }
    } finally {
      value.running = false; clearHeartbeat(value);
      if (session === value && !live(value)) void retire();
      notify(); schedule(value);
    }
  }
  function update() {
    const state = current();
    if (!available(state)) { if (session) void retire(); else notify(); return status(); }
    if (session && live(session)) return status();
    if (session) void retire();
    const id = sessionId(); if (typeof id !== 'string' || !UUID.test(id)) throw TypeError('Invalid public request session.');
    const value = { id, key: state.key, revision: state.revision, account: null, controller: new AbortController(), epoch: ++epoch,
      running: false, results: new Map(), validUntil: now() + 25000, pollSent: false, heartbeat: null, heartbeatEpoch: 0 };
    session = value; connected = false; error = null; notify(); void tick(value); return status();
  }
  async function stop() { await retire(); await Promise.allSettled([...releases]); return status(); }
  return { update, stop, status };
}
module.exports = { createSongRequestPublicBroker };
