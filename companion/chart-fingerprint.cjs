'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const CHUNK_BYTES = 64 * 1024, SECTION_BYTES = 1024 * 1024, SECTION_COUNT = 4096;
const FORMATS = { chart: '.chart', midi: '.mid', sng: '.sng' };
const utf8 = new TextDecoder('utf-8', { fatal: true });
function abort(signal) {
  if (signal?.aborted) { const error = Error('Fingerprint cancelled.'); error.name = 'AbortError'; error.code = 'ABORT_ERR'; throw error; }
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
  return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function samePath(left, right) { return path.relative(left, right) === ''; }

/** Inspect every component; retaining the directory identities catches replacement during an open/read. */
async function inspectPath(root, relative, signal, expected) {
  const names = [root];
  for (const part of relative.split('/')) names.push(path.join(names[names.length - 1], part));
  const entries = [];
  for (let index = 0; index < names.length; index++) {
    abort(signal);
    const filename = names[index], stat = await fs.lstat(filename, { bigint: true });
    abort(signal);
    if (stat.isSymbolicLink() || (index === names.length - 1 ? !stat.isFile() : !stat.isDirectory())) fail('unsafe-path');
    const actual = await fs.realpath(filename); abort(signal);
    if (!samePath(filename, actual)) fail('unsafe-path');
    if (expected && (index === names.length - 1 ? !sameFile(expected[index].stat, stat) : !sameIdentity(expected[index].stat, stat))) fail('changed-file');
    entries.push({ filename, stat });
  }
  return entries;
}

function unsigned64(buffer, offset, maximum = Number.MAX_SAFE_INTEGER) {
  if (offset < 0 || offset + 8 > buffer.length) fail('invalid-container');
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(maximum)) fail('invalid-container');
  return Number(value);
}

/** SNG v1 specification and masking: https://github.com/mdsitton/SngFileFormat#masking */
async function sngNotes(read, size, signal) {
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
    const ranges = [], names = new Set(); let chart = null, midi = null;
    for (let index = 0; index < files.count; index++) {
      abort(signal);
      const length = files.data[cursor++];
      if (!length || cursor + length + 16 > files.data.length) fail('invalid-container');
      const name = utf8.decode(files.data.subarray(cursor, cursor + length)); cursor += length;
      if (!validRelative(name, true) || names.has(name.toLowerCase())) fail('invalid-container');
      names.add(name.toLowerCase());
      const bytes = unsigned64(files.data, cursor), position = unsigned64(files.data, cursor + 8); cursor += 16;
      const range = { position, bytes }; ranges.push(range);
      if (/^notes\.chart$/i.test(name)) chart = { ...range, format: 'chart' };
      if (/^notes\.mid$/i.test(name)) midi = { ...range, format: 'midi' };
    }
    if (cursor !== files.data.length) fail('invalid-container');
    const dataLength = unsigned64(await read(files.next, 8), 0), start = files.next + 8;
    if (dataLength !== size - start) fail('invalid-container');
    // The data section consists of concatenated members: no overlaps, gaps or out-of-range offsets.
    ranges.sort((left, right) => left.position - right.position || left.bytes - right.bytes);
    let end = start;
    for (const range of ranges) {
      if (range.position !== end || range.bytes > size - end) fail('invalid-container');
      end += range.bytes;
    }
    if (end !== size) fail('invalid-container');
    if (!chart && !midi) fail('missing-notes', 'unsupported');
    return { ...(chart || midi), mask: header.subarray(10, 26) };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.reason) throw error;
    fail('invalid-container');
  }
}

/** Hash the original note bytes, never metadata/audio or normalized/parsed notes. No chart-size cap. */
async function fingerprintChart({ rootPath, relativePath, format, signal } = {}) {
  abort(signal);
  let resultFormat = format === 'chart' || format === 'midi' ? format : null;
  const unavailable = (status, reason) => ({ status, format: resultFormat, sha256: null, bytes: null, modifiedAt: null, reason });
  if (!Object.hasOwn(FORMATS, format) || typeof relativePath !== 'string' || path.posix.extname(relativePath).toLowerCase() !== FORMATS[format]) {
    resultFormat = null; return unavailable('unsupported', 'unsupported-format');
  }
  let handle;
  try {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || !validRelative(relativePath)) fail('unsafe-path');
    const root = path.resolve(rootPath), entries = await inspectPath(root, relativePath, signal);
    const entry = entries[entries.length - 1], expected = entry.stat;
    if (expected.size > BigInt(Number.MAX_SAFE_INTEGER)) fail('unavailable-file');
    handle = await fs.open(entry.filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); abort(signal);
    const opened = await handle.stat({ bigint: true }); abort(signal);
    if (!opened.isFile() || !sameFile(expected, opened)) fail('changed-file');
    await inspectPath(root, relativePath, signal, entries);
    const size = Number(expected.size);
    async function read(position, length) {
      abort(signal);
      if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0 || position > size || length > size - position) fail(format === 'sng' ? 'invalid-container' : 'changed-file');
      const buffer = Buffer.alloc(length); let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, Math.min(CHUNK_BYTES, length - offset), position + offset); abort(signal);
        if (!bytesRead) fail('changed-file');
        offset += bytesRead;
      }
      return buffer;
    }
    const source = format === 'sng' ? await sngNotes(read, size, signal) : { position: 0, bytes: size, format };
    resultFormat = source.format;
    const hash = createHash('sha256');
    for (let offset = 0; offset < source.bytes;) {
      const bytes = await read(source.position + offset, Math.min(CHUNK_BYTES, source.bytes - offset));
      // Position is relative to this member, not the archive/data-section or current chunk.
      if (source.mask) for (let index = 0; index < bytes.length; index++) bytes[index] ^= source.mask[(offset + index) % 16] ^ ((offset + index) & 0xff);
      hash.update(bytes); offset += bytes.length;
      abort(signal);
    }
    const finalStat = await handle.stat({ bigint: true }); abort(signal);
    if (!sameFile(expected, finalStat)) fail('changed-file');
    await inspectPath(root, relativePath, signal, entries);
    abort(signal);
    return { status: 'readable', format: resultFormat, sha256: hash.digest('hex'), bytes: source.bytes, modifiedAt: new Date(Number(expected.mtimeMs)).toISOString(), reason: null };
  } catch (error) {
    abort(signal);
    if (error?.name === 'AbortError') throw error;
    return unavailable(error?.status === 'unsupported' ? 'unsupported' : 'unavailable', error?.reason || 'unavailable-file');
  } finally { if (handle) await handle.close().catch(() => {}); }
}

module.exports = { fingerprintChart };
