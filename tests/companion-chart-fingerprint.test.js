const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { Module, createRequire } = require('node:module');
const { fingerprintChart } = require('../companion/chart-fingerprint.cjs');

const chart = Buffer.from('[Song]\n{\n  Name = "Example"\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  0 = N 0 192\n}\n');
// A standard MIDI file with one note and an end-of-track event.
const midi = Buffer.from('4d546864000000060000000100c04d54726b0000000d00903c648140803c0000ff2f00', 'hex');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const u64 = value => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; };
const textField = value => { const bytes = Buffer.from(value), prefix = Buffer.alloc(4); prefix.writeInt32LE(bytes.length); return Buffer.concat([prefix, bytes]); };

function sng(members, metadata = { name: 'Example', artist: 'Artist' }) {
  const mask = Buffer.from('01478baefacd65763990452201814eee', 'hex');
  const pairs = Object.entries(metadata);
  const meta = Buffer.concat([u64(pairs.length), ...pairs.flatMap(([key, value]) => [textField(key), textField(value)])]);
  const indexLength = 8 + members.reduce((sum, member) => sum + 17 + Buffer.byteLength(member.name), 0);
  const start = 26 + 8 + meta.length + 8 + indexLength + 8;
  let position = start;
  const ranges = [];
  const index = Buffer.concat([u64(members.length), ...members.map(member => {
    const name = Buffer.from(member.name), entry = Buffer.concat([Buffer.from([name.length]), name, u64(member.bytes.length), u64(position)]);
    ranges.push({ name: member.name, start: position, end: position + member.bytes.length }); position += member.bytes.length;
    return entry;
  })]);
  const header = Buffer.concat([Buffer.from('SNGPKG'), Buffer.from([1, 0, 0, 0]), mask]);
  const encoded = members.map(member => Buffer.from(member.bytes.map((byte, index) => byte ^ mask[index % 16] ^ (index & 255))));
  return { bytes: Buffer.concat([header, u64(meta.length), meta, u64(index.length), index, u64(position - start), ...encoded]),
    ranges, metadataStart: 34, indexPrefix: 34 + meta.length, indexStart: 42 + meta.length, dataPrefix: start - 8 };
}

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-fingerprint-'));
  const root = path.join(base, 'songs'); await fs.mkdir(root);
  t.after(async () => {
    if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-fingerprint-')) throw Error('Unexpected fingerprint test directory');
    await fs.rm(base, { recursive: true, force: true });
  });
  async function write(relative, bytes) { const filename = path.join(root, relative); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, bytes); return filename; }
  const fingerprint = (relativePath, format, extra = {}) => fingerprintChart({ rootPath: root, relativePath, format, ...extra });
  return { base, root, write, fingerprint };
}
async function injected(overrides) {
  const absolute = require.resolve('../companion/chart-fingerprint.cjs'), local = new Module(absolute, module), normal = createRequire(absolute);
  local.filename = absolute; local.paths = Module._nodeModulePaths(path.dirname(absolute));
  local.require = name => Object.hasOwn(overrides, name) ? overrides[name] : normal(name);
  local._compile(await fs.readFile(absolute, 'utf8'), absolute); return local.exports.fingerprintChart;
}
function wrappedHandle(handle, overrides) {
  return { stat: handle.stat.bind(handle), read: handle.read.bind(handle), close: handle.close.bind(handle), ...overrides };
}
function unreadable(result, status = 'unavailable') {
  assert.equal(result.status, status); assert.equal(result.sha256, null); assert.equal(result.bytes, null); assert.equal(result.modifiedAt, null);
  assert.match(result.reason, /^[a-z-]+$/);
}

