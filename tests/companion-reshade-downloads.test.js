const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { crc32, deflateRawSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { downloadRuntime, downloadStarterEffects, extractRuntime, RUNTIME_VERSION } = require('../companion/reshade-downloads.cjs');
const { createReShadeSetupService } = require('../companion/reshade-setup.cjs');
const starterSources = require('./fixtures/reshade-starter/sources.json');
const safeError = error => error?.code === 'RESHADE_DOWNLOAD_SAFE';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function pe({ x64 = true, dll = true, addon = true } = {}) {
  const bytes = Buffer.alloc(512), header = 128, optional = header + 24;
  bytes.write('MZ'); bytes.writeUInt32LE(header, 0x3c); bytes.write('PE\0\0', header);
  bytes.writeUInt16LE(x64 ? 0x8664 : 0x14c, header + 4);
  bytes.writeUInt16LE(x64 ? 240 : 224, header + 20); bytes.writeUInt16LE(dll ? 0x2022 : 0x102, header + 22);
  bytes.writeUInt16LE(x64 ? 0x20b : 0x10b, optional);
  bytes.writeUInt32LE(16, optional + (x64 ? 108 : 92));
  if (addon) bytes.write('ReShadeRegisterAddon', 420);
  return bytes;
}

function archive({ payload = pe(), method = 8, names = ['ReShade32.dll', 'ReShade64.dll'], certificate = false, compressedTail = Buffer.alloc(0) } = {}) {
  const prefix = pe({ x64: false, dll: false }), locals = [], entries = [], central = [];
  let localOffset = 0;
  for (const name of names) {
    const nameBytes = Buffer.from(name), bytes = name.includes('32') ? pe({ x64: false }) : payload;
    const compressed = method === 8 ? Buffer.concat([deflateRawSync(bytes), compressedTail]) : bytes;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(crc32(bytes), 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(method, 10); record.writeUInt32LE(crc32(bytes), 16); record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(nameBytes.length, 28); record.writeUInt32LE(localOffset, 42);
    entries.push({ name, local: prefix.length + localOffset, centralOffset: central.reduce((sum, item) => sum + item.length, 0), data: prefix.length + localOffset + 30 + nameBytes.length });
    locals.push(local, nameBytes, compressed); central.push(record, nameBytes); localOffset += local.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(localOffset, 16);
  const eocd = prefix.length + localOffset + directory.length;
  for (const entry of entries) entry.central = prefix.length + localOffset + entry.centralOffset;
  let bytes = Buffer.concat([prefix, ...locals, directory, end]);
  if (certificate) {
    const padding = Buffer.alloc((8 - bytes.length % 8) % 8), cert = Buffer.alloc(8);
    cert.writeUInt32LE(8); cert.writeUInt16LE(0x200, 4); cert.writeUInt16LE(2, 6);
    const securityDirectory = 128 + 24 + 96 + 32;
    bytes.writeUInt32LE(bytes.length + padding.length, securityDirectory); bytes.writeUInt32LE(cert.length, securityDirectory + 4);
    bytes = Buffer.concat([bytes, padding, cert]);
  }
  return { bytes, payload, eocd, entries, target: entries.find(item => item.name === 'ReShade64.dll') };
}

function fakeNetwork(t, routes) {
  const calls = [];
  t.mock.method(https, 'request', (url, options, callback) => {
    const request = new EventEmitter(); request.destroyed = false;
    request.destroy = () => { request.destroyed = true; };
    request.setTimeout = (milliseconds, callback) => { request.idleMs = milliseconds; request.expire = callback; return request; };
    const call = { url: String(url), options, request }; calls.push(call);
    request.end = () => queueMicrotask(() => {
      if (request.destroyed) return;
      const route = routes.shift();
      if (!route) { request.emit('error', Error('No mocked route')); return; }
      if (route.error) { request.emit('error', route.error); return; }
      const response = new PassThrough(); response.statusCode = route.status ?? 200; response.headers = route.headers || {}; call.response = response;
      callback(response); if (response.destroyed || route.stall) return;
      for (const chunk of route.chunks || [route.body || Buffer.alloc(0)]) { if (response.destroyed) break; response.write(chunk); }
      if (!response.destroyed) response.end();
    });
    return request;
  });
  return calls;
}

test('runtime extraction supports bounded deflate/stored entries and an appended PE certificate', () => {
  assert.equal(RUNTIME_VERSION, '6.8.0');
  for (const method of [0, 8]) for (const certificate of [false, true]) {
    const fixture = archive({ method, certificate });
    assert.deepEqual(extractRuntime(fixture.bytes), fixture.payload);
  }
});

test('archive extraction rejects truncation, bad offsets, split archives and oversized output', () => {
  for (const transform of [
    b => b.subarray(0, b.length - 2),
    b => { b.writeUInt32LE(0xffffffff, 0x3c); return b; },
    (b, f) => { b.writeUInt16LE(1, f.eocd + 4); return b; },
    (b, f) => { b.writeUInt32LE(0xffffffff, f.eocd + 16); return b; },
    (b, f) => { b.writeUInt32LE(0xffffff00, f.target.central + 42); return b; },
    (b, f) => { b.writeUInt32LE(17 * 1024 * 1024, f.target.central + 24); return b; },
    (b, f) => { b.writeUInt16LE(999, f.eocd + 10); return b; }
  ]) {
    const fixture = archive(); assert.throws(() => extractRuntime(transform(Buffer.from(fixture.bytes), fixture)), safeError);
  }
  for (const value of [null, 'zip', Buffer.alloc(0), Buffer.alloc(16 * 1024 * 1024 + 1)]) assert.throws(() => extractRuntime(value), safeError);
});

test('only the exact unique runtime entry is accepted, with matching local and central names', () => {
  for (const names of [['ReShade32.dll', '../ReShade64.dll'], ['ReShade32.dll', 'ReShade64.dll.bak'], ['ReShade32.dll', 'reshade64.dll'], ['ReShade32.dll', 'ReShade64.dll', 'ReShade64.dll']]) assert.throws(() => extractRuntime(archive({ names }).bytes), safeError);
  const fixture = archive(); fixture.bytes[fixture.target.local + 30] = 'x'.charCodeAt(0);
  assert.throws(() => extractRuntime(fixture.bytes), safeError);
});

test('encrypted ZIP entries and unsupported compression cannot be extracted', () => {
  for (const [localOffset, centralOffset, value] of [[6, 8, 1], [6, 8, 8], [8, 10, 99]]) {
    const f = archive(); f.bytes.writeUInt16LE(value, f.target.local + localOffset); f.bytes.writeUInt16LE(value, f.target.central + centralOffset);
    assert.throws(() => extractRuntime(f.bytes), safeError);
  }
});

test('runtime CRC, inflated size and Windows architecture are checked independently', () => {
  const badCrc = archive(); badCrc.bytes.writeUInt32LE(123, badCrc.target.local + 14); badCrc.bytes.writeUInt32LE(123, badCrc.target.central + 16);
  assert.throws(() => extractRuntime(badCrc.bytes), /endommagé/);
  const bomb = archive(); bomb.bytes.writeUInt32LE(bomb.payload.length - 1, bomb.target.local + 22); bomb.bytes.writeUInt32LE(bomb.payload.length - 1, bomb.target.central + 24);
  assert.throws(() => extractRuntime(bomb.bytes), safeError);
  assert.throws(() => extractRuntime(archive({ compressedTail: Buffer.from('trailing data') }).bytes), safeError);
  for (const payload of [pe({ x64: false }), pe({ dll: false }), pe({ addon: false }), Buffer.alloc(512)]) assert.throws(() => extractRuntime(archive({ payload }).bytes), safeError);
});

test('certificate bounds and non-certificate trailing bytes are rejected', () => {
  const f = archive({ certificate: true }), directory = 128 + 24 + 96 + 32;
  f.bytes.writeUInt32LE(f.bytes.length + 8, directory + 4); assert.throws(() => extractRuntime(f.bytes), safeError);
  const valid = archive(); assert.throws(() => extractRuntime(Buffer.concat([valid.bytes, Buffer.from('unexpected suffix')])), safeError);
});

test('pre-cancelled downloads never create a network request', async t => {
  const calls = fakeNetwork(t, []), controller = new AbortController(); controller.abort();
  await assert.rejects(downloadRuntime({ signal: controller.signal }), { name: 'AbortError', code: 'RESHADE_DOWNLOAD_SAFE' });
  await assert.rejects(downloadStarterEffects({ signal: controller.signal }), { name: 'AbortError', code: 'RESHADE_DOWNLOAD_SAFE' });
  assert.equal(calls.length, 0);
});

test('redirects cannot escape HTTPS, approved hosts, standard ports or credentials-free URLs', async t => {
  const locations = ['http://reshade.me/runtime.exe', 'https://evil.example/runtime.exe', 'https://reshade.me.evil.example/runtime.exe', 'https://user:password@reshade.me/runtime.exe', 'https://reshade.me:444/runtime.exe', 'https://reshade.me/runtime.exe#fragment', 'file:///C:/runtime.exe'];
  const calls = fakeNetwork(t, locations.map(location => ({ status: 302, headers: { location } })));
  for (const location of locations) {
    const count = calls.length; await assert.rejects(downloadRuntime(), safeError);
    assert.equal(calls.length, count + 1, location);
  }
  assert.ok(calls.every(call => call.url === 'https://reshade.me/downloads/ReShade_Setup_6.8.0_Addon.exe'));
});

test('same-host redirect chains are bounded and shader downloads cannot redirect to the runtime host', async t => {
  const calls = fakeNetwork(t, [
    ...Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/again.exe' } })),
    { status: 302, headers: { location: 'https://reshade.me/shader.fx' } }
  ]);
  await assert.rejects(downloadRuntime(), /redirections/); assert.equal(calls.length, 4);
  await assert.rejects(downloadStarterEffects(), safeError); assert.equal(calls.length, 5);
  assert.match(calls[4].url, /^https:\/\/raw\.githubusercontent\.com\/CeeJayDK\/SweetFX\/[a-f0-9]{40}\/Shaders\/SweetFX\/Curves\.fx$/);
});

test('declared size, response encoding and non-success status fail before consuming payloads', async t => {
  const routes = [
    { headers: { 'content-length': '999999999' } }, { headers: { 'content-length': '-1' } },
    { headers: { 'content-length': '4318423' } }, { headers: { 'content-encoding': 'gzip' } }, { status: 404 }
  ];
  const calls = fakeNetwork(t, routes);
  for (let i = 0; i < 5; i++) await assert.rejects(downloadRuntime(), safeError);
  assert.ok(calls.every(call => call.response.destroyed));
});

test('stream limits and pinned hashes reject excess or substituted content even without Content-Length', async t => {
  const calls = fakeNetwork(t, [
    { body: Buffer.alloc(4318425) }, { body: Buffer.alloc(4318424) },
    { body: Buffer.from('a different shader') }, { body: Buffer.alloc(256 * 1024 + 1) }
  ]);
  await assert.rejects(downloadRuntime(), /taille autorisée/);
  await assert.rejects(downloadRuntime(), /version vérifiée/);
  await assert.rejects(downloadStarterEffects(), /version vérifiée/);
  await assert.rejects(downloadStarterEffects(), /taille autorisée/);
  assert.equal(calls.length, 4); assert.ok(calls.every(call => call.request.destroyed));
});

test('cancelling an active download destroys its connection and stops before other shader requests', async t => {
  const controller = new AbortController(), calls = fakeNetwork(t, [{ stall: true }]);
  const pending = downloadStarterEffects({ signal: controller.signal }); await Promise.resolve();
  assert.equal(calls.length, 1); controller.abort();
  await assert.rejects(pending, { name: 'AbortError', code: 'RESHADE_DOWNLOAD_SAFE' });
  assert.equal(calls[0].request.destroyed, true); assert.equal(calls[0].response.destroyed, true); assert.equal(calls.length, 1);
});

test('idle and absolute request deadlines terminate stalled responses', async t => {
  const calls = fakeNetwork(t, [{ stall: true }, { stall: true }]);
  const idle = downloadRuntime(); await Promise.resolve();
  assert.equal(calls[0].request.idleMs, 12000); calls[0].request.expire(); await assert.rejects(idle, /délai/);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const absolute = downloadRuntime(); await Promise.resolve(); t.mock.timers.tick(45001);
  await assert.rejects(absolute, /délai/); assert.equal(calls[1].request.destroyed, true);
});

test('the downloaded official setup extracts to the verified x64 runtime and reports byte progress', async t => {
  const filename = path.resolve(__dirname, '..', '..', 'ReShade_Setup_6.8.0_Addon.exe');
  let setup; try { setup = await fs.readFile(filename); } catch (error) { if (error.code === 'ENOENT') { t.skip('Optional official setup validation fixture is not in the repository'); return; } throw error; }
  assert.equal(sha256(setup), 'afe4c8f13048306307983b8b3d41d5bf00a86820440b0e57dea10950e1176445');
  const calls = fakeNetwork(t, [{ headers: { 'content-length': String(setup.length) }, chunks: [setup.subarray(0, 2000000), setup.subarray(2000000)] }]);
  const progress = [], dll = await downloadRuntime({ onProgress: value => progress.push(value) });
  assert.equal(sha256(dll), '0cee63f9c9f13f3ac909c5b4903f4dbb4b719a7ab3b4f13b0deaf83c814b94f7'); assert.equal(dll.length, 5592064);
  assert.deepEqual(progress.map(item => item.received), [0, 2000000, setup.length]); assert.ok(progress.every(item => item.total === setup.length));
  assert.equal(calls.length, 1); assert.equal(calls[0].request.destroyed, true);
});

test('verified starter sources preserve licenses and change only active includes to isolated header names', async t => {
  const upstream = starterSources.map(source => Buffer.from(source.content));
  for (const [index, source] of starterSources.entries()) {
    const bytes = upstream[index];
    assert.equal(bytes.length, source.size);
    assert.equal(createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex'), source.blobSha);
  }
  const calls = fakeNetwork(t, upstream.map(body => ({ body, headers: { 'content-length': String(body.length) } })));
  const files = await downloadStarterEffects();
  assert.equal(calls.length, 12); assert.equal(files.length, 14);
  assert.deepEqual(calls.map(call => call.url), starterSources.map(source => source.url));
  assert.ok(calls.every(call => /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[a-f0-9]{40}\//.test(call.url)));
  assert.equal(new Set(files.map(file => file.relativePath)).size, files.length);
  assert.deepEqual(files.filter(file => file.relativePath.endsWith('.fx')).map(file => path.basename(file.relativePath)),
    ['ChartsHub_Curves.fx', 'ChartsHub_MagicHDR.fx', 'ChartsHub_Technicolor2.fx']);
  const headers = new Map(starterSources.filter(source => source.relativePath.endsWith('.fxh')).flatMap(source => {
    const original = new URL(source.url).pathname.split('/').pop(), prefixed = path.basename(source.relativePath);
    return [[original, prefixed], ['FXShaders/' + original, prefixed]];
  }));
  headers.set('ReShadeUI.fxh', 'ChartsHub_ReShadeUI.fxh');
  const installedNames = new Set(files.map(file => path.basename(file.relativePath)));
  for (const file of files) {
    assert.match(file.relativePath, /^ChartsHub-ReShade-Shaders\/(?:Shaders|Licenses)\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,100}$/);
    assert.ok(Buffer.isBuffer(file.bytes));
    if (file.relativePath.endsWith('.fxh')) assert.match(path.basename(file.relativePath), /^ChartsHub_/);
    if (/\.fxh?$/.test(file.relativePath)) for (const include of file.bytes.toString().matchAll(/^[ \t]*#[ \t]*include[ \t]+["<]([^">]+)[">]/gm)) {
      assert.ok(installedNames.has(include[1]), file.relativePath + ' resolves ' + include[1]);
      assert.match(include[1], /^ChartsHub_[A-Za-z0-9_.]+$/);
    }
  }
  for (const source of starterSources) {
    const expected = /\.fxh?$/.test(source.relativePath) ? source.content.replace(
      /^([ \t]*#[ \t]*include[ \t]+")([^"\r\n]+)(")/gm,
      (directive, opening, name, closing) => headers.has(name) ? opening + headers.get(name) + closing : directive) : source.content;
    assert.deepEqual(files.find(file => file.relativePath === 'ChartsHub-ReShade-Shaders/' + source.relativePath).bytes, Buffer.from(expected));
  }
  const provenance = files.find(file => file.relativePath.endsWith('/Licenses/SOURCES.txt')).bytes.toString();
  assert.match(provenance, /Curves, MagicHDR, Technicolor2/); assert.match(provenance, /before include renaming/);
  for (const source of starterSources) { assert.ok(provenance.includes(source.url)); assert.ok(provenance.includes(sha256(Buffer.from(source.content)))); }
  assert.match(files.find(file => file.relativePath.endsWith('/Shaders/ChartsHub_ReShadeUI.fxh')).bytes.toString(), /#define __UNIFORM_COLOR_FLOAT3 ui_type = "color";/);
});

test('every starter shader, dependency and license is hash-checked before continuing', async t => {
  const routes = starterSources.flatMap((_, corruptIndex) => starterSources.slice(0, corruptIndex + 1).map((source, index) => ({
    body: Buffer.from(source.content + (index === corruptIndex ? '\n// substituted upstream content' : ''))
  })));
  const calls = fakeNetwork(t, routes);
  let completed = 0;
  for (const [index, source] of starterSources.entries()) {
    await assert.rejects(downloadStarterEffects(), /version vérifiée/);
    completed += index + 1;
    assert.equal(calls.length, completed, source.relativePath + ' stops the whole pack');
    assert.equal(calls.at(-1).request.destroyed, true);
  }
});

test('the real optional pack installs all includes after review, preserving earlier shaders and leaving effects disabled', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-starter-pack-test-')));
  const root = path.join(directory, 'Clone Hero'), data = path.join(directory, 'data'), addon = path.join(directory, 'bridge.addon64');
  await fs.mkdir(root); await fs.mkdir(data);
  await fs.writeFile(path.join(root, 'Clone Hero.exe'), pe({ dll: false }));
  await fs.writeFile(path.join(root, 'UnityPlayer.dll'), 'fixture; never loaded'); await fs.writeFile(addon, pe());
  const shaderDirectory = path.join(root, 'ChartsHub-ReShade-Shaders', 'Shaders');
  await fs.mkdir(shaderDirectory, { recursive: true });
  await fs.writeFile(path.join(shaderDirectory, 'ChartsHub_ArcaneBloom.fx'), 'earlier pack; user edited');
  const calls = fakeNetwork(t, starterSources.map(source => ({ body: Buffer.from(source.content) })));
  const service = createReShadeSetupService({ dataDirectory: data, platform: 'win32', addonBinaryPath: addon,
    reshadeService: { status: () => ({ rootPath: root }), refresh: async () => {} },
    probeClosed: async () => ({ running: false, sessions: [] }), downloadRuntime: async () => pe(), downloadStarterEffects });
  t.after(async () => {
    await service.dispose();
    assert.equal(path.dirname(directory), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('chartshub-starter-pack-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await service.prepare({ includeStarterEffects: true });
  assert.equal(calls.length, 12); assert.equal(service.status().state, 'ready');
  const reviewed = service.status().files.filter(name => name.startsWith('ChartsHub-ReShade-Shaders/'));
  assert.equal(reviewed.length, 14);
  await assert.rejects(fs.stat(path.join(shaderDirectory, 'ChartsHub_Curves.fx')), { code: 'ENOENT' });
  await service.install(); assert.equal(service.status().state, 'complete');
  for (const filename of reviewed) assert.ok((await fs.stat(path.join(root, filename))).isFile(), filename);
  assert.equal(await fs.readFile(path.join(root, 'ChartsHub-ReShade-Preset.ini'), 'utf8'), 'Techniques=\r\nTechniqueSorting=\r\n');
  assert.equal(await fs.readFile(path.join(shaderDirectory, 'ChartsHub_ArcaneBloom.fx'), 'utf8'), 'earlier pack; user edited');
});
