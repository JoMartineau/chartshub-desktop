const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { Module, createRequire } = require('node:module');
const { inspectChartBundle, revalidateBundle, recheckBundleIdentity, captureBundleSnapshot, bundleSnapshot } = require('../companion/chart-bundle.cjs');

const chart = Buffer.from('[Song]\n{\n  Name = "Example"\n  Resolution = 192\n}\n[ExpertSingle]\n{\n  0 = N 0 192\n}\n');
const audio = Buffer.from('Fixture audio bytes, compared exactly, without decoding sound.');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const u64 = value => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; };
const textField = value => { const bytes = Buffer.from(value), length = Buffer.alloc(4); length.writeInt32LE(bytes.length); return Buffer.concat([length, bytes]); };
function sng(members, { seed = 0, title = 'Example' } = {}) {
  const mask = Buffer.from(Array.from({ length: 16 }, (_, index) => (index * 17 + seed) & 255));
  const meta = Buffer.concat([u64(1), textField('name'), textField(title)]);
  const indexLength = 8 + members.reduce((sum, member) => sum + 17 + Buffer.byteLength(member.name), 0);
  const start = 26 + 8 + meta.length + 8 + indexLength + 8; let position = start;
  const ranges = [];
  const index = Buffer.concat([u64(members.length), ...members.map(member => {
    const name = Buffer.from(member.name), entry = Buffer.concat([Buffer.from([name.length]), name, u64(member.bytes.length), u64(position)]);
    ranges.push({ name: member.name, start: position, end: position + member.bytes.length }); position += member.bytes.length;
    return entry;
  })]);
  const header = Buffer.concat([Buffer.from('SNGPKG'), Buffer.from([1, 0, 0, 0]), mask]);
  const encoded = members.map(member => Buffer.from(member.bytes.map((byte, offset) => byte ^ mask[offset % 16] ^ (offset & 255))));
  return { bytes: Buffer.concat([header, u64(meta.length), meta, u64(index.length), index, u64(position - start), ...encoded]), ranges,
    indexStart: 42 + meta.length, dataPrefix: start - 8 };
}
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-bundle-')), root = path.join(base, 'songs'); await fs.mkdir(root);
  t.after(async () => {
    if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-bundle-')) throw Error('Unexpected bundle test directory');
    await fs.rm(base, { recursive: true, force: true });
  });
  async function write(relative, bytes) { const filename = path.join(root, relative); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, bytes); return filename; }
  async function song(name, additions = {}) {
    for (const [file, bytes] of Object.entries({ 'notes.chart': chart, 'song.ogg': audio, ...additions })) await write(name + '/' + file, bytes);
  }
  const inspect = (relativePath, format = 'chart', extra = {}) => inspectChartBundle({ rootPath: root, relativePath, format, ...extra });
  const revalidate = (relativePath, expected, format = 'chart') => revalidateBundle({ rootPath: root, relativePath, format, expected });
  return { base, root, write, song, inspect, revalidate };
}
async function injected(overrides) {
  const absolute = require.resolve('../companion/chart-bundle.cjs'), local = new Module(absolute, module), normal = createRequire(absolute);
  local.filename = absolute; local.paths = Module._nodeModulePaths(path.dirname(absolute));
  local.require = name => Object.hasOwn(overrides, name) ? overrides[name] : normal(name);
  local._compile(await fs.readFile(absolute, 'utf8'), absolute); return local.exports;
}
function wrappedHandle(handle, overrides) {
  return { stat: handle.stat.bind(handle), read: handle.read.bind(handle), close: handle.close.bind(handle), ...overrides };
}
function unavailable(result, status = 'unavailable') {
  assert.equal(result.status, status); assert.equal(result.bundleHash, null); assert.equal(result.identity, null);
  assert.equal(result.notes.sha256, null); assert.equal(result.audio.status, 'unavailable'); assert.match(result.reason, /^[a-z-]+$/);
}

