'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { Module, createRequire } = require('node:module');
const { constants } = require('node:fs');
const { preparePlaybackMedia, mediaResponse } = require('../companion/library-media.cjs');
const { captureBundleSnapshot } = require('../companion/chart-bundle.cjs');
const { createInstalledLibraryService } = require('../companion/library-service.cjs');
const { createBackgroundLibraryService } = require('../companion/library-background.cjs');

const chart = '[Song]\n{\n Name = "Installed"\n Resolution = 192\n}\n[ExpertSingle]\n{\n 0 = N 0 0\n}\n';
const ini = '[Song]\nname=Installed\nartist=Band\ncharter=Mapper\nalbum=Record\nyear=2025\ngenre=Metal\nsong_length=180000\nvideo_start_time=-1250\n';
const audio = Buffer.alloc(180000); for (let index = 0; index < audio.length; index++) audio[index] = index % 251;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLcoAAAAASUVORK5CYII=', 'base64');
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom'), Buffer.alloc(8), Buffer.from('temporary video fixture')]);
const hash = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!await check()) { if (Date.now() >= deadline) throw Error('Playback fixture did not settle'); await delay(10); }
}
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-library-media-'));
  const root = path.join(base, 'Songs'), folder = path.join(root, 'Installed'), outside = path.join(base, 'Outside'), data = path.join(base, 'Profile');
  await Promise.all([fs.mkdir(folder, { recursive: true }), fs.mkdir(outside), fs.mkdir(data)]);
  await Promise.all([fs.writeFile(path.join(folder, 'notes.chart'), chart), fs.writeFile(path.join(folder, 'song.ini'), ini),
    fs.writeFile(path.join(folder, 'song.wav'), audio), fs.writeFile(path.join(folder, 'album.png'), png)]);
  const services = [];
  t.after(async () => {
    for (const value of services) await value.stop();
    if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-library-media-')) throw Error('Unexpected playback fixture directory');
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, root, folder, outside, data, services, file: name => path.join(folder, name),
    item: { id: hash('Installed/notes.chart'), relativePath: 'Installed/notes.chart', format: 'chart', title: 'Installed', artist: 'Band', charter: 'Mapper' } };
}
async function plan(f) {
  f.item.cleanupSnapshot = await captureBundleSnapshot({ rootPath: f.root, relativePath: f.item.relativePath, format: f.item.format });
  return preparePlaybackMedia({ root: f.root, item: f.item });
}
async function injected(filename, overrides) {
  const absolute = require.resolve(filename), local = new Module(absolute, module), normal = createRequire(absolute);
  local.filename = absolute; local.paths = Module._nodeModulePaths(path.dirname(absolute));
  local.require = name => Object.hasOwn(overrides, name) ? overrides[name] : normal(name);
  local._compile(await fs.readFile(absolute, 'utf8'), absolute); return local.exports;
}
async function instrumented(options = {}) {
  const observed = { opens: 0, closes: 0, reads: [], flags: [] };
  const adapter = await injected('../companion/library-media.cjs', { 'node:fs/promises': { ...fs,
    open: async (...args) => {
      await options.beforeOpen?.(args[0]);
      const handle = await fs.open(...args); observed.opens++; observed.flags.push(args[1]);
      let closed = false;
      const proxy = { stat: (...values) => handle.stat(...values),
        read: async (...values) => {
          observed.reads.push(values[2]); const result = await handle.read(...values);
          await options.afterRead?.(args[0], result); return result;
        }, close: async () => { assert.equal(closed, false, 'each descriptor closes only once'); closed = true; await handle.close(); observed.closes++; } };
      try { await options.afterOpen?.(args[0]); } catch (error) { await proxy.close(); throw error; }
      return proxy;
    }
  } });
  return { ...adapter, observed };
}
const request = (method = 'GET', range, signal) => new Request('https://chartshub.invalid/opaque-local-media', { method, signal, headers: range ? { Range: range } : {} });

