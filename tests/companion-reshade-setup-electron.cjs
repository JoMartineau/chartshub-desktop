'use strict';
const { app, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { registerCompanionScheme, createCompanionHost } = require('../companion/host.cjs');
const directory = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'reshade-setup-ui-verification'));
app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration();
if (process.env.CHARTSHUB_TEST_NO_SANDBOX === '1') app.commandLine.appendSwitch('no-sandbox');
registerCompanionScheme();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label) { const end = Date.now() + 8000; while (Date.now() < end) { if (await check()) return; await delay(30); } throw Error('Timed out: ' + label); }
let host, finishPreparation = null;
const source = { rootPath: path.join(directory, 'Clone Hero fixture'), supported: true, installed: false, binaryAvailable: true, running: true, connected: false, busy: false, state: 'not-installed', message: 'ReShade à installer.', error: null, catalog: null };
const state = { state: 'idle', busy: false, rootPath: null, includeStarterEffects: false, version: '6.8.0', message: 'Préparez ReShade pour cette installation de Clone Hero.', error: null, progress: null, files: [] };
const calls = [], passed = [];
const publish = () => host?.services.store.setState(value => ({ ...value }));
const reshadeService = { async load() {}, status: () => structuredClone(source), async refresh() {}, async dispose() {}, async selectRoot() { throw Error('No picker permitted'); }, async install() { throw Error('No addon installation permitted'); }, async command() { throw Error('No native effect command permitted'); } };
const reshadeSetupService = { async load() {}, status: () => structuredClone(state), async dispose() {},
  prepare(options) {
    calls.push({ action: 'prepare', ...options });
    Object.assign(state, { state: 'preparing', busy: true, rootPath: source.rootPath, includeStarterEffects: options.includeStarterEffects, message: 'Téléchargement officiel de ReShade…', error: null, files: [], progress: { label: 'ReShade officiel', received: 1048576, total: 4194304 } }); publish();
    return new Promise(resolve => { finishPreparation = resolve; });
  },
  async cancel() { calls.push({ action: 'cancel' }); Object.assign(state, { state: 'idle', busy: false, progress: null, files: [], error: null, message: 'Préparation annulée.' }); publish(); finishPreparation?.(); finishPreparation = null; },
  async install() { calls.push({ action: 'install' }); Object.assign(state, { state: 'complete', busy: false, progress: null, message: 'ReShade est installé. Lancez Clone Hero pour connecter ses effets.' }); source.installed = true; publish(); }
};
function ready() {
  Object.assign(state, { state: 'ready', busy: false, progress: null, message: 'Fichiers prêts. Fermez Clone Hero, puis installez dans le dossier affiché.', files: ['dxgi.dll', 'ReShade.ini', 'ChartsHubReShade.addon64', 'ChartsHub-ReShade-Shaders/Shaders/Bloom.fx', 'ChartsHub-ReShade-Shaders/Shaders/FilmGrain.fx', 'ChartsHub-ReShade-Shaders/Shaders/ChromaticAberration.fx'] }); publish(); finishPreparation?.(); finishPreparation = null;
}
app.whenReady().then(async () => {
  await fs.mkdir(directory, { recursive: true });
  host = await createCompanionHost({ dataDirectory: directory, cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({ running: null, sessions: [] }), reshadeService, reshadeSetupService });
  const panel = await host.open(), evaluate = code => panel.webContents.executeJavaScript(code);
  await waitFor(() => evaluate("!document.querySelector('#reshade-setup').hidden&&!document.querySelector('#reshade-setup-prepare').disabled"), 'assistant appears before connection');
  assert.equal(await evaluate("document.querySelector('#reshade-setup-effects').checked"), false);
  assert.equal(calls.length, 0, 'opening the assistant must not download anything');
  await evaluate("document.querySelector('#reshade-setup-prepare').click()");
  await waitFor(() => evaluate("!document.querySelector('#reshade-setup-cancel').disabled&&!document.querySelector('#reshade-setup-progress').hidden"), 'preparation can be cancelled');
  assert.equal(calls[0].includeStarterEffects, false);
  assert.equal(await evaluate("document.querySelector('#reshade-setup-progress-meter').value"), 1048576);
  await evaluate("document.querySelector('#reshade-setup-cancel').click()");
  await waitFor(() => evaluate("!document.querySelector('#reshade-setup-prepare').disabled&&document.querySelector('#reshade-setup-progress').hidden"), 'cancellation finishes cleanly');
  assert.equal(await evaluate("document.querySelector('#reshade-setup-error').hidden"), true);
  await evaluate("document.querySelector('#reshade-setup-effects').click();document.querySelector('#reshade-setup-prepare').click()");
  await waitFor(() => state.state === 'preparing', 'pack preparation starts while game is running');
  assert.equal(calls.filter(item => item.action === 'prepare').at(-1).includeStarterEffects, true);
  ready();
  await waitFor(() => evaluate("!document.querySelector('#reshade-setup-review').hidden"), 'prepared file list appears');
  assert.equal(await evaluate("document.querySelector('#reshade-setup-install').disabled"), true);
  assert.match(await evaluate("document.querySelector('#reshade-setup-ready-note').textContent"), /Fermez Clone Hero/);
  assert.ok(await evaluate(`document.querySelector('#reshade-setup-root').textContent===${JSON.stringify(source.rootPath)}`));
  assert.match(await evaluate("document.querySelector('#reshade-setup-version').textContent"), /6\.8\.0/);
  await evaluate("window.__preparedFile=document.querySelector('#reshade-setup-files li')");
  for (let i = 0; i < 4; i++) { publish(); await delay(20); }
  assert.equal(await evaluate("window.__preparedFile===document.querySelector('#reshade-setup-files li')"), true, 'unchanged snapshots preserve the reviewed file nodes');
  source.running = false; publish();
  await waitFor(() => evaluate("!document.querySelector('#reshade-setup-install').disabled"), 'installation becomes available only after game closure');
  await evaluate("document.querySelector('#reshade-setup').scrollIntoView({block:'start'})"); await delay(100);
  await fs.writeFile(path.join(directory, 'reshade-setup-ready.png'), (await panel.webContents.capturePage()).toPNG());
  await evaluate("document.querySelector('#reshade-setup-effects').click()");
  assert.equal(await evaluate("document.querySelector('#reshade-setup-install').disabled"), true);
  await evaluate("document.querySelector('#reshade-setup-effects').click()");
  dialog.showMessageBox = async () => { throw Error('Ready screen is the only confirmation required'); };
  await evaluate("document.querySelector('#reshade-setup-install').click()");
  await waitFor(() => evaluate("document.querySelector('#reshade-setup-state').textContent==='Installation terminée'"), 'review button directly installs');
  assert.equal(calls.filter(item => item.action === 'install').length, 1);
  assert.equal(source.connected, false);
  passed.push('no automatic download; optional pack defaults off; preparation/cancellation works while game runs; reviewed target/version/files remain stable; only a closed game enables direct installation');
  source.connected = true; source.state = 'ready'; source.catalog = { enabled: false, preset: 'Fixture.ini', selectedEffect: null, techniques: [], uniforms: [] }; publish();
  await waitFor(() => evaluate("document.querySelector('#reshade-setup').hidden&&!document.querySelector('#reshade-setup-toggle').hidden"), 'assistant collapses after successful connection');
  await evaluate("document.querySelector('#reshade-setup-toggle').click()");
  assert.equal(await evaluate("document.querySelector('#reshade-setup').hidden"), false);
  await host.setFiltersWidget(true); const widget = host.getFiltersWidget();
  const mini = code => widget.webContents.executeJavaScript(code);
  for (const [name, payload] of [['reshade.setupPrepare', { includeStarterEffects: true }], ['reshade.setupInstall', undefined], ['reshade.setupCancel', undefined]]) assert.equal((await mini(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`)).ok, false);
  assert.equal((await mini('window.ChartsHubCompanion.getSnapshot()')).reshadeSetup, undefined);
  passed.push('connected users can reopen the optional assistant; mini widget cannot read setup data or prepare/install/cancel it');
  await delay(100); await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify({ ok: true, passed }, null, 2));
}).catch(async error => { process.exitCode = 1; await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify({ ok: false, error: error.stack, passed }, null, 2)); }).finally(async () => { finishPreparation?.(); await host?.dispose(); app.exit(process.exitCode || 0); });
