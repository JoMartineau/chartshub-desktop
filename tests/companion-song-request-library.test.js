'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { Module, createRequire } = require('node:module');
const { resolveInstalledSong, chartTracks, midiTracks } = require('../companion/song-request-library.cjs');
const { createInstalledLibraryService } = require('../companion/library-service.cjs');
const { createBackgroundLibraryService } = require('../companion/library-background.cjs');
const { createSongRequests } = require('../companion/song-requests.cjs');

const hash = value => createHash('sha256').update(value).digest('hex');
const chart = '[Song]\n{\n Name = "Installed"\n Artist = "Band"\n Resolution = 192\n}\n'
  + '[ExpertSingle]\n{\n 0 = N 0 0\n}\n[HardDrums]\n{\n 0 = N 1 0\n 0 = N 66 0\n}\n';
const descriptor = (relative = 'Installed/notes.chart', format = 'chart') => ({
  id: hash(relative), relativePath: relative, format, title: 'Installed', artist: 'Band', charter: 'Mapper',
  signature: 'PRIVATE_SIGNATURE', folderRelativePath: 'Installed'
});
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-request-library-'));
  const root = path.join(base, 'Songs'), outside = path.join(base, 'Outside'), data = path.join(base, 'Profile');
  await Promise.all([fs.mkdir(root), fs.mkdir(outside), fs.mkdir(data)]);
  const folder = path.join(root, 'Installed'); await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'notes.chart'), chart);
  await fs.writeFile(path.join(folder, 'song.ini'), '[Song]\nname=Installed\nartist=Band\ncharter=Mapper\nsong_length=180000\n');
  const services = [];
  t.after(async () => {
    for (const service of services) await service.stop();
    if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir())
        || !path.basename(base).startsWith('chartshub-request-library-')) throw Error('Unexpected request-library fixture directory');
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, root, outside, data, folder, item: descriptor(), services };
}
async function service(f) {
  const value = createInstalledLibraryService({ dataDirectory: f.data }); f.services.push(value);
  await value.selectRoot(f.root);
  await settled(value);
  return value;
}
async function settled(value) {
  const started = Date.now();
  while (value.status().status === 'scanning') {
    if (Date.now() - started > 6000) throw Error('Library scan did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(value.status().status, 'ready');
}
async function injected(overrides) {
  const absolute = require.resolve('../companion/song-request-library.cjs'), local = new Module(absolute, module);
  const normal = createRequire(absolute); local.filename = absolute; local.paths = Module._nodeModulePaths(path.dirname(absolute));
  local.require = name => Object.hasOwn(overrides, name) ? overrides[name] : normal(name);
  local._compile(await fs.readFile(absolute, 'utf8'), absolute); return local.exports;
}
function midi(parts) {
  const header = Buffer.alloc(14); header.write('MThd'); header.writeUInt32BE(6, 4);
  header.writeUInt16BE(1, 8); header.writeUInt16BE(parts.length, 10); header.writeUInt16BE(480, 12);
  const chunks = parts.map(({ name, events = [] }) => {
    const title = Buffer.from(name), body = Buffer.concat([Buffer.from([0, 255, 3, title.length]), title,
      ...events.map(event => Buffer.from(event)), Buffer.from([0, 255, 47, 0])]);
    const chunk = Buffer.alloc(8); chunk.write('MTrk'); chunk.writeUInt32BE(body.length, 4);
    return Buffer.concat([chunk, body]);
  });
  return Buffer.concat([header, ...chunks]);
}

test('resolves real installed notes and metadata without exposing paths or modifying any Songs file', async t => {
  const f = await fixture(t), before = await fs.readFile(path.join(f.folder, 'notes.chart'));
  const result = await resolveInstalledSong(f.root, f.item);
  assert.deepEqual(result, { id: f.item.id, title: 'Installed', artist: 'Band', charter: 'Mapper', durationMs: 180000,
    tracks: [{ instrument: 'guitar', difficulty: 'expert' }, { instrument: 'drums', difficulty: 'hard' }, { instrument: 'pro-drums', difficulty: 'hard' }] });
  assert.ok(!JSON.stringify(result).includes(f.root));
  assert.ok(!Object.hasOwn(result, 'relativePath')); assert.ok(!Object.hasOwn(result, 'signature'));
  assert.deepEqual(await fs.readFile(path.join(f.folder, 'notes.chart')), before);
});

test('only a currently indexed opaque ID can pass the actual service adapter; metadata files added after scan stay unavailable', async t => {
  const f = await fixture(t), value = await service(f), context = value.matchingSnapshot();
  const installed = value.query().items[0];
  assert.equal((await value.resolveRequestSong(installed.id, context)).id, installed.id);
  const unindexed = path.join(f.root, 'NotScanned'); await fs.mkdir(unindexed);
  await fs.writeFile(path.join(unindexed, 'notes.chart'), chart);
  for (const id of [hash('NotScanned/notes.chart'), hash('catalogue-song'), '../notes.chart']) {
    await assert.rejects(value.resolveRequestSong(id, context));
  }
  await assert.rejects(value.resolveRequestSong(installed.id, { ...context, revision: context.revision + 1 }));
  await assert.rejects(value.resolveRequestSong(installed.id, { ...context, rootKey: hash('Different Songs') }));
});

test('an indexed record cannot be requested after its real notes file disappears or becomes a directory', async t => {
  const f = await fixture(t), value = await service(f), item = value.query().items[0], context = value.matchingSnapshot();
  await fs.unlink(path.join(f.folder, 'notes.chart'));
  await assert.rejects(value.resolveRequestSong(item.id, context));
  await fs.mkdir(path.join(f.folder, 'notes.chart'));
  await assert.rejects(value.resolveRequestSong(item.id, context));
});

test('path traversal, absolute paths, alternate separators, ambiguous components and forged IDs are refused before reading outside Songs', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.outside, 'notes.chart'), chart);
  const before = await fs.readFile(path.join(f.outside, 'notes.chart'));
  for (const relative of ['../Outside/notes.chart', '/Outside/notes.chart', 'Installed\\notes.chart',
    'Installed//notes.chart', 'Installed/./notes.chart', 'Installed/../notes.chart',
    'Installed./notes.chart', 'Installed /notes.chart', 'Installed/notes.chart:stream', 'Installed/notes.chart\u0000']) {
    await assert.rejects(resolveInstalledSong(f.root, descriptor(relative)));
  }
  await assert.rejects(resolveInstalledSong('relative/Songs', f.item));
  await assert.rejects(resolveInstalledSong(f.root, { ...f.item, id: hash('different path') }));
  await assert.rejects(resolveInstalledSong(f.root, { ...f.item, format: 'midi' }));
  assert.deepEqual(await fs.readFile(path.join(f.outside, 'notes.chart')), before);
});

