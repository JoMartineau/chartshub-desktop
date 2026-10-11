'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createSongRequestPreferences } = require('../companion/song-request-preferences.cjs');
const { INSTRUMENTS, DIFFICULTIES, DEFAULT_RULES } = require('../companion/song-requests.cjs');

const settings = (port = 38474, rules = {}) => ({ port, rules: { ...DEFAULT_RULES, ...rules } });
const document = changes => ({ version: 1, ...settings(), ingestToken: 'a'.repeat(64), readToken: 'b'.repeat(64), ...changes });
const safe = error => error.code === 'SONG_REQUEST_PREFERENCES_SAFE' && !error.message.includes('Private');
async function fixture(t, createDirectory = true) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-song-request-prefs-'));
  const dataDirectory = path.join(base, 'Private-profile');
  if (createDirectory) await fs.mkdir(dataDirectory);
  const file = path.join(dataDirectory, 'song-request-access.json');
  const service = createSongRequestPreferences({ dataDirectory });
  t.after(async () => {
    await service.flush();
    if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-song-request-prefs-')) throw Error('Unsafe temporary fixture');
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, dataDirectory, file, service, fresh: () => createSongRequestPreferences({ dataDirectory }) };
}
function assertProtected(state) {
  assert.equal(state.ingestToken, null); assert.equal(state.readToken, null);
  assert.equal(typeof state.error, 'string'); assert.ok(!state.error.includes('Private'));
}

test('first load creates distinct persistent local capabilities and only dedicated preferences', async t => {
  const f = await fixture(t, false);
  assert.equal(f.service.status().ingestToken, null);
  const state = await f.service.load();
  assert.equal(state.port, 38474); assert.deepEqual(state.rules, DEFAULT_RULES); assert.equal(state.error, null);
  assert.match(state.ingestToken, /^[a-f0-9]{64}$/); assert.match(state.readToken, /^[a-f0-9]{64}$/);
  assert.notEqual(state.ingestToken, state.readToken);
  const disk = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.deepEqual(Object.keys(disk).sort(), ['ingestToken', 'port', 'readToken', 'rules', 'version']);
  assert.deepEqual(disk, { version: 1, port: state.port, rules: state.rules, ingestToken: state.ingestToken, readToken: state.readToken });
  assert.deepEqual(await fs.readdir(f.dataDirectory), ['song-request-access.json']);
  if (process.platform !== 'win32') assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
  assert.deepEqual(await f.fresh().load(), state);
});

test('port, all rule fields and capabilities survive save, flush and a fresh service', async t => {
  const f = await fixture(t); const before = await f.service.load();
  const next = settings(45678, { maxDurationMinutes: 7, instrument: 'pro-drums', difficulty: 'expert' });
  const saved = await f.service.save(next); await f.service.flush();
  assert.deepEqual(saved, { ...before, ...next }); assert.deepEqual(await f.fresh().load(), saved);
  assert.equal(Object.hasOwn(saved, 'enabled'), false); assert.equal(Object.hasOwn(saved, 'requests'), false);
  const disk = await fs.readFile(f.file, 'utf8');
  assert.equal(disk.includes('enabled'), false); assert.equal(disk.includes('requests'), false);
});

test('valid port and duration boundaries and core instrument/difficulty enums are supported', async t => {
  const f = await fixture(t);
  for (const port of [1024, 65535]) for (const maxDurationMinutes of [null, 1, 60]) {
    assert.deepEqual((await f.service.save(settings(port, { maxDurationMinutes }))).rules, { ...DEFAULT_RULES, maxDurationMinutes });
  }
  for (const instrument of INSTRUMENTS) assert.equal((await f.service.save(settings(38474, { instrument }))).rules.instrument, instrument);
  for (const difficulty of DIFFICULTIES) assert.equal((await f.service.save(settings(38474, { difficulty }))).rules.difficulty, difficulty);
});

test('invalid settings and session state cannot create a file or rotate tokens', async t => {
  const f = await fixture(t);
  const inputs = [null, {}, [], { ...settings(), enabled: true }, { ...settings(), requests: [] },
    { ...settings(), ingestToken: 'c'.repeat(64) }, { port: 38474, rules: {} },
    { ...settings(), rules: { ...DEFAULT_RULES, extra: true } },
    ...[0, 1023, 65536, 38474.5, NaN, Infinity, '38474', null].map(port => settings(port)),
    ...[0, 61, 1.5, NaN, '5', false].map(maxDurationMinutes => settings(38474, { maxDurationMinutes })),
    settings(38474, { instrument: 'Drums' }), settings(38474, { instrument: 'private/path' }), settings(38474, { difficulty: 'Expert' })];
  for (const input of inputs) await assert.rejects(f.service.save(input), safe);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  const before = await f.service.load(), disk = await fs.readFile(f.file);
  for (const input of inputs) await assert.rejects(f.service.save(input), safe);
  assert.deepEqual(f.service.status(), before); assert.deepEqual(await fs.readFile(f.file), disk);
});

