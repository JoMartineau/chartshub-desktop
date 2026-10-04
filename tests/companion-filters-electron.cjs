'use strict';
const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { registerCompanionScheme, createCompanionHost } = require('../companion/host.cjs');

// Isolated UI fixture. This harness never installs a module or opens the user's game.
const directory = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'filters-ui-verification'));
app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration();
if (process.env.CHARTSHUB_TEST_NO_SANDBOX === '1') app.commandLine.appendSwitch('no-sandbox');
registerCompanionScheme();
const settings = { enabled: false, saturation: 1, contrast: 1, gamma: 1, exposure: 0, sharpness: 0, vignette: 0 };
const value = { rootPath: path.join(directory, 'Clone Hero fixture'), settings, supported: true, binaryAvailable: true, installed: true, restoreAvailable: true, reshadePresent: false, state: 'restart-required', message: 'Module installé. Lancez Clone Hero pour connecter les filtres.', error: null, running: false, busy: false, native: null };
const filtersService = { async load() {}, status: () => structuredClone(value), async refresh() {}, async dispose() {}, async selectRoot() { throw Error('Unexpected picker'); }, async install() { throw Error('Unexpected install'); }, async restore() { throw Error('Unexpected restore'); }, async setSettings(next) { value.settings = structuredClone(next); } };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) { if (await check()) return; await delay(35); }
  throw Error('Timed out: ' + label);
}
let host;
const passed = [], errors = [];
app.whenReady().then(async () => {
  await fs.mkdir(directory, { recursive: true });
  host = await createCompanionHost({ dataDirectory: directory, cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({ running: null, sessions: [] }), filtersService });
  const panel = await host.open();
  panel.webContents.on('console-message', (...args) => { const message = typeof args[1] === 'object' ? args[1].message : args[2]; if (/Uncaught|Refused/.test(message || '')) errors.push(message); });
  const evaluate = code => panel.webContents.executeJavaScript(code);
  await waitFor(() => evaluate("document.querySelector('#filters-status').textContent.includes('non confirmé')"), 'installation remains unconfirmed');
  await evaluate("document.querySelector('#filters-classic-details').open=true");
  assert.equal(await evaluate("document.querySelector('#filters-install').disabled"), true);
  assert.equal(await evaluate("document.querySelector('#filters-restore').disabled"), false);
  assert.equal(await evaluate("document.querySelectorAll('[data-filter-setting]').length"), 6);
  await evaluate("document.querySelector('#game-filters').scrollIntoView({block:'start'})");
  await delay(100);
  await fs.writeFile(path.join(directory, 'filters-panel-pending.png'), (await panel.webContents.capturePage()).toPNG());
  passed.push('six sliders rendered; installation clearly differs from confirmed native effects');
  await evaluate("document.querySelector('#filters-enabled').click()");
  await waitFor(() => value.settings.enabled, 'enable saved');
  await evaluate("(()=>{const e=document.querySelector('#filters-preset');e.value='vivid';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await waitFor(() => value.settings.saturation === 1.25, 'preset saved');
  assert.equal(value.settings.enabled, true);
  await evaluate("(()=>{const e=document.querySelector('#filters-exposure');e.value='.37';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await waitFor(() => value.settings.exposure === .37, 'slider saved');
  assert.equal(await evaluate("document.querySelector('#filters-preset').value"), 'custom');
  passed.push('enable, presets preserving activation, and slider persistence work through Electron IPC');
  await evaluate("document.querySelector('#filters-widget').click()");
  await waitFor(() => host.getFiltersWidget() && !host.getFiltersWidget().webContents.isLoading(), 'mini widget opens');
  const widget = host.getFiltersWidget();
  const mini = code => widget.webContents.executeJavaScript(code);
  await mini("(()=>{const e=document.querySelector('#filters-widget-engine');e.value='classic';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await waitFor(() => mini("document.querySelector('#filters-enabled').checked"), 'widget receives initial state');
  const miniSnapshot = await mini('window.ChartsHubCompanion.getSnapshot()');
  assert.equal(miniSnapshot.filters.rootPath, undefined);
  assert.equal(miniSnapshot.state, undefined);
  assert.equal((await mini("window.ChartsHubCompanion.command('filters.install')")).ok, false);
  await evaluate("(()=>{const e=document.querySelector('#filters-preset');e.value='soft';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await waitFor(() => mini("document.querySelector('#filters-preset').value==='soft'"), 'widget subscription receives panel changes');
  await mini("(()=>{const e=document.querySelector('#filters-preset');e.value='contrast';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await waitFor(() => evaluate("document.querySelector('#filters-preset').value==='contrast'"), 'panel receives widget changes');
  value.native = { ready: true, frames: 500, enabled: true, pid: 12345 };
  value.state = 'ready'; value.running = true;
  await evaluate("window.ChartsHubCompanion.command('filters.refresh')");
  await waitFor(() => mini("document.querySelector('#filters-status').textContent==='Filtres actifs dans le jeu'"), 'native confirmation status reaches mini widget');
  await fs.writeFile(path.join(directory, 'filters-widget-active.png'), (await widget.webContents.capturePage()).toPNG());
  await mini("document.querySelector('#filters-open-panel').click()");
  await waitFor(() => evaluate("document.activeElement.id==='game-filters'"), 'widget opens filter panel');
  await delay(300);
  await fs.writeFile(path.join(directory, 'filters-panel-active.png'), (await panel.webContents.capturePage()).toPNG());
  passed.push('mini widget receives live subscriptions, updates the main panel, limits IPC, and opens focused controls');
  widget.close();
  await waitFor(() => !host.getFiltersWidget() && !host.snapshot().filtersWidgetEnabled, 'widget destruction clears host state');
  await waitFor(() => evaluate("!document.querySelector('#filters-widget').checked"), 'main toggle clears after widget closed');
  await evaluate("document.querySelector('#filters-reset').click()");
  await waitFor(() => !value.settings.enabled && value.settings.contrast === 1 && value.settings.vignette === 0, 'reset saves neutral disabled defaults');
  await delay(100); // Let the renderer finish its post-command snapshot before IPC handlers are disposed.
  assert.deepEqual(errors, []);
  passed.push('widget destruction synchronizes its toggle; reset restores neutral defaults; no renderer or CSP errors');
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify({ ok: true, passed }, null, 2));
}).catch(async error => {
  process.exitCode = 1;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify({ ok: false, error: error.stack, passed, errors }, null, 2));
}).finally(async () => { await host?.dispose(); app.exit(process.exitCode || 0); });
