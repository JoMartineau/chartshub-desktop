'use strict';
// Explicit, read-only diagnostics. This module never starts the game, imports a
// DLL, downloads a runtime, reads game logs or attempts an installation/repair.
const nativeFs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const REVIEWED_PINS = Object.freeze({
  loaderManifestSha256: 'e7cf37f2cf7163c989c28d8f00f7fbd42ed187645a7409a1fd2a4f94431810c6',
  moduleSha256: '33ce0743897df7dfba88aa6642e16dd7d8509214c0e4975d9a81f590b81ab1a3',
  executableSha256: '3ff57876872fdeac94cf88052a69b19e70c7fc58a70919353c9bfcf64dfd2c87',
  gameAssemblySha256: '12bc21e5a88a2fc9abc259d5d67f24835145eabca6c3f863b075ba37ad75f197',
  metadataSha256: '5f14231810f2641639167eb72956e85cced2f36cb4a84682bdefb1e9da3e3d42'
});
const SHA = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw Object.assign(Error(code), { code }); };
const clone = value => structuredClone(value);
const processScript = "$ErrorActionPreference='Stop';try{$e=@();$p=@(Get-Process -Name 'Clone Hero','CloneHero','Clone Hero Launcher','CloneHeroLauncher' -ErrorAction SilentlyContinue -ErrorVariable e);if(@($e|Where-Object{$_.CategoryInfo.Category-ne'ObjectNotFound'}).Count){throw 'Unavailable'};if($p.Count){'true'}else{'false'}}catch{'unknown'}";
function defaultProcessProbe() {
  // Fixed Windows executable and fixed names; never search PATH or interpolate
  // a selected directory, process name or command supplied by a renderer.
  const windows = /^[a-z]:[\\/][^\x00-\x1f]*$/i.test(process.env.SystemRoot || '') ? process.env.SystemRoot : 'C:\\Windows';
  const executable = path.win32.join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return new Promise(resolve => {
    try {
      execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', processScript],
        { windowsHide: true, shell: false, timeout: 3000, maxBuffer: 1024, encoding: 'utf8' },
        (error, stdout) => resolve(error ? null : String(stdout).trim() === 'false' ? false : String(stdout).trim() === 'true' ? true : null));
    } catch { resolve(null); }
  });
}

