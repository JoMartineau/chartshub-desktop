'use strict';

// Local, ephemeral chat only. Auth, network transports and explicit connection
// consent remain owned by the existing providers; this module never opens one.
const PLATFORMS = ['twitch', 'tiktok'];
const STATES = new Set(['disconnected', 'connecting', 'connected', 'authorizing', 'awaiting_authorization', 'error']);
const ERRORS = new Set(['setup_required', 'auth_revoked', 'subscription_revoked', 'authorization_failed', 'authorization_expired',
  'connection_failed', 'connection_closed', 'connection_timeout', 'provider_unavailable', 'not_live', 'rate_limited',
  'chat_unavailable', 'response_invalid', 'reconnect_invalid', 'subscription_invalid', 'invalid_username', 'storage_unavailable']);
const LIMITS = Object.freeze({ messages: 100, text: 500, name: 80, eventId: 256, seen: 1000, ttlMs: 15 * 60 * 1000, perSecond: 60 });
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function text(value, limit) {
  if (typeof value !== 'string') return '';
  // Keep HTML-looking text literal. Renderers must use textContent, never HTML.
  return value.replace(CONTROLS, '').trim().slice(0, limit).replace(/[\ud800-\udbff]$/u, '');
}

function createUnifiedChat({ getContext = () => ({ active: false, lifecycle: null }), onChange, now = Date.now } = {}) {
  let enabled = false, revision = 0, sequence = 0, initialized = false, lifecycle = null;
  let messages = [], seen = new Map(), recent = [];
  const connections = Object.fromEntries(PLATFORMS.map(platform => [platform, { state: 'disconnected', displayName: null, error: null }]));
  const notify = () => { try { onChange?.(); } catch {} };
  const changed = () => { revision++; notify(); };
  const disconnectAll = () => {
    for (const platform of PLATFORMS) connections[platform] = { state: 'disconnected', displayName: null, error: null };
  };
  function purge(platform) {
    if (platform) {
      messages = messages.filter(message => message.platform !== platform);
      for (const key of seen.keys()) if (key.startsWith(platform + ':')) seen.delete(key);
    } else { messages = []; seen = new Map(); recent = []; }
  }
  function context() {
    let value;
    try { value = getContext(); } catch { value = null; }
    const valid = plainObject(value) && value.active === true
      && (typeof value.lifecycle === 'string' && value.lifecycle.length <= 256 || Number.isSafeInteger(value.lifecycle));
    const key = valid ? value.lifecycle : null;
    if (!initialized) { initialized = true; lifecycle = key; }
    else if (key !== lifecycle || !valid && enabled) {
      lifecycle = key; enabled = false; purge(); disconnectAll(); revision++;
    }
    return valid;
  }
  function prune(time) {
    const prior = messages.length;
    messages = messages.filter(message => message.at > time - LIMITS.ttlMs && message.at <= time);
    for (const [key, expiry] of seen) if (expiry <= time) seen.delete(key);
    recent = recent.filter(at => at > time - 1000 && at <= time);
    if (messages.length !== prior) revision++;
  }
  function status() {
    context(); prune(now());
    return { enabled, revision, messages: messages.map(message => ({ ...message })), connections: {
      twitch: { ...connections.twitch }, tiktok: { ...connections.tiktok }
    } };
  }
  function getRevision() {
    context();
    if (messages.length) {
      const time = now();
      if (messages[0].at <= time - LIMITS.ttlMs || messages.at(-1).at > time) prune(time);
    }
    return revision;
  }
  function configure(value) {
    if (!plainObject(value) || Object.keys(value).length !== 1 || typeof value.enabled !== 'boolean') return { ok: false, code: 'CHAT_INVALID_SETTINGS' };
    const active = context();
    if (value.enabled && !active) return { ok: false, code: 'CHAT_UNAVAILABLE' };
    enabled = value.enabled;
    if (!enabled) purge();
    changed(); return { ok: true };
  }
  function connection(platform, value) {
    if (!context()) return false;
    if (!PLATFORMS.includes(platform) || !plainObject(value) || !STATES.has(value.state)) return false;
    const next = { state: value.state, displayName: text(value.displayName, 80) || null,
      error: ERRORS.has(value.error) ? value.error : null };
    const previous = connections[platform];
    const differs = JSON.stringify(previous) !== JSON.stringify(next);
    connections[platform] = next;
    if (next.state !== 'connected') purge(platform);
    if (differs) changed();
    return true;
  }
  function capture(event) {
    if (!context() || !enabled || !plainObject(event) || !PLATFORMS.includes(event.platform)
      || connections[event.platform].state !== 'connected'
      || typeof event.eventId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(event.eventId)
      || typeof event.query !== 'string' || event.query.length > LIMITS.text
      || typeof event.viewerName !== 'string' || event.viewerName.length > 256) return false;
    const message = text(event.query, LIMITS.text), name = text(event.viewerName, LIMITS.name);
    if (!message || !name) return false;
    const time = now(); if (!Number.isSafeInteger(time) || time < 0) return false;
    prune(time);
    const key = event.platform + ':' + event.eventId;
    if (seen.has(key) || recent.length >= LIMITS.perSecond) return false;
    if (seen.size >= LIMITS.seen) seen.delete(seen.keys().next().value);
    seen.set(key, time + LIMITS.ttlMs); recent.push(time);
    messages.push({ id: String(++sequence), platform: event.platform, name, text: message, at: time });
    if (messages.length > LIMITS.messages) messages.shift();
    changed(); return true;
  }
  function clear(platform) {
    context();
    if (platform !== undefined && !PLATFORMS.includes(platform)) return { ok: false, code: 'CHAT_INVALID_SETTINGS' };
    purge(platform); changed(); return { ok: true };
  }
  function stop() {
    enabled = false; purge();
    disconnectAll();
    changed();
  }
  return Object.freeze({ status, getRevision, configure, capture, connection, clear, stop });
}

module.exports = { createUnifiedChat, LIMITS };
