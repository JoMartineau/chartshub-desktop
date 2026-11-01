'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDownloadWorker, identity, matchesIdentity, rootContext, readJsonFile } = require('../companion/download-worker.cjs');
const { createCatalogueDownloadWorker } = require('../companion/catalogue-download-worker.cjs');

const id = '11111111-2222-4333-8444-555555555555';
const endpoint = '/api/charts/12345678-1234-1234-1234-123456789012/SongFolderabcdefghij/download-manifest';
const highA = 1152921504606846977n, highB = highA + 1n;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pathname = value => path.resolve(value).toLowerCase();

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-exact-identity-'));
  const rootPath = path.join(base, 'exports'); await fs.mkdir(rootPath);
  // Emulate real uint64 NTFS references, returning the rounded value only to
  // callers that explicitly ask Node for its default Number-valued stats.
  const original = fs.lstat.bind(fs), overrides = new Map();
  t.mock.method(fs, 'lstat', async (target, options) => {
    const stat = await original(target, options), replacement = overrides.get(pathname(target));
    if (replacement) {
      assert.equal(stat.isDirectory(), true, 'only directory identities are synthetic');
      stat.dev = options?.bigint ? replacement.dev : Number(replacement.dev);
      stat.ino = options?.bigint ? replacement.ino : Number(replacement.ino);
    }
    return stat;
  });
  const setIdentity = (target, ino, dev = 7n) => overrides.set(pathname(target), { dev, ino });
  setIdentity(rootPath, 123n);
  t.after(async () => {
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('chartshub-exact-identity-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  const stage = path.join(rootPath, '.chartshub-companion-' + id);
  return { rootPath, stage, setIdentity, args: { id, endpoint, rootPath } };
}

async function externalFixture(t, rootIno = 123n, folderIno = 456n) {
  const f = await fixture(t); f.setIdentity(f.rootPath, rootIno);
  f.args.endpoint = 'enchor:0123456789abcdef0123456789abcdef';
  f.args.title = 'Song'; f.args.artist = 'Band';
  const destination = path.join(f.rootPath, 'Band - Song'); f.setIdentity(destination, folderIno);
  let transfers = 0;
  const worker = createCatalogueDownloadWorker({
    fetcher: async () => { throw Error('No network permitted in the identity fixture'); },
    downloadExternal: async ({ directory }) => {
      transfers++;
      const prepared = path.join(directory, 'prepared'); await fs.mkdir(prepared);
      await fs.writeFile(path.join(prepared, 'notes.chart'), '[Song]\n{}');
      await fs.writeFile(path.join(prepared, 'song.ini'), '[song]\nname = Song\n');
      return { destination: prepared };
    }
  });
  const published = await worker.run(f.args);
  return { ...f, worker, published, transfers: () => transfers, ownerFile: path.join(f.stage, 'owner.json'), receiptFile: path.join(f.stage, 'receipt.json') };
}
async function rewriteJson(filename, update) {
  const value = JSON.parse(await fs.readFile(filename, 'utf8')); update(value);
  const bytes = Buffer.from(JSON.stringify(value)); await fs.writeFile(filename, bytes); return bytes;
}

function nativeData() {
  const content = new Map();
  const files = [['song.ini', '[song]\nname = Song\n'], ['notes.chart', '[Song]\n{}'], ['song.ogg', 'synthetic audio']].map(([name, value], index) => {
    const bytes = Buffer.from(value), url = endpoint.replace('download-manifest', 'files/FileNumber' + String(index).padStart(10, '0'));
    content.set(url, bytes); return { parts: [name], size: bytes.length, sha256: hash(bytes), url };
  });
  return { content, manifest: { title: 'Song', artist: 'Band', files } };
}
async function pausedNativeFixture(t, rootIno = 123n) {
  const f = await fixture(t); f.setIdentity(f.rootPath, rootIno);
  const data = nativeData(), controller = new AbortController(), calls = [];
  let pausing = true;
  const fetcher = async url => {
    calls.push(url);
    if (url === 'https://chartshub.ca' + endpoint) return new Response(JSON.stringify(data.manifest), { headers: { 'content-type': 'application/json' } });
    const resource = url.slice('https://chartshub.ca'.length);
    if (pausing && resource === data.manifest.files[1].url) { controller.abort(); return new Promise(() => {}); }
    assert.ok(data.content.has(resource), 'only synthetic manifest members are requested');
    return new Response(data.content.get(resource));
  };
  const worker = createDownloadWorker({ fetcher });
  await assert.rejects(worker.run({ ...f.args, signal: controller.signal }), { code: 'ABORT_ERR' });
  pausing = false;
  const ownerFile = path.join(f.stage, 'owner.json'), checkpointFile = path.join(f.stage, 'checkpoint.json');
  const blobs = await fs.readdir(path.join(f.stage, 'files')); assert.equal(blobs.length, 1);
  return { ...f, worker, calls, data, ownerFile, checkpointFile, blob: path.join(f.stage, 'files', blobs[0]) };
}

test('filesystem identities preserve distinct uint64 references and never serialize raw BigInts', () => {
  assert.equal(Number(highA), Number(highB), 'this pair collides in default Node Number stats');
  const a = identity({ dev: 7n, ino: highA }), b = identity({ dev: 7n, ino: highB });
  assert.notEqual(a, b); assert.equal(a, 'u64:7:1152921504606846977');
  assert.deepEqual(JSON.parse(JSON.stringify({ rootIdentity: a })), { rootIdentity: a });
  assert.throws(() => identity({ dev: 7, ino: Number(highA) }), { code: 'DOWNLOAD_PATH' });
});

test('legacy identities match only unambiguous decimal safe integers, without upgrading rounded values', () => {
  assert.equal(matchesIdentity('7:456', identity({ dev: 7n, ino: 456n })), true);
  assert.equal(matchesIdentity(`7:${Number.MAX_SAFE_INTEGER}`, identity({ dev: 7n, ino: BigInt(Number.MAX_SAFE_INTEGER) })), true);
  assert.equal(matchesIdentity(identity({ dev: 7n, ino: highA }), identity({ dev: 7n, ino: highA })), true);
  assert.equal(matchesIdentity(`7:${2n ** 53n}`, identity({ dev: 7n, ino: 2n ** 53n })), false, 'an exactly representable unsafe old Number can also stand for a rounded neighbour');
  for (const old of [`7:${highA}`, `7:${Number(highA)}`, `7:${2n ** 53n}`, '07:456', '7:0456', '7:-1', '7:4e2', 'future:7:456', '', null]) {
    assert.equal(matchesIdentity(old, identity({ dev: 7n, ino: highA })), false, String(old));
  }
  assert.equal(matchesIdentity('7:456', identity({ dev: 7n, ino: 457n })), false);
});

test('root guards reject distinct directories even when their Number identities collide', async t => {
  const f = await fixture(t); f.setIdentity(f.rootPath, highA);
  const context = await rootContext(f.rootPath), previous = f.rootPath + '-previous';
  await fs.rename(f.rootPath, previous); await fs.mkdir(f.rootPath); f.setIdentity(f.rootPath, highB);
  await fs.writeFile(path.join(previous, 'old.txt'), 'original'); await fs.writeFile(path.join(f.rootPath, 'keep.txt'), 'replacement');
  await assert.rejects(context.guard(), { code: 'DOWNLOAD_PATH' });
  assert.equal(await fs.readFile(path.join(previous, 'old.txt'), 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(f.rootPath, 'keep.txt'), 'utf8'), 'replacement');
});

test('external run and discard reject rounded folder collisions and preserve receipts and both directories', async t => {
  const f = await externalFixture(t, 123n, highA), previous = f.published.destination + '-previous';
  const owner = await fs.readFile(f.ownerFile), receipt = await fs.readFile(f.receiptFile);
  await fs.rename(f.published.destination, previous); await fs.mkdir(f.published.destination); f.setIdentity(f.published.destination, highB);
  await fs.writeFile(path.join(f.published.destination, 'keep.txt'), 'replacement');
  await assert.rejects(f.worker.run(f.args), { code: 'DOWNLOAD_PATH' });
  await assert.rejects(f.worker.discard(f.args), { code: 'DOWNLOAD_PATH' });
  assert.deepEqual(await fs.readFile(f.ownerFile), owner); assert.deepEqual(await fs.readFile(f.receiptFile), receipt);
  assert.equal(f.transfers(), 1); assert.equal(await fs.readFile(path.join(previous, 'notes.chart'), 'utf8'), '[Song]\n{}');
  assert.deepEqual(await fs.readdir(f.published.destination), ['keep.txt']);
});

test('new tagged high identities recover an external completion and discard only its receipt', async t => {
  const f = await externalFixture(t, highA, highB), owner = await fs.readFile(f.ownerFile), receipt = await fs.readFile(f.receiptFile);
  assert.equal(JSON.parse(owner).rootIdentity, identity({ dev: 7n, ino: highA }));
  assert.equal(JSON.parse(receipt).folderIdentity, identity({ dev: 7n, ino: highB }));
  assert.equal((await f.worker.run(f.args)).destination, f.published.destination); assert.equal(f.transfers(), 1);
  assert.deepEqual(await fs.readFile(f.ownerFile), owner); assert.deepEqual(await fs.readFile(f.receiptFile), receipt);
  await f.worker.discard(f.args); await assert.rejects(fs.stat(f.stage), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.published.destination, 'notes.chart'), 'utf8'), '[Song]\n{}');
});

