'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { FILES, BUILD, MODULE_SHA256, GAME_ASSEMBLY_SHA256, inspectQuickImport, copyQuickImport } = require('../package-quick-import.cjs');
const root = path.resolve(__dirname, '..'), seed = path.join(root, 'quick-import-mod'), scratch = path.join(root, 'outputs');
const hasModule = fs.existsSync(path.join(seed, 'ChartsHub.QuickImport.dll'));
const compiled = { skip: hasModule ? false : 'Optional module not compiled; release CI must reproduce it before packaging tests' };
fs.mkdirSync(scratch, { recursive: true });
function fixture() { const directory = fs.mkdtempSync(path.join(scratch, 'quick-import-package-')); fs.cpSync(seed, path.join(directory, 'quick-import-mod'), { recursive: true, errorOnExist: true }); return directory; }
function manifest(directory, patch) { const target = path.join(directory, 'quick-import-mod/MODULE.json'), value = JSON.parse(fs.readFileSync(target, 'utf8')); fs.writeFileSync(target, JSON.stringify({ ...value, ...patch })); }
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
test('Reviewed public module sources remain available without a loader or generated development references', () => {
  assert.equal(FILES.length, 21); for (const name of FILES.filter(name => name !== 'ChartsHub.QuickImport.dll')) assert(fs.statSync(path.join(seed, name)).isFile());
  const value = JSON.parse(fs.readFileSync(path.join(seed, 'MODULE.json'), 'utf8')); assert.equal(value.moduleSha256, MODULE_SHA256); assert.equal(value.gameAssemblySha256, GAME_ASSEMBLY_SHA256);
  assert.equal(JSON.parse(fs.readFileSync(path.join(seed, 'source/global.json'), 'utf8')).sdk.version, '10.0.401');
  if (process.env.CHARTSHUB_REQUIRE_QUICK_IMPORT_PACKAGE === '1') assert(hasModule, 'Release CI must build the pinned module before running packaging tests');
});
test('The optional package has exactly21 reviewed files and pins the production DLL and exact game identity without executing either', compiled, () => {
  const value = inspectQuickImport(root); assert.equal(FILES.length, 21); assert.equal(value.files.length, 21); assert.equal(value.build, BUILD); assert.equal(value.moduleSha256, MODULE_SHA256); assert.equal(value.gameAssemblySha256, GAME_ASSEMBLY_SHA256);
  for (const field of ['defaultEnabled', 'gameBinaryIncluded', 'loaderArchiveIncluded', 'installed']) assert.equal(value[field], false);
  assert(!value.files.some(file => /(?:^|\/)(vendor|bin|obj|UserData)(?:\/|$)|connection\.json|config\.json|MelonLoader\.dll|GameAssembly\.dll/i.test(file.name)));
});
test('Copying only the optional package writes a complete relative hash manifest and preserves the source package', compiled, () => {
  const directory = fixture(), application = path.join(directory, 'Application'); fs.mkdirSync(application); const before = inspectQuickImport(directory);
  const copied = copyQuickImport(directory, application), destination = path.join(application, 'Quick Import/quick-import-mod'); assert.deepEqual(copied, before); assert.deepEqual(inspectQuickImport(directory), before);
  const receipt = JSON.parse(fs.readFileSync(path.join(destination, 'PACKAGE-MANIFEST.json'))); assert.deepEqual(receipt, before);
  for (const file of before.files) { assert.equal(digest(path.join(destination, file.name)), file.sha256); assert.equal(fs.statSync(path.join(destination, file.name)).size, file.bytes); }
});
test('Development references game binaries and private runtime configuration are not silently included', compiled, () => {
  for (const name of ['source/vendor/MelonLoader.dll', 'source/bin/extra.dll', 'connection.json', 'GameAssembly.dll', 'source/obj/temporary.json']) {
    const directory = fixture(), extra = path.join(directory, 'quick-import-mod', name); fs.mkdirSync(path.dirname(extra), { recursive: true }); fs.writeFileSync(extra, 'Forbidden fixture only'); assert.throws(() => inspectQuickImport(directory), /Unreviewed/);
  }
});
test('Missing empty oversized or tampered module files fail before a release package can be copied', compiled, () => {
  for (const action of [directory => fs.unlinkSync(path.join(directory, 'quick-import-mod/README.md')), directory => fs.writeFileSync(path.join(directory, 'quick-import-mod/README.md'), ''), directory => fs.writeFileSync(path.join(directory, 'quick-import-mod/README.md'), Buffer.alloc(1024 * 1024 + 1)), directory => { const file = path.join(directory, 'quick-import-mod/ChartsHub.QuickImport.dll'), bytes = fs.readFileSync(file); bytes[0] ^= 1; fs.writeFileSync(file, bytes); }]) { const directory = fixture(); action(directory); assert.throws(() => inspectQuickImport(directory)); }
});
test('Self asserted activation or changed build module and game digest metadata cannot bypass pinned provenance', compiled, () => {
  for (const patch of [{ defaultEnabled: true }, { installed: true }, { gameBinaryIncluded: true }, { loaderArchiveIncluded: true }, { moduleSha256: 'a'.repeat(64) }, { gameAssemblySha256: '12bc21e5a88a2fc9' + '0'.repeat(48) }, { build: BUILD + '-other' }, { version: '0.2.0' }, { schema: 2 }]) { const directory = fixture(); manifest(directory, patch); assert.throws(() => inspectQuickImport(directory), /provenance/); }
});
test('Existing output packages are preserved and cannot be overwritten or merged', compiled, () => {
  const directory = fixture(), application = path.join(directory, 'Application'); fs.mkdirSync(application); const target = path.join(application, 'Quick Import/quick-import-mod'); fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'Existing.txt'), 'preserve');
  assert.throws(() => copyQuickImport(directory, application), /EEXIST/); assert.equal(fs.readFileSync(path.join(target, 'Existing.txt'), 'utf8'), 'preserve'); assert.deepEqual(fs.readdirSync(target), ['Existing.txt']);
});
test('Hardlinked package members are refused rather than treated as owned distributable bytes', compiled, t => {
  const directory = fixture(), file = path.join(directory, 'quick-import-mod/README.md'), duplicate = path.join(directory, 'shared.txt');
  try { fs.linkSync(file, duplicate); } catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('OS refused a synthetic hardlink'); throw error; }
  assert.throws(() => inspectQuickImport(directory), /Invalid optional-module file/);
});
