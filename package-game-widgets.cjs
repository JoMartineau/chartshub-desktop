'use strict';
// The optional game provider is distributed separately. Inspection/copy never
// execute the provider, extract a loader, open a game or install into a profile.
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const FILES = Object.freeze([
  '.gitignore', 'README.md', 'MODULE.json', 'ChartsHub.CloneHero.Telemetry.dll',
  'Build-Module.ps1', 'Install-GameWidgets.ps1', 'Uninstall-GameWidgets.ps1',
  'Installation.Core.psm1', 'LOADER-FILES.json', 'UPSTREAM-MIT-LICENSE.txt',
  'source/ChartsHub.CloneHero.Telemetry.csproj', 'source/global.json', 'source/packages.lock.json',
  ...['Provider', 'AdapterRegistry', 'HookResolver', 'PipePublisher', 'GameplayResults', 'ResultProjection', 'SongSnapshotProjection', 'NativeSongContext', 'NativePlaybackClock', 'CalibrationResultTracker', 'NativeCalibrationSettings'].map(name => `source/${name}.cs`)
]);
const BUILD = 'CH-1.1.0.6142-win-x64-12bc21e5a88a2fc9';
const GAME_ASSEMBLY_SHA256 = '12bc21e5a88a2fc9abc259d5d67f24835145eabca6c3f863b075ba37ad75f197';
const METADATA_SHA256 = '5f14231810f2641639167eb72956e85cced2f36cb4a84682bdefb1e9da3e3d42';
const MODULE_SHA256 = '33ce0743897df7dfba88aa6642e16dd7d8509214c0e4975d9a81f590b81ab1a3';
const LOADER_MANIFEST_SHA256 = 'e7cf37f2cf7163c989c28d8f00f7fbd42ed187645a7409a1fd2a4f94431810c6';
const LOADER_ARCHIVE_SHA256 = '5b2b2f3d1cd42b59ec886c5bdc2663edae87a0097a4f4a8f58c0965a99dda416';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function regularAncestors(directory) {
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    const info = fs.lstatSync(current); if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Linked game-widget package directory refused');
    if (path.dirname(current) === current) return;
  }
}
function read(file, maximum = 1024 * 1024) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > maximum) throw Error('Invalid game-widget package file');
  return fs.readFileSync(file);
}
function inventory(directory, at = directory) {
  const names = [];
  for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
    const file = path.join(at, entry.name); if (entry.isSymbolicLink()) throw Error('Linked game-widget package member refused');
    if (entry.isDirectory()) names.push(...inventory(directory, file));
    else { const name = path.relative(directory, file).replaceAll('\\', '/'); if (!FILES.includes(name)) throw Error('Unreviewed game-widget package member: ' + name); names.push(name); }
  }
  return names.sort();
}
function managedAssembly(bytes) {
  if (bytes.length < 256 || bytes.toString('ascii', 0, 2) !== 'MZ') throw Error('Managed game-widget assembly required');
  const offset = bytes.readUInt32LE(60);
  if (offset + 24 + 208 > bytes.length || bytes.readUInt32LE(offset) !== 0x4550 || ![0x14c, 0x8664].includes(bytes.readUInt16LE(offset + 4))) throw Error('Invalid game-widget PE header');
  const optional = offset + 24, magic = bytes.readUInt16LE(optional), directories = magic === 0x10b ? optional + 96 : magic === 0x20b ? optional + 112 : -1;
  if (directories < 0 || directories + 120 > bytes.length || bytes.readUInt32LE(directories + 112) === 0 || bytes.readUInt32LE(directories + 116) < 72) throw Error('Game-widget CLR metadata directory required');
}
function inspectGameWidgets(sourceRoot) {
  const directory = path.join(sourceRoot, 'game-widgets-mod'); regularAncestors(directory);
  const names = inventory(directory); if (JSON.stringify(names) !== JSON.stringify([...FILES].sort())) throw Error('Game-widget package membership differs');
  let total = 0; const files = FILES.map(name => { const bytes = read(path.join(directory, name)); total += bytes.length; return { name, bytes: bytes.length, sha256: hash(bytes) }; });
  if (total > 8 * 1024 * 1024) throw Error('Game-widget package exceeds byte limit');
  const module = JSON.parse(read(path.join(directory, 'MODULE.json'), 16384).toString('utf8').replace(/^\uFEFF/, ''));
  const metadataKeys = ['schema', 'kind', 'build', 'moduleSha256', 'version', 'moduleFile', 'defaultEnabled', 'features', 'gameBinaryIncluded', 'loaderArchiveIncluded', 'loaderVersion', 'gameAssemblySha256', 'metadataSha256'];
  if (!module || typeof module !== 'object' || JSON.stringify(Object.keys(module).sort()) !== JSON.stringify(metadataKeys.sort())) throw Error('Game-widget provenance fields differ');
  if (module.schema !== 1 || module.kind !== 'optional-game-widgets' || module.build !== BUILD || module.version !== '0.2.2' || module.moduleFile !== 'ChartsHub.CloneHero.Telemetry.dll' || module.moduleSha256 !== MODULE_SHA256 || module.gameAssemblySha256 !== GAME_ASSEMBLY_SHA256 || module.metadataSha256 !== METADATA_SHA256 || module.loaderVersion !== '0.7.3' || JSON.stringify(module.features) !== JSON.stringify(['accuracy', 'song-clock-for-lyrics']) || ['defaultEnabled', 'gameBinaryIncluded', 'loaderArchiveIncluded'].some(key => module[key] !== false)) throw Error('Game-widget provenance is not reviewed');
  const dll = files.find(file => file.name === module.moduleFile); if (dll.sha256 !== MODULE_SHA256) throw Error('Game-widget module SHA-256 differs from its reviewed manifest'); managedAssembly(read(path.join(directory, dll.name)));
  const loaderBytes = read(path.join(directory, 'LOADER-FILES.json'), 131072); if (hash(loaderBytes) !== LOADER_MANIFEST_SHA256) throw Error('Reviewed loader manifest SHA-256 differs');
  const loader = JSON.parse(loaderBytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (loader.schema !== 1 || loader.loader !== 'MelonLoader' || loader.version !== '0.7.3' || loader.archiveSha256 !== LOADER_ARCHIVE_SHA256 || !Array.isArray(loader.files) || loader.files.length !== 164 || new Set(loader.files.map(file => file.relative.toLowerCase())).size !== 164) throw Error('Reviewed loader membership differs');
  for (const file of loader.files) if (typeof file.relative !== 'string' || !/^(?:version\.dll|MelonLoader\/[A-Za-z0-9._/-]+)$/.test(file.relative) || file.relative.split('/').some(piece => !piece || piece === '.' || piece === '..') || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error('Invalid reviewed loader member');
  return { schema: 1, platform: 'win32', arch: 'x64', build: module.build, version: module.version, moduleSha256: dll.sha256, gameAssemblySha256: GAME_ASSEMBLY_SHA256, metadataSha256: METADATA_SHA256, loaderVersion: '0.7.3', loaderArchiveSha256: LOADER_ARCHIVE_SHA256, loaderManifestSha256: LOADER_MANIFEST_SHA256, loaderFileCount: 164, features: [...module.features], defaultEnabled: false, gameBinaryIncluded: false, loaderArchiveIncluded: false, installed: false, files };
}
function copyGameWidgets(sourceRoot, applicationOutput) {
  const before = inspectGameWidgets(sourceRoot), parent = path.join(applicationOutput, 'Clone Hero Integrations'); regularAncestors(applicationOutput);
  if (fs.existsSync(parent)) regularAncestors(parent); else fs.mkdirSync(parent);
  const directory = path.join(parent, 'game-widgets-mod'); fs.mkdirSync(directory);
  for (const file of before.files) {
    const target = path.join(directory, file.name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, read(path.join(sourceRoot, 'game-widgets-mod', file.name)), { flag: 'wx' });
    if (hash(read(target)) !== file.sha256) throw Error('Game-widget package changed during copying');
  }
  if (JSON.stringify(inspectGameWidgets(sourceRoot)) !== JSON.stringify(before)) throw Error('Game-widget source changed during packaging');
  fs.writeFileSync(path.join(directory, 'PACKAGE-MANIFEST.json'), JSON.stringify(before, null, 2) + '\n', { flag: 'wx' }); return before;
}
module.exports = { FILES, BUILD, GAME_ASSEMBLY_SHA256, METADATA_SHA256, MODULE_SHA256, LOADER_MANIFEST_SHA256, LOADER_ARCHIVE_SHA256, inspectGameWidgets, copyGameWidgets };
