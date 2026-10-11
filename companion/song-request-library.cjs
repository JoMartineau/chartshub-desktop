'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const { fingerprintChart } = require('./chart-fingerprint.cjs');
const samePath = (a, b) => path.relative(a, b) === '';
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const failure = () => Error('Cette chanson installée est indisponible ou son chemin a changé.');

async function inspect(root, relative, previous) {
  const names = [root];
  for (const component of relative.split('/')) names.push(path.join(names.at(-1), component));
  const entries = [];
  for (const [index, filename] of names.entries()) {
    const stat = await fs.lstat(filename, { bigint: true });
    const last = index === names.length - 1;
    if (stat.isSymbolicLink() || (last ? !stat.isFile() : !stat.isDirectory()) || !samePath(filename, await fs.realpath(filename))) throw failure();
    if (previous && !(last ? sameFile(previous[index], stat) : sameIdentity(previous[index], stat))) throw failure();
    entries.push(stat);
  }
  return entries;
}
async function readSafe(root, relative, maximum, prefixOnly = false) {
  const entries = await inspect(root, relative), before = entries.at(-1);
  const handle = await fs.open(path.join(root, ...relative.split('/')), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(before, opened)) throw failure();
    if (before.size > BigInt(maximum) && !prefixOnly) {
      if (!sameFile(before, await handle.stat({ bigint: true }))) throw failure();
      await inspect(root, relative, entries);
      return null;
    }
    const length = Number(before.size < BigInt(maximum) ? before.size : BigInt(maximum));
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const result = await handle.read(bytes, offset, length - offset, offset);
      if (!result.bytesRead) throw failure();
      offset += result.bytesRead;
    }
    if (!sameFile(before, await handle.stat({ bigint: true }))) throw failure();
    await inspect(root, relative, entries);
    return bytes;
  } finally { await handle.close(); }
}

const chartInstruments = { Single: 'guitar', DoubleBass: 'bass', Drums: 'drums', Keyboard: 'keys', DoubleRhythm: 'rhythm', DoubleGuitar: 'guitar-coop', GHLGuitar: 'guitar-6fret', GHLBass: 'bass-6fret', GHLRhythm: 'rhythm-6fret', GHLCoop: 'guitar-coop-6fret' };
function chartTracks(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const tracks = [];
  for (const section of text.matchAll(/^\s*\[(Easy|Medium|Hard|Expert)([A-Za-z]+)\]\s*\r?\n\s*\{([^}]*)\}/gm)) {
    const instrument = chartInstruments[section[2]];
    const playable = instrument?.includes('6fret') ? '(?:[0-4]|[78])' : instrument === 'drums' ? '[0-5]' : '(?:[0-4]|7)';
    if (!instrument || !new RegExp('^\\s*\\d+\\s*=\\s*N\\s+' + playable + '\\s+\\d+', 'm').test(section[3])) continue;
    const difficulty = section[1].toLowerCase();
    tracks.push({ instrument, difficulty });
    if (instrument === 'drums' && /^\s*\d+\s*=\s*N\s+6[678]\s+\d+/m.test(section[3])) tracks.push({ instrument: 'pro-drums', difficulty });
  }
  return tracks;
}
function midiTracks(bytes) {
  if (bytes.length < 14 || bytes.toString('ascii', 0, 4) !== 'MThd' || bytes.readUInt32BE(4) !== 6) throw failure();
  const instruments = { 'PART GUITAR': 'guitar', 'PART BASS': 'bass', 'PART DRUMS': 'drums', 'PART KEYS': 'keys', 'PART RHYTHM': 'rhythm', 'PART GUITAR COOP': 'guitar-coop' };
  const tracks = [], trackCount = bytes.readUInt16BE(10);
  if (trackCount > 256) return tracks;
  let offset = 14, events = 0;
  for (let track = 0; track < trackCount; track++) {
    if (offset + 8 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'MTrk') throw failure();
    const end = offset + 8 + bytes.readUInt32BE(offset + 4);
    if (end > bytes.length) throw failure();
    offset += 8;
    let running = 0, name = '', cymbals = false;
    const notes = new Set();
    const variable = () => {
      let value = 0;
      for (let i = 0; i < 4; i++) {
        if (offset >= end) throw failure();
        const byte = bytes[offset++]; value = value * 128 + (byte & 127);
        if (!(byte & 128)) return value;
      }
      throw failure();
    };
    while (offset < end) {
      if (++events > 500000) return [];
      variable();
      let status = bytes[offset];
      if (status >= 128) { offset++; if (status < 240) running = status; else running = 0; }
      else { status = running; if (!status) throw failure(); }
      if (status === 255) {
        if (offset >= end) throw failure();
        const type = bytes[offset++], length = variable();
        if (length > end - offset) throw failure();
        if (type === 3 && length <= 128) name = bytes.toString('utf8', offset, offset + length).trim().toUpperCase();
        offset += length;
      } else if (status === 240 || status === 247) {
        const length = variable(); if (length > end - offset) throw failure(); offset += length;
      } else if (status < 240) {
        const count = (status >> 4) === 12 || (status >> 4) === 13 ? 1 : 2;
        if (offset + count > end || bytes[offset] > 127 || (count === 2 && bytes[offset + 1] > 127)) throw failure();
        if ((status >> 4) === 9 && bytes[offset + 1] > 0) { notes.add(bytes[offset]); cymbals ||= bytes[offset] >= 110 && bytes[offset] <= 112; }
        offset += count;
      } else throw failure();
    }
    const instrument = instruments[name];
    if (instrument) for (const [level, start] of [['easy', 60], ['medium', 72], ['hard', 84], ['expert', 96]]) {
      if (![...notes].some(note => note >= start && note <= start + (instrument === 'drums' ? 5 : 4))) continue;
      tracks.push({ instrument, difficulty: level });
      if (instrument === 'drums' && cymbals) tracks.push({ instrument: 'pro-drums', difficulty: level });
    }
  }
  return tracks;
}