test('playback mixes backing audio with every known instrument stem, excludes previews and retains metadata and verified artwork', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file('guitar.ogg'), Buffer.from('isolated guitar fixture'));
  await fs.writeFile(f.file('preview.ogg'), Buffer.from('preview is never played'));
  const before = await fs.readFile(f.file('song.wav')), result = await plan(f);
  assert.deepEqual(result.media.map(entry => entry.role), ['song', 'guitar']);
  assert.equal(result.mediaMode, 'stems'); assert.equal(result.genre, 'Metal'); assert.equal(result.videoStartTimeMs, -1250);
  assert.equal(result.artwork.contentType, 'image/png'); assert.equal(result.artwork.size, png.length);
  assert.equal(result.folderPath, f.folder); assert.equal(result.rootPath, f.root);
  assert.ok(result.media.every(entry => entry.rootPath === f.root && entry.identity.file.nlink === '1'));
  assert.deepEqual(structuredClone(result), result, 'private descriptors can cross the worker boundary');
  assert.deepEqual(await fs.readFile(f.file('song.wav')), before, 'preparation never rewrites Songs');
});

test('numbered drum and vocal stems replace combined stems and an audio preview cannot authorize a full song', async t => {
  const f = await fixture(t); await fs.unlink(f.file('song.wav'));
  for (const role of ['drums', 'drums_1', 'drums_2', 'vocals', 'vocals_1', 'vocals_explicit', 'vocals_explicit_1']) await fs.writeFile(f.file(role + '.ogg'), role);
  assert.deepEqual((await plan(f)).media.map(entry => entry.role), ['drums_1', 'drums_2', 'vocals_1', 'vocals_explicit_1']);
  for (const name of await fs.readdir(f.folder)) if (name.endsWith('.ogg')) await fs.unlink(f.file(name));
  await fs.writeFile(f.file('preview.mp3'), 'preview');
  await assert.rejects(plan(f), /Aucun fichier audio complet/);
});

test('ambiguous audio roles and competing notes are refused, SNG is explicitly unsupported', async t => {
  const f = await fixture(t); await fs.writeFile(f.file('song.mp3'), 'competing song');
  await assert.rejects(plan(f), /même instrument/);
  await fs.unlink(f.file('song.mp3')); await fs.writeFile(f.file('notes.mid'), 'second notes');
  await assert.rejects(plan(f), /notes.*ambiguë/);
  await assert.rejects(preparePlaybackMedia({ root: f.root, item: { format: 'sng' } }), error => error.code === 'LIBRARY_MEDIA_UNSUPPORTED' && /SNG/.test(error.message));
});

test('changed notes, metadata, audio and artwork after the scan invalidate the entire playback plan', async t => {
  const f = await fixture(t);
  for (const name of ['notes.chart', 'song.ini', 'song.wav', 'album.png']) {
    const original = await fs.readFile(f.file(name)); await plan(f);
    await fs.appendFile(f.file(name), 'changed after scan');
    await assert.rejects(preparePlaybackMedia({ root: f.root, item: f.item }), /changé/);
    await fs.writeFile(f.file(name), original);
  }
});

test('traversal, outside paths, hard links and folder junctions never authorize playback', async t => {
  const f = await fixture(t); await plan(f);
  for (const relativePath of ['../Outside/notes.chart', '/Outside/notes.chart', 'Installed\\notes.chart', 'Installed/../notes.chart']) {
    await assert.rejects(preparePlaybackMedia({ root: f.root, item: { ...f.item, relativePath, id: hash(relativePath) } }));
  }
  await fs.link(f.file('song.wav'), path.join(f.outside, 'linked.wav'));
  await assert.rejects(plan(f)); await fs.unlink(path.join(f.outside, 'linked.wav'));
  await plan(f); await fs.rename(f.folder, path.join(f.root, 'Original'));
  await fs.symlink(f.outside, f.folder, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(preparePlaybackMedia({ root: f.root, item: f.item }));
});

test('only bounded, correctly signed album raster files are exposed; ambiguous or fake artwork stays absent', async t => {
  const f = await fixture(t); await fs.writeFile(f.file('album.png'), '<svg><script>not an image</script></svg>');
  assert.equal((await plan(f)).artwork, null);
  await fs.writeFile(f.file('album.png'), png); await fs.writeFile(f.file('album.jpg'), Buffer.from([255, 216, 255]));
  assert.equal((await plan(f)).artwork, null);
  await fs.unlink(f.file('album.jpg'));
  const handle = await fs.open(f.file('album.png'), 'r+'); await handle.truncate(8 * 1024 * 1024 + 1); await handle.close();
  assert.equal((await plan(f)).artwork, null);
});

test('video uses only an exact supported name and signature, with a signed millisecond offset', async t => {
  const f = await fixture(t); await fs.writeFile(f.file('background.mp4'), mp4);
  assert.equal((await plan(f)).video, null);
  await fs.writeFile(f.file('video.mp4'), mp4);
  const value = await plan(f); assert.equal(value.video.name, 'video.mp4'); assert.equal(value.video.contentType, 'video/mp4');
  assert.equal(value.videoStartTimeMs, -1250);
  const response = await mediaResponse(value.video, request('GET', 'bytes=4-11'));
  assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), mp4.subarray(4, 12));
  await fs.writeFile(f.file('video.webm'), Buffer.concat([Buffer.from([26, 69, 223, 163]), Buffer.alloc(20)]));
  const ambiguous = await plan(f); assert.equal(ambiguous.video, null); assert.equal(ambiguous.videoUnavailable, 'ambiguous'); assert.equal(ambiguous.media.length, 1);
});

