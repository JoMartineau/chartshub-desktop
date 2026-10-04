const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createFiltersService, DEFAULTS, RANGES, validateSettings, parseStatus } = require('../companion/filters-service.cjs');
const { createReShadeService } = require('../companion/reshade-service.cjs');

const CONFIG = 'ChartsHubFilters.ini';
const STATUS = 'ChartsHubFilters.status.ini';
const MANIFEST = 'ChartsHubFilters.install.json';
const closed = { running: false, sessions: [] };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const safeError = error => error?.code === 'FILTERS_SAFE';
const absent = filename => assert.rejects(fs.stat(filename), { code: 'ENOENT' });

function gate() {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  return { entered, release, async wait() { enter(); await released; } };
}

async function connectNative(f) {
  await f.install();
  const now = Date.now(), live = { running: true, sessions: [{ pid: 4500, startedAtMs: now - 10000 }] };
  f.setClock(now); f.setProbe(live);
  await fs.writeFile(f.file(STATUS), '[Status]\nprotocol=1\npid=4500\nframes=10\nready=1\nenabled=0\nerror=\n');
  await fs.utimes(f.file(STATUS), new Date(now), new Date(now));
  await f.service.refresh(); assert.equal(f.service.status().state, 'ready');
  return live;
}

function executable(machine = 0x8664) {
  const bytes = Buffer.alloc(256);
  bytes.write('MZ'); bytes.writeUInt32LE(0x80, 0x3c); bytes.write('PE\0\0', 0x80); bytes.writeUInt16LE(machine, 0x84);
  return bytes;
}

async function fixture(t, { originals = {}, platform = 'win32', initialData } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-filters-test-'));
  const root = path.join(directory, 'Clone Hero'), data = path.join(directory, 'data');
  const binary = path.join(directory, 'bundled-dxgi.dll');
  const moduleBytes = Buffer.concat([executable(), Buffer.from('ChartsHub native test fixture; never loaded')]);
  await fs.mkdir(root); await fs.mkdir(data);
  await fs.writeFile(path.join(root, 'Clone Hero.exe'), executable());
  await fs.writeFile(path.join(root, 'UnityPlayer.dll'), Buffer.from('Unity test fixture; never loaded'));
  await fs.writeFile(binary, moduleBytes);
  for (const [name, contents] of Object.entries(originals)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), contents);
  }
  const dataFile = path.join(data, 'filters.json');
  if (initialData !== undefined) await fs.writeFile(dataFile, initialData);
  let probe = async () => structuredClone(closed), clock = Date.now();
  const updates = [], services = [];
  const create = () => {
    const service = createFiltersService({ dataDirectory: data, nativeBinaryPath: binary, platform,
      probeGame: () => probe(), now: () => clock, onChange: value => updates.push(value) });
    services.push(service); return service;
  };
  const service = create();
  t.after(async () => {
    await Promise.all(services.map(item => item.dispose()));
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('chartshub-filters-test-')) throw Error('Unexpected test directory');
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { root, dataFile, binary, moduleBytes, service, create, updates,
    file: name => path.join(root, name),
    setProbe: value => { probe = typeof value === 'function' ? value : async () => structuredClone(value); },
    setClock: value => { clock = value; },
    async install() { await service.load(); await service.selectRoot(root); await service.install(); },
    async manifest() { return JSON.parse(await fs.readFile(path.join(root, MANIFEST), 'utf8')); } };
}

test('filters default to disabled and loading a new profile leaves game and data untouched', async t => {
  const f = await fixture(t); const before = await fs.readdir(f.root);
  await f.service.load();
  assert.equal(f.service.status().state, 'unconfigured');
  assert.deepEqual(f.service.status().settings, DEFAULTS); assert.equal(f.service.status().settings.enabled, false);
  const snapshot = f.service.status(); snapshot.settings.enabled = true;
  assert.equal(f.service.status().settings.enabled, false);
  await absent(f.dataFile); assert.deepEqual(await fs.readdir(f.root), before);
});

test('filter ranges reject malformed values while accepting both supported endpoints', () => {
  for (const [key, [minimum, maximum]] of Object.entries(RANGES)) {
    assert.equal(validateSettings({ ...DEFAULTS, [key]: minimum })[key], minimum);
    assert.equal(validateSettings({ ...DEFAULTS, [key]: maximum })[key], maximum);
    for (const value of [minimum - .001, maximum + .001, NaN, Infinity, String(minimum), null]) {
      assert.throws(() => validateSettings({ ...DEFAULTS, [key]: value }), safeError, `${key}: ${value}`);
    }
  }
  for (const value of [null, [], {}, { ...DEFAULTS, enabled: 1 }, { ...DEFAULTS, extra: true }]) assert.throws(() => validateSettings(value), safeError);
});

