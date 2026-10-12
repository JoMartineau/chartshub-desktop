'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { inspectReportedBundle } = require('./chart-bundle.cjs');
const LIMIT = 8 * 1024 * 1024, TOKEN = /^[a-f0-9]{32}$/, ID = /^[a-f0-9]{64}$/;
const failure = () => Object.assign(Error('Le rapport ou les fichiers ont changé. Importez à nouveau badsongs.txt avant de supprimer.'), { code: 'LIBRARY_BAD_SONGS_SAFE' });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value).digest('hex');
function recognized(reason) {
  return /^ERROR: These folders (?:either have no valid metadata file \(song\.ini\), or the metadata does not include a valid song name!|have corrupt \(or broken\) notes\.mid or notes\.chart files!)$/i.test(reason);
}
/** Clone Hero emits severity headers followed by absolute path lines. Warnings
 * remain informational even when the same file also has a separate error. */
function parseBadSongsReport(value, pathApi = path) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > LIMIT || /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw failure();
  const entries = [], groups = new Map(); let section = null, unsupportedLines = 0;
  for (const raw of value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim(); if (!line) continue;
    const header = /^(ERROR|Warning):\s+.+$/i.exec(line);
    if (header) { section = { severity: header[1].toLowerCase() === 'error' ? 'error' : 'warning', reason: line, recognized: recognized(line) }; continue; }
    if (pathApi.isAbsolute(line)) {
      const key = `${section?.severity ?? 'unknown'}\0${process.platform === 'win32' ? line.toLowerCase() : line}`;
      const entry = groups.get(key);
      if (entry) { if (!entry.reasons.includes(section?.reason ?? '')) entry.reasons.push(section?.reason ?? ''); entry.recognized &&= section?.recognized === true; }
      else { const item = { reportedPath: line, severity: section?.severity ?? 'unknown', reasons: [section?.reason ?? ''], recognized: section?.recognized === true }; groups.set(key, item); entries.push(item); }
      continue;
    }
    // Known warning explanations contain no paths or deletion targets.
    if (section?.severity !== 'warning') { unsupportedLines++; section = null; }
  }
  if (!entries.length && value.trim()) throw failure();
  return { entries, unsupportedLines };
}
async function readReport(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || path.basename(filename).toLowerCase() !== 'badsongs.txt') throw failure();
  const stat = await fs.lstat(filename, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(LIMIT) || path.relative(filename, await fs.realpath(filename)) !== '') throw failure();
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const stamp = value => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink', 'mode'].map(key => String(value[key])).join(':');
  try {
    if (stamp(await handle.stat({ bigint: true })) !== stamp(stat)) throw failure();
    const buffer = Buffer.alloc(Number(stat.size) + 1); let offset = 0;
    while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    if (offset !== Number(stat.size) || stamp(await handle.stat({ bigint: true })) !== stamp(stat)
      || stamp(await fs.lstat(filename, { bigint: true })) !== stamp(stat) || path.relative(filename, await fs.realpath(filename)) !== '') throw failure();
    const bytes = buffer.subarray(0, offset);
    return { value: new TextDecoder('utf-8', { fatal: true }).decode(bytes), signature: stamp(stat) + ':' + digest(bytes), modifiedAt: new Date(Number(stat.mtimeMs)).toISOString() };
  } finally { await handle.close(); }
}
function relativeTarget(root, reported) {
  if (!path.isAbsolute(reported) || /[\u0000-\u001f\u007f]/.test(reported)) return null;
  const resolved = path.resolve(reported), relative = path.relative(root, resolved);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) return null;
  return relative.split(path.sep).join('/');
}
const contains = (parent, child) => { const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const left = normalize(parent), right = normalize(child); return left === right || right.startsWith(left + '/'); };
function createBadSongsCleanup({ getDocument, recycle, onCleaned = async () => {}, protectedDirectory } = {}) {
  if (typeof getDocument !== 'function' || typeof recycle !== 'function' || typeof onCleaned !== 'function') throw failure();
  let plan = null, task = null, stopping = false;
  function invalidate() { plan?.controller.abort(); plan = null; }
  function current(value) {
    const document = getDocument();
    if (stopping || value.controller.signal.aborted || value.revision !== document.revision || value.rootPath !== document.settings.rootPath || value.items !== document.items) throw failure();
    return document;
  }
  const publicEntry = item => ({ id: item.id, targetRelativePath: item.targetRelativePath, reportedPath: item.reportedPath, severity: item.severity, reasons: [...item.reasons], eligible: item.eligible, blocked: item.blocked, bytes: item.bundle?.bytes ?? null, kind: item.kind });
  const publicPlan = value => ({ planId: value.planId, revision: value.revision, modifiedAt: value.modifiedAt, unsupportedLines: value.unsupportedLines, entries: value.entries.map(publicEntry) });
  async function runPrepare(filename) {
    invalidate();
    const document = getDocument(), rootPath = document.settings.rootPath;
    if (!rootPath || !path.isAbsolute(rootPath)) throw failure();
    const source = await readReport(filename), parsed = parseBadSongsReport(source.value);
    const value = { planId: randomBytes(16).toString('hex'), rootPath, revision: document.revision, items: document.items, filename, signature: source.signature, modifiedAt: source.modifiedAt,
      controller: new AbortController(), unsupportedLines: parsed.unsupportedLines, entries: [] };
    plan = value;
    try {
      for (const entry of parsed.entries) {
        current(value);
        const targetRelativePath = relativeTarget(rootPath, entry.reportedPath), kind = /\.sng$/i.test(entry.reportedPath) ? 'sng' : 'folder';
        let blocked = entry.severity !== 'error' ? 'warning' : !entry.recognized ? 'unsupported' : !targetRelativePath ? 'outside' : null;
        if (!blocked && protectedDirectory) {
          const target = path.resolve(rootPath, ...targetRelativePath.split('/')), protectedRoot = path.resolve(protectedDirectory);
          const includes = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)); };
          if (includes(target, protectedRoot) || includes(protectedRoot, target)) blocked = 'protected';
        }
        const indexed = !targetRelativePath ? [] : value.items.filter(item => contains(targetRelativePath, item.relativePath));
        if (!blocked && indexed.length > 1) blocked = 'shared';
        const bundle = blocked ? null : await inspectReportedBundle({ rootPath, targetRelativePath, kind, signal: value.controller.signal });
        current(value);
        if (!blocked && !bundle) blocked = 'unsafe';
        value.entries.push({ ...entry, id: digest(`${entry.severity}\0${targetRelativePath ?? entry.reportedPath}`), targetRelativePath, kind, bundle, eligible: !blocked, blocked });
      }
      const overlapping = new Set(value.entries.filter(entry => entry.eligible && value.entries.some(other => other !== entry && other.eligible && (contains(entry.targetRelativePath, other.targetRelativePath) || contains(other.targetRelativePath, entry.targetRelativePath)))).map(entry => entry.id));
      for (const entry of value.entries) if (overlapping.has(entry.id)) { entry.eligible = false; entry.blocked = 'shared'; }
      if ((await readReport(filename)).signature !== value.signature) throw failure(); current(value);
      return publicPlan(value);
    } catch (error) { if (plan === value) invalidate(); throw failure(); }
  }
  function selected(options) {
    if (!object(options) || Object.keys(options).length !== 3 || !['planId', 'revision', 'ids'].every(key => Object.hasOwn(options, key)) || typeof options.planId !== 'string' || !TOKEN.test(options.planId)
      || !Number.isSafeInteger(options.revision) || options.revision < 0 || !Array.isArray(options.ids) || !options.ids.length || options.ids.length > 200 || options.ids.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(options.ids).size !== options.ids.length) throw failure();
    const value = plan; if (!value || value.planId !== options.planId || value.revision !== options.revision) throw failure(); current(value);
    const entries = [...options.ids].map(id => value.entries.find(entry => entry.id === id));
    if (entries.some(entry => !entry?.eligible || entry.severity !== 'error' || !entry.bundle)) throw failure();
    return { value, entries };
  }
  async function review(options) {
    if (task || stopping) throw failure(); const { value, entries } = selected(options);
    if ((await readReport(value.filename)).signature !== value.signature) throw failure(); current(value);
    return { planId: value.planId, revision: value.revision, entries: entries.map(publicEntry) };
  }
  async function execute(options) {
    if (task || stopping) throw failure(); const { value, entries } = selected(options);
    const result = { recycledIds: [], recycledTargets: [], failed: [], cancelled: false, refreshRequested: false };
    task = (async () => {
      try {
        for (const entry of entries) {
          current(value);
          if ((await readReport(value.filename)).signature !== value.signature) throw failure(); current(value);
          const checked = await inspectReportedBundle({ rootPath: value.rootPath, targetRelativePath: entry.targetRelativePath, kind: entry.kind, expected: entry.bundle, signal: value.controller.signal });
          current(value); if (!checked) throw failure();
          if ((await readReport(value.filename)).signature !== value.signature) throw failure(); current(value);
          await recycle(path.resolve(value.rootPath, ...entry.targetRelativePath.split('/')), { type: 'bad-songs', rootPath: value.rootPath, targetRelativePath: entry.targetRelativePath, kind: entry.kind, expected: entry.bundle });
          result.recycledIds.push(entry.id); result.recycledTargets.push(entry.targetRelativePath);
        }
      } catch (error) { if (value.controller.signal.aborted || stopping) result.cancelled = true; else result.failed.push({ id: entries[result.recycledIds.length]?.id, reason: 'changed' }); }
      finally {
        if (result.recycledTargets.length) { await onCleaned({ rootPath: value.rootPath, revision: value.revision, items: value.items, recycledTargets: result.recycledTargets }); result.refreshRequested = true; }
        if (plan === value) invalidate();
        const document = getDocument();
        if (!stopping && !result.cancelled && document.settings.rootPath === value.rootPath) {
          const removed = new Set(result.recycledIds), failed = new Set(result.failed.map(entry => entry.id));
          plan = { ...value, planId: randomBytes(16).toString('hex'), revision: document.revision, items: document.items, controller: new AbortController(),
            entries: value.entries.filter(entry => !removed.has(entry.id)).map(entry => failed.has(entry.id) ? { ...entry, eligible: false, blocked: 'changed' } : entry) };
          result.plan = publicPlan(plan);
        }
      }
      return result;
    })();
    try { return await task; } finally { task = null; }
  }
  async function prepare(filename) {
    if (task || stopping) throw failure();
    const operation = Promise.resolve().then(() => runPrepare(filename)); task = operation;
    try { return await operation; } finally { if (task === operation) task = null; }
  }
  return { prepare, review, execute, invalidate, busy: () => !!task, stop: async () => { stopping = true; invalidate(); try { await task?.catch(() => {}); } finally { stopping = false; } } };
}
async function verifyNativeBadSongCleanup({ root, target, proof } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof target !== 'string' || !path.isAbsolute(target)
    || !object(proof) || proof.type !== 'bad-songs' || proof.rootPath !== root || relativeTarget(root, target) !== proof.targetRelativePath
    || !object(proof.expected) || !object(proof.expected.identity) || typeof proof.expected.digest !== 'string' || !ID.test(proof.expected.digest)
    || !Number.isSafeInteger(proof.expected.bytes) || proof.expected.bytes < 0 || !['folder','sng'].includes(proof.kind)
    || proof.expected.kind !== proof.kind || proof.expected.targetRelativePath !== proof.targetRelativePath
    || proof.expected.identity.kind !== proof.kind || proof.expected.identity.targetRelativePath !== proof.targetRelativePath) throw failure();
  if (!await inspectReportedBundle({ rootPath: root, targetRelativePath: proof.targetRelativePath, kind: proof.kind, expected: proof.expected, identityOnly: true })) throw failure();
}
module.exports = { parseBadSongsReport, relativeTarget, createBadSongsCleanup, verifyNativeBadSongCleanup };
