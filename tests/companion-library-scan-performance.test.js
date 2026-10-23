'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Module, createRequire } = require('node:module');

async function injected(filename, overrides) {
  const absolute = require.resolve(filename), local = new Module(absolute, module), normal = createRequire(absolute);
  local.filename = absolute; local.paths = Module._nodeModulePaths(path.dirname(absolute));
  local.require = name => Object.hasOwn(overrides, name) ? overrides[name] : normal(name);
  local._compile(await fs.readFile(absolute, 'utf8'), absolute);
  return local.exports;
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const turn = () => new Promise(resolve => setImmediate(resolve));

// An entirely virtual filesystem keeps performance/cancellation assertions
// independent of disk speed and never scans or changes a real Songs folder.
async function fixture({ songs = 16, beforeRead, beforeDirectoryEntry, beforeInspect, failRoot = false } = {}) {
  const root = path.resolve('virtual-library-performance'), directories = new Set([root]);
  const files = new Map(), identities = new Map(), calls = [], links = new Set();
  const counts = { directories: 0, files: 0, maxDirectories: 0, maxFiles: 0, snapshots: 0, activeSnapshots: 0, maxSnapshots: 0, metadataReads: 0 };
  const rootNames = [];
  for (let index = 0; index < songs; index++) {
    const name = 'Song-' + String(index).padStart(3, '0'), folder = path.join(root, name);
    rootNames.push(name); directories.add(folder);
    files.set(path.join(folder, 'notes.chart'), Buffer.from('[Song]\n{\n Name = "' + name + '"\n}\n[ExpertSingle]\n{\n 0 = N 0 0\n}\n'));
    files.set(path.join(folder, 'song.ini'), Buffer.from('[song]\nartist=Band\ncharter=Mapper\n'));
    files.set(path.join(folder, 'song.ogg'), Buffer.from('audio must never be opened'));
    files.set(path.join(folder, 'album.jpg'), Buffer.from('artwork'));
    files.set(path.join(folder, 'video.webm'), Buffer.from('video'));
  }
  rootNames.reverse(); rootNames.push('unrelated.txt'); files.set(path.join(root, 'unrelated.txt'), Buffer.from('ignored'));
  for (const name of [...directories, ...files.keys()]) identities.set(name, identities.size + 1);
  const names = folder => folder === root ? [...rootNames] : ['video.webm', 'song.ini', 'album.jpg', 'notes.chart', 'song.ogg'];
  function stat(filename, big) {
    const directory = directories.has(filename), convert = big ? BigInt : value => value;
    if (!directory && !files.has(filename)) throw Object.assign(Error('Absent'), { code: 'ENOENT' });
    return { dev: convert(1), ino: convert(identities.get(filename)), size: convert(directory ? 0 : files.get(filename).length),
      mtimeMs: 1, mtimeNs: convert(1), ctimeNs: convert(1), nlink: convert(1), mode: convert(directory ? 16877 : 33188),
      isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => links.has(filename) };
  }
  const virtual = {
    lstat: async (filename, options) => { calls.push(['lstat', filename]); await beforeInspect?.({ filename, root, links }); return stat(filename, options?.bigint); },
    realpath: async filename => { calls.push(['realpath', filename]); return filename; },
    readdir: async folder => { calls.push(['readdir', folder]); return names(folder); },
    opendir: async folder => {
      calls.push(['opendir', folder]);
      if (failRoot && folder === root) throw Object.assign(Error('Denied'), { code: 'EACCES' });
      return (async function* () {
        counts.directories++; counts.maxDirectories = Math.max(counts.maxDirectories, counts.directories);
        try {
          await turn();
          for (const name of names(folder)) {
            await beforeDirectoryEntry?.({ folder, root, name });
            yield { name, isDirectory: () => directories.has(path.join(folder, name)),
              isFile: () => files.has(path.join(folder, name)), isSymbolicLink: () => false };
          }
        } finally { counts.directories--; }
      })();
    },
    open: async filename => {
      calls.push(['open', filename]);
      assert.match(path.basename(filename), /^(?:notes\.chart|song\.ini)$/, 'metadata scan never opens audio, artwork or video');
      counts.files++; counts.maxFiles = Math.max(counts.maxFiles, counts.files); let closed = false;
      return {
        stat: async () => stat(filename, false),
        read: async (target, offset, length, position) => {
          counts.metadataReads++;
          if (beforeRead) await beforeRead({ filename, counts }); else await turn();
          const body = files.get(filename), bytesRead = Math.min(length, body.length - position);
          body.copy(target, offset, position, position + bytesRead); return { bytesRead };
        },
        close: async () => { assert.equal(closed, false); closed = true; counts.files--; calls.push(['close', filename]); }
      };
    }
  };
  // Use the actual bundle snapshot implementation, including all asset and
  // ancestor checks. Only the underlying filesystem is virtual.
  const bundle = await injected('../companion/chart-bundle.cjs', { 'node:fs/promises': virtual });
  const scanner = await injected('../companion/library-scanner.cjs', {
    'node:fs/promises': virtual,
    './chart-bundle.cjs': { captureBundleSnapshot: async options => {
      counts.snapshots++; counts.activeSnapshots++; counts.maxSnapshots = Math.max(counts.maxSnapshots, counts.activeSnapshots);
      try { await turn(); return await bundle.captureBundleSnapshot(options); } finally { counts.activeSnapshots--; }
    } }
  });
  return { root, files, calls, counts, scan: options => scanner.scanLibrary({ rootPath: root, ...options }) };
}

test('eight directory jobs overlap while snapshots, metadata handles and stable output remain bounded', async () => {
  const f = await fixture({ songs: 20 }), progress = [];
  const full = await f.scan({ onProgress: value => progress.push(value) });
  assert.equal(full.items.length, 20); assert.equal(full.warningCount, 0); assert.equal(full.skippedCount, 0);
  assert.equal(f.counts.maxDirectories, 8, 'overlap directory enumeration, with no ninth directory handle');
  assert.ok(f.counts.maxSnapshots > 1 && f.counts.maxSnapshots <= 8, 'snapshots overlap within the same fixed pool');
  assert.ok(f.counts.maxFiles > 1 && f.counts.maxFiles <= 8, 'metadata reads overlap within the same fixed pool');
  assert.equal(f.counts.snapshots, 40, 'every full scan song keeps its before and after snapshot');
  assert.equal(f.counts.metadataReads, 40); assert.equal(f.counts.directories, 0); assert.equal(f.counts.files, 0); assert.equal(f.counts.activeSnapshots, 0);
  assert.ok(full.items.every(item => /^[a-f0-9]{64}$/.test(item.cleanupSnapshot)));
  assert.deepEqual(full.items.map(item => item.relativePath), [...full.items.map(item => item.relativePath)].sort());
  assert.deepEqual(progress.at(-1), { visited: 121, processed: 20, discovered: 20 });

  const beforeReads = f.counts.metadataReads, beforeSnapshots = f.counts.snapshots;
  const quick = await f.scan({ mode: 'quick', previousItems: full.items });
  assert.deepEqual(quick, full);
  assert.equal(f.counts.metadataReads, beforeReads, 'unchanged quick scans reuse metadata');
  assert.equal(f.counts.snapshots - beforeSnapshots, 20, 'quick reuse still validates the entire bundle');
  const reread = await f.scan({ mode: 'full', previousItems: full.items });
  assert.deepEqual(reread, full);
  assert.equal(f.counts.metadataReads - beforeReads, 40, 'full scans still reread metadata and notes');
});

test('unrelated regular files avoid traversal stats while song artwork and video retain both snapshot checks', async () => {
  const f = await fixture({ songs: 2 }); await f.scan();
  const inspected = filename => f.calls.filter(([operation, target]) => operation === 'lstat' && target === filename).length;
  assert.equal(inspected(path.join(f.root, 'unrelated.txt')), 0);
  for (const folder of ['Song-000', 'Song-001']) {
    assert.equal(inspected(path.join(f.root, folder, 'album.jpg')), 2, 'artwork remains in both full snapshots');
    assert.equal(inspected(path.join(f.root, folder, 'video.webm')), 2, 'video remains in both full snapshots');
    assert.ok(inspected(path.join(f.root, folder, 'song.ogg')) >= 3, 'audio inventory remains part of traversal and both snapshots');
  }
});

test('cancel stops scheduling, waits for all eight active metadata handles and remains quiescent after rejection', async () => {
  const readsHeld = deferred(), allReading = deferred(), controller = new AbortController(); let arrived = 0, postCancelProgress = 0;
  const f = await fixture({ songs: 20, beforeRead: async () => { if (++arrived === 8) allReading.resolve(); await readsHeld.promise; } });
  let settled = false;
  const running = f.scan({ signal: controller.signal, onProgress: () => { if (controller.signal.aborted) postCancelProgress++; } });
  running.then(() => { settled = true; }, () => { settled = true; });
  await allReading.promise;
  assert.equal(f.counts.files, 8); controller.abort(); await turn();
  assert.equal(settled, false, 'scan cannot reject while metadata handles are still in flight');
  const scheduled = f.calls.filter(([operation]) => operation === 'opendir').length;
  assert.equal(scheduled, 9, 'only the root and first eight songs are scheduled');
  readsHeld.resolve(); await assert.rejects(running, { name: 'AbortError' });
  assert.equal(f.counts.files, 0); assert.equal(f.counts.directories, 0); assert.equal(f.counts.activeSnapshots, 0);
  assert.equal(f.calls.filter(([operation]) => operation === 'opendir').length, scheduled);
  assert.equal(postCancelProgress, 0);
  const finalCalls = f.calls.length; await turn(); await turn();
  assert.equal(f.calls.length, finalCalls, 'rejected scans leave no background filesystem work');
});

test('fatal root enumeration failure never schedules descendants or leaves resources behind', async () => {
  const f = await fixture({ songs: 20, failRoot: true });
  await assert.rejects(f.scan(), { code: 'EACCES' });
  assert.deepEqual(f.calls.filter(([operation]) => operation === 'opendir'), [['opendir', f.root]]);
  assert.equal(f.counts.files, 0); assert.equal(f.counts.directories, 0); assert.equal(f.counts.snapshots, 0);
  const finalCalls = f.calls.length; await turn(); assert.equal(f.calls.length, finalCalls);
});

test('cancel during enumeration drains all eight directory iterators before rejecting', async () => {
  const entriesHeld = deferred(), allEnumerating = deferred(), controller = new AbortController(); let arrived = 0;
  const f = await fixture({ songs: 20, beforeDirectoryEntry: async ({ folder, root }) => {
    if (folder === root) return;
    if (++arrived === 8) allEnumerating.resolve(); await entriesHeld.promise;
  } });
  let settled = false;
  const running = f.scan({ signal: controller.signal }); running.then(() => { settled = true; }, () => { settled = true; });
  await allEnumerating.promise; assert.equal(f.counts.directories, 8);
  controller.abort(); await turn(); assert.equal(settled, false);
  entriesHeld.resolve(); await assert.rejects(running, { name: 'AbortError' });
  assert.equal(f.counts.directories, 0); assert.equal(f.counts.files, 0); assert.equal(f.counts.snapshots, 0);
  assert.equal(f.calls.filter(([operation]) => operation === 'opendir').length, 9);
  const finalCalls = f.calls.length; await turn(); await turn(); assert.equal(f.calls.length, finalCalls);
});

test('a listed directory replaced by a link is rejected by its job before enumeration or metadata reads', async () => {
  const f = await fixture({ songs: 2, beforeInspect: ({ filename, root, links }) => {
    if (filename === path.join(root, 'Song-000')) links.add(filename);
  } });
  const result = await f.scan();
  assert.equal(result.items.length, 1); assert.equal(result.items[0].relativePath, 'Song-001/notes.chart');
  assert.equal(result.skippedCount, 1); assert.equal(result.warningCount, 0);
  assert.equal(f.calls.some(([operation, filename]) => operation === 'opendir' && filename === path.join(f.root, 'Song-000')), false);
  assert.equal(f.calls.some(([operation, filename]) => operation === 'open' && filename.startsWith(path.join(f.root, 'Song-000') + path.sep)), false);
  assert.equal(f.counts.directories, 0); assert.equal(f.counts.files, 0);
});

test('a child directory that becomes unreadable retains its previous committed songs', async () => {
  let deny = false;
  const f = await fixture({ songs: 2, beforeInspect: ({ filename, root }) => {
    if (deny && filename === path.join(root, 'Song-000')) throw Object.assign(Error('Denied'), { code: 'EACCES' });
  } });
  const baseline = await f.scan(); deny = true;
  const result = await f.scan({ mode: 'quick', previousItems: baseline.items });
  assert.deepEqual(result.items, baseline.items);
  assert.deepEqual(result.preservedPrefixes, ['Song-000']); assert.equal(result.warningCount, 1); assert.equal(result.skippedCount, 0);
  assert.equal(f.counts.directories, 0); assert.equal(f.counts.files, 0); assert.equal(f.counts.activeSnapshots, 0);
});