test('installation backs up and restores existing proxy, settings and heartbeat byte-for-byte', async t => {
  const originals = {
    'dxgi.dll': Buffer.from([0x4d, 0x5a, 0, 0xff, 0x12]),
    [CONFIG]: Buffer.from('\ufeff[Filters]\r\nenabled=1\r\n; original\r\n'),
    [STATUS]: Buffer.from('[Status]\r\npid=123\r\n; original\r\n'),
    'ReShade.ini': '[GENERAL]\r\nPresetPath=.\\My preset.ini\r\n',
    'My preset.ini': 'Techniques=Vibrance@Vibrance.fx\r\n',
    'reshade-shaders/Shaders/Vibrance.fx': 'original shader content'
  };
  const f = await fixture(t, { originals });
  await f.service.load(); await f.service.selectRoot(f.root);
  assert.equal(f.service.status().reshadePresent, true);
  await f.service.install();
  assert.deepEqual(await fs.readFile(f.file('dxgi.dll')), f.moduleBytes);
  assert.match(await fs.readFile(f.file(CONFIG), 'utf8'), /enabled=0\r?\n/);
  assert.equal(f.service.status().installed, true); assert.notEqual(f.service.status().state, 'ready');
  const manifest = await f.manifest(); assert.equal(manifest.phase, 'installed');
  for (const name of ['dxgi.dll', CONFIG, STATUS]) {
    assert.equal(manifest.originals[name], digest(originals[name]));
    assert.deepEqual(await fs.readFile(f.file(path.join(manifest.backup, name))), originals[name]);
  }
  await f.service.restore();
  for (const [name, contents] of Object.entries(originals)) assert.deepEqual(await fs.readFile(f.file(name)), Buffer.from(contents), name);
  assert.equal((await f.manifest()).phase, 'restored');
  assert.equal(f.service.status().installed, false); assert.equal(f.service.status().reshadePresent, true);
});

test('restore removes only newly installed files and preserves unrelated game assets', async t => {
  const f = await fixture(t, { originals: { 'keep.txt': 'do not touch', 'Songs/song/song.ini': 'name=Example' } });
  await f.install();
  await fs.writeFile(f.file(STATUS), '[Status]\nprotocol=1\n');
  await f.service.restore();
  for (const name of ['dxgi.dll', CONFIG, STATUS]) await absent(f.file(name));
  assert.equal(await fs.readFile(f.file('keep.txt'), 'utf8'), 'do not touch');
  assert.equal(await fs.readFile(f.file('Songs/song/song.ini'), 'utf8'), 'name=Example');
  assert.deepEqual(await fs.readFile(f.file('Clone Hero.exe')), executable());
});

test('settings write live only when the selected game has the verified ChartsHub module', async t => {
  const originalConfig = 'third party settings';
  const f = await fixture(t, { originals: { 'dxgi.dll': 'original ReShade', [CONFIG]: originalConfig } });
  await f.service.load(); await f.service.selectRoot(f.root);
  const requested = { ...DEFAULTS, enabled: true, saturation: 1.5, gamma: .8 };
  await f.service.setSettings(requested);
  assert.equal(await fs.readFile(f.file(CONFIG), 'utf8'), originalConfig);
  await f.service.install();
  f.setProbe({ running: true, sessions: [{ pid: 4500, startedAtMs: Date.now() - 2000 }] });
  await f.service.setSettings({ ...requested, contrast: 1.3 });
  const applied = await fs.readFile(f.file(CONFIG), 'utf8');
  assert.match(applied, /enabled=1\r?\n/); assert.match(applied, /contrast=1\.3\r?\n/);
  await fs.writeFile(f.file('dxgi.dll'), 'module replaced outside ChartsHub');
  await f.service.setSettings({ ...requested, contrast: .9 });
  assert.equal(await fs.readFile(f.file(CONFIG), 'utf8'), applied);
  assert.equal(f.service.status().installed, false);
});

