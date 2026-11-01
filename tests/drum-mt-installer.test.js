'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { crc32, deflateRawSync } = require('node:zlib'), { createHash } = require('node:crypto');
const { createMtInstaller, inspectMtArchive, MT_URL, MT_VERSION, MAX_ZIP_BYTES } = require('../companion/drum-mt-installer.cjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function image(x64 = true) { const bytes = Buffer.alloc(512); bytes.write('MZ'); bytes.writeUInt32LE(128, 60); bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(x64 ? 0x8664 : 0x14c, 132); bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(0x2022, 150); bytes.writeUInt16LE(0x20b, 152); return bytes; }
const members = () => [{ name: 'MT-PowerDrumKit.vst3', bytes: image() }, { name: 'MT-PowerDrumKit-Content.pdk', bytes: Buffer.from('synthetic-content-only') }, { name: 'License.txt', bytes: Buffer.from('Unmodified synthetic publisher licence') }];
function zip(entries = members(), { method = 8, descriptor = false, compressedTail = false, compressionFlags = 0 } = {}) {
  const records = [], central = [], positions = []; let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.from(entry.name), data = entry.bytes, compressed = method === 8 ? Buffer.concat([deflateRawSync(data), ...(compressedTail ? [Buffer.from([0])] : [])]) : data, flags = (descriptor ? 8 : 0) | compressionFlags;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); local.writeUInt16LE(raw.length, 26);
    if (!descriptor) { local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); }
    const row = Buffer.alloc(46); row.writeUInt32LE(0x02014b50); row.writeUInt16LE(20, 4); row.writeUInt16LE(20, 6); row.writeUInt16LE(flags, 8); row.writeUInt16LE(method, 10); row.writeUInt32LE(crc32(data), 16); row.writeUInt32LE(compressed.length, 20); row.writeUInt32LE(data.length, 24); row.writeUInt16LE(raw.length, 28); row.writeUInt32LE(offset, 42);
    const tail = descriptor ? Buffer.alloc(16) : Buffer.alloc(0); if (descriptor) { tail.writeUInt32LE(0x08074b50); tail.writeUInt32LE(crc32(data), 4); tail.writeUInt32LE(compressed.length, 8); tail.writeUInt32LE(data.length, 12); }
    positions.push({ local: offset, data: offset + 30 + raw.length, centralRelative: central.reduce((n, item) => n + item.length, 0) });
    records.push(local, raw, compressed, tail); central.push(row, raw); offset += 30 + raw.length + compressed.length + tail.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return { bytes: Buffer.concat([...records, directory, end]), positions: positions.map(item => ({ ...item, central: offset + item.centralRelative })), end: offset + directory.length };
}
function response(bytes, patch = {}) { const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); } }); return { status: 200, redirected: false, url: MT_URL, headers: new Headers({ 'content-length': String(bytes.length) }), body, ...patch }; }
async function fixture(t, fetcher, onChange) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-mt-test-')); t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert(path.basename(directory).startsWith('chartshub-mt-test-')); await fs.rm(directory, { recursive: true, force: true }); }); return { directory, installer: createMtInstaller({ dataDirectory: path.join(directory, 'synthetic-data'), fetcher, onChange }) }; }
const invalid = error => error?.code === 'DRUM_MT_ARCHIVE';

test('MT download and filesystem access require exact explicit consent; status and dispose do not fetch', async t => {
  let calls = 0; const { directory, installer } = await fixture(t, () => { calls++; throw Error('Network must not run'); });
  for (const consent of [undefined, null, {}, { consent: false }, { consent: 1 }, { consent: true, url: MT_URL }, []]) await assert.rejects(installer.install(consent), error => error.code === 'DRUM_MT_CONSENT');
  assert.equal(installer.status().state, 'idle'); assert.equal(calls, 0); assert.deepEqual(await fs.readdir(directory), []);
  await installer.dispose(); assert.equal(calls, 0); await assert.rejects(installer.install({ consent: true }), error => error.code === 'DRUM_MT_UNAVAILABLE');
});

