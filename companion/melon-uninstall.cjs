'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// Bootstraps and IL2CPP cores from the official MelonLoader v0.7.3 x64 release ZIPs.
// https://github.com/LavaGang/MelonLoader/releases/tag/v0.7.3
const OFFICIAL = Object.freeze({
  wine: Object.freeze({
    bootstrap: 'version.dll',
    bootstrapHash: '0ce7a4e530c7f83f172a2c44aed45eedb3bdcf06b83760f143a0fba6885fa929',
    coreHash: 'bdd43dc0f3893c208c95389b863ab61c967ae14204da0dd8051647e754c8709b'
  }),
  linux: Object.freeze({
    bootstrap: 'MelonLoader.Bootstrap.so',
    bootstrapHash: 'b6419b27aab6d9c71a8bfb29bfd059ac91c0567f867b254d2a43c9494695fdca',
    coreHash: '9ef910c90b8a58671fb8c23376b2ba32194121af6fa5ef3310432f1d4a559895'
  }),
  macos: Object.freeze({
    bootstrap: 'MelonLoader.Bootstrap.dylib',
    bootstrapHash: '03b6000071fcc1720a57dc8c5e6ddea742c5413b00bb320871fd51ee8f0d7437',
    coreHash: '42e8c8c296e04a22cb3021ffb00bcf37ac1c57732355e44c00df2b18b95988f2'
  })
});
const BOOTSTRAPS = Object.values(OFFICIAL).map(item => item.bootstrap);
const WINDOWS_PROXIES = ['winhttp.dll', 'winmm.dll', 'dinput.dll', 'dinput8.dll', 'dsound.dll',
  'd3d8.dll', 'd3d9.dll', 'd3d10.dll', 'd3d11.dll', 'd3d12.dll', 'ddraw.dll', 'msacm32.dll'];
