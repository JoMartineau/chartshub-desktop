'use strict';

const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createLibraryCleanup } = require('./library-cleanup.cjs');
const { revalidateBundle, recheckBundleIdentity } = require('./chart-bundle.cjs');

const HEX = /^[a-f0-9]{64}$/, TOKEN = /^[a-f0-9]{32}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeError = () => Object.assign(Error('Ce nettoyage groupé n’est plus vérifié. Préparez une nouvelle sélection.'), { code: 'LIBRARY_CLEANUP_SAFE' });
const failedReason = 'La mise à la corbeille n’a pas pu être vérifiée ou effectuée. Préparez une nouvelle sélection.';
const historyWarning = 'Le nettoyage est terminé, mais son historique n’a pas pu être enregistré.';
const copy = value => structuredClone(value);
const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
const contains = (parent, child) => canonical(parent) === canonical(child) || canonical(child).startsWith(canonical(parent) + '/');
const overlaps = (left, right) => contains(left, right) || contains(right, left);
const empty = options => { if (!object(options) || Object.keys(options).length) throw safeError(); };

/** One frozen global selection, one index commit. Only native recycling can
 * mutate songs; preparation and review never authorize or perform a recycle. */
function createLibraryBulkCleanup({ getDocument, duplicates, recycle, onChange = () => {}, onCleaned = async () => {}, onCompleted = async () => {} }) {
  let plan = null, operation = null, stopping = null;
  const pending = new Set();
  const track = task => { pending.add(task); task.then(() => pending.delete(task), () => pending.delete(task)); return task; };
  const notify = () => { try { onChange(); } catch {} };
  const status = () => operation ? { phase: operation.phase, processed: operation.processed, total: operation.total } : null;
  function invalidate() {
    plan?.controller.abort(); plan = null;
    operation?.controller.abort(); operation?.child?.invalidate();
  }
  function ready() { if (operation || stopping) throw safeError(); }
  function current(value) {
    const document = getDocument();
    if (value.controller.signal.aborted || document.items !== value.items || document.revision !== value.revision
      || document.settings.rootPath !== value.rootPath) throw safeError();
  }
  function groupsFor(value, candidates) {
    const ids = new Set(candidates.map(candidate => candidate.keeperId));
    return value.groups.filter(group => ids.has(group.keep.id));
  }
  async function preferences(value, groups = value.groups) {
    current(value);
    for (const group of groups) { await duplicates.validateCleanupReceipt(group.source); current(value); }
  }
  function publicPlan(value) {
    return copy({ planId: value.planId, revision: value.revision, keepers: value.keepers, candidates: value.candidates, summary: value.summary });
  }
  function safeTargets(value, candidates = value.candidates) {
    const ids = new Set(), keeperIds = new Set(value.keepers.map(keeper => keeper.id));
    for (const candidate of candidates) {
      if (ids.has(candidate.id) || keeperIds.has(candidate.id) || !candidate.targetRelativePath || candidate.eligible || !candidate.forceable
        || !value.keepers.some(keeper => keeper.id === candidate.keeperId)
        || value.keepers.some(keeper => overlaps(keeper.targetRelativePath, candidate.targetRelativePath))
        || candidates.some(other => other.id !== candidate.id && overlaps(other.targetRelativePath, candidate.targetRelativePath))
        || value.items.some(item => item.id !== candidate.id && contains(candidate.targetRelativePath, item.relativePath))) throw safeError();
      ids.add(candidate.id);
    }
  }
  async function prepare(options = {}) {
    ready(); empty(options); invalidate();
    const document = getDocument();
    if (!document.settings.rootPath || !path.isAbsolute(document.settings.rootPath)) throw safeError();
    const value = { rootPath: document.settings.rootPath, revision: document.revision, items: document.items,
      controller: new AbortController(), planId: randomBytes(16).toString('hex'), groups: [], keepers: [], candidates: [],
      phase: 'preparing', processed: 0, total: 0, child: null };
    operation = value; notify();
    let blockedGroups = 0, identicalGroups = 0;
    try {
      const summary = await duplicates.collectCleanupContexts({ signal: value.controller.signal,
        onGroup: async (group, processed, total) => {
          current(value); value.total = total; notify();
          if (group) {
            const child = createLibraryCleanup({ getDocument, recycle: async () => { throw safeError(); },
              getContext: async () => { current(value); const source = await duplicates.validateCleanupReceipt(group.source); current(value); return source; } });
            value.child = child;
            try {
              const prepared = await child.prepare({ contextId: group.source.contextId, revision: value.revision, keepId: group.source.keepId });
              current(value);
              const candidates = prepared.candidates.filter(candidate => candidate.forceable && !candidate.eligible)
                .map(candidate => ({ ...candidate, keeperId: prepared.keepId }));
              if (candidates.length) {
                const keep = { ...prepared.keep, title: group.title, artist: group.artist, charter: group.charter };
                value.groups.push({ source: group.source, keep }); value.keepers.push(keep); value.candidates.push(...candidates);
              } else if (prepared.candidates.some(candidate => !candidate.eligible)) blockedGroups++;
              else identicalGroups++;
            } finally { await child.stop(); value.child = null; }
          }
          value.processed = processed; notify();
        } });
      await preferences(value); safeTargets(value);
      value.summary = { ...summary, blockedGroups: summary.blockedGroups + blockedGroups,
        readyGroups: value.groups.length, identicalGroups, candidateCount: value.candidates.length };
      current(value); plan = value;
      return publicPlan(value);
    } catch (_) { value.controller.abort(); throw safeError(); }
    finally { if (operation === value) operation = null; notify(); }
  }
  function selection(options) {
    if (!object(options) || Object.keys(options).some(key => !['planId', 'revision', 'ids'].includes(key))
      || typeof options.planId !== 'string' || !TOKEN.test(options.planId) || !Number.isSafeInteger(options.revision) || options.revision < 0
      || !Array.isArray(options.ids) || !options.ids.length || options.ids.length > 10000
      || options.ids.some(id => typeof id !== 'string' || !HEX.test(id)) || new Set(options.ids).size !== options.ids.length) throw safeError();
    return { planId: options.planId, revision: options.revision, ids: [...options.ids] };
  }
  async function selected(value, request) {
    if (!value || plan !== value || value.planId !== request.planId || value.revision !== request.revision) throw safeError();
    const candidates = request.ids.map(id => value.candidates.find(candidate => candidate.id === id));
    if (candidates.some(candidate => !candidate)) throw safeError();
    safeTargets(value, candidates); await preferences(value, groupsFor(value, candidates));
    if (plan !== value) throw safeError();
    return candidates;
  }
  function member(value, candidate, keeper = false) {
    const group = value.groups.find(group => group.keep.id === candidate.keeperId);
    const item = group?.source.members.find(item => item.id === (keeper ? candidate.keeperId : candidate.id));
    if (!item?.bundle || item.bundle.status !== 'verified') throw safeError();
    return { group, item, options: { rootPath: value.rootPath, relativePath: item.relativePath, format: item.format,
      expected: item.bundle, signal: value.controller.signal } };
  }
  async function checkedMember(value, candidate, keeper, full) {
    current(value);
    const record = member(value, candidate, keeper), expected = keeper ? record.group.keep : candidate;
    const target = await (full ? revalidateBundle : recheckBundleIdentity)(record.options);
    current(value);
    if (!target || !path.isAbsolute(target) || path.relative(value.rootPath, target) !== expected.targetRelativePath.split('/').join(path.sep)) throw safeError();
    return target;
  }
  async function checkBatch(value, candidates, full) {
    const checkedKeepers = new Set();
    for (const candidate of candidates) {
      try {
        if (!checkedKeepers.has(candidate.keeperId)) { await checkedMember(value, candidate, true, full); checkedKeepers.add(candidate.keeperId); }
        await checkedMember(value, candidate, false, full);
      } catch (_) { throw Object.assign(safeError(), { candidateId: candidate.id }); }
    }
  }
  async function review(options) {
    ready();
    try {
      const request = selection(options), value = plan, candidates = await selected(value, request);
      await checkBatch(value, candidates, false); await preferences(value, groupsFor(value, candidates));
      if (plan !== value) throw safeError();
      return copy({ planId: value.planId, revision: value.revision, keepers: groupsFor(value, candidates).map(group => group.keep), candidates });
    } catch (_) { throw safeError(); }
  }
  async function execute(options) {
    ready();
    const request = selection(options), value = plan;
    if (!value) throw safeError();
    value.phase = 'executing'; value.processed = 0; value.total = request.ids.length; operation = value; notify();
    const result = { recycledIds: [], failed: [], cancelled: false, refreshRequested: false };
    let candidates = [], attempted = false;
    try {
      candidates = await selected(value, request); attempted = true;
      // Rehash every selected copy and every keeper before the first mutation.
      // A bad last copy must not allow earlier copies to reach the native bin.
      await checkBatch(value, candidates, true);
      await checkBatch(value, candidates, false);
      await preferences(value, groupsFor(value, candidates));
      for (const candidate of candidates) {
        try {
          await preferences(value, groupsFor(value, candidates));
          await checkedMember(value, candidate, true, true);
          const target = await checkedMember(value, candidate, false, true);
          // Close the hashing window and protect all keepers, not just this group.
          for (const group of groupsFor(value, candidates)) {
            const representative = candidates.find(copy => copy.keeperId === group.keep.id);
            await checkedMember(value, representative, true, false);
          }
          if (await checkedMember(value, candidate, false, false) !== target) throw safeError();
          await preferences(value, groupsFor(value, candidates)); current(value);
          const kept = member(value, candidate, true).item, copyMember = member(value, candidate, false).item;
          await recycle(target, { rootPath: value.rootPath,
            keeper: { relativePath: kept.relativePath, format: kept.format, expected: kept.bundle },
            target: { relativePath: copyMember.relativePath, format: copyMember.format, expected: copyMember.bundle } });
          result.recycledIds.push(candidate.id); value.processed++; notify();
        } catch (_) {
          if (value.controller.signal.aborted) result.cancelled = true;
          else result.failed.push({ id: candidate.id, reason: failedReason });
          break;
        }
      }
    } catch (failure) {
      if (value.controller.signal.aborted) result.cancelled = true;
      else if (attempted) result.failed.push({ id: failure.candidateId ?? candidates[0].id, reason: failedReason });
      else throw safeError();
    } finally {
      if (value.controller.signal.aborted) result.cancelled = true;
      value.controller.abort(); if (plan === value) plan = null;
      if (attempted) {
        for (const group of groupsFor(value, candidates)) {
          const chosen = candidates.filter(candidate => candidate.keeperId === group.keep.id), ids = new Set(chosen.map(candidate => candidate.id));
          try {
            const record = await onCompleted({ rootPath: value.rootPath, keep: copy(group.keep), candidates: copy(chosen), mode: 'force',
              result: { recycledIds: result.recycledIds.filter(id => ids.has(id)), failed: result.failed.filter(failure => ids.has(failure.id)), cancelled: result.cancelled } });
            if (record?.recorded === false) result.historyError = historyWarning;
          } catch (_) { result.historyError = historyWarning; }
        }
        try { await onCleaned({ rootPath: value.rootPath, revision: value.revision, items: value.items,
          keeperIds: value.keepers.map(keeper => keeper.id), recycledIds: [...result.recycledIds] }); } catch (_) {}
      }
      if (operation === value) operation = null; notify();
    }
    return result;
  }
  async function cancel(options = {}) { empty(options); invalidate(); await Promise.allSettled([...pending]); return true; }
  async function stop() {
    if (stopping) return stopping;
    invalidate(); stopping = Promise.allSettled([...pending]);
    try { await stopping; } finally { stopping = null; }
  }
  return { prepare: options => track(prepare(options)), review: options => track(review(options)), execute: options => track(execute(options)),
    cancel, stop, invalidate, status, busy: () => operation !== null };
}

module.exports = { createLibraryBulkCleanup };