test('save captures its input and returned state cannot mutate the authoritative settings', async t => {
  const f = await fixture(t), input = settings(40000, { maxDurationMinutes: 8 });
  const task = f.service.save(input); input.port = 65535; input.rules.maxDurationMinutes = 60;
  const saved = await task; assert.equal(saved.port, 40000); assert.equal(saved.rules.maxDurationMinutes, 8);
  saved.rules.instrument = 'vocals'; saved.ingestToken = 'x'; saved.error = 'x';
  const state = f.service.status(); state.rules.difficulty = 'hard';
  assert.deepEqual(f.service.status().rules, { ...DEFAULT_RULES, maxDurationMinutes: 8 });
  assert.equal(f.service.status().error, null); assert.match(f.service.status().ingestToken, /^[a-f0-9]{64}$/);
});

test('simultaneous loads share capabilities and serial saves are drained by flush', async t => {
  const f = await fixture(t, false);
  const [first, second] = await Promise.all([f.service.load(), f.service.load()]); assert.deepEqual(first, second);
  const writes = [f.service.save(settings(40001)), f.service.save(settings(40002, { difficulty: 'hard' }))];
  const results = Promise.all(writes); const flushed = await f.service.flush(); await results;
  assert.equal(flushed.port, 40002); assert.equal(flushed.rules.difficulty, 'hard');
  assert.equal(flushed.ingestToken, first.ingestToken); assert.deepEqual(await f.fresh().load(), flushed);
  assert.deepEqual(await fs.readdir(f.dataDirectory), ['song-request-access.json']);
});

test('malformed, future, invalid UTF-8, oversized and invalid-schema originals stay intact with no exposed tokens', async t => {
  const f = await fixture(t);
  const invalid = ['{ broken Private data', JSON.stringify(document({ version: 2 })), Buffer.from([0xff, 0xfe]), ' '.repeat(8193),
    ...[document({ version: 0 }), document({ port: 80 }), document({ readToken: 'a'.repeat(64) }),
      document({ ingestToken: 'A'.repeat(64) }), document({ readToken: 'b'.repeat(63) }), document({ enabled: true }),
      document({ rules: { ...DEFAULT_RULES, maxDurationMinutes: 61 } })].map(value => JSON.stringify(value))];
  for (const original of invalid) {
    await fs.writeFile(f.file, original); const service = f.fresh();
    assertProtected(await service.load()); await assert.rejects(service.save(settings()), safe);
    assert.deepEqual(await fs.readFile(f.file), Buffer.from(original));
    assert.deepEqual(await fs.readdir(f.dataDirectory), ['song-request-access.json']);
  }
});

test('the 8 KiB read cap accepts a valid document at the boundary and refuses one extra byte', async t => {
  const f = await fixture(t); const json = JSON.stringify(document());
  await fs.writeFile(f.file, json.padEnd(8192, ' ')); assert.equal((await f.fresh().load()).error, null);
  await fs.appendFile(f.file, ' '); assertProtected(await f.fresh().load()); assert.equal((await fs.stat(f.file)).size, 8193);
});

test('external modification and deletion after load are refused without overwriting or resurrecting files', async t => {
  const f = await fixture(t); const initial = await f.service.load();
  const outsider = f.fresh(); await outsider.load(); await outsider.save(settings(42000));
  const latest = await fs.readFile(f.file);
  await assert.rejects(f.service.save(settings(43000)), safe); assert.deepEqual(await fs.readFile(f.file), latest);
  assert.equal(f.service.status().port, initial.port);
  await fs.unlink(f.file); await assert.rejects(outsider.save(settings(44000)), safe);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  // A protected instance must not resume writing merely because the original bytes return.
  await fs.writeFile(f.file, latest); await assert.rejects(outsider.save(settings(44000)), safe);
  assert.deepEqual(await fs.readFile(f.file), latest);
});

test('a same-content replacement is detected by identity, not only by the bytes', async t => {
  const f = await fixture(t); await f.service.load(); const original = await fs.readFile(f.file);
  const backup = path.join(f.dataDirectory, 'original-backup.json'); await fs.rename(f.file, backup); await fs.writeFile(f.file, original);
  await assert.rejects(f.service.save(settings(40000)), safe);
  assert.deepEqual(await fs.readFile(f.file), original); assert.deepEqual(await fs.readFile(backup), original);
  assert.equal(f.service.status().port, 38474);
});