const GAME_NAME = /^clone[ _-]?hero$/i;
const MAX_FILES = 20000;
const digest = data => createHash('sha256').update(data).digest('hex');
const identity = info => [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = reason => { const error = new Error(reason); error.reason = reason; throw error; };

async function infoOf(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function ordinary(file, directory) {
  const info = await infoOf(file);
  if (!info || info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) fail('unsafe_path');
  return info;
}

async function ancestors(directory) {
  const all = [];
  for (let at = directory; ; at = path.dirname(at)) {
    const info = await ordinary(at, true);
    all.push([at, info.dev, info.ino]);
    if (at === path.dirname(at)) return all;
  }
}

async function readOrdinary(file, limit, prefix = false) {
  const before = await ordinary(file, false);
  if (before.size < 1 || (!prefix && before.size > limit)) fail('unsafe_path');
  const handle = await fs.open(file, 'r');
  try {
    if (!same(identity(await handle.stat()), identity(before))) fail('changed');
    const data = Buffer.alloc(Math.min(limit, before.size));
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead !== data.length || !same(identity(await handle.stat()), identity(before)) ||
        !same(identity(await ordinary(file, false)), identity(before))) fail('changed');
    return data;
  } finally { await handle.close(); }
}

async function gameSelection(selection, platform) {
  if (!['linux', 'darwin'].includes(platform)) fail('unsupported_platform');
  if (typeof selection !== 'string' || !path.isAbsolute(selection) || /[\0\r\n]/.test(selection)) fail('invalid_game');
  let executable = path.resolve(selection);
  if (platform === 'darwin' && /\.app$/i.test(executable)) {
    if (!GAME_NAME.test(path.basename(executable, path.extname(executable)))) fail('invalid_game');
    const bin = path.join(executable, 'Contents', 'MacOS');
    await ancestors(bin);
    const entries = (await fs.readdir(bin)).filter(name => GAME_NAME.test(name));
    if (entries.length !== 1) fail('invalid_game');
    executable = path.join(bin, entries[0]);
  }
  const filename = path.basename(executable);
  const wine = /\.exe$/i.test(filename);
  if (!GAME_NAME.test(filename.replace(/\.(?:exe|x86_64)$/i, ''))) fail('invalid_game');
  const executableDir = path.dirname(executable);
  const layout = wine ? 'wine' : platform === 'linux' ? 'linux' : 'macos';
  let root = executableDir;
  if (layout === 'macos') {
    const contents = path.dirname(executableDir);
    const bundle = path.dirname(contents);
    if (path.basename(executableDir) !== 'MacOS' || path.basename(contents) !== 'Contents' ||
        !/\.app$/i.test(bundle) || !GAME_NAME.test(path.basename(bundle, path.extname(bundle)))) fail('invalid_game');
    root = path.dirname(bundle);
  }
  const ancestorIds = await ancestors(executableDir);
  if (root === path.parse(root).root) fail('invalid_game');
  const header = await readOrdinary(executable, 4096, true);
  const elf = header.length > 20 && header.subarray(0, 6).equals(Buffer.from([0x7f, 69, 76, 70, 2, 1])) && header.readUInt16LE(18) === 0x3e;
  const peOffset = header.length >= 64 ? header.readUInt32LE(60) : header.length;
  const pe = header.length >= 64 && header.toString('ascii', 0, 2) === 'MZ' && peOffset <= header.length - 6 &&
    header.readUInt32LE(peOffset) === 0x4550 && header.readUInt16LE(peOffset + 4) === 0x8664;
  const mach = header.length >= 8 && (
    (header.readUInt32LE(0) === 0xfeedfacf && header.readUInt32LE(4) === 0x01000007) ||
    ([0xcafebabe, 0xcafebabf].includes(header.readUInt32BE(0)) && header.readUInt32BE(4) > 0 && header.readUInt32BE(4) <= 32 &&
      Array.from({ length: header.readUInt32BE(4) }, (_, index) => 8 + index * (header.readUInt32BE(0) === 0xcafebabe ? 20 : 32))
        .some(offset => offset <= header.length - 4 && header.readUInt32BE(offset) === 0x01000007))
  );
  if (!(layout === 'wine' ? pe : layout === 'linux' ? elf : mach)) fail('unsupported_game_binary');
  if (layout !== 'macos') {
    await ordinary(path.join(root, filename.replace(/\.(?:exe|x86_64)$/i, '') + '_Data'), true);
  } else {
    await ordinary(path.join(path.dirname(executableDir), 'Info.plist'), false);
    await ancestors(path.join(path.dirname(executableDir), 'Resources', 'Data'));
  }
  return { executable, root, layout, ancestorIds, executableIdentity: identity(await ordinary(executable, false)) };
}

async function loaderInventory(root) {
  const tree = [];
  const device = (await ordinary(root, true)).dev;
  async function walk(relative, depth) {
    if (tree.length >= MAX_FILES || depth > 24) fail('unsafe_path');
    const file = path.join(root, relative);
    const info = await infoOf(file);
    if (!info || info.isSymbolicLink() || info.dev !== device) fail('unsafe_path');
    if (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)) fail('unsafe_path');
    tree.push([relative, ...identity(info)]);
    if (info.isDirectory()) {
      const children = await fs.readdir(file);
      if (children.length + tree.length > MAX_FILES) fail('unsafe_path');
      for (const name of children.sort()) await walk(path.join(relative, name), depth + 1);
    }
  }
  await walk('MelonLoader', 0);
  return tree;
}

