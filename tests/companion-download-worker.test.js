const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createDownloadWorker } = require('../companion/download-worker.cjs');

const ORIGIN = 'https://chartshub.ca';
const endpoint = '/api/charts/12345678-1234-1234-1234-123456789012/SongFolderabcdefghij/download-manifest';
const id = '11111111-2222-4333-8444-555555555555';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const blobKey = parts => hash(JSON.stringify(parts)) + '.blob';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function song(entries = [['song.ini', 'name=Test\nartist=Artist\n'], ['notes.chart', '[Song]\n{}'], ['audio/song.ogg', 'synthetic audio fixture']], hashes = true) {
  const content = new Map();
  const files = entries.map(([name, value], index) => {
    const bytes = Buffer.from(value), url = endpoint.replace(/download-manifest$/, 'files/FileNumber' + String(index).padStart(10, '0'));
    content.set(url, bytes); return { parts: name.split('/'), size: bytes.length, url, ...(hashes ? { sha256: hash(bytes) } : {}) };
  });
  return { manifest: { title: 'Test', artist: 'Artist', files }, content };
}
async function fixture(t, data = song()) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-worker-')), rootPath = path.join(base, 'downloads'), outside = path.join(base, 'outside');
  await fs.mkdir(rootPath); await fs.mkdir(outside); const calls = [];
  const source = { data, intercept: null };
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    const response = source.intercept ? await source.intercept(url, options) : null;
    if (response !== null && response !== undefined) return response;
    if (url === ORIGIN + endpoint) return json(source.data.manifest);
    const bytes = source.data.content.get(url.slice(ORIGIN.length));
    assert.ok(bytes, 'Unexpected request: ' + url);
    return new Response(bytes, { headers: { 'content-length': String(bytes.length), 'content-type': 'application/octet-stream' } });
  };
  const worker = createDownloadWorker({ fetcher });
  const stage = path.join(rootPath, '.chartshub-companion-' + id);
  t.after(async () => {
    if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-worker-')) throw Error('Unsafe test cleanup');
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, rootPath, outside, calls, source, fetcher, worker, stage, args: { id, endpoint, rootPath } };
}
async function pauseAfterFirst(f) {
  const controller = new AbortController(), firstUrl = ORIGIN + f.source.data.manifest.files[0].url;
  f.source.intercept = (url) => {
    if (url !== ORIGIN + endpoint && url !== firstUrl) { controller.abort('private cancellation reason'); return new Promise(() => {}); }
  };
  await assert.rejects(f.worker.run({ ...f.args, signal: controller.signal }), { name: 'AbortError', code: 'ABORT_ERR' });
  f.source.intercept = null;
}

test('Companion download worker installs checked synthetic files, sends no credentials or Range, and reports complete progress', async t => {
  const f = await fixture(t), progress = [];
  const result = await f.worker.run({ ...f.args, onProgress: item => progress.push(item) });
  assert.deepEqual(result, { destination: path.join(f.rootPath, 'Artist - Test'), folderName: 'Artist - Test', files: 3, totalBytes: [...f.source.data.content.values()].reduce((n, bytes) => n + bytes.length, 0) });
  for (const file of f.source.data.manifest.files) assert.deepEqual(await fs.readFile(path.join(result.destination, ...file.parts)), f.source.data.content.get(file.url));
  assert.equal(await f.worker.resolveCompleted({ rootPath: f.rootPath, destination: result.destination }), result.destination);
  assert.equal(progress.at(-1).receivedBytes, result.totalBytes); assert.equal(progress.at(-1).completedFiles, 3); assert.equal(progress.at(-1).currentFile, null);
  assert.ok(progress.every(item => item.receivedBytes <= item.totalBytes && item.completedFiles <= item.totalFiles));
  assert.ok((await fs.readdir(f.stage)).includes('checkpoint.json'));
  await assert.rejects(fs.stat(path.join(f.stage, 'files')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(result.destination, '.chartshub-companion-installing')), { code: 'ENOENT' });
  for (const { url, options } of f.calls) {
    assert.ok(url.startsWith(ORIGIN + '/api/charts/')); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'GET'); assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.cache, 'no-store');
    assert.equal(Object.keys(options.headers).some(key => /range|cookie|authorization/i.test(key)), false);
  }
});

