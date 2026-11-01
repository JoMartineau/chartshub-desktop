'use strict';
// Package only the reviewed optional ChartsHub module, sources and guides.
// This module never opens a game, extracts a loader, or installs anything.
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const FILES = Object.freeze([
  'README.md', 'MODULE.json', 'ChartsHub.QuickImport.dll', 'Build-Module.ps1',
  'Install-QuickImport.ps1', 'Uninstall-QuickImport.ps1', 'Installation.Core.psm1', 'Loader.defaults.cfg',
  'source/ChartsHub.QuickImport.csproj', 'source/global.json',
  ...['AtomicCacheUpdate', 'ChartValidator', 'ImportQueue', 'IncrementalFolderIndex', 'LocalPipeHost', 'LocalProtocol', 'NativeCacheFormat'].map(name => `source/Core/${name}.cs`),
  ...['HookResolver', 'NativeImportExperiment', 'ProductionProvider', 'ValidatedCopyAdapter'].map(name => `source/Mod/${name}.cs`)
]);
const BUILD = 'CH-1.1.0.6142-win-x64-12bc21e5a88a2fc9';
const GAME_ASSEMBLY_SHA256 = '12bc21e5a88a2fc9abc259d5d67f24835145eabca6c3f863b075ba37ad75f197';
const MODULE_SHA256 = 'a628b64502b5b7e88dbf59d8e310422d4d644da9506191c19c53c3b94a9736e0';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function regularAncestors(directory) {
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    const info = fs.lstatSync(current); if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Linked optional-module directory refused');
    if (path.dirname(current) === current) return;
  }
}
function read(file, maximum = 1024 * 1024) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > maximum) throw Error('Invalid optional-module file');
  return fs.readFileSync(file);
}
function inventory(directory, at = directory) {
  const result = [];
  for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
    const file = path.join(at, entry.name); if (entry.isSymbolicLink()) throw Error('Linked optional-module member refused');
    if (entry.isDirectory()) result.push(...inventory(directory, file));
    else { const name = path.relative(directory, file).replaceAll('\\', '/'); if (!FILES.includes(name)) throw Error('Unreviewed optional-module member: ' + name); result.push(name); }
  }
  return result.sort();
}
function managedAssembly(bytes) {
  if (bytes.length < 256 || bytes.toString('ascii', 0, 2) !== 'MZ') throw Error('Managed Quick Import assembly required');
  const offset = bytes.readUInt32LE(60); if (offset + 24 + 208 > bytes.length || bytes.readUInt32LE(offset) !== 0x4550 || ![0x14c, 0x8664].includes(bytes.readUInt16LE(offset + 4))) throw Error('Invalid Quick Import PE header');
  const optional = offset + 24, magic = bytes.readUInt16LE(optional), directories = magic === 0x10b ? optional + 96 : magic === 0x20b ? optional + 112 : -1;
  if (directories < 0 || directories + 120 > bytes.length || bytes.readUInt32LE(directories + 112) === 0 || bytes.readUInt32LE(directories + 116) < 72) throw Error('Quick Import CLR metadata directory required');
}
function inspectQuickImport(sourceRoot) {
  const directory = path.join(sourceRoot, 'quick-import-mod'); regularAncestors(directory);
  const names = inventory(directory); if (JSON.stringify(names) !== JSON.stringify([...FILES].sort())) throw Error('Optional-module package membership differs');
  let total = 0;
  const files = FILES.map(name => { const bytes = read(path.join(directory, name)); total += bytes.length; return { name, bytes: bytes.length, sha256: hash(bytes) }; });
  if (total > 8 * 1024 * 1024) throw Error('Optional-module package exceeds byte limit');
  const module = JSON.parse(read(path.join(directory, 'MODULE.json'), 16384).toString('utf8').replace(/^\uFEFF/, ''));
  if (module.schema !== 1 || module.kind !== 'production-candidate' || module.build !== BUILD || module.version !== '0.1.0' || module.moduleSha256 !== MODULE_SHA256 || module.gameAssemblySha256 !== GAME_ASSEMBLY_SHA256 || ['defaultEnabled', 'gameBinaryIncluded', 'loaderArchiveIncluded', 'installed'].some(key => module[key] !== false)) throw Error('Optional-module provenance is not reviewed');
  const dll = files.find(file => file.name === 'ChartsHub.QuickImport.dll'); if (dll.sha256 !== module.moduleSha256) throw Error('Quick Import module SHA-256 differs from its reviewed manifest');
  managedAssembly(read(path.join(directory, dll.name)));
  return { schema: 1, platform: 'win32', arch: 'x64', build: module.build, version: module.version, moduleSha256: dll.sha256, gameAssemblySha256: module.gameAssemblySha256, defaultEnabled: false, gameBinaryIncluded: false, loaderArchiveIncluded: false, installed: false, files };
}
function copyQuickImport(sourceRoot, applicationOutput) {
  const before = inspectQuickImport(sourceRoot), parent = path.join(applicationOutput, 'Quick Import'); regularAncestors(applicationOutput);
  if (fs.existsSync(parent)) regularAncestors(parent); else fs.mkdirSync(parent);
  const directory = path.join(parent, 'quick-import-mod'); fs.mkdirSync(directory);
  for (const file of before.files) {
    const target = path.join(directory, file.name); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, read(path.join(sourceRoot, 'quick-import-mod', file.name)), { flag: 'wx' });
    if (hash(read(target)) !== file.sha256) throw Error('Optional module changed during packaging');
  }
  if (JSON.stringify(inspectQuickImport(sourceRoot)) !== JSON.stringify(before)) throw Error('Optional-module source changed during packaging');
  fs.writeFileSync(path.join(directory, 'PACKAGE-MANIFEST.json'), JSON.stringify(before, null, 2) + '\n', { flag: 'wx' });
  return before;
}
module.exports = { FILES, BUILD, GAME_ASSEMBLY_SHA256, MODULE_SHA256, inspectQuickImport, copyQuickImport };
