const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createLibraryCleanupHistory } = require('../companion/library-cleanup-history.cjs');

const hash = value => createHash('sha256').update(value).digest('hex');
const target = name => ({ id: hash(name), relativePath: `${name}/notes.chart`, targetRelativePath: name });
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-cleanup-history-'));
  const directory = path.join(base, 'profile'), rootPath = path.join(base, 'Songs');
  await fs.mkdir(directory);
  const history = createLibraryCleanupHistory({ directory }), file = path.join(directory, 'library-cleanup-history.json');
  const event = (extra = {}) => ({ rootPath, keep: target('Keep'), candidates: [target('B'), target('C'), target('D')], mode: 'normal',
    result: { recycledIds: [hash('B')], failed: [{ id: hash('C'), reason: 'Private C:/unrelated error' }], cancelled: false }, ...extra });
  t.after(async () => {
    if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-cleanup-history-')) throw Error('Unsafe temporary fixture');
    await fs.rm(base, { force: true, recursive: true });
  });
  return { base, directory, file, rootPath, history, event, list: options => history.list({ rootPath, ...options }) };
}
const safe = failure => failure.code === 'LIBRARY_CLEANUP_HISTORY' && !failure.message.includes('Private');

test('new history is empty and never creates or opens the configured Songs folder', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.list(), { entries: [], total: 0, offset: 0, limit: 10, maxEntries: 200 });
  await assert.rejects(fs.stat(f.rootPath), { code: 'ENOENT' });
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});

test('durable records preserve selected keeper, individual outcomes and partial failures without private paths or native errors', async t => {
  const f = await fixture(t), before = Date.now(), result = await f.history.append(f.event());
  assert.equal(result.recorded, true); assert.match(result.id, /^[a-f0-9]{32}$/);
  const reloaded = createLibraryCleanupHistory({ directory: f.directory });
  const page = await reloaded.list({ rootPath: f.rootPath }), [entry] = page.entries;
  assert.deepEqual(entry.keep, target('Keep')); assert.equal(entry.mode, 'normal'); assert.equal(entry.cancelled, false);
  assert.ok(Date.parse(entry.at) >= before && Date.parse(entry.at) <= Date.now());
  assert.deepEqual(entry.candidates.map(value => [value.id, value.status]), [[hash('B'), 'recycled'], [hash('C'), 'failed'], [hash('D'), 'not-attempted']]);
  assert.equal(entry.candidates[0].reason, null); assert.match(entry.candidates[1].reason, /corbeille/);
  assert.ok(!JSON.stringify(page).includes('rootKey')); assert.ok(!JSON.stringify(page).includes(f.rootPath));
  const source = await fs.readFile(f.file, 'utf8'); assert.ok(!source.includes('Private')); assert.ok(!source.includes('unrelated')); assert.ok(!source.includes(f.rootPath));
});

test('only explicitly selected copies are recorded and force mode and interruption survive restart', async t => {
  const f = await fixture(t);
  assert.equal((await f.history.append(f.event({ candidates: [target('C')], mode: 'force', result: { recycledIds: [], failed: [], cancelled: true } }))).recorded, true);
  const [entry] = (await f.list()).entries;
  assert.equal(entry.mode, 'force'); assert.equal(entry.cancelled, true);
  assert.deepEqual(entry.candidates.map(value => [value.id, value.status]), [[hash('C'), 'not-attempted']]);
  assert.ok(!JSON.stringify(entry).includes(hash('B'))); assert.ok(!JSON.stringify(entry).includes(hash('D')));
});

test('each Songs folder has an isolated paginated view and callers cannot mutate persisted data', async t => {
  const f = await fixture(t), other = path.join(f.base, 'Other Songs');
  const first = await f.history.append(f.event());
  await f.history.append(f.event({ rootPath: other }));
  const second = await f.history.append(f.event({ mode: 'force' }));
  const page = await f.list({ limit: 1 }); assert.equal(page.total, 2); assert.equal(page.entries[0].id, second.id);
  page.entries[0].keep.relativePath = 'rewritten';
  const next = await f.list({ offset: 1, limit: 1 }); assert.equal(next.entries[0].id, first.id);
  assert.equal((await f.list()).entries[0].keep.relativePath, 'Keep/notes.chart');
  assert.equal((await f.history.list({ rootPath: other })).total, 1);
  assert.equal((await f.list({ offset: 200 })).entries.length, 0);
});

test('queued writes snapshot selected values and retain concurrent results', async t => {
  const f = await fixture(t), event = f.event(), first = f.history.append(event);
  event.keep.relativePath = 'changed'; event.candidates.splice(0); event.result.recycledIds.splice(0);
  const writes = [first, ...Array.from({ length: 8 }, () => f.history.append(f.event()))];
  assert.ok((await Promise.all(writes)).every(value => value.recorded));
  const page = await f.list(); assert.equal(page.total, 9); assert.ok(page.entries.every(value => value.keep.relativePath === 'Keep/notes.chart'));
});

