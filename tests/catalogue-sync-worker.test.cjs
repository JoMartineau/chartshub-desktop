'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createCatalogueSyncWorker, validateSyncRecord } = require('../companion/catalogue-sync-worker.cjs');

const endpoint = '/api/charts/12345678-1234-4234-8234-123456789012/ChartFolder0123456789/download-manifest';
const origin = 'https://chartshub.ca';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const id = () => crypto.randomUUID();

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-catalogue-sync-')), rootPath = path.join(base, 'Songs');
  await fs.mkdir(rootPath);
  t.after(async () => {
    assert.equal(path.dirname(base), path.resolve(os.tmpdir())); assert.ok(path.basename(base).startsWith('chartshub-catalogue-sync-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  const contents = new Map(), calls = [];
  let current = [], weak = false, hook = null;
  function setFiles(values, { withoutHashes = false, revisions = false } = {}) {
    contents.clear(); weak = withoutHashes;
    current = values.map(([name, bytes], index) => {
      const body = Buffer.from(bytes), url = endpoint.replace(/download-manifest$/, 'files/SourceFile' + String(index).padStart(10, '0'));
      contents.set(url, body);
      return { parts: name.split('/'), size: body.length, url, ...(!withoutHashes ? { sha256: hash(body) } : {}), ...(revisions ? { revision: hash(body) } : {}) };
    });
  }
  setFiles([['song.ini', '[song]\nname = Signal de test\nartist = Projet fictif\n'], ['notes.chart', '[Song]\n{}\n'], ['song.ogg', 'synthetic audio A']]);
  function manifest() {
    return { title: 'Signal de test', artist: 'Projet fictif', files: current,
      ...(!weak || current.every(file => file.revision) ? { contentRevision: hash(JSON.stringify(current.map(file => [file.parts, file.sha256 ?? file.revision]))) } : {}) };
  }
  const fetcher = async (url, options) => {
    calls.push(url); if (hook) { const intercepted = await hook(url, options); if (intercepted) return intercepted; }
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    if (url === origin + endpoint) return new Response(JSON.stringify(manifest()), { headers: { 'content-type': 'application/json' } });
    assert.equal(options.headers['X-ChartsHub-Download'], '1');
    assert.ok(contents.has(url.slice(origin.length)), 'only declared synthetic resources may be requested');
    return new Response(contents.get(url.slice(origin.length)));
  };
  const worker = createCatalogueSyncWorker({ fetcher });
  return { base, rootPath, contents, calls, worker, setFiles, manifest, setHook: value => { hook = value; }, args: { endpoint, rootPath, includeVideo: false },
    payloadCalls: () => calls.filter(url => url !== origin + endpoint) };
}

test('new charts install once with durable provenance; subsequent verification transfers no files', async t => {
  const f = await fixture(t), inspected = await f.worker.inspect(f.args);
  assert.equal(inspected.state, 'new'); const first = await f.worker.run({ ...f.args, id: id() });
  assert.equal(first.changed, true); assert.equal(first.files, 3); assert.equal(first.receivedBytes, first.totalBytes);
  assert.deepEqual(validateSyncRecord(first.record), first.record);
  assert.match(first.record.folderIdentity, /^u64:/); assert.match(first.record.rootIdentity, /^u64:/);
  assert.equal(await fs.readFile(path.join(first.destination, 'song.ogg'), 'utf8'), 'synthetic audio A');
  const before = f.calls.length;
  const same = await f.worker.inspect({ ...f.args, record: first.record, remote: { contentRevision: first.record.revision } });
  assert.equal(same.state, 'unchanged'); assert.equal(f.calls.length, before, 'unchanged remote inventory requires no per-chart HTTP request');
  const second = await f.worker.run({ ...f.args, id: id(), record: first.record });
  assert.equal(second.changed, false); assert.equal(second.receivedBytes, 0); assert.equal(f.payloadCalls().length, 3);
  assert.deepEqual((await fs.readdir(f.rootPath)).filter(name => !name.startsWith('.')), [first.folderName]);
});

test('changed charts download only changed files and retain the complete previous chart as a backup', async t => {
  const f = await fixture(t), original = await f.worker.run({ ...f.args, id: id() });
  f.setFiles([['song.ini', '[song]\nname = Signal de test\nartist = Projet fictif\n'], ['notes.chart', '[Song]\n{ updated }\n'], ['song.ogg', 'synthetic audio A']]);
  assert.equal((await f.worker.inspect({ ...f.args, record: original.record })).state, 'update');
  const before = f.payloadCalls().length, result = await f.worker.run({ ...f.args, record: original.record, id: id() });
  assert.equal(result.destination, original.destination); assert.equal(result.changed, true);
  assert.equal(f.payloadCalls().length - before, 1, 'unchanged audio and metadata are copied locally');
  assert.equal(result.receivedBytes, Buffer.byteLength('[Song]\n{ updated }\n'));
  assert.equal(await fs.readFile(path.join(result.destination, 'notes.chart'), 'utf8'), '[Song]\n{ updated }\n');
  assert.equal(await fs.readFile(path.join(result.backupPath, 'notes.chart'), 'utf8'), '[Song]\n{}\n');
  assert.equal((await f.worker.inspect({ ...f.args, record: result.record, remote: { contentRevision: result.record.revision } })).state, 'unchanged');
});

test('same-size local modifications and extra files block updates without replacing user files', async t => {
  const f = await fixture(t), first = await f.worker.run({ ...f.args, id: id() }), notes = path.join(first.destination, 'notes.chart');
  await fs.writeFile(notes, '[Song]\nXX\n');
  assert.equal((await f.worker.inspect({ ...f.args, record: first.record, remote: { contentRevision: first.record.revision } })).state, 'conflict');
  await assert.rejects(f.worker.run({ ...f.args, record: first.record, id: id() }), { code: 'SYNC_CONFLICT' });
  assert.equal(await fs.readFile(notes, 'utf8'), '[Song]\nXX\n');
  await fs.writeFile(notes, '[Song]\n{}\n'); await fs.writeFile(path.join(first.destination, 'my-notes.txt'), 'keep me');
  assert.equal((await f.worker.inspect({ ...f.args, record: first.record })).state, 'conflict');
  assert.equal(await fs.readFile(path.join(first.destination, 'my-notes.txt'), 'utf8'), 'keep me');
});

test('untracked charts are adopted only when every manifest byte matches; different charts do not get suffixed duplicates', async t => {
  const f = await fixture(t), directory = path.join(f.rootPath, 'Projet fictif - Signal de test');
  await fs.mkdir(directory);
  for (const file of f.manifest().files) await fs.writeFile(path.join(directory, ...file.parts), f.contents.get(file.url));
  const found = await f.worker.inspect(f.args);
  assert.equal(found.state, 'unchanged'); assert.equal(found.reason, 'ADOPTED_IDENTICAL'); assert.equal(f.payloadCalls().length, 0);
  await fs.writeFile(path.join(directory, 'song.ogg'), 'different audio');
  assert.equal((await f.worker.inspect(f.args)).state, 'conflict');
  await assert.rejects(f.worker.run({ ...f.args, id: id() }), { code: 'SYNC_CONFLICT' });
  assert.deepEqual((await fs.readdir(f.rootPath)).filter(name => !name.startsWith('.')), ['Projet fictif - Signal de test']);
});

test('a trusted legacy completion can adopt an exact chart at its old suffixed folder', async t => {
  const f = await fixture(t), candidateFolder = 'Projet fictif - Signal de test (2)', directory = path.join(f.rootPath, candidateFolder);
  await fs.mkdir(directory);
  for (const file of f.manifest().files) await fs.writeFile(path.join(directory, ...file.parts), f.contents.get(file.url));
  const result = await f.worker.inspect({ ...f.args, candidateFolder });
  assert.equal(result.state, 'unchanged'); assert.equal(result.record.folderName, candidateFolder);
  await assert.rejects(f.worker.inspect({ ...f.args, candidateFolder: '../outside' }), { code: 'SYNC_INVALID' });
});

test('an identical chart in a nested pack is adopted and updated at the same verified path', async t => {
  const f = await fixture(t), candidateFolder = 'Collection de test/Artiste fictif/Chart existante', directory = path.join(f.rootPath, ...candidateFolder.split('/'));
  await fs.mkdir(directory, { recursive: true });
  for (const file of f.manifest().files) await fs.writeFile(path.join(directory, ...file.parts), f.contents.get(file.url));
  const neighbor = path.join(path.dirname(directory), 'Autre chart'); await fs.mkdir(neighbor); await fs.writeFile(path.join(neighbor, 'keep.txt'), 'unselected neighboring chart');
  const adopted = await f.worker.inspect({ ...f.args, candidateFolder });
  assert.equal(adopted.reason, 'ADOPTED_IDENTICAL'); assert.equal(adopted.record.folderName, candidateFolder);
  assert.equal(adopted.record.parentIdentities.length, 2); assert.deepEqual(validateSyncRecord(adopted.record), adopted.record);
  assert.equal(f.payloadCalls().length, 0);
  assert.throws(() => validateSyncRecord({ ...adopted.record, parentIdentities: [] }), { code: 'SYNC_INVALID' });
  f.setFiles([['song.ini', '[song]\nname = Signal de test\nartist = Projet fictif\n'], ['notes.chart', '[Song]\n{ nested update }\n'], ['song.ogg', 'synthetic audio A']]);
  const updated = await f.worker.run({ ...f.args, record: adopted.record, id: id() });
  assert.equal(updated.destination, directory); assert.equal(updated.record.folderName, candidateFolder);
  assert.deepEqual(updated.record.parentIdentities, adopted.record.parentIdentities);
  assert.equal(f.payloadCalls().length, 1); assert.equal(await fs.readFile(path.join(directory, 'notes.chart'), 'utf8'), '[Song]\n{ nested update }\n');
  assert.equal(await fs.readFile(path.join(updated.backupPath, 'notes.chart'), 'utf8'), '[Song]\n{}\n');
  assert.equal(await fs.readFile(path.join(neighbor, 'keep.txt'), 'utf8'), 'unselected neighboring chart');
  assert.equal((await f.worker.inspect({ ...f.args, record: updated.record, remote: { contentRevision: updated.record.revision } })).state, 'unchanged');
  assert.equal((await f.worker.inspect({ ...f.args, candidateFolder })).state, 'unchanged');
  await fs.writeFile(path.join(directory, 'song.ogg'), 'unknown user audio');
  assert.equal((await f.worker.inspect({ ...f.args, candidateFolder })).state, 'conflict', 'title/artist and folder location never authorize adoption of differing bytes');
});

test('nested folder validation refuses traversal, hidden/reserved paths and excessive depth before filesystem adoption', async t => {
  const f = await fixture(t);
  for (const candidateFolder of ['/absolute', 'C:/outside', 'pack\\chart', 'pack/../chart', 'pack//chart', 'pack/.private/chart', 'pack/CON/chart', Array(33).fill('pack').join('/')]) {
    await assert.rejects(f.worker.inspect({ ...f.args, candidateFolder }), { code: 'SYNC_INVALID' });
  }
  assert.equal(f.payloadCalls().length, 0); assert.deepEqual(await fs.readdir(f.rootPath), []);
});

test('an ancestor replaced during nested promotion blocks publication and recovery into that replacement', async t => {
  const f = await fixture(t), candidateFolder = 'Pack de test/Chart existante', directory = path.join(f.rootPath, ...candidateFolder.split('/'));
  await fs.mkdir(directory, { recursive: true });
  for (const file of f.manifest().files) await fs.writeFile(path.join(directory, ...file.parts), f.contents.get(file.url));
  const adopted = await f.worker.inspect({ ...f.args, candidateFolder }), job = id(), parent = path.dirname(directory), moved = path.join(f.base, 'pack-moved-by-user');
  f.setFiles([['song.ini', '[song]\nname = Signal de test\nartist = Projet fictif\n'], ['notes.chart', '[Song]\n{ nested update }\n'], ['song.ogg', 'synthetic audio A']]);
  const rename = fs.rename.bind(fs); let replaced = false;
  t.mock.method(fs, 'rename', async (source, target) => {
    await rename(source, target);
    if (!replaced && source === directory && path.basename(target) === 'backup') {
      replaced = true; await rename(parent, moved); await fs.mkdir(parent); await fs.writeFile(path.join(parent, 'keep.txt'), 'replacement parent must stay untouched');
    }
  });
  await assert.rejects(f.worker.run({ ...f.args, record: adopted.record, id: job }), { code: 'SYNC_CONFLICT' });
  const stage = path.join(f.rootPath, '.chartshub-companion-' + job);
  assert.equal(await fs.readFile(path.join(stage, 'backup', 'notes.chart'), 'utf8'), '[Song]\n{}\n');
  assert.equal(await fs.readFile(path.join(parent, 'keep.txt'), 'utf8'), 'replacement parent must stay untouched');
  assert.deepEqual(await fs.readdir(parent), ['keep.txt']);
  const before = f.calls.length;
  await assert.rejects(f.worker.run({ ...f.args, record: adopted.record, id: job }), { code: 'SYNC_CONFLICT' });
  assert.equal(f.calls.length, before, 'journal recovery refuses a replaced ancestor before network work');
  assert.deepEqual(await fs.readdir(parent), ['keep.txt']);
});

test('a nested candidate behind a directory junction is never adopted or overwritten', async t => {
  const f = await fixture(t), external = path.join(f.base, 'outside-library'), chart = path.join(external, 'Chart existante'), link = path.join(f.rootPath, 'Linked pack');
  await fs.mkdir(chart, { recursive: true });
  for (const file of f.manifest().files) await fs.writeFile(path.join(chart, ...file.parts), f.contents.get(file.url));
  try { await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('directory links require the elevated synthetic-fixture check on this Windows account'); throw error; }
  const candidateFolder = 'Linked pack/Chart existante';
  assert.equal((await f.worker.inspect({ ...f.args, candidateFolder })).state, 'conflict');
  await assert.rejects(f.worker.run({ ...f.args, candidateFolder, id: id() }), { code: 'SYNC_CONFLICT' });
  assert.equal(f.payloadCalls().length, 0); assert.equal(await fs.readFile(path.join(chart, 'song.ogg'), 'utf8'), 'synthetic audio A');
});

test('a weak source inventory is rechecked, never assumed identical from file size or name', async t => {
  const f = await fixture(t), values = [['song.ini', '[song]\nname = Signal de test\n'], ['notes.chart', '[Song]\n{}'], ['song.ogg', 'synthetic audio A']];
  f.setFiles(values, { withoutHashes: true });
  const first = await f.worker.run({ ...f.args, id: id() });
  assert.equal((await f.worker.inspect({ ...f.args, record: first.record })).state, 'update');
  const before = f.payloadCalls().length, again = await f.worker.run({ ...f.args, record: first.record, id: id() });
  assert.equal(f.payloadCalls().length - before, values.length, 'without remote proof all payloads require verification');
  assert.equal(again.changed, false, 'byte comparison proves no replacement is needed');
  f.setFiles(values.map(([name, bytes]) => [name, name === 'song.ogg' ? 'synthetic audio B' : bytes]), { withoutHashes: true });
  const changed = await f.worker.run({ ...f.args, record: again.record, id: id() });
  assert.equal(changed.changed, true); assert.equal(await fs.readFile(path.join(changed.destination, 'song.ogg'), 'utf8'), 'synthetic audio B');
});

test('opaque per-file revisions permit safe reuse when the source has no public SHA-256', async t => {
  const f = await fixture(t), values = [['song.ini', '[song]\nname = Signal de test\n'], ['notes.chart', '[Song]\n{}'], ['song.ogg', 'synthetic audio A']];
  f.setFiles(values, { withoutHashes: true, revisions: true });
  const first = await f.worker.run({ ...f.args, id: id() });
  assert.equal((await f.worker.inspect({ ...f.args, record: first.record })).state, 'unchanged');
  f.setFiles(values.map(([name, bytes]) => [name, name === 'notes.chart' ? '[Song]\n{ changed }' : bytes]), { withoutHashes: true, revisions: true });
  const before = f.payloadCalls().length, next = await f.worker.run({ ...f.args, record: first.record, id: id() });
  assert.equal(next.changed, true); assert.equal(f.payloadCalls().length - before, 1);
});

test('video preference applies to new downloads and changing it updates only the video member', async t => {
  const f = await fixture(t);
  f.setFiles([['song.ini', '[song]\nname = Signal de test\n'], ['notes.chart', '[Song]\n{}'], ['song.ogg', 'synthetic audio'], ['video.mp4', 'synthetic video']]);
  const without = await f.worker.run({ ...f.args, id: id() });
  assert.equal(without.files, 3); await assert.rejects(fs.stat(path.join(without.destination, 'video.mp4')), { code: 'ENOENT' });
  assert.equal((await f.worker.inspect({ ...f.args, record: without.record, includeVideo: true, remote: { contentRevision: without.record.revision } })).state, 'update');
  const before = f.payloadCalls().length, withVideo = await f.worker.run({ ...f.args, record: without.record, includeVideo: true, id: id() });
  assert.equal(withVideo.files, 4); assert.equal(f.payloadCalls().length - before, 1); assert.equal(await fs.readFile(path.join(withVideo.destination, 'video.mp4'), 'utf8'), 'synthetic video');
});

test('pause and a new worker instance reuse only complete validated files from the owned stage', async t => {
  const f = await fixture(t), controller = new AbortController(), job = id();
  await assert.rejects(f.worker.run({ ...f.args, id: job, signal: controller.signal, onProgress: value => { if (value.completedFiles === 1) controller.abort(); } }), { code: 'ABORT_ERR' });
  assert.deepEqual((await fs.readdir(f.rootPath)).filter(name => !name.startsWith('.')), [], 'incomplete charts never appear as installed');
  const firstPayload = f.payloadCalls()[0], before = f.payloadCalls().length;
  const result = await f.worker.run({ ...f.args, id: job });
  assert.equal(result.changed, true); assert.equal(f.payloadCalls().length - before, 2);
  assert.equal(f.payloadCalls().filter(url => url === firstPayload).length, 1, 'first verified file was not downloaded again');
});

test('a failed transfer leaves the current playable chart untouched', async t => {
  const f = await fixture(t), first = await f.worker.run({ ...f.args, id: id() });
  f.setFiles([['song.ini', '[song]\nname = Signal de test\nartist = Projet fictif\n'], ['notes.chart', '[Song]\nnew notes'], ['song.ogg', 'synthetic audio A']]);
  f.setHook(url => url.includes('/files/') ? new Response('failed', { status: 503 }) : null);
  await assert.rejects(f.worker.run({ ...f.args, record: first.record, id: id() }), { code: 'SYNC_HTTP' });
  assert.equal(await fs.readFile(path.join(first.destination, 'notes.chart'), 'utf8'), '[Song]\n{}\n');
  assert.equal(await fs.readFile(path.join(first.destination, 'song.ogg'), 'utf8'), 'synthetic audio A');
});

test('a publication rename failure restores the verified backup and the prepared update can be retried', async t => {
  const f = await fixture(t), first = await f.worker.run({ ...f.args, id: id() }), job = id();
  f.setFiles([['song.ini', '[song]\nname = Signal de test\nartist = Projet fictif\n'], ['notes.chart', '[Song]\nnew notes'], ['song.ogg', 'synthetic audio A']]);
  const originalRename = fs.rename.bind(fs); let failOnce = true;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (failOnce && path.basename(source) === 'ready' && target === first.destination) { failOnce = false; throw Object.assign(Error('simulated sharing violation'), { code: 'EACCES' }); }
    return originalRename(source, target);
  });
  await assert.rejects(f.worker.run({ ...f.args, record: first.record, id: job }), { code: 'SYNC_IO' });
  assert.equal(await fs.readFile(path.join(first.destination, 'notes.chart'), 'utf8'), '[Song]\n{}\n');
  const before = f.payloadCalls().length, retry = await f.worker.run({ ...f.args, record: first.record, id: job });
  assert.equal(retry.changed, true); assert.equal(f.payloadCalls().length, before, 'verified prepared files are retained');
});

test('restart recovers a journal interrupted after backup rename without fetching or duplicating the chart', async t => {
  const f = await fixture(t), first = await f.worker.run({ ...f.args, id: id() }), job = id();
  f.setFiles([['song.ini', '[song]\nname = Signal de test\nartist = Projet fictif\n'], ['notes.chart', '[Song]\nnew notes'], ['song.ogg', 'synthetic audio A']]);
  const updated = await f.worker.run({ ...f.args, record: first.record, id: job });
  const directory = path.join(f.rootPath, '.chartshub-companion-' + job), stateFile = path.join(directory, 'checkpoint.json'), state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  await fs.rename(updated.destination, path.join(directory, 'ready'));
  await fs.writeFile(path.join(directory, 'ready', '.chartshub-companion-installing'), JSON.stringify({ owner: 'ChartsHub catalogue synchronization v1', id: job, endpoint }));
  state.transaction.phase = 'backed-up'; await fs.writeFile(stateFile, JSON.stringify(state));
  f.setHook(() => { throw Error('network must not be used during journal recovery'); });
  const count = f.calls.length, recovered = await f.worker.run({ ...f.args, record: first.record, id: job });
  assert.equal(f.calls.length, count); assert.equal(recovered.destination, updated.destination);
  assert.equal(await fs.readFile(path.join(recovered.destination, 'notes.chart'), 'utf8'), '[Song]\nnew notes');
  assert.equal(await fs.readFile(path.join(recovered.backupPath, 'notes.chart'), 'utf8'), '[Song]\n{}\n');
});

test('root/folder replacement and malformed provenance cannot authorize an update', async t => {
  const f = await fixture(t), first = await f.worker.run({ ...f.args, id: id() });
  for (const patch of [{ folderName: '../escape' }, { folderIdentity: '7:8' }, { rootIdentity: 'u64:7:-1' }, { revision: 'unknown' }, { files: [{ ...first.record.files[0], parts: ['..', 'escape'] }] }]) assert.throws(() => validateSyncRecord({ ...first.record, ...patch }), { code: 'SYNC_INVALID' });
  await fs.rename(first.destination, first.destination + '-original'); await fs.mkdir(first.destination); await fs.writeFile(path.join(first.destination, 'keep.txt'), 'replacement directory');
  assert.equal((await f.worker.inspect({ ...f.args, record: first.record })).state, 'conflict');
  await assert.rejects(f.worker.run({ ...f.args, record: first.record, id: id() }), { code: 'SYNC_CONFLICT' });
  assert.equal(await fs.readFile(path.join(first.destination, 'keep.txt'), 'utf8'), 'replacement directory');
});

test('out-of-scope URLs, oversized manifests and bad hashes are rejected before publication', async t => {
  const f = await fixture(t);
  await assert.rejects(f.worker.run({ ...f.args, endpoint: 'https://example.test/manifest', id: id() }), { code: 'SYNC_INVALID' });
  f.setHook(url => url === origin + endpoint ? new Response(JSON.stringify({ ...f.manifest(), files: [{ ...f.manifest().files[0], url: '/outside/file' }] }), { headers: { 'content-type': 'application/json' } }) : null);
  await assert.rejects(f.worker.run({ ...f.args, id: id() }), { code: 'SYNC_INVALID' });
  f.setHook(url => url.includes('/files/') ? new Response('corrupt payload') : null);
  await assert.rejects(f.worker.run({ ...f.args, id: id() }), { code: 'SYNC_INTEGRITY' });
  assert.deepEqual((await fs.readdir(f.rootPath)).filter(name => !name.startsWith('.')), []);
});

test('an unchanged inventory performs no file-content reads and a removed chart is safely classified as missing', async t => {
  const f = await fixture(t), first = await f.worker.run({ ...f.args, id: id() }), originalOpen = fs.open.bind(fs), opened = [];
  t.mock.method(fs, 'open', async (...args) => { opened.push(args[0]); return originalOpen(...args); });
  const found = await f.worker.inspect({ ...f.args, record: first.record, remote: { contentRevision: first.record.revision } });
  assert.equal(found.state, 'unchanged'); assert.deepEqual(opened, [], 'large unchanged payloads are not hashed at every synchronization');
  const moved = path.join(f.base, 'manually-moved-chart'); await fs.rename(first.destination, moved);
  const absent = await f.worker.inspect({ ...f.args, record: first.record, remote: { contentRevision: first.record.revision } });
  assert.equal(absent.state, 'new'); assert.equal(absent.reason, 'LOCAL_MISSING'); assert.equal(absent.record, null);
  assert.equal(await fs.readFile(path.join(moved, 'song.ogg'), 'utf8'), 'synthetic audio A');
});

test('a source video change outside the chosen policy updates provenance without copying or downloading audio', async t => {
  const f = await fixture(t), values = [['song.ini', '[song]\nname = Signal de test\n'], ['notes.chart', '[Song]\n{}'], ['song.ogg', 'synthetic audio'], ['video.mp4', 'synthetic video A']];
  f.setFiles(values); const first = await f.worker.run({ ...f.args, id: id() });
  f.setFiles(values.map(([name, bytes]) => [name, name === 'video.mp4' ? 'synthetic video B' : bytes]));
  const beforePayloads = f.payloadCalls().length, inspected = await f.worker.inspect({ ...f.args, record: first.record });
  assert.equal(inspected.state, 'unchanged'); assert.notEqual(inspected.record.revision, first.record.revision);
  const result = await f.worker.run({ ...f.args, record: first.record, id: id() });
  assert.equal(result.changed, false); assert.equal(result.record.folderIdentity, first.record.folderIdentity);
  assert.equal(f.payloadCalls().length, beforePayloads);
});

test('changing a paused manifest prunes only owned obsolete files and resumes nested paths', async t => {
  const f = await fixture(t), controller = new AbortController(), job = id();
  f.setFiles([['old/song.ini', '[song]\nname = Signal de test\n'], ['notes.chart', '[Song]\n{}'], ['song.ogg', 'synthetic audio']]);
  await assert.rejects(f.worker.run({ ...f.args, id: job, signal: controller.signal, onProgress: value => { if (value.completedFiles === 1) controller.abort(); } }), { code: 'ABORT_ERR' });
  f.setFiles([['new/song.ini', '[song]\nname = Signal de test\n'], ['notes.chart', '[Song]\n{}'], ['song.ogg', 'synthetic audio']]);
  const result = await f.worker.run({ ...f.args, id: job });
  assert.equal(await fs.readFile(path.join(result.destination, 'new', 'song.ini'), 'utf8'), '[song]\nname = Signal de test\n');
  await assert.rejects(fs.stat(path.join(result.destination, 'old')), { code: 'ENOENT' });
});

test('manifest timeouts and rate limits remain explicit and do not create chart folders', async t => {
  const f = await fixture(t);
  const hung = createCatalogueSyncWorker({ fetcher: () => new Promise(() => {}), manifestTimeoutMs: 15 });
  await assert.rejects(hung.inspect(f.args), { code: 'SYNC_TIMEOUT' });
  const limited = createCatalogueSyncWorker({ fetcher: async () => new Response('slow down', { status: 429 }) });
  await assert.rejects(limited.run({ ...f.args, id: id() }), { code: 'SYNC_RATE_LIMITED' });
  assert.deepEqual(await fs.readdir(f.rootPath), []);
});

test('insufficient disk space is rejected before transferring files', async t => {
  const f = await fixture(t);
  if (typeof fs.statfs !== 'function') return t.skip('statfs unavailable');
  t.mock.method(fs, 'statfs', async () => ({ bavail: 0n, bsize: 4096n }));
  await assert.rejects(f.worker.run({ ...f.args, id: id() }), { code: 'ENOSPC' });
  assert.equal(f.payloadCalls().length, 0); assert.deepEqual(await fs.readdir(f.rootPath), []);
});

test('finalization after a durable receipt removes only the empty metadata stage of a new installation', async t => {
  const f = await fixture(t), job = id(), result = await f.worker.run({ ...f.args, id: job }), directory = path.join(f.rootPath, '.chartshub-companion-' + job);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['checkpoint.json', 'owner.json']);
  assert.deepEqual(await f.worker.finalize({ ...f.args, id: job, record: result.record }), { cleaned: true });
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(result.destination, 'song.ogg'), 'utf8'), 'synthetic audio A');
  assert.equal((await f.worker.inspect({ ...f.args, record: result.record, remote: { contentRevision: result.record.revision } })).state, 'unchanged');
  assert.deepEqual(await f.worker.finalize({ ...f.args, id: job, record: result.record }), { cleaned: false, reason: 'NO_STAGE' });
});

