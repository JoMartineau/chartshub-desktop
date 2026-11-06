'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { Module, createRequire } = require('node:module');
const { createBackgroundLibraryService } = require('../companion/library-background.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const deadline = Date.now() + 6000; while (!predicate()) { if (Date.now() > deadline) throw Error('Library batch condition timed out'); await delay(10); } }
async function ready(service) { await until(() => service.status().status !== 'scanning'); assert.equal(service.status().status, 'ready'); }
async function fixture(t, { background = false } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-library-batch-')), root = path.join(base, 'Songs'), other = path.join(base, 'Other Songs'), data = path.join(base, 'profile');
  await fs.mkdir(root); await fs.mkdir(other);
  const watchers = []; let scans = 0, factory = createBackgroundLibraryService;
  if (!background) {
    const filename = require.resolve('../companion/library-service.cjs'), local = new Module(filename, module), normal = createRequire(filename);
    const overrides = {
      'node:fs': { ...nativeFs, watch: (directory, options, callback) => { const watcher = new EventEmitter(); Object.assign(watcher, { callback, closed: false, close() { this.closed = true; } }); watchers.push(watcher); return watcher; } },
      './library-scanner.cjs': { scanLibrary: async () => { scans++; return { items: [], warningCount: 0, skippedCount: 0 }; } },
    };
    local.filename = filename; local.paths = Module._nodeModulePaths(path.dirname(filename)); local.require = name => Object.hasOwn(overrides, name) ? overrides[name] : normal(name);
    local._compile(await fs.readFile(filename, 'utf8'), filename); factory = local.exports.createInstalledLibraryService;
  }
  const service = factory({ dataDirectory: data });
  t.after(async () => { await service.stop(); if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-library-batch-')) throw Error('Unexpected fixture directory'); await fs.rm(base, { recursive: true, force: true }); });
  await service.load(); await service.selectRoot(root); await ready(service); await service.configure({ refreshOnStart: false }); await service.start();
  return { base, root, other, data, service, watchers, scans: () => scans, watch: () => watchers.at(-1) };
}

test('100000 watcher events during a bulk download produce one final quick scan', async t => {
  const f = await fixture(t); await f.service.configure({ watch: true }); const before = f.scans();
  const token = await f.service.beginDownloadBatch(f.root); assert.match(token, /^[a-f0-9-]{36}$/); assert.equal(f.service.status().downloadBatchActive, true);
  for (let index = 0; index < 100000; index++) f.watch().callback('change', 'Synthetic ' + index + '/song.ini');
  await delay(825); assert.equal(f.scans(), before); assert.equal(f.service.status().settings.watch, true);
  await f.service.endDownloadBatch(token, { changed: true }); await ready(f.service); await delay(825);
  assert.equal(f.scans(), before + 1); assert.equal(f.service.status().downloadBatchActive, false); assert.equal(f.service.status().settings.watch, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.data, 'library.json'), 'utf8')).settings.watch, true);
});

test('nested batches wait for the last token and duplicate finishes do not rescan', async t => {
  const f = await fixture(t), before = f.scans();
  const first = await f.service.beginDownloadBatch(f.root), second = await f.service.beginDownloadBatch(f.root);
  await f.service.endDownloadBatch(first, { changed: true }); assert.equal(f.scans(), before); assert.equal(f.service.status().downloadBatchActive, true);
  await f.service.endDownloadBatch(second); await ready(f.service); assert.equal(f.scans(), before + 1);
  await f.service.endDownloadBatch(first, { changed: true }); await f.service.endDownloadBatch(second, { changed: true }); assert.equal(f.scans(), before + 1);
});

test('pending automatic refresh is deferred but explicit manual refresh stays available', async t => {
  const f = await fixture(t); await f.service.configure({ watch: true }); const before = f.scans();
  f.watch().callback('rename', 'Earlier edit'); const token = await f.service.beginDownloadBatch(f.root);
  await delay(825); assert.equal(f.scans(), before);
  assert.equal(await f.service.requestScan('quick'), true); await ready(f.service); assert.equal(f.scans(), before + 1);
  assert.equal(f.service.status().downloadBatchActive, true);
  await f.service.endDownloadBatch(token); await ready(f.service); assert.equal(f.scans(), before + 2);
});

test('watch preference changes during a batch never restart automatic scans early', async t => {
  const f = await fixture(t); await f.service.configure({ watch: true }); const before = f.scans(), token = await f.service.beginDownloadBatch(f.root);
  await f.service.configure({ watch: false }); await f.service.configure({ watch: true }); f.watch().callback('change', 'New/song.ini');
  await delay(825); assert.equal(f.scans(), before);
  await f.service.endDownloadBatch(token); await ready(f.service); assert.equal(f.scans(), before + 1);
});

test('unchanged downloads do not scan and successful downloads refresh even with watch off', async t => {
  const f = await fixture(t), before = f.scans();
  const unchanged = await f.service.beginDownloadBatch(f.root); await f.service.endDownloadBatch(unchanged, { changed: false }); assert.equal(f.scans(), before);
  const changed = await f.service.beginDownloadBatch(f.root); await f.service.endDownloadBatch(changed, { changed: true }); await ready(f.service);
  assert.equal(f.scans(), before + 1); assert.equal(f.service.status().settings.watch, false);
});

test('stage-only events are ignored and other download roots do not pause the selected library', async t => {
  const f = await fixture(t); await f.service.configure({ watch: true }); const before = f.scans();
  assert.equal(await f.service.beginDownloadBatch(f.other), null); assert.equal(f.service.status().downloadBatchActive, false);
  const token = await f.service.beginDownloadBatch(f.root);
  f.watch().callback('change', '.chartshub-companion-12345678-1234-4123-8123-123456789abc/song.ini');
  await f.service.endDownloadBatch(token, { changed: false }); await delay(825); assert.equal(f.scans(), before);
});

test('root changes and stop invalidate old tokens without refreshing the wrong library', async t => {
  const f = await fixture(t); const old = await f.service.beginDownloadBatch(f.root);
  await f.service.selectRoot(f.other); await ready(f.service); const afterRootChange = f.scans();
  await f.service.endDownloadBatch(old, { changed: true }); assert.equal(f.scans(), afterRootChange); assert.equal(f.service.status().downloadBatchActive, false);
  const stopped = await f.service.beginDownloadBatch(f.other); await f.service.stop(); await f.service.endDownloadBatch(stopped, { changed: true });
  assert.equal(f.scans(), afterRootChange); assert.equal(f.service.status().downloadBatchActive, false);
  assert.equal(await f.service.beginDownloadBatch(f.other), null);
});

test('real background worker exposes bounded batch RPCs and commits a newly installed song once', async t => {
  const f = await fixture(t, { background: true }), before = f.service.status().revision;
  const token = await f.service.beginDownloadBatch(f.root); assert.equal(f.service.status().downloadBatchActive, true);
  const folder = path.join(f.root, 'Signal fictif'); await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'song.ini'), '[song]\nname = Signal fictif\nartist = Groupe Exemple\ncharter = Charter Démo\n');
  await fs.writeFile(path.join(folder, 'notes.chart'), '[Song]\n{\nResolution = 192\n}\n[ExpertSingle]\n{\n0 = N 0 0\n}\n');
  await f.service.endDownloadBatch(token, { changed: true }); await until(() => f.service.status().status === 'ready' && f.service.status().revision > before);
  assert.equal(f.service.status().count, 1); assert.equal(f.service.status().revision, before + 1); assert.equal(f.service.status().downloadBatchActive, false);
  assert.equal((await f.service.query()).items[0].title, 'Signal fictif');
});
