'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const CHUNK_BYTES = 64 * 1024, SECTION_BYTES = 1024 * 1024, SECTION_COUNT = 4096;
const FORMATS = { chart: '.chart', midi: '.mid', sng: '.sng' };
const AUDIO = /\.(?:ogg|opus|mp3|wav|flac|aiff?|m4a)$/i;
const utf8 = new TextDecoder('utf-8', { fatal: true });
function abort(signal) {
  if (signal?.aborted) { const error = Error('Bundle verification cancelled.'); error.name = 'AbortError'; error.code = 'ABORT_ERR'; throw error; }
}
function fail(reason, status = 'unavailable') { const error = Error(reason); error.reason = reason; error.status = status; throw error; }
function validRelative(value, container = false) {
  return typeof value === 'string' && value.length > 0 && value.length <= 32768 &&
    !path.isAbsolute(value) && !/[\\<>:"|?*\u0000-\u001f\u007f]/.test(value) &&
    value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) &&
      !/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(part) && (!container || !part.includes('..')));
}
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function sameFile(left, right) {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs && left.nlink === right.nlink && left.mode === right.mode;
}
function samePath(left, right) { return path.relative(left, right) === ''; }
function within(root, target) {
  const relative = path.relative(root, target);
  return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
function descriptor(stat, full = true) {
  const result = { dev: String(stat.dev), ino: String(stat.ino) };
  if (full) for (const key of ['size', 'mtimeNs', 'ctimeNs', 'nlink', 'mode']) result[key] = String(stat[key]);
  return result;
}
function sortNames(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function normalizedName(name) { return name.normalize('NFC').toLowerCase(); }
function manifestDigest(domain, entries, normalize = false) {
  const hash = createHash('sha256').update(domain + '\n');
  const sorted = entries.map(entry => ({ name: normalize ? normalizedName(entry.name) : entry.name, bytes: entry.bytes, sha256: entry.sha256 }))
    .sort((left, right) => sortNames(left.name, right.name));
  for (const entry of sorted) hash.update(JSON.stringify([entry.name, entry.bytes, entry.sha256]) + '\n');
  return hash.digest('hex');
}
function audioSummary(entries) {
  const audio = entries.filter(entry => AUDIO.test(entry.name));
  const count = audio.filter(entry => !/^preview\./i.test(path.posix.basename(entry.name)) && entry.bytes > 0).length;
  return { status: count ? 'verified' : 'missing', count, bytes: audio.reduce((sum, entry) => sum + entry.bytes, 0),
    digest: audio.length ? manifestDigest('chartshub-audio-v1', audio, true) : null };
}

function bundleSnapshot(identity) {
  return identity ? createHash('sha256').update('chartshub-scan-bundle-v1\n').update(JSON.stringify(identity)).digest('hex') : null;
}

/** The library scan records every filename and filesystem identity without
 * opening audio. A missing/unsafe snapshot cannot authorize later cleanup. */
async function captureBundleSnapshot({ rootPath, relativePath, format, signal } = {}) {
  abort(signal);
  try {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || !validRelative(relativePath) || !Object.hasOwn(FORMATS, format) || path.posix.extname(relativePath).toLowerCase() !== FORMATS[format]) return null;
    const kind = format === 'sng' ? 'sng' : 'folder', targetRelativePath = kind === 'sng' ? relativePath : path.posix.dirname(relativePath);
    if (!validRelative(targetRelativePath) || (kind === 'folder' && !/^notes\.(?:chart|mid)$/i.test(path.posix.basename(relativePath)))) return null;
    const root = path.resolve(rootPath), target = path.resolve(root, ...targetRelativePath.split('/'));
    if (!within(root, target)) return null;
    const ancestry = await inspectPath(root, targetRelativePath, kind, signal), leaf = ancestry[ancestry.length - 1];
    const identity = { version: 1, targetRelativePath, kind,
      ancestors: ancestry.slice(0, -1).map(entry => descriptor(entry.stat, false)), target: descriptor(leaf.stat), files: [] };
    if (kind === 'folder') {
      const names = (await fs.readdir(target)).sort(sortNames), normalized = new Set(); abort(signal);
      if (!names.includes(path.posix.basename(relativePath))) return null;
      for (const name of names) {
        if (!validRelative(name) || name.includes('/') || normalized.has(normalizedName(name))) return null;
        normalized.add(normalizedName(name));
        if (/\.(?:chart|mid|midi|sng)$/i.test(name) && !/^notes\.(?:chart|mid)$/i.test(name)) return null;
        const stat = await inspectFile(path.join(target, name), signal);
        identity.files.push({ name, ...descriptor(stat) });
      }
      const finalNames = (await fs.readdir(target)).sort(sortNames); abort(signal);
      if (JSON.stringify(names) !== JSON.stringify(finalNames)) return null;
    }
    await inspectPath(root, targetRelativePath, kind, signal, ancestry); abort(signal);
    return bundleSnapshot(identity);
  } catch (error) {
    abort(signal);
    if (error?.name === 'AbortError') throw error;
    return null;
  }
}

/** Inspect the root and every child without accepting links, junctions, aliases or hard-linked files. */
async function inspectPath(root, relative, kind, signal, expected) {
  const names = [root];
  for (const part of relative.split('/')) names.push(path.join(names[names.length - 1], part));
  const entries = [];
  for (let index = 0; index < names.length; index++) {
    abort(signal);
    const filename = names[index], stat = await fs.lstat(filename, { bigint: true }); abort(signal);
    const leaf = index === names.length - 1, directory = !leaf || kind === 'folder';
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) fail('unsafe-path');
    const actual = await fs.realpath(filename); abort(signal);
    if (!samePath(filename, actual)) fail('unsafe-path');
    if (expected && (leaf ? !sameFile(expected[index].stat, stat) : !sameIdentity(expected[index].stat, stat))) fail('changed-bundle');
    entries.push({ filename, stat });
  }
  return entries;
}
async function inspectFile(filename, signal, expected) {
  abort(signal);
  const stat = await fs.lstat(filename, { bigint: true }); abort(signal);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) fail('unsafe-path');
  if (!samePath(filename, await fs.realpath(filename))) fail('unsafe-path');
  abort(signal);
  if (expected && !sameFile(expected, stat)) fail('changed-bundle');
  if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) fail('unavailable-file');
  return stat;
}
async function openRead(filename, expected, signal, action) {
  let handle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); abort(signal);
    const opened = await handle.stat({ bigint: true }); abort(signal);
    if (!opened.isFile() || opened.nlink !== 1n || !sameFile(expected, opened)) fail('changed-bundle');
    const size = Number(expected.size);
    async function read(position, length) {
      abort(signal);
      if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0 || position > size || length > size - position) fail('invalid-container');
      const buffer = Buffer.alloc(length); let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, Math.min(CHUNK_BYTES, length - offset), position + offset); abort(signal);
        if (!bytesRead) fail('changed-bundle');
        offset += bytesRead;
      }
      return buffer;
    }
    const result = await action(read, size);
    const finalStat = await handle.stat({ bigint: true }); abort(signal);
    if (!sameFile(expected, finalStat)) fail('changed-bundle');
    await inspectFile(filename, signal, expected);
    return result;
  } finally { if (handle) await handle.close().catch(() => {}); }
}
async function hashRange(read, position, bytes, signal, mask) {
  const hash = createHash('sha256');
  for (let offset = 0; offset < bytes;) {
    abort(signal);
    const chunk = await read(position + offset, Math.min(CHUNK_BYTES, bytes - offset));
    if (mask) for (let index = 0; index < chunk.length; index++) chunk[index] ^= mask[(offset + index) % 16] ^ ((offset + index) & 255);
    hash.update(chunk); offset += chunk.length;
  }
  abort(signal); return hash.digest('hex');
}
function unsigned64(buffer, offset, maximum = Number.MAX_SAFE_INTEGER) {
  if (offset < 0 || offset + 8 > buffer.length) fail('invalid-container');
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(maximum)) fail('invalid-container');
  return Number(value);
}