test('finalization preserves old-chart backups and every unknown or incomplete stage entry', async t => {
  const f = await fixture(t), initialId = id(), first = await f.worker.run({ ...f.args, id: initialId }), initialStage = path.join(f.rootPath, '.chartshub-companion-' + initialId);
  await fs.writeFile(path.join(initialStage, 'keep-user-data.txt'), 'must remain');
  assert.deepEqual(await f.worker.finalize({ ...f.args, id: initialId, record: first.record }), { cleaned: false, reason: 'EXTRA_FILES' });
  assert.equal(await fs.readFile(path.join(initialStage, 'keep-user-data.txt'), 'utf8'), 'must remain');
  assert.ok((await fs.readdir(initialStage)).includes('owner.json'));
  f.setFiles([['song.ini', '[song]\nname = Signal de test\nartist = Projet fictif\n'], ['notes.chart', '[Song]\n{ updated }'], ['song.ogg', 'synthetic audio A']]);
  const updateId = id(), update = await f.worker.run({ ...f.args, id: updateId, record: first.record });
  assert.deepEqual(await f.worker.finalize({ ...f.args, id: updateId, record: update.record }), { cleaned: false, reason: 'BACKUP_PRESERVED' });
  assert.equal(await fs.readFile(path.join(update.backupPath, 'notes.chart'), 'utf8'), '[Song]\n{}\n');
  const pausedId = id(), controller = new AbortController();
  f.setFiles([['song.ini', '[song]\nname = Changed\n'], ['notes.chart', '[Song]\n{ later }'], ['song.ogg', 'synthetic audio A']]);
  await assert.rejects(f.worker.run({ ...f.args, id: pausedId, record: update.record, signal: controller.signal,
    onProgress: progress => { if (progress.completedFiles === 1) controller.abort(); } }), { code: 'ABORT_ERR' });
  assert.deepEqual(await f.worker.finalize({ ...f.args, id: pausedId, record: update.record }), { cleaned: false, reason: 'INCOMPLETE' });
  assert.ok((await fs.readdir(path.join(f.rootPath, '.chartshub-companion-' + pausedId))).includes('ready'));
});

