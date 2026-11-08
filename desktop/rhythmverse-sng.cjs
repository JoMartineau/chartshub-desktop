'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { randomBytes } = require('node:crypto');
const { buildSngHeader, MAX_BYTES, MAX_FILE_BYTES } = require('../enchor-sng');

const MAX_ENTRIES = 1000;
const MAX_INI_BYTES = 128 * 1024;
const CHUNK_SIZE = 64 * 1024;
const VIDEO_EXTENSION = /\.(?:mp4|webm|avi|vp8|ogv|mpeg|mpg|mov|m4v|mkv|wmv)$/i;
const REGISTERED_NAME = /^(?:notes\.(?:chart|mid)|(?:album|background|highway)\.(?:png|jpg|jpeg|webp|gif|bmp)|(?:video|background)\.(?:mp4|webm|avi|vp8|ogv|mpeg|mpg|mov|m4v|mkv|wmv)|(?:song|guitar|bass|rhythm|vocals(?:_[12])?|drums(?:_[1-4])?|keys|crowd|preview)\.(?:ogg|opus|mp3|wav|flac|aiff?|m4a))$/i;

function invalidChart(message = 'La chart extraite ne peut pas être enregistrée au format SNG.') {
  return Object.assign(new Error(message), { code: 'RV_ARCHIVE_SNG' });
}

async function plainStat(filename, directory) {
  const stat = await fs.lstat(filename, { bigint: true });
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)
    || path.relative(filename, await fs.realpath(filename))) throw invalidChart();
  return stat;
}

function sameIdentity(before, after) {
  return before.dev === after.dev && before.ino === after.ino;
}

function sameFile(before, after) {
  return sameIdentity(before, after) && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

async function readVerified(file, signal, read) {
  signal?.throwIfAborted();
  if (!sameFile(file.stat, await plainStat(file.filename, false))) throw invalidChart();
  const handle = await fs.open(file.filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameFile(file.stat, await handle.stat({ bigint: true }))) throw invalidChart();
    const result = await read(handle);
    signal?.throwIfAborted();
    if (!sameFile(file.stat, await handle.stat({ bigint: true })) || !sameFile(file.stat, await plainStat(file.filename, false))) {
      throw invalidChart();
    }
    return result;
  } finally {
    await handle.close();
  }
}

