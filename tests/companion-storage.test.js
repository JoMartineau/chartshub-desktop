const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-companion-'));
  t.after(() => { if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('chartshub-companion-')) throw Error('Unexpected temporary test directory'); return fs.rm(directory, { recursive: true, force: true }); });
  const { SettingsRepository, validateSettings } = await import('../companion/dist/storage/SettingsRepository.js');
  const { createDefaultWidgets } = await import('../companion/dist/widgets/core/index.js');
  const { createDefaultTheme, validateTheme } = await import('../companion/dist/themes/ThemeService.js');
  const { createDefaultStream } = await import('../companion/dist/overlay/stream/StreamConfig.js');
  const defaults = createDefaultWidgets(), file = path.join(directory, 'settings.json');
  return { file, defaults, validateSettings, createDefaultTheme, validateTheme, createDefaultStream, repo: new SettingsRepository(file, defaults), SettingsRepository };
}
test('settings missing: defaults returned independently without filesystem writes', async t => {
  const f = await fixture(t); const loaded = await f.repo.load();
  assert.equal(loaded.version, 3); assert.deepEqual(loaded.theme, f.createDefaultTheme());
  assert.deepEqual(loaded.stream, f.createDefaultStream(f.defaults));
  assert.equal(loaded.widgets.length, 5); loaded.widgets[0].enabled = false;
  assert.equal(f.defaults[0].enabled, true); await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});
test('settings roundtrip retains disabled artist, IDs, positions, sizes and visibility', async t => {
  const f = await fixture(t); const data = await f.repo.load();
  const artist = data.widgets.find(w => /artist/i.test(w.type));
  artist.enabled = false; artist.position = { x: 117, y: 86 }; artist.size = { width: 401, height: 48 };
  artist.visibility = { game: false, stream: true }; artist.gameplayVisibility = ['paused'];
  await f.repo.save(data);
  assert.deepEqual(await new f.SettingsRepository(f.file, f.defaults).load(), data);
});

test('settings v3 persists shared locks and source-color preferences without rewriting absent locks', async t => {
  const f = await fixture(t), document = await f.repo.load();
  assert.ok(document.widgets.every(widget => widget.locked === undefined));
  document.widgets[0].locked = true;
  document.widgets[1].locked = false;
  const charter = document.widgets.find(widget => widget.type === 'song.charter');
  charter.locked = true; charter.style.useSourceColors = true;
  charter.config = { label: 'Keep charter metadata', nested: { unchanged: true } };
  document.stream.layout[0].x = 320;
  await f.repo.save(document);
  const loaded = await new f.SettingsRepository(f.file, f.defaults).load();
  assert.deepEqual(loaded, document);
  assert.equal(loaded.version, 3);
  assert.equal(loaded.widgets[3].locked, undefined);
  assert.equal(loaded.stream.layout[0].x, 320);
  loaded.widgets[0].locked = false;
  await f.repo.save(loaded);
  assert.equal((await f.repo.load()).widgets[0].locked, false);
  assert.equal(JSON.parse(await fs.readFile(f.file + '.bak', 'utf8')).widgets[0].locked, true);
});

test('settings rejects nonboolean lock values before writing and still validates locked geometry', async t => {
  const f = await fixture(t), document = await f.repo.load();
  for (const locked of [null, 0, 1, 'true', [], {}]) {
    const invalid = structuredClone(document); invalid.widgets[0].locked = locked;
    assert.throws(() => f.validateSettings(invalid), /Verrouillage/);
    assert.throws(() => f.repo.save(invalid), /Verrouillage/);
  }
  for (const patch of [{ position: { x: -1, y: 0 } }, { size: { width: 0, height: 28 } }]) {
    const invalid = structuredClone(document); Object.assign(invalid.widgets[0], patch, { locked: true });
    assert.throws(() => f.validateSettings(invalid), /Disposition/);
  }
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});
test('settings serialize concurrent saves and preserve previous version as backup', async t => {
  const f = await fixture(t); const first = await f.repo.load(); const last = structuredClone(first);
  last.widgets[0].enabled = false;
  await Promise.all([f.repo.save(first), f.repo.save(last)]);
  assert.deepEqual(await f.repo.load(), last);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file + '.bak', 'utf8')), first);
  assert.deepEqual((await fs.readdir(path.dirname(f.file))).sort(), ['settings.json', 'settings.json.bak']);
});

