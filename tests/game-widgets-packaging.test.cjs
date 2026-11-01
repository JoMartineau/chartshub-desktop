'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { FILES, BUILD, MODULE_SHA256, GAME_ASSEMBLY_SHA256, METADATA_SHA256, LOADER_MANIFEST_SHA256, inspectGameWidgets, copyGameWidgets } = require('../package-game-widgets.cjs');
const root = path.resolve(__dirname, '..'), seed = path.join(root, 'game-widgets-mod'), scratch = path.join(root, 'outputs');
const hasModule = fs.existsSync(path.join(seed, 'ChartsHub.CloneHero.Telemetry.dll'));
const compiled = { skip: hasModule ? false : 'Release Windows CI reproduces the optional provider before packaging tests' };
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.mkdirSync(scratch, { recursive: true });
function fixture() { const directory = fs.mkdtempSync(path.join(scratch, 'game-widget-package-')), target = path.join(directory, 'game-widgets-mod'); for (const name of FILES) { const file = path.join(target, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(path.join(seed, name), file); } return directory; }
function changeManifest(directory, patch) { const file = path.join(directory, 'game-widgets-mod/MODULE.json'), value = JSON.parse(fs.readFileSync(file, 'utf8')); fs.writeFileSync(file, JSON.stringify({ ...value, ...patch })); }

test('The optional provider includes twenty-three public source and guide files but no loader or game binaries', () => {
  assert.equal(FILES.length, 24); for (const name of FILES.filter(name => name !== 'ChartsHub.CloneHero.Telemetry.dll')) assert(fs.statSync(path.join(seed, name)).isFile());
  const module = JSON.parse(fs.readFileSync(path.join(seed, 'MODULE.json'), 'utf8')); assert.equal(module.moduleSha256, MODULE_SHA256); assert.equal(module.gameAssemblySha256, GAME_ASSEMBLY_SHA256); assert.equal(module.metadataSha256, METADATA_SHA256);
  assert.equal(digest(path.join(seed, 'LOADER-FILES.json')), LOADER_MANIFEST_SHA256); assert.equal(JSON.parse(fs.readFileSync(path.join(seed, 'source/global.json'), 'utf8')).sdk.version, '10.0.401');
  const project = fs.readFileSync(path.join(seed, 'source/ChartsHub.CloneHero.Telemetry.csproj'), 'utf8'); assert.match(project, /<DebugType>none<\/DebugType>/); assert.match(project, /<DebugSymbols>false<\/DebugSymbols>/); assert.match(project, /<IncludeSourceRevisionInInformationalVersion>false<\/IncludeSourceRevisionInInformationalVersion>/);
  if (process.env.CHARTSHUB_REQUIRE_GAME_WIDGETS_PACKAGE === '1') assert(hasModule, 'Release CI must compile the pinned provider before its tests');
});

test('Exactly twenty-four provider package files pin the module game metadata and shared loader inventory', compiled, () => {
  const value = inspectGameWidgets(root); assert.equal(value.files.length, 24); assert.equal(value.build, BUILD); assert.equal(value.moduleSha256, MODULE_SHA256); assert.equal(value.metadataSha256, METADATA_SHA256); assert.equal(value.loaderManifestSha256, LOADER_MANIFEST_SHA256); assert.equal(value.loaderFileCount, 164); assert.deepEqual(value.features, ['accuracy', 'song-clock-for-lyrics']);
  for (const key of ['defaultEnabled', 'installed', 'gameBinaryIncluded', 'loaderArchiveIncluded']) assert.equal(value[key], false);
  assert(!value.files.some(file => /(?:^|\/)(vendor|bin|obj|UserData)(?:\/|$)|connection\.json|GameAssembly\.dll|MelonLoader\.dll|version\.dll|\.zip$/i.test(file.name)));
});

test('The copied optional provider has a complete relative twenty-four file receipt and preserves all original bytes', compiled, () => {
  const directory = fixture(), application = path.join(directory, 'Application'); fs.mkdirSync(application); const before = inspectGameWidgets(directory);
  assert.deepEqual(copyGameWidgets(directory, application), before); assert.deepEqual(inspectGameWidgets(directory), before);
  const target = path.join(application, 'Clone Hero Integrations/game-widgets-mod'); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'PACKAGE-MANIFEST.json'), 'utf8')), before);
  for (const file of before.files) { assert.equal(digest(path.join(target, file.name)), file.sha256); assert.equal(fs.statSync(path.join(target, file.name)).size, file.bytes); }
});