function createGameModPreflight({ getGameRoot, getContext, moduleDirectory = path.join(__dirname, '..', 'game-widgets-mod'),
  onChange = () => {}, platform = process.platform, processProbe = defaultProcessProbe,
  runtimeDirectory = path.win32.join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', 'dotnet/shared/Microsoft.WindowsDesktop.App'),
  fileSystem = nativeFs, pins = REVIEWED_PINS, now = Date.now, timeoutMs = 30000 } = {}) {
  if (typeof getGameRoot !== 'function' || typeof getContext !== 'function' || typeof onChange !== 'function'
      || typeof processProbe !== 'function' || typeof now !== 'function' || !object(pins)
      || Object.keys(REVIEWED_PINS).some(key => !SHA.test(pins[key]))
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 60000) fail('GAME_MOD_CHECK_INVALID');
  // The injectable paths/filesystem/pins are main-process test seams, never IPC
  // parameters. Creating/statusing this service performs no filesystem probe.
  const fs = fileSystem, expectedPins = { ...pins };
  const same = (a, b) => platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  let revision = 0, disposed = false, scope, selectedRoot = null, owner = null, notifying = false;
  const blank = () => ({ busy: false, supported: platform === 'win32', selected: selectedRoot !== null,
    checked: false, state: platform === 'win32' ? 'idle' : 'unsupported', compatible: false, canInstall: false,
    process: 'unknown', loader: { state: 'unknown', version: '0.7.3', expected: 164, checked: 0, missing: 0, different: 0 },
    module: { state: 'unknown' }, checks: [], checkedAt: null, error: null });
  let report = blank();
  const snapshot = () => ({ revision, ...clone(report) });
  function notify() { if (disposed || notifying) return; notifying = true; try { onChange(snapshot()); } catch {} finally { notifying = false; } }
  function context() {
    try {
      const value = getContext(), lifecycle = value?.lifecycle;
      if (!object(value) || value.active !== true || !(Number.isSafeInteger(lifecycle) && lifecycle >= 0
          || typeof lifecycle === 'string' && lifecycle.length > 0 && lifecycle.length <= 128 && !/[\x00-\x1f\x7f]/.test(lifecycle))) return null;
      return lifecycle;
    } catch { return null; }
  }
  function selected() { try { const value = getGameRoot(); return typeof value === 'string' ? value : null; } catch { return null; } }
  function sync() {
    if (disposed) return;
    const nextScope = context(), nextRoot = selected();
    const changed = scope !== undefined && (nextScope !== scope || nextRoot !== selectedRoot);
    scope = nextScope; selectedRoot = nextRoot; report.selected = nextRoot !== null;
    if (changed) { owner = null; revision++; report = blank(); notify(); }
  }
  function status() { sync(); return snapshot(); }
  function guard(run) { sync(); if (disposed || owner !== run || scope === null) fail('GAME_MOD_CHECK_CANCELLED'); }
  function absolute(value) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 240 || !path.isAbsolute(value)
        || /[\x00-\x1f\x7f]/.test(value) || value.startsWith('\\\\') || value.startsWith('//')) fail('GAME_FOLDER_INVALID');
    const resolved = path.resolve(value);
    if (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(resolved)) fail('GAME_FOLDER_INVALID');
    const pieces = resolved.slice(path.parse(resolved).root.length).split(path.sep).filter(Boolean);
    if (pieces.some(piece => /[. ]$/.test(piece) || /[:<>"|?*]/.test(piece) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(piece))) fail('GAME_FOLDER_INVALID');
    return resolved;
  }
  function child(root, relative) {
    if (typeof relative !== 'string' || relative.length > 180 || relative.includes('\\') || relative.split('/').some(s => !s || s === '.' || s === '..' || /[:<>"|?*\x00-\x1f]/.test(s) || /[. ]$/.test(s))) fail('PACKAGE_INVALID');
    const value = path.resolve(root, ...relative.split('/'));
    if (!value.startsWith(root + path.sep) || value.length > 260) fail('PATH_TOO_LONG');
    return value;
  }
  async function ordinary(file, type, run, missing = false) {
    guard(run); let at = path.parse(file).root;
    const pieces = file.slice(at.length).split(path.sep).filter(Boolean);
    let result;
    for (let index = 0; index < pieces.length; index++) {
      at = path.join(at, pieces[index]);
      try { result = await fs.lstat(at); } catch (error) { guard(run); if (error.code === 'ENOENT' && missing) return null; throw error; }
      guard(run);
      const final = index === pieces.length - 1;
      if (result.isSymbolicLink()) fail('LINKED_PATH');
      if (!final && !result.isDirectory() || final && (type === 'directory' ? !result.isDirectory() : !result.isFile())) fail('GAME_FOLDER_INVALID');
      if (final && type === 'file' && result.nlink !== 1) fail('HARDLINK_FILE');
    }
    const real = await fs.realpath(file); guard(run);
    if (!same(path.resolve(real), path.resolve(file))) fail('LINKED_PATH');
    return result;
  }
  const stable = (a, b) => a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && b.nlink === 1;
  async function read(file, max, run, { hash = false, header = false } = {}) {
    const before = await ordinary(file, 'file', run);
    if (!Number.isSafeInteger(before.size) || before.size < 1 || before.size > max) fail('FILE_SIZE_INVALID');
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      guard(run); if (!stable(before, await handle.stat())) fail('FILE_CHANGED'); guard(run);
      if (header) {
        const dos = Buffer.alloc(64), n = await handle.read(dos, 0, dos.length, 0); guard(run);
        if (n.bytesRead !== 64 || dos.readUInt16LE(0) !== 0x5a4d) fail('GAME_NOT_X64');
        const offset = dos.readUInt32LE(60), pe = Buffer.alloc(26);
        if (offset < 64 || offset > 1024 * 1024 || offset + pe.length > before.size) fail('GAME_NOT_X64');
        const p = await handle.read(pe, 0, pe.length, offset); guard(run);
        if (p.bytesRead !== pe.length || pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== 0x8664 || pe.readUInt16LE(24) !== 0x20b) fail('GAME_NOT_X64');
      }
      const digest = hash ? crypto.createHash('sha256') : null, chunks = [], buffer = Buffer.alloc(Math.min(1024 * 1024, before.size + 1));
      let total = 0;
      for (;;) {
        const result = await handle.read(buffer, 0, Math.min(buffer.length, before.size + 1 - total), total); guard(run);
        if (!result.bytesRead) break;
        total += result.bytesRead; if (total > before.size) fail('FILE_CHANGED');
        if (hash) digest.update(buffer.subarray(0, result.bytesRead)); else chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
      }
      const end = await handle.stat(), current = await ordinary(file, 'file', run); guard(run);
      if (total !== before.size || !stable(before, end) || !stable(before, current)) fail('FILE_CHANGED');
      return hash ? { bytes: total, sha256: digest.digest('hex') } : Buffer.concat(chunks, total);
    } finally { await handle.close(); }
  }
  function parse(bytes) { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('PACKAGE_INVALID'); } }
  async function manifests(run) {
    const root = absolute(moduleDirectory);
    const bytes = await read(child(root, 'LOADER-FILES.json'), 65536, run);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== expectedPins.loaderManifestSha256) fail('PACKAGE_INVALID');
    const manifest = parse(bytes);
    if (!object(manifest) || manifest.schema !== 1 || manifest.loader !== 'MelonLoader' || manifest.version !== '0.7.3'
        || manifest.archiveSha256 !== '5b2b2f3d1cd42b59ec886c5bdc2663edae87a0097a4f4a8f58c0965a99dda416'
        || !Array.isArray(manifest.files) || manifest.files.length !== 164) fail('PACKAGE_INVALID');
    const seen = new Set(); let sum = 0;
    for (const item of manifest.files) {
      if (!object(item) || Object.keys(item).sort().join(',') !== 'bytes,relative,sha256' || !SHA.test(item.sha256)
          || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > 32 * 1024 * 1024
          || !(item.relative === 'version.dll' || item.relative.startsWith('MelonLoader/'))) fail('PACKAGE_INVALID');
      child(root, item.relative); const key = item.relative.toLowerCase(); if (seen.has(key)) fail('PACKAGE_INVALID'); seen.add(key); sum += item.bytes;
    }
    if (sum > 128 * 1024 * 1024 || !seen.has('version.dll')) fail('PACKAGE_INVALID');
    const module = parse(await read(child(root, 'MODULE.json'), 8192, run));
    if (!object(module) || module.schema !== 1 || module.kind !== 'optional-game-widgets' || module.build !== 'CH-1.1.0.6142-win-x64-12bc21e5a88a2fc9'
        || module.version !== '0.2.2' || module.moduleFile !== 'ChartsHub.CloneHero.Telemetry.dll' || module.moduleSha256 !== expectedPins.moduleSha256
        || module.gameAssemblySha256 !== expectedPins.gameAssemblySha256 || module.metadataSha256 !== expectedPins.metadataSha256
        || module.defaultEnabled !== false || module.gameBinaryIncluded !== false || module.loaderArchiveIncluded !== false || module.loaderVersion !== '0.7.3'
        || JSON.stringify(module.features) !== '["accuracy","song-clock-for-lyrics"]') fail('PACKAGE_INVALID');
    return manifest;
  }
  const codes = new Set(['GAME_FOLDER_INVALID','PATH_TOO_LONG','LINKED_PATH','HARDLINK_FILE','FILE_SIZE_INVALID','FILE_CHANGED','GAME_NOT_X64','PACKAGE_INVALID']);
  function publicCode(error) { return codes.has(error?.code) ? error.code : ['EACCES','EPERM'].includes(error?.code) ? 'READ_PERMISSION_DENIED' : error?.code === 'ENOENT' ? 'GAME_FOLDER_MISSING' : 'CHECK_UNAVAILABLE'; }
  async function check(run) {
    const result = blank(), add = (id, level, code) => result.checks.push({ id, level, code }); result.checked = true;
    const root = absolute(run.root); await ordinary(root, 'directory', run);
    const files = [['Clone Hero.exe', expectedPins.executableSha256, 128 * 1024 * 1024], ['GameAssembly.dll', expectedPins.gameAssemblySha256, 512 * 1024 * 1024], ['Clone Hero_Data/il2cpp_data/Metadata/global-metadata.dat', expectedPins.metadataSha256, 128 * 1024 * 1024]];
    for (const [relative, expected, maximum] of files) {
      const found = await read(child(root, relative), maximum, run, { hash: true, header: relative === 'Clone Hero.exe' });
      if (found.sha256 !== expected) { add('game', 'error', 'UNSUPPORTED_GAME_BUILD'); result.state = 'blocked'; return result; }
    }
    result.compatible = true; add('game', 'ok', 'REVIEWED_GAME_X64');
    let running = null; try { running = await processProbe(); } catch {} guard(run);
    result.process = running === false ? 'closed' : running === true ? 'running' : 'unknown';
    add('process', running === false ? 'ok' : 'error', running === false ? 'GAME_AND_LAUNCHER_CLOSED' : running === true ? 'GAME_RUNNING' : 'PROCESS_CHECK_FAILED');
    const manifest = await manifests(run);
    for (const item of manifest.files) {
      const target = child(root, item.relative), stat = await ordinary(target, 'file', run, true);
      if (!stat) { result.loader.missing++; continue; }
      const found = await read(target, 32 * 1024 * 1024, run, { hash: true }); result.loader.checked++;
      if (found.bytes !== item.bytes || found.sha256 !== item.sha256) result.loader.different++;
    }
    result.loader.state = result.loader.different ? 'different' : result.loader.missing === 164 ? 'missing' : result.loader.missing ? 'partial' : 'matching';
    add('loader', result.loader.state === 'matching' ? 'ok' : 'error', result.loader.different ? 'SHARED_LOADER_DIFFERENT' : result.loader.missing ? 'SHARED_LOADER_MISSING' : 'SHARED_LOADER_VERIFIED');
    const modulePath = child(root, 'Mods/ChartsHub.CloneHero.Telemetry.dll'), moduleStat = await ordinary(modulePath, 'file', run, true);
    if (!moduleStat) result.module.state = 'missing';
    else result.module.state = (await read(modulePath, 8 * 1024 * 1024, run, { hash: true })).sha256 === expectedPins.moduleSha256 ? 'matching' : 'different';
    add('module', result.module.state === 'different' ? 'error' : 'ok', result.module.state === 'different' ? 'MODULE_ALREADY_EXISTS' : result.module.state === 'missing' ? 'MODULE_NOT_INSTALLED' : 'MODULE_VERIFIED');
    // Only existence is inspected. A receipt can contain private paths and is
    // not needed to diagnose an old/partial install or prove create-only safety.
    const receipt = await ordinary(child(root, 'UserData/ChartsHubGameWidgets/install-receipt.json'), 'file', run, true);
    if (receipt) add('receipt', result.module.state === 'matching' ? 'warning' : 'error', 'RECEIPT_ALREADY_EXISTS');
    else if (result.module.state === 'matching') add('receipt', 'warning', 'INSTALLATION_RECEIPT_MISSING');
    // A fixed Microsoft runtime directory is a presence hint, not evidence that
    // the loader will initialize. No dotnet executable or registry script runs.
    let runtime = 'unknown';
    try {
      const runtimeRoot = absolute(runtimeDirectory), stat = await ordinary(runtimeRoot, 'directory', run, true);
      if (!stat) runtime = 'missing';
      else {
        const versions = await fs.readdir(runtimeRoot, { withFileTypes: true }); guard(run);
        if (versions.length > 256) fail('CHECK_UNAVAILABLE');
        runtime = versions.some(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^6\.\d+\.\d+$/.test(entry.name)) ? 'present' : 'missing';
      }
    } catch (error) { guard(run); runtime = 'unknown'; }
    add('runtime', runtime === 'present' ? 'ok' : 'warning', runtime === 'present' ? 'DOTNET6_DESKTOP_PRESENT' : runtime === 'missing' ? 'DOTNET6_DESKTOP_NOT_FOUND' : 'DOTNET6_DESKTOP_UNKNOWN');
    // access(W_OK) is a read-only permission hint. Even success cannot prove a
    // future installer write, ACL grant, antivirus decision or available lock.
    let permissionCode = 'WRITE_ACCESS_NOT_PROVEN';
    try { await fs.access(root, constants.W_OK); } catch (error) { if (['EACCES','EPERM','EROFS'].includes(error.code)) permissionCode = 'WRITE_PERMISSION_MAY_BE_DENIED'; } guard(run);
    add('permissions', 'warning', permissionCode);
    let diskCode = 'DISK_SPACE_UNKNOWN';
    try { const disk = await fs.statfs(root, { bigint: true }); guard(run); if (typeof disk.bavail === 'bigint' && typeof disk.bsize === 'bigint' && disk.bavail >= 0n && disk.bsize > 0n) diskCode = disk.bavail * disk.bsize < 64n * 1024n * 1024n ? 'LOW_DISK_SPACE' : 'DISK_SPACE_AVAILABLE'; } catch { guard(run); }
    add('disk', diskCode === 'DISK_SPACE_AVAILABLE' ? 'ok' : 'warning', diskCode);
    result.canInstall = !result.checks.some(item => item.level === 'error') && result.module.state === 'missing';
    result.state = result.checks.some(item => item.level === 'error') ? 'blocked' : result.checks.some(item => item.level === 'warning') ? 'warning' : 'ready';
    return result;
  }
  async function refresh(value) {
    if (!object(value) || Object.keys(value).join(',') !== 'revision' || !Number.isSafeInteger(value.revision) || value.revision < 0) fail('GAME_MOD_CHECK_INVALID');
    sync(); if (disposed) fail('GAME_MOD_CHECK_CANCELLED'); if (value.revision !== revision) fail('GAME_MOD_CHECK_STALE');
    if (scope === null) fail('GAME_MOD_CHECK_INACTIVE'); if (platform !== 'win32') fail('GAME_MOD_CHECK_UNAVAILABLE');
    if (owner) fail('GAME_MOD_CHECK_BUSY');
    if (!selectedRoot) fail('GAME_MOD_CHECK_GAME_REQUIRED');
    const run = { root: selectedRoot }; owner = run; report = { ...blank(), busy: true, state: 'checking' }; revision++; notify();
    let timer;
    try {
      guard(run);
      const result = await Promise.race([check(run), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error('CHECK_TIMED_OUT'), { code: 'CHECK_TIMED_OUT' })), timeoutMs); })]);
      guard(run); report = { ...result, busy: false, checkedAt: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(now()))) };
    } catch (error) {
      if (owner !== run || disposed || scope === null) fail('GAME_MOD_CHECK_CANCELLED');
      const code = error?.code === 'CHECK_TIMED_OUT' ? 'CHECK_TIMED_OUT' : publicCode(error);
      report = { ...blank(), checked: true, state: 'blocked', error: code, checks: [{ id: 'check', level: 'error', code }], checkedAt: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(now()))) };
    } finally { clearTimeout(timer); if (owner === run) { owner = null; report.busy = false; revision++; notify(); } }
    return snapshot();
  }
  function stop() { if (disposed) return; owner = null; revision++; report = blank(); notify(); }
  function dispose() { if (disposed) return; stop(); disposed = true; }
  return Object.freeze({ status, refresh, stop, dispose });
}
module.exports = { createGameModPreflight, REVIEWED_GAME_MOD_PINS: REVIEWED_PINS };
