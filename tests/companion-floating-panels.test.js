const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createFloatingPanels } = require('../companion/floating-panels.cjs');

const defaults = () => ({ backgroundColor: '#151719e6', textColor: '#eef1f2', fontFamily: 'system', fontSize: 14 });
const safe = error => error.code === 'FLOATING_PANELS_SAFE' && !error.message.includes('Private');
async function fixture(t, createDirectory = true) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-floating-panels-'));
  const dataDirectory = path.join(base, 'profile'); if (createDirectory) await fs.mkdir(dataDirectory);
  const file = path.join(dataDirectory, 'floating-panels.json'), service = createFloatingPanels({ dataDirectory });
  t.after(async () => {
    if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-floating-panels-')) throw Error('Unsafe temporary fixture');
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, dataDirectory, file, service, update: (appearance = defaults(), panel = 'catalogue', revision = service.status().revision) => service.update({ revision, panel, appearance }) };
}

test('new floating settings load defaults without writing, and first save creates its dedicated file', async t => {
  const f = await fixture(t, false);
  assert.deepEqual(await f.service.load(), { revision: 0, appearance: { catalogue: defaults(), filters: defaults() }, error: null, canWrite: true });
  await assert.rejects(fs.stat(f.dataDirectory), { code: 'ENOENT' });
  const updated = await f.update(); assert.equal(updated.revision, 1);
  assert.deepEqual(await fs.readdir(f.dataDirectory), ['floating-panels.json']);
});

test('catalogue and filters retain separate colors, background alpha, local font and size across a fresh service', async t => {
  const f = await fixture(t); await f.service.load();
  const catalogue = { backgroundColor: '#12345678', textColor: '#fedcba', fontFamily: 'georgia', fontSize: 19 };
  await f.update(catalogue); assert.deepEqual(f.service.status().appearance.filters, defaults());
  const filters = { backgroundColor: '#00000000', textColor: '#ffffff', fontFamily: 'consolas', fontSize: 24 };
  await f.update(filters, 'filters'); await f.service.flush();
  const stored = await createFloatingPanels({ dataDirectory: f.dataDirectory }).load();
  assert.deepEqual(stored.appearance, { catalogue, filters }); assert.equal(stored.revision, 2);
});

test('colors share existing safe normalization and text stays opaque', async t => {
  const f = await fixture(t);
  const result = await f.update({ backgroundColor: 'rgba(10, 20, 30, .5)', textColor: 'hsl(0 100% 50%)', fontFamily: 'arial', fontSize: 10 });
  assert.deepEqual(result.appearance.catalogue, { backgroundColor: '#0a141e80', textColor: '#ff0000', fontFamily: 'arial', fontSize: 10 });
  await f.update({ ...defaults(), backgroundColor: '#abcd', textColor: '#ffff' });
  assert.deepEqual(f.service.status().appearance.catalogue, { ...defaults(), backgroundColor: '#aabbccdd', textColor: '#ffffff' });
});

test('malformed payloads, unsafe colors, arbitrary fonts and unbounded sizes cannot create a settings file', async t => {
  const f = await fixture(t);
  const invalidAppearance = [
    null, {}, { ...defaults(), backgroundColor: 'url(https://private.invalid)' }, { ...defaults(), textColor: '#ffffff80' },
    { ...defaults(), textColor: 'transparent' }, { ...defaults(), fontFamily: 'Arial; background:url(x)' },
    { ...defaults(), fontSize: 9 }, { ...defaults(), fontSize: 25 }, { ...defaults(), fontSize: 14.5 },
    { ...defaults(), fontSize: NaN }, { ...defaults(), fontSize: '14' }, { ...defaults(), extra: true }
  ];
  for (const appearance of invalidAppearance) await assert.rejects(f.update(appearance), safe);
  for (const input of [null, {}, { revision: 0, panel: 'overlay', appearance: defaults() }, { revision: -1, panel: 'catalogue', appearance: defaults() }, { revision: 0, panel: 'catalogue', appearance: defaults(), path: '../outside' }]) await assert.rejects(f.service.update(input), safe);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' }); assert.equal(f.service.status().revision, 0);
});

test('input snapshots, output copies and stale revision checks preserve the authoritative saved settings', async t => {
  const f = await fixture(t), input = { revision: 0, panel: 'catalogue', appearance: { ...defaults(), fontSize: 18 } };
  const saving = f.service.update(input); input.appearance.fontSize = 24;
  const result = await saving; assert.equal(result.appearance.catalogue.fontSize, 18);
  result.appearance.catalogue.fontSize = 11; assert.equal(f.service.status().appearance.catalogue.fontSize, 18);
  const original = await fs.readFile(f.file, 'utf8');
  await assert.rejects(f.update(defaults(), 'filters', 0), { code: 'STALE_FLOATING_PANELS' });
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
});

