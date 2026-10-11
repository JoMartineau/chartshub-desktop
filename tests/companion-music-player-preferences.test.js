'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createMusicPlayerPreferences, DEFAULT_APPEARANCE, validateAppearance, PLAYLIST_LIMITS } = require('../companion/music-player-preferences.cjs');

const settings = (changes = {}) => ({ appearance: { ...DEFAULT_APPEARANCE }, videoEnabled: true, volume: .7, shuffle: false, playlists: [], ...changes });
const document = (changes = {}) => ({ version: 1, ...settings(), ...changes });
const safe = error => error.code === 'MUSIC_PLAYER_PREFERENCES_SAFE' && !error.message.includes('Private');
async function fixture(t, createDirectory = true) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-music-player-prefs-'));
  const dataDirectory = path.join(base, 'Private-profile');
  if (createDirectory) await fs.mkdir(dataDirectory);
  const file = path.join(dataDirectory, 'music-player-preferences.json');
  const lock = path.join(dataDirectory, '.music-player-preferences.lock');
  const service = createMusicPlayerPreferences({ dataDirectory });
  t.after(async () => {
    await service.flush();
    if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-music-player-prefs-')) throw Error('Unsafe temporary fixture');
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, dataDirectory, file, lock, service, fresh: () => createMusicPlayerPreferences({ dataDirectory }) };
}
function assertProtected(state) {
  assert.equal(state.canWrite, false);
  assert.equal(typeof state.error, 'string'); assert.ok(!state.error.includes('Private'));
  assert.deepEqual(state.appearance, DEFAULT_APPEARANCE);
  assert.equal(state.videoEnabled, true); assert.equal(state.volume, .7);
  assert.equal(state.shuffle, false); assert.deepEqual(state.playlists, []);
}

test('status and concurrent absent loads return defaults without creating files or directories', async t => {
  for (const createDirectory of [false, true]) {
    const f = await fixture(t, createDirectory);
    const expected = { ...settings(), error: null, canWrite: true };
    assert.deepEqual(f.service.status(), expected);
    const [first, second] = await Promise.all([f.service.load(), f.service.load()]);
    assert.deepEqual(first, expected); assert.deepEqual(second, expected); assert.deepEqual(await f.service.flush(), expected);
    if (createDirectory) assert.deepEqual(await fs.readdir(f.dataDirectory), []);
    else await assert.rejects(fs.stat(f.dataDirectory), { code: 'ENOENT' });
  }
});

test('all spectrum models, four RGB colors, video and volume survive atomic saves and fresh loads', async t => {
  const f = await fixture(t, false);
  for (const [index, spectrumModel] of ['bars', 'curve', 'circle', 'mirror'].entries()) {
    const input = settings({ appearance: { backgroundColor: '#123ABC', textColor: '#FEDCBA', accentColor: '#00Ff11', secondaryColor: '#Aa22Ee', spectrumModel }, videoEnabled: index % 2 === 0, volume: index / 3 });
    const expected = { ...input, appearance: { ...input.appearance, backgroundColor: '#123abc', textColor: '#fedcba', accentColor: '#00ff11', secondaryColor: '#aa22ee' }, canWrite: true, error: null };
    assert.deepEqual(await f.service.save(input), expected); assert.deepEqual(await f.service.flush(), expected);
    assert.deepEqual(await f.fresh().load(), expected);
    const disk = JSON.parse(await fs.readFile(f.file, 'utf8'));
    assert.deepEqual(disk, { version: 1, appearance: expected.appearance, videoEnabled: input.videoEnabled, volume: input.volume, shuffle: false, playlists: [] });
    assert.deepEqual(Object.keys(disk).sort(), ['appearance', 'playlists', 'shuffle', 'version', 'videoEnabled', 'volume']);
    assert.deepEqual(await fs.readdir(f.dataDirectory), ['music-player-preferences.json']);
    if (process.platform !== 'win32') assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
  }
});

