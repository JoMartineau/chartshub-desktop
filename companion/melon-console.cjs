'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const { defaultProcessProbe, REVIEWED_GAME_MOD_PINS } = require('./game-mod-preflight.cjs');
const { validateLocalQuickImportPath } = require('./quick-import-preferences.cjs');

const MAX_CONFIG_BYTES = 65536;
const DEFAULT_PINS = Object.freeze({
  ...REVIEWED_GAME_MOD_PINS,
  loaderProxySha256: '0ce7a4e530c7f83f172a2c44aed45eedb3bdcf06b83760f143a0fba6885fa929',
  loaderRuntimeSha256: 'bdd43dc0f3893c208c95389b863ab61c967ae14204da0dd8051647e754c8709b'
});
const fail = name => { const code = 'MELON_CONSOLE_' + name; throw Object.assign(Error(code), { code }); };
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
const stamp = value => value && [
  value.dev, value.ino, value.mode, value.nlink, value.size, value.mtimeNs, value.ctimeNs
].join(':');

function inspectConfig(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('CONFIG_INVALID'); }
  const bom = text.startsWith('\ufeff') ? '\ufeff' : '';
  const parts = text.slice(bom.length).split(/(\r\n|\n)/);
  let table = '', consoleHeader = -1, optionIndex = -1, optionMatch;
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(line)) fail('CONFIG_INVALID');
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue;
    // The loader writes simple TOML tables and assignments. Leave complex
    // syntax alone when a single, unambiguous console setting cannot be proven.
    if (/"""|'''/.test(line)) fail('CONFIG_INVALID');
    const heading = /^[ \t]*\[([a-zA-Z0-9_-]+)\][ \t]*(?:#.*)?$/.exec(line);
    if (heading) {
      table = heading[1];
      if (table === 'console') {
        if (consoleHeader !== -1) fail('CONFIG_INVALID');
        consoleHeader = index;
      }
      continue;
    }
    const key = /^[ \t]*([a-zA-Z0-9_-]+)[ \t]*=/.exec(line)?.[1];
    if (!key || (table === '' && key === 'console')) fail('CONFIG_INVALID');
    if (table !== 'console' || key !== 'hide_console') continue;
    optionMatch = /^([ \t]*hide_console[ \t]*=[ \t]*)(true|false)([ \t]*(?:#.*)?)$/.exec(line);
    if (!optionMatch || optionIndex !== -1) fail('CONFIG_INVALID');
    optionIndex = index;
  }
  return {
    hideConsole: optionMatch?.[2] === 'true',
    update(hideConsole) {
      const choice = String(hideConsole);
      if (optionMatch) parts[optionIndex] = optionMatch[1] + choice + optionMatch[3];
      else {
        const newline = parts[1] || '\n';
        const setting = 'hide_console = ' + choice;
        if (consoleHeader >= 0) {
          const followingNewline = parts[consoleHeader + 1];
          if (followingNewline) parts.splice(consoleHeader + 2, 0, setting, followingNewline);
          else parts.push(newline, setting, newline);
        } else {
          if (parts.at(-1)) parts.push(newline);
          parts.push('[console]', newline, setting, newline);
        }
      }
      const updated = Buffer.from(bom + parts.join(''), 'utf8');
      if (updated.length > MAX_CONFIG_BYTES) fail('CONFIG_INVALID');
      return updated;
    }
  };
}

async function checkedDirectory(directory) {
  let stat;
  for (let current = directory; ; current = path.dirname(current)) {
    const entry = await fs.lstat(current, { bigint: true });
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail('CONFLICT');
    if (!stat) stat = entry;
    if (path.dirname(current) === current) break;
  }
  const real = await fs.realpath(directory);
  const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (canonical(real) !== canonical(directory)) fail('CONFLICT');
  return stat;
}

async function fileDigest(file, maximum) {
  const directory = path.dirname(file);
  const identity = await checkedDirectory(directory);
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 1n || before.size > BigInt(maximum)) fail('CONFLICT');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (stamp(await handle.stat({ bigint: true })) !== stamp(before)) fail('CONFLICT');
    const hash = createHash('sha256');
    let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      total += chunk.length;
      if (total > Number(before.size)) fail('CONFLICT');
      hash.update(chunk);
    }
    if (total !== Number(before.size)
        || !sameFile(identity, await checkedDirectory(directory))
        || stamp(await handle.stat({ bigint: true })) !== stamp(before)
        || stamp(await fs.lstat(file, { bigint: true })) !== stamp(before)) fail('CONFLICT');
    return hash.digest('hex');
  } finally { await handle.close(); }
}

async function configStat(file) {
  let stat;
  try { stat = await fs.lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(MAX_CONFIG_BYTES)) fail('CONFIG_INVALID');
  return stat;
}

async function readConfig(file) {
  const before = await configStat(file);
  if (!before) return { before, bytes: Buffer.alloc(0) };
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (stamp(await handle.stat({ bigint: true })) !== stamp(before)) fail('CONFLICT');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== Number(before.size) || stamp(await handle.stat({ bigint: true })) !== stamp(before)
        || stamp(await configStat(file)) !== stamp(before)) fail('CONFLICT');
    return { before, bytes: buffer.subarray(0, total) };
  } finally { await handle.close(); }
}

function createMelonConsole({ processProbe = defaultProcessProbe, platform = process.platform, pins = DEFAULT_PINS } = {}) {
  const program = [
    ['Clone Hero.exe', pins.executableSha256, 128 * 1024 * 1024],
    ['GameAssembly.dll', pins.gameAssemblySha256, 512 * 1024 * 1024],
    ['Clone Hero_Data/il2cpp_data/Metadata/global-metadata.dat', pins.metadataSha256, 128 * 1024 * 1024]
  ];
  const loader = [
    ['version.dll', pins.loaderProxySha256, 32 * 1024 * 1024],
    ['MelonLoader/net6/MelonLoader.dll', pins.loaderRuntimeSha256, 32 * 1024 * 1024]
  ];
  let busy = false;

  async function verify(root, files, failure, guard) {
    for (const [relative, sha256, maximum] of files) {
      let found;
      try { found = await fileDigest(path.join(root, relative), maximum); }
      catch { fail(failure); }
      guard();
      if (found !== sha256) fail(failure);
    }
  }

  async function check(gameRoot, guard) {
    if (platform !== 'win32') fail('UNSUPPORTED_PLATFORM');
    let root;
    try { root = validateLocalQuickImportPath(gameRoot); }
    catch { fail('UNSUPPORTED_GAME'); }
    await checkedDirectory(root);
    guard();
    await verify(root, program, 'UNSUPPORTED_GAME', guard);
    await verify(root, loader, 'LOADER_UNVERIFIED', guard);
    const directory = path.join(root, 'UserData');
    const identity = await checkedDirectory(directory);
    guard();
    return { directory, identity, file: path.join(directory, 'Loader.cfg') };
  }

  async function closed(guard) {
    let running;
    try { running = await processProbe(); }
    catch { fail('PROCESS_UNKNOWN'); }
    guard();
    if (running === true) fail('GAME_RUNNING');
    if (running !== false) fail('PROCESS_UNKNOWN');
  }

  async function operation(callback) {
    try { return await callback(); }
    catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('MELON_CONSOLE_')) throw error;
      fail(error?.code === 'EEXIST' ? 'CONFLICT' : 'UNAVAILABLE');
    }
  }

  function read(gameRoot, guard = () => {}) {
    return operation(async () => {
      guard();
      const { directory, identity, file } = await check(gameRoot, guard);
      const { bytes } = await readConfig(file);
      if (!sameFile(identity, await checkedDirectory(directory))) fail('CONFLICT');
      guard();
      return { hideConsole: inspectConfig(bytes).hideConsole };
    });
  }

  function write(gameRoot, hideConsole, guard = () => {}) {
    return operation(async () => {
      if (typeof hideConsole !== 'boolean') fail('CONFIG_INVALID');
      if (busy) fail('BUSY');
      busy = true;
      try {
        guard();
        const { directory, identity, file } = await check(gameRoot, guard);
        await closed(guard);
        const { before, bytes } = await readConfig(file);
        guard();
        const next = inspectConfig(bytes).update(hideConsole);
        if (bytes.equals(next)) return { hideConsole };
        if (!sameFile(identity, await checkedDirectory(directory))) fail('CONFLICT');
        guard();
        const stage = path.join(directory, '.charts-' + randomUUID() + '.tmp');
        const handle = await fs.open(stage, 'wx', before ? Number(before.mode & 0o777n) : 0o600);
        let owned;
        try {
          try {
            owned = await handle.stat({ bigint: true });
            await handle.writeFile(next);
            await handle.sync();
          } finally { await handle.close(); }
          await closed(guard);
          if (!sameFile(identity, await checkedDirectory(directory))) fail('CONFLICT');
          const current = await readConfig(file);
          if (stamp(before) !== stamp(current.before) || !bytes.equals(current.bytes)) fail('CONFLICT');
          guard();
          if (before) await fs.rename(stage, file);
          else await fs.link(stage, file);
        } finally {
          const currentStage = await fs.lstat(stage, { bigint: true }).catch(() => null);
          if (owned && currentStage?.isFile() && sameFile(owned, currentStage)) await fs.unlink(stage);
        }
        return { hideConsole };
      } finally { busy = false; }
    });
  }

  return Object.freeze({ read, write });
}

module.exports = { createMelonConsole };
