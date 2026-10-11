const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createReShadeSetupService, addShaderPath } = require('../companion/reshade-setup.cjs');
const { createReShadeService } = require('../companion/reshade-service.cjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const safeError = error => error?.code === 'RESHADE_SETUP_SAFE';
const closed = { running: false, sessions: [] };
const shaderName = 'ChartsHub-ReShade-Shaders/Shaders/ChartsHub_Curves.fx';
const shader = Buffer.from('// downloaded shader fixture; never compiled');
function exe(extra = '') {
  const bytes = Buffer.alloc(256); bytes.write('MZ'); bytes.writeUInt32LE(0x80, 0x3c); bytes.write('PE\0\0', 0x80); bytes.writeUInt16LE(0x8664, 0x84);
  return Buffer.concat([bytes, Buffer.from(extra)]);
}
async function fixture(t, extra = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-setup-test-')));
  const root = path.join(dir, 'Clone Hero'), data = path.join(dir, 'data'), addonBinaryPath = path.join(dir, 'addon.dll');
  await fs.mkdir(root); await fs.mkdir(data); await fs.writeFile(path.join(root, 'Clone Hero.exe'), exe());
  await fs.writeFile(path.join(root, 'UnityPlayer.dll'), 'fixture; never loaded');
  const addon = exe('ChartsHub addon fixture'), runtime = exe('ReShadeRegisterAddon\0runtime fixture');
  await fs.writeFile(addonBinaryPath, addon);
  const bridge = createReShadeService({ dataDirectory: data, initialRoot: root, addonBinaryPath, platform: 'win32', probeGame: async () => closed });
  await bridge.load();
  const services = [], updates = [], calls = [];
  let selectedRoot = root, probe = async () => closed;
  const reshadeService = { status: () => ({ ...bridge.status(), rootPath: selectedRoot }), refresh: () => bridge.refresh() };
  const create = overrides => {
    const service = createReShadeSetupService({ dataDirectory: data, reshadeService, platform: 'win32', addonBinaryPath,
      probeClosed: () => probe(), onChange: status => updates.push(status),
      downloadRuntime: async () => { calls.push('runtime'); return runtime; },
      downloadStarterEffects: async () => { calls.push('effects'); return [{ relativePath: shaderName, bytes: shader }]; },
      ...extra, ...overrides });
    services.push(service); return service;
  };
  const service = create();
  t.after(async () => {
    await Promise.all(services.map(item => item.dispose())); await bridge.dispose();
    const absolute = path.resolve(dir);
    assert.equal(path.dirname(absolute), await fs.realpath(os.tmpdir())); assert.ok(path.basename(absolute).startsWith('chartshub-setup-test-'));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  return { root, dir, service, bridge, create, updates, calls, runtime, addon, file: name => path.join(root, name),
    select: value => { selectedRoot = value; }, probe: value => { probe = typeof value === 'function' ? value : async () => value; },
    prepare: includeStarterEffects => service.prepare({ includeStarterEffects: Boolean(includeStarterEffects) }) };
}

test('preparation downloads files but leaves game unchanged until the reviewed installation', async t => {
  const f = await fixture(t), before = await fs.readdir(f.root);
  f.probe({ running: true, sessions: [{ pid: 1 }] });
  await f.prepare(true);
  assert.deepEqual(await fs.readdir(f.root), before);
  assert.equal(f.service.status().state, 'ready'); assert.ok(f.service.status().files.includes(shaderName));
  assert.deepEqual(f.calls, ['runtime', 'effects']);
  await assert.rejects(f.service.install(), /Fermez Clone Hero/);
  assert.deepEqual(await fs.readdir(f.root), before);
});

test('fresh installation connects the real bridge service with effects disabled and verifiable backups', async t => {
  const f = await fixture(t); await f.prepare(true); await f.service.install();
  assert.equal(f.service.status().state, 'complete'); assert.equal(f.bridge.status().installed, true);
  assert.deepEqual(await fs.readFile(f.file('dxgi.dll')), f.runtime);
  assert.deepEqual(await fs.readFile(f.file('ChartsHubReShade.addon64')), f.addon);
  assert.deepEqual(await fs.readFile(f.file(shaderName)), shader);
  assert.match(await fs.readFile(f.file('ReShade.ini'), 'utf8'), /EffectSearchPaths=.*ChartsHub-ReShade-Shaders/);
  assert.equal(await fs.readFile(f.file('ChartsHub-ReShade-Preset.ini'), 'utf8'), 'Techniques=\r\nTechniqueSorting=\r\n');
  const journal = JSON.parse(await fs.readFile(f.file('ChartsHubReShade.setup.json'), 'utf8'));
  assert.equal(journal.phase, 'complete'); assert.ok(journal.files.every(item => item.beforeHash === null));
  assert.ok((await fs.stat(f.file(journal.backup + '/manifest.json'))).isFile());
});

test('existing presets, other shaders, unrelated INI settings and original runtime are preserved in backup', async t => {
  const f = await fixture(t), original = exe('ReShadeRegisterAddon\0older runtime'), preset = Buffer.from('Techniques=CA@ChromaticAberration.fx\n');
  const ini = Buffer.from('\ufeff[GENERAL]\r\nPresetPath=.\\My preset.ini\r\nPerformanceMode=1\r\nEffectSearchPaths=C:\\old\\shaders\r\n[INPUT]\r\nKeyOverlay=36,0,0,0\r\n');
  await fs.writeFile(f.file('dxgi.dll'), original); await fs.writeFile(f.file('ReShade.ini'), ini); await fs.writeFile(f.file('My preset.ini'), preset);
  await fs.mkdir(f.file('reshade-shaders')); await fs.writeFile(f.file('reshade-shaders/other.fx'), 'my shader');
  await f.prepare(true); await f.service.install();
  assert.deepEqual(await fs.readFile(f.file('My preset.ini')), preset);
  assert.equal(await fs.readFile(f.file('reshade-shaders/other.fx'), 'utf8'), 'my shader');
  assert.deepEqual(await fs.readFile(f.file('ReShade.ini')), addShaderPath(ini));
  assert.match(await fs.readFile(f.file('ReShade.ini'), 'utf8'), /PerformanceMode=1/);
  const journal = JSON.parse(await fs.readFile(f.file('ChartsHubReShade.setup.json'), 'utf8'));
  const runtimeBackup = journal.files.find(item => item.relativePath === 'dxgi.dll');
  assert.equal(runtimeBackup.beforeHash, digest(original));
  assert.deepEqual(await fs.readFile(f.file(journal.backup + '/' + runtimeBackup.backupFile)), original);
});

test('opting out downloads no shaders and leaves an existing INI byte-for-byte unchanged', async t => {
  const f = await fixture(t), ini = Buffer.from('[GENERAL]\nPresetPath=mine.ini\n');
  await fs.writeFile(f.file('ReShade.ini'), ini); await f.prepare(false); await f.service.install();
  assert.deepEqual(f.calls, ['runtime']); assert.deepEqual(await fs.readFile(f.file('ReShade.ini')), ini);
  assert.equal(f.service.status().files.includes(shaderName), false);
});

test('unknown graphical DLL and unowned bridge block downloads without modifying the game', async t => {
  const f = await fixture(t), other = exe('another mod'); await fs.writeFile(f.file('dxgi.dll'), other);
  await assert.rejects(f.prepare(), safeError); assert.deepEqual(f.calls, []); assert.deepEqual(await fs.readFile(f.file('dxgi.dll')), other);
  await fs.unlink(f.file('dxgi.dll')); await fs.writeFile(f.file('ChartsHubReShade.addon64'), other);
  await assert.rejects(f.prepare(), safeError); assert.deepEqual(f.calls, []);
});

test('a changed root, executable or config invalidates the reviewed plan', async t => {
  const f = await fixture(t); await f.prepare(); f.select(path.join(f.dir, 'other'));
  await assert.rejects(f.service.install(), /dossier sélectionné/);
  f.select(f.root); await f.prepare(); await fs.writeFile(f.file('Clone Hero.exe'), exe('updated game'));
  await assert.rejects(f.service.install(), /installation du jeu a changé/);
  await f.prepare(); await fs.writeFile(f.file('ReShade.ini'), 'external edit');
  await assert.rejects(f.service.install(), /configuration du jeu a changé/);
  assert.equal(await fs.readFile(f.file('ReShade.ini'), 'utf8'), 'external edit');
  await assert.rejects(fs.stat(f.file('dxgi.dll')), { code: 'ENOENT' });
});

test('incompatible add-on preferences are preserved with an actionable error before downloading', async t => {
  const f = await fixture(t);
  for (const [setting, message] of [
    ['AddonPath=.\\other-addons', /AddonPath/],
    ['DisabledAddons=ChartsHub ReShade Bridge', /DisabledAddons/],
    ['DisabledAddons=Other@ChartsHubReShade.addon64', /DisabledAddons/]
  ]) {
    const ini = Buffer.from('[ADDON]\r\n' + setting + '\r\n'); await fs.writeFile(f.file('ReShade.ini'), ini);
    await assert.rejects(f.prepare(), message); assert.deepEqual(await fs.readFile(f.file('ReShade.ini')), ini);
  }
  assert.deepEqual(f.calls, []);
  await fs.writeFile(f.file('ReShade.ini'), '[ADDON]\nAddonPath=.\\\nDisabledAddons=Generic Depth\n');
  await f.prepare(); assert.equal(f.service.status().state, 'ready');
});

test('waiting for installation keeps the transaction alive until the last write completes', async t => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { beforeWrite: async ({ index }) => { if (index === 0) { entered(); await gate; } } });
  await f.prepare(); const task = f.service.install(); await started;
  let idle = false; const waiting = f.service.whenIdle().then(() => { idle = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(idle, false);
  await assert.rejects(f.service.cancel(), /en cours/); release(); await task; await waiting;
  assert.equal(idle, true); assert.equal(f.service.status().state, 'complete');
});

test('closure is freshly rechecked after backups, including unknown process state', async t => {
  const f = await fixture(t); let probes = 0; f.probe(async () => (++probes === 1 ? closed : { running: null }));
  await f.prepare(); await assert.rejects(f.service.install(), /fermeture.*vérifiée/);
  await assert.rejects(fs.stat(f.file('dxgi.dll')), { code: 'ENOENT' });
});

test('an interrupted write rolls back runtime and configuration without touching user presets', async t => {
  const f = await fixture(t, { beforeWrite: async ({ index }) => { if (index === 2) throw Error('simulated disk error'); } });
  const original = exe('ReShadeRegisterAddon\0original'), ini = Buffer.from('[GENERAL]\nPresetPath=mine.ini\n');
  await fs.writeFile(f.file('dxgi.dll'), original); await fs.writeFile(f.file('ReShade.ini'), ini); await fs.writeFile(f.file('mine.ini'), 'keep me');
  await f.prepare(true); await assert.rejects(f.service.install(), safeError);
  assert.deepEqual(await fs.readFile(f.file('dxgi.dll')), original); assert.deepEqual(await fs.readFile(f.file('ReShade.ini')), ini);
  assert.equal(await fs.readFile(f.file('mine.ini'), 'utf8'), 'keep me');
  assert.equal(JSON.parse(await fs.readFile(f.file('ChartsHubReShade.setup.json'), 'utf8')).phase, 'rolled-back');
});

test('a retained installation journal can recover after interruption on the next preparation', async t => {
  const f = await fixture(t); let blockRecovery = false;
  f.probe(async () => blockRecovery ? { running: true } : closed);
  const broken = f.create({ beforeWrite: async ({ index }) => { if (index === 1) { blockRecovery = true; throw Error('interrupt'); } } });
  await broken.prepare({ includeStarterEffects: false }); await assert.rejects(broken.install(), /sauvegardes sont conservées/);
  assert.equal(JSON.parse(await fs.readFile(f.file('ChartsHubReShade.setup.json'), 'utf8')).phase, 'installing');
  blockRecovery = false;
  const resumed = f.create(); await resumed.prepare({ includeStarterEffects: false });
  assert.equal(resumed.status().state, 'ready'); await assert.rejects(fs.stat(f.file('dxgi.dll')), { code: 'ENOENT' });
  await resumed.install(); assert.equal(f.bridge.status().installed, true);
});

test('recovery preserves external edits and refuses a tampered backup', async t => {
  const f = await fixture(t); let blockRecovery = false;
  const original = exe('ReShadeRegisterAddon\0original'); await fs.writeFile(f.file('dxgi.dll'), original);
  f.probe(async () => blockRecovery ? { running: true } : closed);
  const broken = f.create({ beforeWrite: async ({ index }) => { if (index === 1) { blockRecovery = true; throw Error('interrupt'); } } });
  await broken.prepare({ includeStarterEffects: false }); await assert.rejects(broken.install(), safeError);
  const journal = JSON.parse(await fs.readFile(f.file('ChartsHubReShade.setup.json'), 'utf8'));
  blockRecovery = false; await fs.writeFile(f.file('dxgi.dll'), 'external edit');
  await assert.rejects(f.prepare(), /modifié après/); assert.equal(await fs.readFile(f.file('dxgi.dll'), 'utf8'), 'external edit');
  await fs.writeFile(f.file('dxgi.dll'), f.runtime); await fs.writeFile(f.file(journal.backup + '/0.bin'), 'tampered');
  await assert.rejects(f.prepare(), /sauvegarde est invalide/); assert.deepEqual(await fs.readFile(f.file('dxgi.dll')), f.runtime);
});

test('a symlinked shader directory is refused, including when swapped after preparation', async t => {
  const f = await fixture(t), outside = path.join(f.dir, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, f.file('ChartsHub-ReShade-Shaders'), 'junction');
  await assert.rejects(f.prepare(true), /dossier de shaders/); assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(f.file('ChartsHub-ReShade-Shaders')); await f.prepare(true);
  await fs.symlink(outside, f.file('ChartsHub-ReShade-Shaders'), 'junction');
  await assert.rejects(f.service.install(), /dossier de shaders/); assert.deepEqual(await fs.readdir(outside), []);
});

test('a modified starter effect is preserved and never overwritten', async t => {
  const f = await fixture(t); await fs.mkdir(path.dirname(f.file(shaderName)), { recursive: true }); await fs.writeFile(f.file(shaderName), 'custom change');
  await assert.rejects(f.prepare(true), /pack a été modifié/); assert.equal(await fs.readFile(f.file(shaderName), 'utf8'), 'custom change');
});

test('cancellation aborts downloads and makes install unavailable without touching the game', async t => {
  let entered; const start = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { downloadRuntime: ({ signal }) => new Promise((resolve, reject) => {
    entered(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const before = await fs.readdir(f.root), task = f.prepare(); await start; await f.service.cancel(); await task;
  assert.equal(f.service.status().state, 'idle'); await assert.rejects(f.service.install(), safeError); assert.deepEqual(await fs.readdir(f.root), before);
});

test('malformed options, unsafe download paths and unsupported binaries never become ready', async t => {
  const f = await fixture(t); await assert.rejects(f.service.prepare({ includeStarterEffects: true, url: 'https://example.com' }), safeError);
  const unsafe = f.create({ downloadStarterEffects: async () => [{ relativePath: '../bad.dll', bytes: shader }] });
  await assert.rejects(unsafe.prepare({ includeStarterEffects: true }), /pack d’effets téléchargé est invalide/);
  const invalid = f.create({ downloadRuntime: async () => Buffer.from('not a PE') });
  await assert.rejects(invalid.prepare({ includeStarterEffects: false }), /moteur ReShade téléchargé est invalide/);
  assert.deepEqual(await fs.readdir(f.root), ['Clone Hero.exe', 'UnityPlayer.dll']);
});

test('shader search path edits are idempotent and preserve BOM, CRLF, comments and unrelated sections', () => {
  const input = Buffer.from('\ufeff;hello\r\n[GENERAL]\r\nPresetPath=.\\mine.ini\r\nEffectSearchPaths=X:\\shaders\r\n[INPUT]\r\nKey=1\r\n');
  const result = addShaderPath(input);
  assert.equal(result.toString('utf8'), input.toString('utf8').replace('X:\\shaders', 'X:\\shaders,.\\ChartsHub-ReShade-Shaders\\Shaders'));
  assert.deepEqual(addShaderPath(result), result);
  assert.throws(() => addShaderPath(Buffer.from([0xff, 0xfe, 0xff])), safeError);
  assert.throws(() => addShaderPath(Buffer.from('[GENERAL]\n[GENERAL]\n')), safeError);
});
