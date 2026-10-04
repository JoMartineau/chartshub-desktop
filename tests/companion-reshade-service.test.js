const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { createReShadeService, validateCommand, pipeRequest } = require('../companion/reshade-service.cjs');
const { createFiltersService } = require('../companion/filters-service.cjs');

const ADDON = 'ChartsHubReShade.addon64';
const MANIFEST = 'ChartsHubReShade.install.json';
const closed = { running: false, sessions: [] };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const safeError = error => error?.code === 'RESHADE_SAFE';
const absent = filename => assert.rejects(fs.lstat(filename), { code: 'ENOENT' });
const A = 'ChromaticAberration.fx', B = 'CA.fx';

function gate() {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  return { entered, release, async wait() { enter(); await released; } };
}

function executable(machine = 0x8664) {
  const bytes = Buffer.alloc(256);
  bytes.write('MZ'); bytes.writeUInt32LE(0x80, 0x3c); bytes.write('PE\0\0', 0x80); bytes.writeUInt16LE(machine, 0x84);
  return bytes;
}
function parameter(effect, id, options = {}) {
  return { effect, id, name: 'Strength', label: 'Strength', type: 'float', value: [.5],
    min: [0], max: [1], step: [.01], components: 1, rows: 1, columns: 1, arrayLength: 0,
    uiType: 'slider', items: [], tooltip: '', readOnly: false, ...options };
}
async function fixture(t, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-reshade-test-')));
  const root = path.join(directory, 'Clone Hero'), data = path.join(directory, 'data');
  const binary = path.join(directory, 'bundled.addon64'), dataFile = path.join(data, 'reshade.json');
  const moduleBytes = Buffer.concat([executable(), Buffer.from('ChartsHub test addon; never loaded')]);
  const originals = {
    'dxgi.dll': Buffer.concat([executable(), Buffer.from('ReShadeRegisterAddon\0fixture; never loaded')]),
    'ReShade.ini': Buffer.from('\ufeff[GENERAL]\r\nPresetPath=.\\My preset.ini\r\nPerformanceMode=0\r\n; preserved\r\n'),
    'My preset.ini': Buffer.from('Techniques=CA@ChromaticAberration.fx\r\n[ChromaticAberration.fx]\r\nStrength=0.3\r\n'),
    'reshade-shaders/Shaders/ChromaticAberration.fx': Buffer.from('original shader fixture'),
    'Songs/keep/song.ini': Buffer.from('name=Preserved song'), ...options.originals
  };
  await fs.mkdir(root); await fs.mkdir(data);
  await fs.writeFile(path.join(root, 'Clone Hero.exe'), executable());
  await fs.writeFile(path.join(root, 'UnityPlayer.dll'), 'Unity fixture; never loaded');
  await fs.writeFile(binary, moduleBytes);
  for (const [name, bytes] of Object.entries(originals)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), bytes);
  }
  if (options.initialData !== undefined) await fs.writeFile(dataFile, options.initialData);
  const runtime = { protocol: 1, addonVersion: '0.11.0', pid: 42424, generation: 1,
    runtimeReady: true, effectsEnabled: true, presetName: 'My preset.ini', executablePath: path.join(root, 'Clone Hero.exe') };
  const techniques = [
    { id: '1:t:1', name: 'CA', label: 'CA', effect: A, enabled: false },
    { id: '1:t:2', name: 'CA', label: 'CA', effect: B, enabled: true }
  ];
  const uniforms = { [A]: [parameter(A, '1:u:3')], [B]: [parameter(B, '1:u:4')] };
  let probe = async () => structuredClone(closed), closedProbe = async () => structuredClone(closed), interceptor = null;
  const requests = [], updates = [], services = [];
  const transport = async (pid, request) => {
    requests.push({ pid, ...structuredClone(request) });
    let answer = structuredClone(runtime);
    if (request.action === 'catalog') answer.techniques = structuredClone(techniques);
    if (request.action === 'uniforms') { answer.effect = request.effect; answer.uniforms = structuredClone(uniforms[request.effect] || []); }
    if (interceptor) return interceptor(pid, request, answer);
    if (request.action === 'setEnabled') runtime.effectsEnabled = request.enabled;
    if (request.action === 'setTechnique') techniques.find(item => item.id === request.techniqueId).enabled = request.enabled;
    if (request.action === 'setUniform') Object.values(uniforms).flat().find(item => item.id === request.uniformId).value = [...request.value];
    return answer;
  };
  const create = extra => {
    const service = createReShadeService({ dataDirectory: data, addonBinaryPath: binary, platform: options.platform || 'win32',
      probeGame: () => probe(), probeClosed: () => closedProbe(), transport, onChange: value => updates.push(value), ...extra });
    services.push(service); return service;
  };
  const service = create(options.serviceOptions);
  t.after(async () => {
    await Promise.all(services.map(item => item.dispose()));
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== await fs.realpath(os.tmpdir()) || !path.basename(resolved).startsWith('chartshub-reshade-test-')) throw Error('Unexpected test directory');
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const result = { directory, root, data, dataFile, binary, moduleBytes, originals, service, create, services,
    runtime, techniques, uniforms, requests, updates, file: name => path.join(root, name),
    setProbe: value => { probe = typeof value === 'function' ? value : async () => structuredClone(value); },
    setClosed: value => { closedProbe = typeof value === 'function' ? value : async () => structuredClone(value); },
    intercept: value => { interceptor = value; },
    async select() { await service.load(); await service.selectRoot(root); },
    async install() { await result.select(); await service.install(); },
    async connect() { await result.install(); result.setProbe({ running: true, sessions: [{ pid: runtime.pid }] }); await service.refresh(); assert.equal(service.status().connected, true); },
    async unchanged() { for (const [name, bytes] of Object.entries(originals)) assert.deepEqual(await fs.readFile(result.file(name)), Buffer.from(bytes), name); }
  };
  return result;
}