test('complete folder comparison covers exact notes, song audio, previews and every extra filename', async t => {
  const f = await fixture(t);
  for (const name of ['A', 'B']) await f.song(name, { 'preview.ogg': Buffer.from('preview'), 'album.png': Buffer.from('art'), 'song.ini': Buffer.from('name=Example') });
  const a = await f.inspect('A/notes.chart'), b = await f.inspect('B/notes.chart');
  assert.equal(a.status, 'verified'); assert.equal(a.kind, 'folder'); assert.equal(a.targetRelativePath, 'A');
  assert.equal(a.notes.sha256, digest(chart)); assert.equal(a.audio.status, 'verified'); assert.equal(a.audio.count, 1);
  assert.equal(a.audio.bytes, audio.length + 7); assert.equal(a.entryCount, 5);
  assert.equal(a.totalBytes, chart.length + audio.length + 7 + 3 + 12);
  assert.equal(a.bundleHash, b.bundleHash); assert.equal(a.audio.digest, b.audio.digest); assert.equal(a.nonAudioHash, b.nonAudioHash);
  assert.notDeepEqual(a.identity, b.identity); assert.doesNotThrow(() => JSON.stringify(a.identity));
  assert.ok(!JSON.stringify(a).includes(f.root));

  await f.write('B/song.ogg', Buffer.from('Different audio'));
  const changedAudio = await f.inspect('B/notes.chart');
  assert.equal(changedAudio.notes.sha256, a.notes.sha256); assert.notEqual(changedAudio.audio.digest, a.audio.digest); assert.notEqual(changedAudio.bundleHash, a.bundleHash); assert.equal(changedAudio.nonAudioHash, a.nonAudioHash);
  await f.write('B/song.ogg', audio); await f.write('B/preview.ogg', Buffer.from('new preview'));
  const changedPreview = await f.inspect('B/notes.chart');
  assert.notEqual(changedPreview.audio.digest, a.audio.digest); assert.notEqual(changedPreview.bundleHash, a.bundleHash); assert.equal(changedPreview.nonAudioHash, a.nonAudioHash);
  await f.write('B/preview.ogg', Buffer.from('preview')); await f.write('B/album.png', Buffer.from('other art'));
  const changedExtra = await f.inspect('B/notes.chart');
  assert.equal(changedExtra.audio.digest, a.audio.digest); assert.notEqual(changedExtra.bundleHash, a.bundleHash); assert.notEqual(changedExtra.nonAudioHash, a.nonAudioHash);
  await f.write('B/album.png', Buffer.from('art')); await fs.rename(path.join(f.root, 'B', 'album.png'), path.join(f.root, 'B', 'cover.png'));
  assert.notEqual((await f.inspect('B/notes.chart')).bundleHash, a.bundleHash);
});

test('scan snapshots cover every asset without opening content and reject changed identity even with restored size and mtime', async t => {
  const f = await fixture(t); await f.song('A', { 'album.png': Buffer.from('cover'), 'readme.txt': Buffer.from('extra') });
  let opens = 0;
  const api = await injected({ 'node:fs/promises': { ...fs, open: async () => { opens++; throw Error('Scan must not read audio'); } } });
  const options = { rootPath: f.root, relativePath: 'A/notes.chart', format: 'chart' };
  const snapshot = await api.captureBundleSnapshot(options);
  assert.match(snapshot, /^[a-f0-9]{64}$/); assert.equal(opens, 0);
  assert.equal(snapshot, bundleSnapshot((await f.inspect('A/notes.chart')).identity));
  await f.song('sibling'); assert.equal(await captureBundleSnapshot(options), snapshot);
  const filename = path.join(f.root, 'A', 'song.ogg'), before = await fs.stat(filename);
  await fs.writeFile(filename, Buffer.alloc(audio.length, 42)); await fs.utimes(filename, before.atime, before.mtime);
  assert.notEqual(await captureBundleSnapshot(options), snapshot);
  const changed = await captureBundleSnapshot(options);
  await f.write('A/another-extra.txt', Buffer.from('new')); assert.notEqual(await captureBundleSnapshot(options), changed);
  await fs.mkdir(path.join(f.root, 'A', 'nested')); assert.equal(await captureBundleSnapshot(options), null);
});