test('Companion download worker reserves a new directory without overwriting an existing song', async t => {
  const f = await fixture(t), existing = path.join(f.rootPath, 'Artist - Test');
  await fs.mkdir(existing); await fs.writeFile(path.join(existing, 'song.ini'), 'user content');
  const result = await f.worker.run(f.args);
  assert.equal(result.folderName, 'Artist - Test (2)'); assert.equal(await fs.readFile(path.join(existing, 'song.ini'), 'utf8'), 'user content');
});

test('Companion download worker resumes after a new instance, revalidates the manifest and skips only verified completed files', async t => {
  const f = await fixture(t); await pauseAfterFirst(f);
  const files = await fs.readdir(path.join(f.stage, 'files'));
  assert.deepEqual(files, [blobKey(['song.ini'])]); await assert.rejects(fs.stat(path.join(f.stage, 'active.part')), { code: 'ENOENT' });
  const before = f.calls.length, progress = [];
  const result = await createDownloadWorker({ fetcher: f.fetcher }).run({ ...f.args, onProgress: value => progress.push(value) });
  assert.equal(result.files, 3); assert.equal(f.calls[before].url, ORIGIN + endpoint);
  assert.equal(f.calls.slice(before).some(call => call.url === ORIGIN + f.source.data.manifest.files[0].url), false);
  assert.ok(progress.some(value => value.completedFiles === 1 && value.receivedBytes === f.source.data.manifest.files[0].size));
});

test('Companion download worker removes interrupted bytes and restarts that file from zero', async t => {
  const f = await fixture(t), controller = new AbortController(); let bodyCancelled = false;
  const file = f.source.data.manifest.files[0];
  f.source.intercept = url => url === ORIGIN + file.url ? new Response(new ReadableStream({
    start(stream) { stream.enqueue(Buffer.from('name=')); }, cancel() { bodyCancelled = true; }
  })) : null;
  await assert.rejects(f.worker.run({ ...f.args, signal: controller.signal, onProgress: p => { if (p.receivedBytes > 0) controller.abort(); } }), { name: 'AbortError' });
  assert.equal(bodyCancelled, true); await assert.rejects(fs.stat(path.join(f.stage, 'active.part')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.join(f.stage, 'files')), []);
  f.source.intercept = null; const before = f.calls.length; await f.worker.run(f.args);
  assert.equal(f.calls[before + 1].url, ORIGIN + file.url); assert.equal(f.calls[before + 1].options.headers.Range, undefined);
});

test('Companion download worker detects same-size checkpoint corruption even without a remote hash', async t => {
  const f = await fixture(t, song(undefined, false)); await pauseAfterFirst(f);
  const file = f.source.data.manifest.files[0];
  await fs.writeFile(path.join(f.stage, 'files', blobKey(file.parts)), Buffer.alloc(file.size, 120));
  const before = f.calls.length; const result = await f.worker.run(f.args);
  assert.equal(f.calls.slice(before).filter(call => call.url === ORIGIN + file.url).length, 1);
  assert.deepEqual(await fs.readFile(path.join(result.destination, ...file.parts)), f.source.data.content.get(file.url));
});

test('Companion download worker reconciles a fresh changed manifest before resuming', async t => {
  const f = await fixture(t); await pauseAfterFirst(f);
  f.source.data = song([['song.ini', 'name=Changed\nartist=Artist\n'], ['notes.mid', 'synthetic MIDI']]);
  const before = f.calls.length, result = await f.worker.run(f.args);
  assert.equal(result.files, 2); assert.equal(f.calls.slice(before).length, 3);
  assert.equal(await fs.readFile(path.join(result.destination, 'song.ini'), 'utf8'), 'name=Changed\nartist=Artist\n');
  await assert.rejects(fs.stat(path.join(result.destination, 'notes.chart')), { code: 'ENOENT' });
});

