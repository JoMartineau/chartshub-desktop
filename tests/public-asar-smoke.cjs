'use strict';
// Run the public production modules from the archive that will be distributed.
// The two external fixtures own only disposable profiles and synthetic video.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

const PRIVATE_MEMBERS = Object.freeze([
  'companion/connector-assets/ChartsHub.CloneHero.Telemetry.dll',
  'companion/connector-assets/CONNECTOR-UPSTREAM-LICENSE.txt',
  'companion/connector-assets/manifest.json',
  'companion/connector-assets/MELONLOADER-LICENSE.md',
  'companion/connector-assets/MELONLOADER-NOTICE.txt',
  'companion/connector-assets/README.md',
  'companion/connector-setup.cjs',
  'companion/connector-setup-download.cjs',
  'companion/connector-setup-payload.cjs',
  'companion/calibration-hardware.cjs',
  'companion/calibration-hardware-windows.ps1',
  'companion/clonehero-telemetry-source.cjs',
  'companion/clonehero-telemetry-model.cjs'
]);
const PUBLIC_MEMBERS = Object.freeze([
  'package.json', 'companion/host.cjs', 'companion/preload.cjs',
  'companion/gameplay-measurements.cjs', 'companion/game-capture.cjs',
  'companion/ui/panel.js', 'companion/ui/gameplay-features.js',
  'companion/ui/workspace-navigation.js', 'companion/ui/game-capture.js',
  'companion/ui/game-capture.html', 'companion/game-capture-preload.cjs',
  'companion/ui/game-capture-output.js', 'companion/ui/game-capture-output.html',
  'companion/input-viewer.cjs', 'companion/input-viewer-preload.cjs',
  'companion/ui/input-viewer.html', 'companion/ui/input-viewer.js',
  'companion/ui/input-viewer.css', 'companion/ui/input-viewer-model.js',
  'companion/ui/input-viewer-controls.js'
]);
const FIXTURES = Object.freeze([
  { name: 'public-gameplay-removal-electron.cjs', count: 9, kind: 'public' },
  { name: 'companion-game-capture-lyrics-electron.cjs', count: 8, kind: 'lyrics' },
  { name: 'input-viewer-electron.cjs', count: 9, kind: 'input-viewer' }
]);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const repo = path.resolve(__dirname, '..');
const argument = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const trackedSources = [...FIXTURES.map(value => 'tests/' + value.name), 'tests/workspace-input.cjs', 'tests/public-asar-smoke.cjs'];
const sourceHashes = () => Object.fromEntries(trackedSources.map(name => [name, hash(fs.readFileSync(path.join(repo, name)))]));

function reportPaths(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw Error('Fixture outputs may not contain symbolic links');
    if (entry.isDirectory()) found.push(...reportPaths(location));
    else if (entry.name === 'report.json') found.push(location);
  }
  return found;
}

