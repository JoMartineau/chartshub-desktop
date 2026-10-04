const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createCharterColorResolver } = require('../companion/charter-color-resolver.cjs');

const row = (Charter, patch = {}) => ({ Name: 'First Song', Artist: 'First Artist', Charter, ...patch });
const song = { title: 'First Song', artist: 'First Artist', charter: 'Creator' };
async function fixture(t, rows = [row('<color=#ff0000>Creator</color>')]) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-charter-'));
  const root = await fs.realpath(temporary), current = path.join(root, 'currentsong.txt'), cache = path.join(root, 'songs.json');
  await fs.writeFile(current, 'First Song\nFirst Artist\nCreator');
  await fs.writeFile(cache, JSON.stringify(rows));
  t.after(async () => {
    if (path.dirname(root) !== await fs.realpath(os.tmpdir()) || !path.basename(root).startsWith('chartshub-charter-')) throw Error('Unsafe fixture cleanup');
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, current, cache, resolve: createCharterColorResolver(), write: rows => fs.writeFile(cache, JSON.stringify(rows)) };
}

test('charter resolver recovers the real per-letter JoMartineau format including an unclosed final color', async t => {
  const colors = ['#ff0000', '#ff8b00', '#e7ff00', '#5cff00', '#00ff2e', '#00ffb9', '#00b9ff', '#002eff', '#5c00ff', '#e700ff', '#ff008b'];
  const name = 'JoMartineau', text = [...name].map((letter, index) => `<color=${colors[index]}>${letter}${index < name.length - 1 ? '</color>' : ''}`).join('');
  const f = await fixture(t, [row(text, { Name: 'Antimatter', Artist: 'Silent Planet' }), row('<b><color=#8700ff>Other Charter</color></b>', { Name: '<color=#ff0000>Antimatter</color>', Artist: 'Silent Planet' })]);
  const result = await f.resolve({ title: 'Antimatter', artist: 'Silent Planet', charter: name }, f.current);
  assert.deepEqual(result, [...name].map((letter, index) => ({ text: letter, color: colors[index] })));
});

test('charter resolver handles successive songs and different charters without any chart-specific names or stale styles', async t => {
  const f = await fixture(t, [row('<color=#ff0000>Creator</color>'), row('<color=#00ff00>Another</color> Author', { Name: 'Second Song', Artist: 'Second Artist' })]);
  assert.deepEqual(await f.resolve(song, f.current), [{ text: 'Creator', color: '#ff0000' }]);
  const second = await f.resolve({ title: 'Second Song', artist: 'Second Artist', charter: 'Another Author' }, f.current);
  assert.ok(second); assert.equal(second.map(item => item.text).join(''), 'Another Author');
  assert.equal(second[0].color, '#00ff00');
  assert.equal(await f.resolve({ ...song, charter: 'Missing Charter' }, f.current), undefined);
  assert.deepEqual(await f.resolve(song, f.current), [{ text: 'Creator', color: '#ff0000' }]);
});

test('charter resolver requires the exact normalized title, artist and charter, preserving version qualifiers and accents', async t => {
  const f = await fixture(t);
  for (const update of [{ title: 'First Song (Live)' }, { title: 'First-Song' }, { title: 'Fírst Song' }, { artist: 'Other Artist' }, { charter: 'Different' }, { charter: '' }, { artist: '' }]) {
    assert.equal(await f.resolve({ ...song, ...update }, f.current), undefined);
  }
  assert.ok(await f.resolve({ ...song, title: ' FIRST   SONG ', artist: 'first artist' }, f.current));
  await f.write([row('<b><color=#ff0000>Creator</color></b>', { Name: '<color=#00ff00>First Song</color>' })]);
  assert.deepEqual(await f.resolve(song, f.current), [{ text: 'Creator', color: '#ff0000' }]);
});