test('fingerprints entire chart and MIDI bytes, including byte encoding differences', async t => {
  const f = await fixture(t);
  await f.write('A/notes.chart', chart); await f.write('B/notes.chart', chart);
  await f.write('C/notes.mid', midi); await f.write('D/notes.chart', Buffer.from('\ufeff' + chart.toString(), 'utf16le'));
  await f.write('E/notes.chart', Buffer.from(chart.toString().replace(/\n/g, '\r\n')));
  const a = await f.fingerprint('A/notes.chart', 'chart'), b = await f.fingerprint('B/notes.chart', 'chart');
  assert.equal(a.status, 'readable'); assert.equal(a.sha256, digest(chart)); assert.equal(a.sha256, b.sha256);
  assert.equal(a.bytes, chart.length); assert.equal(a.format, 'chart'); assert.equal(a.reason, null); assert.ok(Number.isFinite(Date.parse(a.modifiedAt)));
  const mid = await f.fingerprint('C/notes.mid', 'midi'); assert.equal(mid.sha256, digest(midi)); assert.equal(mid.format, 'midi');
  for (const name of ['D', 'E']) assert.notEqual((await f.fingerprint(name + '/notes.chart', 'chart')).sha256, a.sha256);
  await f.write('F/notes.chart', Buffer.from(midi));
  const sameBytesOtherFormat = await f.fingerprint('F/notes.chart', 'chart');
  assert.equal(sameBytesOtherFormat.sha256, mid.sha256); assert.notEqual(sameBytesOtherFormat.format, mid.format, 'bytes alone do not establish chart/MIDI equivalence');
});

test('SNG fingerprints match standalone decoded notes; chart takes precedence over MIDI', async t => {
  const f = await fixture(t);
  await f.write('plain/notes.chart', chart); await f.write('plain/notes.mid', midi);
  const withChart = sng([{ name: 'song.ogg', bytes: Buffer.alloc(293, 75) }, { name: 'notes.mid', bytes: midi }, { name: 'notes.chart', bytes: chart }]);
  await f.write('chart.sng', withChart.bytes);
  await f.write('midi.sng', sng([{ name: 'notes.mid', bytes: midi }, { name: 'song.ogg', bytes: Buffer.alloc(9000, 21) }]).bytes);
  await f.write('changed.sng', sng([{ name: 'notes.chart', bytes: Buffer.concat([chart, Buffer.from('\n')]) }]).bytes);
  const packedChart = await f.fingerprint('chart.sng', 'sng'), packedMidi = await f.fingerprint('midi.sng', 'sng');
  assert.equal(packedChart.status, 'readable'); assert.equal(packedChart.format, 'chart'); assert.equal(packedChart.bytes, chart.length);
  assert.equal(packedChart.sha256, (await f.fingerprint('plain/notes.chart', 'chart')).sha256);
  assert.equal(packedMidi.sha256, (await f.fingerprint('plain/notes.mid', 'midi')).sha256); assert.equal(packedMidi.format, 'midi');
  assert.notEqual((await f.fingerprint('changed.sng', 'sng')).sha256, packedChart.sha256);
});

test('SNG hashing reads no audio payload and streams note data through bounded reads', async t => {
  const f = await fixture(t), large = Buffer.alloc(2 * 1024 * 1024 + 523);
  for (let index = 0; index < large.length; index++) large[index] = (index * 31 + Math.floor(index / 17)) & 255;
  const archive = sng([{ name: 'song.ogg', bytes: Buffer.alloc(12001, 5) }, { name: 'notes.chart', bytes: large }, { name: 'preview.ogg', bytes: Buffer.alloc(601, 7) }]);
  await f.write('large.sng', archive.bytes); let reads = 0, largest = 0;
  const audioRanges = archive.ranges.filter(range => range.name.endsWith('.ogg'));
  const fingerprint = await injected({ 'node:fs/promises': { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return wrappedHandle(handle, { read: async (buffer, offset, length, position) => {
      for (const range of audioRanges) assert.ok(position + length <= range.start || position >= range.end, 'audio payload must never be read');
      largest = Math.max(largest, length); reads++; return handle.read(buffer, offset, length, position);
    } });
  } } });
  const result = await fingerprint({ rootPath: f.root, relativePath: 'large.sng', format: 'sng' });
  assert.equal(result.status, 'readable'); assert.equal(result.sha256, digest(large)); assert.equal(result.bytes, large.length);
  assert.ok(largest <= 64 * 1024); assert.ok(reads > 32);
});

test('unsupported formats never open files, unsafe paths and missing entries do not leak paths', async t => {
  const f = await fixture(t); let opened = 0;
  const fingerprint = await injected({ 'node:fs/promises': { ...fs, open: async () => { opened++; throw Error('Must not open'); } } });
  for (const [relativePath, format] of [['song.ogg', 'chart'], ['notes.chart', 'audio'], ['song.ogg', 'sng']]) {
    unreadable(await fingerprint({ rootPath: f.root, relativePath, format }), 'unsupported');
  }
  assert.equal(opened, 0);
  for (const relativePath of ['../notes.chart', '/notes.chart', 'C:/notes.chart', 'folder/../notes.chart', 'folder\\notes.chart', 'folder//notes.chart', 'folder./notes.chart', 'AUX/notes.chart']) {
    const result = await f.fingerprint(relativePath, 'chart'); unreadable(result); assert.ok(!JSON.stringify(result).includes(f.root));
  }
  unreadable(await f.fingerprint('missing/notes.chart', 'chart'));
});