async function defaultProcessProbe() {
  try {
    const { stdout } = await promisify(execFile)('/bin/ps', ['-axww', '-o', 'pid=', '-o', 'command='], {
      timeout: 2500, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C' }
    });
    const rows = stdout.trim().split('\n').map(line => line.trim().match(/^(\d+)\s+(.+)$/));
    if (rows.some(row => !row) || !rows.some(row => Number(row[1]) === process.pid)) return 'unknown';
    for (const row of rows) {
      if (Number(row[1]) === process.pid) continue;
      if (/(?:^|[\s"'\\/])clone[ _-]?hero(?=$|[\s."'\\/_-])/i.test(row[2])) return 'running';
    }
    return 'closed';
  } catch { return 'unknown'; }
}

function createMelonUninstaller({ platform = process.platform, processProbe = defaultProcessProbe, signatures = OFFICIAL } = {}) {
  let busy = false;

  async function scan(selection) {
    const game = await gameSelection(selection, platform);
    const layout = signatures[game.layout];
    const marker = await infoOf(path.join(game.root, 'MelonLoader'));
    const existingBootstraps = [];
    for (const name of BOOTSTRAPS) if (await infoOf(path.join(game.root, name))) existingBootstraps.push(name);
    if (!marker && !existingBootstraps.length) return { ...game, status: 'absent' };
    if (!marker || !same(existingBootstraps, [layout.bootstrap])) fail('unrecognized_loader');
    if (game.layout === 'wine') {
      for (const name of WINDOWS_PROXIES) if (await infoOf(path.join(game.root, name))) fail('additional_proxy');
    }
    const paths = [layout.bootstrap, 'MelonLoader'];
    const bootstrap = path.join(game.root, layout.bootstrap);
    const bootstrapIdentity = identity(await ordinary(bootstrap, false));
    await ordinary(path.join(game.root, 'MelonLoader'), true);
    await ordinary(path.join(game.root, 'MelonLoader', 'net6'), true);
    if (digest(await readOrdinary(bootstrap, 32 * 1024 * 1024)) !== layout.bootstrapHash ||
        digest(await readOrdinary(path.join(game.root, 'MelonLoader', 'net6', 'MelonLoader.dll'), 32 * 1024 * 1024)) !== layout.coreHash) fail('unrecognized_loader');
    const inventory = await loaderInventory(game.root);
    const planId = digest(JSON.stringify([game, paths, bootstrapIdentity, inventory]));
    return { ...game, status: 'ready', paths, planId, bootstrapIdentity, inventory };
  }

  function publicPlan(plan) {
    return { status: plan.status, layout: plan.layout, paths: plan.paths ?? [], planId: plan.planId ?? null };
  }

  async function inspect(selection) {
    try { return publicPlan(await scan(selection)); }
    catch (error) { return { status: 'blocked', reason: error.reason ?? 'read_failed', paths: [], planId: null }; }
  }

  async function quarantine(selection, planId, { assertCurrent = () => {} } = {}) {
    if (busy) return { status: 'blocked', reason: 'busy' };
    busy = true;
    let backup, backupIdentity, plan;
    const moved = [];
    try {
      if (typeof planId !== 'string' || !/^[a-f0-9]{64}$/.test(planId)) fail('confirmation_required');
      plan = await scan(selection);
      if (plan.status !== 'ready' || plan.planId !== planId) fail('changed');
      const guard = async () => {
        await assertCurrent();
        const processState = await processProbe({ executable: plan.executable, root: plan.root, layout: plan.layout });
        if (processState !== 'closed') fail(processState === 'running' ? 'game_running' : 'process_unknown');
        if (!same(await ancestors(path.dirname(plan.executable)), plan.ancestorIds) ||
            !same(identity(await ordinary(plan.executable, false)), plan.executableIdentity)) fail('changed');
        await assertCurrent();
      };
      await guard();
      backup = await fs.mkdtemp(path.join(plan.root, '.chartshub-melonloader-backup-'));
      const info = await ordinary(backup, true);
      backupIdentity = [info.dev, info.ino];
      for (const name of plan.paths) {
        await guard();
        const destination = path.join(backup, name);
        const backupInfo = await ordinary(backup, true);
        if (!same([backupInfo.dev, backupInfo.ino], backupIdentity) || await infoOf(destination)) fail('changed');
        const source = path.join(plan.root, name);
        const current = name === 'MelonLoader' ? await loaderInventory(plan.root) : identity(await ordinary(source, false));
        if (!same(current, name === 'MelonLoader' ? plan.inventory : plan.bootstrapIdentity)) fail('changed');
        // A large inventory can take longer than the process check. Recheck
        // immediately before detaching the loader directory.
        if (name === 'MelonLoader') await guard();
        await assertCurrent();
        await fs.rename(source, destination);
        moved.push(name);
      }
      return { status: 'quarantined', layout: plan.layout, paths: plan.paths, backupName: path.basename(backup) };
    } catch (error) {
      if (backup) {
        try {
          if (!same(await ancestors(path.dirname(plan.executable)), plan.ancestorIds)) fail('changed');
          const info = await ordinary(backup, true);
          if (!same([info.dev, info.ino], backupIdentity)) fail('changed');
          for (const name of moved.reverse()) {
            const destination = path.join(plan.root, name);
            if (await infoOf(destination)) fail('changed');
            const source = path.join(backup, name);
            const movedInfo = await ordinary(source, name === 'MelonLoader');
            const expected = name === 'MelonLoader' ? plan.inventory[0].slice(1, 3) : plan.bootstrapIdentity.slice(0, 2);
            if (!same([movedInfo.dev, movedInfo.ino], expected)) fail('changed');
            await fs.rename(source, destination);
          }
          await fs.rmdir(backup);
        } catch {
          return { status: 'blocked', reason: 'rollback_failed', backupName: path.basename(backup) };
        }
      }
      return { status: 'blocked', reason: error.reason ?? 'quarantine_failed' };
    } finally { busy = false; }
  }
  return { inspect, quarantine };
}

module.exports = { createMelonUninstaller };