test('unsupported, malformed and oversized optional videos preserve the verified audio plan', async t => {
  const f = await fixture(t); await fs.writeFile(f.file('video.avi'), 'unsupported');
  assert.equal((await plan(f)).videoUnavailable, 'unsupported'); await fs.unlink(f.file('video.avi'));
  await fs.writeFile(f.file('video.mp4'), '<html>not mp4</html>');
  assert.equal((await plan(f)).videoUnavailable, 'unsupported');
  await fs.writeFile(f.file('video.mp4'), mp4);
  await plan(f);
  // Exercise the size guard without allocating a multi-gigabyte test video.
  const oversized = await injected('../companion/library-media.cjs', { 'node:fs/promises': { ...fs,
    lstat: async (filename, options) => {
      const stat = await fs.lstat(filename, options);
      return filename === f.file('video.mp4') ? Object.assign(Object.create(stat), { size: BigInt(4 * 1024 * 1024 * 1024 + 1) }) : stat;
    }
  } });
  const value = await oversized.preparePlaybackMedia({ root: f.root, item: f.item });
  assert.equal(value.video, null); assert.equal(value.videoUnavailable, 'unavailable'); assert.equal(value.media.length, 1);
});

test('missing or conflicting optional INI fields never invent genre or video alignment', async t => {
  const f = await fixture(t); await fs.writeFile(f.file('song.ini'), ini + 'genre=Other\nvideo_start_time=1250\n');
  const value = await plan(f); assert.equal(value.genre, undefined); assert.equal(value.videoStartTimeMs, 0);
  await fs.writeFile(f.file('song.ini'), '[other]\ngenre=Private\nvideo_start_time=4000\n');
  assert.equal((await plan(f)).genre, undefined); assert.equal((await plan(f)).videoStartTimeMs, 0);
});

test('GET streams bounded chunks from a checked descriptor and closes exactly once at EOF', async t => {
  const f = await fixture(t), entry = (await plan(f)).media[0], adapter = await instrumented(); let closed = 0;
  const response = await adapter.mediaResponse(entry, request(), { onClose: () => closed++ });
  assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Length'), String(audio.length));
  assert.equal(response.headers.get('Content-Type'), 'audio/wav'); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(adapter.observed.reads.length, 0, 'creating a response does not buffer the song');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio); await until(() => closed === 1);
  assert.equal(adapter.observed.opens, 1); assert.equal(adapter.observed.closes, 1);
  assert.ok(adapter.observed.reads.every(length => length <= 64 * 1024));
  assert.ok(adapter.observed.flags.every(flags => (flags & (constants.O_NOFOLLOW ?? 0)) === (constants.O_NOFOLLOW ?? 0)));
});

test('single HTTP ranges support explicit, open-ended and suffix byte ranges without extra data', async t => {
  const f = await fixture(t), entry = (await plan(f)).media[0];
  for (const [range, start, end] of [['bytes=0-9', 0, 9], ['bytes=179990-', 179990, audio.length - 1], ['bytes=-7', audio.length - 7, audio.length - 1], ['bytes=179995-999999', 179995, audio.length - 1]]) {
    let closed = 0; const response = await mediaResponse(entry, request('GET', range), { onClose: () => closed++ });
    assert.equal(response.status, 206); assert.equal(response.headers.get('Content-Range'), `bytes ${start}-${end}/${audio.length}`);
    assert.equal(response.headers.get('Content-Length'), String(end - start + 1));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio.subarray(start, end + 1)); await until(() => closed === 1);
  }
});