test('directory junctions/symlinks in root and indexed parents never resolve outside the selected real Songs directory', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.outside, 'notes.chart'), chart);
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  const linked = path.join(f.root, 'Linked'); await fs.symlink(f.outside, linked, type);
  await assert.rejects(resolveInstalledSong(f.root, descriptor('Linked/notes.chart')));
  const alias = path.join(f.base, 'Alias'); await fs.symlink(f.root, alias, type);
  await assert.rejects(resolveInstalledSong(alias, f.item));
  await fs.rename(f.folder, path.join(f.root, 'Original')); await fs.symlink(f.outside, f.folder, type);
  await assert.rejects(resolveInstalledSong(f.root, f.item));
  assert.deepEqual(await fs.readFile(path.join(f.outside, 'notes.chart'), 'utf8'), chart);
});

test('notes and optional metadata file symlinks are refused when the account permits creating file links', async t => {
  const f = await fixture(t), target = path.join(f.outside, 'notes.chart'); await fs.writeFile(target, chart);
  await fs.unlink(path.join(f.folder, 'notes.chart'));
  try { await fs.symlink(target, path.join(f.folder, 'notes.chart'), 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('File-link privilege unavailable; directory-junction coverage still runs.'); return; }
    throw error;
  }
  await assert.rejects(resolveInstalledSong(f.root, f.item));
  await fs.unlink(path.join(f.folder, 'notes.chart')); await fs.writeFile(path.join(f.folder, 'notes.chart'), chart);
  await fs.unlink(path.join(f.folder, 'song.ini')); await fs.symlink(target, path.join(f.folder, 'song.ini'), 'file');
  await assert.rejects(resolveInstalledSong(f.root, f.item));
});

