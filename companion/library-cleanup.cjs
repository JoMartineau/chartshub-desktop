'use strict';

const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { inspectChartBundle, revalidateBundle, recheckBundleIdentity } = require('./chart-bundle.cjs');

const HEX = /^[a-f0-9]{64}$/, TOKEN = /^[a-f0-9]{32}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeError = () => Object.assign(new Error('Ce nettoyage ne peut pas être vérifié. Recomparez les versions et préparez un nouveau nettoyage.'), { code: 'LIBRARY_CLEANUP_SAFE' });
const reason = {
  unavailable: 'Le contenu complet de cette version ne peut pas être vérifié.',
  keep: 'La version à conserver ne peut pas être vérifiée intégralement.',
  audio: 'Les fichiers audio sont absents, différents ou non vérifiés.',
  notes: 'Le contenu ou le format des notes est différent.',
  contents: 'Cette version contient des fichiers différents ou supplémentaires.',
  target: 'Cette cible partage son emplacement avec une autre version ou la bibliothèque.',
  failed: 'La mise à la corbeille n’a pas pu être vérifiée ou effectuée. Recomparez les versions avant de réessayer.'
};
function relative(value) {
  return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !/[\\:\u0000-\u001f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
}
const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
function contains(parent, child) {
  const left = canonical(parent), right = canonical(child);
  return left === right || right.startsWith(left + '/');
}
const overlaps = (left, right) => contains(left, right) || contains(right, left);
function audio(value) {
  return { status: value?.status ?? 'unavailable', count: Number.isSafeInteger(value?.count) ? value.count : 0, bytes: Number.isSafeInteger(value?.bytes) ? value.bytes : 0 };
}
function summary(member, bundle) {
  return {
    id: member.id, relativePath: member.relativePath,
    targetRelativePath: relative(bundle?.targetRelativePath) ? bundle.targetRelativePath : null,
    kind: bundle?.kind ?? null, bytes: Number.isSafeInteger(bundle?.totalBytes) ? bundle.totalBytes : null,
    audio: audio(bundle?.audio)
  };
}
function copySummary(value) { return { ...value, audio: { ...value.audio } }; }

/** Plans expose only IDs and relative labels. Only the checked executor can
 * cross the native recycling boundary; there is no permanent-delete fallback. */
function createLibraryCleanup({ getDocument, getContext, recycle, onCleaned = async () => {} } = {}) {
  if (typeof getDocument !== 'function' || typeof getContext !== 'function' || typeof recycle !== 'function' || typeof onCleaned !== 'function') throw safeError();
  let plan = null, preparing = null, executing = null, stopping = null;
  const pending = new Set();
  function track(task) {
    pending.add(task); task.then(() => pending.delete(task), () => pending.delete(task)); return task;
  }
  function invalidate() {
    preparing?.controller.abort(); preparing = null;
    plan?.controller.abort(); plan = null;
    executing?.controller.abort();
  }
  function ready() { if (stopping || executing) throw safeError(); }
  function assertSnapshot(current) {
    const document = getDocument();
    if (current.controller.signal.aborted || document.revision !== current.revision || document.settings?.rootPath !== current.rootPath || document.items !== current.items) throw safeError();
    return document;
  }
  async function contextFor(current) {
    assertSnapshot(current);
    const checked = await getContext({ contextId: current.contextId, revision: current.revision, keepId: current.keepId });
    assertSnapshot(current);
    if (!checked || checked.contextId !== current.contextId || checked.revision !== current.revision || checked.rootPath !== current.rootPath || checked.keepId !== current.keepId || checked.keepHash !== current.keepHash || checked.keepFormat !== current.keepFormat || checked.preferenceToken !== current.preferenceToken || checked.members.length !== current.members.length || checked.members.some((member, index) => {
      const prior = current.members[index];
      return member.id !== prior.id || member.relativePath !== prior.relativePath || member.format !== prior.format;
    })) throw safeError();
  }
  function publicPlan(current) {
    return { planId: current.planId, contextId: current.contextId, revision: current.revision, keepId: current.keepId, keep: copySummary(current.keep), candidates: current.candidates.map(copySummary) };
  }
  function targetBlocked(current, member, bundle) {
    const target = bundle?.targetRelativePath;
    if (!relative(target) || !contains(target, member.relativePath)) return true;
    if (member.id !== current.keepId && overlaps(target, current.keep.targetRelativePath ?? '')) return true;
    // An indexed chart sharing or nesting under the same target must survive,
    // including charts outside the compared metadata group.
    return current.items.some(item => item.id !== member.id && contains(target, item.relativePath));
  }
  async function runPrepare(options) {
    ready();
    if (!object(options) || Object.keys(options).some(key => !['contextId', 'revision', 'keepId'].includes(key)) || typeof options.contextId !== 'string' || !TOKEN.test(options.contextId) || !Number.isSafeInteger(options.revision) || options.revision < 0 || typeof options.keepId !== 'string' || !HEX.test(options.keepId)) throw safeError();
    const request = { contextId: options.contextId, revision: options.revision, keepId: options.keepId };
    invalidate();
    const marker = { controller: new AbortController() }; preparing = marker;
    try {
      const source = await getContext(request);
      if (preparing !== marker || marker.controller.signal.aborted) throw safeError();
      const document = getDocument();
      if (!source || source.contextId !== request.contextId || source.revision !== request.revision || source.keepId !== request.keepId || source.rootPath !== document.settings?.rootPath || source.revision !== document.revision || !path.isAbsolute(source.rootPath) || !Array.isArray(source.members) || source.members.length < 2 || !HEX.test(source.keepHash) || !['chart', 'midi'].includes(source.keepFormat) || source.members.some(member => !object(member) || typeof member.id !== 'string' || !HEX.test(member.id) || !relative(member.relativePath) || !['chart', 'midi', 'sng'].includes(member.format)) || new Set(source.members.map(member => member.id)).size !== source.members.length) throw safeError();
      const current = { ...source, members: source.members.map(member => ({ ...member })), items: document.items, controller: marker.controller, planId: randomBytes(16).toString('hex'), bundles: new Map(), candidates: [] };
      const keeper = current.members.find(member => member.id === current.keepId);
      if (!keeper) throw safeError();
      const keptBundle = await inspectChartBundle({ rootPath: current.rootPath, relativePath: keeper.relativePath, format: keeper.format, signal: current.controller.signal });
      assertSnapshot(current);
      current.bundles.set(keeper.id, keptBundle); current.keep = summary(keeper, keptBundle);
      const validKeep = keptBundle?.status === 'verified' && keptBundle.notes?.sha256 === current.keepHash && keptBundle.notes?.format === current.keepFormat && !targetBlocked(current, keeper, keptBundle);
      for (const member of current.members) {
        if (member.id === current.keepId) continue;
        assertSnapshot(current);
        const bundle = await inspectChartBundle({ rootPath: current.rootPath, relativePath: member.relativePath, format: member.format, signal: current.controller.signal });
        assertSnapshot(current); current.bundles.set(member.id, bundle);
        const notesMatch = bundle?.notes?.sha256 === keptBundle.notes?.sha256 && bundle?.notes?.format === keptBundle.notes?.format;
        const audioMatch = keptBundle.audio?.status === 'verified' && keptBundle.audio.count > 0 && bundle?.audio?.status === 'verified' && bundle.audio.count > 0
          && HEX.test(keptBundle.audio.digest) && bundle.audio.digest === keptBundle.audio.digest;
        const contentsMatch = bundle?.kind === keptBundle.kind && HEX.test(keptBundle.bundleHash) && bundle?.bundleHash === keptBundle.bundleHash;
        const blockedTarget = bundle?.status === 'verified' ? targetBlocked(current, member, bundle) : true;
        const nonAudioMatch = bundle?.kind === 'folder' && keptBundle.kind === 'folder' && HEX.test(bundle.nonAudioHash) && bundle.nonAudioHash === keptBundle.nonAudioHash;
        let blocked = !validKeep ? reason.keep : bundle?.status !== 'verified' ? reason.unavailable : !notesMatch ? reason.notes : !audioMatch ? reason.audio : !contentsMatch ? reason.contents : blockedTarget ? reason.target : null;
        const forceable = blocked === reason.audio && validKeep && !blockedTarget && nonAudioMatch
          && bundle.audio.status === 'verified' && bundle.audio.count > 0 && keptBundle.audio.status === 'verified' && keptBundle.audio.count > 0
          && HEX.test(bundle.audio.digest) && HEX.test(keptBundle.audio.digest) && bundle.audio.digest !== keptBundle.audio.digest;
        current.candidates.push({ ...summary(member, bundle), eligible: !blocked, forceable, reason: blocked });
      }
      // Even a malformed index cannot authorize overlapping recycle targets.
      for (const candidate of current.candidates) {
        if ((candidate.eligible || candidate.forceable) && current.candidates.some(other => other.id !== candidate.id && other.targetRelativePath && overlaps(candidate.targetRelativePath, other.targetRelativePath))) {
          candidate.eligible = false; candidate.forceable = false; candidate.reason = reason.target;
        }
      }
      await contextFor(current);
      if (preparing !== marker) throw safeError();
      plan = current; preparing = null;
      return publicPlan(current);
    } catch (_) {
      if (preparing === marker) preparing = null;
      marker.controller.abort(); throw safeError();
    }
  }
  function selection(options) {
    if (!object(options) || Object.keys(options).some(key => !['planId', 'revision', 'ids'].includes(key)) || typeof options.planId !== 'string' || !TOKEN.test(options.planId) || !Number.isSafeInteger(options.revision) || options.revision < 0 || !Array.isArray(options.ids) || options.ids.length < 1 || options.ids.some(id => typeof id !== 'string' || !HEX.test(id)) || new Set(options.ids).size !== options.ids.length) throw safeError();
    // Capture before the first asynchronous check; caller mutation never widens
    // the native confirmation or the executor's target selection.
    return { planId: options.planId, revision: options.revision, ids: [...options.ids] };
  }
  async function selected(current, request, force = false) {
    if (!current || plan !== current || current.planId !== request.planId || current.revision !== request.revision) throw safeError();
    const values = request.ids.map(id => current.candidates.find(candidate => candidate.id === id));
    if (values.some(value => !(force ? value?.forceable : value?.eligible) || value.id === current.keepId)) throw safeError();
    await contextFor(current);
    if (plan !== current) throw safeError();
    return values;
  }
  function forceSelection(options) {
    if (!object(options) || Object.keys(options).some(key => !['planId', 'revision', 'id'].includes(key)) || typeof options.planId !== 'string' || !TOKEN.test(options.planId) || !Number.isSafeInteger(options.revision) || options.revision < 0 || typeof options.id !== 'string' || !HEX.test(options.id)) throw safeError();
    return { planId: options.planId, revision: options.revision, ids: [options.id] };
  }
  async function runReview(options, force = false) {
    ready();
    try {
      const request = force ? forceSelection(options) : selection(options), current = plan, values = await selected(current, request, force);
      return { planId: current.planId, revision: current.revision, keep: copySummary(current.keep), candidates: values.map(copySummary) };
    } catch (_) { throw safeError(); }
  }
  async function runExecute(options, force = false) {
    ready();
    const request = force ? forceSelection(options) : selection(options), current = plan;
    if (!current) throw safeError();
    const operation = { controller: current.controller }; executing = operation;
    const result = { recycledIds: [], failed: [], cancelled: false, refreshRequested: false };
    let attempted = false;
    try {
      const values = await selected(current, request, force); attempted = true;
      const keeper = current.members.find(member => member.id === current.keepId);
      for (const candidate of values) {
        if (current.controller.signal.aborted) { result.cancelled = true; break; }
        try {
          await contextFor(current);
          const kept = await revalidateBundle({ rootPath: current.rootPath, relativePath: keeper.relativePath, format: keeper.format, expected: current.bundles.get(keeper.id), signal: current.controller.signal });
          assertSnapshot(current);
          if (!kept) throw safeError();
          const member = current.members.find(value => value.id === candidate.id);
          const checked = await revalidateBundle({ rootPath: current.rootPath, relativePath: member.relativePath, format: member.format, expected: current.bundles.get(member.id), signal: current.controller.signal });
          assertSnapshot(current);
          await contextFor(current);
          // Both hashes can involve large audio. Close that read window with
          // short path/name/stat checks of the keeper and then the target.
          const finalKeep = await recheckBundleIdentity({ rootPath: current.rootPath, relativePath: keeper.relativePath, format: keeper.format, expected: current.bundles.get(keeper.id), signal: current.controller.signal });
          const finalTarget = await recheckBundleIdentity({ rootPath: current.rootPath, relativePath: member.relativePath, format: member.format, expected: current.bundles.get(member.id), signal: current.controller.signal });
          if (!checked || !finalKeep || finalTarget !== checked || !path.isAbsolute(checked) || path.relative(current.rootPath, checked) !== candidate.targetRelativePath.split('/').join(path.sep) || checked === finalKeep || targetBlocked(current, member, current.bundles.get(member.id))) throw safeError();
          assertSnapshot(current);
          await recycle(checked);
          result.recycledIds.push(member.id);
        } catch (_) {
          if (current.controller.signal.aborted) result.cancelled = true;
          else result.failed.push({ id: candidate.id, reason: reason.failed });
          break;
        }
      }
      if (current.controller.signal.aborted) result.cancelled = true;
    } catch (_) {
      if (current.controller.signal.aborted) result.cancelled = true;
      else throw safeError();
    } finally {
      if (plan === current) { current.controller.abort(); plan = null; }
      if (executing === operation) executing = null;
      if (attempted) {
        try { await onCleaned(); result.refreshRequested = true; } catch (_) { /* A refresh failure cannot undo a successful native recycle. */ }
      }
    }
    return result;
  }
  async function stop() {
    if (stopping) return stopping;
    invalidate();
    stopping = (async () => { await Promise.allSettled([...pending]); })();
    try { await stopping; } finally { stopping = null; }
  }
  return {
    prepare: options => track(runPrepare(options)), review: options => track(runReview(options)), forceReview: options => track(runReview(options, true)),
    execute: options => track(runExecute(options)), forceExecute: options => track(runExecute(options, true)),
    invalidate, stop, busy: () => preparing !== null || executing !== null
  };
}

module.exports = { createLibraryCleanup };