test('invalid inputs and extra session fields cannot create or modify preferences', async t => {
  const f = await fixture(t, false);
  const invalid = [null, {}, [], { ...settings(), playing: true }, { ...settings(), songId: 'private' }, { ...settings(), version: 1 },
    ...[null, 1, 'true', []].map(videoEnabled => settings({ videoEnabled })),
    ...[-.1, 1.1, NaN, Infinity, '0.7', null].map(volume => settings({ volume })),
    ...['#abc', '#12345678', 'red', '#GG0000', '#00ff00\n', null].map(accentColor => settings({ appearance: { ...DEFAULT_APPEARANCE, accentColor } })),
    ...['Bars', '', 'random', null].map(spectrumModel => settings({ appearance: { ...DEFAULT_APPEARANCE, spectrumModel } })),
    settings({ appearance: { ...DEFAULT_APPEARANCE, opacity: .5 } }), settings({ appearance: { accentColor: '#ffffff' } })];
  for (const input of invalid) await assert.rejects(f.service.save(input), safe);
  await assert.rejects(fs.stat(f.dataDirectory), { code: 'ENOENT' });
  const before = await f.service.save(settings()), original = await fs.readFile(f.file);
  for (const input of invalid) await assert.rejects(f.service.save(input), safe);
  assert.deepEqual(f.service.status(), before); assert.deepEqual(await fs.readFile(f.file), original);
});

test('save captures input and callers cannot mutate stored appearance through returned objects', async t => {
  const f = await fixture(t), input = settings({ volume: .2 });
  const task = f.service.save(input); input.volume = 1; input.appearance.backgroundColor = '#ffffff';
  const saved = await task; assert.equal(saved.volume, .2); assert.deepEqual(saved.appearance, DEFAULT_APPEARANCE);
  saved.appearance.accentColor = '#ffffff'; saved.videoEnabled = false; saved.canWrite = false; saved.error = 'private';
  f.service.status().appearance.secondaryColor = '#000000';
  assert.deepEqual(await f.fresh().load(), f.service.status()); assert.deepEqual(f.service.status().appearance, DEFAULT_APPEARANCE);
  const normalized = validateAppearance({ ...DEFAULT_APPEARANCE, accentColor: '#ABCDEF' });
  assert.equal(normalized.accentColor, '#abcdef'); assert.equal(DEFAULT_APPEARANCE.accentColor, '#22d3ee');
});

test('serial saves drain through flush in submission order without orphan lock or temporary files', async t => {
  const f = await fixture(t, false);
  const writes = [f.service.save(settings({ volume: 0 })), f.service.save(settings({ videoEnabled: false, volume: .5 })),
    f.service.save(settings({ appearance: { ...DEFAULT_APPEARANCE, spectrumModel: 'mirror' }, volume: 1 }))];
  const results = Promise.all(writes), flushed = await f.service.flush();
  assert.deepEqual((await results).map(result => result.volume), [0, .5, 1]);
  assert.equal(flushed.appearance.spectrumModel, 'mirror'); assert.equal(flushed.volume, 1); assert.equal(flushed.videoEnabled, true);
  assert.deepEqual(await f.fresh().load(), flushed); assert.deepEqual(await fs.readdir(f.dataDirectory), ['music-player-preferences.json']);
});

test('malformed, future, invalid UTF-8, oversized and invalid-schema originals are preserved', async t => {
  const f = await fixture(t);
  const invalid = ['{ broken Private data', JSON.stringify(document({ version: 2 })), Buffer.from([0xff, 0xfe]),
    Buffer.from([0x7b, 0xc0, 0xaf, 0x7d]), ' '.repeat(256 * 1024 + 1),
    ...[document({ version: 0 }), document({ version: '1' }), document({ volume: 2 }), document({ videoEnabled: 1 }),
      document({ appearance: { ...DEFAULT_APPEARANCE, spectrumModel: 'other' } }), document({ appearance: { ...DEFAULT_APPEARANCE, textColor: '#abc' } }),
      document({ autoplay: true }), { ...settings() }].map(value => JSON.stringify(value))];
  for (const original of invalid) {
    await fs.writeFile(f.file, original); const service = f.fresh();
    assertProtected(await service.load()); await assert.rejects(service.save(settings()), safe);
    assert.deepEqual(await fs.readFile(f.file), Buffer.from(original)); assert.deepEqual(await fs.readdir(f.dataDirectory), ['music-player-preferences.json']);
  }
  await fs.writeFile(f.file, JSON.stringify(document({ version: 2 })));
  assert.match((await f.fresh().load()).error, /version plus récente/);
});

