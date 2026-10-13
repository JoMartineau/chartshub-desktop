'use strict';
const { normalizeResult, normalizeStatus, buildRequest, failure } = require('./catalogue-enchor-client.cjs');
const { normalizeMetadata } = require('./chart-matching.cjs');

// Searches belong to the requesting trusted surface. Native caching and manual
// association generations remain independent from provider search generations.
function createExternalCatalogue({ client, now = Date.now } = {}) {
  const scopes = new Map(); let active = true, transport = Promise.resolve();
  let enabled = null, suspended = false, retryUntil = 0;
  function state(scope) {
    if (!['panel', 'widget'].includes(scope)) throw failure('ENCHOR_INVALID_QUERY');
    if (!scopes.has(scope)) scopes.set(scope, { key: null, generation: 0, criteriaGeneration: 0, controller: null, items: [], page: 0, total: 0, hasMore: false, status: 'idle', error: null, unsupported: [], localFilters: [], windows: new Map(), nativeCount: null });
    return scopes.get(scope);
  }
  function snapshot(current) {
    const retryAfterSeconds = Math.max(0, Math.ceil((retryUntil - now()) / 1000));
    return { status: enabled === false ? 'disabled' : suspended ? 'suspended' : retryAfterSeconds ? 'cooldown' : current.status === 'cooldown' ? current.page ? 'ready' : 'idle' : current.status, enabled, suspended, retryUntil, retryAfterSeconds, error: current.error, unsupported: [...current.unsupported], localFilters: [...current.localFilters], page: current.page, pageSize: 25, total: current.page && !current.hasMore ? current.items.length : current.total, hasMore: current.hasMore };
  }
  function cancel(current) { current.generation++; current.controller?.abort(); current.controller = null; }
  function reset(current, key) { cancel(current); current.criteriaGeneration++; Object.assign(current, { key, items: [], page: 0, total: 0, hasMore: false, status: 'idle', error: null, windows: new Map(), nativeCount: null }); }
  function prepare(selected, scope = 'panel') {
    const current = state(scope), key = JSON.stringify(Object.fromEntries(Object.entries(selected).filter(([key]) => !['page', 'externalSearch'].includes(key))));
    if (current.key !== key) reset(current, key);
    return { current, generation: current.criteriaGeneration };
  }
  function isCurrent(token, scope = 'panel') { return active && scopes.get(scope) === token.current && token.current.criteriaGeneration === token.generation; }
  function cancelScope(scope, clear = false) {
    const current = scopes.get(scope); if (!current) return;
    if (clear) reset(current, null);
    else { cancel(current); current.criteriaGeneration++; current.status = current.page ? 'ready' : 'idle'; current.error = null; }
  }
  function contains(value, term) { return !term || normalizeMetadata(value).includes(normalizeMetadata(term)); }
  async function search(selected, nativeCount, scope = 'panel') {
    prepare(selected, scope); const current = state(scope);
    if (current.nativeCount !== nativeCount) { current.nativeCount = nativeCount; current.windows.clear(); }
    const existing = current.windows.get(selected.page), previous = current.windows.get(selected.page - 1);
    const offset = existing ? existing.offset : previous ? previous.offset + previous.count : Math.min((selected.page - 1) * 20, nativeCount + current.items.length);
    const output = (items = current.items) => {
      const limit = existing ? existing.count : Math.min(20, Math.max(0, nativeCount + items.length - offset));
      // Sparse filtered/overlapping upstream pages retain their actual width.
      // Next starts after the displayed rows, so it cannot permanently skip
      // matches when one explicit request adds fewer than twenty records.
      if (current.page && current.status === 'ready' && !existing) current.windows.set(selected.page, { offset, count: limit });
      return { items, external: snapshot(current), offset, limit };
    };
    let spec;
    try { spec = buildRequest(selected, Math.max(1, current.page + 1)); }
    catch (problem) { cancel(current); current.status = 'error'; current.error = problem.message; return output([]); }
    current.unsupported = spec.unsupported; current.localFilters = spec.localFilters;
    if (selected.source === 'chartshub' || spec.unsupported.length) { if (current.controller) cancel(current); return output([]); }
    if (!spec.endpoint) { if (current.controller) cancel(current); current.error = selected.source === 'chorusencore' || selected.externalSearch ? failure('ENCHOR_INVALID_QUERY').message : null; return output([]); }
    const required = Math.max(0, offset + (existing ? existing.count : 20) - nativeCount);
    if (!selected.externalSearch || current.status === 'ready' && current.page && (required <= current.items.length || !current.hasMore)) return output();
    if (!active) throw failure();
    if (retryUntil > now()) { current.status = 'cooldown'; return output(); }
    if (typeof client.enchorStatus !== 'function' || typeof client.enchorSearch !== 'function') { current.status = 'error'; current.error = 'La recherche ChorusEncore est indisponible dans cette connexion.'; return output(); }
    // A new submit replaces a pending request. Await its bounded cancellation
    // before issuing another transport, including requests from the other view.
    cancel(current); const expected = current.generation, controller = new AbortController(); current.controller = controller;
    current.status = 'loading'; current.error = null;
    const guard = () => { if (!active || controller.signal.aborted || expected !== current.generation) throw Object.assign(Error('Recherche ChorusEncore remplacée.'), { name: 'AbortError' }); };
    const wait = async promise => {
      guard(); let aborted;
      const interrupt = new Promise((_resolve, reject) => { aborted = () => reject(Object.assign(Error('Recherche ChorusEncore remplacée.'), { name: 'AbortError' })); controller.signal.addEventListener('abort', aborted, { once: true }); });
      try { return await Promise.race([promise, interrupt]); } finally { controller.signal.removeEventListener('abort', aborted); }
    };
    const work = transport.catch(() => {}).then(async () => {
      guard();
      try {
        const availability = normalizeStatus(await wait(client.enchorStatus({ signal: controller.signal }))); guard();
        enabled = availability.enabled; suspended = availability.suspended;
        if (availability.retryAfterSeconds) retryUntil = Math.max(retryUntil, now() + Math.min(availability.retryAfterSeconds * 1000, Number.MAX_SAFE_INTEGER - now()));
        if (!enabled) { current.status = 'disabled'; current.error = failure('ENCHOR_DISABLED').message; return; }
        if (suspended) { current.status = 'suspended'; current.error = failure('ENCHOR_ACCESS_DENIED').message; return; }
        if (retryUntil > now()) { current.status = 'cooldown'; return; }
        if (current.page && (required <= current.items.length || !current.hasMore)) { current.status = 'ready'; return; }
        const result = normalizeResult(await wait(client.enchorSearch({ endpoint: spec.endpoint, body: { ...spec.body, page: current.page + 1 }, signal: controller.signal })), current.page + 1); guard();
        const seen = new Set(current.items.map(item => item.id));
        const additions = result.charts.filter(item => !seen.has(item.id) && seen.add(item.id) && spec.localFilters.every(key => key === 'year' ? normalizeMetadata(item.year) === normalizeMetadata(selected.year) : contains(item[key], selected[key])));
        if (current.items.length + additions.length > 20000 || Buffer.byteLength(JSON.stringify([...current.items, ...additions])) > 32 * 1024 * 1024) throw failure('ENCHOR_INVALID_RESPONSE');
        current.items = [...current.items, ...additions]; current.page = result.page; current.total = result.found; current.hasMore = result.hasMore; current.status = 'ready'; current.error = null;
      } catch (problem) {
        if (controller.signal.aborted || expected !== current.generation || !active) throw problem;
        const known = typeof problem?.code === 'string' && problem.code.startsWith('ENCHOR_') ? problem : failure();
        if (Number.isSafeInteger(known.retryAfterSeconds) && known.retryAfterSeconds > 0) retryUntil = Math.max(retryUntil, now() + Math.min(known.retryAfterSeconds * 1000, Number.MAX_SAFE_INTEGER - now()));
        if (known.code === 'ENCHOR_DISABLED') enabled = false;
        if (['ENCHOR_ACCESS_DENIED', 'ENCHOR_RECOVERY_REQUIRED'].includes(known.code)) suspended = true;
        current.status = retryUntil > now() ? 'cooldown' : !enabled && enabled !== null ? 'disabled' : suspended ? 'suspended' : 'error'; current.error = failure(known.code).message;
      } finally { if (current.controller === controller) current.controller = null; }
    });
    transport = work.catch(() => {}); await work; guard();
    return output();
  }
  function lookup(id) { for (const current of scopes.values()) { const item = current.items.find(item => item.id === id); if (item) return item; } return null; }
  function stop() { active = false; for (const current of scopes.values()) cancel(current); scopes.clear(); enabled = null; suspended = false; retryUntil = 0; }
  function start() { active = true; }
  return { search, lookup, stop, start, prepare, isCurrent, cancelScope };
}
module.exports = { createExternalCatalogue };