test('concurrent writes cannot reuse a revision and flush waits for the outstanding atomic save', async t => {
  const f = await fixture(t);
  const first = f.update({ ...defaults(), fontSize: 20 }), second = f.update({ ...defaults(), fontSize: 22 });
  const settled = Promise.allSettled([first, second]); const flushed = await f.service.flush(); const results = await settled;
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected'); assert.equal(results[1].reason.code, 'STALE_FLOATING_PANELS');
  assert.equal(flushed.appearance.catalogue.fontSize, 20); assert.equal(flushed.revision, 1);
  assert.deepEqual(await fs.readdir(f.dataDirectory), ['floating-panels.json']);
});

test('corrupt, future, oversized and invalid-schema documents are preserved without overwrite', async t => {
  const f = await fixture(t);
  for (const original of ['{ broken', '{"version":9,"private":"untouched"}', 'x'.repeat(16385), JSON.stringify({ version: 1, revision: 4, appearance: { catalogue: defaults() } })]) {
    await fs.writeFile(f.file, original);
    const service = createFloatingPanels({ dataDirectory: f.dataDirectory }), state = await service.load();
    assert.equal(state.canWrite, false); assert.equal(typeof state.error, 'string');
    await assert.rejects(service.update({ revision: 0, panel: 'catalogue', appearance: defaults() }), safe);
    assert.equal(await fs.readFile(f.file, 'utf8'), original);
  }
});

test('external updates, replacement files and deletion are never silently clobbered', async t => {
  const f = await fixture(t); await f.update();
  const staleService = createFloatingPanels({ dataDirectory: f.dataDirectory }); await staleService.load();
  await f.update({ ...defaults(), fontSize: 17 }, 'filters');
  const original = await fs.readFile(f.file, 'utf8');
  await assert.rejects(staleService.update({ revision: 1, panel: 'catalogue', appearance: defaults() }), safe);
  assert.equal(staleService.status().canWrite, false); assert.equal(await fs.readFile(f.file, 'utf8'), original);
  await fs.unlink(f.file); await assert.rejects(f.update(), safe); await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});

test('occupied writer lock reports a recoverable error and preserves previous settings', async t => {
  const f = await fixture(t); await f.update(); const original = await fs.readFile(f.file, 'utf8');
  const lock = path.join(f.dataDirectory, '.floating-panels.lock'); await fs.writeFile(lock, 'another writer');
  await assert.rejects(f.update({ ...defaults(), fontSize: 24 }), safe);
  assert.equal(f.service.status().revision, 1); assert.equal(f.service.status().appearance.catalogue.fontSize, 14);
  assert.equal(f.service.status().canWrite, true); assert.equal(await fs.readFile(f.file, 'utf8'), original); assert.equal(await fs.readFile(lock, 'utf8'), 'another writer');
  await fs.unlink(lock); await f.update({ ...defaults(), fontSize: 24 }); assert.equal(f.service.status().error, null);
});

test('hardlinked settings and junction or symlink profile directories are rejected and untouched', async t => {
  const f = await fixture(t), other = path.join(f.base, 'other.json');
  const original = JSON.stringify({ version: 1, revision: 0, appearance: { catalogue: defaults(), filters: defaults() } });
  await fs.writeFile(other, original); await fs.link(other, f.file);
  assert.equal((await f.service.load()).canWrite, false); await assert.rejects(f.update(), safe); assert.equal(await fs.readFile(other, 'utf8'), original);
  const alias = path.join(f.base, 'linked-profile'); await fs.symlink(f.dataDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = createFloatingPanels({ dataDirectory: alias }); assert.equal((await linked.load()).canWrite, false);
  await assert.rejects(linked.update({ revision: 0, panel: 'filters', appearance: defaults() }), safe); assert.equal(await fs.readFile(other, 'utf8'), original);
});

test('a settings path changed to a directory after loading cannot replace the directory or report a successful write', async t => {
  const f = await fixture(t); await f.service.load(); await fs.mkdir(f.file);
  await assert.rejects(f.update(), safe); assert.equal(f.service.status().revision, 0); assert.deepEqual(await fs.readdir(f.file), []);
});