test('valid containers without registered notes and unsupported versions remain unsupported', async t => {
  const f = await fixture(t);
  await f.write('audio.sng', sng([{ name: 'song.ogg', bytes: Buffer.alloc(111) }]).bytes);
  await f.write('nested.sng', sng([{ name: 'sub/notes.chart', bytes: chart }]).bytes);
  const unknown = sng([{ name: 'notes.mid', bytes: midi }]).bytes; unknown.writeUInt32LE(2, 6); await f.write('new.sng', unknown);
  for (const name of ['audio.sng', 'nested.sng', 'new.sng']) unreadable(await f.fingerprint(name, 'sng'), 'unsupported');
});

test('malformed SNG indexes, names, strings, ranges and truncated sections never produce a hash', async t => {
  const f = await fixture(t), base = sng([{ name: 'notes.chart', bytes: chart }, { name: 'song.ogg', bytes: Buffer.alloc(33) }]);
  const cases = [base.bytes.subarray(0, 25), base.bytes.subarray(0, base.bytes.length - 1), Buffer.concat([base.bytes, Buffer.from([0])])];
  const change = fn => { const bytes = Buffer.from(base.bytes); fn(bytes); cases.push(bytes); };
  change(bytes => { bytes[0] = 0xd3; });
  change(bytes => bytes.writeBigUInt64LE(2n ** 63n, 26));
  change(bytes => bytes.writeBigUInt64LE(4097n, base.metadataStart));
  change(bytes => bytes.writeInt32LE(-1, base.metadataStart + 8));
  change(bytes => { bytes[base.metadataStart + 12] = 0xff; });
  change(bytes => bytes.writeBigUInt64LE(2n ** 63n, base.indexPrefix));
  change(bytes => bytes.writeBigUInt64LE(4097n, base.indexStart));
  change(bytes => { bytes[base.indexStart + 8] = 255; });
  const firstLength = base.indexStart + 9 + Buffer.byteLength('notes.chart');
  change(bytes => bytes.writeBigUInt64LE(BigInt(base.bytes.length), firstLength));
  change(bytes => bytes.writeBigUInt64LE(0n, firstLength + 8));
  change(bytes => bytes.writeBigUInt64LE(2n ** 63n, firstLength + 8));
  change(bytes => bytes.writeBigUInt64LE(2n ** 63n, base.dataPrefix));
  const secondPosition = firstLength + 16 + 1 + Buffer.byteLength('song.ogg') + 8;
  change(bytes => bytes.writeBigUInt64LE(BigInt(base.ranges[0].start), secondPosition));
  for (const name of ['../notes.chart', '/notes.chart', 'x\\notes.chart', 'x:notes.chart', 'foo..bar', 'NUL.txt', 'foo./notes.chart', 'note\0.chart', 'foo?/notes.chart']) cases.push(sng([{ name, bytes: chart }]).bytes);
  cases.push(sng([{ name: 'notes.chart', bytes: chart }, { name: 'NOTES.CHART', bytes: chart }]).bytes);
  for (let index = 0; index < cases.length; index++) {
    await f.write('invalid.sng', cases[index]); const result = await f.fingerprint('invalid.sng', 'sng');
    unreadable(result); assert.equal(result.format, null, 'invalid case ' + index); assert.ok(!JSON.stringify(result).includes(f.root));
  }
});

test('short successful reads are retried until every note byte has been hashed', async t => {
  const f = await fixture(t); await f.write('notes.chart', chart);
  const fingerprint = await injected({ 'node:fs/promises': { ...fs, open: async (...args) => {
    const handle = await fs.open(...args); return wrappedHandle(handle, { read: (buffer, offset, length, position) => handle.read(buffer, offset, Math.min(7, length), position) });
  } } });
  assert.equal((await fingerprint({ rootPath: f.root, relativePath: 'notes.chart', format: 'chart' })).sha256, digest(chart));
});

