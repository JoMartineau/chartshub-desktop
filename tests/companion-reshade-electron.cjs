'use strict';
const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { registerCompanionScheme, createCompanionHost } = require('../companion/host.cjs');
const directory = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'reshade-ui-verification'));
app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration();
if (process.env.CHARTSHUB_TEST_NO_SANDBOX === '1') app.commandLine.appendSwitch('no-sandbox');
registerCompanionScheme();
const calls = [], passed = [], errors = [];
const base = { effect: 'qUINT_bloom.fx', type: 'float', min: [0], max: [2], step: [.01], items: [], uiType: 'slider', description: '', readOnly: false };
const uniforms = [
  { ...base, id: 'u:strength', name: 'BLOOM_INTENSITY', label: 'Intensité du bloom', values: [.3], description: 'Intensité des halos lumineux.' },
  { ...base, id: 'u:rgb', name: 'BLOOM_COLOR', label: 'Couleur', values: [1, .8, .6], min: [0, 0, 0], max: [1, 1, 1] },
  { ...base, id: 'u:bool', name: 'SHOW_BLOOM', label: 'Afficher les halos', type: 'bool', values: [true], min: null, max: null, step: null },
  { ...base, id: 'u:mode', name: 'QUALITY', label: 'Qualité', type: 'int', values: [1], min: [0], max: [2], step: [1], items: ['Basse', 'Moyenne', 'Haute'], uiType: 'combo' },
  { ...base, id: 'u:time', name: 'FRAME_TIME', label: 'Horloge interne', values: [60], readOnly: true },
];
const catalog = { enabled: true, preset: path.join(directory, 'private-presets', 'Mon preset.ini'), selectedEffect: null, uniforms: [], techniques: [
  { id: 't:bloom', name: 'Bloom', label: 'Bloom', effect: 'qUINT_bloom.fx', enabled: false },
  { id: 't:grain', name: 'FilmGrain', label: 'Film Grain', effect: 'FilmGrain.fx', enabled: false },
  { id: 't:ca', name: 'ChromaticAberration', label: 'Chromatic Aberration', effect: 'CA.fx', enabled: false },
  ...Array.from({ length: 180 }, (_, index) => ({ id: `t:other${index}`, name: `Other${index}`, label: index === 0 ? '<img src=x onerror=alert(1)>' : `Shader ${index}`, effect: `Other${index}.fx`, enabled: false }))
] };
const value = { rootPath: path.join(directory, 'Clone Hero fixture'), supported: true, installed: true, binaryAvailable: true, restoreAvailable: true, running: false, connected: false, busy: false, state: 'restart-required', message: 'Lancez Clone Hero pour recevoir les effets ReShade.', error: null, catalog: null };
const reshadeService = { async load() {}, status: () => structuredClone(value), async refresh() {}, async dispose() {}, async selectRoot() { throw Error('No real picker permitted'); }, async install() { throw Error('No real installation permitted'); }, async command(payload) {
  calls.push(structuredClone(payload));
  if (payload.action === 'selectEffect') { value.catalog.selectedEffect = payload.effect; value.catalog.uniforms = payload.effect === base.effect ? uniforms : []; }
  if (payload.action === 'enabled') value.catalog.enabled = payload.enabled;
  if (payload.action === 'technique') value.catalog.techniques.find(item => item.id === payload.id).enabled = payload.enabled;
  if (payload.action === 'uniform') value.catalog.uniforms.find(item => item.id === payload.id).values = [...payload.values];
} };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label) { const end = Date.now() + 8000; while (Date.now() < end) { if (await check()) return; await delay(35); } throw Error('Timed out: ' + label); }
let host;
app.whenReady().then(async () => {
  await fs.mkdir(directory, { recursive: true });
  host = await createCompanionHost({ dataDirectory: directory, cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({ running: null, sessions: [] }), reshadeService });
  const panel = await host.open();
  panel.webContents.on('console-message', (...args) => { const message = typeof args[1] === 'object' ? args[1].message : args[2]; if (/Uncaught|Refused/.test(message || '')) errors.push(message); });
  const evaluate = code => panel.webContents.executeJavaScript(code);
  await waitFor(() => evaluate("document.querySelector('#reshade-status').textContent.includes('attente')"), 'installed bridge remains unconfirmed');
  assert.equal(await evaluate("document.querySelector('#reshade-enabled').disabled"), true);
  assert.equal(await evaluate("document.querySelector('#filters-classic-details').open"), false);
  value.connected = true; value.running = true; value.state = 'ready'; value.catalog = catalog; value.message = 'ReShade connecté. Choisissez les effets à activer.';
  await evaluate("window.ChartsHubCompanion.command('reshade.refresh')");
  await waitFor(() => evaluate("document.querySelectorAll('.reshade-technique').length===150"), 'large catalog renders bounded visible list');
  assert.equal(await evaluate("document.querySelectorAll('#reshade-techniques img').length"), 0);
  assert.ok(await evaluate("document.querySelector('#reshade-techniques').textContent.includes('<img src=x onerror=alert(1)>')"));
  assert.equal(catalog.techniques.filter(item => item.enabled).length, 0);
  await evaluate("(()=>{const e=document.querySelector('#reshade-search');e.value='bloom';e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  assert.equal(await evaluate("document.querySelectorAll('.reshade-technique').length"), 1);
  await evaluate("document.querySelector('[data-technique-id=\"t:bloom\"] input').click()");
  await waitFor(() => catalog.techniques[0].enabled, 'one original technique is enabled');
  assert.equal(catalog.techniques.filter(item => item.enabled).length, 1);
  await evaluate("document.querySelector('[data-technique-id=\"t:bloom\"] button').click()");
  await waitFor(() => evaluate("document.querySelectorAll('.reshade-uniform').length===4"), 'effect native parameters render and automatic uniform stays hidden');
  assert.equal(catalog.selectedEffect, 'qUINT_bloom.fx');
  assert.equal(await evaluate("!!document.querySelector('[data-uniform-id=\"u:time\"]')"), false);
  passed.push('installed/connected states differ; large catalog is searchable and shader text stays inert; no effects are enabled automatically');
  await evaluate("(()=>{const e=document.querySelector('[data-uniform-id=\"u:rgb\"] input[type=number][data-component=\"1\"]');e.value='.42';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await waitFor(() => uniforms[1].values[1] === .42, 'vector component update');
  assert.deepEqual(uniforms[1].values, [1, .42, .6]);
  await evaluate("document.querySelector('[data-uniform-id=\"u:bool\"] input').click()");
  await waitFor(() => uniforms[2].values[0] === false, 'boolean parameter');
  await evaluate("(()=>{const e=document.querySelector('[data-uniform-id=\"u:mode\"] select');e.value='2';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await waitFor(() => uniforms[3].values[0] === 2, 'enum parameter');
  await evaluate("(()=>{const e=document.querySelector('[data-uniform-id=\"u:strength\"] input[type=range]');e.value='.55';e.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#reshade-save').click();})()");
  await waitFor(() => calls.some(item => item.action === 'save'), 'save request');
  assert.equal(uniforms[0].values[0], .55);
  const saveIndex = calls.findIndex(item => item.action === 'save');
  assert.equal(calls[saveIndex - 1].action, 'uniform');
  await waitFor(() => evaluate("document.querySelector('#reshade-feedback').textContent.includes('Demande')"), 'save acknowledgment is candid');
  passed.push('float, vector, boolean, enum controls send native values; saving flushes pending slider changes before requesting preset save');
  await evaluate("document.querySelector('#game-filters').scrollIntoView({block:'start'})");
  await delay(100);
  await fs.writeFile(path.join(directory, 'reshade-panel-connected.png'), (await panel.webContents.capturePage()).toPNG());
  await evaluate("document.querySelector('#reshade-widget').click()");
  await waitFor(() => host.getFiltersWidget() && !host.getFiltersWidget().webContents.isLoading(), 'mini widget opens');
  const widget = host.getFiltersWidget(); const mini = code => widget.webContents.executeJavaScript(code);
  await waitFor(() => mini("document.querySelectorAll('.reshade-uniform').length===4"), 'mini receives selected effect parameters');
  assert.equal(await mini("document.querySelector('#filters-widget-engine').value"), 'reshade');
  const miniSnapshot = await mini('window.ChartsHubCompanion.getSnapshot()');
  assert.equal(miniSnapshot.reshade.rootPath, undefined); assert.equal(miniSnapshot.reshade.catalog.preset, 'Mon preset.ini');
  for (const action of ['reshade.install', 'reshade.chooseRoot', 'reshade.refresh']) assert.equal((await mini(`window.ChartsHubCompanion.command(${JSON.stringify(action)})`)).ok, false);
  await mini("(()=>{const e=document.querySelector('#reshade-search');e.value='bloom';e.dispatchEvent(new Event('input',{bubbles:true}));const n=document.querySelector('[data-uniform-id=\"u:strength\"] input[type=number]');n.value='.77';n.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await waitFor(() => evaluate("document.querySelector('[data-uniform-id=\"u:strength\"] input[type=number]').value==='0.77'"), 'mini parameter updates reach main panel');
  await fs.writeFile(path.join(directory, 'reshade-widget-connected.png'), (await widget.webContents.capturePage()).toPNG());
  await mini("document.querySelector('#reshade-open-panel').click()");
  await waitFor(() => evaluate("document.activeElement.id==='game-filters'"), 'open main controls');
  value.connected = false; value.catalog = null; value.state = 'restart-required';
  await evaluate("window.ChartsHubCompanion.command('reshade.refresh')");
  await waitFor(() => mini("document.querySelector('#reshade-enabled').disabled&&document.querySelectorAll('.reshade-technique').length===0"), 'disconnect disables widget and clears stale effects');
  widget.close();
  await waitFor(() => evaluate("!document.querySelector('#reshade-widget').checked"), 'closing widget synchronizes main toggle');
  await delay(100); assert.deepEqual(errors, []);
  passed.push('mini defaults to ReShade, shares controls live, denies installation IPC, opens the panel and clears stale controls on disconnect');
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify({ ok: true, passed }, null, 2));
}).catch(async error => { process.exitCode = 1; await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify({ ok: false, error: error.stack, passed, errors }, null, 2)); }).finally(async () => { await host?.dispose(); app.exit(process.exitCode || 0); });
