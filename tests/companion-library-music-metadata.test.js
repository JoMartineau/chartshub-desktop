'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createInstalledLibraryService } = require('../companion/library-service.cjs');
const { createBackgroundLibraryService } = require('../companion/library-background.cjs');
const { scanLibrary, SCANNER_LIMITS } = require('../companion/library-scanner.cjs');

const notes = genre => '[Song]\n{\n Name = "Synthetic"\n Artist = "Band"\n' + (genre === undefined ? '' : ` Genre = "${genre}"\n`) + '}\n'
  + '[EasySingle]\n{\n 0 = N 0 0\n}\n[ExpertDrums]\n{\n 0 = N 1 0\n 0 = N 66 0\n}\n';
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-music-metadata-')), root = path.join(base, 'Songs'), data = path.join(base, 'Profile');
  await fs.mkdir(root); await fs.mkdir(data); const services = [];
  const create = (factory = createInstalledLibraryService) => { const service = factory({ dataDirectory: data }); services.push(service); return service; };
  t.after(async () => {
    for (const service of services) await service.stop();
    if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-music-metadata-')) throw Error('Unsafe temporary fixture');
    await fs.rm(base, { recursive: true, force: true });
  });
  return { root, data, file: path.join(data, 'library.json'), create };
}
async function song(f, name, chart = notes(), ini) {
  const folder = path.join(f.root, name); await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'notes.chart'), chart);
  if (ini !== undefined) await fs.writeFile(path.join(folder, 'song.ini'), ini);
  return folder;
}
async function settled(service) {
  const until = Date.now() + 6000;
  while (service.status().status === 'scanning') { if (Date.now() > until) throw Error('Metadata scan timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(service.status().status, 'ready');
}
function midi() {
  const header = Buffer.alloc(14); header.write('MThd'); header.writeUInt32BE(6, 4); header.writeUInt16BE(1, 8); header.writeUInt16BE(2, 10); header.writeUInt16BE(480, 12);
  return Buffer.concat([header, ...[['PART GUITAR', 60], ['PART DRUMS', 96]].map(([name, note]) => {
    const text = Buffer.from(name), body = Buffer.concat([Buffer.from([0, 255, 3, text.length]), text, Buffer.from([0, 144, note, 100, 0, 255, 47, 0])]);
    const chunk = Buffer.alloc(8); chunk.write('MTrk'); chunk.writeUInt32BE(body.length, 4); return Buffer.concat([chunk, body]);
  })]);
}

test('real song.ini genre overrides chart fallback, strips markup, remains bounded and is never inferred', async t => {
  const f = await fixture(t);
  const first = await song(f, 'INI', notes('Rock'), '[Song]\nname=INI\ngenre=<color=#ff00ff>Métal progressif</color>\n');
  await song(f, 'Fallback', notes('Électro'));
  await song(f, 'Absent', notes(), '[Song]\nname=Metal title\n[Other]\ngenre=Invented\n');
  await song(f, 'Conflict', notes('Rock'), '[Song]\ngenre=Metal\ngenre=Pop\n');
  await song(f, 'Bounded', notes(), `[Song]\ngenre=<b>${'x'.repeat(600)}</b>\n`);
  const original = await fs.readFile(path.join(first, 'song.ini')), service = f.create(); await service.selectRoot(f.root); await settled(service);
  const items = service.queryPlayback({ query: '' }).items;
  const byFolder = JSON.parse(await fs.readFile(f.file, 'utf8')).items;
  assert.equal(byFolder.find(item => item.folderRelativePath === 'INI').genre, 'Métal progressif');
  assert.equal(byFolder.find(item => item.folderRelativePath === 'Fallback').genre, 'Électro');
  assert.equal(byFolder.find(item => item.folderRelativePath === 'Absent').genre, undefined);
  assert.equal(byFolder.find(item => item.folderRelativePath === 'Conflict').genre, undefined);
  assert.equal(byFolder.find(item => item.folderRelativePath === 'Bounded').genre.length, 512);
  assert.equal(service.queryPlayback({ query: '', filters: { genre: 'metal' } }).total, 1);
  assert.equal(service.queryPlayback({ query: 'electro' }).total, 1);
  assert.deepEqual(await fs.readFile(path.join(first, 'song.ini')), original); assert.ok(items.every(item => !Object.hasOwn(item, 'relativePath')));
});

test('chart and MIDI index playable track pairs; combined filters cannot cross guitar and drum difficulties', async t => {
  const f = await fixture(t); await song(f, 'Chart');
  const directory = path.join(f.root, 'Midi'); await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'notes.mid'), midi());
  await fs.writeFile(path.join(directory, 'song.ini'), '[Song]\nname=MIDI\ngenre=Jazz\n');
  const service = f.create(); await service.selectRoot(f.root); await settled(service);
  assert.equal(service.queryPlayback({ query: '', filters: { instrument: 'drums', difficulty: 'easy' } }).total, 0);
  assert.equal(service.queryPlayback({ query: '', filters: { instrument: 'drums', difficulty: 'expert' } }).total, 2);
  assert.equal(service.queryPlayback({ query: '', filters: { instrument: 'pro-drums', difficulty: 'expert' } }).total, 1);
  assert.equal(service.queryPlayback({ query: '', filters: { instrument: 'guitar', difficulty: 'easy', genre: 'Jazz' } }).total, 1);
  const actual = service.queryPlayback({ query: '', filters: { genre: 'Jazz' } }).items[0];
  assert.deepEqual(actual.tracks, [{ instrument: 'guitar', difficulty: 'easy' }, { instrument: 'drums', difficulty: 'expert' }]);
  const open = t.mock.method(fs, 'open', async () => { throw Error('Search must use the index without opening notes or audio'); });
  assert.equal(service.queryPlayback({ query: '', filters: { genre: 'Jazz', instrument: 'guitar', difficulty: 'easy' } }).total, 1); open.mock.restore();
});