test('HEAD and unsatisfiable ranges close their descriptor without reading or leaking body bytes', async t => {
  const f = await fixture(t), entry = (await plan(f)).media[0], adapter = await instrumented(); let closed = 0;
  const head = await adapter.mediaResponse(entry, request('HEAD', 'bytes=20-29'), { onClose: () => closed++ });
  assert.equal(head.status, 206); assert.equal(head.body, null); assert.equal(head.headers.get('Content-Length'), '10');
  for (const range of ['bytes=180000-', 'bytes=9-2', 'bytes=-0', 'bytes=0-1,4-5', 'bytes=9007199254740993-', 'items=0-1', 'bytes=-']) {
    const response = await adapter.mediaResponse(entry, request('GET', range), { onClose: () => closed++ });
    assert.equal(response.status, 416, range); assert.equal(response.body, null); assert.equal(response.headers.get('Content-Range'), 'bytes */' + audio.length);
  }
  assert.equal(closed, 8); assert.equal(adapter.observed.opens, 8); assert.equal(adapter.observed.closes, 8); assert.equal(adapter.observed.reads.length, 0);
});

test('foreign paths, metadata entries, disallowed methods and revoked capabilities close without opening arbitrary files', async t => {
  const f = await fixture(t), entry = (await plan(f)).media[0], adapter = await instrumented(); let closed = 0;
  const callback = { onClose: () => closed++ };
  for (const value of [{ ...entry, path: path.join(f.outside, 'private.wav') }, { ...entry, kind: 'metadata' }, { ...entry, relativePath: '../Outside/private.wav' }]) {
    assert.equal((await adapter.mediaResponse(value, request(), callback)).status, 404);
  }
  assert.equal((await adapter.mediaResponse(entry, request('POST'), callback)).status, 405);
  assert.equal((await adapter.mediaResponse(entry, request(), { ...callback, isAllowed: () => false })).status, 404);
  assert.equal(closed, 5); assert.equal(adapter.observed.opens, 0);
});

test('changes after preparation or between open and descriptor validation never expose replacement files', async t => {
  const f = await fixture(t), entry = (await plan(f)).media[0];
  await fs.appendFile(f.file('notes.chart'), 'changed'); let closed = 0;
  assert.equal((await mediaResponse(entry, request(), { onClose: () => closed++ })).status, 404); assert.equal(closed, 1);
  await fs.writeFile(f.file('notes.chart'), chart); const current = (await plan(f)).media[0];
  await fs.writeFile(path.join(f.outside, 'song.wav'), 'outside audio must never be read');
  const adapter = await instrumented({ beforeOpen: async () => {
    await fs.rename(f.folder, path.join(f.root, 'Original'));
    await fs.symlink(f.outside, f.folder, process.platform === 'win32' ? 'junction' : 'dir');
  } });
  assert.equal((await adapter.mediaResponse(current, request(), { onClose: () => closed++ })).status, 404);
  assert.equal(adapter.observed.opens, 1); assert.equal(adapter.observed.closes, 1); assert.equal(adapter.observed.reads.length, 0); assert.equal(closed, 2);
});

test('changes after a response opens and during a read fail before returning changed audio and close the descriptor', async t => {
  const f = await fixture(t), entry = (await plan(f)).media[0], adapter = await instrumented(); let closed = 0;
  const response = await adapter.mediaResponse(entry, request(), { onClose: () => closed++ });
  await fs.appendFile(f.file('song.wav'), 'changed before first pull');
  await assert.rejects(response.arrayBuffer(), /changé/); await until(() => closed === 1); assert.equal(adapter.observed.closes, 1);
  await fs.writeFile(f.file('song.wav'), audio); const current = (await plan(f)).media[0];
  let modified = false;
  const racing = await instrumented({ afterRead: async filename => { if (!modified) { modified = true; await fs.appendFile(filename, 'changed during read'); } } });
  const read = await racing.mediaResponse(current, request(), { onClose: () => closed++ });
  await assert.rejects(read.body.getReader().read(), /changé/); await until(() => closed === 2); assert.equal(racing.observed.closes, 1);
});

test('reader cancellation, request abortion and session abortion release an idle or active descriptor exactly once', async t => {
  const f = await fixture(t), entry = (await plan(f)).media[0], adapter = await instrumented(); let closed = 0;
  const cancelled = await adapter.mediaResponse(entry, request(), { onClose: () => closed++ });
  await cancelled.body.cancel(); assert.equal(closed, 1); assert.equal(adapter.observed.reads.length, 0);
  const requestAbort = new AbortController(), sessionAbort = new AbortController();
  const active = await adapter.mediaResponse(entry, request('GET', undefined, requestAbort.signal), { signal: sessionAbort.signal, onClose: () => closed++ });
  const reader = active.body.getReader(); assert.equal((await reader.read()).value.length, 64 * 1024);
  sessionAbort.abort(); requestAbort.abort(); await assert.rejects(reader.read(), error => error.name === 'AbortError');
  await until(() => closed === 2); assert.equal(adapter.observed.opens, 2); assert.equal(adapter.observed.closes, 2);
  const preAborted = new AbortController(); preAborted.abort();
  assert.equal((await adapter.mediaResponse(entry, request('GET', undefined, preAborted.signal), { onClose: () => closed++ })).status, 404);
  assert.equal(closed, 3); assert.equal(adapter.observed.opens, 2);
});

