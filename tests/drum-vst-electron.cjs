'use strict';
// Actual Host/preload/renderer/IPC, synthetic drum service only. Never open an
// audio/MIDI/controller device, download a plug-in, inspect a game or reuse a profile.
const { app, BrowserWindow, desktopCapturer, shell, dialog } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
if (process.env.NODE_PATH) require('node:module').Module._initPaths();
const { registerFixtureMaintenance, revealWorkspace } = require('./workspace-input.cjs'), disposeMaintenance = registerFixtureMaintenance();
const archiveArg = process.argv.find(value => value.startsWith('--fixture-asar='));
const productRoot = archiveArg ? path.resolve(archiveArg.slice('--fixture-asar='.length)) : path.resolve(__dirname, '..');
if (archiveArg && !productRoot.endsWith('.asar')) throw Error('An actual ASAR is required');
const outputArg = process.argv.find(value => value.startsWith('--fixture-output=')); if (!outputArg) throw Error('Explicit disposable output required');
const output = path.resolve(outputArg.slice('--fixture-output='.length)); if (output === path.parse(output).root) throw Error('Non-root fixture output required');
const directory = path.join(output, 'drums-' + randomUUID().slice(0, 8));
app.setPath('userData', path.join(directory, 'profile')); app.setPath('sessionData', path.join(directory, 'session')); process.env.LOCALAPPDATA = path.join(directory, 'local-app-data');
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const { createCompanionHost, registerCompanionScheme } = require(path.join(productRoot, 'companion/host.cjs'));
const { defaultSettings, validateSettings } = require(path.join(productRoot, 'companion/drum-vst-model.cjs')); registerCompanionScheme();
const checks = [], errors = [], externalRequests = [], calls = [], forbidden = { capture: 0, external: 0, fileDialog: 0 };
desktopCapturer.getSources = async () => { forbidden.capture++; throw Error('Real capture forbidden'); };
shell.openExternal = async () => { forbidden.external++; throw Error('Real external launch forbidden'); };
dialog.showOpenDialog = async () => { forbidden.fileDialog++; throw Error('Real file dialog forbidden'); };
let state = { supported: true, available: true, phase: 'stopped', revision: 1, plugin: null, devices: { audio: [], midi: [], xinput: [] }, settings: defaultSettings(), error: null, meters: { left: 0, right: 0 }, audio: null, mt: { version: '2.1.5.1', state: 'idle', progress: { receivedBytes: 0, totalBytes: null }, error: null } };
state.settings.pads[0].binding = { kind: 'axis', index: 3, direction: -1 };
let nextError = null, host, owner, contents, view, foreign, finished = false, visibilityUnexpected = false;
const fakeService = {
  status: () => structuredClone(state),
  async command(name, payload) {
    calls.push({ name, payload: structuredClone(payload) });
    if (nextError) { const code = nextError; nextError = null; state.phase = 'error'; state.error = code; throw Object.assign(Error(code), { code }); }
    if (name === 'drums.choosePlugin') { state.plugin = { name: 'Synthetic VST3 instrument', loaded: true }; state.phase = 'loaded'; state.revision++; }
    else if (name === 'drums.refreshDevices') state.devices = { audio: [{ id: 'abc123', name: 'Synthetic audio' }], midi: [{ id: 4, name: 'Synthetic MIDI' }], xinput: [{ id: 0, index: 0, name: 'Synthetic XInput' }] };
    else if (name === 'drums.configure') { assert.equal(payload.revision, state.revision); state.settings = validateSettings(payload.settings); state.revision++; }
    else if (name === 'drums.start') { state.phase = 'running'; state.error = null; state.audio = { sampleRate: 48000, blockSize: 128, latencyMs: 5.3, latencyKind: 'reported', exclusive: false }; }
    else if (name === 'drums.stop') { state.phase = state.plugin ? 'loaded' : 'stopped'; state.audio = null; state.meters = { left: 0, right: 0 }; }
    else if (name === 'drums.testPad') { assert.equal(state.phase, 'running'); assert(state.settings.pads.some(pad => pad.id === payload.padId)); }
    else if (name === 'drums.installMt') { assert.deepEqual(payload, { consent: true }); state.mt.state = 'installed'; }
    else if (!['drums.panic', 'drums.editor', 'drums.openMtPage', 'drums.openMtLicense'].includes(name)) throw Error('Unexpected drum command ' + name);
    return this.status();
  },
  async stop() { state.phase = 'stopped'; state.audio = null; }, async dispose() { await this.stop(); }
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(code, target = contents) { let timer; try { return await Promise.race([target.executeJavaScript(code), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Renderer evaluation timeout')), 10000); })]); } finally { clearTimeout(timer); } }
async function until(check, label) { const deadline = Date.now() + 10000; do { if (await check()) return; await delay(25); } while (Date.now() < deadline); throw Error('Timed out: ' + label); }
async function click(selector) {
  await revealWorkspace({ webContents: contents }, selector);
  const point = await evaluate(`(async()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled||n.closest('[inert]'))throw Error('Unavailable control');n.scrollIntoView({block:'center',behavior:'instant'});await new Promise(r=>setTimeout(r,60));const b=n.getBoundingClientRect(),p={x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)},hit=document.elementFromPoint(p.x,p.y);if(!b.width||!b.height||!(hit===n||n.contains(hit)))throw Error('Covered control');return p;})()`);
  contents.focus(); for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) contents.sendInputEvent({ type, ...point, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) }); await delay(70);
}
async function edit(selector, value, event = 'input') { await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Unavailable field');n.value=${JSON.stringify(String(value))};n.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`); }
async function check(name, action) { await action(); checks.push(name); console.log('PASS ' + name); }
const deadline = setTimeout(() => void finish(Error('Drum fixture exceeded 120 seconds')), 120000);
async function finish(error) {
  if (finished) return; finished = true; clearTimeout(deadline);
  if (error) console.error(error.stack || error);
  try { if (error && contents && !contents.isDestroyed()) await fs.writeFile(path.join(directory, 'failure.png'), (await contents.capturePage()).toPNG()); if (foreign && !foreign.isDestroyed()) foreign.destroy(); await host?.dispose(); if (owner && !owner.isDestroyed()) owner.destroy(); disposeMaintenance(); assert.equal(BrowserWindow.getAllWindows().length, 0); } catch (failure) { error ||= failure; }
  await fs.mkdir(directory, { recursive: true });
  const report = { result: error ? 'failed' : 'passed', checks, errors, error: error ? String(error.stack || error) : null, externalRequests, forbiddenCalls: forbidden, calls,
    actualHostAndIpc: true, actualPreloadAndRenderer: true, loadedFromAsar: !!archiveArg, productRoot, syntheticDrumService: true, rendererSandboxDisabled: app.commandLine.hasSwitch('no-sandbox'), visibilityUnexpected,
    realAudioOpened: false, realMidiRead: false, realXInputRead: false, realHardwareRead: false, realGameRead: false, realProfileRead: false, realUserProfileRead: false, realDesktopCaptured: false, realPluginLoaded: false, realDownload: false };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ directory, result: report.result, checks: checks.length })); app.exit(error ? 1 : 0);
}
process.on('uncaughtException', error => void finish(error)); process.on('unhandledRejection', error => void finish(error));
app.whenReady().then(async () => {
  await fs.mkdir(directory, { recursive: true });
  owner = new BrowserWindow({ width: 1280, height: 950, show: false, frame: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  owner.on('show', () => { visibilityUnexpected = true; owner.hide(); });
  host = await createCompanionHost({ dataDirectory: path.join(directory, 'synthetic-companion'), drumVstService: fakeService, cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({ running: false, sessions: [] }), isCatalogueAvailable: () => false, authorizeCatalogue: async () => false,
    catalogueClient: { async load() { return { items: [], revision: 'drum-fixture', demo: false }; }, async artwork() { throw Error('Real artwork forbidden'); } }, downloadWorker: { async run() { throw Error('Real download forbidden'); }, async discard() {}, async resolveCompleted() { return null; } },
    embedded: { ownerWindow: owner, attachView(value) { view = value; owner.contentView.addChildView(value); view.setBounds({ x: 0, y: 0, width: 1280, height: 950 }); contents = value.webContents;
      contents.on('console-message', (_event, detail) => { if (detail.level === 'error' || detail.level >= 3) errors.push(detail.message); }); contents.on('render-process-gone', (_event, detail) => { if (!finished) errors.push(detail.reason); });
      contents.session.webRequest.onBeforeRequest((details, callback) => { const allowed = details.url.startsWith('chartshub-companion://') || details.url.startsWith('data:') || details.url === 'about:blank'; if (!allowed) externalRequests.push(details.url); callback({ cancel: !allowed }); });
    }, activate() { view.setVisible(true); } }
  });
  host.setLanguage('fr'); await host.open(); await until(() => evaluate("!!window.ChartshubWorkspaceNavigation&&!!document.querySelector('#drums-start')"), 'drum renderer ready');

  await check('Public sandboxed Companion exposes the drum workspace without starting or detecting any device', async () => {
    assert.equal(owner.isVisible(), false); const preferences = contents.getLastWebPreferences(); assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false); assert.equal(app.commandLine.hasSwitch('no-sandbox'), false);
    assert(await evaluate("!document.querySelector('[data-companion-workspace=drums]').hidden")); assert.deepEqual(calls, []); assert.equal(host.snapshot().drums.settings.midiDeviceId, -1);
  });
  await check('French drum navigation keeps MT consent unchecked and preparation inactive until an explicit agreement', async () => {
    await click('[data-companion-workspace=drums]'); assert.equal(await evaluate("document.querySelector('#companion-app').dataset.workspace"), 'drums');
    assert.equal(await evaluate("document.querySelector('#page-title').textContent"), 'Batterie / VST');
    assert(await evaluate("!document.querySelector('#drums-mt-consent').checked&&document.querySelector('#drums-mt-install').disabled")); assert.deepEqual(calls, []);
    await click('#drums-mt-license'); assert.equal(calls.at(-1).name, 'drums.openMtLicense');
  });
  await check('Device discovery and plug-in choice use explicit trusted main-panel commands with synthetic results', async () => {
    await click('#drums-refresh-devices'); await until(() => evaluate("document.querySelector('#drums-midi').options.length===2"), 'synthetic devices');
    assert.deepEqual(calls.at(-1), { name: 'drums.refreshDevices', payload: {} }); await click('#drums-choose-plugin');
    await until(() => evaluate("document.querySelector('#drums-plugin').textContent.includes('Synthetic VST3')"), 'synthetic plugin');
    assert(!calls.some(call => call.name === 'drums.start')); assert.equal(forbidden.fileDialog, 0);
  });
  await check('Custom notes and XInput mappings survive revisioned settings application through the real renderer and IPC', async () => {
    await edit('#drums-source', 'manual', 'change'); await edit('#drums-kick-note', 60); await edit('#drums-kick-velocity', 88); await click('#drums-save-settings');
    await until(() => evaluate("!document.querySelector('#drums-start').disabled"), 'saved manual setup');
    assert.equal(state.settings.source, 'manual'); assert.equal(state.settings.pads[0].note, 60); assert.equal(state.settings.pads[0].velocity, 88); assert.deepEqual(state.settings.pads[0].binding, { kind: 'axis', index: 3, direction: -1 });
  });
  await check('English navigation and incoming status updates preserve an unfinished pad edit without replaying commands', async () => {
    await edit('#drums-snare-note', 61); const before = calls.length; state.meters = { left: .2, right: .4 }; host.setLanguage('en');
    await until(() => evaluate("document.querySelector('#page-title').textContent==='Drums / VST'"), 'English drum workspace');
    assert.equal(await evaluate("document.querySelector('#drums-snare-note').value"), '61'); assert.equal(calls.length, before);
    assert.equal(await evaluate("document.querySelector('#drums-source option[value=midi]').textContent"), 'MIDI drum kit'); await click('#drums-save-settings');
    await until(() => evaluate("!document.querySelector('#drums-start').disabled"), 'English settings applied'); assert.equal(state.settings.pads[1].note, 61);
  });
  await check('Explicit Start, pad test, Panic and Stop work through actual IPC without opening audio or reading hardware', async () => {
    await click('#drums-start'); await until(() => evaluate("!document.querySelector('#drums-stop').disabled&&document.querySelector('#drums-source').disabled"), 'synthetic audio running');
    await click('#drums-kick-test'); assert.deepEqual(calls.at(-1), { name: 'drums.testPad', payload: { padId: 'kick', velocity: 88 } });
    await click('#drums-panic'); assert.equal(calls.at(-1).name, 'drums.panic'); await click('#drums-stop');
    await until(() => evaluate("!document.querySelector('#drums-start').disabled"), 'synthetic audio stopped'); assert.equal(state.phase, 'loaded');
  });
  await check('Backend failures are translated and malformed or unconsented commands never reach the drum service', async () => {
    nextError = 'DRUM_MIDI_BUSY'; await click('#drums-start'); await until(() => evaluate("!document.querySelector('#drums-feedback').hidden"), 'translated drum failure');
    assert.match(await evaluate("document.querySelector('#drums-feedback').textContent"), /MIDI input is busy/);
    const before = calls.length; const rejected = await evaluate("Promise.all([window.ChartsHubCompanion.command('drums.installMt',{consent:false}),window.ChartsHubCompanion.command('drums.testPad',{padId:'unknown',velocity:127}),window.ChartsHubCompanion.command('drums.start',{path:'arbitrary.dll'})])");
    assert(rejected.every(result => result.ok === false)); assert.equal(calls.length, before);
  });
  await check('Foreign sandboxed senders and the real read-only overlay cannot obtain or mutate drum capabilities', async () => {
    const probe = path.join(directory, 'probe.cjs'); await fs.writeFile(probe, "const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('FixtureProbe',{read:()=>ipcRenderer.invoke('companion:snapshot'),start:()=>ipcRenderer.invoke('companion:command','drums.start',{})});", { flag: 'wx' });
    foreign = new BrowserWindow({ show: false, webPreferences: { session: contents.session, preload: probe, contextIsolation: true, nodeIntegration: false, sandbox: true } }); await foreign.loadURL('about:blank');
    const before = calls.length; assert.equal(await evaluate('window.FixtureProbe.read()', foreign.webContents), null); assert.equal((await evaluate('window.FixtureProbe.start()', foreign.webContents)).ok, false); assert.equal(calls.length, before); foreign.destroy(); foreign = null;
    await host.setOverlay(true); const overlay = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === 'chartshub-companion://app/ui/overlay.html'); assert(overlay); overlay.hide();
    const received = await evaluate('window.ChartsHubCompanion.getSnapshot()', overlay.webContents); assert.equal(received.drums, undefined);
    assert.equal((await evaluate("window.ChartsHubCompanion.command('drums.start',{})", overlay.webContents)).ok, false); assert.equal(calls.length, before); await host.setOverlay(false);
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []); assert.deepEqual(forbidden, { capture: 0, external: 0, fileDialog: 0 });
  });
  assert.equal(checks.length, 8); await finish();
}).catch(error => void finish(error));