test('an occupied writer lock preserves its owner and permits retry after release', async t => {
  const f = await fixture(t); const initial = await f.service.load(), original = await fs.readFile(f.file);
  const lock = path.join(f.dataDirectory, '.song-request-access.lock'); await fs.writeFile(lock, 'Other Private writer');
  await assert.rejects(f.service.save(settings(40000)), safe);
  assert.equal(f.service.status().ingestToken, initial.ingestToken); assert.equal(f.service.status().port, 38474);
  assert.deepEqual(await fs.readFile(f.file), original); assert.equal(await fs.readFile(lock, 'utf8'), 'Other Private writer');
  await fs.unlink(lock); assert.equal((await f.service.save(settings(40000))).error, null);
  assert.deepEqual(await fs.readdir(f.dataDirectory), ['song-request-access.json']);
});

test('hardlinked files and junction or symlink ancestors are refused without touching their target', async t => {
  const f = await fixture(t), other = path.join(f.base, 'other.json'); const original = JSON.stringify(document());
  await fs.writeFile(other, original); await fs.link(other, f.file);
  assertProtected(await f.service.load()); await assert.rejects(f.service.save(settings()), safe);
  assert.equal(await fs.readFile(other, 'utf8'), original);
  const target = path.join(f.base, 'real-profile'); await fs.mkdir(target);
  const alias = path.join(f.base, 'linked-profile'); await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const dataDirectory of [alias, path.join(alias, 'nested')]) {
    const linked = createSongRequestPreferences({ dataDirectory }); assertProtected(await linked.load());
    await assert.rejects(linked.save(settings()), safe);
  }
  assert.deepEqual(await fs.readdir(target), []); assert.equal(await fs.readFile(other, 'utf8'), original);
});

test('a directory or junction at the file path is refused and preserved', async t => {
  const f = await fixture(t); await fs.mkdir(f.file);
  assertProtected(await f.service.load()); await assert.rejects(f.service.save(settings()), safe);
  assert.deepEqual(await fs.readdir(f.file), []);
  await fs.rmdir(f.file);
  const target = path.join(f.base, 'file-link-target'); await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'Private.txt'), 'untouched');
  await fs.symlink(target, f.file, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = f.fresh(); assertProtected(await linked.load()); await assert.rejects(linked.save(settings()), safe);
  assert.equal(await fs.readFile(path.join(target, 'Private.txt'), 'utf8'), 'untouched');
});

test('replaced or removed profile directories cannot receive a stale save', async t => {
  const f = await fixture(t); await f.service.load(); const original = await fs.readFile(f.file);
  const backup = path.join(f.base, 'profile-backup'); await fs.rename(f.dataDirectory, backup);
  await assert.rejects(f.service.save(settings(40000)), safe); await assert.rejects(fs.stat(f.dataDirectory), { code: 'ENOENT' });
  await fs.mkdir(f.dataDirectory); await fs.writeFile(f.file, original);
  await assert.rejects(f.service.save(settings(40000)), safe); assert.deepEqual(await fs.readFile(f.file), original);
  assert.deepEqual(await fs.readFile(path.join(backup, 'song-request-access.json')), original);
});

test('changed unsafe bytes remain protected even after replacing them with the previous valid document', async t => {
  const f = await fixture(t); await f.service.load(); const original = await fs.readFile(f.file);
  await fs.writeFile(f.file, Buffer.from([0xff])); await assert.rejects(f.service.save(settings(40000)), safe);
  assert.deepEqual(await fs.readFile(f.file), Buffer.from([0xff]));
  await fs.writeFile(f.file, original); await assert.rejects(f.service.save(settings(40000)), safe);
  assert.deepEqual(await fs.readFile(f.file), original);
});

test('profile paths must be absolute and cannot contain NUL or ambiguous trailing components', async t => {
  for (const dataDirectory of [undefined, '', '.', '../Private', 'Private', `${path.parse(os.tmpdir()).root}Private\0profile`]) {
    assert.throws(() => createSongRequestPreferences({ dataDirectory }), safe);
  }
  const f = await fixture(t);
  const ambiguous = createSongRequestPreferences({ dataDirectory: path.join(f.base, 'ambiguous. ') });
  assertProtected(await ambiguous.load()); await assert.rejects(ambiguous.save(settings()), safe);
  assert.deepEqual(await fs.readdir(f.base), ['Private-profile']);
});