test('revoking an already opened capability prevents its next chunk and closes the file', async t => {
  const f = await fixture(t), entry = (await plan(f)).media[0]; let allowed = true, closed = 0;
  const response = await mediaResponse(entry, request(), { isAllowed: () => allowed, onClose: () => closed++ });
  const reader = response.body.getReader(); assert.equal((await reader.read()).value.length, 64 * 1024);
  allowed = false; await assert.rejects(reader.read(), /changé/); await until(() => closed === 1);
});

test('aborting while a chunk is in flight closes the descriptor and never returns that chunk', async t => {
  const f = await fixture(t), entry = (await plan(f)).media[0], abort = new AbortController(); let entered, release, closed = 0;
  const arrived = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  const adapter = await instrumented({ afterRead: async () => { entered(); await gate; } });
  const response = await adapter.mediaResponse(entry, request(), { signal: abort.signal, onClose: () => closed++ });
  const reader = response.body.getReader(), reading = reader.read(); await arrived;
  abort.abort(); await assert.rejects(reading, error => error.name === 'AbortError'); await until(() => closed === 1);
  release(); await delay(10);
  assert.equal(adapter.observed.opens, 1); assert.equal(adapter.observed.closes, 1);
});

test('abortion during descriptor opening produces no response body and releases the checked handle', async t => {
  const f = await fixture(t), entry = (await plan(f)).media[0], abort = new AbortController(); let closed = 0;
  const adapter = await instrumented({ afterOpen: async () => abort.abort() });
  const response = await adapter.mediaResponse(entry, request(), { signal: abort.signal, onClose: () => closed++ });
  assert.equal(response.status, 404); assert.equal(response.body, null); assert.equal(closed, 1);
  assert.equal(adapter.observed.opens, 1); assert.equal(adapter.observed.closes, 1); assert.equal(adapter.observed.reads.length, 0);
});

test('notes changed while an open response is idle prevent its first audio chunk', async t => {
  const f = await fixture(t), entry = (await plan(f)).media[0], adapter = await instrumented(); let closed = 0;
  const response = await adapter.mediaResponse(entry, request(), { onClose: () => closed++ });
  await fs.appendFile(f.file('notes.chart'), 'changed before playing');
  await assert.rejects(response.body.getReader().read(), /changé/); await until(() => closed === 1);
  assert.equal(adapter.observed.reads.length, 0); assert.equal(adapter.observed.closes, 1);
});

test('the installed library resolves only indexed current songs with metadata, revision and private media identities', async t => {
  const f = await fixture(t), value = createInstalledLibraryService({ dataDirectory: f.data }); f.services.push(value);
  await value.selectRoot(f.root); await until(() => value.status().status === 'ready');
  const song = await value.resolvePlaybackSong(f.item.id), index = value.matchingSnapshot();
  assert.equal(song.rootKey, index.rootKey); assert.equal(song.revision, index.revision);
  assert.equal(song.title, 'Installed'); assert.equal(song.album, 'Record'); assert.equal(song.year, '2025'); assert.equal(song.durationMs, 180000);
  assert.deepEqual(song.tracks, [{ instrument: 'guitar', difficulty: 'expert' }]); assert.equal(song.mediaMode, 'song');
  await assert.rejects(value.resolvePlaybackSong(hash('Outside/notes.chart')), error => error.code === 'LIBRARY_MEDIA_SAFE');
  await fs.appendFile(f.file('song.ini'), 'new_field=changed\n');
  await assert.rejects(value.resolvePlaybackSong(f.item.id), error => error.code === 'LIBRARY_MEDIA_SAFE');
});

