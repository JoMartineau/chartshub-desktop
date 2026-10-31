'use strict';
// Chart/MIDI source specifications:
// https://github.com/TheNathannator/GuitarGame_ChartFormats/tree/main/docs/Chart-File-Formats
// No audio offsets are applied: these positions share the native chart clock.
const MAX_BYTES = 16 * 1024 * 1024, MAX_EVENTS = 1000000, MAX_LYRICS = 50000, MAX_LINES = 10000;
const fail = reason => { throw Object.assign(Error('Lyrics unavailable'), { reason }); };
const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff;
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function words(syllables) {
  let result = '', join = false;
  for (let raw of syllables) {
    if (raw.length > 2048 || /[\u0000-\u001f\u007f]/u.test(raw)) fail('invalid');
    raw = raw.replace(/<[^>]{0,256}>/gu, '').replace(/[+#^*%$/]/gu, '').replace(/[_§]/gu, ' ').trim();
    if (!raw) continue;
    const nextJoin = /[-=]$/u.test(raw), value = raw.replace(/-/gu, '').replace(/=/gu, '-');
    result += (result && !join ? ' ' : '') + value;
    join = nextJoin;
    if (result.length > 512) fail('unsupported');
  }
  return result.normalize('NFC').replace(/\s+/gu, ' ').trim();
}
function timeline(resolution, tempos) {
  if (!Number.isSafeInteger(resolution) || resolution < 1 || resolution > 32767) fail('invalid');
  tempos.sort((a,b) => a.tick - b.tick);
  const segments = [{ tick: 0, seconds: 0, micros: 500000 }];
  for (const tempo of tempos) {
    if (!integer(tempo.tick) || !Number.isFinite(tempo.micros) || tempo.micros <= 0 || tempo.micros > 60000000) fail('invalid');
    const last = segments.at(-1);
    if (last.tick === tempo.tick) {
      if (last.explicit && last.micros !== tempo.micros) fail('ambiguous');
      last.micros = tempo.micros; last.explicit = true; continue;
    }
    const seconds = last.seconds + (tempo.tick - last.tick) * last.micros / resolution / 1000000;
    if (!Number.isFinite(seconds) || seconds > 86400) fail('unsupported');
    segments.push({ ...tempo, seconds, explicit: true });
  }
  return tick => {
    if (!integer(tick)) fail('invalid');
    let low = 0, high = segments.length - 1;
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (segments[middle].tick <= tick) low = middle; else high = middle - 1; }
    const s = segments[low], seconds = s.seconds + (tick - s.tick) * s.micros / resolution / 1000000;
    if (!Number.isFinite(seconds) || seconds > 86400) fail('unsupported');
    return seconds;
  };
}
function assemble(resolution, tempos, phrases, syllables) {
  if (!syllables.length) return { lines: [], reason: 'missing' };
  if (syllables.length > MAX_LYRICS || phrases.length > MAX_LINES) fail('unsupported');
  phrases.sort((a,b) => a.start - b.start || a.end - b.end);
  const unique = [];
  for (const p of phrases) {
    if (!integer(p.start) || !integer(p.end) || p.end <= p.start) fail('invalid');
    const last = unique.at(-1);
    if (last && last.start === p.start && last.end === p.end) continue;
    if (last && last.end > p.start) fail('ambiguous');
    unique.push(p);
  }
  syllables.sort((a,b) => a.tick - b.tick);
  const toSeconds = timeline(resolution, tempos), lines = []; let cursor = 0;
  for (const p of unique) {
    const collected = []; let previous = null;
    while (cursor < syllables.length && syllables[cursor].tick < p.end) {
      const s = syllables[cursor++];
      if (!integer(s.tick) || s.tick < p.start) fail('invalid');
      if (previous?.tick === s.tick) { if (previous.text !== s.text) fail('ambiguous'); continue; }
      collected.push(s.text); previous = s;
    }
    const text = words(collected);
    if (text) lines.push({ startSeconds: toSeconds(p.start), endSeconds: toSeconds(p.end), text });
  }
  if (cursor !== syllables.length) fail('invalid');
  return { lines, reason: lines.length ? null : 'missing' };
}
function chart(bytes) {
  const source = decode(bytes).replace(/^\uFEFF/u, ''), sections = new Map();
  let heading = null, open = false, count = 0;
  for (const original of source.split(/\r?\n/u)) {
    const line = original.trim(); if (!line) continue;
    if (++count > MAX_EVENTS) fail('unsupported');
    if (line.length > 8192) fail('unsupported');
    const name = /^\[([^\]]+)\]$/u.exec(line);
    if (name) { if (open || heading !== null) fail('invalid'); heading = name[1]; continue; }
    if (line === '{') { if (!heading || open || sections.has(heading)) fail('invalid'); sections.set(heading, []); open = true; continue; }
    if (line === '}') { if (!open) fail('invalid'); open = false; heading = null; continue; }
    if (!open) fail('invalid');
    if (['Song','SyncTrack','Events'].includes(heading)) sections.get(heading).push(line);
  }
  if (open || heading) fail('invalid');
  const syllables = [], phrases = [], tempos = []; let start = null, resolution = null;
  for (const line of sections.get('Events') || []) {
    const e = /^(\d+)\s*=\s*E\s+"(.*)"$/u.exec(line); if (!e) continue;
    const tick = Number(e[1]), value = e[2]; if (!integer(tick)) fail('invalid');
    if (value === 'phrase_start') { if (start !== null) phrases.push({ start, end: tick }); start = tick; }
    else if (value === 'phrase_end') { if (start !== null) phrases.push({ start, end: tick }); start = null; }
    else if (value.startsWith('lyric ')) { syllables.push({ tick, text: value.slice(6) }); if (syllables.length > MAX_LYRICS) fail('unsupported'); }
  }
  if (!syllables.length) return { lines: [], reason: 'missing' };
  if (start !== null) fail('invalid');
  for (const line of sections.get('Song') || []) {
    const r = /^Resolution\s*=\s*(\d+)$/u.exec(line); if (r) { if (resolution !== null) fail('ambiguous'); resolution = Number(r[1]); }
  }
  for (const line of sections.get('SyncTrack') || []) {
    const t = /^(\d+)\s*=\s*B\s+(\d+)$/u.exec(line);
    if (t) tempos.push({ tick: Number(t[1]), micros: 60000000000 / Number(t[2]) });
    else if (/^\d+\s*=\s*B\b/u.test(line)) fail('invalid');
  }
  return assemble(resolution, tempos, phrases, syllables);
}
function midi(bytes) {
  if (bytes.length < 14 || bytes.toString('ascii',0,4) !== 'MThd' || bytes.readUInt32BE(4) !== 6) fail('invalid');
  const format = bytes.readUInt16BE(8), tracks = bytes.readUInt16BE(10), resolution = bytes.readUInt16BE(12);
  if (format !== 1 || resolution & 0x8000) fail('unsupported');
  if (!tracks || tracks > 256 || !resolution) fail('invalid');
  const tempos = [], vocals = []; let offset = 14, events = 0;
  for (let track = 0; track < tracks; track++) {
    if (offset + 8 > bytes.length || bytes.toString('ascii',offset,offset+4) !== 'MTrk') fail('invalid');
    const end = offset + 8 + bytes.readUInt32BE(offset + 4); offset += 8;
    if (end > bytes.length) fail('invalid');
    let tick = 0, running = 0, name = null, ended = false;
    const syllables = [], phrases = [], phraseEvents = [];
    const variable = () => { let value = 0; for (let n = 0; n < 4; n++) { if (offset >= end) fail('invalid'); const b = bytes[offset++]; value = value * 128 + (b & 127); if (!(b & 128)) return value; } fail('invalid'); };
    while (offset < end) {
      if (++events > MAX_EVENTS) fail('unsupported');
      tick += variable(); if (!integer(tick) || offset >= end || ended) fail('invalid');
      let status = bytes[offset]; if (status & 128) offset++; else { if (!running) fail('invalid'); status = running; }
      if (status === 0xff) {
        if (offset >= end) fail('invalid'); const type = bytes[offset++], length = variable();
        if (length > end - offset) fail('invalid'); const data = bytes.subarray(offset, offset + length); offset += length;
        if (type === 0x03) { const next = decode(data); if (name !== null && name !== next) fail('ambiguous'); name = next; }
        else if (type === 0x51) { if (length !== 3 || track !== 0) fail('unsupported'); tempos.push({ tick, micros: data.readUIntBE(0,3) }); }
        else if (type === 0x01 || type === 0x05) { if (length > 2048) fail('unsupported'); const text = decode(data); if (text && !/^\[.*\]$/u.test(text)) syllables.push({ tick, text }); if (syllables.length > MAX_LYRICS) fail('unsupported'); }
        else if (type === 0x2f) { if (length || offset !== end) fail('invalid'); ended = true; }
        // Preserve channel running status across meta events for established
        // chart writers that use this widespread MIDI-spec deviation.
      } else if (status === 0xf0 || status === 0xf7) {
        const length = variable(); if (length > end - offset) fail('invalid'); offset += length; running = 0;
      } else {
        if (status < 0x80 || status > 0xef) fail('unsupported'); running = status;
        const type = status >>> 4, length = type === 0xc || type === 0xd ? 1 : 2;
        if (length > end - offset) fail('invalid'); const note = bytes[offset], velocity = bytes[offset+1];
        for (let n = 0; n < length; n++) if (bytes[offset+n] & 128) fail('invalid'); offset += length;
        if ((type === 8 || type === 9) && (note === 105 || note === 106)) {
          phraseEvents.push({tick,status,note,velocity});
        }
      }
    }
    if (!ended) fail('invalid');
    if (name === 'PART VOCALS') {
      const active = new Map();
      for (const event of phraseEvents) {
        const key = `${event.status & 15}:${event.note}`;
        if (event.status >>> 4 === 9 && event.velocity > 0) { if (active.has(key)) fail('ambiguous'); active.set(key, event.tick); }
        else { if (!active.has(key)) fail('invalid'); phrases.push({ start: active.get(key), end: event.tick }); active.delete(key); }
      }
      if (active.size) fail('invalid'); vocals.push({ syllables, phrases });
    }
  }
  if (offset !== bytes.length) fail('invalid');
  if (!vocals.length) return { lines: [], reason: 'missing' };
  if (vocals.length !== 1) fail('ambiguous');
  return assemble(resolution, tempos, vocals[0].phrases, vocals[0].syllables);
}
function parseSongLyrics(bytes, format) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) fail('unsupported');
    if (format === 'chart') return chart(bytes);
    if (format === 'midi') return midi(bytes);
    fail('unsupported');
  } catch (error) { return { lines: [], reason: ['missing','unsupported','ambiguous'].includes(error?.reason) ? error.reason : 'invalid' }; }
}
module.exports = { parseSongLyrics, MAX_BYTES };
