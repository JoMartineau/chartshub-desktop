'use strict';
const { randomUUID } = require('node:crypto');
const ORIGIN = 'https://chartshub.ca';
const ENDPOINT = ORIGIN + '/api/account/notifications/downloads';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/** Main-process account ownership only. Renderers cannot create notifications,
 * name their recipient, supply URLs or disclose local filenames to the server. */
function createDownloadNotifications({ fetcher, showNative = () => {}, probeGame = async () => ({ running: null }), openCentre = async () => {}, language = () => 'fr', timeoutMs = 7000 } = {}) {
  if (typeof fetcher !== 'function' || typeof showNative !== 'function' || typeof probeGame !== 'function' || typeof openCentre !== 'function' || typeof language !== 'function') throw Error('Invalid notification configuration');
  let accountId = null, generation = 0, disposed = false, queue = Promise.resolve();
  const controllers = new Set(), captures = new WeakSet(), completed = new WeakSet(), companion = new Map();
  const current = scope => !disposed && scope && captures.has(scope) && scope.generation === generation && scope.accountId === accountId;
  function invalidate() {
    generation++; accountId = null;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    // Retain ownership of active transfers: a subsequent account must not adopt
    // their completion. Only an explicit resume/retry can establish new intent.
  }
  function setAccount(user) {
    const next = user && typeof user.id === 'string' && user.id.length > 0 && user.id.length <= 200 ? user.id : null;
    if (next !== accountId) { invalidate(); accountId = next; }
  }
  function capture() {
    if (disposed || !accountId) return null;
    const scope = Object.freeze({ accountId, generation, eventId: randomUUID() }); captures.add(scope); return scope;
  }
  async function deliver(scope, event) {
    if (!current(scope)) return;
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
    try {
      // The server compares this header to the cookie-authenticated user. A
      // cookie switch between client checks and request dispatch cannot move a
      // notification to the next account.
      const response = await fetcher(ENDPOINT, { method: 'POST', credentials: 'include', redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: ORIGIN, 'X-Chartshub-Account-Id': scope.accountId }, body: JSON.stringify(event) });
      if (!current(scope) || controller.signal.aborted || !response?.ok || response.redirected || (response.url && response.url !== ENDPOINT)) return;
      const declared = response.headers?.get('content-length');
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > 256 * 1024)) return;
      const body = await response.text();
      if (!current(scope) || controller.signal.aborted || Buffer.byteLength(body) > 256 * 1024) return;
      const result = JSON.parse(body), preferences = result?.preferences;
      if (result?.ok !== true || result.duplicate !== false || !result.notification || preferences?.categories?.downloads !== true || typeof preferences.quietWhilePlaying !== 'boolean') return;
      if (preferences.quietWhilePlaying) {
        let game;
        try { game = await probeGame(); } catch { return; }
        // Process presence is deliberately broader than "playing a song".
        // Unknown detection stays quiet rather than interrupting the game.
        if (game?.running !== false) return;
      }
      if (!current(scope) || controller.signal.aborted) return;
      const french = language() === 'fr';
      const title = french ? 'ChartsHub · Téléchargements' : 'ChartsHub · Downloads';
      const bodyText = event.outcome === 'complete'
        ? french ? `${event.completed} chart(s) téléchargée(s).` : `${event.completed} chart(s) downloaded.`
        : event.outcome === 'cancelled'
          ? french ? `Téléchargement annulé · ${event.completed}/${event.total} chart(s) terminée(s).` : `Download cancelled · ${event.completed}/${event.total} chart(s) completed.`
          : french ? `Téléchargement incomplet · ${event.completed}/${event.total} chart(s) terminée(s).` : `Download incomplete · ${event.completed}/${event.total} chart(s) completed.`;
      showNative({ title, body: bodyText, silent: true }, () => {
        if (current(scope)) void Promise.resolve(openCentre(() => current(scope))).catch(() => {});
      });
    } catch { /* A notification must never fail or undo a local download. */ }
    finally { clearTimeout(timer); controllers.delete(controller); }
  }
  function post(scope, event) {
    if (!current(scope) || !UUID.test(event.eventId) || !['complete', 'error', 'cancelled'].includes(event.outcome)
      || !Number.isSafeInteger(event.total) || event.total < 1 || event.total > 200
      || !Number.isSafeInteger(event.completed) || event.completed < 0 || event.completed > event.total
      || (event.outcome === 'complete' && event.completed !== event.total)) return;
    queue = queue.then(() => deliver(scope, event)).catch(() => {});
  }
  function terminal(scope, outcome) {
    if (!current(scope) || completed.has(scope)) return;
    completed.add(scope);
    post(scope, { eventId: scope.eventId, outcome, completed: outcome === 'complete' ? 1 : 0, total: 1 });
  }
  function observeCompanion(snapshot) {
    if (!Array.isArray(snapshot?.items)) return;
    for (const item of snapshot.items) {
      const owner = companion.get(item.id);
      if (!owner || owner.done) continue;
      const outcome = { Completed: 'complete', Failed: 'error', Cancelled: 'cancelled' }[item.state];
      if (outcome) { owner.done = true; terminal(owner.scope, outcome); }
    }
  }
  function trackCompanion(scope, id, snapshot, { restart = false } = {}) {
    if (!current(scope) || typeof id !== 'string' || !UUID.test(id) || (!restart && companion.has(id))) return;
    companion.set(id, { scope, done: false });
    if (companion.size > 1000) for (const [key, value] of companion) { if (value.done && key !== id) companion.delete(key); if (companion.size <= 500) break; }
    observeCompanion(snapshot);
  }
  function finishNative(scope, endpoints, result) {
    if (!current(scope) || completed.has(scope) || !Array.isArray(endpoints) || !endpoints.length) return;
    completed.add(scope);
    // Moderation/review exports do not create public download notifications.
    const eligible = endpoints.filter(endpoint => typeof endpoint === 'string' && /^\/api\/charts\//.test(endpoint));
    const results = Array.isArray(result?.results) ? result.results : endpoints.length === 1 ? [{ endpoint: endpoints[0], ...result }] : [];
    for (let offset = 0; offset < eligible.length; offset += 200) {
      const batch = eligible.slice(offset, offset + 200), finished = batch.filter(endpoint => results.some(entry => entry.endpoint === endpoint && entry.ok === true)).length;
      const cancelled = result?.cancelled === true;
      post(scope, { eventId: offset === 0 ? scope.eventId : randomUUID(), outcome: finished === batch.length ? 'complete' : cancelled ? 'cancelled' : 'error', completed: finished, total: batch.length });
    }
  }
  return { setAccount, invalidate, capture, trackCompanion, observeCompanion, finishNative, flush: () => queue,
    dispose() { disposed = true; invalidate(); companion.clear(); return queue; } };
}
module.exports = { createDownloadNotifications };
