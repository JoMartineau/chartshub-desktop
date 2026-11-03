'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createMelonConsole } = require('../companion/melon-console.cjs');

async function fixture(t, options = {}) {
  const game = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ch-console-'));
  t.after(() => fs.rm(game, { recursive: true, force: true }));
  const pins = {};
  const files = {
    executableSha256: 'Clone Hero.exe',
    gameAssemblySha256: 'GameAssembly.dll',
    metadataSha256: 'Clone Hero_Data/il2cpp_data/Metadata/global-metadata.dat',
    loaderProxySha256: 'version.dll',
    loaderRuntimeSha256: 'MelonLoader/net6/MelonLoader.dll'
  };
  for (const [pin, relative] of Object.entries(files)) {
    const file = path.join(game, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, relative);
    pins[pin] = createHash('sha256').update(relative).digest('hex');
  }
  const data = path.join(game, 'UserData');
  await fs.mkdir(data);
  return {
    game, data, config: path.join(data, 'Loader.cfg'),
    console: createMelonConsole({ platform: 'win32', processProbe: async () => false, pins, ...options })
  };
}

test('hide and show rewrite one TOML value while preserving CRLF, BOM, comments and all other bytes', async t => {
  const f = await fixture(t);
  const original = '\ufeff# Édition locale\r\n[loader]\r\ndisable = false\r\n\r\n[console] # local\r\n'
    + '\thide_console  = false  # mon choix\r\nhide_warnings = true\r\n[logs]\r\nmax_logs = 7';
  await fs.writeFile(f.config, original);
  assert.deepEqual(await f.console.read(f.game), { hideConsole: false });
  assert.deepEqual(await f.console.write(f.game, true), { hideConsole: true });
  assert.equal(await fs.readFile(f.config, 'utf8'), original.replace('= false  # mon choix', '= true  # mon choix'));
  assert.deepEqual(await f.console.read(f.game), { hideConsole: true });
  assert.deepEqual(await f.console.write(f.game, false), { hideConsole: false });
  assert.equal(await fs.readFile(f.config, 'utf8'), original);
  assert.deepEqual(await fs.readdir(f.data), ['Loader.cfg']);
});

test('the console key can be created with an existing unrelated config or when the file does not exist', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.console.read(f.game), { hideConsole: false });
  await f.console.write(f.game, true);
  assert.equal(await fs.readFile(f.config, 'utf8'), '[console]\nhide_console = true\n');
  const original = '[console]\r\nhide_warnings = true\r\n[logs]\r\nmax_logs = 12\r\n';
  await fs.writeFile(f.config, original);
  await f.console.write(f.game, false);
  assert.equal(await fs.readFile(f.config, 'utf8'), original.replace('[console]\r\n', '[console]\r\nhide_console = false\r\n'));
});

test('ambiguous config and hard-linked files remain untouched', async t => {
  const f = await fixture(t);
  for (const original of [
    '[console]\nhide_console = false\nhide_console = true\n',
    '[console]\nhide_console = "false"\n',
    '[console]\nhide_console = false\n[console]\nhide_warnings = false\n',
    'console.hide_console = false\n',
    '["console"]\nhide_console = false\n',
    'comment = """\n[console]\nhide_console = false\n"""\n'
  ]) {
    await fs.writeFile(f.config, original);
    await assert.rejects(f.console.write(f.game, true), { code: 'MELON_CONSOLE_CONFIG_INVALID' });
    assert.equal(await fs.readFile(f.config, 'utf8'), original);
  }
  const original = '[console]\nhide_console = false\n';
  await fs.writeFile(f.config, original);
  await fs.link(f.config, path.join(f.game, 'linked.cfg'));
  await assert.rejects(f.console.write(f.game, true), { code: 'MELON_CONSOLE_CONFIG_INVALID' });
  assert.equal(await fs.readFile(f.config, 'utf8'), original);
});

test('running or unknown processes and a change during preparation block replacement', async t => {
  let processState = true, calls = 0, f;
  const external = '[console]\nhide_console = false\nhide_warnings = true\n';
  f = await fixture(t, { processProbe: async () => {
    if (processState === false && ++calls === 2) await fs.writeFile(f.config, external);
    return processState;
  } });
  const original = '[console]\nhide_console = false\n';
  await fs.writeFile(f.config, original);
  await assert.rejects(f.console.write(f.game, true), { code: 'MELON_CONSOLE_GAME_RUNNING' });
  processState = null;
  await assert.rejects(f.console.write(f.game, true), { code: 'MELON_CONSOLE_PROCESS_UNKNOWN' });
  assert.equal(await fs.readFile(f.config, 'utf8'), original);
  processState = false;
  await assert.rejects(f.console.write(f.game, true), { code: 'MELON_CONSOLE_CONFLICT' });
  assert.equal(await fs.readFile(f.config, 'utf8'), external);
  assert.deepEqual(await fs.readdir(f.data), ['Loader.cfg']);
});

test('an unverified loader or game is rejected before configuration can be written', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.game, 'version.dll'), 'different');
  await assert.rejects(f.console.write(f.game, true), { code: 'MELON_CONSOLE_LOADER_UNVERIFIED' });
  await fs.writeFile(path.join(f.game, 'Clone Hero.exe'), 'different');
  await assert.rejects(f.console.write(f.game, true), { code: 'MELON_CONSOLE_UNSUPPORTED_GAME' });
  assert.deepEqual(await fs.readdir(f.data), []);
});