test('a fresh profile reads no game state and does not create configuration', async t => {
  const f = await fixture(t); const before = await fs.readdir(f.root);
  await f.service.load();
  assert.equal(f.service.status().state, 'unconfigured'); assert.equal(f.service.status().connected, false);
  assert.equal(f.service.status().catalog, null); await absent(f.dataFile);
  assert.deepEqual(await fs.readdir(f.root), before); assert.deepEqual(f.requests, []);
});

test('closed-game installation adds only the owned bridge and journal, preserving all ReShade files', async t => {
  const f = await fixture(t); let probes = 0;
  f.setClosed(async () => { probes++; return closed; });
  await f.install();
  assert.ok(probes >= 2, 'installation verifies closure again before writing');
  assert.deepEqual(await fs.readFile(f.file(ADDON)), f.moduleBytes);
  const journal = JSON.parse(await fs.readFile(f.file(MANIFEST), 'utf8'));
  assert.equal(journal.phase, 'installed'); assert.equal(journal.moduleHash, digest(f.moduleBytes));
  assert.equal(f.service.status().installed, true); assert.equal(f.service.status().connected, false);
  assert.equal(f.service.status().state, 'restart-required'); await f.unchanged();
  const restored = f.create(); await restored.load(); assert.equal(restored.status().rootPath, await fs.realpath(f.root));
});

test('installation restores the verified native-module backup through the existing service', async t => {
  const f = await fixture(t);
  const nativeBinary = path.join(f.directory, 'native-dxgi.dll');
  await fs.writeFile(nativeBinary, Buffer.concat([executable(), Buffer.from('custom filters fixture')]));
  const filters = createFiltersService({ dataDirectory: f.data, nativeBinaryPath: nativeBinary, platform: 'win32', probeGame: async () => closed });
  f.services.push(filters); await filters.load(); await filters.selectRoot(f.root); await filters.install();
  assert.notDeepEqual(await fs.readFile(f.file('dxgi.dll')), f.originals['dxgi.dll']);
  const service = f.create({ filtersService: filters }); await service.load(); await service.selectRoot(f.root);
  assert.equal(service.status().restoreAvailable, true); await service.install();
  assert.equal(service.status().installed, true); await f.unchanged();
  assert.equal(JSON.parse(await fs.readFile(f.file('ChartsHubFilters.install.json'), 'utf8')).phase, 'restored');
  assert.equal(filters.status().installed, false);
});

test('unknown add-on bytes are preserved even when installation is otherwise valid', async t => {
  const f = await fixture(t); const unknown = Buffer.from('another addon');
  await f.select(); await fs.writeFile(f.file(ADDON), unknown);
  await assert.rejects(f.service.install(), safeError);
  assert.deepEqual(await fs.readFile(f.file(ADDON)), unknown); await absent(f.file(MANIFEST)); await f.unchanged();
});

