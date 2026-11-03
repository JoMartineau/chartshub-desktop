'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createMelonUninstaller } = require('../companion/melon-uninstall.cjs');

const names = { linux: 'MelonLoader.Bootstrap.so', macos: 'MelonLoader.Bootstrap.dylib', wine: 'version.dll' };
const hash = value => createHash('sha256').update(value).digest('hex');
const signatures = Object.fromEntries(Object.entries(names).map(([layout, bootstrap]) => [layout, {
  bootstrap, bootstrapHash: hash('test bootstrap'), coreHash: hash('test core')
}]));

async function fixture(t, layout, platform, processProbe = async () => 'closed') {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'chartshub-loader-removal-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const header = Buffer.alloc(80);
  let selection, executable;
  if (layout === 'linux') {
    Buffer.from([0x7f, 69, 76, 70, 2, 1]).copy(header);
    header.writeUInt16LE(0x3e, 18);
    executable = selection = path.join(root, 'clonehero');
    await fs.mkdir(path.join(root, 'clonehero_Data'));
  } else if (layout === 'wine') {
    header.write('MZ');
    header.writeUInt32LE(64, 60);
    header.writeUInt32LE(0x4550, 64);
    header.writeUInt16LE(0x8664, 68);
    executable = selection = path.join(root, 'Clone Hero.exe');
    await fs.mkdir(path.join(root, 'Clone Hero_Data'));
  } else {
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(0x01000007, 4);
    selection = path.join(root, 'Clone Hero.app');
    executable = path.join(selection, 'Contents', 'MacOS', 'Clone Hero');
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.mkdir(path.join(selection, 'Contents', 'Resources', 'Data'), { recursive: true });
    await fs.writeFile(path.join(selection, 'Contents', 'Info.plist'), 'synthetic');
  }
  await fs.writeFile(executable, header);
  await fs.mkdir(path.join(root, 'MelonLoader', 'net6'), { recursive: true });
  await fs.mkdir(path.join(root, 'Mods'));
  await fs.mkdir(path.join(root, 'UserData'));
  await fs.writeFile(path.join(root, 'Mods', 'keep.dll'), 'unrelated mod');
  await fs.writeFile(path.join(root, 'UserData', 'keep.cfg'), 'unrelated configuration');
  await fs.writeFile(path.join(root, names[layout]), 'test bootstrap');
  await fs.writeFile(path.join(root, 'MelonLoader', 'net6', 'MelonLoader.dll'), 'test core');
  const api = createMelonUninstaller({ platform, processProbe, signatures });
  return { root, selection, executable, header, api };
}

for (const [layout, platform] of [['linux', 'linux'], ['macos', 'darwin'], ['wine', 'linux'], ['wine', 'darwin']]) {
  test('quarantines only the reviewed ' + layout + ' installation on ' + platform, async t => {
    const { api, root, selection, executable, header } = await fixture(t, layout, platform);
    const plan = await api.inspect(selection);
    assert.equal(plan.status, 'ready');
    assert.equal(plan.layout, layout);
    assert.deepEqual(plan.paths, [names[layout], 'MelonLoader']);
    if (layout === 'macos') assert.deepEqual(await api.inspect(executable), plan);
    const result = await api.quarantine(selection, plan.planId);
    assert.equal(result.status, 'quarantined');
    assert.equal((await api.inspect(selection)).status, 'absent');
    assert.equal(await fs.readFile(path.join(root, result.backupName, names[layout]), 'utf8'), 'test bootstrap');
    assert.equal(await fs.readFile(path.join(root, 'Mods', 'keep.dll'), 'utf8'), 'unrelated mod');
    assert.equal(await fs.readFile(path.join(root, 'UserData', 'keep.cfg'), 'utf8'), 'unrelated configuration');
    assert.deepEqual(await fs.readFile(executable), header);
  });
}

test('rejects a changed plan and a proxy from another loader', async t => {
  const { api, root, selection } = await fixture(t, 'wine', 'linux');
  const plan = await api.inspect(selection);
  assert.equal(plan.status, 'ready');
  await fs.writeFile(path.join(root, 'MelonLoader', 'changed.txt'), 'new file');
  assert.equal((await api.quarantine(selection, plan.planId)).reason, 'changed');
  await fs.writeFile(path.join(root, 'winhttp.dll'), 'unrelated proxy');
  assert.equal((await api.inspect(selection)).reason, 'additional_proxy');
  await fs.unlink(path.join(root, 'winhttp.dll'));
  await fs.writeFile(path.join(root, 'version.dll'), 'unexpected bootstrap');
  assert.equal((await api.inspect(selection)).reason, 'unrecognized_loader');
});

test('rejects links inside the loader without touching their targets', async t => {
  const { api, root, selection } = await fixture(t, 'linux', 'linux');
  await fs.symlink(path.join(root, 'UserData'), path.join(root, 'MelonLoader', 'escape'), 'junction');
  assert.equal((await api.inspect(selection)).reason, 'unsafe_path');
  assert.equal(await fs.readFile(path.join(root, 'UserData', 'keep.cfg'), 'utf8'), 'unrelated configuration');
});

test('restores the first file if the game process starts between moves', async t => {
  let calls = 0;
  const { api, root, selection } = await fixture(t, 'linux', 'linux', async () => ++calls >= 3 ? 'running' : 'closed');
  const plan = await api.inspect(selection);
  assert.equal((await api.quarantine(selection, plan.planId)).reason, 'game_running');
  assert.equal(await fs.readFile(path.join(root, names.linux), 'utf8'), 'test bootstrap');
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('.chartshub-melonloader-backup-')), false);
});

test('fails closed when process state cannot be established', async t => {
  const { api, root, selection } = await fixture(t, 'linux', 'linux', async () => 'unknown');
  const plan = await api.inspect(selection);
  assert.equal((await api.quarantine(selection, plan.planId)).reason, 'process_unknown');
  assert.equal(await fs.readFile(path.join(root, names.linux), 'utf8'), 'test bootstrap');
});