test('consented fake official ZIP installs transactionally into new private folders, preserving every supplied byte', async t => {
  const archive = zip(), calls = [], changes = [];
  const { directory, installer } = await fixture(t, async (url, options) => { calls.push({ url, options }); return response(archive.bytes); }, state => changes.push(state));
  const first = await installer.install({ consent: true }), second = await installer.install({ consent: true });
  assert.equal(calls.length, 2); assert.equal(calls[0].url, MT_URL); assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.method, 'GET');
  assert.equal(first.version, MT_VERSION); assert.notEqual(first.pluginPath, second.pluginPath); assert(first.pluginPath.startsWith(path.join(directory, 'synthetic-data', 'instruments') + path.sep));
  for (const entry of members()) assert.deepEqual(await fs.readFile(path.join(path.dirname(first.pluginPath), entry.name)), entry.bytes);
  assert.equal(first.receipt.archiveSha256, sha(archive.bytes)); assert.equal(first.receipt.archiveHashKind, 'computed-download'); assert.equal(first.receipt.officialPublishedSha256, null); assert.equal(first.receipt.consent, true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(path.dirname(first.pluginPath), 'chartshub-mt-receipt.json'))), first.receipt);
  assert(changes.some(state => state.state === 'extracting')); assert.equal(installer.status().state, 'installed');
  assert((await fs.readdir(path.dirname(path.dirname(first.pluginPath)))).every(name => !name.startsWith('.stage-')));
});

test('ZIP stored and deflated members including descriptors and nested folders are checked without rewriting licence data', async () => {
  for (const method of [0, 8]) for (const descriptor of [false, true]) {
    const files = members().map(entry => ({ ...entry, name: 'MT/' + entry.name })); const decoded = await inspectMtArchive(zip(files, { method, descriptor }).bytes);
    assert.equal(decoded.pluginRelativePath, 'MT/MT-PowerDrumKit.vst3'); for (const item of decoded.files) assert.deepEqual(item.bytes, files.find(entry => entry.name === item.path).bytes);
  }
});

test('Deflate compression-option flags are accepted only when matching local and central method-8 headers', async () => {
  for (const compressionFlags of [2, 4, 6]) {
    const archive = zip(members(), { method: 8, compressionFlags });
    assert.equal(archive.bytes.readUInt16LE(archive.positions[0].local + 6), compressionFlags);
    assert.equal(archive.bytes.readUInt16LE(archive.positions[0].central + 8), compressionFlags);
    const decoded = await inspectMtArchive(archive.bytes); assert.equal(decoded.files.length, members().length);
    assert.deepEqual(decoded.files.find(file => file.path === 'MT-PowerDrumKit.vst3').bytes, image());
    await assert.rejects(inspectMtArchive(zip(members(), { method: 0, compressionFlags }).bytes), invalid);
    const mismatch = zip(members(), { method: 8, compressionFlags }); mismatch.bytes.writeUInt16LE(0, mismatch.positions[0].local + 6);
    await assert.rejects(inspectMtArchive(mismatch.bytes), invalid);
  }
});

test('ZIP traversal, alternate paths, reserved names, case duplicates and symlinks are rejected', async () => {
  for (const name of ['../escape.txt', '/absolute.txt', 'C:/absolute.txt', 'folder\\escape.txt', 'a/./file', 'a//file', 'CON.txt', 'file. ', 'folder/file:stream', 'mt-powerdrumkit.VST3']) {
    await assert.rejects(inspectMtArchive(zip([...members(), { name, bytes: Buffer.from('x') }]).bytes), invalid);
  }
  const symbolic = zip(); symbolic.bytes.writeUInt32LE((0xa000 << 16) >>> 0, symbolic.positions[0].central + 38); await assert.rejects(inspectMtArchive(symbolic.bytes), invalid);
  await assert.rejects(inspectMtArchive(zip([...members(), { name: 'file', bytes: Buffer.from('x') }, { name: 'file/child', bytes: Buffer.from('x') }]).bytes), invalid);
});

test('ZIP headers, CRC, compression stream and x64 plugin identity fail closed', async () => {
  const crc = zip(members(), { method: 0 }); crc.bytes[crc.positions[1].data] ^= 1; await assert.rejects(inspectMtArchive(crc.bytes), invalid);
  const mismatch = zip(); mismatch.bytes[mismatch.positions[0].local + 30] ^= 1; await assert.rejects(inspectMtArchive(mismatch.bytes), invalid);
  const overlap = zip(); overlap.bytes.writeUInt32LE(0, overlap.positions[1].central + 42); await assert.rejects(inspectMtArchive(overlap.bytes), invalid);
  const encrypted = zip(); encrypted.bytes.writeUInt16LE(1, encrypted.positions[0].central + 8); await assert.rejects(inspectMtArchive(encrypted.bytes), invalid);
  const large = zip(); large.bytes.writeUInt32LE(0xffffffff, large.positions[0].central + 24); await assert.rejects(inspectMtArchive(large.bytes), invalid);
  await assert.rejects(inspectMtArchive(zip(members(), { compressedTail: true }).bytes), invalid);
  const bad = members(); bad[0].bytes = image(false); await assert.rejects(inspectMtArchive(zip(bad).bytes), invalid);
  const absent = members(); absent[1].name = 'another-folder/MT-PowerDrumKit-Content.pdk'; await assert.rejects(inspectMtArchive(zip(absent).bytes), invalid);
  const empty = members(); empty[1].bytes = Buffer.alloc(0); await assert.rejects(inspectMtArchive(zip(empty).bytes), invalid);
  const tooMany = [...members(), ...Array.from({ length: 98 }, (_, i) => ({ name: 'x' + i, bytes: Buffer.alloc(0) }))]; await assert.rejects(inspectMtArchive(zip(tooMany).bytes), invalid);
});

