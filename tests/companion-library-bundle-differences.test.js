'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { inspectChartBundle, bundleSnapshot } = require('../companion/chart-bundle.cjs');
const { describeBundleDifferences } = require('../companion/library-bundle-differences.cjs');
const { createLibraryCleanup } = require('../companion/library-cleanup.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bundle = entries => ({ status: 'verified', kind: 'folder', entryCount: entries.length,
  files: entries.map(([name, content]) => ({ name, bytes: Buffer.byteLength(content), sha256: hash(content) })) });

test('file differences classify exact content, same-size changes and every file category deterministically', () => {
  const keeper = bundle([['readme.txt', 'keep'], ['song.ini', 'name=A'], ['album.png', 'art1'], ['song.ogg', 'stem1'], ['notes.chart', 'notes'], ['unique.png', 'only']]);
  const copy = bundle([['extra.txt', 'extra'], ['notes.chart', 'notes'], ['song.ogg', 'stem2'], ['album.png', 'art2'], ['song.ini', 'name=A'], ['readme.txt', 'keep']]);
  const result = describeBundleDifferences(keeper, copy);
  assert.equal(result.status, 'verified');
  assert.deepEqual(result.counts, { identical: 3, changed: 2, onlyKeeper: 1, onlyCopy: 1, unverified: 0 });
  assert.deepEqual(result.files.map(file => [file.name, file.category, file.status]), [
    ['notes.chart', 'notes', 'identical'], ['song.ogg', 'audio', 'changed'], ['album.png', 'artwork', 'changed'],
    ['unique.png', 'artwork', 'only-keeper'], ['song.ini', 'metadata', 'identical'], ['extra.txt', 'other', 'only-copy'], ['readme.txt', 'other', 'identical'],
  ]);
  assert.deepEqual(result.files.find(file => file.name === 'song.ogg'), { name: 'song.ogg', category: 'audio', status: 'changed', keeperBytes: 5, copyBytes: 5 });
  assert.equal(result.files.find(file => file.name === 'unique.png').copyBytes, null);
  assert.equal(result.files.find(file => file.name === 'extra.txt').keeperBytes, null);
  assert.deepEqual(describeBundleDifferences({ ...keeper, files: [...keeper.files].reverse() }, { ...copy, files: [...copy.files].reverse() }), result);
  assert.doesNotMatch(JSON.stringify(result), /sha256|bundleHash|identity|[a-f0-9]{64}/);
});

test('logical filename matches retain case changes while ambiguous and unsafe manifests fail closed', () => {
  const keeper = bundle([['notes.chart', 'notes'], ['Song.ogg', 'audio']]);
  const result = describeBundleDifferences(keeper, bundle([['notes.chart', 'notes'], ['song.ogg', 'audio']]));
  assert.equal(result.files.find(file => file.category === 'audio').status, 'changed');
  for (const invalid of [
    { ...keeper, status: 'unavailable' }, { ...keeper, files: undefined }, { ...keeper, entryCount: 9 },
    bundle([['../outside.txt', 'x']]), bundle([['C:/secret.txt', 'x']]), bundle([['/outside.txt', 'x']]),
    bundle([['a\\secret.txt', 'x']]), bundle([['NUL.txt', 'x']]), bundle([['name.', 'x']]),
    bundle([['song.ogg', 'x'], ['SONG.OGG', 'y']]),
    { ...keeper, files: keeper.files.map(file => ({ ...file, sha256: 'invalid' })) },
  ]) {
    const difference = describeBundleDifferences(keeper, invalid);
    assert.equal(difference.status, 'unavailable');
    assert.ok(difference.files.every(file => file.status === 'unverified' && file.copyBytes === null));
    assert.equal(difference.counts.onlyKeeper, 0, 'unreadability never proves absence');
    assert.equal(difference.counts.unverified, 2);
    assert.doesNotMatch(JSON.stringify(difference), /outside|secret|NUL/);
  }
  assert.deepEqual(describeBundleDifferences(null, null), { status: 'unavailable', counts: { identical: 0, changed: 0, onlyKeeper: 0, onlyCopy: 0, unverified: 0 }, files: [] });
});

