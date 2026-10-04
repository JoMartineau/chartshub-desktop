const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Module, createRequire } = require('node:module');
const { createSongIniColorResolver } = require('../companion/song-ini-colors.cjs');

const song = (title = 'Track', artist = 'Artist', charter = 'Charter') => ({ title, artist, charter });
const ini = (title = 'Track', artist = 'Artist', charter = '<color=red>Charter') => `[song]\nname = ${title}\nartist = ${artist}\ncharter = ${charter}\n`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-ini-colors-'));
  const game = path.join(base, 'game'), root = path.join(base, 'songs');
  await fs.mkdir(game); await fs.mkdir(root);
  const current = path.join(game, 'currentsong.txt'), settings = path.join(game, 'settings.ini');
  await fs.writeFile(current, '');
  await fs.writeFile(settings, `[directories]\npath0 = ${root}\n`);
  t.after(async () => { if (path.dirname(base) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-ini-colors-')) throw Error('Unexpected fixture directory'); await fs.rm(base, { recursive: true, force: true }); });
  return { base, game, root, current, settings, async write(directory, content = ini()) {
    const folder = path.join(root, directory); await fs.mkdir(folder, { recursive: true });
    const filename = path.join(folder, 'song.ini'); await fs.writeFile(filename, content); return filename;
  } };
}
async function injected(overrides) {
  const filename = require.resolve('../companion/song-ini-colors.cjs'), local = new Module(filename, module), normal = createRequire(filename);
  local.filename = filename; local.paths = Module._nodeModulePaths(path.dirname(filename));
  local.require = name => Object.hasOwn(overrides, name) ? overrides[name] : normal(name);
  local._compile(await fs.readFile(filename, 'utf8'), filename); return local.exports.createSongIniColorResolver;
}

test('exact song.ini colors vary by chart and never inherit another song by the same charter', async t => {
  const f = await fixture(t);
  const rainbow = '<color=#f00>Jo</color><color=#0f0>Martineau';
  const first = await f.write('Sleepwalker', ini('Sleepwalker', 'PRESIDENT', rainbow));
  const second = await f.write('Crisis', ini('Crisis', 'Alexisonfire', '<color=red>JoMartineau'));
  const before = await Promise.all([fs.readFile(first), fs.readFile(second), fs.readFile(f.settings)]);
  const resolve = createSongIniColorResolver();
  assert.deepEqual(await resolve(song('Sleepwalker', 'PRESIDENT', 'JoMartineau'), f.current), { matched: true, segments: [{ text: 'Jo', color: '#ff0000' }, { text: 'Martineau', color: '#00ff00' }] });
  assert.deepEqual(await resolve(song('Crisis', 'Alexisonfire', 'JoMartineau'), f.current), { matched: true, segments: [{ text: 'JoMartineau', color: '#ff0000' }] });
  assert.deepEqual(await resolve(song('Missing', 'PRESIDENT', 'JoMartineau'), f.current), { matched: false });
  assert.deepEqual(await Promise.all([fs.readFile(first), fs.readFile(second), fs.readFile(f.settings)]), before);
});

test('plain exact charts block stale cache colors while duplicate conflicting charts stay ambiguous', async t => {
  const f = await fixture(t); await f.write('plain', ini('Plain', 'Artist', 'Charter'));
  await f.write('duplicate-red', ini('Duplicate')); await f.write('duplicate-blue', ini('Duplicate', 'Artist', '<color=blue>Charter'));
  await f.write('equivalent-a', ini('Equivalent')); await f.write('equivalent-b', ini('Equivalent', 'Artist', '<color=#ff0000>Charter</color>'));
  const resolve = createSongIniColorResolver();
  assert.deepEqual(await resolve(song('Plain'), f.current), { matched: true });
  assert.deepEqual(await resolve(song('Duplicate'), f.current), { matched: true, ambiguous: true });
  assert.deepEqual(await resolve(song('Equivalent'), f.current), { matched: true, segments: [{ text: 'Charter', color: '#ff0000' }] });
});

test('UTF8 BOM and UTF16 metadata support frets fallback, charter priority and exact normalized identities', async t => {
  const f = await fixture(t);
  await f.write('utf8', '\uFEFF[song]\nname = <b>Track</b>\nartist = Artist\nfrets = <color=red>Wrong\ncharter = <color=#08f>CHARTER\n');
  const utf16 = Buffer.from('[song]\r\nname=Été\r\nartist=Artist\r\nfrets=<color=blue>Charter\r\n', 'utf16le');
  await f.write('utf16le', Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]));
  await f.write('utf16be', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('[song]\nname=Other\nartist=Artist\ncharter=<color=lime>Charter\n', 'utf16le').swap16()]));
  const resolve = createSongIniColorResolver();
  assert.deepEqual(await resolve(song('track', 'ARTIST', 'Charter'), f.current), { matched: true, segments: [{ text: 'Charter', color: '#0088ff' }] });
  assert.deepEqual(await resolve(song('Été'), f.current), { matched: true, segments: [{ text: 'Charter', color: '#0000ff' }] });
  assert.deepEqual(await resolve(song('Other'), f.current), { matched: true, segments: [{ text: 'Charter', color: '#00ff00' }] });
  assert.deepEqual(await resolve(song('Track', 'Artist (Live)'), f.current), { matched: false });
  assert.deepEqual(await resolve(song('Track', 'Artist', 'Wrong'), f.current), { matched: false });
});