test('redirects, changed download URLs, bad HTTP status and dishonest sizes never install', async t => {
  const archive = zip();
  for (const patch of [{ redirected: true }, { url: 'https://other.invalid/kit.zip' }, { status: 302 }, { status: 404 },
    { headers: new Headers({ 'content-length': String(MAX_ZIP_BYTES + 1) }) }, { headers: new Headers({ 'content-length': String(archive.bytes.length + 1) }) }]) {
    const { directory, installer } = await fixture(t, async () => response(archive.bytes, patch));
    await assert.rejects(installer.install({ consent: true }), error => error.code === 'DRUM_MT_DOWNLOAD');
    assert.equal(installer.status().state, 'error'); assert.deepEqual(await fs.readdir(directory), []);
  }
});

test('cancel aborts a stalled fake response, rejects concurrent installs and makes no directories', async t => {
  let calls = 0; const { directory, installer } = await fixture(t, async () => { calls++; return new Promise(() => {}); });
  const pending = installer.install({ consent: true });
  await assert.rejects(installer.install({ consent: true }), error => error.code === 'DRUM_MT_BUSY'); installer.cancel();
  await assert.rejects(pending, error => error.code === 'DRUM_MT_CANCELLED'); assert.equal(calls, 1); assert.equal(installer.status().state, 'idle'); assert.deepEqual(await fs.readdir(directory), []);
});

test('invalid content or a symlinked application instrument folder leaves existing files untouched', async t => {
  const bad = zip(); bad.bytes[bad.positions[0].data] ^= 1;
  const { directory, installer } = await fixture(t, async () => response(bad.bytes)); await assert.rejects(installer.install({ consent: true }));
  assert.deepEqual(await fs.readdir(directory), []);
  const safe = zip(), data = path.join(directory, 'synthetic-data'), outside = path.join(directory, 'outside'); await fs.mkdir(data); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  await fs.symlink(outside, path.join(data, 'instruments'), process.platform === 'win32' ? 'junction' : 'dir');
  const guarded = createMtInstaller({ dataDirectory: data, fetcher: async () => response(safe.bytes) });
  await assert.rejects(guarded.install({ consent: true }), error => error.code === 'DRUM_MT_STORAGE'); assert.deepEqual(await fs.readdir(outside), ['keep.txt']); assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('a linked data directory or ancestor is rejected before writing into its destination', async t => {
  const archive = zip(), { directory } = await fixture(t, async () => response(archive.bytes));
  const outside = path.join(directory, 'outside'), linked = path.join(directory, 'linked'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  for (const dataDirectory of [linked, path.join(linked, 'new-profile')]) {
    const installer = createMtInstaller({ dataDirectory, fetcher: async () => response(archive.bytes) });
    await assert.rejects(installer.install({ consent: true }), error => error.code === 'DRUM_MT_STORAGE');
    assert.deepEqual(await fs.readdir(outside), ['keep.txt']);
  }
});

test('dispose awaits cancellation of a stalled download without filesystem side effects', async t => {
  const { directory, installer } = await fixture(t, async () => new Promise(() => {}));
  const task = installer.install({ consent: true }); const rejected = assert.rejects(task, error => error.code === 'DRUM_MT_CANCELLED');
  await installer.dispose(); await rejected; assert.deepEqual(await fs.readdir(directory), []);
});

test('an extraction write failure removes only its fresh stage and preserves earlier installations', async t => {
  const archive = zip(), { installer } = await fixture(t, async () => response(archive.bytes));
  const first = await installer.install({ consent: true }), base = path.dirname(path.dirname(first.pluginPath)), prior = await fs.readdir(base);
  const write = fs.writeFile.bind(fs);
  t.mock.method(fs, 'writeFile', async (file, ...args) => {
    if (typeof file === 'string' && file.includes(path.sep + '.stage-') && path.basename(file) === 'License.txt') throw Object.assign(Error('synthetic write failure'), { code: 'EACCES' });
    return write(file, ...args);
  });
  await assert.rejects(installer.install({ consent: true }), error => error.code === 'DRUM_MT_STORAGE');
  assert.deepEqual(await fs.readdir(base), prior); assert.deepEqual(await fs.readFile(first.pluginPath), image());
});
