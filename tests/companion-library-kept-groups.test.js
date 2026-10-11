const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createInstalledLibraryService } = require('../companion/library-service.cjs');
const { validCommand } = require('../companion/security.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settled(service) {
  const deadline = Date.now() + 10000;
  while (service.status().status === 'scanning') { if (Date.now() > deadline) throw Error('Fixture scan timeout'); await delay(5); }
  assert.equal(service.status().status, 'ready');
}
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-kept-groups-')), root = path.join(base, 'Songs'), profile = path.join(base, 'profile');
  await fs.mkdir(root); const services = [];
  async function song(folder, songRoot = root) {
    const target = path.join(songRoot, folder); await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'notes.chart'), '[Song]\n{\n Name = "Song"\n Artist = "Artist"\n Charter = "Charter"\n}\n');
    await fs.writeFile(path.join(target, 'song.ogg'), 'fixture audio');
  }
  for (const folder of ['A', 'B', 'C']) await song(folder);
  const create = () => {
    const service = createInstalledLibraryService({ dataDirectory: profile, recycle: async () => assert.fail('Keeping copies never recycles files') });
    services.push(service); return service;
  };
  const service = create(); await service.selectRoot(root); await settled(service); await service.configure({ refreshOnStart: false });
  const compare = target => target.compareDuplicates({ id: target.query().items[0].id, revision: target.status().revision });
  const keep = async target => { const comparison = await compare(target); return target.keepDuplicateVersions({ contextId: comparison.contextId, revision: comparison.revision }); };
  t.after(async () => {
    for (const service of services) await service.stop();
    if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-kept-groups-')) throw Error('Unsafe fixture');
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, root, profile, service, create, compare, keep, song, preferenceFile: path.join(profile, 'library-duplicate-choices.json') };
}

test('keep-all is explicit, durable, excludes the exact group from duplicates and global verification, and preserves every song', async t => {
  const f = await fixture(t), revision = f.service.status().revision;
  assert.equal(f.service.query({ duplicates: 'possible' }).total, 3);
  const comparison = await f.compare(f.service), keepId = comparison.variants[0].id;
  await f.service.chooseDuplicate({ contextId: comparison.contextId, revision, id: keepId });
  const plan = await f.service.prepareCleanup({ contextId: comparison.contextId, revision, keepId });
  const result = await f.service.keepDuplicateVersions({ contextId: comparison.contextId, revision });
  assert.deepEqual(result, { contextId: comparison.contextId, revision, preferredId: null, keptAll: true });
  assert.equal(f.service.status().revision, revision);
  assert.equal(f.service.query({ duplicates: 'possible' }).total, 0);
  assert.equal(f.service.query().total, 3); assert.ok(f.service.query().items.every(item => item.keptAll === true && item.duplicateCount === 3));
  assert.equal((await f.service.verifyAllDuplicates()).totalGroups, 0);
  await assert.rejects(f.service.cleanupReview({ planId: plan.planId, revision, ids: [plan.candidates[0].id] }));
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['A', 'B', 'C']);
  const saved = JSON.parse(await fs.readFile(f.preferenceFile, 'utf8'));
  assert.equal(saved.version, 2); assert.deepEqual(saved.choices, {}); assert.equal(Object.keys(saved.keptGroups).length, 1);
  assert.ok(!JSON.stringify(saved).includes(f.root));
  await f.service.stop(); const reopened = f.create(); await reopened.start();
  assert.equal(reopened.query({ duplicates: 'possible' }).total, 0); assert.equal(reopened.query().total, 3);
  assert.equal((await f.compare(reopened)).keptAll, true);
  reopened.requestScan('quick'); await settled(reopened);
  assert.equal(reopened.query({ duplicates: 'possible' }).total, 0, 'unchanged scan preserves the reviewed membership');
  const again = await f.compare(reopened);
  await reopened.chooseDuplicate({ contextId: again.contextId, revision: again.revision, id: keepId });
  assert.equal(reopened.query({ duplicates: 'possible' }).total, 3, 'explicit keeper selection can reopen a kept group');
});