test('charter resolver rejects conflicting styles and plain-versus-colored duplicates but accepts equal parsed styles', async t => {
  const f = await fixture(t);
  for (const values of [
    [row('<color=#ff0000>Creator</color>'), row('<color=#00ff00>Creator</color>')],
    [row('<color=#ff0000>Creator</color>'), row('Creator')],
    [row('Creator'), row('<color=#ff0000>Creator</color>')]
  ]) { await f.write(values); assert.equal(await f.resolve(song, f.current), undefined); }
  await f.write([row('<color=#FF0000>Creator</color>'), row('<b><color=#ff0000>Creator</color></b>'), row('<color=#ff0000>Creator</color>')]);
  assert.deepEqual(await f.resolve(song, f.current), [{ text: 'Creator', color: '#ff0000' }]);
});

test('charter resolver reads an unchanged cache once, shares concurrent loads, returns clones and reloads changed contents', async t => {
  const f = await fixture(t), open = fs.open; let reads = 0;
  t.mock.method(fs, 'open', async function (filename, ...args) { if (filename === f.cache) reads++; return open.call(fs, filename, ...args); });
  const results = await Promise.all(Array.from({ length: 12 }, () => f.resolve(song, f.current)));
  assert.equal(reads, 1); assert.ok(results.every(result => result?.[0].color === '#ff0000'));
  results[0][0].color = '#abcdef'; results[0].push({ text: 'injected' });
  assert.deepEqual(await f.resolve(song, f.current), [{ text: 'Creator', color: '#ff0000' }]); assert.equal(reads, 1);
  await f.write([row('<color=#0000ff>Creator</color>'), row('Unrelated')]);
  assert.deepEqual(await f.resolve(song, f.current), [{ text: 'Creator', color: '#0000ff' }]); assert.equal(reads, 2);
});

test('charter resolver retains no more than two source caches and does not mix identical names across source folders', async t => {
  const a = await fixture(t), b = await fixture(t, [row('<color=#00ff00>Creator</color>')]), c = await fixture(t, [row('<color=#0000ff>Creator</color>')]);
  const resolve = createCharterColorResolver(), open = fs.open, reads = new Map();
  t.mock.method(fs, 'open', async function (filename, ...args) { reads.set(filename, (reads.get(filename) ?? 0) + 1); return open.call(fs, filename, ...args); });
  assert.equal((await resolve(song, a.current))[0].color, '#ff0000');
  assert.equal((await resolve(song, b.current))[0].color, '#00ff00');
  assert.equal((await resolve(song, c.current))[0].color, '#0000ff');
  assert.equal((await resolve(song, b.current))[0].color, '#00ff00'); assert.equal(reads.get(b.cache), 1);
  assert.equal((await resolve(song, a.current))[0].color, '#ff0000'); assert.equal(reads.get(a.cache), 2);
});

test('charter resolver fails quietly for missing, malformed and oversized cache data without reading another location', async t => {
  const f = await fixture(t);
  await fs.unlink(f.cache); assert.equal(await f.resolve(song, f.current), undefined);
  await fs.writeFile(f.cache, 'not JSON'); assert.equal(await f.resolve(song, f.current), undefined);
  for (const invalid of [{ songs: [row('<color=#ff0000>Creator</color>')] }, null, Array(100001).fill(null)]) {
    await f.write(invalid); assert.equal(await f.resolve(song, f.current), undefined);
  }
  const handle = await fs.open(f.cache, 'w'); await handle.truncate(64 * 1024 * 1024 + 1); await handle.close();
  assert.equal(await f.resolve(song, f.current), undefined);
  for (const current of [null, '', '../currentsong.txt', 'file:///private', f.current + '\0']) assert.equal(await f.resolve(song, current), undefined);
});