/** SNG v1 follows the parser in chart-fingerprint.cjs and the official SngFileFormat masking specification. */
async function sngIndex(read, size, signal) {
  const header = await read(0, 26);
  if (!header.subarray(0, 6).equals(Buffer.from('SNGPKG'))) fail('invalid-container');
  if (header.readUInt32LE(6) !== 1) fail('unsupported-container-version', 'unsupported');
  async function section(position) {
    const length = unsigned64(await read(position, 8), 0, SECTION_BYTES);
    if (length < 8) fail('invalid-container');
    const data = await read(position + 8, length);
    return { data, count: unsigned64(data, 0, SECTION_COUNT), next: position + 8 + length };
  }
  const metadata = await section(26); let cursor = 8;
  if (metadata.count > Math.floor((metadata.data.length - 8) / 8)) fail('invalid-container');
  function string(data) {
    if (cursor + 4 > data.length) fail('invalid-container');
    const length = data.readInt32LE(cursor); cursor += 4;
    if (length < 0 || length > data.length - cursor) fail('invalid-container');
    const value = utf8.decode(data.subarray(cursor, cursor + length)); cursor += length;
    if (value.includes('\0')) fail('invalid-container');
  }
  try {
    for (let index = 0; index < metadata.count; index++) { abort(signal); string(metadata.data); string(metadata.data); }
    if (cursor !== metadata.data.length) fail('invalid-container');
    const files = await section(metadata.next); cursor = 8;
    if (files.count > Math.floor((files.data.length - 8) / 18)) fail('invalid-container');
    const members = [], names = new Set(); let chart = null, midi = null;
    for (let index = 0; index < files.count; index++) {
      abort(signal);
      const length = files.data[cursor++];
      if (!length || cursor + length + 16 > files.data.length) fail('invalid-container');
      const name = utf8.decode(files.data.subarray(cursor, cursor + length)); cursor += length;
      if (!validRelative(name, true) || names.has(normalizedName(name))) fail('invalid-container');
      names.add(normalizedName(name));
      const bytes = unsigned64(files.data, cursor), position = unsigned64(files.data, cursor + 8); cursor += 16;
      const member = { name, bytes, position }; members.push(member);
      if (/^notes\.chart$/i.test(name)) chart = { ...member, format: 'chart' };
      if (/^notes\.mid$/i.test(name)) midi = { ...member, format: 'midi' };
    }
    if (cursor !== files.data.length) fail('invalid-container');
    const dataLength = unsigned64(await read(files.next, 8), 0), start = files.next + 8;
    if (dataLength !== size - start) fail('invalid-container');
    const ranges = [...members].sort((left, right) => left.position - right.position || left.bytes - right.bytes); let end = start;
    for (const range of ranges) {
      if (range.position !== end || range.bytes > size - end) fail('invalid-container');
      end += range.bytes;
    }
    if (end !== size) fail('invalid-container');
    if (!chart && !midi) fail('missing-notes', 'unsupported');
    return { members, notes: chart || midi, mask: header.subarray(10, 26),
      metadata: { bytes: metadata.data.length, sha256: createHash('sha256').update(metadata.data).digest('hex') } };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.reason) throw error;
    fail('invalid-container');
  }
}