test('notes content changes while being read are detected using the real open-file identity/stat checks', async t => {
  const f = await fixture(t); let changed = false;
  const guarded = await injected({ 'node:fs/promises': { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return { stat: (...values) => handle.stat(...values), close: () => handle.close(), read: async (...values) => {
      const result = await handle.read(...values);
      if (!changed) { changed = true; await fs.appendFile(path.join(f.folder, 'notes.chart'), '\nChanged during read\n'); }
      return result;
    } };
  } } });
  await assert.rejects(guarded.resolveInstalledSong(f.root, f.item)); assert.equal(changed, true);
});

test('oversized notes still get a final path/identity check before returning unknown metadata', async t => {
  const f = await fixture(t), file = path.join(f.folder, 'notes.chart');
  await fs.unlink(path.join(f.folder, 'song.ini'));
  const handle = await fs.open(file, 'r+'); await handle.truncate(16 * 1024 * 1024 + 1); await handle.close();
  let changed = false;
  const guarded = await injected({ 'node:fs/promises': { ...fs, open: async (...args) => {
    const source = await fs.open(...args);
    return { close: () => source.close(), read: (...values) => source.read(...values), stat: async (...values) => {
      const before = await source.stat(...values);
      if (!changed) {
        changed = true; await fs.rename(file, file + '.original'); await fs.writeFile(file, chart);
      }
      return before;
    } };
  } } });
  await assert.rejects(guarded.resolveInstalledSong(f.root, f.item)); assert.equal(changed, true);
});

test('duration is read only inside the Song INI section and invalid/oversized metadata cannot pretend it is known', async t => {
  const f = await fixture(t), ini = path.join(f.folder, 'song.ini');
  await fs.writeFile(ini, '[Other]\nsong_length=1\n[Song]\nsong_length=180000\n[After]\nsong_length=2\n');
  assert.equal((await resolveInstalledSong(f.root, f.item)).durationMs, 180000);
  await fs.writeFile(ini, '[Other]\nsong_length=1\n');
  assert.equal(Object.hasOwn(await resolveInstalledSong(f.root, f.item), 'durationMs'), false);
  for (const value of ['0', '-1', '3.5', '9007199254740992', 'unknown']) {
    await fs.writeFile(ini, `[Song]\nsong_length=${value}\n`);
    assert.equal(Object.hasOwn(await resolveInstalledSong(f.root, f.item), 'durationMs'), false);
  }
  await fs.writeFile(ini, '[Song]\nsong_length=1\n' + 'x'.repeat(128 * 1024));
  assert.equal(Object.hasOwn(await resolveInstalledSong(f.root, f.item), 'durationMs'), false);
});

test('track parsing detects real guitar/open notes and drum cymbals while preserving instrument/difficulty pairing', () => {
  const bytes = Buffer.from('[EasySingle]\n{\n 0 = N 7 0\n}\n[ExpertDrums]\n{\n 0 = N 2 0\n 0 = N 66 0\n}\n[ExpertUnknown]\n{\n 0 = N 0 0\n}\n');
  assert.deepEqual(chartTracks(bytes), [{ instrument: 'guitar', difficulty: 'easy' },
    { instrument: 'drums', difficulty: 'expert' }, { instrument: 'pro-drums', difficulty: 'expert' }]);
});

test('chart HOPO/tap/cymbal markers alone cannot prove a playable instrument/difficulty track', () => {
  const bytes = Buffer.from('[ExpertSingle]\n{\n 0 = N 5 0\n 0 = N 6 0\n}\n'
    + '[ExpertDrums]\n{\n 0 = N 66 0\n 0 = N 67 0\n 0 = N 68 0\n}\n');
  assert.deepEqual(chartTracks(bytes), []);
});