test('scan snapshots fail closed for unsafe paths, junctions, hardlinks, root charts and unsupported formats', async t => {
  const f = await fixture(t); await f.song('A');
  for (const relativePath of ['../A/notes.chart', 'A/../A/notes.chart', 'A\\notes.chart', 'NUL/notes.chart', 'notes.chart']) {
    assert.equal(await captureBundleSnapshot({ rootPath: f.root, relativePath, format: 'chart' }), null);
  }
  await fs.symlink(path.join(f.root, 'A'), path.join(f.root, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await captureBundleSnapshot({ rootPath: f.root, relativePath: 'junction/notes.chart', format: 'chart' }), null);
  await fs.link(path.join(f.root, 'A', 'song.ogg'), path.join(f.root, 'other.ogg'));
  assert.equal(await captureBundleSnapshot({ rootPath: f.root, relativePath: 'A/notes.chart', format: 'chart' }), null);
  const signal = AbortSignal.abort();
  await assert.rejects(captureBundleSnapshot({ rootPath: f.root, relativePath: 'A/notes.chart', format: 'chart', signal }), { name: 'AbortError' });
});

test('audio normalization covers all stems but an audio filename or extra file difference protects a bundle', async t => {
  const f = await fixture(t); await f.song('A', { 'guitar.opus': Buffer.from('guitar') });
  await f.write('B/notes.chart', chart); await f.write('B/SONG.OGG', audio); await f.write('B/GUITAR.OPUS', Buffer.from('guitar'));
  const a = await f.inspect('A/notes.chart'), b = await f.inspect('B/notes.chart');
  assert.equal(a.audio.digest, b.audio.digest); assert.equal(a.audio.count, 2);
  assert.notEqual(a.bundleHash, b.bundleHash, 'complete folder manifest preserves exact filename differences');
  await fs.rename(path.join(f.root, 'B', 'GUITAR.OPUS'), path.join(f.root, 'B', 'bass.opus'));
  assert.notEqual((await f.inspect('B/notes.chart')).audio.digest, a.audio.digest);
  await f.write('A/readme.txt', Buffer.from('Unique extra'));
  assert.notEqual((await f.inspect('A/notes.chart')).bundleHash, a.bundleHash);
});

test('missing, preview-only and empty song audio are ineligible; alternate notes remain in the bundle', async t => {
  const f = await fixture(t); await f.write('A/notes.chart', chart);
  for (const additions of [{}, { 'preview.ogg': audio }, { 'song.ogg': Buffer.alloc(0) }]) {
    for (const [name, bytes] of Object.entries(additions)) await f.write('A/' + name, bytes);
    const value = await f.inspect('A/notes.chart');
    assert.equal(value.status, 'verified'); assert.equal(value.audio.status, 'missing'); assert.equal(value.audio.count, 0);
    assert.equal(await f.revalidate('A/notes.chart', value), null);
  }
  await f.song('B', { 'notes.mid': Buffer.from('secondary notes') });
  const b = await f.inspect('B/notes.chart'); assert.equal(b.status, 'verified'); assert.equal(b.entryCount, 3);
  await f.write('B/notes.mid', Buffer.from('other secondary notes'));
  assert.notEqual((await f.inspect('B/notes.chart')).bundleHash, b.bundleHash);
});

test('root folders, nested data, other charts and unsafe paths never produce a recycle target', async t => {
  const f = await fixture(t); await f.write('notes.chart', chart); await f.write('song.ogg', audio); await f.song('A');
  const root = await f.inspect('notes.chart'); unavailable(root); assert.equal(root.reason, 'root-folder'); assert.equal(root.targetRelativePath, null);
  for (const name of ['another.chart', 'another.mid', 'another.midi', 'other.sng']) {
    const file = await f.write('A/' + name, chart); const value = await f.inspect('A/notes.chart');
    unavailable(value); assert.equal(value.reason, 'multiple-charts'); await fs.unlink(file);
  }
  await fs.mkdir(path.join(f.root, 'A', 'nested')); unavailable(await f.inspect('A/notes.chart'));
  for (const relativePath of ['../notes.chart', '/notes.chart', 'C:/notes.chart', 'A/../notes.chart', 'A\\notes.chart', 'A//notes.chart', 'A./notes.chart', 'NUL/notes.chart']) {
    const value = await f.inspect(relativePath); unavailable(value); assert.ok(!JSON.stringify(value).includes(f.root));
  }
  unavailable(await f.inspect('missing/notes.chart'));
  unavailable(await f.inspect('A/song.ogg'), 'unsupported');
  unavailable(await f.inspect('A/custom.chart'), 'unsupported');
});

test('junctions, symlinks and hardlinks are refused for the target and every asset', async t => {
  const f = await fixture(t); await f.song('A');
  try { await fs.symlink(path.join(f.root, 'A'), path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('Host cannot create directory links'); return; } throw error; }
  unavailable(await f.inspect('linked/notes.chart'));
  unavailable(await inspectChartBundle({ rootPath: path.join(f.root, 'linked'), relativePath: 'notes.chart', format: 'chart' }));
  await fs.symlink(path.join(f.root, 'A'), path.join(f.root, 'A', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  unavailable(await f.inspect('A/notes.chart')); await fs.unlink(path.join(f.root, 'A', 'linked'));
  await fs.link(path.join(f.root, 'A', 'song.ogg'), path.join(f.root, 'copy.ogg'));
  unavailable(await f.inspect('A/notes.chart')); await fs.unlink(path.join(f.root, 'copy.ogg'));
  const archive = sng([{ name: 'notes.chart', bytes: chart }, { name: 'song.ogg', bytes: audio }]);
  await f.write('a.sng', archive.bytes); await fs.link(path.join(f.root, 'a.sng'), path.join(f.root, 'b.sng'));
  unavailable(await f.inspect('a.sng', 'sng'));
});

test('SNG verification hashes decoded notes/audio while conservatively preserving all container bytes', async t => {
  const f = await fixture(t), members = [{ name: 'notes.chart', bytes: chart }, { name: 'song.ogg', bytes: audio }, { name: 'preview.ogg', bytes: Buffer.from('preview') }];
  await f.song('plain', { 'preview.ogg': Buffer.from('preview') });
  for (const name of ['A.sng', 'B.sng']) await f.write(name, sng(members).bytes);
  await f.write('remasked.sng', sng(members, { seed: 7 }).bytes);
  const a = await f.inspect('A.sng', 'sng'), b = await f.inspect('B.sng', 'sng'), plain = await f.inspect('plain/notes.chart');
  assert.equal(a.status, 'verified'); assert.equal(a.kind, 'sng'); assert.equal(a.targetRelativePath, 'A.sng'); assert.equal(a.nonAudioHash, null);
  assert.deepEqual(a.notes, plain.notes); assert.deepEqual(a.audio, plain.audio); assert.equal(a.bundleHash, b.bundleHash);
  assert.equal(a.bundleHash, digest(sng(members).bytes)); assert.equal(a.totalBytes, sng(members).bytes.length); assert.equal(a.entryCount, members.length);
  const remasked = await f.inspect('remasked.sng', 'sng');
  assert.equal(remasked.audio.digest, a.audio.digest); assert.notEqual(remasked.bundleHash, a.bundleHash);
  await f.write('B.sng', sng([...members, { name: 'album.png', bytes: Buffer.from('art') }]).bytes);
  const extra = await f.inspect('B.sng', 'sng'); assert.equal(extra.audio.digest, a.audio.digest); assert.notEqual(extra.bundleHash, a.bundleHash);
  await f.write('B.sng', sng(members.map(member => member.name === 'song.ogg' ? { ...member, bytes: Buffer.from('changed') } : member)).bytes);
  assert.notEqual((await f.inspect('B.sng', 'sng')).audio.digest, a.audio.digest);
  assert.equal(await f.revalidate('A.sng', a, 'sng'), path.join(f.root, 'A.sng'));
});

test('SNG parsing rejects unsupported, malformed and missing-note containers without hashes', async t => {
  const f = await fixture(t), archive = sng([{ name: 'notes.chart', bytes: chart }, { name: 'song.ogg', bytes: audio }]);
  const malformed = [archive.bytes.subarray(0, 20), archive.bytes.subarray(0, archive.bytes.length - 1), Buffer.concat([archive.bytes, Buffer.from([0])])];
  const overlap = Buffer.from(archive.bytes), secondPosition = archive.indexStart + 8 + 17 + Buffer.byteLength('notes.chart') + 1 + Buffer.byteLength('song.ogg') + 8;
  overlap.writeBigUInt64LE(BigInt(archive.ranges[0].start), secondPosition); malformed.push(overlap);
  const badCount = Buffer.from(archive.bytes); badCount.writeBigUInt64LE(4097n, archive.indexStart); malformed.push(badCount);
  for (const name of ['../notes.chart', 'NUL.ogg', 'bad\\name.ogg']) malformed.push(sng([{ name: 'notes.chart', bytes: chart }, { name, bytes: audio }]).bytes);
  malformed.push(sng([{ name: 'notes.chart', bytes: chart }, { name: 'NOTES.CHART', bytes: chart }]).bytes);
  for (const bytes of malformed) { await f.write('invalid.sng', bytes); unavailable(await f.inspect('invalid.sng', 'sng')); }
  const version = Buffer.from(archive.bytes); version.writeUInt32LE(2, 6); await f.write('new.sng', version);
  unavailable(await f.inspect('new.sng', 'sng'), 'unsupported');
  await f.write('missing.sng', sng([{ name: 'song.ogg', bytes: audio }]).bytes);
  unavailable(await f.inspect('missing.sng', 'sng'), 'unsupported');
  await f.write('silent.sng', sng([{ name: 'notes.mid', bytes: chart }, { name: 'preview.ogg', bytes: audio }]).bytes);
  const silent = await f.inspect('silent.sng', 'sng'); assert.equal(silent.notes.format, 'midi'); assert.equal(silent.audio.status, 'missing');
});

test('large notes, audio and extras stream through bounded reads, including decoded SNG members', async t => {
  const f = await fixture(t), large = Buffer.alloc(1024 * 1024 + 519);
  for (let index = 0; index < large.length; index++) large[index] = (index * 19 + Math.floor(index / 23)) & 255;
  await f.song('A', { 'song.ogg': large, 'video.mp4': large });
  const archive = sng([{ name: 'song.ogg', bytes: large }, { name: 'notes.chart', bytes: chart }]); await f.write('A.sng', archive.bytes);
  let reads = 0, largest = 0, audioRead = 0;
  const injectedApi = await injected({ 'node:fs/promises': { ...fs, open: async (...args) => {
    const handle = await fs.open(...args); return wrappedHandle(handle, { read: (buffer, offset, length, position) => {
      largest = Math.max(largest, length); reads++;
      if (String(args[0]).endsWith('A.sng') && position >= archive.ranges[0].start && position < archive.ranges[0].end) audioRead++;
      return handle.read(buffer, offset, Math.min(5003, length), position);
    } });
  } } });
  const standalone = await injectedApi.inspectChartBundle({ rootPath: f.root, relativePath: 'A/notes.chart', format: 'chart' });
  const packed = await injectedApi.inspectChartBundle({ rootPath: f.root, relativePath: 'A.sng', format: 'sng' });
  assert.equal(standalone.status, 'verified'); assert.equal(packed.status, 'verified'); assert.equal(packed.audio.digest, standalone.audio.digest);
  assert.equal(packed.bundleHash, digest(archive.bytes)); assert.ok(largest <= 64 * 1024); assert.ok(reads > 600); assert.ok(audioRead > 400);
});

test('revalidation requires unchanged bytes and identities, while sibling operations do not invalidate a keeper', async t => {
  const f = await fixture(t); await f.song('A'); const a = await f.inspect('A/notes.chart');
  assert.equal(await f.revalidate('A/notes.chart', a), path.join(f.root, 'A'));
  await f.song('B'); assert.equal(await f.revalidate('A/notes.chart', a), path.join(f.root, 'A'));
  await f.write('A/song.ogg', Buffer.from('new audio')); assert.equal(await f.revalidate('A/notes.chart', a), null);
  await f.write('A/song.ogg', audio); assert.equal(await f.revalidate('A/notes.chart', a), null, 'restoring bytes cannot restore reviewed identity');
  const current = await f.inspect('A/notes.chart');
  await fs.rename(path.join(f.root, 'A'), path.join(f.root, 'old-A')); await f.song('A');
  assert.equal((await f.inspect('A/notes.chart')).bundleHash, current.bundleHash);
  assert.equal(await f.revalidate('A/notes.chart', current), null, 'identical replacement folder still requires a new review');
  assert.equal(await f.revalidate('B/notes.chart', current), null, 'expected bundle cannot be used for another target');
});

test('replacement before open, changes after an earlier read and added files invalidate the full bundle', async t => {
  const f = await fixture(t);
  for (const mutation of ['replace', 'earlier-file', 'add-file', 'truncate']) {
    await f.song(mutation); let changed = false, reads = 0;
    const directory = path.join(f.root, mutation), notePath = path.join(directory, 'notes.chart');
    const api = await injected({ 'node:fs/promises': { ...fs, open: async (...args) => {
      if (mutation === 'replace' && !changed) {
        changed = true; await fs.rename(notePath, path.join(f.root, 'old-notes.chart')); await fs.writeFile(notePath, chart);
      }
      const handle = await fs.open(...args);
      return wrappedHandle(handle, { read: async (...readArgs) => {
        reads++; const result = await handle.read(...readArgs);
        if (!changed && (mutation !== 'earlier-file' || String(args[0]).endsWith('song.ogg'))) {
          changed = true;
          if (mutation === 'earlier-file') await fs.writeFile(notePath, Buffer.from('changed notes'));
          if (mutation === 'add-file') await fs.writeFile(path.join(directory, 'new-extra.txt'), Buffer.from('extra'));
          if (mutation === 'truncate') await fs.truncate(notePath, 1);
        }
        return result;
      } });
    } } });
    unavailable(await api.inspectChartBundle({ rootPath: f.root, relativePath: mutation + '/notes.chart', format: 'chart' }));
    if (mutation === 'replace') assert.equal(reads, 0);
  }
});

test('cancellation before and during verification throws AbortError and closes open handles', async t => {
  const f = await fixture(t); await f.song('A');
  const before = new AbortController(); before.abort();
  await assert.rejects(f.inspect('A/notes.chart', 'chart', { signal: before.signal }), { name: 'AbortError', code: 'ABORT_ERR' });
  const during = new AbortController(); let closed = 0;
  const api = await injected({ 'node:fs/promises': { ...fs, open: async (...args) => {
    const handle = await fs.open(...args); return wrappedHandle(handle, {
      read: async (...readArgs) => { const result = await handle.read(...readArgs); during.abort(); return result; },
      close: async () => { closed++; await handle.close(); }
    });
  } } });
  await assert.rejects(api.inspectChartBundle({ rootPath: f.root, relativePath: 'A/notes.chart', format: 'chart', signal: during.signal }), { name: 'AbortError' });
  assert.equal(closed, 1);
});

test('final identity gate performs no content reads and detects changed assets, names, containers and links', async t => {
  const f = await fixture(t); await f.song('A');
  const archive = sng([{ name: 'notes.chart', bytes: chart }, { name: 'song.ogg', bytes: audio }]); await f.write('A.sng', archive.bytes);
  const expected = await f.inspect('A/notes.chart'), packed = await f.inspect('A.sng', 'sng');
  let opens = 0;
  const api = await injected({ 'node:fs/promises': { ...fs, open: async () => { opens++; throw Error('Identity gate must not read content'); } } });
  const options = { rootPath: f.root, relativePath: 'A/notes.chart', format: 'chart', expected };
  assert.equal(await api.recheckBundleIdentity(options), path.join(f.root, 'A'));
  await f.song('unrelated'); assert.equal(await api.recheckBundleIdentity(options), path.join(f.root, 'A'));
  assert.equal(await api.recheckBundleIdentity({ rootPath: f.root, relativePath: 'A.sng', format: 'sng', expected: packed }), path.join(f.root, 'A.sng'));
  await f.write('A/song.ogg', Buffer.from('new audio')); assert.equal(await api.recheckBundleIdentity(options), null);
  const current = await f.inspect('A/notes.chart'); await f.write('A/unique.txt', Buffer.from('extra'));
  assert.equal(await api.recheckBundleIdentity({ ...options, expected: current }), null);
  await f.write('A.sng', Buffer.concat([archive.bytes, Buffer.from([0])]));
  assert.equal(await api.recheckBundleIdentity({ rootPath: f.root, relativePath: 'A.sng', format: 'sng', expected: packed }), null);
  assert.equal(opens, 0);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(recheckBundleIdentity({ ...options, signal: cancelled.signal }), { name: 'AbortError' });
});

test('final identity gate rejects identical directory replacements and added hardlinks', async t => {
  const f = await fixture(t); await f.song('A'); const expected = await f.inspect('A/notes.chart');
  const options = { rootPath: f.root, relativePath: 'A/notes.chart', format: 'chart', expected };
  await fs.rename(path.join(f.root, 'A'), path.join(f.root, 'old-A')); await f.song('A');
  assert.equal(await recheckBundleIdentity(options), null);
  const replacement = await f.inspect('A/notes.chart');
  await fs.link(path.join(f.root, 'A', 'song.ogg'), path.join(f.root, 'outside.ogg'));
  assert.equal(await recheckBundleIdentity({ ...options, expected: replacement }), null);
});