test('history retains at most 200 recent records across folders', async t => {
  const f = await fixture(t), first = await f.history.append(f.event());
  for (let index = 0; index < 200; index++) assert.equal((await f.history.append(f.event())).recorded, true);
  const page = await f.list({ limit: 50 }); assert.equal(page.total, 200); assert.equal(page.entries.length, 50);
  const stored = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.equal(stored.entries.length, 200); assert.ok(!stored.entries.some(value => value.id === first.id));
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['library-cleanup-history.json']);
});

test('malformed, keeper-bearing, ambiguous and out-of-selection results are rejected without any history write', async t => {
  const f = await fixture(t);
  const invalid = [
    { keep: { ...target('Keep'), relativePath: '../outside' } },
    { candidates: [target('Keep')] },
    { candidates: [target('B'), target('B')] },
    { candidates: [{ ...target('B'), targetRelativePath: '../outside' }] },
    { candidates: [{ ...target('B'), targetRelativePath: 'Keep', relativePath: 'Keep/other.chart' }] },
    { result: { recycledIds: [hash('Keep')], failed: [], cancelled: false } },
    { result: { recycledIds: [hash('B')], failed: [{ id: hash('B') }], cancelled: false } },
    { result: { recycledIds: [hash('Unknown')], failed: [], cancelled: false } },
    { mode: 'delete' }, { rootPath: '../outside' }, { candidates: [] }
  ];
  for (const extra of invalid) assert.equal((await f.history.append(f.event(extra))).recorded, false);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});

test('invalid pagination and absent profiles return generic errors without creating directories', async t => {
  const f = await fixture(t);
  for (const input of [{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 51 }, { limit: '10' }, { rootPath: '../Songs' }]) await assert.rejects(f.list(input), safe);
  const missing = createLibraryCleanupHistory({ directory: path.join(f.base, 'missing') });
  assert.equal((await missing.append(f.event())).recorded, false);
  await assert.rejects(missing.list({ rootPath: f.rootPath }), safe);
  await assert.rejects(fs.stat(path.join(f.base, 'missing')), { code: 'ENOENT' });
});

test('malformed JSON or an invalid schema is preserved unchanged and cannot be silently overwritten', async t => {
  const f = await fixture(t);
  for (const original of ['{broken', '{"version":2,"entries":[]}', '{"version":1,"entries":[{}]}', '{"version":1,"entries":[],"foreign":true}']) {
    await fs.writeFile(f.file, original);
    await assert.rejects(f.list(), safe); const outcome = await f.history.append(f.event());
    assert.equal(outcome.recorded, false); assert.match(outcome.error, /restent inchangés/);
    assert.equal(await fs.readFile(f.file, 'utf8'), original);
    assert.deepEqual(await fs.readdir(f.directory), ['library-cleanup-history.json']);
  }
});

test('hard-linked history and occupied lock files cannot overwrite an unrelated file', async t => {
  const f = await fixture(t), other = path.join(f.base, 'untouched.json'), original = '{"version":1,"entries":[]}';
  await fs.writeFile(other, original); await fs.link(other, f.file);
  await assert.rejects(f.list(), safe); assert.equal((await f.history.append(f.event())).recorded, false);
  assert.equal(await fs.readFile(other, 'utf8'), original);
  await fs.unlink(f.file);
  const lock = path.join(f.directory, '.library-cleanup-history.lock'); await fs.writeFile(lock, 'another writer');
  assert.equal((await f.history.append(f.event())).recorded, false);
  assert.equal(await fs.readFile(lock, 'utf8'), 'another writer');
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});

test('symlink or junction profile ancestors are rejected without touching the destination', async t => {
  const f = await fixture(t), alias = path.join(f.base, 'linked-profile');
  await fs.symlink(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const history = createLibraryCleanupHistory({ directory: alias });
  assert.equal((await history.append(f.event())).recorded, false); await assert.rejects(history.list({ rootPath: f.rootPath }), safe);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('a history file replaced by a symlink or directory is rejected', async t => {
  const f = await fixture(t), other = path.join(f.base, 'outside-history.json');
  await fs.writeFile(other, '{"version":1,"entries":[]}');
  try { await fs.symlink(other, f.file, 'file'); }
  catch (failure) { if (!['EPERM', 'EACCES'].includes(failure.code)) throw failure; t.diagnostic('Windows file symlink privilege unavailable; directory and junction coverage still runs.'); }
  if ((await fs.lstat(f.file).catch(() => null))?.isSymbolicLink()) {
    await assert.rejects(f.list(), safe); assert.equal((await f.history.append(f.event())).recorded, false);
    assert.equal(await fs.readFile(other, 'utf8'), '{"version":1,"entries":[]}'); await fs.unlink(f.file);
  }
  await fs.mkdir(f.file); await assert.rejects(f.list(), safe); assert.equal((await f.history.append(f.event())).recorded, false);
  assert.deepEqual(await fs.readdir(f.file), []);
});