test('safe legacy external root and folder receipts recover byte-unchanged, then discard only the stage', async t => {
  const f = await externalFixture(t);
  const owner = await rewriteJson(f.ownerFile, value => { value.rootIdentity = '7:123'; });
  const receipt = await rewriteJson(f.receiptFile, value => { value.folderIdentity = '7:456'; });
  assert.equal((await f.worker.run(f.args)).destination, f.published.destination); assert.equal(f.transfers(), 1);
  assert.deepEqual(await fs.readFile(f.ownerFile), owner); assert.deepEqual(await fs.readFile(f.receiptFile), receipt);
  await f.worker.discard(f.args); await assert.rejects(fs.stat(f.stage), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.published.destination, 'notes.chart'), 'utf8'), '[Song]\n{}');
});

for (const field of ['root', 'folder']) test(`ambiguous legacy external ${field} identity refuses recovery and cleanup without rewriting data`, async t => {
  const f = await externalFixture(t, field === 'root' ? highA : 123n, field === 'folder' ? highA : 456n);
  await rewriteJson(field === 'root' ? f.ownerFile : f.receiptFile, value => { value[field === 'root' ? 'rootIdentity' : 'folderIdentity'] = '7:' + Number(highA); });
  const owner = await fs.readFile(f.ownerFile), receipt = await fs.readFile(f.receiptFile);
  await assert.rejects(f.worker.run(f.args), { code: 'DOWNLOAD_PATH' });
  await assert.rejects(f.worker.discard(f.args), { code: 'DOWNLOAD_PATH' });
  assert.deepEqual(await fs.readFile(f.ownerFile), owner); assert.deepEqual(await fs.readFile(f.receiptFile), receipt);
  assert.equal(f.transfers(), 1); assert.equal(await fs.readFile(path.join(f.published.destination, 'notes.chart'), 'utf8'), '[Song]\n{}');
  assert.equal(await f.worker.resolveCompleted({ rootPath: f.rootPath, destination: f.published.destination }), f.published.destination, 'history can still resolve a completed folder independently of a refused staging receipt');
});