test('install and restore refuse running or unknown game processes without changing game files', async t => {
  const f = await fixture(t, { originals: { 'dxgi.dll': 'original proxy' } });
  await f.service.load(); await f.service.selectRoot(f.root);
  for (const running of [true, null]) {
    f.setProbe({ running, sessions: [] });
    await assert.rejects(f.service.install(), safeError);
    assert.equal(await fs.readFile(f.file('dxgi.dll'), 'utf8'), 'original proxy');
    await absent(f.file(MANIFEST)); await absent(f.file(CONFIG));
  }
  f.setProbe(closed); await f.service.install();
  const manifest = await fs.readFile(f.file(MANIFEST)); const config = await fs.readFile(f.file(CONFIG));
  for (const running of [true, null]) {
    f.setProbe({ running, sessions: [] });
    await assert.rejects(f.service.restore(), safeError);
    assert.deepEqual(await fs.readFile(f.file('dxgi.dll')), f.moduleBytes);
    assert.deepEqual(await fs.readFile(f.file(MANIFEST)), manifest);
    assert.deepEqual(await fs.readFile(f.file(CONFIG)), config);
  }
});

test('a modified installed DLL is never overwritten by restoration', async t => {
  const f = await fixture(t, { originals: { 'dxgi.dll': 'original proxy' } }); await f.install();
  await fs.writeFile(f.file('dxgi.dll'), 'new third-party proxy');
  const before = await fs.readFile(f.file(CONFIG));
  await assert.rejects(f.service.restore(), safeError);
  assert.equal(await fs.readFile(f.file('dxgi.dll'), 'utf8'), 'new third-party proxy');
  assert.deepEqual(await fs.readFile(f.file(CONFIG)), before);
  assert.equal((await f.manifest()).phase, 'installed');
});

test('restoration rechecks the proxy after its final process check', async t => {
  const f = await fixture(t, { originals: { 'dxgi.dll': 'original proxy' } }); await f.install();
  let calls = 0;
  f.setProbe(async () => { if (++calls === 2) await fs.writeFile(f.file('dxgi.dll'), 'concurrent replacement'); return structuredClone(closed); });
  await assert.rejects(f.service.restore(), safeError);
  assert.equal(await fs.readFile(f.file('dxgi.dll'), 'utf8'), 'concurrent replacement');
});

test('a tampered backup prevents partial restoration and preserves the installed proxy', async t => {
  const f = await fixture(t, { originals: { 'dxgi.dll': 'original proxy', [CONFIG]: 'original settings' } }); await f.install();
  const manifest = await f.manifest();
  await fs.writeFile(f.file(path.join(manifest.backup, CONFIG)), 'modified backup');
  const config = await fs.readFile(f.file(CONFIG));
  await assert.rejects(f.service.restore(), safeError);
  assert.deepEqual(await fs.readFile(f.file('dxgi.dll')), f.moduleBytes);
  assert.deepEqual(await fs.readFile(f.file(CONFIG)), config);
});

test('an interrupted prepared installation is recoverable after the game closes', async t => {
  const originals = { 'dxgi.dll': 'original ReShade', [CONFIG]: 'original settings', [STATUS]: 'original heartbeat' };
  const f = await fixture(t, { originals });
  await f.service.load(); await f.service.selectRoot(f.root);
  let calls = 0;
  f.setProbe(async () => ++calls === 1 ? structuredClone(closed) : { running: true, sessions: [] });
  await assert.rejects(f.service.install(), safeError);
  assert.equal((await f.manifest()).phase, 'prepared');
  for (const [name, value] of Object.entries(originals)) assert.equal(await fs.readFile(f.file(name), 'utf8'), value);
  f.setProbe(closed); await f.service.refresh();
  assert.equal(f.service.status().state, 'error');
  await f.service.restore();
  for (const [name, value] of Object.entries(originals)) assert.equal(await fs.readFile(f.file(name), 'utf8'), value);
  assert.equal((await f.manifest()).phase, 'restored');
});

test('prepared manifest also recovers when proxy replacement completed before interruption', async t => {
  const f = await fixture(t, { originals: { 'dxgi.dll': 'original proxy', [CONFIG]: 'original settings' } }); await f.install();
  const manifest = await f.manifest(); manifest.phase = 'prepared';
  await fs.writeFile(f.file(MANIFEST), JSON.stringify(manifest));
  await f.service.restore();
  assert.equal(await fs.readFile(f.file('dxgi.dll'), 'utf8'), 'original proxy');
  assert.equal(await fs.readFile(f.file(CONFIG), 'utf8'), 'original settings');
});