test('Unreviewed SDK references game files loader archives and runtime configuration are refused', compiled, () => {
  for (const name of ['source/vendor/MelonLoader.dll', 'source/bin/extra.dll', 'source/obj/state.json', 'GameAssembly.dll', 'connection.json', 'MelonLoader.x64.zip', 'UserData/config.json']) {
    const directory = fixture(), file = path.join(directory, 'game-widgets-mod', name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'Forbidden synthetic package member'); assert.throws(() => inspectGameWidgets(directory), /Unreviewed/);
  }
});

test('Missing empty oversized and altered module bytes cannot pass package provenance', compiled, () => {
  for (const change of [directory => fs.unlinkSync(path.join(directory, 'game-widgets-mod/README.md')), directory => fs.writeFileSync(path.join(directory, 'game-widgets-mod/README.md'), ''), directory => fs.writeFileSync(path.join(directory, 'game-widgets-mod/README.md'), Buffer.alloc(1024 * 1024 + 1)), directory => { const file = path.join(directory, 'game-widgets-mod/ChartsHub.CloneHero.Telemetry.dll'), bytes = fs.readFileSync(file); bytes[0] ^= 1; fs.writeFileSync(file, bytes); }]) { const directory = fixture(); change(directory); assert.throws(() => inspectGameWidgets(directory)); }
});

test('Game fingerprints loader membership supported features and activation cannot be self asserted by edited metadata', compiled, () => {
  for (const patch of [{ schema: 2 }, { kind: 'anything' }, { build: BUILD + '-other' }, { version: '0.2.1' }, { moduleFile: 'elsewhere.dll' }, { moduleSha256: 'f'.repeat(64) }, { gameAssemblySha256: 'f'.repeat(64) }, { metadataSha256: 'f'.repeat(64) }, { defaultEnabled: true }, { installed: true }, { loaderVersion: 'next' }, { loaderArchiveIncluded: true }, { gameBinaryIncluded: true }, { features: ['accuracy', 'calibration'] }]) { const directory = fixture(); changeManifest(directory, patch); assert.throws(() => inspectGameWidgets(directory), /provenance/); }
  const directory = fixture(), file = path.join(directory, 'game-widgets-mod/LOADER-FILES.json'), document = JSON.parse(fs.readFileSync(file, 'utf8')); document.files[0].sha256 = '0'.repeat(64); fs.writeFileSync(file, JSON.stringify(document)); assert.throws(() => inspectGameWidgets(directory), /loader manifest SHA-256/);
});

test('Existing provider output packages cannot be overwritten merged or removed', compiled, () => {
  const directory = fixture(), application = path.join(directory, 'Application'), target = path.join(application, 'Clone Hero Integrations/game-widgets-mod'); fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'Existing.txt'), 'preserve');
  assert.throws(() => copyGameWidgets(directory, application), /EEXIST/); assert.equal(fs.readFileSync(path.join(target, 'Existing.txt'), 'utf8'), 'preserve'); assert.deepEqual(fs.readdirSync(target), ['Existing.txt']);
});

test('Hardlinked provider package members are refused rather than treated as owned bytes', compiled, t => {
  const directory = fixture(), file = path.join(directory, 'game-widgets-mod/README.md'); try { fs.linkSync(file, path.join(directory, 'shared.txt')); } catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('OS refused a synthetic hardlink'); throw error; }
  assert.throws(() => inspectGameWidgets(directory), /Invalid game-widget package file/);
});