test('Companion download worker rejects invalid sizes and hashes without publishing a song', async t => {
  for (const mode of ['short', 'long', 'hash', 'length']) {
    const f = await fixture(t, song([['notes.chart', '123456']]));
    f.source.intercept = url => {
      if (url === ORIGIN + endpoint) return null;
      if (mode === 'short') return new Response('123');
      if (mode === 'long') return new Response('1234567');
      if (mode === 'hash') return new Response('abcdef');
      return new Response('123456', { headers: { 'content-length': '3' } });
    };
    await assert.rejects(f.worker.run(f.args), { code: 'DOWNLOAD_INTEGRITY' });
    assert.deepEqual((await fs.readdir(f.rootPath)).filter(name => !name.startsWith('.chartshub-companion-')), []);
    await assert.rejects(fs.stat(path.join(f.stage, 'active.part')), { code: 'ENOENT' });
  }
});

test('Companion download worker rejects arbitrary, admin, redirect and malformed manifest endpoints before network access', async t => {
  const f = await fixture(t);
  for (const value of [ORIGIN + endpoint, '//chartshub.ca' + endpoint, 'https://private.invalid', endpoint + '?x=1', endpoint + '#x',
    endpoint.replace('/api/charts/', '/api/admin/charts/'), endpoint.replace('/api/', '/%61pi/'), '/api/auth/me', endpoint.replace('/download-manifest', '/source')]) {
    await assert.rejects(f.worker.run({ ...f.args, endpoint: value }), { code: 'DOWNLOAD_INVALID' });
  }
  for (const value of ['../private', '1234', 'AAAAAAAA-2222-4333-8444-555555555555', '11111111-2222-3333-8444-555555555555']) await assert.rejects(f.worker.run({ ...f.args, id: value }), { code: 'DOWNLOAD_INVALID' });
  assert.equal(f.calls.length, 0); assert.deepEqual(await fs.readdir(f.rootPath), []);
});

test('Companion download worker inherits the desktop manifest limits, extension rules and path conflict validation', async t => {
  const f = await fixture(t), original = structuredClone(f.source.data.manifest), file = original.files[0];
  for (const files of [[], Array(1001).fill(file), [{ ...file, size: 2_000_000_001 }], [{ ...file, size: -1 }],
    [{ ...file, parts: ['..', 'song.ini'] }], [{ ...file, parts: ['CON.chart'] }], [{ ...file, parts: ['secret.exe'] }],
    [{ ...file, parts: ['other.ini'] }], [{ ...file, parts: ['song.ini.'] }], [{ ...file, parts: ['x'.repeat(181) + '.chart'] }],
    [{ ...file, parts: ['x', 'x', 'x', 'x', 'x', 'x', 'notes.chart'] }], [file, { ...file, parts: ['SONG.INI'] }],
    [file, { ...file, parts: ['song.ini', 'notes.chart'] }], [{ ...file, sha256: 'bad' }], [{ ...file, sha256: null }],
    [{ ...file, url: 'https://private.invalid/file' }], [{ ...file, url: file.url + '?token=private' }]]) {
    f.source.data.manifest = { ...original, files };
    await assert.rejects(f.worker.run(f.args), { code: 'DOWNLOAD_INVALID' });
    assert.deepEqual(await fs.readdir(f.rootPath), []);
  }
});