test('legacy version1 caches load unchanged then quick scan enriches genre and tracks, with stable IDs and unchanged next scans', async t => {
  const f = await fixture(t); await song(f, 'Installed', notes('Rock'), '[Song]\nname=Installed\ngenre=Metal\n');
  const initial = f.create(); await initial.selectRoot(f.root); await settled(initial); await initial.stop();
  const stored = JSON.parse(await fs.readFile(f.file, 'utf8')), id = stored.items[0].id;
  for (const item of stored.items) { delete item.genre; delete item.tracks; delete item.musicMetadataVersion; }
  const legacy = JSON.stringify(stored); await fs.writeFile(f.file, legacy);
  const service = f.create(); await service.load(); assert.equal(service.status().status, 'ready'); assert.equal(service.status().count, 1);
  assert.equal(service.queryPlayback({ query: '', filters: { genre: 'Metal' } }).total, 0); assert.equal(await fs.readFile(f.file, 'utf8'), legacy);
  service.requestScan('quick'); await settled(service);
  const result = service.queryPlayback({ query: '', filters: { genre: 'Metal', instrument: 'guitar', difficulty: 'easy' } });
  assert.equal(result.total, 1); assert.equal(result.items[0].id, id); assert.equal(service.status().changes.modified, 1);
  const enriched = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.equal(enriched.version, 1); assert.equal(enriched.items[0].musicMetadataVersion, 1);
  service.requestScan('quick'); await settled(service); assert.deepEqual(service.status().changes, { added: 0, removed: 0, modified: 0 });
  service.requestScan('full'); await settled(service); assert.deepEqual(service.status().changes, { added: 0, removed: 0, modified: 0 });
  const reloaded = f.create(); await reloaded.load(); assert.deepEqual(reloaded.queryPlayback({ query: '' }).items, service.queryPlayback({ query: '' }).items);
});

test('missing, malformed or oversized notes keep track metadata unknown without fabricating matching instruments', async t => {
  const f = await fixture(t); await song(f, 'Malformed', Buffer.from([255]), '[Song]\ngenre=Rock\n');
  const folder = await song(f, 'Oversized', notes('Rock')), file = path.join(folder, 'notes.chart');
  const handle = await fs.open(file, 'r+'); try { await handle.truncate(SCANNER_LIMITS.notesBytes + 1); } finally { await handle.close(); }
  const result = await scanLibrary({ rootPath: f.root }); assert.equal(result.items.length, 2); assert.ok(result.warningCount >= 2);
  assert.ok(result.items.every(item => item.tracks === undefined));
  const service = f.create(); await service.selectRoot(f.root); await settled(service);
  assert.equal(service.queryPlayback({ query: '', filters: { genre: 'Rock' } }).total, 2);
  assert.equal(service.queryPlayback({ query: '', filters: { instrument: 'guitar' } }).total, 0);
});

test('new optional cached metadata remains strict and invalid originals stay protected', async t => {
  const f = await fixture(t); await song(f, 'Installed'); const service = f.create(); await service.selectRoot(f.root); await settled(service); await service.stop();
  const baseline = JSON.parse(await fs.readFile(f.file, 'utf8'));
  const changes = [{ genre: 5 }, { genre: 'line\nother' }, { genre: 'x'.repeat(513) }, { musicMetadataVersion: 2 },
    { tracks: [{ instrument: 'guitar', difficulty: 'easy', path: 'PRIVATE' }] }, { tracks: [{ instrument: 'all', difficulty: 'easy' }] },
    { tracks: [{ instrument: 'guitar', difficulty: 'all' }] }, { tracks: [{ instrument: 'unknown', difficulty: 'expert' }] },
    { tracks: [{ instrument: 'guitar', difficulty: 'easy' }, { instrument: 'guitar', difficulty: 'easy' }] }];
  for (const change of changes) {
    const value = structuredClone(baseline); Object.assign(value.items[0], change); const original = JSON.stringify(value); await fs.writeFile(f.file, original);
    const fresh = f.create(); await fresh.load(); assert.equal(fresh.status().status, 'error'); assert.equal(await fs.readFile(f.file, 'utf8'), original);
  }
});

test('the actual worker searches indexed genre and matching tracks, preserving safe DTO metadata and artwork-independent selection', async t => {
  const f = await fixture(t), folder = await song(f, 'Installed', notes('Post-Rock'));
  await fs.writeFile(path.join(folder, 'song.wav'), 'synthetic audio');
  const service = f.create(createBackgroundLibraryService); await service.selectRoot(f.root); await settled(service);
  const result = await service.queryPlayback({ query: 'post-rock', filters: { genre: 'Rock', instrument: 'drums', difficulty: 'expert' } });
  assert.equal(result.total, 1); assert.equal(result.items[0].genre, 'Post-Rock'); assert.equal(result.items[0].tracks.length, 3);
  assert.equal((await service.queryPlayback({ query: '', filters: { instrument: 'drums', difficulty: 'easy' } })).total, 0);
  assert.doesNotMatch(JSON.stringify(result), /relativePath|signature|musicMetadataVersion/); assert.ok(!JSON.stringify(result).includes(f.root));
  const plan = await service.resolvePlaybackSong(result.items[0].id); assert.equal(plan.genre, 'Post-Rock');
});