/** Read-only verification. All hashes cover bytes, never decoded sound samples or parsed note events. */
async function inspectChartBundle({ rootPath, relativePath, format, signal } = {}) {
  abort(signal);
  const kind = format === 'sng' ? 'sng' : 'folder'; let targetRelativePath = null;
  const unavailable = (status, reason) => ({ status, reason, kind, targetRelativePath,
    notes: { format: format === 'chart' || format === 'midi' ? format : null, sha256: null, bytes: null },
    audio: { status: 'unavailable', count: 0, bytes: 0, digest: null }, nonAudioHash: null, bundleHash: null, totalBytes: null, entryCount: 0, identity: null });
  if (!Object.hasOwn(FORMATS, format) || typeof relativePath !== 'string' || path.posix.extname(relativePath).toLowerCase() !== FORMATS[format]) return unavailable('unsupported', 'unsupported-format');
  try {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || !validRelative(relativePath)) fail('unsafe-path');
    targetRelativePath = kind === 'sng' ? relativePath : path.posix.dirname(relativePath);
    if (targetRelativePath === '.') { targetRelativePath = null; fail('root-folder'); }
    if (kind === 'folder' && !/^notes\.(?:chart|mid)$/i.test(path.posix.basename(relativePath))) fail('unsupported-notes-name', 'unsupported');
    const root = path.resolve(rootPath), target = path.resolve(root, ...targetRelativePath.split('/'));
    if (!within(root, target)) fail('unsafe-path');
    const ancestry = await inspectPath(root, targetRelativePath, kind, signal), leaf = ancestry[ancestry.length - 1];
    const identity = { version: 1, targetRelativePath, kind,
      ancestors: ancestry.slice(0, -1).map(entry => descriptor(entry.stat, false)), target: descriptor(leaf.stat), files: [] };
    let notes, audio, nonAudioHash = null, bundleHash, totalBytes, entryCount, bundleFiles, containerMetadata = null;
    if (kind === 'sng') {
      if (leaf.stat.size > BigInt(Number.MAX_SAFE_INTEGER)) fail('unavailable-file');
      const result = await openRead(target, leaf.stat, signal, async (read, size) => {
        await inspectPath(root, targetRelativePath, kind, signal, ancestry);
        const index = await sngIndex(read, size, signal);
        const members = [];
        for (const member of index.members) members.push({ name: member.name, bytes: member.bytes,
          sha256: await hashRange(read, member.position, member.bytes, signal, index.mask) });
        members.sort((left, right) => sortNames(left.name, right.name));
        const noteHash = members.find(member => member.name === index.notes.name).sha256;
        return { notes: { format: index.notes.format, sha256: noteHash, bytes: index.notes.bytes }, audio: audioSummary(members), nonAudioHash: null,
          bundleHash: await hashRange(read, 0, size, signal), totalBytes: size, entryCount: index.members.length,
          bundleFiles: members, containerMetadata: index.metadata };
      });
      ({ notes, audio, nonAudioHash, bundleHash, totalBytes, entryCount, bundleFiles, containerMetadata } = result);
    } else {
      const names = (await fs.readdir(target)).sort(sortNames); abort(signal);
      const normalized = new Set(), files = [], entries = [];
      for (const name of names) {
        if (!validRelative(name) || name.includes('/') || normalized.has(normalizedName(name))) fail('unsafe-path');
        normalized.add(normalizedName(name));
        const filename = path.join(target, name), stat = await fs.lstat(filename, { bigint: true }); abort(signal);
        if (stat.isDirectory()) fail('nested-folder');
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) fail('unsafe-path');
        if (/\.(?:chart|mid|midi|sng)$/i.test(name) && !/^notes\.(?:chart|mid)$/i.test(name)) fail('multiple-charts');
        await inspectFile(filename, signal, stat);
        files.push({ name, filename, stat });
      }
      const selected = files.find(entry => entry.name === path.posix.basename(relativePath));
      if (!selected) fail('missing-notes');
      for (const file of files) {
        const sha256 = await openRead(file.filename, file.stat, signal, async (read, size) => {
          await inspectPath(root, targetRelativePath, kind, signal, ancestry);
          return hashRange(read, 0, size, signal);
        });
        const entry = { name: file.name, bytes: Number(file.stat.size), sha256 }; entries.push(entry);
        if (file === selected) notes = { format, sha256, bytes: entry.bytes };
      }
      // Recheck every file after the last read: changing an earlier file also invalidates the bundle.
      for (const file of files) await inspectFile(file.filename, signal, file.stat);
      const finalNames = (await fs.readdir(target)).sort(sortNames); abort(signal);
      if (JSON.stringify(names) !== JSON.stringify(finalNames)) fail('changed-bundle');
      identity.files = files.map(file => ({ name: file.name, ...descriptor(file.stat) }));
      audio = audioSummary(entries);
      nonAudioHash = manifestDigest('chartshub-nonaudio-v1', entries.filter(entry => !AUDIO.test(entry.name)));
      bundleHash = manifestDigest('chartshub-folder-v1', entries);
      bundleFiles = entries;
      totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0); entryCount = entries.length;
      if (!Number.isSafeInteger(totalBytes)) fail('unavailable-file');
    }
    await inspectPath(root, targetRelativePath, kind, signal, ancestry); abort(signal);
    return { status: 'verified', reason: null, kind, targetRelativePath, notes, audio, nonAudioHash, bundleHash, totalBytes, entryCount, identity,
      files: bundleFiles, containerMetadata };
  } catch (error) {
    abort(signal);
    if (error?.name === 'AbortError') throw error;
    return unavailable(error?.status === 'unsupported' ? 'unsupported' : 'unavailable', error?.reason || 'unavailable-file');
  }
}