/** Main/worker only: callers supply an indexed item, never a path from a viewer. */
async function resolveInstalledSong(rootPath, item) {
  const relative = item?.relativePath;
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || typeof relative !== 'string' || !relative
    || /[\\<>:"|?*\u0000-\u001f\u007f]/.test(relative) || relative.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))
    || !/^[a-f0-9]{64}$/.test(item?.id) || item.id !== createHash('sha256').update(relative).digest('hex')) throw failure();
  const root = path.resolve(rootPath);
  const expectedExtension = { chart: '.chart', midi: '.mid', sng: '.sng' }[item.format];
  if (!expectedExtension || path.posix.extname(relative).toLowerCase() !== expectedExtension) throw failure();
  const bytes = await readSafe(root, relative, item.format === 'sng' ? 26 : 16 * 1024 * 1024, item.format === 'sng');
  if (!bytes || !bytes.length) throw failure();
  if (item.format === 'sng') {
    const proof = await fingerprintChart({ rootPath: root, relativePath: relative, format: item.format });
    if (proof.status !== 'readable' || !proof.bytes) throw failure();
  }
  let tracks;
  if (item.format !== 'sng') {
    try { tracks = item.format === 'chart' ? chartTracks(bytes) : midiTracks(bytes); } catch { throw failure(); }
    if (item.format === 'chart' && !tracks.length) throw failure();
  }
  const directory = path.posix.dirname(relative), ini = directory === '.' ? 'song.ini' : directory + '/song.ini';
  let durationMs;
  try {
    const metadata = await readSafe(root, ini, 128 * 1024);
    if (metadata) {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(metadata);
      let section = '', length = null, conflict = false;
      for (const line of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const heading = /^\s*\[([^\]]+)\]\s*$/.exec(line);
        if (heading) { section = heading[1].trim().toLowerCase(); continue; }
        if (section !== 'song') continue;
        const entry = /^\s*song_length\s*=\s*(.*?)\s*$/i.exec(line);
        if (!entry) continue;
        if (length !== null && length !== entry[1]) conflict = true;
        length = entry[1];
      }
      if (!conflict && length && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) && Number(length) > 0) durationMs = Number(length);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw failure(); }
  return { id: item.id, title: item.title, artist: item.artist, charter: item.charter, ...(durationMs ? { durationMs } : {}), ...(tracks ? { tracks } : {}) };
}
module.exports = { resolveInstalledSong, chartTracks, midiTracks };