test('stopping during asynchronous playback resolution invalidates its result', async t => {
  const f = await fixture(t); let release, entered;
  const arrived = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  const adapter = await injected('../companion/library-service.cjs', { './library-media.cjs': {
    preparePlaybackMedia: async options => { const result = await preparePlaybackMedia(options); entered(); await gate; return result; }
  } });
  const value = adapter.createInstalledLibraryService({ dataDirectory: f.data }); f.services.push(value);
  await value.selectRoot(f.root); await until(() => value.status().status === 'ready');
  const pending = value.resolvePlaybackSong(f.item.id); await arrived; await value.stop(); release();
  await assert.rejects(pending, error => error.code === 'LIBRARY_MEDIA_SAFE');
});

test('changing the Songs root during playback resolution cannot return the previous private plan', async t => {
  const f = await fixture(t); let release, entered;
  const arrived = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  const adapter = await injected('../companion/library-service.cjs', { './library-media.cjs': {
    preparePlaybackMedia: async options => { const result = await preparePlaybackMedia(options); entered(); await gate; return result; }
  } });
  const value = adapter.createInstalledLibraryService({ dataDirectory: f.data }); f.services.push(value);
  await value.selectRoot(f.root); await until(() => value.status().status === 'ready');
  const pending = value.resolvePlaybackSong(f.item.id); await arrived;
  await value.selectRoot(f.outside); await until(() => value.status().status === 'ready'); release();
  await assert.rejects(pending, error => error.code === 'LIBRARY_MEDIA_SAFE');
  assert.equal(value.matchingSnapshot().items.length, 0);
});

test('MIDI charts use the same safe local audio plan and report their actual playable tracks', async t => {
  const f = await fixture(t); await fs.unlink(f.file('notes.chart'));
  const header = Buffer.alloc(14); header.write('MThd'); header.writeUInt32BE(6, 4); header.writeUInt16BE(1, 10); header.writeUInt16BE(480, 12);
  const name = Buffer.from('PART GUITAR'), body = Buffer.concat([Buffer.from([0, 255, 3, name.length]), name, Buffer.from([0, 144, 96, 100, 0, 128, 96, 0, 0, 255, 47, 0])]);
  const chunk = Buffer.alloc(8); chunk.write('MTrk'); chunk.writeUInt32BE(body.length, 4);
  await fs.writeFile(f.file('notes.mid'), Buffer.concat([header, chunk, body]));
  const value = createInstalledLibraryService({ dataDirectory: f.data }); f.services.push(value);
  await value.selectRoot(f.root); await until(() => value.status().status === 'ready');
  const result = await value.resolvePlaybackSong(hash('Installed/notes.mid'));
  assert.deepEqual(result.tracks, [{ instrument: 'guitar', difficulty: 'expert' }]); assert.equal(result.media[0].name, 'song.wav');
});

test('the real background worker returns playback plans, preserves safe errors and blocks resolution after shutdown', async t => {
  const f = await fixture(t), value = createBackgroundLibraryService({ dataDirectory: f.data }); f.services.push(value);
  await value.selectRoot(f.root); await until(() => value.status().status === 'ready');
  const result = await value.resolvePlaybackSong(f.item.id);
  assert.equal(result.rootKey, value.matchingSnapshot().rootKey); assert.equal(result.revision, value.status().revision);
  assert.equal(result.media[0].size, audio.length); assert.equal(result.artwork.contentType, 'image/png');
  const page = await value.queryPlayback({ query: 'Record', offset: 0, limit: 20, filters: { album: 'Record', year: '2025' } });
  assert.equal(page.total, 1); assert.equal(page.items[0].album, 'Record'); assert.equal(page.items[0].year, '2025');
  assert.ok(!JSON.stringify(page).includes(f.root)); assert.equal(page.items[0].cleanupSnapshot, undefined);
  await fs.writeFile(f.file('song.mp3'), 'ambiguous'); await value.requestScan('quick'); await until(() => value.status().status === 'ready');
  await assert.rejects(value.resolvePlaybackSong(f.item.id), error => error.code === 'LIBRARY_MEDIA_SAFE' && !error.message.includes(f.root));
  await value.stop(); await assert.rejects(value.resolvePlaybackSong(f.item.id), /arrêté/);
});

test('unsupported audio survives the service and real worker boundaries as an explicit format error', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file('guitar.aiff'), 'unsupported audio');
  for (const create of [createInstalledLibraryService, createBackgroundLibraryService]) {
    const value = create({ dataDirectory: f.data }); f.services.push(value);
    await value.selectRoot(f.root); await until(() => value.status().status === 'ready');
    await assert.rejects(value.resolvePlaybackSong(f.item.id), error => error.code === 'LIBRARY_MEDIA_UNSUPPORTED' && !error.message.includes(f.root));
    await value.stop();
  }
});