test('a replaced owned add-on cannot be overwritten using its old journal', async t => {
  const f = await fixture(t); await f.install(); const journal = await fs.readFile(f.file(MANIFEST));
  const replacement = Buffer.from('changed after ChartsHub installation'); await fs.writeFile(f.file(ADDON), replacement);
  await assert.rejects(f.service.install(), safeError);
  assert.deepEqual(await fs.readFile(f.file(ADDON)), replacement); assert.deepEqual(await fs.readFile(f.file(MANIFEST)), journal);
});

test('a junction at the add-on path is rejected without touching its target', async t => {
  const f = await fixture(t); await f.select();
  const target = path.join(f.directory, 'unrelated'); await fs.mkdir(target); await fs.writeFile(path.join(target, 'keep'), 'unchanged');
  await fs.symlink(target, f.file(ADDON), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.install(), safeError);
  assert.equal((await fs.lstat(f.file(ADDON))).isSymbolicLink(), true);
  assert.equal(await fs.readFile(path.join(target, 'keep'), 'utf8'), 'unchanged'); await absent(f.file(MANIFEST));
});

test('running or unknown closure blocks install independently of a cached closed status', async t => {
  const f = await fixture(t); await f.select();
  for (const running of [true, null, undefined]) {
    f.setClosed({ running, sessions: [] });
    await assert.rejects(f.service.install(), safeError); await absent(f.file(ADDON)); await absent(f.file(MANIFEST));
  }
  await f.unchanged();
});

test('a game starting during preparation prevents the final add-on write', async t => {
  const f = await fixture(t); await f.select(); let checks = 0;
  f.setClosed(async () => ++checks === 1 ? closed : { running: true, sessions: [{ pid: 100 }] });
  await assert.rejects(f.service.install(), safeError); assert.equal(checks, 2);
  await absent(f.file(ADDON)); await absent(f.file(MANIFEST)); await f.unchanged();
});

test('a concurrent add-on replacement detected by the second probe is preserved', async t => {
  const f = await fixture(t); await f.select(); let checks = 0;
  const replacement = Buffer.from('external add-on write');
  f.setClosed(async () => { if (++checks === 2) await fs.writeFile(f.file(ADDON), replacement); return closed; });
  await assert.rejects(f.service.install(), safeError);
  assert.deepEqual(await fs.readFile(f.file(ADDON)), replacement); await absent(f.file(MANIFEST));
});

test('an interrupted prepared install resumes only its matching owned add-on', async t => {
  const f = await fixture(t); await f.select();
  await fs.writeFile(f.file(MANIFEST), JSON.stringify({ version: 1, phase: 'prepared', moduleHash: digest(f.moduleBytes) }));
  await fs.writeFile(f.file(ADDON), f.moduleBytes); await f.service.install();
  assert.equal(JSON.parse(await fs.readFile(f.file(MANIFEST), 'utf8')).phase, 'installed'); await f.unchanged();
});

test('an interrupted upgrade recognizes its previous verified hash without trusting arbitrary bytes', async t => {
  const f = await fixture(t); await f.select();
  const previous = Buffer.concat([executable(), Buffer.from('previous owned version')]);
  await fs.writeFile(f.file(ADDON), previous);
  await fs.writeFile(f.file(MANIFEST), JSON.stringify({ version: 1, phase: 'prepared', moduleHash: digest(f.moduleBytes), previousHash: digest(previous) }));
  await f.service.install(); assert.deepEqual(await fs.readFile(f.file(ADDON)), f.moduleBytes);
  assert.equal(JSON.parse(await fs.readFile(f.file(MANIFEST), 'utf8')).phase, 'installed'); await f.unchanged();
});

test('a changed graphics proxy aborts installation before any bridge journal or add-on is written', async t => {
  const f = await fixture(t); await f.select(); let checks = 0;
  const changed = Buffer.concat([executable(), Buffer.from('external graphics proxy')]);
  f.setClosed(async () => { if (++checks === 2) await fs.writeFile(f.file('dxgi.dll'), changed); return closed; });
  await assert.rejects(f.service.install(), safeError);
  assert.deepEqual(await fs.readFile(f.file('dxgi.dll')), changed); await absent(f.file(ADDON)); await absent(f.file(MANIFEST));
});