test('256 KiB boundary and UTF-8 BOM are supported without accepting an extra byte', async t => {
  const f = await fixture(t), json = JSON.stringify(document());
  await fs.writeFile(f.file, json.padEnd(256 * 1024, ' ')); assert.equal((await f.fresh().load()).error, null);
  await fs.appendFile(f.file, ' '); assertProtected(await f.fresh().load()); assert.equal((await fs.stat(f.file)).size, 256 * 1024 + 1);
  await fs.writeFile(f.file, '\uFEFF' + json); assert.equal((await f.fresh().load()).error, null);
});

test('external creation, change and deletion are refused without overwrite or resurrection', async t => {
  const f = await fixture(t); await f.service.load();
  const original = JSON.stringify(document({ volume: .2 })); await fs.writeFile(f.file, original);
  await assert.rejects(f.service.save(settings()), safe); assert.equal(await fs.readFile(f.file, 'utf8'), original);
  const current = f.fresh(); await current.load();
  await fs.writeFile(f.file, JSON.stringify(document({ volume: .9 })));
  const changed = await fs.readFile(f.file); await assert.rejects(current.save(settings()), safe);
  assert.deepEqual(await fs.readFile(f.file), changed); assert.equal(current.status().volume, .2); assert.equal(current.status().canWrite, false);
  const removed = f.fresh(); await removed.load(); await fs.unlink(f.file);
  await assert.rejects(removed.save(settings()), safe); await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  await fs.writeFile(f.file, changed); await assert.rejects(removed.save(settings()), safe); assert.deepEqual(await fs.readFile(f.file), changed);
});

test('same-content replacement and hardlinks are rejected by identity', async t => {
  const f = await fixture(t); await f.service.save(settings()); const original = await fs.readFile(f.file);
  const backup = path.join(f.dataDirectory, 'original-backup.json'); await fs.rename(f.file, backup); await fs.writeFile(f.file, original);
  await assert.rejects(f.service.save(settings({ volume: 0 })), safe);
  assert.deepEqual(await fs.readFile(f.file), original); assert.deepEqual(await fs.readFile(backup), original);
  await fs.unlink(f.file); await fs.link(backup, f.file);
  const linked = f.fresh(); assertProtected(await linked.load()); await assert.rejects(linked.save(settings()), safe);
  assert.deepEqual(await fs.readFile(backup), original);
});

test('junction or symlink directories and ancestors are refused without touching targets', async t => {
  const f = await fixture(t), target = path.join(f.base, 'real-profile'); await fs.mkdir(target);
  const alias = path.join(f.base, 'linked-profile'); await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const dataDirectory of [alias, path.join(alias, 'nested')]) {
    const linked = createMusicPlayerPreferences({ dataDirectory }); assertProtected(await linked.load()); await assert.rejects(linked.save(settings()), safe);
  }
  assert.deepEqual(await fs.readdir(target), []);
});

test('directory, junction and available file symlinks at the preferences path are preserved', async t => {
  const f = await fixture(t); await fs.mkdir(f.file);
  assertProtected(await f.service.load()); await assert.rejects(f.service.save(settings()), safe); assert.deepEqual(await fs.readdir(f.file), []);
  await fs.rmdir(f.file);
  const target = path.join(f.base, 'file-link-target'); await fs.mkdir(target); await fs.writeFile(path.join(target, 'Private.txt'), 'untouched');
  await fs.symlink(target, f.file, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = f.fresh(); assertProtected(await linked.load()); await assert.rejects(linked.save(settings()), safe);
  assert.equal(await fs.readFile(path.join(target, 'Private.txt'), 'utf8'), 'untouched');
  await fs.unlink(f.file);
  const targetFile = path.join(target, 'original.json'), original = JSON.stringify(document()); await fs.writeFile(targetFile, original);
  try { await fs.symlink(targetFile, f.file, 'file'); }
  catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error; return; }
  const fileLink = f.fresh(); assertProtected(await fileLink.load()); await assert.rejects(fileLink.save(settings()), safe);
  assert.equal(await fs.readFile(targetFile, 'utf8'), original);
});

