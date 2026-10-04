'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { Module, createRequire } = require('node:module');

const digest = text => createHash('sha256').update(text).digest('hex');
async function injected(filename, overrides) {
  const absolute = require.resolve(filename), local = new Module(absolute, module), normal = createRequire(absolute);
  local.filename = absolute; local.paths = Module._nodeModulePaths(path.dirname(absolute));
  local.require = name => Object.hasOwn(overrides, name) ? overrides[name] : normal(name);
  local._compile(await fs.readFile(absolute, 'utf8'), absolute);
  return local.exports;
}
async function settled(service) {
  const deadline = Date.now() + 15000;
  while (service.status().status === 'scanning') {
    assert.ok(Date.now() < deadline, 'large-library scan must settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return service.status();
}
function item(index, metadata) {
  const folderRelativePath = `Song-${String(index).padStart(5, '0')}`;
  const relativePath = `${folderRelativePath}/notes.mid`;
  return {
    id: digest(relativePath), relativePath, folderRelativePath,
    title: `${folderRelativePath} ${metadata}`, artist: metadata, charter: metadata, album: metadata, year: metadata,
    format: 'midi', audio: 'missing', signature: digest(String(index))
  };
}

test('12,000 songs persist beyond 32 MiB, reload completely, paginate and invalidate query/matching caches', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-library-large-'));
  const root = path.join(base, 'songs'), data = path.join(base, 'profile'), filename = path.join(data, 'library.json');
  await fs.mkdir(root); await fs.mkdir(data);
  const services = [];
  t.after(async () => {
    for (const service of services) await service.stop();
    const resolved = path.resolve(base);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('chartshub-library-large-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  // Shared UTF-8 metadata keeps the fixture heap modest while the actual file
  // exceeds the former byte cap. No audio files or huge directory tree needed.
  const metadata = 'é'.repeat(256), count = 12000;
  let nextItems = Array.from({ length: count }, (_, index) => item(index + 1, metadata));
  let previousCount = null;
  const module = await injected('../companion/library-service.cjs', {
    './library-scanner.cjs': {
      SCANNER_LIMITS: { metadataBytes: 256 * 1024, sngSectionBytes: 1024 * 1024 },
      scanLibrary: async options => {
        previousCount = options.previousItems.length;
        options.onProgress({ visited: nextItems.length * 2, processed: nextItems.length, discovered: nextItems.length });
        return { items: nextItems, warningCount: 0, skippedCount: 0, preservedPrefixes: [] };
      }
    }
  });
  const create = () => {
    const service = module.createInstalledLibraryService({ dataDirectory: data }); services.push(service); return service;
  };
  const original = create();
  await original.selectRoot(root);
  const committed = await settled(original);
  assert.equal(committed.status, 'ready', committed.error);
  assert.equal(committed.count, count);
  assert.deepEqual(committed.changes, { added: count, removed: 0, modified: 0 });
  assert.ok((await fs.stat(filename)).size > 32 * 1024 * 1024, 'exercise the former 32 MiB persistence cap');
  const lastId = nextItems.at(-1).id;
  const lastPage = original.query({ offset: count - 1, limit: 100 });
  assert.equal(lastPage.total, count); assert.equal(lastPage.items.length, 1); assert.equal(lastPage.items[0].id, lastId);
  assert.equal(Object.hasOwn(lastPage.items[0], 'signature'), false);
  assert.equal(Object.hasOwn(lastPage.items[0], 'folderRelativePath'), false);
  lastPage.items[0].title = 'mutated caller copy';
  assert.notEqual(original.query({ offset: count - 1, limit: 100 }).items[0].title, 'mutated caller copy');
  assert.equal(original.query({ offset: 1000001, limit: 100 }).total, count);
  assert.deepEqual(original.query({ offset: 1000001, limit: 100 }).items, []);
  await original.stop();

  const reloaded = create();
  const loaded = await reloaded.load();
  assert.equal(loaded.status, 'ready', loaded.error); assert.equal(loaded.count, count);
  assert.equal(loaded.revision, committed.revision);
  assert.equal(reloaded.query({ offset: count - 1, limit: 1 }).items[0].id, lastId);
  assert.equal(reloaded.query({ query: 'Song-12000', limit: 1 }).items[0].id, lastId);
  const snapshot = reloaded.matchingSnapshot();
  assert.equal(snapshot.items.length, count); assert.equal(snapshot.items.at(-1).id, lastId);
  assert.equal(reloaded.matchingSnapshot(), snapshot, 'unchanged snapshots are cached');

  // A subsequent scan must discard cached pages and matching records, even
  // though the selected folder and query strings stay the same.
  nextItems = [item(1, 'Replacement metadata')];
  reloaded.requestScan('quick');
  const refreshed = await settled(reloaded);
  assert.equal(previousCount, count); assert.equal(refreshed.status, 'ready', refreshed.error);
  assert.deepEqual(refreshed.changes, { added: 0, removed: count - 1, modified: 1 });
  assert.equal(reloaded.query().total, 1);
  assert.equal(reloaded.query({ offset: count - 1, limit: 1 }).items.length, 0);
  assert.equal(reloaded.query({ query: 'Song-12000', limit: 1 }).total, 0);
  const updated = reloaded.matchingSnapshot();
  assert.notEqual(updated, snapshot); assert.equal(updated.items.length, 1);
});

async function syntheticScanner({ songCount = 10001, onEntry } = {}) {
  const root = path.join(os.tmpdir(), 'chartshub-virtual-library-' + randomUUID());
  const counts = { entries: 0, opened: 0, closed: 0, reads: 0 };
  const stat = directory => ({
    ino: 1, dev: 1, size: 4, mtimeMs: 42,
    isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => false
  });
  const dirent = (name, directory) => ({ name, isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => false });
  const fakeFs = {
    realpath: async filename => filename,
    lstat: async filename => {
      if (path.basename(filename) === '.chartshub-companion-installing') throw Object.assign(Error('Absent'), { code: 'ENOENT' });
      return stat(filename === root || /^Song-\d+$/.test(path.basename(filename)));
    },
    open: async () => { counts.reads++; throw Error('MIDI metadata needs no file reads'); },
    opendir: async folder => {
      counts.opened++;
      return (async function* () {
        try {
          const total = folder === root ? songCount : 10;
          for (let index = 0; index < total; index++) {
            const entry = folder === root ? dirent(`Song-${String(index + 1).padStart(5, '0')}`, true)
              : dirent(index === 0 ? 'notes.mid' : `cover-${index}.jpg`, false);
            counts.entries++; onEntry?.(counts.entries);
            yield entry;
          }
        } finally { counts.closed++; }
      })();
    }
  };
  const module = await injected('../companion/library-scanner.cjs', { 'node:fs/promises': fakeFs });
  return { root, counts, scan: options => module.scanLibrary({ rootPath: root, ...options }) };
}

test('scanner crosses 100,000 entries and 10,000 songs while yielding and closing directory iterators', async () => {
  const fixture = await syntheticScanner();
  let heartbeat = false, lastProgress;
  setImmediate(() => { heartbeat = true; });
  const result = await fixture.scan({ onProgress: progress => { lastProgress = progress; } });
  assert.equal(result.items.length, 10001);
  assert.equal(fixture.counts.entries, 110011);
  assert.deepEqual(lastProgress, { visited: 110011, processed: 10001, discovered: 10001 });
  assert.equal(heartbeat, true, 'large scans must allow other event-loop work');
  assert.equal(fixture.counts.closed, fixture.counts.opened);
  assert.equal(fixture.counts.reads, 0);
  assert.equal(result.warningCount, 0); assert.equal(result.skippedCount, 0);
  assert.equal(result.items.at(-1).relativePath, 'Song-10001/notes.mid');
});

test('scanner remains cancellable after 100,000 entries and closes its active directory', async () => {
  const controller = new AbortController();
  let cancellationScheduled = false;
  const fixture = await syntheticScanner({
    onEntry: count => {
      if (count === 100001) {
        cancellationScheduled = true;
        setImmediate(() => controller.abort());
      }
    }
  });
  await assert.rejects(fixture.scan({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(cancellationScheduled, true, 'reach the former cap before cancelling');
  assert.ok(fixture.counts.entries >= 100001 && fixture.counts.entries <= 100040, 'cancellation is observed at a bounded yield');
  assert.equal(fixture.counts.closed, fixture.counts.opened);
  assert.equal(fixture.counts.reads, 0);
});