/** Rehash immediately before the caller's OS recycle operation. The absolute result must stay internal. */
async function revalidateBundle({ rootPath, relativePath, format, expected, signal } = {}) {
  abort(signal);
  if (!expected || expected.status !== 'verified' || expected.audio?.status !== 'verified' || !expected.bundleHash || !expected.identity) return null;
  const current = await inspectChartBundle({ rootPath, relativePath, format, signal });
  if (current.status !== 'verified' || current.audio.status !== 'verified' || current.kind !== expected.kind ||
    current.targetRelativePath !== expected.targetRelativePath || current.bundleHash !== expected.bundleHash ||
    JSON.stringify(current.notes) !== JSON.stringify(expected.notes) || JSON.stringify(current.audio) !== JSON.stringify(expected.audio) ||
    JSON.stringify(current.identity) !== JSON.stringify(expected.identity)) return null;
  const root = path.resolve(rootPath), target = path.resolve(root, ...current.targetRelativePath.split('/'));
  return within(root, target) ? target : null;
}

/** A final metadata-only gate after both bundles have been rehashed. Never
 * authorize from this alone: it only closes the intervening long read window. */
async function recheckBundleIdentity({ rootPath, relativePath, format, expected, signal } = {}) {
  abort(signal);
  try {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || !validRelative(relativePath) || !Object.hasOwn(FORMATS, format) || path.posix.extname(relativePath).toLowerCase() !== FORMATS[format] || expected?.status !== 'verified' || expected.audio?.status !== 'verified' || !expected.identity) return null;
    const kind = format === 'sng' ? 'sng' : 'folder', targetRelativePath = kind === 'sng' ? relativePath : path.posix.dirname(relativePath);
    if (!validRelative(targetRelativePath) || targetRelativePath !== expected.targetRelativePath || kind !== expected.kind) return null;
    const root = path.resolve(rootPath), target = path.resolve(root, ...targetRelativePath.split('/'));
    if (!within(root, target)) return null;
    const ancestry = await inspectPath(root, targetRelativePath, kind, signal), leaf = ancestry[ancestry.length - 1];
    const identity = { version: 1, targetRelativePath, kind,
      ancestors: ancestry.slice(0, -1).map(entry => descriptor(entry.stat, false)), target: descriptor(leaf.stat), files: [] };
    if (kind === 'folder') {
      const names = (await fs.readdir(target)).sort(sortNames); abort(signal);
      if (!Array.isArray(expected.identity.files) || JSON.stringify(names) !== JSON.stringify(expected.identity.files.map(file => file.name))) return null;
      for (const name of names) {
        if (!validRelative(name) || name.includes('/')) return null;
        const stat = await inspectFile(path.join(target, name), signal);
        identity.files.push({ name, ...descriptor(stat) });
      }
      const finalNames = (await fs.readdir(target)).sort(sortNames); abort(signal);
      if (JSON.stringify(names) !== JSON.stringify(finalNames)) return null;
    }
    await inspectPath(root, targetRelativePath, kind, signal, ancestry); abort(signal);
    return JSON.stringify(identity) === JSON.stringify(expected.identity) ? target : null;
  } catch (error) {
    abort(signal);
    if (error?.name === 'AbortError') throw error;
    return null;
  }
}

module.exports = { inspectChartBundle, revalidateBundle, recheckBundleIdentity, captureBundleSnapshot, bundleSnapshot };