test('INI candidates are re-read on every lookup so editing or removing source colors takes effect', async t => {
  const f = await fixture(t), filename = await f.write('chart'); const resolve = createSongIniColorResolver();
  const initial = await resolve(song(), f.current); initial.segments[0].color = '#ffffff';
  assert.equal((await resolve(song(), f.current)).segments[0].color, '#ff0000', 'caller mutation cannot change cached data');
  await fs.writeFile(filename, ini('Track', 'Artist', '<color=blue>Charter'));
  assert.deepEqual(await resolve(song(), f.current), { matched: true, segments: [{ text: 'Charter', color: '#0000ff' }] });
  await fs.writeFile(filename, ini('Track', 'Artist', 'Charter'));
  assert.deepEqual(await resolve(song(), f.current), { matched: true });
  await fs.unlink(filename);
  assert.deepEqual(await resolve(song(), f.current), { matched: false, ambiguous: true }, 'a stale index cannot authorize another source');
  assert.deepEqual(await resolve(song(), f.current), { matched: false }, 'the invalidated index rebuilds on the next request');
});

test('quoted song metadata and frets colors match the live text without retaining INI quote delimiters', async t => {
  const f = await fixture(t);
  await f.write('quoted', `[song]\nname="Track"\nartist='Artist'\ncharter=""\nfrets="<color='red'>Charter</color>"\n`);
  assert.deepEqual(await createSongIniColorResolver()(song(), f.current), { matched: true, segments: [{ text: 'Charter', color: '#ff0000' }] });
});

test('persisted completed index reopens without scanning and still re-reads each exact INI for updated colors', async t => {
  const f = await fixture(t), filename = await f.write('chart'); const dataDirectory = path.join(f.base, 'profile');
  assert.equal((await createSongIniColorResolver({ dataDirectory })(song(), f.current)).matched, true);
  const cache = path.join(dataDirectory, 'charter-ini-index.json'), saved = JSON.parse(await fs.readFile(cache, 'utf8'));
  assert.equal(saved.version, 1); assert.deepEqual(saved.entries[0][1], [[0, 'chart/song.ini']]);
  assert.deepEqual(await fs.readdir(dataDirectory), ['charter-ini-index.json']);
  let traversals = 0;
  const factory = await injected({ 'node:fs/promises': { ...fs, opendir: async (...args) => { traversals++; return fs.opendir(...args); } } });
  const reopened = factory({ dataDirectory });
  assert.deepEqual(await reopened(song(), f.current), { matched: true, segments: [{ text: 'Charter', color: '#ff0000' }] });
  assert.equal(traversals, 0, 'restart uses the completed index, not another full traversal');
  await fs.writeFile(filename, ini('Track', 'Artist', '<color=blue>Charter'));
  assert.deepEqual(await reopened(song(), f.current), { matched: true, segments: [{ text: 'Charter', color: '#0000ff' }] });
  assert.equal(traversals, 0, 'color edits require only the matched metadata read');
});