test('a non-ReShade or altered backup is refused before restoring the existing native module', async t => {
  for (const altered of [false, true]) {
    const f = await fixture(t, altered ? {} : { originals: { 'dxgi.dll': Buffer.concat([executable(), Buffer.from('another graphics proxy')]) } });
    const nativeBinary = path.join(f.directory, 'native-dxgi.dll'); const nativeBytes = Buffer.concat([executable(), Buffer.from('custom filters fixture')]);
    await fs.writeFile(nativeBinary, nativeBytes);
    const filters = createFiltersService({ dataDirectory: f.data, nativeBinaryPath: nativeBinary, platform: 'win32', probeGame: async () => closed });
    f.services.push(filters); await filters.load(); await filters.selectRoot(f.root); await filters.install();
    const journalFile = f.file('ChartsHubFilters.install.json'), journalBytes = await fs.readFile(journalFile);
    if (altered) {
      const journal = JSON.parse(journalBytes.toString());
      await fs.appendFile(f.file(path.join(journal.backup, 'dxgi.dll')), 'tampered backup');
    }
    const service = f.create({ filtersService: filters }); await service.load(); await service.selectRoot(f.root);
    await assert.rejects(service.install(), safeError);
    assert.deepEqual(await fs.readFile(f.file('dxgi.dll')), nativeBytes); assert.deepEqual(await fs.readFile(journalFile), journalBytes);
    await absent(f.file(ADDON)); await absent(f.file(MANIFEST));
    assert.deepEqual(await fs.readFile(f.file('ReShade.ini')), f.originals['ReShade.ini']);
    assert.deepEqual(await fs.readFile(f.file('My preset.ini')), f.originals['My preset.ini']);
  }
});

test('invalid persisted profiles are preserved and cannot be bypassed by selecting or installing', async t => {
  const bytes = '{not valid JSON\r\n'; const f = await fixture(t, { initialData: bytes });
  await assert.rejects(f.service.load(), safeError); await assert.rejects(f.service.selectRoot(f.root), safeError);
  await assert.rejects(f.service.install(), safeError); await f.service.refresh();
  assert.equal(await fs.readFile(f.dataFile, 'utf8'), bytes); await absent(f.file(ADDON)); await f.unchanged();
});

test('failed profile persistence leaves the selected root unchanged', async t => {
  const f = await fixture(t); await f.service.load(); await fs.mkdir(f.dataFile);
  await assert.rejects(f.service.selectRoot(f.root), safeError); assert.equal(f.service.status().rootPath, null);
  await assert.rejects(f.service.install(), safeError); await absent(f.file(ADDON));
  assert.equal((await fs.lstat(f.dataFile)).isDirectory(), true); await f.unchanged();
});

test('unsupported platform and 32-bit game cannot install the bridge', async t => {
  const f = await fixture(t, { platform: 'linux' }); await f.select(); await assert.rejects(f.service.install(), safeError);
  await absent(f.file(ADDON)); assert.equal(f.service.status().supported, false);
  const windows = f.create({ platform: 'win32' }); await windows.load();
  await fs.writeFile(f.file('Clone Hero.exe'), executable(0x14c));
  await assert.rejects(windows.selectRoot(f.root), safeError); await absent(f.file(ADDON));
});

test('bridge responses must identify the selected process and installation', async t => {
  const f = await fixture(t); await f.connect();
  for (const corrupt of [{ pid: 12 }, { protocol: 2 }, { executablePath: path.join(f.directory, 'other', 'Clone Hero.exe') }]) {
    f.intercept((_pid, _request, answer) => ({ ...answer, ...corrupt }));
    await f.service.refresh(); assert.equal(f.service.status().connected, false); assert.equal(f.service.status().catalog, null);
    const count = f.requests.length; await assert.rejects(f.service.command({ action: 'enabled', enabled: false }), safeError);
    assert.equal(f.requests.length, count, 'no command is sent to an untrusted runtime');
  }
});