test('new, removed and changed members require a fresh decision while an unrelated root remains independent', async t => {
  const f = await fixture(t); await f.keep(f.service);
  await f.song('D'); f.service.requestScan('quick'); await settled(f.service);
  assert.equal(f.service.query({ duplicates: 'possible' }).total, 4);
  assert.equal((await f.service.verifyAllDuplicates()).needsKeeperGroups, 1);
  await f.keep(f.service);
  await fs.rename(path.join(f.root, 'D'), path.join(f.base, 'removed-fixture-D'));
  f.service.requestScan('quick'); await settled(f.service);
  assert.equal(f.service.query({ duplicates: 'possible' }).total, 3);
  await f.keep(f.service);
  const audio = path.join(f.root, 'B', 'song.ogg'), before = await fs.stat(audio);
  await fs.writeFile(audio, 'changed audio'); await fs.utimes(audio, before.atime, before.mtime);
  f.service.requestScan('quick'); await settled(f.service);
  assert.equal(f.service.query({ duplicates: 'possible' }).total, 3, 'same-size/mtime edit has a different scan identity');
  await f.keep(f.service);
  const otherRoot = path.join(f.base, 'OtherSongs'); await f.song('A', otherRoot); await f.song('B', otherRoot); await f.song('C', otherRoot);
  await f.service.selectRoot(otherRoot); await settled(f.service);
  assert.equal(f.service.query({ duplicates: 'possible' }).total, 3);
});

test('clearing a keeper alone does not record keep-all and malformed or stale requests cannot suppress a group', async t => {
  const f = await fixture(t), comparison = await f.compare(f.service), request = { contextId: comparison.contextId, revision: comparison.revision };
  await f.service.chooseDuplicate({ ...request, id: null });
  assert.equal(f.service.query({ duplicates: 'possible' }).total, 3);
  for (const bad of [null, {}, { ...request, id: null }, { ...request, contextId: 'b'.repeat(32) }, { ...request, revision: request.revision + 1 }, { ...request, path: f.root }]) {
    await assert.rejects(f.service.keepDuplicateVersions(bad), { code: 'LIBRARY_COMPARISON_SAFE' });
    assert.equal(f.service.query({ duplicates: 'possible' }).total, 3);
  }
  assert.equal(validCommand('library.keepDuplicateVersions', request, []), true);
  for (const bad of [{}, { ...request, revision: -1 }, { ...request, contextId: '../private' }, { ...request, ids: [] }]) assert.equal(validCommand('library.keepDuplicateVersions', bad, []), false);
  await fs.writeFile(f.preferenceFile, '{externally changed');
  await assert.rejects(f.service.keepDuplicateVersions(request), /changé sur disque/);
  assert.equal(f.service.query({ duplicates: 'possible' }).total, 3);
  assert.equal(await fs.readFile(f.preferenceFile, 'utf8'), '{externally changed');
});

test('legacy keeper choices migrate with their original backup when a separate group is kept', async t => {
  const f = await fixture(t), comparison = await f.compare(f.service);
  await f.service.chooseDuplicate({ contextId: comparison.contextId, revision: comparison.revision, id: comparison.variants[0].id });
  await f.service.stop();
  const saved = JSON.parse(await fs.readFile(f.preferenceFile, 'utf8')), legacy = JSON.stringify({ version: 1, choices: saved.choices });
  await fs.writeFile(f.preferenceFile, legacy);
  const reopened = f.create(); await reopened.start();
  assert.equal((await f.compare(reopened)).preferredId, comparison.variants[0].id);
  await f.keep(reopened);
  assert.equal(await fs.readFile(f.preferenceFile + '.bak', 'utf8'), legacy);
  assert.equal(JSON.parse(await fs.readFile(f.preferenceFile, 'utf8')).version, 2);
  assert.equal(reopened.query({ duplicates: 'possible' }).total, 0);
});