test('installation rechecks the proxy after backing it up and leaves a concurrent replacement intact', async t => {
  const f = await fixture(t, { originals: { 'dxgi.dll': 'original proxy' } });
  await f.service.load(); await f.service.selectRoot(f.root);
  let calls = 0;
  f.setProbe(async () => { if (++calls === 2) await fs.writeFile(f.file('dxgi.dll'), 'concurrent replacement'); return structuredClone(closed); });
  await assert.rejects(f.service.install(), safeError);
  assert.equal(await fs.readFile(f.file('dxgi.dll'), 'utf8'), 'concurrent replacement');
  assert.equal((await f.manifest()).phase, 'prepared');
  await absent(f.file(CONFIG));
});

test('fresh native heartbeat requires a live matching process session and rendered frames', async t => {
  const f = await fixture(t); await f.install();
  const now = Date.now(); f.setClock(now);
  const live = { running: true, sessions: [{ pid: 4500, startedAtMs: now - 10000 }] };
  f.setProbe(live);
  const heartbeat = '[Status]\nprotocol=1\npid=4500\nframes=10\nready=1\nenabled=0\nerror=\n';
  await fs.writeFile(f.file(STATUS), heartbeat); await fs.utimes(f.file(STATUS), new Date(now), new Date(now));
  await f.service.refresh(); assert.equal(f.service.status().state, 'ready');
  assert.equal(f.service.status().native.enabled, false);
  await fs.utimes(f.file(STATUS), new Date(now - 6000), new Date(now - 6000));
  await f.service.refresh(); assert.notEqual(f.service.status().state, 'ready'); assert.equal(f.service.status().native, null);
  for (const [modified, probe, text] of [
    [now + 3000, live, heartbeat],
    [now, closed, heartbeat],
    [now, { running: null, sessions: [] }, heartbeat],
    [now, { running: true, sessions: [{ pid: 4501, startedAtMs: now - 1000 }] }, heartbeat],
    [now, { running: true, sessions: [{ pid: 4500, startedAtMs: now + 1000 }] }, heartbeat],
    [now, live, heartbeat.replace('protocol=1', 'protocol=2')],
    [now, live, heartbeat.replace('frames=10', 'frames=0')]
  ]) assert.notEqual(parseStatus(Buffer.from(text), modified, probe, now)?.ready, true);
});

test('invalid persisted data is preserved and cannot be overwritten by a subsequent settings edit', async t => {
  for (const original of ['{invalid json', JSON.stringify({ version: 2, rootPath: null, settings: DEFAULTS }), JSON.stringify({ version: 1, rootPath: null, settings: { ...DEFAULTS, gamma: -1 } })]) {
    const f = await fixture(t, { initialData: original });
    await assert.rejects(f.service.load(), safeError);
    assert.deepEqual(f.service.status().settings, DEFAULTS);
    assert.equal(await fs.readFile(f.dataFile, 'utf8'), original);
    await assert.rejects(Promise.resolve().then(() => f.service.setSettings({ ...DEFAULTS, enabled: true })), safeError);
    assert.deepEqual(f.service.status().settings, DEFAULTS);
    await assert.rejects(f.service.selectRoot(f.root), safeError);
    assert.equal(f.service.status().rootPath, null);
    await assert.rejects(f.service.install(), safeError);
    await absent(f.file('dxgi.dll')); await absent(f.file(CONFIG));
    assert.equal(await fs.readFile(f.dataFile, 'utf8'), original);
  }
});

test('valid saved configuration reloads without enabling filters by default or touching the game', async t => {
  const f = await fixture(t); await f.service.load(); await f.service.selectRoot(f.root);
  const desired = { ...DEFAULTS, saturation: 1.4, exposure: -.5 }; await f.service.setSettings(desired);
  const other = f.create(); await other.load();
  assert.equal(other.status().rootPath, await fs.realpath(f.root)); assert.deepEqual(other.status().settings, desired);
  await absent(f.file('dxgi.dll')); await absent(f.file(CONFIG));
});

test('missing native binary, wrong architecture and an existing D3D11 proxy fail before changing the game', async t => {
  const f = await fixture(t); await f.service.load();
  await fs.writeFile(f.file('Clone Hero.exe'), executable(0x14c));
  await assert.rejects(f.service.selectRoot(f.root), safeError);
  assert.equal(f.service.status().rootPath, null);
  await fs.writeFile(f.file('Clone Hero.exe'), executable()); await f.service.selectRoot(f.root);
  await fs.writeFile(f.file('d3d11.dll'), 'another module'); await assert.rejects(f.service.install(), safeError);
  await absent(f.file(MANIFEST)); await absent(f.file('dxgi.dll'));
  await fs.unlink(f.file('d3d11.dll')); await fs.unlink(f.binary);
  await assert.rejects(f.service.install(), safeError); await absent(f.file(MANIFEST)); await absent(f.file(CONFIG));
});