test('removed or replaced profile directories cannot receive stale saves, even with absent initial files', async t => {
  for (const initialFile of [false, true]) {
    const f = await fixture(t); if (initialFile) await f.service.save(settings()); else await f.service.load();
    const backup = path.join(f.base, 'profile-backup'); await fs.rename(f.dataDirectory, backup);
    await assert.rejects(f.service.save(settings({ volume: 0 })), safe); await assert.rejects(fs.stat(f.dataDirectory), { code: 'ENOENT' });
    await fs.mkdir(f.dataDirectory);
    if (initialFile) await fs.copyFile(path.join(backup, 'music-player-preferences.json'), f.file);
    const originalEntries = await fs.readdir(f.dataDirectory);
    await assert.rejects(f.service.save(settings()), safe); assert.deepEqual(await fs.readdir(f.dataDirectory), originalEntries);
    assert.deepEqual(await fs.readdir(backup), initialFile ? ['music-player-preferences.json'] : []);
  }
});

test('unsafe changed bytes permanently protect the loaded instance even after valid bytes return', async t => {
  const f = await fixture(t); await f.service.save(settings()); const original = await fs.readFile(f.file);
  await fs.writeFile(f.file, Buffer.from([0xff])); await assert.rejects(f.service.save(settings({ volume: 0 })), safe);
  assert.deepEqual(await fs.readFile(f.file), Buffer.from([0xff])); assert.equal(f.service.status().canWrite, false);
  await fs.writeFile(f.file, original); await assert.rejects(f.service.save(settings()), safe); assert.deepEqual(await fs.readFile(f.file), original);
});

test('absolute paths and unambiguous components are required before writing', async t => {
  for (const dataDirectory of [undefined, '', '.', '../Private', 'Private', `${path.parse(os.tmpdir()).root}Private\0profile`]) assert.throws(() => createMusicPlayerPreferences({ dataDirectory }), safe);
  const f = await fixture(t), ambiguous = createMusicPlayerPreferences({ dataDirectory: path.join(f.base, 'ambiguous. ') });
  assertProtected(await ambiguous.load()); await assert.rejects(ambiguous.save(settings()), safe); assert.deepEqual(await fs.readdir(f.base), ['Private-profile']);
});

test('occupied writer locks are preserved and retry succeeds after the other writer releases them', async t => {
  const f = await fixture(t); const initial = await f.service.save(settings()), original = await fs.readFile(f.file);
  await fs.writeFile(f.lock, 'Other Private writer'); await assert.rejects(f.service.save(settings({ volume: 0 })), safe);
  assert.equal(f.service.status().canWrite, true); assert.equal(f.service.status().volume, initial.volume);
  assert.deepEqual(await fs.readFile(f.file), original); assert.equal(await fs.readFile(f.lock, 'utf8'), 'Other Private writer');
  await fs.unlink(f.lock); assert.equal((await f.service.save(settings({ volume: 0 }))).error, null);
  assert.deepEqual(await fs.readdir(f.dataDirectory), ['music-player-preferences.json']);
});

