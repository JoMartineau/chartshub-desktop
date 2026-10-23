'use strict';
const { createHash } = require('node:crypto');

// A scan revision also advances when nothing changed. Compare committed song
// fingerprints instead, without rereading any files or serializing the library.
function songRequestShareKey(index, rules) {
  if (!index?.rootKey || !Array.isArray(index.items)) return null;
  const hash = createHash('sha256').update(JSON.stringify([index.rootKey, rules]));
  for (const item of [...index.items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    hash.update(JSON.stringify([item.id, item.fingerprint, item.title, item.artist, item.charter, item.durationMs, item.tracks]));
  }
  return hash.digest('hex');
}

// Synchronize a previously published list. This module never creates sharing
// consent, reads Songs, stores capabilities or chooses an account itself.
function createSongRequestShareSync({ context, publish, cancel = () => {}, onChange = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, debounceMs = 1500, retryDelays = [5000, 30000] } = {}) {
  if (typeof context !== 'function' || typeof publish !== 'function') throw TypeError('Invalid sharing synchronization');
  let enabled = false, epoch = 0, timer = null, running = null, synchronizedKey = null;
  let attemptedKey = null, attempts = 0, blockedKey = null, lastStatus = '';
  const retryable = new Set(['SHARE_NETWORK', 'SHARE_UNAVAILABLE', 'SHARE_RATE_LIMIT', 'SHARE_UPLOAD_CONFLICT']);
  function current() { try { return context() ?? {}; } catch { return {}; } }
  function status() {
    const value = current(), active = enabled && value.active === true && value.published === true;
    return { enabled: active, pending: active && value.key !== synchronizedKey && blockedKey !== value.key,
      updating: active && !!running, retrying: active && timer?.kind === 'retry' };
  }
  function notify() {
    const value = status(), serialized = JSON.stringify(value);
    if (serialized === lastStatus) return; lastStatus = serialized;
    try { onChange(value); } catch { /* Renderer notifications cannot start another upload. */ }
  }
  function clear() { if (timer) clearTimer(timer.handle); timer = null; }
  function abortRunning() {
    if (!running || running.cancelled) return;
    running.cancelled = true;
    // Cancellation may race a server commit. The previous key is no longer
    // proof of the remote contents, including when changes revert to that key.
    synchronizedKey = null;
    try { cancel(); } catch { /* The publication still validates its current revision. */ }
  }
  function schedule(key, delay, kind) {
    clear();
    const scheduled = { key, kind, handle: null };
    scheduled.handle = setTimer(() => {
      if (timer !== scheduled) return; timer = null;
      const value = current();
      if (!enabled || value.active !== true || value.published !== true || value.ready !== true || value.key !== key) { update(); return; }
      const operation = { key, epoch, cancelled: false, promise: null }; running = operation; notify();
      operation.promise = Promise.resolve().then(() => publish()).catch(() => ({ ok: false, error: 'SHARE_UNAVAILABLE' })).then(result => {
        if (operation.epoch !== epoch || operation.cancelled) return;
        const latest = current();
        if (!enabled || latest.active !== true || latest.published !== true || latest.key !== key) return;
        if (result?.ok === true) { synchronizedKey = key; attempts = 0; blockedKey = null; }
        else if (latest.ready === true) {
          if (retryable.has(result?.error) && attempts < retryDelays.length) {
            const delayMs = retryDelays[attempts++]; schedule(key, delayMs, 'retry');
          } else blockedKey = key;
        }
      }).finally(() => { if (running === operation) running = null; update(); });
    }, delay);
    scheduled.handle?.unref?.(); timer = scheduled; notify();
  }
  function update() {
    const value = current();
    if (!enabled || value.active !== true || value.published !== true) {
      clear(); abortRunning();
      if (value.published !== true) { synchronizedKey = null; attemptedKey = null; blockedKey = null; attempts = 0; }
      notify(); return;
    }
    if (value.ready !== true || typeof value.key !== 'string' || !value.key) { clear(); abortRunning(); notify(); return; }
    if (running && running.key !== value.key) abortRunning();
    if (value.key === synchronizedKey) { clear(); notify(); return; }
    if (attemptedKey !== value.key) { attemptedKey = value.key; attempts = 0; blockedKey = null; }
    if (running || blockedKey === value.key) { notify(); return; }
    if (timer?.key === value.key) { notify(); return; }
    schedule(value.key, debounceMs, 'change');
  }
  async function pause({ forget = false } = {}) {
    enabled = false; epoch++; clear(); abortRunning();
    if (forget) { synchronizedKey = null; attemptedKey = null; blockedKey = null; attempts = 0; }
    notify(); await running?.promise;
  }
  function resume({ synchronized } = {}) {
    enabled = true;
    if (typeof synchronized === 'string') { synchronizedKey = synchronized; attemptedKey = synchronized; blockedKey = null; attempts = 0; }
    update();
  }
  return { update, pause, resume, status };
}

module.exports = { createSongRequestShareSync, songRequestShareKey };