test('real bundle manifests expose only verified file differences without leaking filesystem roots', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-differences-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('chartshub-differences-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const name of ['Keep', 'Copy']) {
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, name, 'notes.chart'), 'notes');
    await fs.writeFile(path.join(root, name, 'song.ogg'), name === 'Keep' ? 'audio A' : 'audio B');
    await fs.writeFile(path.join(root, name, 'album.png'), name === 'Keep' ? 'art A' : 'art B');
  }
  await fs.writeFile(path.join(root, 'Copy', 'credits.txt'), 'unique credits');
  const inspect = name => inspectChartBundle({ rootPath: root, relativePath: `${name}/notes.chart`, format: 'chart' });
  const keeper = await inspect('Keep'), copy = await inspect('Copy');
  assert.equal(keeper.files.length, 3); assert.equal(copy.files.length, 4);
  const difference = describeBundleDifferences(keeper, copy);
  assert.equal(difference.counts.changed, 2); assert.equal(difference.counts.onlyCopy, 1);
  assert.ok(!JSON.stringify(difference).includes(root));
  assert.ok(difference.files.every(file => !path.isAbsolute(file.name)));
  await fs.mkdir(path.join(root, 'Copy', 'unverified-folder'));
  const unavailable = await inspect('Copy');
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.files, undefined, 'partial manifests never escape failed verification');
  assert.ok(describeBundleDifferences(keeper, unavailable).files.every(file => file.status === 'unverified'));
});

test('public preparation and review differences are independent copies and cannot change cleanup or completion records', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-diff-plan-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('chartshub-diff-plan-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const members = [];
  for (const name of ['Keep', 'Copy']) {
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, name, 'notes.chart'), 'notes');
    await fs.writeFile(path.join(root, name, 'song.ogg'), 'same audio');
    const relativePath = `${name}/notes.chart`;
    const inspected = await inspectChartBundle({ rootPath: root, relativePath, format: 'chart' });
    members.push({ id: hash(name), relativePath, format: 'chart', bundle: inspected, cleanupSnapshot: bundleSnapshot(inspected.identity) });
  }
  const context = { rootPath: root, revision: 1, contextId: 'e'.repeat(32), keepId: members[0].id,
    keepHash: members[0].bundle.notes.sha256, keepFormat: 'chart', preferenceToken: 'saved', members };
  const document = { revision: 1, settings: { rootPath: root }, items: members }, recycled = [], completed = [];
  const cleanup = createLibraryCleanup({ getDocument: () => document, getContext: async () => context,
    recycle: async target => recycled.push(target), onCompleted: async event => completed.push(event) });
  t.after(() => cleanup.stop());
  const prepared = await cleanup.prepare({ contextId: context.contextId, revision: 1, keepId: context.keepId });
  const selection = { planId: prepared.planId, revision: 1, ids: [members[1].id] };
  const expected = structuredClone(prepared.candidates[0].differences);
  assert.equal(expected.status, 'verified'); assert.equal(expected.counts.identical, 2);
  prepared.candidates[0].differences.files[0].name = 'forged';
  prepared.candidates[0].differences.files.push({ name: 'fake' });
  prepared.candidates[0].differences.counts.identical = 9000;
  prepared.candidates[0].differences.status = 'unavailable';
  const review = await cleanup.review(selection);
  assert.deepEqual(review.candidates[0].differences, expected);
  review.candidates[0].differences.files[0].status = 'only-copy'; review.candidates[0].differences.counts.changed = 90;
  const again = await cleanup.review(selection);
  assert.deepEqual(again.candidates[0].differences, expected);
  assert.doesNotMatch(JSON.stringify(again), /sha256|bundleHash|identity/);
  assert.ok(!JSON.stringify(again).includes(root));
  const result = await cleanup.execute(selection);
  assert.deepEqual(result.recycledIds, [members[1].id]);
  assert.deepEqual(recycled, [path.join(root, 'Copy')]);
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].candidates[0].differences, expected);
  assert.equal(completed[0].keep.id, members[0].id);
  assert.deepEqual(completed[0].result.recycledIds, [members[1].id]);
});