test('cancellation before opening or during reading throws AbortError and closes handles', async t => {
  const f = await fixture(t); await f.write('notes.chart', Buffer.alloc(256 * 1024));
  const before = new AbortController(); before.abort();
  await assert.rejects(f.fingerprint('notes.chart', 'chart', { signal: before.signal }), { name: 'AbortError', code: 'ABORT_ERR' });
  const during = new AbortController(); let closed = 0;
  const fingerprint = await injected({ 'node:fs/promises': { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return wrappedHandle(handle, { read: async (...readArgs) => { const result = await handle.read(...readArgs); during.abort(); return result; }, close: async () => { closed++; await handle.close(); } });
  } } });
  await assert.rejects(fingerprint({ rootPath: f.root, relativePath: 'notes.chart', format: 'chart', signal: during.signal }), { name: 'AbortError' });
  assert.equal(closed, 1);
});

test('directory links and linked roots are rejected, including junctions on Windows', async t => {
  const f = await fixture(t); await f.write('real/notes.chart', chart);
  const link = path.join(f.root, 'linked');
  try { await fs.symlink(path.join(f.root, 'real'), link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('This host cannot create directory links'); return; } throw error; }
  unreadable(await f.fingerprint('linked/notes.chart', 'chart'));
  unreadable(await fingerprintChart({ rootPath: link, relativePath: 'notes.chart', format: 'chart' }));
  const fileLink = path.join(f.root, 'linked.chart');
  try { await fs.symlink(path.join(f.root, 'real', 'notes.chart'), fileLink, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return; throw error; }
  unreadable(await f.fingerprint('linked.chart', 'chart'));
});

test('a replaced file between inspection and open is rejected before reading any bytes', async t => {
  const f = await fixture(t), target = await f.write('notes.chart', chart); let reads = 0;
  const fingerprint = await injected({ 'node:fs/promises': { ...fs, open: async (...args) => {
    await fs.rename(target, path.join(f.root, 'old.chart')); await fs.writeFile(target, chart);
    const handle = await fs.open(...args); return wrappedHandle(handle, { read: async (...readArgs) => { reads++; return handle.read(...readArgs); } });
  } } });
  unreadable(await fingerprint({ rootPath: f.root, relativePath: 'notes.chart', format: 'chart' })); assert.equal(reads, 0);
});

test('directory replacement with a junction between checks and open is rejected before reading', async t => {
  const f = await fixture(t); await f.write('inside/notes.chart', chart);
  const outside = path.join(f.base, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'notes.chart'), chart);
  let canLink = true;
  try { await fs.symlink(outside, path.join(f.base, 'probe'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) canLink = false; else throw error; }
  if (!canLink) { t.skip('This host cannot create directory links'); return; }
  let reads = 0;
  const fingerprint = await injected({ 'node:fs/promises': { ...fs, open: async (...args) => {
    await fs.rename(path.join(f.root, 'inside'), path.join(f.root, 'renamed'));
    await fs.symlink(outside, path.join(f.root, 'inside'), process.platform === 'win32' ? 'junction' : 'dir');
    const handle = await fs.open(...args); return wrappedHandle(handle, { read: async (...readArgs) => { reads++; return handle.read(...readArgs); } });
  } } });
  unreadable(await fingerprint({ rootPath: f.root, relativePath: 'inside/notes.chart', format: 'chart' })); assert.equal(reads, 0);
});

test('truncation and same-size changes during a read discard the tentative hash', async t => {
  const f = await fixture(t), original = Buffer.alloc(256 * 1024, 1);
  for (const mutation of ['truncate', 'rewrite']) {
    const filename = await f.write('notes.chart', original); let changed = false;
    const fingerprint = await injected({ 'node:fs/promises': { ...fs, open: async (...args) => {
      const handle = await fs.open(...args);
      return wrappedHandle(handle, { read: async (...readArgs) => {
        const result = await handle.read(...readArgs);
        if (!changed) { changed = true;
          if (mutation === 'truncate') await fs.truncate(filename, 128);
          else { await fs.writeFile(filename, Buffer.alloc(original.length, 2)); await fs.utimes(filename, new Date(), new Date(Date.now() + 2000)); }
        }
        return result;
      } });
    } } });
    unreadable(await fingerprint({ rootPath: f.root, relativePath: 'notes.chart', format: 'chart' }));
  }
});