test('finalization refuses a stale receipt, changed installed files and a forged owner without deleting metadata', async t => {
  const f = await fixture(t), job = id(), result = await f.worker.run({ ...f.args, id: job }), directory = path.join(f.rootPath, '.chartshub-companion-' + job);
  await assert.rejects(f.worker.finalize({ ...f.args, id: job, record: { ...result.record, revision: hash('another revision') } }), { code: 'SYNC_CONFLICT' });
  await fs.writeFile(path.join(result.destination, 'notes.chart'), '[Song]\n{ user edit }');
  await assert.rejects(f.worker.finalize({ ...f.args, id: job, record: result.record }), { code: 'SYNC_CONFLICT' });
  assert.deepEqual((await fs.readdir(directory)).sort(), ['checkpoint.json', 'owner.json']);
  await fs.writeFile(path.join(directory, 'owner.json'), JSON.stringify({ owner: 'another application' }));
  await assert.rejects(f.worker.finalize({ ...f.args, id: job, record: result.record }), { code: 'SYNC_CONFLICT' });
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8')).owner, 'another application');
});

test('repeated weak-source verification reclaims only its owned identical copies and recovers without another transfer', async t => {
  const f = await fixture(t), values = [['song.ini', '[song]\nname = Signal de test\n'], ['notes.chart', '[Song]\n{}'], ['song.ogg', 'synthetic audio A']];
  f.setFiles(values, { withoutHashes: true });
  let job = id(), result = await f.worker.run({ ...f.args, id: job });
  await f.worker.finalize({ ...f.args, id: job, record: result.record });
  for (let attempt = 0; attempt < 2; attempt++) {
    job = id(); result = await f.worker.run({ ...f.args, id: job, record: result.record });
    assert.equal(result.changed, false); assert.ok(result.receivedBytes > 0, 'a weak source requires byte verification');
    const stage = path.join(f.rootPath, '.chartshub-companion-' + job);
    assert.equal(JSON.parse(await fs.readFile(path.join(stage, 'checkpoint.json'), 'utf8')).transaction.phase, 'verified-unchanged');
    if (attempt === 0) {
      const unlink = fs.unlink.bind(fs); let interrupt = true;
      t.mock.method(fs, 'unlink', async target => {
        await unlink(target);
        if (interrupt && target === path.join(stage, 'ready', 'song.ini')) { interrupt = false; throw Object.assign(Error('interrupted owned-copy cleanup'), { code: 'EACCES' }); }
      });
      await assert.rejects(f.worker.finalize({ ...f.args, id: job, record: result.record }), { code: 'SYNC_IO' });
      assert.equal(await fs.readFile(path.join(result.destination, 'song.ini'), 'utf8'), values[0][1]);
    }
    const before = f.calls.length; f.setHook(() => { throw Error('verified receipt recovery must not download again'); });
    result = await f.worker.run({ ...f.args, id: job, record: result.record });
    assert.equal(result.changed, false); assert.equal(f.calls.length, before); f.setHook(null);
    assert.deepEqual(await f.worker.finalize({ ...f.args, id: job, record: result.record }), { cleaned: true });
    assert.deepEqual(await fs.readdir(f.rootPath), [result.folderName], 'no full identical copies or metadata stages accumulate');
    assert.equal(await fs.readFile(path.join(result.destination, 'song.ogg'), 'utf8'), 'synthetic audio A');
  }
});