test('six-fret charts recognize their last lane and open notes without treating markers or unknown lane 9 as playable', () => {
  for (const lane of [0, 1, 2, 3, 4, 7, 8]) assert.deepEqual(chartTracks(Buffer.from(`[ExpertGHLGuitar]\n{\n 0 = N ${lane} 0\n}\n`)), [{ instrument: 'guitar-6fret', difficulty: 'expert' }]);
  for (const lane of [5, 6, 9]) assert.deepEqual(chartTracks(Buffer.from(`[ExpertGHLGuitar]\n{\n 0 = N ${lane} 0\n}\n`)), []);
});

test('MIDI parser handles per-track names, running status, note-off/zero velocity and independent difficulty tracks', () => {
  const bytes = midi([{ name: 'PART GUITAR', events: [[0, 144, 60, 100], [0, 61, 100], [0, 144, 96, 0]] },
    { name: 'PART DRUMS', events: [[0, 144, 96, 100], [0, 144, 110, 100], [0, 128, 84, 100]] }]);
  assert.deepEqual(midiTracks(bytes), [{ instrument: 'guitar', difficulty: 'easy' },
    { instrument: 'drums', difficulty: 'expert' }, { instrument: 'pro-drums', difficulty: 'expert' }]);
});

test('MIDI guitar force-HOPO/strum markers cannot prove playable notes', () => {
  assert.deepEqual(midiTracks(midi([{ name: 'PART GUITAR', events: [[0, 144, 101, 100], [0, 144, 102, 100]] }])), []);
});

test('malformed MIDI chunks, running status and VLQs fail safely instead of inventing tracks', () => {
  for (const bytes of [Buffer.from('MThd'), midi([{ name: 'PART GUITAR', events: [[0, 60, 100]] }]),
    midi([{ name: 'PART GUITAR', events: [[128, 128, 128, 128, 0, 144, 60, 100]] }]),
    midi([{ name: 'PART GUITAR', events: [[0, 144, 60, 128]] }])]) assert.throws(() => midiTracks(bytes));
  const length = midi([{ name: 'PART GUITAR' }]); length.writeUInt32BE(999999, 18);
  assert.throws(() => midiTracks(length));
});

test('a malformed actual MIDI file or a header-only SNG package cannot count as an available installed song', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.folder, 'notes.mid'), Buffer.from('MThd'));
  await assert.rejects(resolveInstalledSong(f.root, descriptor('Installed/notes.mid', 'midi')));
  const header = Buffer.concat([Buffer.from('SNGPKG'), Buffer.from([1, 0, 0, 0]), Buffer.alloc(16)]);
  assert.equal(header.length, 26);await fs.writeFile(path.join(f.folder, 'packed.sng'), header);
  await assert.rejects(resolveInstalledSong(f.root, descriptor('Installed/packed.sng', 'sng')));
});

test('real installed track metadata enforces instrument/difficulty together and missing metadata refuses active rules', async t => {
  const f = await fixture(t), value = await service(f);
  const core = createSongRequests({ getLibrarySnapshot: value.matchingSnapshot,
    searchSongs: options => value.query(options), resolveSong: (id, context) => value.resolveRequestSong(id, context) });
  core.configure({ enabled: true, rules: { instrument: 'drums', difficulty: 'expert', maxDurationMinutes: 3 } });
  const source = { platform: 'youtube', eventId: '1', viewerId: 'viewer', viewerName: 'Viewer', songId: f.item.id };
  assert.equal((await core.receive(source)).code, 'difficulty_unavailable', 'Expert Guitar + Hard Drums cannot meet Expert Drums');
  core.configure({ rules: { instrument: 'guitar' } });
  assert.equal((await core.receive({ ...source, eventId: '2' })).ok, true);
  await fs.unlink(path.join(f.folder, 'song.ini'));
  assert.equal((await core.accept(core.snapshot().requests[0].id)).code, 'song_unavailable', 'Changed metadata cannot use the cached scan identity');
  value.requestScan('full'); await settled(value);
  assert.equal((await core.accept(core.snapshot().requests[0].id)).code, 'metadata_unknown');
});