test('safe legacy native owner resumes verified partial bytes and never rewrites the owner', async t => {
  const f = await pausedNativeFixture(t);
  const owner = await rewriteJson(f.ownerFile, value => { value.rootIdentity = '7:123'; });
  const before = f.calls.length, published = await f.worker.run(f.args);
  assert.equal(f.calls.slice(before).includes('https://chartshub.ca' + f.data.manifest.files[0].url), false, 'verified bytes are reused');
  assert.deepEqual(await fs.readFile(f.ownerFile), owner);
  await f.worker.discard(f.args); await assert.rejects(fs.stat(f.stage), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(published.destination, 'notes.chart'), 'utf8'), '[Song]\n{}');
});

test('ambiguous legacy native owner refuses resume and discard while preserving partial bytes and checkpoint', async t => {
  const f = await pausedNativeFixture(t, highA);
  const owner = await rewriteJson(f.ownerFile, value => { value.rootIdentity = '7:' + Number(highA); });
  const checkpoint = await fs.readFile(f.checkpointFile), blob = await fs.readFile(f.blob);
  await assert.rejects(f.worker.run(f.args), { code: 'DOWNLOAD_PATH' });
  await assert.rejects(f.worker.discard(f.args), { code: 'DOWNLOAD_PATH' });
  assert.deepEqual(await fs.readFile(f.ownerFile), owner); assert.deepEqual(await fs.readFile(f.checkpointFile), checkpoint); assert.deepEqual(await fs.readFile(f.blob), blob);
  assert.deepEqual((await fs.readdir(f.rootPath)).filter(name => !name.startsWith('.')), []);
});

test('new tagged high native root resumes existing partial data and retains its exact receipt', async t => {
  const f = await pausedNativeFixture(t, highA), owner = await fs.readFile(f.ownerFile);
  assert.equal(JSON.parse(owner).rootIdentity, identity({ dev: 7n, ino: highA }));
  const published = await f.worker.run(f.args); assert.deepEqual(await fs.readFile(f.ownerFile), owner);
  await f.worker.discard(f.args); assert.equal(await fs.readFile(path.join(published.destination, 'notes.chart'), 'utf8'), '[Song]\n{}');
});

test('JSON handle identity checks reject Number-colliding replacement files before reading their content', async t => {
  const f = await fixture(t), filename = path.join(f.rootPath, 'receipt.json'); await fs.writeFile(filename, '{"private":"fixture"}');
  const context = await rootContext(f.rootPath), checked = context.checked;
  context.checked = async (...args) => { const stat = await checked(...args); if (args[0] === filename) stat.ino = highA; return stat; };
  const originalOpen = fs.open.bind(fs); let read = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args), originalStat = handle.stat.bind(handle), originalRead = handle.read.bind(handle);
    handle.stat = async options => { const stat = await originalStat(options); stat.ino = options?.bigint ? highB : Number(highB); return stat; };
    handle.read = async (...readArgs) => { read = true; return originalRead(...readArgs); }; return handle;
  });
  await assert.rejects(readJsonFile(context, filename), { code: 'DOWNLOAD_PATH' }); assert.equal(read, false);
});