test('malformed generation and runtime-ready fields cannot create a connected session', async t => {
  const f = await fixture(t); await f.connect();
  for (const corrupt of [{ generation: undefined }, { generation: '1' }, { generation: -1 }, { generation: 1.5 }, { runtimeReady: 'true' }]) {
    f.intercept((_pid, _request, answer) => ({ ...answer, ...corrupt })); await f.service.refresh();
    assert.equal(f.service.status().connected, false, JSON.stringify(corrupt));
    assert.equal(f.service.status().catalog, null, JSON.stringify(corrupt));
  }
});

test('a loading runtime remains disconnected and cannot accept changes', async t => {
  const f = await fixture(t); await f.connect(); f.runtime.runtimeReady = false;
  await f.service.refresh(); assert.equal(f.service.status().connected, false);
  const count = f.requests.length; await assert.rejects(f.service.command({ action: 'save' }), safeError); assert.equal(f.requests.length, count);
});

test('same-named techniques and uniforms remain scoped to their selected effect', async t => {
  const f = await fixture(t); await f.connect();
  await f.service.command({ action: 'selectEffect', effect: A });
  assert.equal(f.service.status().catalog.uniforms[0].effect, A);
  await f.service.command({ action: 'selectEffect', effect: B });
  assert.equal(f.service.status().catalog.uniforms[0].effect, B);
  const count = f.requests.length;
  await assert.rejects(f.service.command({ action: 'uniform', id: '1:u:3', values: [.3] }), safeError); assert.equal(f.requests.length, count);
  await f.service.command({ action: 'uniform', id: '1:u:4', values: [.7] });
  assert.deepEqual(f.uniforms[A][0].value, [.5]); assert.deepEqual(f.uniforms[B][0].value, [.7]);
  await f.service.command({ action: 'technique', id: '1:t:1', enabled: true });
  assert.equal(f.techniques[0].enabled, true); assert.equal(f.techniques[1].enabled, true); await f.unchanged();
});

test('failed uniform selection never relabels stale parameters as the new effect', async t => {
  const f = await fixture(t); await f.connect(); await f.service.command({ action: 'selectEffect', effect: A });
  f.intercept((_pid, request, answer) => request.action === 'uniforms' && request.effect === B ? { ...answer, uniforms: f.uniforms[A] } : answer);
  await assert.rejects(f.service.command({ action: 'selectEffect', effect: B }), safeError);
  const catalog = f.service.status().catalog;
  assert.ok(!catalog || catalog.selectedEffect === A || (catalog.selectedEffect === B && catalog.uniforms.length === 0));
  if (catalog?.uniforms.length) assert.ok(catalog.uniforms.every(item => item.effect === catalog.selectedEffect));
});

test('uniform replies identify the requested effect even when they contain no parameters', async t => {
  const f = await fixture(t); await f.connect();
  f.intercept((_pid, request, answer) => request.action === 'uniforms' ? { ...answer, effect: B, uniforms: [] } : answer);
  await assert.rejects(f.service.command({ action: 'selectEffect', effect: A }), safeError);
});

test('a failed parameter refresh cannot leave a connected flag with no catalog', async t => {
  const f = await fixture(t); await f.connect(); await f.service.command({ action: 'selectEffect', effect: A });
  f.intercept((_pid, request, answer) => request.action === 'uniforms' ? { ...answer, uniforms: [{ bad: true }] } : answer);
  await f.service.refresh(); assert.equal(f.service.status().connected, false); assert.equal(f.service.status().catalog, null);
});

test('uniform type, shape, read-only and scalar/vector bounds are enforced before transport', async t => {
  const f = await fixture(t);
  f.uniforms[A] = [
    parameter(A, '1:u:3', { value: [0, 0], components: 2, rows: 2, min: [-10], max: [10] }),
    parameter(A, '1:u:5', { type: 'int', value: [2], min: [0], max: [16] }),
    parameter(A, '1:u:6', { type: 'bool', value: [true], min: null, max: null }),
    parameter(A, '1:u:7', { type: 'uint', value: [2], min: null, max: null }),
    parameter(A, '1:u:8', { readOnly: true })
  ];
  await f.connect(); await f.service.command({ action: 'selectEffect', effect: A });
  for (const [id, values] of [['1:u:3', [0]], ['1:u:3', [0, 10.01]], ['1:u:3', [-10.01, 0]], ['1:u:5', [2.5]], ['1:u:6', [1]], ['1:u:7', [-1]], ['1:u:8', [.4]], ['999:u:1', [.5]]]) {
    const count = f.requests.length; await assert.rejects(f.service.command({ action: 'uniform', id, values }), safeError); assert.equal(f.requests.length, count);
  }
  await f.service.command({ action: 'uniform', id: '1:u:3', values: [-10, 10] });
  await f.service.command({ action: 'uniform', id: '1:u:6', values: [false] });
  assert.deepEqual(f.uniforms[A][0].value, [-10, 10]); assert.deepEqual(f.uniforms[A][2].value, [false]);
});