test('Windows settings replacement retries transient sharing locks without removing current bytes', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), first = await f.repo.load(); await f.repo.save(first);
  const prior = await fs.readFile(f.file), next = structuredClone(first); next.stream.layout[0].x = 136;
  const rename = fs.rename.bind(fs), unlink = fs.unlink.bind(fs); let attempts = 0, temporary; const actualSharingFailures = [];
  t.mock.method(fs, 'unlink', async file => { assert.notEqual(file, f.file, 'The current settings are never unlinked'); return unlink(file); });
  t.mock.method(fs, 'rename', async (from, to) => {
    assert.equal(to, f.file); temporary ??= from; assert.equal(from, temporary, 'Retries reuse the same synced document');
    assert.deepEqual(await fs.readFile(f.file), prior, 'Readers retain the previous complete document until replacement');
    assert.equal(JSON.parse(await fs.readFile(from, 'utf8')).stream.layout[0].x, 136);
    attempts++; if (attempts < 3) throw Object.assign(Error('synthetic Windows sharing lock'), { code: attempts === 1 ? 'EPERM' : 'EBUSY' });
    try { return await rename(from, to); }
    catch (error) { assert(['EPERM', 'EBUSY'].includes(error.code), 'Unexpected real rename error: ' + error.code); actualSharingFailures.push(error.code); throw error; }
  });
  let reading = true; const reads = [], readErrors = [];
  const reader = (async () => { while (reading) { try { reads.push(JSON.parse(await fs.readFile(f.file, 'utf8')).stream.layout[0].x); } catch (error) { readErrors.push(error); } await new Promise(resolve => setTimeout(resolve, 2)); } })();
  try { await f.repo.save(next); } finally { reading = false; await reader; }
  reads.push(JSON.parse(await fs.readFile(f.file, 'utf8')).stream.layout[0].x);
  assert.deepEqual(readErrors, [], 'Concurrent readers never see a missing or partial document');
  assert(reads.includes(first.stream.layout[0].x) && reads.includes(136));
  assert(reads.every(x => x === first.stream.layout[0].x || x === 136), 'Every observation is the complete old or complete new layout');
  assert.equal(attempts, 2 + actualSharingFailures.length + 1, 'Two injected locks, recorded real sharing locks, then one successful replacement');
  assert(attempts <= 6, 'All retries stay within the production bound'); assert.deepEqual(await f.repo.load(), next);
  assert.deepEqual(await fs.readFile(f.file + '.bak'), prior);
  assert.deepEqual((await fs.readdir(path.dirname(f.file))).sort(), ['settings.json', 'settings.json.bak']);
});

test('Windows retry keeps queued settings serialized and backs up the immediately previous save', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), initial = await f.repo.load(); await f.repo.save(initial);
  const first = structuredClone(initial), last = structuredClone(initial); first.stream.layout[0].x = 136; last.stream.layout[0].x = 184;
  const rename = fs.rename.bind(fs), completed = []; let attempts = 0, firstTemporary;
  t.mock.method(fs, 'rename', async (from, to) => {
    attempts++; const x = JSON.parse(await fs.readFile(from, 'utf8')).stream.layout[0].x;
    if (attempts === 1) { firstTemporary = from; assert.equal(x, 136); throw Object.assign(Error('synthetic reader'), { code: 'EPERM' }); }
    if (completed.length === 0) { assert.equal(from, firstTemporary); assert.equal(x, 136); }
    await rename(from, to); completed.push(x);
  });
  await Promise.all([f.repo.save(first), f.repo.save(last)]);
  assert.equal(attempts, 3); assert.deepEqual(completed, [136, 184]);
  assert.deepEqual(await f.repo.load(), last); assert.deepEqual(JSON.parse(await fs.readFile(f.file + '.bak', 'utf8')), first);
  assert.deepEqual((await fs.readdir(path.dirname(f.file))).sort(), ['settings.json', 'settings.json.bak']);
});

test('Windows permanent sharing lock is bounded, preserves settings, cleans temporary files and releases the save queue', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), initial = await f.repo.load(); await f.repo.save(initial);
  const prior = await fs.readFile(f.file), next = structuredClone(initial); next.stream.layout[0].x = 136;
  const rename = fs.rename.bind(fs); let attempts = 0, locked = true;
  t.mock.method(fs, 'rename', async (from, to) => { attempts++; if (locked) throw Object.assign(Error('persistent synthetic lock'), { code: 'EPERM' }); return rename(from, to); });
  await assert.rejects(f.repo.save(next), { code: 'EPERM' }); assert.equal(attempts, 6, 'One attempt and five bounded retries');
  assert.deepEqual(await fs.readFile(f.file), prior); assert.deepEqual(await fs.readFile(f.file + '.bak'), prior);
  assert.deepEqual((await fs.readdir(path.dirname(f.file))).sort(), ['settings.json', 'settings.json.bak']);
  locked = false; await f.repo.save(next); assert.equal(attempts, 7); assert.deepEqual(await f.repo.load(), next);
});