test('failed atomic rename preserves the original file, cleans owned temporary files and supports retry', async t => {
  const f = await fixture(t); await f.service.save(settings()); const original = await fs.readFile(f.file), rename = fs.rename;
  const mock = t.mock.method(fs, 'rename', async (...args) => { if (args[1] === f.file) throw Object.assign(new Error('Private rename failure'), { code: 'EACCES' }); return rename(...args); });
  await assert.rejects(f.service.save(settings({ volume: 0 })), safe); assert.equal(f.service.status().canWrite, true);
  assert.deepEqual(await fs.readFile(f.file), original); assert.deepEqual(await fs.readdir(f.dataDirectory), ['music-player-preferences.json']);
  mock.mock.restore(); assert.equal((await f.service.save(settings({ volume: 0 }))).volume, 0);
});

test('a removed or replaced writer lock during writing blocks commit and preserves another owner', async t => {
  for (const replace of [false, true]) {
    const f = await fixture(t); await f.service.save(settings()); const original = await fs.readFile(f.file), open = fs.open;
    let changed = false;
    const mock = t.mock.method(fs, 'open', async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('.tmp') && !changed) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { changed = true; await fs.unlink(f.lock); if (replace) await fs.writeFile(f.lock, 'Other Private writer'); return sync(); };
      }
      return handle;
    });
    await assert.rejects(f.service.save(settings({ volume: 0 })), safe); mock.mock.restore();
    assert.ok(changed); assert.equal(f.service.status().canWrite, false); assert.deepEqual(await fs.readFile(f.file), original);
    if (replace) assert.equal(await fs.readFile(f.lock, 'utf8'), 'Other Private writer');
    else await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
    assert.deepEqual((await fs.readdir(f.dataDirectory)).sort(), replace ? ['.music-player-preferences.lock', 'music-player-preferences.json'] : ['music-player-preferences.json']);
  }
});

for (const mutation of ['content', 'hardlink', 'replacement', 'destination']) {
  test(`a ${mutation} change during temporary writing cannot overwrite the approved destination`, async t => {
    const f = await fixture(t); await f.service.save(settings()); const original = await fs.readFile(f.file), open = fs.open;
    const backup = path.join(f.dataDirectory, 'Private-external-copy.tmp');
    let changed = false, external = null, candidate = null;
    const mock = t.mock.method(fs, 'open', async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('.tmp') && !changed) {
        const sync = handle.sync.bind(handle); candidate = String(args[0]);
        handle.sync = async () => {
          await sync(); changed = true;
          if (mutation === 'content') { external = JSON.stringify(document({ volume: .9 })); await fs.writeFile(candidate, external); }
          if (mutation === 'hardlink') await fs.link(candidate, backup);
          if (mutation === 'replacement') { await fs.rename(candidate, backup); external = 'Other Private writer'; await fs.writeFile(candidate, external); }
          if (mutation === 'destination') { external = JSON.stringify(document({ volume: .9 })); await fs.writeFile(f.file, external); }
        };
      }
      return handle;
    });
    await assert.rejects(f.service.save(settings({ volume: 0 })), safe); mock.mock.restore();
    assert.ok(changed); assert.equal(f.service.status().canWrite, false); assert.equal(f.service.status().volume, .7);
    assert.deepEqual(await fs.readFile(f.file), mutation === 'destination' ? Buffer.from(external) : original);
    if (mutation === 'replacement') assert.equal(await fs.readFile(candidate, 'utf8'), external);
    else await assert.rejects(fs.stat(candidate), { code: 'ENOENT' });
    if (mutation === 'hardlink' || mutation === 'replacement') assert.equal(JSON.parse(await fs.readFile(backup, 'utf8')).volume, 0);
    await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
  });
}

const songId = index => index.toString(16).padStart(64, '0');
const playlist = (name = 'My Songs', songIds = [], changes = {}) => ({ id: randomUUID(), name, rootKey: 'a'.repeat(64), songIds, ...changes });