test('an interruption while deleting detached metadata does not block receipt-based resume or remove the chart', async t => {
  const f = await fixture(t), job = id(), result = await f.worker.run({ ...f.args, id: job }), directory = path.join(f.rootPath, '.chartshub-companion-' + job), retired = directory + '-finalized';
  const unlink = fs.unlink.bind(fs); let interrupt = true;
  t.mock.method(fs, 'unlink', async target => {
    await unlink(target);
    if (interrupt && target === path.join(retired, 'checkpoint.json')) { interrupt = false; throw Object.assign(Error('interrupted metadata cleanup'), { code: 'EACCES' }); }
  });
  await assert.rejects(f.worker.finalize({ ...f.args, id: job, record: result.record }), { code: 'SYNC_IO' });
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(retired), ['owner.json']);
  const before = f.payloadCalls().length, resumed = await f.worker.run({ ...f.args, id: job, record: result.record });
  assert.equal(resumed.changed, false); assert.equal(f.payloadCalls().length, before);
  assert.equal(await fs.readFile(path.join(resumed.destination, 'song.ogg'), 'utf8'), 'synthetic audio A');
});

test('an unexpected file in a weak verified copy blocks its entire cleanup and preserves the installed chart', async t => {
  const f = await fixture(t), values = [['song.ini', '[song]\nname = Signal de test\n'], ['notes.chart', '[Song]\n{}'], ['song.ogg', 'synthetic audio A']];
  f.setFiles(values, { withoutHashes: true });
  const first = await f.worker.run({ ...f.args, id: id() }), job = id(), unchanged = await f.worker.run({ ...f.args, id: job, record: first.record });
  const stage = path.join(f.rootPath, '.chartshub-companion-' + job), ready = path.join(stage, 'ready');
  await fs.writeFile(path.join(ready, 'unrecognized-user-file.txt'), 'keep this file and the whole stage');
  await assert.rejects(f.worker.finalize({ ...f.args, id: job, record: unchanged.record }), { code: 'SYNC_CONFLICT' });
  for (const [name, bytes] of [...values, ['unrecognized-user-file.txt', 'keep this file and the whole stage']]) assert.equal(await fs.readFile(path.join(ready, name), 'utf8'), bytes);
  assert.ok((await fs.readdir(stage)).includes('owner.json'));
  assert.equal(await fs.readFile(path.join(first.destination, 'song.ogg'), 'utf8'), 'synthetic audio A');
});