test('settings replacement does not retry permanent permission errors or change the backup-write contract', async t => {
  const f = await fixture(t), initial = await f.repo.load(); await f.repo.save(initial);
  const prior = await fs.readFile(f.file), next = structuredClone(initial); next.stream.layout[0].x = 136;
  const originalCopy = fs.copyFile.bind(fs); let attempts = 0;
  const mockedRename = t.mock.method(fs, 'rename', async () => { attempts++; throw Object.assign(Error('synthetic access failure'), { code: 'EACCES' }); });
  await assert.rejects(f.repo.save(next), { code: 'EACCES' }); assert.equal(attempts, 1); assert.deepEqual(await fs.readFile(f.file), prior);
  mockedRename.mock.restore();
  t.mock.method(fs, 'copyFile', async (from, to) => { if (from === f.file && to === f.file + '.bak') throw Object.assign(Error('synthetic backup failure'), { code: 'EPERM' }); return originalCopy(from, to); });
  attempts = 0; t.mock.method(fs, 'rename', async () => { attempts++; });
  await assert.rejects(f.repo.save(next), { code: 'EPERM' }); assert.equal(attempts, 0, 'A backup failure never reaches replacement');
  assert.deepEqual(await fs.readFile(f.file), prior);
  assert.deepEqual((await fs.readdir(path.dirname(f.file))).sort(), ['settings.json', 'settings.json.bak']);
});

test('non-Windows settings replacement propagates sharing error without platform-specific retries', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), initial = await f.repo.load(); await f.repo.save(initial); const prior = await fs.readFile(f.file); let attempts = 0;
  t.mock.method(fs, 'rename', async () => { attempts++; throw Object.assign(Error('synthetic sharing error'), { code: 'EPERM' }); });
  await assert.rejects(f.repo.save(initial), { code: 'EPERM' }); assert.equal(attempts, 1); assert.deepEqual(await fs.readFile(f.file), prior);
  assert.deepEqual((await fs.readdir(path.dirname(f.file))).sort(), ['settings.json', 'settings.json.bak']);
});
test('future settings schema is preserved and cannot be overwritten', async t => {
  const f = await fixture(t); const original = '{"version":4,"widgets":[],"future":"preserve"}';
  await fs.writeFile(f.file, original); await assert.rejects(f.repo.load());
  await assert.rejects(f.repo.save({ version: 1, widgets: f.defaults }));
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
});

test('v1 migration preserves geometry, IDs and visibility without touching disk until the first edit', async t => {
  const f = await fixture(t);
  const legacy = { version: 1, widgets: structuredClone(f.defaults) };
  const colors = ['#ffffff', '#e0e7ff', '#aebbd0', '#c4b5fd', '#c4b5fd'];
  for (const [index, instance] of legacy.widgets.entries()) {
    delete instance.style.colorMode;
    instance.style.color = colors[index];
  }
  legacy.widgets[1].position = { x: 117, y: 86 };
  legacy.widgets[1].size = { width: 401, height: 48 };
  legacy.widgets[1].enabled = false;
  legacy.widgets[1].visibility = { game: false, stream: true };
  legacy.widgets[1].gameplayVisibility = ['paused'];
  const original = JSON.stringify(legacy, null, 2);
  await fs.writeFile(f.file, original);
  const migrated = await f.repo.load();
  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.theme, f.createDefaultTheme());
  assert.deepEqual(migrated.stream, f.createDefaultStream(legacy.widgets));
  assert.ok(migrated.widgets.every(instance => instance.style.colorMode === 'theme'));
  for (const [index, instance] of migrated.widgets.entries()) {
    for (const key of ['id', 'type', 'enabled', 'position', 'size', 'visibility', 'gameplayVisibility', 'config']) {
      assert.deepEqual(instance[key], legacy.widgets[index][key], key);
    }
  }
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), ['settings.json']);
  migrated.widgets[0].position.x = 160;
  await f.repo.save(migrated);
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).version, 3);
  assert.equal(await fs.readFile(f.file + '.bak', 'utf8'), original);
  assert.deepEqual(await new f.SettingsRepository(f.file, f.defaults).load(), migrated);
});