test('a regular notes file edited after scanning is refused until a full rescan commits its new identity', async t => {
  const f = await fixture(t), value = await service(f), context = value.matchingSnapshot();
  await fs.appendFile(path.join(f.folder, 'notes.chart'), '\n[EasySingle]\n{\n 0 = N 2 0\n}\n');
  await assert.rejects(value.resolveRequestSong(f.item.id, context));
  value.requestScan('full'); await settled(value);
  await assert.rejects(value.resolveRequestSong(f.item.id, context), 'The old scan context stays stale');
  const result = await value.resolveRequestSong(f.item.id, value.matchingSnapshot());
  assert.ok(result.tracks.some(track => track.instrument === 'guitar' && track.difficulty === 'easy'));
});

test('sharing collects only current validated local songs and reports changed/missing indexed files without paths in song DTOs', async t => {
  const f = await fixture(t);
  for (const name of ['Missing', 'Changed']) {
    const directory = path.join(f.root, name); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'notes.chart'), chart);
    await fs.writeFile(path.join(directory, 'song.ini'), '[Song]\nname=' + name + '\nartist=Band\ncharter=Mapper\n');
  }
  await fs.writeFile(path.join(f.outside, 'notes.chart'), chart);
  const value = await service(f), context = value.matchingSnapshot();
  await fs.unlink(path.join(f.root, 'Missing', 'notes.chart'));
  await fs.appendFile(path.join(f.root, 'Changed', 'notes.chart'), '\nchanged since scan\n');
  const result = await value.requestLibraryForSharing();
  assert.equal(result.unavailableCount, 2); assert.equal(result.revision, context.revision); assert.equal(result.rootKey, context.rootKey);
  assert.equal(result.songs.length, 1); assert.equal(result.songs[0].id, f.item.id);
  assert.deepEqual(Object.keys(result.songs[0]).sort(), ['artist', 'charter', 'durationMs', 'id', 'title', 'tracks']);
  const projected = JSON.stringify(result.songs);
  for (const value of [f.root, f.outside, 'relativePath', 'folderRelativePath', 'signature', 'cleanupSnapshot']) assert.equal(projected.includes(value), false);
  await fs.unlink(path.join(f.folder, 'notes.chart'));
  await assert.rejects(value.requestLibraryForSharing(), 'No valid local songs cannot publish an empty metadata snapshot');
});

test('sharing refuses an unscanned/empty library and the actual worker preserves the safe metadata contract', async t => {
  const f = await fixture(t), idle = createInstalledLibraryService({ dataDirectory: f.data }); f.services.push(idle);
  await idle.load(); await assert.rejects(idle.requestLibraryForSharing());
  await idle.selectRoot(f.outside); await settled(idle); await assert.rejects(idle.requestLibraryForSharing());
  const value = createBackgroundLibraryService({ dataDirectory: path.join(f.base, 'WorkerProfile') }); f.services.push(value);
  await value.load(); await value.selectRoot(f.root); await settled(value);
  const result = await value.requestLibraryForSharing();assert.equal(result.songs.length, 1);assert.equal(result.unavailableCount, 0);
  assert.equal(result.songs[0].title, 'Installed');assert.equal(Object.hasOwn(result.songs[0], 'relativePath'), false);
  assert.equal(JSON.stringify(result.songs).includes(f.root), false);
});

test('sharing aborts when the selected root/revision changes while resolving a song', async t => {
  const f = await fixture(t), absolute = require.resolve('../companion/library-service.cjs'), local = new Module(absolute, module);
  const normal = createRequire(absolute);local.filename = absolute;local.paths = Module._nodeModulePaths(path.dirname(absolute));
  let entered, release;const pending = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  local.require = name => name === './song-request-library.cjs' ? { resolveInstalledSong: async (...args) => {
    entered();await gate;return resolveInstalledSong(...args);
  } } : normal(name);
  local._compile(await fs.readFile(absolute, 'utf8'), absolute);
  const value = local.exports.createInstalledLibraryService({ dataDirectory: f.data });f.services.push(value);
  await value.selectRoot(f.root);await settled(value);
  const sharing = value.requestLibraryForSharing();await pending;
  await value.selectRoot(f.outside);release();await assert.rejects(sharing);await settled(value);
});

