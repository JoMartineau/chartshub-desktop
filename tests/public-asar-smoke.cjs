'use strict';
// Run the public production modules from the archive that will be distributed.
// External fixtures own only disposable profiles and synthetic media/controls.
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
  'companion/calibration-hardware-windows.ps1'
]);
const PUBLIC_MEMBERS = Object.freeze([
  'companion/catalogue-client.cjs', 'companion/catalogue-enchor-client.cjs',
  'companion/catalogue-external.cjs', 'companion/catalogue-service.cjs',
  'companion/ui/catalogue-card.js', 'companion/ui/catalogue-card-data.js',
  'companion/ui/catalogue-widget.html', 'companion/ui/catalogue-widget.js',
  'companion/ui/catalogue-widget.css', 'companion/ui/localization.js',
  'companion/unified-chat.cjs', 'companion/song-request-discovery.cjs',
  'companion/song-request-connections.cjs', 'companion/song-request-tiktok.cjs', 'companion/stream-server.cjs',
  'companion/session-activity.cjs', 'companion/session-widget-model.cjs',
  'companion/ui/unified-chat-controls.js', 'companion/ui/unified-chat-controls.css',
  'companion/ui/request-discovery-controls.js', 'companion/ui/request-discovery-controls.css',
  'companion/ui/session-widget-controls.js', 'companion/ui/session-widget-controls.css',
  'companion/ui/session-feed.html', 'companion/ui/session-feed.js', 'companion/ui/session-feed.css',
  'companion/ui/home-controls.js', 'companion/ui/home-controls.css',
  'desktop/quick-import-download-completion.cjs', 'companion/quick-import-service.cjs',
  'companion/quick-import-preferences.cjs', 'companion/quick-import-client.cjs',
  'companion/quick-import-download-observer.cjs', 'companion/quick-import-build.cjs',
  'companion/ui/quick-import-controls.js', 'companion/ui/quick-import-controls.css',
  'companion/drum-vst-model.cjs', 'companion/drum-vst-service.cjs',
  'companion/drum-vst-preferences.cjs', 'companion/drum-mt-installer.cjs', 'companion/ui/drum-vst-controls.js',
  'package.json', 'companion/host.cjs', 'companion/preload.cjs',
  'companion/gameplay-measurements.cjs', 'companion/game-capture.cjs',
  'companion/game-widget-integrations.cjs', 'companion/game-mod-preflight.cjs',
  'companion/ui/game-widget-controls.js', 'companion/ui/game-widget-controls.css',
  'companion/clonehero-telemetry-source.cjs', 'companion/clonehero-telemetry-model.cjs',
  'companion/clonehero-telemetry-contract.cjs', 'companion/clonehero-telemetry-view.cjs',
  'companion/song-visuals.cjs', 'companion/song-lyrics-parser.cjs', 'companion/ui/song-visuals-controls.js',
  'companion/ui/panel.js', 'companion/ui/gameplay-features.js',
  'companion/ui/workspace-navigation.js', 'companion/ui/game-capture.js',
  'companion/ui/game-capture.html', 'companion/game-capture-preload.cjs',
  'companion/ui/game-capture-output.js', 'companion/ui/game-capture-output.html',
  'companion/input-viewer.cjs', 'companion/input-viewer-preload.cjs', 'companion/input-viewer-game-events.cjs',
  'companion/ui/input-viewer.html', 'companion/ui/input-viewer.js',
  'companion/ui/input-viewer.css', 'companion/ui/input-viewer-model.js',
  'companion/ui/input-viewer-controls.js', 'companion/ui/input-viewer-paint.js',
  'companion/ui/input-viewer-extra-styles.js', 'companion/ui/input-viewer-trail-paint.js',
  'companion/input-viewer-xinput.cjs', 'companion/input-viewer-xinput-windows.ps1',
  'companion/input-viewer-output-state.cjs', 'companion/input-viewer-output-preload.cjs',
  'companion/ui/input-viewer-output.html', 'companion/ui/input-viewer-output.js',
  'companion/ui/input-viewer-output.css'
]);
const FIXTURES = Object.freeze([
  { name: 'public-gameplay-removal-electron.cjs', count: 9, kind: 'public' },
  { name: 'companion-game-capture-lyrics-electron.cjs', count: 8, kind: 'lyrics' },
  { name: 'input-viewer-electron.cjs', count: 9, kind: 'input-viewer' },
  { name: 'input-viewer-detection-electron.cjs', count: 15, kind: 'input-detection' },
  { name: 'input-viewer-afterglow-electron.cjs', count: 6, kind: 'input-afterglow' },
  { name: 'input-viewer-output-electron.cjs', count: 11, kind: 'input-output' },
  { name: 'drum-vst-electron.cjs', count: 8, kind: 'drums' },
  { name: 'quick-import-electron.cjs', count: 8, kind: 'quick-import' },
  { name: 'companion-session-features-electron.cjs', count: 12, kind: 'session-features' },
  { name: 'game-widget-integrations-electron.cjs', count: 12, kind: 'game-widgets' }
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
  assert.equal(PRIVATE_MEMBERS.length, 11);
  for (const name of PRIVATE_MEMBERS) {
    assert(publicMeasurementBundleIgnore.some(pattern => pattern.test('/' + name)), 'Release ignore missing ' + name);
    assert(!memberSet.has(name), 'Private member present in public ASAR: ' + name);
  }
  assert.deepEqual(members.filter(name => publicMeasurementBundleIgnore.some(pattern => pattern.test('/' + name))), [], 'Private service or asset subtree present');
  assert.deepEqual(members.filter(name => /(?:^|\/)ChartsHub\.CloneHero\.Telemetry\.dll$/i.test(name)), [], 'Connector binary present under another path');
  for (const name of PUBLIC_MEMBERS) assert(memberSet.has(name), 'Public production module missing: ' + name);
  assert(!members.some(name => name.startsWith('native-drum-host/')), 'Native SDK, sources and test plug-in must remain outside the application archive');
  assert(!members.some(name => name.startsWith('quick-import-mod/')), 'Optional game module, installer and development sources must remain outside ASAR');
  assert(!members.some(name => name.startsWith('game-widgets-mod/')), 'Optional Accuracy and lyrics provider, installer and sources must remain outside ASAR');
  assert(!members.some(name => /(?:^|\/)ChartsHub\.QuickImport\.dll$/i.test(name)), 'Optional game module may not be hidden under another archive path');
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
      const checkNames = report.checks.map(check => typeof check === 'string' ? check : check?.name);
      assert(checkNames.every(name => typeof name === 'string' && name.length > 0), 'Named fixture checks required');
      assert.equal(new Set(checkNames).size, fixture.count);
      assert.equal(report.loadedFromAsar, true);
      assert.equal(path.resolve(report.productRoot), archive);
      assert.equal(report.realGameRead, false);
      assert.deepEqual(report.externalRequests, []);
      if (fixture.kind === 'game-widgets') {
        for (const flag of ['actualHostAndIpc', 'actualPreloadAndRenderer', 'actualTelemetrySourceAndModel', 'actualWindowsNamedPipe', 'actualLocalObsServerAndBrowser', 'actualSyntheticLibrary', 'syntheticGameFrames', 'nativeFloatingDisplaysSuppressed']) assert.equal(report[flag], true);
        for (const flag of ['rendererSandboxDisabled', 'visibilityUnexpected', 'calibrationExposed', 'realGameLaunched', 'realProviderConnected', 'realHardwareRead', 'realInputRead', 'realAudioOpened', 'realProfileRead', 'realUserProfileRead', 'realDesktopCaptured', 'realDownload', 'realNetworkUsed', 'installationPerformed']) assert.equal(report[flag], false);
        assert.deepEqual(report.errors, []);
        assert.equal(Object.keys(report.forbiddenCalls).length, 6);
        for (const count of Object.values(report.forbiddenCalls)) assert.equal(count, 0);
        for (const name of Object.keys(report.sourceHashesBefore)) assert.equal(report.sourceHashesBefore[name], publicHashes[name], 'Actual optional widget module hash differs: ' + name);
        assert.deepEqual(report.sourceHashesAfter, report.sourceHashesBefore);
      } else if (fixture.kind === 'session-features') {
        for (const flag of ['actualHostAndIpc', 'actualPreloadAndRenderer', 'actualLibraryAndRequestQueue', 'syntheticProviders', 'syntheticCatalogue', 'syntheticLocalBridge', 'syntheticDownloadWorker', 'syntheticDOMActions', 'syntheticStreamServer', 'syntheticClipboard', 'nativeFloatingDisplaysSuppressed']) assert.equal(report[flag], true);
        assert.equal(report.rendererSandboxDisabled, false);
        assert.equal(report.visibilityUnexpected, false);
        for (const flag of ['realGameLaunched', 'realProviderConnected', 'realHardwareRead', 'realInputRead', 'realAudioOpened', 'realProfileRead', 'realUserProfileRead', 'realDesktopCaptured', 'realDownload', 'realNetworkUsed']) assert.equal(report[flag], false);
        assert.deepEqual(report.errors, []);
        assert.equal(Object.keys(report.forbiddenCalls).length, 5);
        for (const count of Object.values(report.forbiddenCalls)) assert.equal(count, 0);
      } else if (fixture.kind === 'quick-import') {
        assert.equal(report.actualHostAndIpc, true);
        assert.equal(report.actualPreloadAndRenderer, true);
        assert.equal(report.syntheticQuickImportService, true);
        assert.equal(report.syntheticDownloadWorker, true);
        assert.equal(report.rendererSandboxDisabled, false);
        assert.equal(report.visibilityUnexpected, false);
        assert.equal(report.nativeFloatingDisplaysSuppressed, true);
        for (const flag of ['realGameLaunched', 'realProviderConnected', 'realHardwareRead', 'realInputRead', 'realAudioOpened', 'realProfileRead', 'realUserProfileRead', 'realDesktopCaptured', 'realDownload', 'realNetworkUsed']) assert.equal(report[flag], false);
        assert.deepEqual(report.errors, []);
        assert.equal(Object.keys(report.forbiddenCalls).length, 5);
        for (const count of Object.values(report.forbiddenCalls)) assert.equal(count, 0);
      } else if (fixture.kind === 'drums') {
        assert.equal(report.actualHostAndIpc, true);
        assert.equal(report.actualPreloadAndRenderer, true);
        assert.equal(report.syntheticDrumService, true);
        assert.equal(report.rendererSandboxDisabled, false);
        assert.equal(report.visibilityUnexpected, false);
        for (const flag of ['realAudioOpened', 'realMidiRead', 'realXInputRead', 'realHardwareRead', 'realProfileRead', 'realUserProfileRead', 'realDesktopCaptured', 'realPluginLoaded', 'realDownload']) assert.equal(report[flag], false);
        assert.deepEqual(report.errors, []);
        for (const count of Object.values(report.forbiddenCalls)) assert.equal(count, 0);
      } else if (fixture.kind === 'public') {
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
      } else if (fixture.kind === 'input-afterglow') {
        assert.equal(report.productionPaint, true);
        assert.equal(report.paintOverride, null);
        assert.equal(report.actualRendererRaster, true);
        assert.equal(report.syntheticButtons, true);
        assert.equal(report.defaultRendererSecurity, true);
        for (const name of ['realInputRead', 'realDevicesRead', 'realProfileRead']) assert.equal(report[name], false);
        assert(report.checks.every(check => check && typeof check === 'object' && check.passed === true));
        assert.deepEqual(report.errors, []);
        assert.equal(report.evidence.trailStyles.length, 6);
        assert.equal(new Set(report.evidence.trailStyles.map(entry => entry.style)).size, 6);
        for (const name of ['ui/input-viewer-paint.js', 'ui/input-viewer-trail-paint.js', 'ui/input-viewer-extra-styles.js', 'ui/input-viewer-model.js', 'ui/input-viewer.js']) {
          assert.equal(report.sourceHashes[name], publicHashes['companion/' + name], 'Actual afterglow module hash differs: ' + name);
        }
      } else if (fixture.kind === 'input-output') {
        assert.equal(report.actualDirectorAndPreloads, true);
        assert.equal(report.actualOutputRenderer, true);
        assert.equal(report.actualLocalObsServerAndBrowser, true);
        assert.equal(report.defaultRendererSecurity, true);
        assert.equal(report.syntheticWindowsTransport, true);
        assert.equal(report.syntheticGamepads, true);
        for (const name of ['realInputRead', 'realDevicesRead', 'realProfileRead']) assert.equal(report[name], false);
        assert.deepEqual(report.errors, []);
      } else if (fixture.kind === 'input-viewer' || fixture.kind === 'input-detection') {
        assert.equal(report.syntheticGamepads, true);
        if (fixture.kind === 'input-viewer') assert.equal(report.syntheticKeyboard, true);
        else assert.equal(report.syntheticWindowsTransport, true);
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
    privateMembersAbsent: PRIVATE_MEMBERS, privateMemberCount: PRIVATE_MEMBERS.length, entirePrivateSubtreeAbsent: true,
    publicModuleHashes: publicHashes, publicNativeChecks: evidence, totalNativeChecks: evidence.reduce((sum, item) => sum + item.count, 0),
    fixtureSourceHashesBefore: sourcesBefore, fixtureSourceHashesAfter: sourcesAfter,
    publicHostDefault: true, privateOptInOnBundle: false, optionalGameWidgetsBundled: true, optionalGameWidgetsDefaultEnabled: false, calibrationBundled: false, fixtureOnly: true,
    realGameRead: false, realUserProfileRead: false, realHardwareRead: false, realDesktopCaptured: false,
    installationPerformed: false, error: failure ? String(failure.stack || failure) : null
  };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  if (failure) throw failure;
  assert.equal(report.totalNativeChecks, 98);
  console.log(JSON.stringify({ result: report.result, privateMembersAbsent: PRIVATE_MEMBERS.length, nativeChecks: report.totalNativeChecks, version, archiveSha256: archiveBefore, output }));
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