test('manifest paths cannot direct restoration outside the verified backup directory', async t => {
  const f = await fixture(t, { originals: { 'dxgi.dll': 'original proxy' } }); await f.install();
  const manifest = await f.manifest(); manifest.backup = '..\\outside';
  await fs.writeFile(f.file(MANIFEST), JSON.stringify(manifest));
  await assert.rejects(f.service.restore(), safeError);
  assert.deepEqual(await fs.readFile(f.file('dxgi.dll')), f.moduleBytes);
});

test('healthy native refresh retains its confirmed installation and heartbeat through unrelated publications', async t => {
  const f = await fixture(t), live = await connectNative(f);
  const before = f.service.status(), probeGate = gate(), crossServiceUpdates = [];
  const reshade = createReShadeService({ dataDirectory: path.join(path.dirname(f.dataFile), 'reshade-profile'), addonBinaryPath: f.binary,
    platform: 'win32', probeGame: async () => closed, probeClosed: async () => closed,
    onChange: () => crossServiceUpdates.push(f.service.status()) });
  f.setProbe(async () => { await probeGate.wait(); return live; });
  const refresh = f.service.refresh();
  try {
    await probeGate.entered;
    assert.deepEqual(f.service.status(), before, 'a pending probe must not expose installed=false or native=null');
    await reshade.load(); assert.ok(crossServiceUpdates.length >= 2);
    for (const snapshot of crossServiceUpdates) assert.deepEqual(snapshot, before, 'ReShade publication must read the confirmed native state');
  } finally { probeGate.release(); await refresh; await reshade.dispose(); }
  assert.deepEqual(f.service.status(), before);
});

test('native settings become public only after persistence and the final inspection complete', async t => {
  const f = await fixture(t), live = await connectNative(f);
  const before = f.service.status(), inspectionGate = gate(), desired = { ...before.settings, enabled: true, saturation: 1.6 };
  let probes = 0;
  f.setProbe(async () => { if (++probes === 2) await inspectionGate.wait(); return live; });
  const mutation = f.service.setSettings(desired);
  try {
    await inspectionGate.entered;
    assert.deepEqual(f.service.status(), { ...before, busy: true }, 'persisted but not yet inspected settings must not mix with old public state');
  } finally { inspectionGate.release(); await mutation; }
  const after = f.service.status(); assert.equal(after.busy, false); assert.equal(after.installed, true);
  assert.equal(after.state, 'ready'); assert.deepEqual(after.settings, desired);
});

test('native root selection stays on the confirmed installation until its inspection completes', async t => {
  const f = await fixture(t), other = await fixture(t); await connectNative(f);
  const before = f.service.status(), inspectionGate = gate();
  f.setProbe(async () => { await inspectionGate.wait(); return closed; });
  const selection = f.service.selectRoot(other.root);
  try { await inspectionGate.entered; assert.deepEqual(f.service.status(), { ...before, busy: true }); }
  finally { inspectionGate.release(); await selection; }
  const after = f.service.status(); assert.equal(after.rootPath, await fs.realpath(other.root));
  assert.equal(after.installed, false); assert.equal(after.native, null); assert.equal(after.state, 'not-installed');
});

test('native disconnects and inspection errors replace the confirmed state only after the check completes', async t => {
  const f = await fixture(t), live = await connectNative(f);
  for (const failure of [false, true]) {
    f.setProbe(live); await f.service.refresh(); const before = f.service.status(), probeGate = gate();
    assert.equal(before.state, 'ready');
    f.setProbe(async () => {
      await probeGate.wait();
      if (failure) throw Error('test process query failed');
      return closed;
    });
    const refresh = f.service.refresh();
    try { await probeGate.entered; assert.deepEqual(f.service.status(), before); }
    finally { probeGate.release(); await refresh; }
    const after = f.service.status(); assert.equal(after.native, null);
    assert.equal(after.state, failure ? 'error' : 'restart-required');
    if (failure) assert.equal(typeof after.error, 'string');
    else { assert.equal(after.running, false); assert.equal(after.installed, true); }
  }
});