test('command schema excludes arbitrary paths, extra arguments and unbounded data', () => {
  for (const command of [null, [], { action: 'reload' }, { action: 'save', path: 'some.ini' },
    { action: 'enabled', enabled: 1 }, { action: 'technique', id: '../bad', enabled: true },
    { action: 'selectEffect', effect: 'A\0.fx' }, { action: 'uniform', id: '1:u:3', values: [] },
    { action: 'uniform', id: '1:u:3', values: Array(17).fill(0) },
    ...[NaN, Infinity, 1e13, '1', null].map(value => ({ action: 'uniform', id: '1:u:3', values: [value] }))]) assert.throws(() => validateCommand(command), safeError);
  const input = { action: 'uniform', id: '1:u:3', values: [.3] }, copy = validateCommand(input);
  copy.values[0] = .8; assert.equal(input.values[0], .3);
});

test('an acknowledged technique activation may reload effects and refresh IDs without repeating the mutation', async t => {
  const f = await fixture(t); await f.connect(); await f.service.command({ action: 'selectEffect', effect: A });
  f.intercept((_pid, request, answer) => {
    if (request.action === 'setTechnique') {
      assert.equal(request.techniqueId, '1:t:1');
      f.runtime.generation = 2; f.techniques[0].enabled = true;
      for (const technique of f.techniques) technique.id = technique.id.replace(/^1:/, '2:');
      for (const parameter of Object.values(f.uniforms).flat()) parameter.id = parameter.id.replace(/^1:/, '2:');
      return { ...answer, generation: 2 };
    }
    return answer;
  });
  await f.service.command({ action: 'technique', id: '1:t:1', enabled: true });
  assert.equal(f.service.status().connected, true); assert.equal(f.service.status().error, null);
  assert.equal(f.service.status().catalog.techniques[0].id, '2:t:1'); assert.equal(f.service.status().catalog.techniques[0].enabled, true);
  assert.equal(f.requests.filter(request => request.action === 'setTechnique').length, 1, 'a successful mutation must never be retried');
  const count = f.requests.length;
  await assert.rejects(f.service.command({ action: 'technique', id: '1:t:1', enabled: false }), safeError);
  await assert.rejects(f.service.command({ action: 'uniform', id: '1:u:3', values: [.7] }), safeError);
  assert.equal(f.requests.length, count, 'cached generation-one IDs must be rejected locally');
  await f.service.command({ action: 'selectEffect', effect: A });
  assert.equal(f.service.status().catalog.uniforms[0].id, '2:u:3');
  f.intercept(null); await f.service.command({ action: 'uniform', id: '2:u:3', values: [.7] });
  assert.deepEqual(f.uniforms[A][0].value, [.7]);
});

test('acknowledged reload stays successful when its refresh is unavailable and leaves stale commands disabled', async t => {
  const f = await fixture(t); await f.connect(); await f.service.command({ action: 'selectEffect', effect: A });
  let applied = false;
  f.intercept((_pid, request, answer) => {
    if (request.action === 'setTechnique') { applied = true; f.runtime.generation = 2; return { ...answer, generation: 2 }; }
    if (applied) throw Object.assign(Error('Effects are still reloading.'), { code: 'RESHADE_SAFE' });
    return answer;
  });
  await f.service.command({ action: 'technique', id: '1:t:1', enabled: true });
  assert.equal(f.requests.filter(request => request.action === 'setTechnique').length, 1);
  assert.equal(f.service.status().connected, false); assert.equal(f.service.status().catalog, null);
  const count = f.requests.length;
  await assert.rejects(f.service.command({ action: 'uniform', id: '1:u:3', values: [.7] }), safeError);
  await assert.rejects(f.service.command({ action: 'technique', id: '1:t:1', enabled: true }), safeError);
  assert.equal(f.requests.length, count);
});