test('playlist creation, rename, membership changes and shuffle persist together through fresh instances', async t => {
  const f = await fixture(t), first = playlist('  Rock mix  ', [songId(1), songId(2)]), other = playlist('Other Songs', [songId(3)], { rootKey: 'b'.repeat(64) });
  const created = await f.service.save(settings({ playlists: [first, other], shuffle: true }));
  assert.equal(created.playlists[0].name, 'Rock mix'); assert.equal(created.shuffle, true);
  assert.deepEqual(await f.fresh().load(), created);
  const renamed = { ...created.playlists[0], name: 'Concert set', songIds: [songId(2), songId(4)] };
  const changed = await f.service.save(settings({ playlists: [renamed, other], shuffle: false })); await f.service.flush();
  assert.deepEqual(await f.fresh().load(), changed); assert.equal(changed.playlists[0].id, first.id);
  const removed = await f.service.save(settings({ playlists: [renamed] }));
  assert.equal((await f.fresh().load()).playlists.length, 1); assert.deepEqual(removed.playlists[0].songIds, [songId(2), songId(4)]);
  const disk = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.deepEqual(Object.keys(disk).sort(), ['appearance', 'playlists', 'shuffle', 'version', 'videoEnabled', 'volume']);
  assert.equal(JSON.stringify(disk).includes('path'), false); assert.deepEqual(await fs.readdir(f.dataDirectory), ['music-player-preferences.json']);
});

test('legacy exact four-field documents load without writes and migrate only on explicit save', async t => {
  const f = await fixture(t), original = JSON.stringify({ version: 1, appearance: { ...DEFAULT_APPEARANCE, spectrumModel: 'curve' }, videoEnabled: false, volume: .3 });
  await fs.writeFile(f.file, original); const before = await fs.stat(f.file, { bigint: true });
  const state = await f.service.load(); assert.equal(state.shuffle, false); assert.deepEqual(state.playlists, []); assert.equal(state.volume, .3);
  assert.equal(await fs.readFile(f.file, 'utf8'), original); const after = await fs.stat(f.file, { bigint: true });
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
  await f.service.save({ appearance: state.appearance, videoEnabled: state.videoEnabled, volume: state.volume });
  const saved = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.equal(saved.version, 1); assert.equal(saved.shuffle, false); assert.deepEqual(saved.playlists, []);
  assert.deepEqual(await f.fresh().load(), f.service.status());
});

test('legacy three-field saves and optional updates preserve stored playlists or shuffle when omitted', async t => {
  const f = await fixture(t), lists = [playlist('Retained', [songId(1)])];
  await f.service.save(settings({ shuffle: true, playlists: lists }));
  const legacy = { appearance: { ...DEFAULT_APPEARANCE }, videoEnabled: false, volume: .2 };
  const saved = await f.service.save(legacy); assert.equal(saved.shuffle, true); assert.deepEqual(saved.playlists, lists);
  await f.service.save({ ...legacy, shuffle: false }); assert.deepEqual(f.service.status().playlists, lists);
  await f.service.save({ ...legacy, playlists: [] }); assert.equal(f.service.status().shuffle, false); assert.deepEqual(f.service.status().playlists, []);
  assert.deepEqual(await f.fresh().load(), f.service.status());
});

test('playlist inputs are captured before queuing and status exposes deep copies only', async t => {
  const f = await fixture(t), input = settings({ playlists: [playlist('Captured', [songId(1)])], shuffle: true });
  const captured = structuredClone(input.playlists), task = f.service.save(input);
  input.playlists[0].name = 'Changed'; input.playlists[0].songIds.push(songId(2)); input.playlists.push(playlist()); input.shuffle = false;
  const saved = await task; assert.deepEqual(saved.playlists, captured); assert.equal(saved.shuffle, true);
  saved.playlists[0].songIds.push(songId(3)); saved.playlists[0].name = 'External'; saved.playlists.push(playlist());
  f.service.status().playlists[0].songIds.length = 0;
  assert.deepEqual(f.service.status().playlists, captured); assert.deepEqual(await f.fresh().load(), f.service.status());
});