test('a sharing operation cannot resume after stop has completed and the ready scan revision remains unchanged', async t => {
  const f = await fixture(t), absolute = require.resolve('../companion/library-service.cjs'), local = new Module(absolute, module);
  const normal = createRequire(absolute);local.filename = absolute;local.paths = Module._nodeModulePaths(path.dirname(absolute));
  let entered, release;const pending = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  local.require = name => name === './song-request-library.cjs' ? { resolveInstalledSong: async (...args) => {
    entered();await gate;return resolveInstalledSong(...args);
  } } : normal(name);
  local._compile(await fs.readFile(absolute, 'utf8'), absolute);
  const value = local.exports.createInstalledLibraryService({ dataDirectory: f.data });f.services.push(value);
  await value.selectRoot(f.root);await settled(value);const revision = value.status().revision;
  const sharing = value.requestLibraryForSharing();await pending;
  await value.stop();assert.equal(value.status().revision, revision);
  release();await assert.rejects(sharing, 'Stopping invalidates the preparation even after stopTask is cleared');
});

test('a directory replaced by a junction during notes reading fails before reading any outside metadata', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.outside, 'notes.chart'), chart);
  await fs.writeFile(path.join(f.outside, 'song.ini'), '[Song]\nsong_length=1\n');
  let changed = false; const opened = [];
  const guarded = await injected({ 'node:fs/promises': { ...fs, open: async (...args) => {
    opened.push(args[0]); const handle = await fs.open(...args);
    return { stat: (...values) => handle.stat(...values), close: () => handle.close(), read: async (...values) => {
      const result = await handle.read(...values);
      if (!changed) {
        changed = true; await fs.rename(f.folder, path.join(f.root, 'Original'));
        await fs.symlink(f.outside, f.folder, process.platform === 'win32' ? 'junction' : 'dir');
      }
      return result;
    } };
  } } });
  await assert.rejects(guarded.resolveInstalledSong(f.root, f.item));
  assert.deepEqual(opened, [path.join(f.folder, 'notes.chart')]);
  assert.equal(await fs.readFile(path.join(f.outside, 'song.ini'), 'utf8'), '[Song]\nsong_length=1\n');
});

test('conflicting Song durations stay unknown; repeated identical entries and BOM are safely recognized', async t => {
  const f = await fixture(t), ini = path.join(f.folder, 'song.ini');
  await fs.writeFile(ini, '\uFEFF[Song]\nsong_length=180000\nsong_length=180000\n');
  assert.equal((await resolveInstalledSong(f.root, f.item)).durationMs, 180000);
  for (const content of ['[Song]\nsong_length=1\nsong_length=180000\n',
    '[Song]\nsong_length=1\n[Other]\nsong_length=1\n[Song]\nsong_length=180000\n']) {
    await fs.writeFile(ini, content);
    assert.equal(Object.hasOwn(await resolveInstalledSong(f.root, f.item), 'durationMs'), false);
  }
});

test('actual worker RPC resolves only current indexed IDs and returns no filesystem paths', async t => {
  const f = await fixture(t), value = createBackgroundLibraryService({ dataDirectory: f.data }); f.services.push(value);
  await value.load(); await value.selectRoot(f.root);
  const started = Date.now();
  while (value.status().status !== 'ready') {
    if (Date.now() - started > 6000) throw Error('Request library worker scan did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const context = value.matchingSnapshot(), result = await value.resolveRequestSong(f.item.id, context);
  assert.equal(result.title, 'Installed'); assert.equal(result.durationMs, 180000);
  assert.ok(!JSON.stringify(result).includes(f.root));
  await assert.rejects(value.resolveRequestSong(hash('unindexed/notes.chart'), context));
  await assert.rejects(value.resolveRequestSong(f.item.id, { ...context, revision: context.revision + 1 }));
  await fs.unlink(path.join(f.folder, 'notes.chart'));
  await assert.rejects(value.resolveRequestSong(f.item.id, context));
});