async function main() {
  assert.equal(process.platform, 'win32', 'This public release smoke requires native Windows Electron');
  assert.equal(process.versions.electron, undefined, 'Start the orchestrator with Node');
  const asarArgument = argument('asar'), outputArgument = argument('output');
  assert(asarArgument && outputArgument, 'Explicit --asar and NEW --output paths are required');
  const archive = path.resolve(asarArgument), output = path.resolve(outputArgument);
  const electronArgument = argument('electron');
  const electronExecutable = electronArgument ? path.resolve(electronArgument) : require('electron');
  assert(fs.statSync(electronExecutable).isFile(), 'An installed native Electron executable is required');
  assert.equal(path.extname(archive).toLowerCase(), '.asar');
  assert(fs.lstatSync(archive).isFile() && !fs.lstatSync(archive).isSymbolicLink(), 'Actual regular ASAR required');
  assert(output !== path.parse(output).root && !fs.existsSync(output), 'A NEW disposable output directory is required');
  assert(!output.toLowerCase().startsWith((archive + path.sep).toLowerCase()));
  const asar = createRequire(require.resolve('@electron/packager'))('@electron/asar');
  const members = asar.listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\//, ''));
  const memberSet = new Set(members);
  const { publicMeasurementBundleIgnore } = require('../companion/gameplay-measurements.cjs');
  assert.equal(PRIVATE_MEMBERS.length, 13);
  for (const name of PRIVATE_MEMBERS) {
    assert(publicMeasurementBundleIgnore.some(pattern => pattern.test('/' + name)), 'Release ignore missing ' + name);
    assert(!memberSet.has(name), 'Private member present in public ASAR: ' + name);
  }
  assert.deepEqual(members.filter(name => publicMeasurementBundleIgnore.some(pattern => pattern.test('/' + name))), [], 'Private service or asset subtree present');
  assert.deepEqual(members.filter(name => /(?:^|\/)ChartsHub\.CloneHero\.Telemetry\.dll$/i.test(name)), [], 'Connector binary present under another path');
  for (const name of PUBLIC_MEMBERS) assert(memberSet.has(name), 'Public production module missing: ' + name);
  const publicHashes = Object.fromEntries(PUBLIC_MEMBERS.map(name => [name, hash(asar.extractFile(archive, path.join(...name.split('/'))))]));
  const version = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8')).version;
  assert.equal(version, require('../package.json').version, 'Archive and reviewed source versions differ');
  const archiveBefore = hash(fs.readFileSync(archive)), sourcesBefore = sourceHashes();
  fs.mkdirSync(output, { recursive: true });
  const evidence = [], startedAt = new Date().toISOString();
  let failure;
  try {
    for (const fixture of FIXTURES) {
      const fixtureOutput = path.join(output, fixture.kind);
      fs.mkdirSync(fixtureOutput);
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const command = [path.join(__dirname, fixture.name), '--fixture-output=' + fixtureOutput, '--fixture-asar=' + archive];
      const child = spawnSync(electronExecutable, command, { env, cwd: repo, windowsHide: true, shell: false, encoding: 'utf8', timeout: 125000, maxBuffer: 8 * 1024 * 1024 });
      fs.writeFileSync(path.join(fixtureOutput, 'stdout.log'), child.stdout || '', { flag: 'wx' });
      fs.writeFileSync(path.join(fixtureOutput, 'stderr.log'), child.stderr || '', { flag: 'wx' });
      if (child.error) throw child.error;
      assert.equal(child.status, 0, fixture.name + ' exited unsuccessfully: ' + (child.stderr || '').slice(-2000));
      const paths = reportPaths(fixtureOutput);
      assert.equal(paths.length, 1, 'Exactly one fixture report required');
      const bytes = fs.readFileSync(paths[0]), report = JSON.parse(bytes);
      assert.equal(report.result, 'passed');
      assert.equal(report.error, null);
      assert.equal(report.checks.length, fixture.count);
      assert.equal(new Set(report.checks).size, fixture.count);
      assert.equal(report.loadedFromAsar, true);
      assert.equal(path.resolve(report.productRoot), archive);
      assert.equal(report.realGameRead, false);
      assert.deepEqual(report.externalRequests, []);
      if (fixture.kind === 'public') {
        assert.equal(report.actualHostAndIpc, true);
        assert.equal(report.publicHostDefault, true);
        assert.equal(report.privateServicesInjectedButNeverAccessed, true);
        assert.equal(report.offeredWidgetCount, 5);
        assert.equal(report.storedWidgetCount, 13);
        assert.equal(report.blockedCommands.length, 14);
        assert.equal(report.rendererSandboxDisabled, false);
        assert.equal(report.visibleWindowObserved, false);
        for (const name of ['runtimeErrors', 'consoleErrors', 'cspErrors']) assert.deepEqual(report[name], []);
        for (const value of Object.values(report.forbiddenCalls)) assert.equal(value, 0);
        for (const name of Object.keys(report.sourceHashesBefore)) assert.equal(report.sourceHashesBefore[name], publicHashes[name], 'Actual Host module hash differs: ' + name);
        assert.deepEqual(report.sourceHashesAfter, report.sourceHashesBefore);
        for (const name of ['realGameExecuted', 'realHardwareRead', 'realMediaRead', 'realSongsRead', 'realUserProfileRead', 'realInstallation']) assert.equal(report[name], false);
      } else if (fixture.kind === 'input-viewer') {
        assert.equal(report.syntheticGamepads, true);
        assert.equal(report.syntheticKeyboard, true);
        assert.equal(report.realInputRead, false);
        assert.equal(report.realDevicesRead, false);
        assert.equal(report.realProfileRead, false);
        assert.equal(report.defaultRendererSecurity, true);
        assert.deepEqual(report.errors, []);
      } else {
        assert.equal(report.actualCaptureServiceAndIpc, true);
        assert.equal(report.actualLocalWebRTC, true);
        assert.equal(report.isolatedProfile, true);
        for (const name of ['realWindowCaptured', 'realWindowsEnumerated', 'connectorLoaded', 'audioCaptured']) assert.equal(report[name], false);
        assert.deepEqual(report.errors, []);
      }
      evidence.push({ fixture: fixture.name, count: fixture.count, report: path.relative(output, paths[0]).replaceAll('\\', '/'), sha256: hash(bytes) });
      console.log('PASS actual ASAR ' + fixture.name + ' ' + fixture.count + '/' + fixture.count);
    }
  } catch (error) { failure = error; }
  const archiveAfter = hash(fs.readFileSync(archive)), sourcesAfter = sourceHashes();
  try { assert.equal(archiveAfter, archiveBefore); assert.deepEqual(sourcesAfter, sourcesBefore); } catch (error) { failure ||= error; }
  const report = {
    result: failure ? 'failed' : 'PUBLIC_ASAR_SMOKE_OK', startedAt, completedAt: new Date().toISOString(),
    version, archive, archiveSha256: archiveBefore, archiveSha256After: archiveAfter,
    privateMembersAbsent: PRIVATE_MEMBERS, privateMemberCount: 13, entirePrivateSubtreeAbsent: true,
    publicModuleHashes: publicHashes, publicNativeChecks: evidence, totalNativeChecks: evidence.reduce((sum, item) => sum + item.count, 0),
    fixtureSourceHashesBefore: sourcesBefore, fixtureSourceHashesAfter: sourcesAfter,
    publicHostDefault: true, privateOptInOnBundle: false, fixtureOnly: true,
    realGameRead: false, realUserProfileRead: false, realHardwareRead: false, realDesktopCaptured: false,
    installationPerformed: false, error: failure ? String(failure.stack || failure) : null
  };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  if (failure) throw failure;
  assert.equal(report.totalNativeChecks, 26);
  console.log(JSON.stringify({ result: report.result, privateMembersAbsent: 13, nativeChecks: report.totalNativeChecks, version, archiveSha256: archiveBefore, output }));
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