test('legacy customized colors stay custom while canonical default colors follow the theme', async t => {
  const f = await fixture(t);
  const legacy = { version: 1, widgets: structuredClone(f.defaults) };
  for (const instance of legacy.widgets) delete instance.style.colorMode;
  legacy.widgets[0].style.color = '#FFF';
  legacy.widgets[1].style.color = 'rgb(12, 34, 56)';
  legacy.widgets[2].style.color = '#aebbd0ff';
  delete legacy.widgets[3].style.color;
  legacy.widgets[4].style.colorMode = 'custom';
  const migrated = f.validateSettings(legacy);
  assert.deepEqual(migrated.widgets.map(instance => instance.style.colorMode), ['theme', 'custom', 'theme', 'theme', 'custom']);
  assert.equal(migrated.widgets[0].style.color, '#ffffff');
  assert.equal(migrated.widgets[1].style.color, '#0c2238');
  assert.equal(migrated.widgets[2].style.color, '#aebbd0');
  await f.repo.save(legacy);
  assert.deepEqual(await f.repo.load(), migrated, 'legacy save callers produce canonical v3 settings');
});

test('v3 persistence roundtrips canonical alpha colors and widget effects', async t => {
  const f = await fixture(t); const document = await f.repo.load();
  document.theme.presetId = 'neon';
  document.theme.colors.accent = 'rgba(255, 0, 128, 0.5)';
  document.theme.effects.glow = { enabled: true, blur: 18 };
  document.theme.effects.gradient = { enabled: true, from: 'hsl(120 100% 50%)', to: '#fff8', angle: 135 };
  document.widgets[0].style = {
    colorMode: 'custom', color: 'rgba(255, 0, 128, 0.5)', fontSize: 34, fontWeight: 700,
    backgroundColor: 'hsl(120, 100%, 25%)', borderColor: '#ABC8',
    glow: { enabled: true, color: 'rgb(10, 20, 30)', blur: 12 },
    gradient: { enabled: true, from: '#f00', to: 'hsla(240, 100%, 50%, 0.5)', angle: 135 }
  };
  const canonical = f.validateSettings(document);
  assert.equal(canonical.theme.presetId, 'neon');
  assert.equal(canonical.theme.colors.accent, '#ff008080');
  assert.deepEqual(canonical.theme.effects.glow, { enabled: true, blur: 18 });
  assert.deepEqual(canonical.theme.effects.gradient, { enabled: true, from: '#00ff00', to: '#ffffff88', angle: 135 });
  assert.equal(canonical.widgets[0].style.color, '#ff008080');
  assert.equal(canonical.widgets[0].style.backgroundColor, '#008000');
  assert.equal(canonical.widgets[0].style.borderColor, '#aabbcc88');
  assert.deepEqual(canonical.widgets[0].style.glow, { enabled: true, color: '#0a141e', blur: 12 });
  assert.deepEqual(canonical.widgets[0].style.gradient, { enabled: true, from: '#ff0000', to: '#0000ff80', angle: 135 });
  await f.repo.save(document);
  assert.deepEqual(await new f.SettingsRepository(f.file, f.defaults).load(), canonical);
});

test('invalid current theme or unsafe widget effect values are rejected before save', async t => {
  const f = await fixture(t); const original = await f.repo.load();
  for (const mutate of [
    d => delete d.theme,
    d => { d.theme = { invalid: true }; },
    d => { d.widgets[0].style.colorMode = 'browser-css'; },
    d => { d.widgets[0].style.backgroundColor = 'url(https://invalid)'; },
    d => { d.widgets[0].style.glow = { enabled: true, color: '#fff', blur: 41 }; },
    d => { d.widgets[0].style.gradient = { enabled: true, from: '#fff', to: '#000', angle: -1 }; }
  ]) {
    const invalid = structuredClone(original); mutate(invalid);
    assert.throws(() => f.validateSettings(invalid));
  }
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});
test('corrupt settings can recover on explicit change while retaining original backup', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, 'broken JSON'); await assert.rejects(f.repo.load());
  assert.equal(await fs.readFile(f.file, 'utf8'), 'broken JSON');
  await f.repo.save({ version: 1, widgets: f.defaults });
  assert.equal(await fs.readFile(f.file + '.bak', 'utf8'), 'broken JSON'); assert.equal((await f.repo.load()).widgets.length, 5);
});
test('invalid widget IDs, duplicate IDs, bounds and visibility are rejected', async t => {
  const f = await fixture(t);
  for (const mutate of [d => d.widgets.push(d.widgets[0]), d => d.widgets[0].id = '../bad', d => d.widgets[0].size.width = NaN, d => d.widgets[0].enabled = 'false', d => d.widgets[0].gameplayVisibility = ['not-a-state'], d => d.widgets[0].style.color = 'url(http://bad)']) {
    const data = { version: 1, widgets: structuredClone(f.defaults) }; mutate(data);
    assert.throws(() => f.validateSettings(data));
  }
});

