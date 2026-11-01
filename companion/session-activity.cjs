'use strict';
// Ephemeral local transitions only. Never reads a path, downloads history or
// joins chat transports. OBS sharing is an independent opt-in at the Host.
const LIMITS = Object.freeze({ items: 100, observed: 1024, input: 500 });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '').trim().slice(0, max) : '';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function createSessionActivity({ getContext = () => ({ active: false }), now = Date.now, onChange = () => {} } = {}) {
  if (typeof getContext !== 'function' || typeof now !== 'function' || typeof onChange !== 'function') throw TypeError('Invalid session activity callbacks');
  let owner = null, epoch = 0, revision = 0, sequence = 0, disposed = false, items = [];
  let requests = new Map(), downloads = new Map(), completedDownloads = new Set(), requestBaseline = false, downloadBaseline = false;
  const notify = () => { try { onChange(); } catch {} };
  function reset(key) { owner = key; epoch++; revision++; items = []; requests = new Map(); downloads = new Map(); completedDownloads = new Set(); requestBaseline = downloadBaseline = false; }
  function context() {
    let source; try { source = getContext(); } catch {}
    const lifecycle = source?.lifecycle, root = source?.root ?? null, account = source?.account ?? null;
    const token = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value);
    const active = !disposed && source?.active === true && (root === null || token(root)) && (account === null || token(account)) && (Number.isSafeInteger(lifecycle) && lifecycle >= 0 || token(lifecycle));
    const key = active ? JSON.stringify([root, lifecycle, account]) : null;
    if (owner !== key) reset(key);
    return active;
  }
  function captureScope() { return context() ? epoch : null; }
  function snapshot() { context(); return { revision, items: items.map(item => ({ ...item })) }; }
  function record(map, id, state) {
    if (!map.has(id) && map.size >= LIMITS.observed) {
      const removable = [...map].find(([, entry]) => !['pending', 'accepted', 'Queued', 'Downloading', 'Paused'].includes(entry));
      if (removable) map.delete(removable[0]); else return false;
    }
    map.set(id, state); return true;
  }
  function observe(value, kind, expectedScope) {
    const scope = captureScope(); if (scope === null || expectedScope !== undefined && expectedScope !== scope) return false;
    const values = kind === 'request' ? value?.requests : value?.items;
    if (!Array.isArray(values) || values.length > LIMITS.input) return false;
    const baseline = kind === 'request' ? requestBaseline : downloadBaseline, map = kind === 'request' ? requests : downloads, events = [];
    let root; try { root = getContext()?.root ?? null; } catch { return false; }
    for (const entry of values) {
      if (!plain(entry) || !uuid(entry.id)) continue;
      const id = entry.id.toLowerCase(), state = kind === 'request' ? entry.status : entry.state, previous = map.get(id);
      if (!(kind === 'request' ? ['pending', 'accepted', 'played', 'rejected', 'removed'].includes(state) : ['Queued', 'Downloading', 'Paused', 'Completed', 'Failed', 'Cancelled'].includes(state))) continue;
      // A current scope belongs to a freshly started Host operation. Its
      // chosen destination may differ from Songs; unscoped history may not.
      if (kind === 'download' && expectedScope === undefined && entry.rootPath !== root) continue;
      if (!record(map, id, state) || !baseline || previous === state) continue;
      const action = kind === 'request' ? state === 'pending' && previous === undefined ? 'added' : state === 'accepted' && previous === 'pending' ? 'accepted' : state === 'played' && previous === 'accepted' ? 'played' : null : state === 'Completed' && ['Queued', 'Downloading', 'Paused'].includes(previous) ? 'completed' : null;
      // SongRequests.snapshot() publishes a flat title. Accept the older nested
      // shape only as a compatibility fallback for synthetic/imported callers.
      const title = text(kind === 'request' ? entry.title ?? entry.song?.title : entry.title, 200);
      if (action && title) events.push({ kind, action, title, platform: ['twitch', 'tiktok', 'youtube', 'website'].includes(entry.platform) ? entry.platform : 'desktop', ...(kind === 'request' && text(entry.viewerName, 80) ? { name: text(entry.viewerName, 80) } : {}) });
    }
    if (kind === 'request') requestBaseline = true; else downloadBaseline = true;
    if (captureScope() !== scope) return false;
    let at; try { at = now(); } catch { return false; }
    if (!Number.isSafeInteger(at) || at < 0 || captureScope() !== scope) return false;
    if (events.length) { for (const event of events) items.push({ id: String(++sequence), ...event, at }); items = items.slice(-LIMITS.items); revision++; notify(); }
    return true;
  }
  function update() { context(); return snapshot(); }
  // Called only from a fresh, authorised main-process web download. Its path
  // never enters the activity feed, and prior download history is not replayed.
  function observeCompletedDownload(value, expectedScope) {
    const scope = captureScope();
    if (scope === null || expectedScope !== undefined && expectedScope !== scope || !plain(value) || !uuid(value.id)) return false;
    const id = value.id.toLowerCase(), title = text(value.title, 200);
    if (!title || completedDownloads.has(id)) return false;
    let at; try { at = now(); } catch { return false; }
    if (!Number.isSafeInteger(at) || at < 0 || captureScope() !== scope) return false;
    completedDownloads.add(id);
    if (completedDownloads.size > LIMITS.observed) completedDownloads.delete(completedDownloads.values().next().value);
    items.push({ id: String(++sequence), kind: 'download', action: 'completed', title, platform: 'desktop', at });
    items = items.slice(-LIMITS.items); revision++; notify(); return true;
  }
  function clear() { context(); reset(owner); notify(); return snapshot(); }
  function dispose() { if (disposed) return; disposed = true; reset(null); }
  return Object.freeze({ observeRequests: (value, scope) => observe(value, 'request', scope), observeDownloads: (value, scope) => observe(value, 'download', scope), observeCompletedDownload, captureScope, update, clear, snapshot, dispose });
}
module.exports = { createSessionActivity, LIMITS };