test('invalid persisted relative paths are rejected before access and rebuilt from configured roots', async t => {
  const f = await fixture(t); await f.write('chart'); const dataDirectory = path.join(f.base, 'profile');
  await createSongIniColorResolver({ dataDirectory })(song(), f.current);
  const cache = path.join(dataDirectory, 'charter-ini-index.json'), saved = JSON.parse(await fs.readFile(cache, 'utf8'));
  saved.entries[0][1] = [[0, '../outside/song.ini']]; await fs.writeFile(cache, JSON.stringify(saved));
  let traversals = 0;
  const factory = await injected({ 'node:fs/promises': { ...fs, opendir: async (...args) => { traversals++; return fs.opendir(...args); }, open: async (...args) => {
    assert.ok(!String(args[0]).includes('outside'), 'cache paths cannot escape the configured directory'); return fs.open(...args);
  } } });
  assert.equal((await factory({ dataDirectory })(song(), f.current)).matched, true); assert.ok(traversals > 0);
  assert.deepEqual(JSON.parse(await fs.readFile(cache, 'utf8')).entries[0][1], [[0, 'chart/song.ini']]);
});

test('a known stale persisted index is not loaded repeatedly after a chart identity changes', async t => {
  const f = await fixture(t), filename = await f.write('chart'); const dataDirectory = path.join(f.base, 'profile');
  await createSongIniColorResolver({ dataDirectory })(song(), f.current);
  await fs.writeFile(filename, ini('Renamed', 'Artist', '<color=blue>Charter'));
  let traversals = 0;
  const factory = await injected({ 'node:fs/promises': { ...fs, opendir: async (...args) => { traversals++; return fs.opendir(...args); } } });
  const reopened = factory({ dataDirectory });
  assert.deepEqual(await reopened(song(), f.current), { matched: false, ambiguous: true });
  assert.deepEqual(await reopened(song('Renamed'), f.current), { matched: true, segments: [{ text: 'Charter', color: '#0000ff' }] });
  assert.ok(traversals > 0, 'the stale disk snapshot is bypassed on the next lookup');
});

test('completed index is reused across songs while direct root additions refresh the candidate set', async t => {
  const f = await fixture(t); await f.write('first', ini('First')); await f.write('second', ini('Second'));
  let opened = 0;
  const factory = await injected({ 'node:fs/promises': { ...fs, open: async (...args) => { if (path.basename(args[0]).toLowerCase() === 'song.ini') opened++; return fs.open(...args); } } });
  const resolve = factory(); await resolve(song('First'), f.current); const initialReads = opened;
  await resolve(song('Second'), f.current); assert.equal(opened - initialReads, 1, 'only the matching INI is read after the first complete scan');
  await f.write('third', ini('Third'));
  assert.equal((await resolve(song('Third'), f.current)).matched, true);
});

test('directory settings accept only configured absolute roots, deduplicate overlaps and ignore unrelated sections', async t => {
  const f = await fixture(t), filename = await f.write('nested/chart');
  await fs.writeFile(f.settings, `[other]\npath0=${f.base}\n[directories]\npath0="${f.root}"\npath1=${f.root}\npath2=${path.dirname(filename)}\npath3=relative/songs\n`);
  assert.deepEqual(await createSongIniColorResolver()(song(), f.current), { matched: true, segments: [{ text: 'Charter', color: '#ff0000' }] });
  await fs.writeFile(f.settings, '[directories]\npath0=relative/songs\n');
  assert.deepEqual(await createSongIniColorResolver()(song(), f.current), { matched: false });
  await fs.writeFile(f.settings, '[directories]\n' + Array.from({ length: 17 }, (_, index) => `path${index}=${path.join(f.base, 'root' + index)}`).join('\n'));
  assert.deepEqual(await createSongIniColorResolver()(song(), f.current), { matched: false, ambiguous: true });
});

