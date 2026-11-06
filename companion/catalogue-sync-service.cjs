'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createCatalogueSyncStore, UUID } = require('./catalogue-sync-store.cjs');
const { validateDescriptor, syncError, MAX_TOTAL, HASH } = require('./catalogue-sync-client.cjs');
const { rootContext } = require('./download-worker.cjs');
const { safePart } = require('../download.js');
const safeFolder = value => typeof value === 'string' && value.length < 32700 && value.split('/').length <= 32 && value.split('/').every(part => safePart(part) && !part.startsWith('.'));
const ACTIVE = new Set(['analyzing', 'running']);
const TASK_STATES = new Set(['new', 'update', 'unchanged', 'conflict', 'failed', 'completed']);
const emptyCounts = () => ({ new: 0, update: 0, unchanged: 0, conflict: 0, failed: 0, completed: 0 });
const interrupted = problem => problem?.name === 'AbortError' || problem?.code === 'ABORT_ERR';
const safeCode = problem => /^(SYNC_|DOWNLOAD_)[A-Z_]+$/.test(problem?.code) ? problem.code : 'SYNC_FAILED';

function createCatalogueSyncService({ dataDirectory, catalogue, worker, getContext, onChange, onInstalled, onStarting, onSettled, store = createCatalogueSyncStore({ dataDirectory }) }) {
  if (typeof catalogue?.page !== 'function' || typeof worker?.inspect !== 'function' || typeof worker?.run !== 'function' || typeof getContext !== 'function') throw syncError('SYNC_INVALID');
  let state = { version: 1, phase: 'idle', mode: 'all', rootPath: null, rootIdentity: null, jobId: null, revision: null,
    total: 0, analyzed: 0, pageCount: 0, analysisComplete: false, counts: emptyCounts(), receivedBytes: 0, concurrency: 2, includeVideo: false, error: null };
  let loaded = false, protectedState = false, controller = null, task = null, lastNotify = 0, changedLibrary = false, commandPending = false, intent = 0;
  let recent = [], live = new Map(), writes = Promise.resolve();
  const serial = callback => { const pending = writes.then(callback); writes = pending.catch(() => {}); return pending; };
  const checkIntent = expected => { if (expected !== intent) throw Object.assign(Error('Paused'), { name: 'AbortError', code: 'ABORT_ERR' }); };
  const reserved = fn => async (...args) => {
    if (commandPending) throw syncError('SYNC_BUSY'); commandPending = true;
    try { return await fn(intent, ...args); } finally { commandPending = false; }
  };
  function status() {
    const { version, rootIdentity, jobId, revision, pageCount, analysisComplete, analyzed, ...value } = state;
    return { ...value, canResume: state.analysisComplete, counts: { ...state.counts }, revision: `${jobId || 'idle'}:${generation}`,
      processed: state.phase === 'analyzing' ? analyzed : state.counts.unchanged + state.counts.conflict + state.counts.failed + state.counts.completed,
      receivedBytes: state.receivedBytes + [...live.values()].reduce((sum, item) => sum + item.receivedBytes, 0),
      items: [...live.values(), ...recent].slice(0, 50).map(item => ({ chartId: item.chartId, title: item.title, artist: item.artist, state: item.state, error: item.error || null })) };
  }
  let generation = 0;
  function notify(force = false) {
    generation++;
    if (!force && Date.now() - lastNotify < 200) return;
    lastNotify = Date.now(); try { onChange?.(status()); } catch {}
  }
  const save = () => store.writeState({ ...state, counts: { ...state.counts } });
  function checkAllowed(root = state.rootPath) {
    const context = getContext();
    if (!context?.active || context.busy || !context.rootPath || path.resolve(context.rootPath) !== path.resolve(root || '')) throw syncError('SYNC_CONTEXT');
    if (protectedState) throw syncError('SYNC_STORAGE');
    return context;
  }
  function validateTask(item) {
    validateDescriptor(item);
    if (!UUID.test(item.id) || !TASK_STATES.has(item.state) || !['new', 'update', 'unchanged', 'conflict', 'failed'].includes(item.kind)
        || !(item.candidateFolder === undefined || safeFolder(item.candidateFolder))) throw syncError('SYNC_STORAGE');
    return item;
  }
  async function recount() {
    const counts = emptyCounts(); let received = 0;
    for (let page = 0; page < state.pageCount; page++) {
      const items = await store.loadPage(state.jobId, page);
      for (const item of items) {
        validateTask(item);
        if (item.kind === 'new' || item.kind === 'update') counts[item.kind]++;
        if (!['new', 'update'].includes(item.state)) counts[item.state]++;
        received += item.receivedBytes || 0;
      }
    }
    state.counts = counts; state.receivedBytes = received;
  }
  async function load() {
    if (loaded) return status();
    try {
      const saved = await store.readState();
      if (saved) {
        if (saved.version !== 1 || !['idle', 'analyzing', 'ready', 'running', 'paused', 'completed', 'error'].includes(saved.phase)
            || !['all', 'installed'].includes(saved.mode) || !Number.isInteger(saved.concurrency) || saved.concurrency < 1 || saved.concurrency > 4
            || typeof saved.includeVideo !== 'boolean' || !Number.isInteger(saved.pageCount) || saved.pageCount < 0 || saved.pageCount > MAX_TOTAL
            || !Number.isInteger(saved.total) || saved.total < 0 || saved.total > MAX_TOTAL
            || typeof saved.analysisComplete !== 'boolean' || !Number.isInteger(saved.analyzed) || saved.analyzed < 0 || saved.analyzed > MAX_TOTAL
            || !Number.isSafeInteger(saved.receivedBytes) || saved.receivedBytes < 0
            || !saved.counts || Object.keys(emptyCounts()).some(key => !Number.isSafeInteger(saved.counts[key]) || saved.counts[key] < 0 || saved.counts[key] > MAX_TOTAL)
            || !(saved.error === null || typeof saved.error === 'string' && /^(SYNC_|DOWNLOAD_)[A-Z_]{1,80}$/.test(saved.error))
            || !(saved.rootIdentity === null || typeof saved.rootIdentity === 'string' && /^u64:[0-9]+:[0-9]+$/.test(saved.rootIdentity))
            || saved.jobId !== null && !UUID.test(saved.jobId) || saved.revision !== null && !HASH.test(saved.revision)
            || saved.rootPath !== null && (typeof saved.rootPath !== 'string' || !path.isAbsolute(saved.rootPath))) throw syncError('SYNC_STORAGE');
        state = saved;
        if (ACTIVE.has(state.phase)) { state.phase = 'paused'; state.error = state.analysisComplete ? null : 'SYNC_ANALYSIS_INTERRUPTED'; }
        if (state.jobId) await recount();
      }
    } catch { protectedState = true; state.phase = 'error'; state.error = 'SYNC_STORAGE'; }
    loaded = true; notify(true); return status();
  }
  function launch(callback) {
    const current = new AbortController(); controller = current;
    const work = Promise.resolve().then(() => callback(current.signal)).catch(async problem => {
      const fatal = ['SYNC_STORAGE', 'SYNC_NO_SPACE'].includes(problem?.code);
      state.phase = !fatal && (interrupted(problem) || current.signal.aborted) ? 'paused' : 'error';
      state.error = state.phase === 'paused' ? null : safeCode(problem);
      try { await serial(save); } catch { state.error = 'SYNC_STORAGE'; }
    }).finally(async () => {
      live.clear();
      const changed = changedLibrary; changedLibrary = false;
      try { await onSettled?.({ changed, rootPath: state.rootPath }); } catch {}
      if (controller === current) controller = null;
      if (task === work) task = null;
      notify(true);
    });
    task = work; notify(true); return status();
  }
  function legacyCandidate(endpoint, context) {
    const entry = context.completedDownloads?.find(item => item.endpoint === endpoint && item.rootPath === state.rootPath);
    return typeof entry?.destination === 'string' && path.dirname(entry.destination) === state.rootPath ? path.basename(entry.destination) : undefined;
  }
  async function analyze(options = {}, expected = intent) {
    await load(); checkIntent(expected); if (task) throw syncError('SYNC_BUSY');
    const context = getContext(), rootPath = context?.rootPath;
    if (typeof context?.completedDownloads === 'function') context.completedDownloads = context.completedDownloads();
    checkAllowed(rootPath);
    const mode = options.mode || state.mode, concurrency = options.concurrency ?? state.concurrency, includeVideo = options.includeVideo ?? state.includeVideo;
    if (!['all', 'installed'].includes(mode) || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4 || typeof includeVideo !== 'boolean') throw syncError('SYNC_INVALID');
    const root = await rootContext(rootPath);
    checkIntent(expected);
    state = { ...state, phase: 'analyzing', mode, concurrency, includeVideo, rootPath: root.root, rootIdentity: root.rootIdentity,
      jobId: randomUUID(), revision: null, total: 0, analyzed: 0, pageCount: 0, analysisComplete: false, counts: emptyCounts(), receivedBytes: 0, error: null };
    recent = []; await serial(save); checkIntent(expected);
    return launch(async signal => {
      let offset = 0, relevant = 0; const seen = new Set();
      do {
        signal.throwIfAborted(); checkAllowed(); await root.guard();
        const page = await catalogue.page({ offset, revision: state.revision, signal });
        if (page.total > MAX_TOTAL || state.revision && page.revision !== state.revision) throw syncError('SYNC_CATALOGUE_CHANGED');
        state.revision = page.revision; state.total = mode === 'all' ? page.total : relevant;
        const items = [];
        for (const descriptor of page.items) {
          signal.throwIfAborted(); checkAllowed(); validateDescriptor(descriptor);
          if (seen.has(descriptor.endpoint)) throw syncError('SYNC_INVALID'); seen.add(descriptor.endpoint);
          const record = await store.readRecord(state.rootPath, descriptor.endpoint);
          let candidateFolder = record ? undefined : legacyCandidate(descriptor.endpoint, context), candidateConflict = false;
          if (!record && !candidateFolder && typeof context.findCandidate === 'function') {
            const candidate = await context.findCandidate({ descriptor, rootPath: state.rootPath, signal });
            if (candidate?.conflict) candidateConflict = true;
            else if (candidate?.candidateFolder) { if (!safeFolder(candidate.candidateFolder)) throw syncError('SYNC_INVALID'); candidateFolder = candidate.candidateFolder; }
          }
          if (mode === 'installed' && !record && !candidateFolder && !candidateConflict) continue;
          relevant++;
          const item = { ...descriptor, id: randomUUID(), state: 'new', kind: 'new', ...(candidateFolder ? { candidateFolder } : {}) };
          try {
            // No per-chart HTTP request for new entries during planning. The
            // worker validates collisions and the fresh manifest before writing.
            const result = candidateConflict ? { state: 'conflict', reason: 'SYNC_EXISTING_AMBIGUOUS' } : record || candidateFolder ? await worker.inspect({ endpoint: item.endpoint, rootPath: state.rootPath, record, candidateFolder, includeVideo, remote: descriptor, signal }) : { state: 'new' };
            if (!['new', 'update', 'unchanged', 'conflict'].includes(result.state)) throw syncError('SYNC_INVALID');
            item.state = item.kind = result.state; item.error = result.reason || null;
            if (result.record && result.record !== record && JSON.stringify(result.record) !== JSON.stringify(record)) await store.writeRecord(state.rootPath, item.endpoint, result.record);
          } catch (problem) {
            if (interrupted(problem) || signal.aborted) throw problem;
            if (problem?.code === 'SYNC_STORAGE') throw problem;
            item.state = item.kind = 'failed'; item.error = safeCode(problem);
          }
          items.push(item); state.counts[item.state]++; state.analyzed++;
          recent.unshift(item); if (recent.length > 50) recent.length = 50;
          if (mode === 'installed') state.total = relevant;
          notify();
        }
        await store.savePage(state.jobId, state.pageCount, items); state.pageCount++; await serial(save);
        offset = page.nextOffset;
      } while (offset !== null);
      state.analysisComplete = true; state.phase = 'ready'; await serial(save); notify(true);
    });
  }
  async function execute(signal) {
    const root = await rootContext(state.rootPath);
    if (root.rootIdentity !== state.rootIdentity) throw syncError('SYNC_CONTEXT');
    for (let pageNumber = 0; pageNumber < state.pageCount; pageNumber++) {
      signal.throwIfAborted(); checkAllowed(); await root.guard();
      const entries = await store.loadPage(state.jobId, pageNumber); entries.forEach(validateTask); let cursor = 0;
      const results = await Promise.allSettled(Array.from({ length: state.concurrency }, async () => { try {
        while (cursor < entries.length && !signal.aborted) {
          const index = cursor++, entry = entries[index];
          if (!['new', 'update'].includes(entry.state)) continue;
          signal.throwIfAborted(); checkAllowed(); await root.guard();
          const liveEntry = { ...entry, state: 'running', receivedBytes: 0 }; live.set(entry.id, liveEntry); notify();
          let installed = null, finalizedRecord = null;
          try {
            const record = await store.readRecord(state.rootPath, entry.endpoint);
            const result = await worker.run({ id: entry.id, endpoint: entry.endpoint, rootPath: state.rootPath, record,
              candidateFolder: entry.candidateFolder, includeVideo: state.includeVideo, signal, onProgress: value => {
                if (Number.isSafeInteger(value.receivedBytes) && value.receivedBytes >= 0) liveEntry.receivedBytes = value.receivedBytes;
                notify();
              } });
            if (!result?.record || typeof result.changed !== 'boolean') throw syncError('SYNC_INVALID');
            // Provenance is durable before marking the task complete. A restart
            // after this boundary verifies it instead of installing a duplicate.
            // A pending task verified in place may already have been promoted
            // just before an earlier process stopped. Refresh the index once
            // for the batch even when recovery performs no new file writes.
            changedLibrary = true;
            await store.writeRecord(state.rootPath, entry.endpoint, result.record);
            finalizedRecord = result.record;
            entry.state = result.changed ? 'completed' : 'unchanged'; entry.error = null;
            entry.receivedBytes = Number.isSafeInteger(result.receivedBytes) && result.receivedBytes >= 0 ? result.receivedBytes : 0;
            if (result.changed) installed = { ...entry, rootPath: state.rootPath, destination: result.destination, files: result.files, totalBytes: result.totalBytes };
          } catch (problem) {
            if (problem?.code === 'SYNC_STORAGE') { controller?.abort(); throw problem; }
            if (problem?.code === 'ENOSPC' || problem?.code === 'SYNC_NO_SPACE') throw syncError('SYNC_NO_SPACE');
            if (interrupted(problem) || signal.aborted) throw problem;
            entry.state = /CONFLICT|LOCAL_CHANGED/.test(problem?.code || '') ? 'conflict' : 'failed'; entry.error = safeCode(problem); entry.receivedBytes = 0;
          } finally { live.delete(entry.id); }
          await serial(async () => {
            await store.append(state.jobId, pageNumber, { index, state: entry.state, error: entry.error, receivedBytes: entry.receivedBytes });
            // Never report an install before its completion is durable: an
            // interrupted journal append may replay a recovered update.
            if (installed) { try { await onInstalled?.(installed); } catch {} }
            // A durable receipt and task completion permit deleting only owned
            // staging data; old-chart backups and unexpected files stay intact.
            if (finalizedRecord) { try { await worker.finalize?.({ id: entry.id, endpoint: entry.endpoint, rootPath: state.rootPath, record: finalizedRecord }); } catch {} }
            state.counts[entry.state]++; state.receivedBytes += entry.receivedBytes;
            recent.unshift(entry); if (recent.length > 50) recent.length = 50;
            await save(); notify();
          });
        }
      } catch (problem) { controller?.abort(); throw problem; } }));
      const failure = results.find(result => result.status === 'rejected' && ['SYNC_STORAGE', 'SYNC_NO_SPACE'].includes(result.reason?.code))
        || results.find(result => result.status === 'rejected' && !interrupted(result.reason)) || results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    }
    signal.throwIfAborted(); state.phase = 'completed'; await serial(save); notify(true);
  }
  async function start(expected = intent) {
    await load(); checkIntent(expected); if (task) throw syncError('SYNC_BUSY'); checkAllowed();
    if (!state.analysisComplete || !['ready', 'paused', 'error'].includes(state.phase)) throw syncError('SYNC_ANALYZE_FIRST');
    await onStarting?.({ rootPath: state.rootPath });
    try { checkIntent(expected); changedLibrary ||= state.counts.completed > 0; state.phase = 'running'; state.error = null; await serial(save); checkIntent(expected); return launch(execute); }
    catch (problem) { const changed = changedLibrary; changedLibrary = false; await onSettled?.({ changed, rootPath: state.rootPath }); throw problem; }
  }
  async function pause() {
    intent++;
    controller?.abort(); if (task) await task;
    if (['ready', 'running', 'analyzing'].includes(state.phase)) state.phase = 'paused';
    if (loaded && !protectedState && state.jobId) await serial(save); notify(true); return status();
  }
  async function retry(expected = intent) {
    await load(); checkIntent(expected); if (task) throw syncError('SYNC_BUSY'); checkAllowed();
    if (!state.analysisComplete) throw syncError('SYNC_ANALYZE_FIRST');
    // A fresh namespace compacts page journals on explicit retry, without
    // rewriting a100,000-entry plan at each completion.
    const previousJob = state.jobId, nextJob = randomUUID();
    for (let pageNumber = 0; pageNumber < state.pageCount; pageNumber++) {
      checkIntent(expected);
      const entries = await store.loadPage(previousJob, pageNumber);
      for (const item of entries) if (item.state === 'failed') { item.state = item.kind === 'update' ? 'update' : 'new'; item.error = null; }
      await store.savePage(nextJob, pageNumber, entries);
    }
    checkIntent(expected); state.jobId = nextJob; state.phase = 'ready'; state.error = null; await recount(); await serial(save); return start(expected);
  }
  return { load, status, analyze: reserved((ticket, options) => analyze(options || {}, ticket)), start: reserved(ticket => start(ticket)), resume: reserved(ticket => start(ticket)), pause, retry: reserved(ticket => retry(ticket)), stop: pause, whenIdle: async () => { await task; await writes; return status(); }, isBusy: () => !!task || commandPending };
}
module.exports = { createCatalogueSyncService };