test('Companion download worker rejects redirects, foreign responses, 206 and oversized JSON without revealing remote errors', async t => {
  const f = await fixture(t);
  for (const response of [() => new Response('private upstream URL', { status: 403 }), () => new Response('', { status: 302, headers: { location: 'https://private.invalid' } }),
    () => new Response('partial', { status: 206 }), () => { const value = json(f.source.data.manifest); Object.defineProperty(value, 'url', { value: 'https://private.invalid' }); return value; },
    () => { const value = json(f.source.data.manifest); Object.defineProperty(value, 'redirected', { value: true }); return value; },
    () => new Response('<html>private</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '2000001' } }),
    () => new Response(Buffer.alloc(2_000_001), { headers: { 'content-type': 'application/json' } })]) {
    f.source.intercept = response;
    await assert.rejects(f.worker.run(f.args), error => { assert.doesNotMatch(error.message, /private|https:/); return ['DOWNLOAD_HTTP', 'DOWNLOAD_INVALID'].includes(error.code); });
  }
  assert.deepEqual(await fs.readdir(f.rootPath), []);
});

test('Companion download worker bounds stalled manifest headers, file preparation and stalled bodies', async t => {
  for (const mode of ['manifest', 'file', 'body']) {
    const f = await fixture(t); let cancelledBody = false;
    f.source.intercept = url => {
      if (mode === 'manifest' || url !== ORIGIN + endpoint) return mode === 'body' ? new Response(new ReadableStream({ cancel() { cancelledBody = true; } })) : new Promise(() => {});
      return null;
    };
    const worker = createDownloadWorker({ fetcher: f.fetcher, manifestTimeoutMs: 20, headerTimeoutMs: 20, idleTimeoutMs: 20 });
    await assert.rejects(worker.run(f.args), { code: 'DOWNLOAD_TIMEOUT' });
    if (mode === 'body') assert.equal(cancelledBody, true);
    if (mode !== 'manifest') await assert.rejects(fs.stat(path.join(f.stage, 'active.part')), { code: 'ENOENT' });
  }
});

test('Companion download worker handles cancellation and concurrent run/discard without overlapping operations', async t => {
  const f = await fixture(t), controller = new AbortController(), started = deferred();
  f.source.intercept = (_url, options) => { started.resolve(options.signal); return new Promise(() => {}); };
  const pending = f.worker.run({ ...f.args, signal: controller.signal }), signal = await started.promise;
  await assert.rejects(createDownloadWorker({ fetcher: f.fetcher }).run(f.args), { code: 'DOWNLOAD_BUSY' });
  await assert.rejects(f.worker.discard(f.args), { code: 'DOWNLOAD_BUSY' });
  controller.abort('private reason'); await assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR' }); assert.equal(signal.aborted, true);
  await f.worker.discard(f.args); assert.deepEqual(await fs.readdir(f.rootPath), []);
});

test('Companion download worker refuses unowned and future-version staging without deleting user files', async t => {
  const f = await fixture(t); await fs.mkdir(f.stage); await fs.writeFile(path.join(f.stage, 'user.txt'), 'keep');
  await assert.rejects(f.worker.run(f.args), { code: 'DOWNLOAD_PATH' }); await assert.rejects(f.worker.discard(f.args), { code: 'DOWNLOAD_PATH' });
  assert.equal(await fs.readFile(path.join(f.stage, 'user.txt'), 'utf8'), 'keep');
  await fs.unlink(path.join(f.stage, 'user.txt')); await fs.rmdir(f.stage);
  await pauseAfterFirst(f);
  const checkpoint = path.join(f.stage, 'checkpoint.json'), bytes = await fs.readFile(checkpoint, 'utf8');
  const future = JSON.parse(bytes); future.version = 99; await fs.writeFile(checkpoint, JSON.stringify(future));
  await assert.rejects(f.worker.run(f.args), { code: 'DOWNLOAD_PATH' }); await assert.rejects(f.worker.discard(f.args), { code: 'DOWNLOAD_PATH' });
  assert.equal(JSON.parse(await fs.readFile(checkpoint, 'utf8')).version, 99);
});

test('Companion download worker refuses root, staging and checkpoint-files directory junctions', async t => {
  for (const mode of ['root', 'stage', 'files']) {
    const f = await fixture(t); await fs.writeFile(path.join(f.outside, 'keep.txt'), 'private user file');
    if (mode === 'root') { await fs.rmdir(f.rootPath); await fs.symlink(f.outside, f.rootPath, 'junction'); }
    if (mode === 'stage') await fs.symlink(f.outside, f.stage, 'junction');
    if (mode === 'files') { await pauseAfterFirst(f); await fs.rename(path.join(f.stage, 'files'), path.join(f.stage, 'old-files')); await fs.symlink(f.outside, path.join(f.stage, 'files'), 'junction'); }
    await assert.rejects(f.worker.run(f.args), { code: 'DOWNLOAD_PATH' });
    await assert.rejects(f.worker.discard(f.args), { code: 'DOWNLOAD_PATH' });
    assert.deepEqual(await fs.readdir(f.outside), ['keep.txt']); assert.equal(await fs.readFile(path.join(f.outside, 'keep.txt'), 'utf8'), 'private user file');
  }
});

test('Companion download worker detects root replacement during network activity before writing any outside bytes', async t => {
  const f = await fixture(t);
  f.source.intercept = async url => {
    if (url !== ORIGIN + endpoint) return null;
    await fs.rename(f.rootPath, path.join(f.base, 'original-downloads'));
    await fs.symlink(f.outside, f.rootPath, 'junction'); return json(f.source.data.manifest);
  };
  await assert.rejects(f.worker.run(f.args), { code: 'DOWNLOAD_PATH' }); assert.deepEqual(await fs.readdir(f.outside), []);
});

test('Companion download worker records publication before late cancellation and recovers its result after queue-persistence loss', async t => {
  const f = await fixture(t), controller = new AbortController();
  const first = await f.worker.run({ ...f.args, signal: controller.signal, onProgress: p => { if (p.currentFile === null && p.completedFiles === 3) controller.abort(); } });
  assert.equal(controller.signal.aborted, true); assert.equal(first.files, 3);
  const before = f.calls.length, second = await createDownloadWorker({ fetcher: f.fetcher }).run(f.args);
  assert.deepEqual(second, first); assert.equal(f.calls.length - before, 1); assert.equal(f.calls.at(-1).url, ORIGIN + endpoint);
  assert.deepEqual((await fs.readdir(f.rootPath)).filter(name => !name.startsWith('.chartshub-companion-')), ['Artist - Test']);
  await f.worker.discard(f.args); await assert.rejects(fs.stat(f.stage), { code: 'ENOENT' });
  assert.equal(await f.worker.resolveCompleted({ rootPath: f.rootPath, destination: first.destination }), first.destination);
  assert.equal(await fs.readFile(path.join(first.destination, 'notes.chart'), 'utf8'), '[Song]\n{}');
});

test('Companion completed-folder resolution rejects foreign paths, nested paths, junctions and unfinished installations', async t => {
  const f = await fixture(t), result = await f.worker.run(f.args), linked = path.join(f.rootPath, 'linked');
  await fs.symlink(f.outside, linked, 'junction');
  for (const destination of [f.rootPath, f.outside, f.stage, path.join(result.destination, 'audio'), linked, 'Artist - Test', path.join(f.rootPath, 'missing')]) assert.equal(await f.worker.resolveCompleted({ rootPath: f.rootPath, destination }), null);
  await fs.writeFile(path.join(result.destination, '.chartshub-companion-installing'), 'reserved');
  assert.equal(await f.worker.resolveCompleted({ rootPath: f.rootPath, destination: result.destination }), null);
});

test('Companion discard removes an owned interrupted publication but preserves a completed destination and tolerates a missing root', async t => {
  const f = await fixture(t); await pauseAfterFirst(f);
  const checkpoint = path.join(f.stage, 'checkpoint.json'), state = JSON.parse(await fs.readFile(checkpoint, 'utf8'));
  state.pending = 'Interrupted installation'; await fs.writeFile(checkpoint, JSON.stringify(state));
  const pending = path.join(f.rootPath, state.pending); await fs.mkdir(pending);
  await fs.writeFile(path.join(pending, '.chartshub-companion-installing'), JSON.stringify({ owner: 'ChartsHub Companion download v1', id }));
  await fs.writeFile(path.join(pending, 'notes.chart'), 'complete file moved before interruption');
  await f.worker.discard(f.args);
  await assert.rejects(fs.stat(pending), { code: 'ENOENT' }); await assert.rejects(fs.stat(f.stage), { code: 'ENOENT' });
  await fs.rmdir(f.rootPath); await f.worker.discard(f.args);
});

test('Companion file-body transport errors remain safe network failures and remove partial output', async t => {
  const f = await fixture(t);
  f.source.intercept = url => url === ORIGIN + endpoint ? null : new Response(new ReadableStream({ start(stream) { stream.error(Error('private upstream token and URL')); } }));
  await assert.rejects(f.worker.run(f.args), error => error.code === 'DOWNLOAD_NETWORK' && !/private|token|URL/.test(error.message));
  await assert.rejects(fs.stat(path.join(f.stage, 'active.part')), { code: 'ENOENT' });
});