test('a native stale-ID refusal still fails the command without retrying the mutation', async t => {
  const f = await fixture(t); await f.connect();
  f.intercept((_pid, request, answer) => {
    if (request.action === 'setTechnique') throw Object.assign(Error('Refresh the effect catalog after reload.'), { code: 'RESHADE_SAFE' });
    return answer;
  });
  await assert.rejects(f.service.command({ action: 'technique', id: '1:t:1', enabled: true }), /Refresh the effect catalog/);
  assert.equal(f.requests.filter(request => request.action === 'setTechnique').length, 1);
  assert.equal(f.techniques[0].enabled, false);
});

test('explicit save calls the bridge API without rewriting local ReShade configuration', async t => {
  const f = await fixture(t); await f.connect();
  await f.service.command({ action: 'enabled', enabled: false });
  assert.equal(f.service.status().catalog.enabled, false);
  assert.equal(f.requests.some(request => request.action === 'savePreset'), false);
  await f.service.command({ action: 'save' }); assert.equal(f.requests.filter(request => request.action === 'savePreset').length, 1);
  await f.unchanged();
});

test('bridge errors propagate as safe errors without pretending a command was saved', async t => {
  const f = await fixture(t); await f.connect();
  f.intercept((_pid, request, answer) => {
    if (request.action === 'savePreset') throw Object.assign(Error('No frame; queued operation cancelled.'), { code: 'RESHADE_SAFE' });
    return answer;
  });
  await assert.rejects(f.service.command({ action: 'save' }), /queued operation cancelled/);
  assert.match(f.service.status().error, /queued operation cancelled/); await f.unchanged();
});

test('status snapshots cannot modify service-owned technique or uniform state', async t => {
  const f = await fixture(t); await f.connect(); await f.service.command({ action: 'selectEffect', effect: A });
  const snapshot = f.service.status(); snapshot.catalog.uniforms[0].values[0] = 999; snapshot.catalog.techniques[0].id = 'forged';
  assert.equal(f.service.status().catalog.uniforms[0].values[0], .5); assert.equal(f.service.status().catalog.techniques[0].id, '1:t:1');
});

test('healthy refresh exposes its last committed snapshot even when another service publishes midway', async t => {
  const f = await fixture(t); await f.connect(); await f.service.command({ action: 'selectEffect', effect: A });
  const before = f.service.status(), probeGate = gate(), uniformsGate = gate(), crossServiceUpdates = [];
  const native = createFiltersService({ dataDirectory: path.join(f.directory, 'native-profile'), nativeBinaryPath: f.binary,
    platform: 'win32', probeGame: async () => closed, onChange: () => crossServiceUpdates.push(f.service.status()) });
  f.services.push(native);
  f.techniques[0].enabled = true; f.uniforms[A][0].value = [.8];
  f.setProbe(async () => { await probeGate.wait(); return { running: true, sessions: [{ pid: f.runtime.pid }] }; });
  f.intercept(async (_pid, request, answer) => { if (request.action === 'uniforms') await uniformsGate.wait(); return answer; });
  const refresh = f.service.refresh();
  try {
    await probeGate.entered;
    assert.deepEqual(f.service.status(), before, 'in-progress disk/process checks must not expose connected=false');
    await native.load();
    assert.ok(crossServiceUpdates.length >= 2);
    for (const snapshot of crossServiceUpdates) assert.deepEqual(snapshot, before, 'unrelated publications must see the confirmed ReShade state');
    probeGate.release(); await uniformsGate.entered;
    assert.deepEqual(f.service.status(), before, 'a new catalog must not publish before matching uniforms are validated');
  } finally { probeGate.release(); uniformsGate.release(); await refresh; }
  assert.equal(f.service.status().connected, true); assert.equal(f.service.status().installed, true);
  assert.equal(f.service.status().catalog.techniques[0].enabled, true);
  assert.deepEqual(f.service.status().catalog.uniforms[0].values, [.8]);
});