test('charter resolver rejects cache directory links and linked files, never following paths supplied inside cache rows', async t => {
  const f = await fixture(t), target = path.join(f.root, 'target'); await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'songs.json'), JSON.stringify([row('<color=#00ff00>Creator</color>')]));
  const linked = path.join(f.root, 'linked'); await fs.symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await f.resolve(song, path.join(linked, 'currentsong.txt')), undefined);
  await fs.unlink(f.cache); await fs.mkdir(f.cache); assert.equal(await f.resolve(song, f.current), undefined); await fs.rmdir(f.cache);
  try { await fs.symlink(path.join(target, 'songs.json'), f.cache, 'file'); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; t.diagnostic('File symlink creation unavailable; directory junction protection exercised.'); }
  assert.equal(await f.resolve(song, f.current), undefined);
  await fs.rm(f.cache, { force: true });
  await f.write([row('Creator', { filePath: path.join(target, 'songs.json'), CharterColorFile: path.join(target, 'songs.json') })]);
  assert.equal(await f.resolve(song, f.current), undefined);
});

test('charter resolver bounds metadata fields, ignores unsupported rows and cannot return unvalidated markup or URLs as a style', async t => {
  const f = await fixture(t, [null, [], { Name: 'First Song', Artist: 'First Artist', Charter: {} },
    row('<color=url(https://private.invalid)>Creator</color>'), row('x'.repeat(8193)), row('<color=#ff0000>Creator</color>', { Name: 'x'.repeat(513) })]);
  assert.equal(await f.resolve(song, f.current), undefined);
  await f.write([null, row('<color=#ff0000>Creator</color>')]);
  const result = await f.resolve(song, f.current);
  assert.deepEqual(result, [{ text: 'Creator', color: '#ff0000' }]);
  assert.equal(await f.resolve({ ...song, title: 'x'.repeat(8193) }, f.current), undefined);
  assert.doesNotMatch(JSON.stringify(result), /<|https:|filePath|CharterColorFile/);
});

test('charter resolver reads the matching song.ini before stale songs.json and preserves chart-specific palettes', async t => {
  const f = await fixture(t), songs = path.join(f.root, 'local-songs');
  await fs.mkdir(songs);
  await fs.writeFile(path.join(f.root, 'settings.ini'), '[directories]\npath0 = ' + songs + '\n');
  const folders = ['a', 'b', 'plain'];
  for (const folder of folders) await fs.mkdir(path.join(songs, folder));
  await fs.writeFile(path.join(songs, 'a/song.ini'), '[song]\nname=First Song\nartist=First Artist\ncharter=<color=#0000ff>Creator</color>\n');
  await fs.writeFile(path.join(songs, 'b/song.ini'), '[song]\nname=Second Song\nartist=First Artist\ncharter=<color=#00ff00>Creator</color>\n');
  await fs.writeFile(path.join(songs, 'plain/song.ini'), '[song]\nname=Plain Song\nartist=First Artist\ncharter=Creator\n');
  await f.write([row('<color=#ff0000>Creator</color>'), row('<color=#ff0000>Creator</color>', { Name: 'Plain Song' })]);
  assert.deepEqual(await f.resolve(song, f.current), [{ text: 'Creator', color: '#0000ff' }]);
  assert.deepEqual(await f.resolve({ ...song, title: 'Second Song' }, f.current), [{ text: 'Creator', color: '#00ff00' }]);
  assert.equal(await f.resolve({ ...song, title: 'Plain Song' }, f.current), undefined);
  assert.equal(await f.resolve({ ...song, title: 'Missing Song' }, f.current), undefined);
});

test('charter resolver suppresses old exported colors for incomplete or ambiguous local matches and honors cancellation', async t => {
  const f = await fixture(t);
  for (const local of [{ matched: false, ambiguous: true }, { matched: true, ambiguous: true }, { matched: true }, { matched: true, segments: [{ text: 'Wrong Name', color: '#0000ff' }] }]) {
    const resolve = createCharterColorResolver({ resolveLocal: async () => local });
    assert.equal(await resolve(song, f.current), undefined);
  }
  const controller = new AbortController(); let calls = 0;
  const resolve = createCharterColorResolver({ resolveLocal: async () => { calls++; controller.abort(); return { matched: false }; } });
  assert.equal(await resolve(song, f.current, { signal: controller.signal }), undefined);
  assert.equal(calls, 1);
  assert.equal(await resolve(song, f.current, { signal: controller.signal }), undefined);
  assert.equal(calls, 1);
});