test('restart reads its valid deep1000-file journal above the old3MB limit without fetching or losing the backup', async t => {
  const { identity } = require('../companion/download-worker.cjs');
  const f = await fixture(t), job = id(), first = await f.worker.run({ ...f.args, id: job }), directory = path.join(f.rootPath, '.chartshub-companion-' + job), backup = path.join(directory, 'backup');
  await fs.rename(first.destination, backup); await fs.mkdir(first.destination);
  const files = [], previousFiles = [], stats = stat => Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink'].map(key => [key, String(stat[key])]));
  for (const file of first.record.files) {
    const target = path.join(first.destination, ...file.parts); await fs.copyFile(path.join(backup, ...file.parts), target);
    files.push({ ...file, stamp: stats(await fs.lstat(target, { bigint: true })) });
    previousFiles.push({ ...file, stamp: stats(await fs.lstat(path.join(backup, ...file.parts), { bigint: true })) });
  }
  // macOS PATH_MAX is 1024 bytes, including the temporary root. Use ASCII paths
  // well below that bound and real previous/next 1000-file receipts to exercise
  // the large checkpoint, rather than exceeding native filesystem limits.
  const parents = Array.from({ length: 5 }, (_, index) => 'p'.repeat(109) + index), filename = index => 'f'.repeat(170) + String(index).padStart(4, '0') + '.txt';
  const longestPaths = [first.destination, backup].map(folder => Buffer.byteLength(path.join(folder, ...parents, filename(996))));
  if (process.platform === 'darwin') assert.ok(longestPaths.every(length => length < 1024), 'the actual disposable fixture paths must fit macOS PATH_MAX');
  await fs.mkdir(path.join(first.destination, ...parents), { recursive: true }); await fs.mkdir(path.join(backup, ...parents), { recursive: true });
  for (let index = 0; index < 997; index++) {
    const parts = [...parents, filename(index)], target = path.join(first.destination, ...parts), oldTarget = path.join(backup, ...parts);
    await fs.writeFile(target, ''); await fs.writeFile(oldTarget, '');
    const descriptor = { parts, size: 0, sha256: hash(''), remoteSignature: hash('deep' + index) };
    files.push({ ...descriptor, stamp: stats(await fs.lstat(target, { bigint: true })) });
    previousFiles.push({ ...descriptor, stamp: stats(await fs.lstat(oldTarget, { bigint: true })) });
  }
  const previousRecord = validateSyncRecord({ ...first.record, revision: hash('previous deep revision'), files: previousFiles });
  const record = validateSyncRecord({ ...first.record, folderIdentity: identity(await fs.lstat(first.destination, { bigint: true })), revision: hash('deep revision'), files });
  const statePath = path.join(directory, 'checkpoint.json'), state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.files = Object.fromEntries(files.map(file => [hash(JSON.stringify(file.parts)), { parts: file.parts, size: file.size, sha256: file.sha256, remoteSignature: file.remoteSignature }]));
  state.transaction = { phase: 'complete', folderName: first.folderName, previousIdentity: previousRecord.folderIdentity, nextIdentity: record.folderIdentity, previousRecord, record };
  const checkpoint = JSON.stringify(state); assert.ok(Buffer.byteLength(checkpoint) > 3000000); assert.ok(Buffer.byteLength(checkpoint) < 16 * 1024 * 1024);
  await fs.writeFile(statePath, checkpoint); const before = f.calls.length; f.setHook(() => { throw Error('recovery must not access network'); });
  const recovered = await f.worker.run({ ...f.args, id: job, record });
  assert.equal(f.calls.length, before); assert.equal(recovered.files, 1000); assert.equal(recovered.destination, first.destination);
  assert.equal(await fs.readFile(path.join(recovered.backupPath, 'song.ogg'), 'utf8'), 'synthetic audio A');
  assert.deepEqual(await f.worker.finalize({ ...f.args, id: job, record: recovered.record }), { cleaned: false, reason: 'BACKUP_PRESERVED' });
});