test('unsupported oversized or invalid-encoding INIs cannot inject colors or prevent supported metadata from matching', async t => {
  const f = await fixture(t); await f.write('supported');
  await f.write('large', ini('Large') + 'x'.repeat(65536)); await f.write('binary', Buffer.from([0xff, 0, 0x81, 0]));
  await f.write('unsafe', ini('Unsafe', 'Artist', '<color="url(secret)">Charter'));
  await f.write('incomplete', '[song]\nname=Incomplete\ncharter=<color=red>Charter\n');
  const resolve = createSongIniColorResolver();
  assert.equal((await resolve(song(), f.current)).matched, true);
  assert.deepEqual(await resolve(song('Large'), f.current), { matched: false });
  assert.deepEqual(await resolve(song('Unsafe'), f.current), { matched: true });
  assert.deepEqual(await resolve(song('Incomplete'), f.current), { matched: false });
});

test('an inaccessible subtree makes a scan unavailable rather than falsely declaring a unique matching chart', async t => {
  const f = await fixture(t); await f.write('readable'); const blocked = path.join(f.root, 'blocked'); await fs.mkdir(blocked);
  const factory = await injected({ 'node:fs/promises': { ...fs, opendir: async (...args) => {
    if (args[0] === blocked) throw Object.assign(Error('Denied'), { code: 'EACCES' }); return fs.opendir(...args);
  } } });
  assert.deepEqual(await factory()(song(), f.current), { matched: false, ambiguous: true });
});

test('cancellation never commits a partial index and a later lookup can complete safely', async t => {
  const f = await fixture(t); const filename = await f.write('chart'), entered = deferred(), gate = deferred(); let hold = true;
  const factory = await injected({ 'node:fs/promises': { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    if (args[0] === filename && hold) { hold = false; const read = handle.read.bind(handle); handle.read = async (...values) => { entered.resolve(); await gate.promise; return read(...values); }; }
    return handle;
  } } });
  const resolve = factory(), controller = new AbortController();
  const pending = resolve(song(), f.current, { signal: controller.signal });
  try {
    await Promise.race([entered.promise, pending.then(() => { throw Error('The resolver finished before reaching the controlled metadata read.'); })]);
    controller.abort(); gate.resolve(); assert.deepEqual(await pending, { matched: false, ambiguous: true });
  } finally {
    controller.abort(); gate.resolve(); await Promise.allSettled([pending]);
  }
  assert.deepEqual(await resolve(song(), f.current), { matched: true, segments: [{ text: 'Charter', color: '#ff0000' }] });
  const aborted = new AbortController(); aborted.abort(); assert.deepEqual(await resolve(song(), f.current, { signal: aborted.signal }), { matched: false, ambiguous: true });
});

test('directory junctions and file links never supply metadata from outside the configured root', async t => {
  const f = await fixture(t); await f.write('ordinary');
  const outside = path.join(f.base, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'song.ini'), ini('Track', 'Artist', '<color=blue>Charter'));
  await fs.symlink(outside, path.join(f.root, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  try { await fs.symlink(path.join(outside, 'song.ini'), path.join(f.root, 'song.ini'), 'file'); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; t.diagnostic('File symlink creation unavailable; directory junction exclusion remains exercised.'); }
  assert.deepEqual(await createSongIniColorResolver()(song(), f.current), { matched: true, segments: [{ text: 'Charter', color: '#ff0000' }] });
});
