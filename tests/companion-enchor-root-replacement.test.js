'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { createCatalogueDownloadWorker } = require('../companion/catalogue-download-worker.cjs');
const { downloadEnchor } = require('../enchor-download.js');
const id = '11111111-2222-4333-8444-555555555555', md5 = '0123456789abcdef0123456789abcdef';

// A complete but tiny synthetic container: no provider or real music is read.
function sng() {
  const metadata = [['name', 'Song'], ['artist', 'Band']].map(pair => pair.map(value => Buffer.from(value)));
  const files = [['notes.chart', '[Song]\n{}'], ['song.ogg', 'synthetic audio']].map(([name, value]) => ({ name: Buffer.from(name), data: Buffer.from(value) }));
  const metaLength = 8 + metadata.reduce((sum, pair) => sum + 8 + pair[0].length + pair[1].length, 0);
  const indexLength = 8 + files.reduce((sum, file) => sum + 17 + file.name.length, 0), start = 26 + 8 + metaLength + 8 + indexLength + 8;
  const header = Buffer.alloc(start), mask = Buffer.from('0123456789abcdef'); let position = 0;
  const bytes = value => { value.copy(header, position); position += value.length; };
  const u32 = value => { header.writeUInt32LE(value, position); position += 4; }, u64 = value => { header.writeBigUInt64LE(BigInt(value), position); position += 8; };
  bytes(Buffer.from('SNGPKG')); u32(1); bytes(mask); u64(metaLength); u64(metadata.length);
  for (const pair of metadata) for (const value of pair) { u32(value.length); bytes(value); }
  u64(indexLength); u64(files.length); let offset = start;
  for (const file of files) { header[position++] = file.name.length; bytes(file.name); u64(file.data.length); u64(offset); offset += file.data.length; }
  u64(files.reduce((sum, file) => sum + file.data.length, 0));
  return Buffer.concat([header, ...files.map(file => Buffer.from(file.data.map((value, index) => value ^ mask[index % 16] ^ (index & 255))))]);
}

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ch-enchor-root-')), rootPath = path.join(base, 'exports'); await fs.mkdir(rootPath);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir())); assert.ok(path.basename(base).startsWith('ch-enchor-root-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  return { rootPath, args: { id, endpoint: 'enchor:' + md5, title: 'Song', artist: 'Band', rootPath } };
}
async function paths(rootPath) {
  const stage = path.join(rootPath, '.chartshub-companion-' + id);
  const partials = (await fs.readdir(stage)).filter(name => name.startsWith('.chartshub-partial-'));
  assert.equal(partials.length, 1); return { stage, partial: path.join(stage, partials[0]) };
}
async function waitForPrefix(filename) {
  const deadline = Date.now() + 4000;
  for (;;) {
    const info = await fs.stat(filename).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (info?.size >= 6) return;
    if (Date.now() >= deadline) throw Error('Synthetic SNG prefix was not written before the replacement.');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

for (const scope of ['root', 'stage', 'partial']) for (const boundary of ['headers', 'body', 'after-body']) {
  test(`external import preserves a replacement ${scope} while waiting for ${boundary}`, async t => {
    const f = await fixture(t), bytes = sng(); let replaced, marker, locked;
    async function replace(current) {
      const target = scope === 'root' ? f.rootPath : scope === 'stage' ? current.stage : current.partial;
      try { await fs.rename(target, target + '.previous'); }
      catch (error) { if (boundary === 'body' && process.platform === 'win32' && error.code === 'EPERM') locked = error; throw error; }
      await fs.mkdir(current.partial, { recursive: true });
      marker = path.join(current.partial, 'keep.txt'); await fs.writeFile(marker, 'foreign sentinel');
      replaced = current;
    }
    const worker = createCatalogueDownloadWorker({
      // The real converter awaits this phase after closing the download file.
      // It exercises a reachable replacement even on Windows with open-file locks.
      downloadExternal: options => downloadEnchor({ ...options, progress: value => {
        if (boundary === 'after-body' && value.message === 'Vérification du conteneur SNG…') return paths(f.rootPath).then(replace);
        return options.progress(value);
      } }),
      fetcher: async () => {
      const current = await paths(f.rootPath);
      if (boundary === 'headers') { await replace(current); return new Response(bytes); }
      if (boundary === 'after-body') return new Response(bytes);
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(bytes.subarray(0, 6)); },
        async pull(controller) {
          await waitForPrefix(path.join(current.partial, 'chart.sng')); await replace(current);
          controller.enqueue(bytes.subarray(6)); controller.close();
        }
      }));
    } });
    let problem; try { await worker.run(f.args); } catch (error) { problem = error; }
    if (locked) {
      assert.equal(locked.code, 'EPERM'); assert.equal(replaced, undefined);
      assert.equal(typeof locked.dest, 'string'); await assert.rejects(fs.stat(locked.dest), { code: 'ENOENT' });
      t.skip('Windows denied this actual directory rename while the file handle was open (EPERM); headers and after-body replacements are tested separately.'); return;
    }
    assert.ok(problem, 'the changed destination must reject the import'); assert.equal(problem.code, 'DOWNLOAD_PATH');
    assert.ok(replaced, 'the mock really replaced the directory during the transfer');
    assert.equal(await fs.readFile(marker, 'utf8'), 'foreign sentinel', 'cleanup must never delete a replacement directory');
    assert.deepEqual(await fs.readdir(replaced.partial), ['keep.txt'], 'no SNG, extraction or publication may enter the replacement tree');
    await assert.rejects(fs.stat(path.join(replaced.stage, 'Band - Song')), { code: 'ENOENT' });
  });
}