function songIniText(bytes) {
  const bom = bytes.subarray(0, 2).toString('hex');
  if (bom === 'fffe') return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
  if (bom === 'feff') return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

async function readMetadata(file, signal) {
  if (!file || !file.size || file.size > MAX_INI_BYTES) throw invalidChart('Le fichier song.ini de la chart est absent ou invalide.');
  const bytes = await readVerified(file, signal, async handle => {
    const bytes = Buffer.alloc(file.size);
    for (let offset = 0; offset < bytes.length;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw invalidChart();
      offset += bytesRead;
    }
    return bytes;
  });
  const unsectioned = new Map(), song = new Map();
  let section = null;
  for (const original of songIniText(bytes).split(/\r\n|\r|\n/)) {
    const line = original.trim();
    if (!line || /^[;#]/.test(line)) continue;
    const heading = /^\[([^\]]+)\]\s*(?:[;#].*)?$/.exec(line);
    if (heading) {
      section = heading[1].trim().toLowerCase();
      continue;
    }
    if (section !== null && section !== 'song') continue;
    const equals = line.indexOf('=');
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim().toLowerCase();
    const value = line.slice(equals + 1).trim();
    if (!key || /[=;#\[\]\u0000-\u001f\u007f]/u.test(key) || value.includes('\0')) continue;
    (section === 'song' ? song : unsectioned).set(key, value);
  }
  const metadata = section === null ? unsectioned : song;
  if (!metadata.size || metadata.size > 4096) throw invalidChart('Les métadonnées de song.ini sont absentes ou invalides.');
  return Array.from(metadata, ([key, value]) => ({ key, value }));
}

async function chartFiles(directory, includeVideo, signal) {
  const pending = [{ filename: directory, parts: [] }];
  const members = [];
  let ini, entries = 0, total = 0;
  while (pending.length) {
    const parent = pending.pop();
    await plainStat(parent.filename, true);
    for (const entry of await fs.readdir(parent.filename, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (++entries > MAX_ENTRIES || entry.isSymbolicLink()) throw invalidChart();
      const filename = path.join(parent.filename, entry.name);
      const parts = [...parent.parts, entry.name];
      if (parts.length > 6) throw invalidChart();
      if (entry.isDirectory()) {
        pending.push({ filename, parts });
        continue;
      }
      const stat = await plainStat(filename, false);
      const size = Number(stat.size);
      if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES) throw invalidChart();
      const file = { filename, stat, size };
      if (entry.name.toLowerCase() === 'song.ini') {
        if (parent.parts.length || ini) throw invalidChart('Le format SNG exige une seule chart.');
        ini = file;
      } else if (includeVideo || !VIDEO_EXTENSION.test(entry.name)) {
        const name = !parent.parts.length && REGISTERED_NAME.test(entry.name) ? entry.name.toLowerCase() : parts.join('/');
        if (Buffer.byteLength(name) > 255) throw invalidChart();
        total += size;
        if (total > MAX_BYTES) throw invalidChart();
        members.push({ ...file, name, position: 0 });
      }
    }
  }
  return { ini, members, total };
}

async function writeRhythmVerseSng({ directory, filename, signal, includeVideo = true }) {
  if (!path.isAbsolute(directory) || !path.isAbsolute(filename) || typeof includeVideo !== 'boolean') throw invalidChart();
  signal?.throwIfAborted();
  const { ini, members, total } = await chartFiles(directory, includeVideo, signal);
  const metadataEntries = await readMetadata(ini, signal);
  const mask = randomBytes(16);
  let header;
  try {
    header = buildSngHeader({ mask, metadataEntries, members }, members);
  } catch {
    throw invalidChart();
  }

  const destinationDirectory = path.dirname(filename);
  const parent = await plainStat(destinationDirectory, true);
  signal?.throwIfAborted();
  const output = await fs.open(filename, 'wx', 0o600);
  let outputStat, complete = false;
  try {
    outputStat = await output.stat({ bigint: true });
    if (!sameIdentity(outputStat, await plainStat(filename, false))) throw invalidChart();
    async function write(bytes) {
      for (let offset = 0; offset < bytes.length;) {
        signal?.throwIfAborted();
        const { bytesWritten } = await output.write(bytes, offset, bytes.length - offset, null);
        if (!bytesWritten) throw invalidChart();
        offset += bytesWritten;
      }
    }
    await write(header);
    const buffer = Buffer.alloc(CHUNK_SIZE);
    for (const member of members) {
      await readVerified(member, signal, async input => {
        let position = 0;
        while (position < member.size) {
          signal?.throwIfAborted();
          const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, member.size - position), position);
          if (!bytesRead) throw invalidChart();
          for (let index = 0; index < bytesRead; index++) {
            const offset = position + index;
            buffer[index] ^= mask[offset & 15] ^ (offset & 255);
          }
          await write(buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
      });
    }
    signal?.throwIfAborted();
    await output.sync();
    const finished = await plainStat(filename, false);
    const bytes = header.length + total;
    if (!sameIdentity(parent, await plainStat(destinationDirectory, true)) || !sameIdentity(outputStat, finished)
      || finished.size !== BigInt(bytes)) throw invalidChart();
    signal?.throwIfAborted();
    complete = true;
    return { filename, files: members.length, bytes, format: 'sng' };
  } finally {
    try {
      await output.close();
    } finally {
      if (!complete && outputStat) {
        try {
          if (sameIdentity(parent, await plainStat(destinationDirectory, true)) && sameIdentity(outputStat, await plainStat(filename, false))) {
            await fs.unlink(filename);
          }
        } catch { /* A replaced destination is not owned by this conversion. */ }
      }
    }
  }
}

module.exports = { writeRhythmVerseSng };