test('a pending technique mutation retains the confirmed catalog until its full inspection completes', async t => {
  const f = await fixture(t); await f.connect(); await f.service.command({ action: 'selectEffect', effect: A });
  const before = f.service.status(), inspectionGate = gate();
  f.intercept(async (_pid, request, answer) => {
    if (request.action === 'setTechnique') f.techniques[0].enabled = request.enabled;
    if (request.action === 'uniforms') await inspectionGate.wait();
    return answer;
  });
  const mutation = f.service.command({ action: 'technique', id: '1:t:1', enabled: true });
  try {
    await inspectionGate.entered;
    assert.deepEqual(f.service.status(), { ...before, busy: true });
  } finally { inspectionGate.release(); await mutation; }
  assert.equal(f.service.status().busy, false); assert.equal(f.service.status().connected, true);
  assert.equal(f.service.status().catalog.techniques[0].enabled, true);
});

test('selecting another installation retains the confirmed root and catalog until inspection finishes', async t => {
  const f = await fixture(t), other = await fixture(t); await f.connect(); await f.service.command({ action: 'selectEffect', effect: A });
  const before = f.service.status(), inspectionGate = gate();
  f.setProbe(async () => { await inspectionGate.wait(); return closed; });
  const selection = f.service.selectRoot(other.root);
  try {
    await inspectionGate.entered;
    assert.deepEqual(f.service.status(), { ...before, busy: true });
  } finally { inspectionGate.release(); await selection; }
  assert.equal(f.service.status().rootPath, await fs.realpath(other.root));
  assert.equal(f.service.status().installed, false); assert.equal(f.service.status().connected, false);
  assert.equal(f.service.status().catalog, null);
});

test('a confirmed disconnect or inspection error is committed only after its delayed probe resolves', async t => {
  const f = await fixture(t); await f.connect();
  for (const failure of [false, true]) {
    f.setProbe({ running: true, sessions: [{ pid: f.runtime.pid }] }); await f.service.refresh();
    const before = f.service.status(), probeGate = gate(); assert.equal(before.connected, true);
    f.setProbe(async () => {
      await probeGate.wait();
      if (failure) throw Error('test process query failed');
      return closed;
    });
    const refresh = f.service.refresh();
    try { await probeGate.entered; assert.deepEqual(f.service.status(), before); }
    finally { probeGate.release(); await refresh; }
    const after = f.service.status(); assert.equal(after.connected, false); assert.equal(after.catalog, null);
    assert.equal(after.state, failure ? 'error' : 'restart-required');
    if (failure) assert.equal(typeof after.error, 'string');
    else assert.equal(after.running, false);
  }
});

async function withPipe(t, reply) {
  // A test-owned pipe name; no running game process is queried or contacted.
  const pid = 900000000 + Math.floor(Math.random() * 10000000);
  const server = net.createServer(socket => { socket.on('error', () => {}); socket.once('data', data => reply(socket, JSON.parse(data.toString().trim()))); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen('\\\\.\\pipe\\ChartsHub-ReShade-' + pid, resolve); });
  t.after(() => new Promise(resolve => server.close(resolve))); return pid;
}

test('pipe transport accepts fragmented responses and rejects mismatched request IDs', { skip: process.platform !== 'win32' }, async t => {
  const pid = await withPipe(t, (socket, request) => {
    const response = JSON.stringify({ id: request.id, ok: true, data: { protocol: 1 } });
    socket.write(response.slice(0, 8)); setImmediate(() => socket.end(response.slice(8) + '\n'));
  });
  assert.deepEqual(await pipeRequest(pid, { id: 7, action: 'status' }), { protocol: 1 });
  const badPid = await withPipe(t, socket => socket.end('{"id":8,"ok":true,"data":{}}\n'));
  await assert.rejects(pipeRequest(badPid, { id: 7, action: 'status' }), safeError);
});

test('pipe transport rejects malformed replies and preserves bridge failure messages', { skip: process.platform !== 'win32' }, async t => {
  for (const reply of ['not JSON\n', '{"id":1,"ok":true,"data":[]}\n', '{"id":1,"ok":"yes","data":{}}\n']) {
    const pid = await withPipe(t, socket => socket.end(reply));
    await assert.rejects(pipeRequest(pid, { id: 1, action: 'status' }), safeError);
  }
  const pid = await withPipe(t, socket => socket.end('{"id":1,"ok":false,"error":{"code":"stale_id","message":"Refresh after reload."}}\n'));
  await assert.rejects(pipeRequest(pid, { id: 1, action: 'status' }), /Refresh after reload/);
});