test('v2 migration creates an independent stream layout without writing and backs up the original on first save', async t => {
  const f = await fixture(t);
  const legacy = { version: 2, widgets: structuredClone(f.defaults), theme: f.createDefaultTheme() };
  legacy.widgets[0].position = { x: 176, y: 96 };
  legacy.widgets[0].visibility = { game: false, stream: true };
  legacy.theme.colors.accent = '#ff008080';
  legacy.widgets[0].style = { ...legacy.widgets[0].style, colorMode: 'custom', color: '#abcdef80' };
  const original = JSON.stringify(legacy, null, 2);
  await fs.writeFile(f.file, original);
  const migrated = await f.repo.load();
  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.widgets, legacy.widgets);
  assert.deepEqual(migrated.theme, legacy.theme);
  assert.deepEqual(migrated.stream, f.createDefaultStream(legacy.widgets));
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), ['settings.json']);
  migrated.stream.layout[0].x = 320;
  assert.equal(migrated.widgets[0].position.x, 176);
  await f.repo.save(migrated);
  assert.equal(await fs.readFile(f.file + '.bak', 'utf8'), original);
  assert.deepEqual(await new f.SettingsRepository(f.file, f.defaults).load(), migrated);
});

test('v2 save callers remain supported while saved files use the current stream schema', async t => {
  const f = await fixture(t);
  const previous = { version: 2, widgets: structuredClone(f.defaults), theme: f.createDefaultTheme() };
  previous.theme.colors.text = '#aabbcc';
  await f.repo.save(previous);
  const loaded = await f.repo.load();
  assert.equal(loaded.version, 3);
  assert.deepEqual(loaded.widgets, previous.widgets);
  assert.deepEqual(loaded.theme, previous.theme);
  assert.deepEqual(loaded.stream, f.createDefaultStream(previous.widgets));
});

test('v3 stream canvas and layout roundtrip independently of game positions and visibility', async t => {
  const f = await fixture(t);
  const document = await f.repo.load();
  const game = structuredClone(document.widgets);
  document.stream.port = 45000;
  document.stream.canvas = { width: 1080, height: 1920, fps: 30 };
  document.stream.layout[0] = { id: document.widgets[0].id, x: 360, y: 200, width: 640, height: 80 };
  await f.repo.save(document);
  const loaded = await new f.SettingsRepository(f.file, f.defaults).load();
  assert.deepEqual(loaded.stream, document.stream);
  assert.deepEqual(loaded.widgets, game);
  loaded.widgets[0].position.x = 80;
  assert.equal(loaded.stream.layout[0].x, 360);
  loaded.stream.layout[0].x = 400;
  assert.equal(loaded.widgets[0].position.x, 80);
});

test('v3 rejects missing or invalid stream settings instead of silently replacing saved layouts', async t => {
  const f = await fixture(t);
  const valid = await f.repo.load();
  for (const mutate of [
    document => { delete document.stream; },
    document => { document.stream.layout.pop(); },
    document => { document.stream.layout[0].id = 'missing-widget'; },
    document => { document.stream.canvas.fps = 120; },
    document => { document.stream.port = 0; },
    document => { document.stream.address = '0.0.0.0'; },
    document => { document.stream.layout[0].width = 1281; },
  ]) {
    const invalid = structuredClone(valid); mutate(invalid);
    assert.throws(() => f.validateSettings(invalid));
  }
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});

test('legacy geometry outside the logical scene is retained for game and fitted only in the new stream copy', async t => {
  const f = await fixture(t);
  const legacy = { version: 2, widgets: structuredClone(f.defaults), theme: f.createDefaultTheme() };
  legacy.widgets[0].position = { x: 6000, y: 6000 };
  legacy.widgets[0].size = { width: 8192, height: 1 };
  legacy.widgets[0].locked = true;
  const migrated = f.validateSettings(legacy);
  assert.equal(migrated.widgets[0].locked, true);
  assert.deepEqual(migrated.widgets[0].position, { x: 6000, y: 6000 });
  assert.deepEqual(migrated.widgets[0].size, { width: 8192, height: 1 });
  assert.deepEqual(migrated.stream.layout[0], { id: migrated.widgets[0].id, x: 0, y: 704, width: 1280, height: 16 });
});