test('serial optional saves merge preserved playlist fields using the latest committed document', async t => {
  const f = await fixture(t), legacy = { appearance: { ...DEFAULT_APPEARANCE }, videoEnabled: true, volume: .7 }, lists = [playlist('Queued', [songId(1)])];
  const tasks = [f.service.save({ ...legacy, playlists: lists }), f.service.save({ ...legacy, shuffle: true }), f.service.save({ ...legacy, volume: .4 })];
  const joined = Promise.all(tasks), state = await f.service.flush(); await joined;
  assert.equal(state.shuffle, true); assert.equal(state.volume, .4); assert.deepEqual(state.playlists, lists);
  assert.deepEqual(await f.fresh().load(), state);
});

test('playlist IDs, root scope, names, member IDs and extra capabilities are strictly validated before writing', async t => {
  const f = await fixture(t, false), valid = playlist('Valid', [songId(1)]);
  const invalidLists = [null, {}, [null], [playlist('', [])], [playlist(' '.repeat(10), [])], [playlist('x'.repeat(101), [])],
    [playlist('line\nother', [])], [playlist('hidden\u202ename', [])],
    ...['not-a-uuid', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', '00000000-0000-0000-0000-000000000000'].map(id => [playlist('Valid', [], { id })]),
    ...['not-a-root', 'A'.repeat(64), '../Songs'].map(rootKey => [playlist('Valid', [], { rootKey })]),
    [playlist('Valid', ['../notes.chart'])], [playlist('Valid', [songId(1), songId(1)])], [playlist('Valid', [], { path: 'PRIVATE' })],
    [playlist('Valid', [], { songIds: 'PRIVATE' })], [valid, { ...valid, rootKey: 'b'.repeat(64) }]];
  for (const playlists of invalidLists) await assert.rejects(f.service.save(settings({ playlists })), safe);
  for (const shuffle of [null, 0, 1, 'true', []]) await assert.rejects(f.service.save(settings({ shuffle })), safe);
  await assert.rejects(fs.stat(f.dataDirectory), { code: 'ENOENT' });
  await f.service.save(settings({ playlists: [valid], shuffle: true })); const original = await fs.readFile(f.file), before = f.service.status();
  for (const playlists of invalidLists) await assert.rejects(f.service.save(settings({ playlists })), safe);
  assert.deepEqual(await fs.readFile(f.file), original); assert.deepEqual(f.service.status(), before);
});

test('20 playlists, 500 members and 2500 total references are supported, with every next boundary refused', async t => {
  const f = await fixture(t);
  const empty = Array.from({ length: PLAYLIST_LIMITS.playlists }, (_, index) => playlist('List ' + index));
  assert.equal((await f.service.save(settings({ playlists: empty }))).playlists.length, 20);
  await assert.rejects(f.service.save(settings({ playlists: [...empty, playlist('Extra')] })), safe);
  const members = Array.from({ length: 500 }, (_, index) => songId(index));
  const filled = Array.from({ length: 5 }, (_, index) => playlist('Full ' + index, members));
  const saved = await f.service.save(settings({ playlists: filled })); assert.equal(saved.playlists.flatMap(value => value.songIds).length, 2500);
  assert.ok((await fs.stat(f.file)).size > 8192); assert.ok((await fs.stat(f.file)).size < 256 * 1024);
  assert.deepEqual(await f.fresh().load(), saved);
  await assert.rejects(f.service.save(settings({ playlists: [playlist('Over member limit', [...members, songId(500)])] })), safe);
  await assert.rejects(f.service.save(settings({ playlists: [...filled, playlist('Over total', [songId(1)])] })), safe);
  assert.deepEqual(f.service.status(), saved);
});

test('invalid new playlist documents and partial schema migrations preserve originals', async t => {
  const f = await fixture(t);
  const invalid = [document({ shuffle: 1 }), document({ playlists: [{ ...playlist(), songIds: ['PRIVATE'] }] }),
    { version: 1, ...settings(), playlists: undefined }, { version: 1, ...settings(), shuffle: undefined }];
  for (const value of invalid) {
    const original = JSON.stringify(value); await fs.writeFile(f.file, original); const current = f.fresh();
    assertProtected(await current.load()); await assert.rejects(current.save(settings()), safe); assert.equal(await fs.readFile(f.file, 'utf8'), original);
  }
});
