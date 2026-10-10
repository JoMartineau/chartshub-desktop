'use strict';
// Real Electron renderer, IPC, host, catalogue, queue and appearance persistence.
// Catalogue/network, native folder picker and transfer worker are synthetic.
// This script never accesses a real chart folder or starts a network transfer.
const { app, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { registerCompanionScheme, createCompanionHost } = require('../companion/host.cjs');

const output = path.resolve(process.argv[2] || path.join(__dirname, '../../companion-catalogue-widget-verification'));
const directory = path.join(output, 'catalogue-widget-' + randomUUID()), dataDirectory = path.join(directory, 'profile'), songs = path.join(directory, 'Synthetic Songs');
app.setPath('userData', path.join(directory, 'electron-profile')); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); registerCompanionScheme();
const originalPicker = dialog.showOpenDialog, passed = [], runs = [], discarded = [], pickerOwners = [];
let host, panel, mini, lastWait = null, failing = false, pickerCancelled = true, catalogueLoads = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const abortError = () => Object.assign(Error('Synthetic transfer interrupted'), { name: 'AbortError', code: 'ABORT_ERR' });
async function waitFor(check, label, timeout = 15000) {
  lastWait = label; const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(30); }
  throw Error('Timed out: ' + label);
}
const evaluate = code => mini.webContents.executeJavaScript(code);
const command = (name, payload) => evaluate(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`);
async function click(selector) {
  let point;
  await waitFor(async () => {
    point = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.hidden||n.disabled)return null;n.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)},hit=document.elementFromPoint(p.x,p.y);return r.width&&r.height&&hit&&(hit===n||n.contains(hit))?p:null;})()`);
    return !!point;
  }, 'visible enabled mini control ' + selector);
  mini.focus(); mini.webContents.focus(); mini.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  mini.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  mini.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 }); await delay(45);
}
async function fillFields(values) {
  await evaluate(`(()=>{for(const [selector,value] of Object.entries(${JSON.stringify(values)})){const n=document.querySelector(selector);if(!n||n.disabled)throw Error('Unavailable input: '+selector);n.value=value;n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
}
async function search(fields, ids) {
  await fillFields(Object.fromEntries(['query', 'artist', 'charter', 'instrument', 'difficulty'].map(key => [`#catalogue-widget-${key}`, fields[key] ?? ''])));
  await click('#catalogue-widget-search');
  await waitFor(() => evaluate(`document.querySelector('#catalogue-widget-results').getAttribute('aria-busy')==='false'&&JSON.stringify([...document.querySelectorAll('#catalogue-widget-results article')].map(n=>n.dataset.chartId).sort())===${JSON.stringify(JSON.stringify([...ids].sort()))}`), 'catalogue search results ' + ids.join(', '));
}
async function capture(name) { await fs.writeFile(path.join(directory, `${name}.png`), (await mini.webContents.capturePage()).toPNG()); }
const state = id => host.downloads.status().items.find(item => item.id === id);
function worker() {
  return {
    run(options) {
      let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
      const run = { ...options, settled: false, aborted: false };
      const finish = (callback, value) => { if (!run.settled) { run.settled = true; options.signal.removeEventListener('abort', onAbort); callback(value); } };
      const onAbort = () => { run.aborted = true; finish(reject, abortError()); };
      run.resolve = value => finish(resolve, value); options.signal.addEventListener('abort', onAbort, { once: true });
      runs.push(run); if (options.signal.aborted) onAbort(); return promise;
    },
    async discard(value) { assert.equal(value.rootPath, songs); discarded.push(value.id); },
    async resolveCompleted(value) {
      assert.equal(value.rootPath, songs); assert.equal(path.dirname(value.destination), songs);
      assert.equal(await fs.readFile(path.join(value.destination, 'notes.chart'), 'utf8'), 'synthetic chart content');
      return value.destination;
    },
  };
}
async function complete(run) {
  assert.equal(run.rootPath, songs); assert.equal(run.settled, false);
  const folderName = 'Synthetic-' + run.id, destination = path.join(songs, folderName);
  assert.equal(path.dirname(destination), songs); await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, 'notes.chart'), 'synthetic chart content');
  run.resolve({ destination, folderName, files: 1, totalBytes: 100 });
  await waitFor(() => state(run.id)?.state === 'Completed', 'synthetic transfer completed');
}
const charts = [
  { id: 'mini-complete', title: 'Notes', artist: '<img src=x onerror="window.__unsafe=true">', charter: 'Fixture charter' },
  { id: 'mini-cancel', title: '<script>window.__unsafe=true</script>', artist: 'Fixture artist', charter: 'Fixture charter' },
].map((item, index) => ({ ...item, verified: true, viewUrl: `https://chartshub.ca/index.html?chart=${item.id}&share=2`,
  downloadEndpoint: `/api/charts/11111111-1111-4111-8111-111111111111/FixtureDownload${index}/download-manifest`,
  instruments: ['Guitar'], difficulties: ['Expert'], instrumentDifficulties: { Guitar: ['Expert'] } }));
async function openHost() {
  host = await createCompanionHost({ dataDirectory, cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({ running: false, sessions: [] }),
    isCatalogueAvailable: () => true, authorizeCatalogue: async () => true,
    catalogueClient: { async load() { catalogueLoads++; return { items: charts, revision: 'mini-electron-fixture', demo: false }; }, async artwork() { throw Error('No network in fixture'); } },
    downloadWorker: worker() });
  panel = await host.open(); await host.setCatalogueWidget(true); mini = host.getCatalogueWidget(); mini.setSize(650, 880);
  await waitFor(() => evaluate("!!window.ChartsHubCompanion&&!document.querySelector('#catalogue-widget-search')?.disabled&&!!document.querySelector('#floating-panels-save')"), 'native mini ready');
}
async function fail(error) {
  if (failing) return; failing = true; console.error(error);
  const report = { result: 'COMPANION_CATALOGUE_WIDGET_FAILED', error: String(error.stack || error), lastWait, passed, runs: runs.map(run => ({ id: run.id, settled: run.settled, aborted: run.aborted })) };
  if (mini && !mini.isDestroyed()) {
    try { report.renderer = await evaluate("({language:document.documentElement.lang,body:document.body.innerText.slice(0,14000),active:document.activeElement?.id})"); } catch (_) {}
    try { await capture('failure'); } catch (_) {}
  }
  await fs.mkdir(directory, { recursive: true }).catch(() => {}); await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2)).catch(() => {});
  console.error('Mini catalogue diagnostics: ' + path.join(directory, 'report.json'));
  try { await host?.dispose(); } catch (_) {} dialog.showOpenDialog = originalPicker; app.exit(1);
}
setTimeout(() => void fail(Error('Mini catalogue Electron verification timed out')), 150000).unref();

app.whenReady().then(async () => {
  await fs.mkdir(songs, { recursive: true });
  dialog.showOpenDialog = async owner => { pickerOwners.push(owner); return pickerCancelled ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [songs] }; };
  await openHost(); assert.equal(mini.isAlwaysOnTop(), true); assert.equal(catalogueLoads, 0); assert.equal(runs.length, 0);
  let scoped = await evaluate('window.ChartsHubCompanion.getSnapshot()');
  for (const key of ['logs', 'library', 'state', 'profiles', 'stream']) assert.equal(Object.hasOwn(scoped, key), false);
  assert.deepEqual(Object.keys(scoped.floatingPanels.appearance), ['catalogue']); assert.equal(scoped.downloads.hasRoot, false);
  assert.equal((await command('library.query', {})).ok, false);
  assert.equal((await command('panels.appearance', { revision: scoped.floatingPanels.revision, panel: 'filters', appearance: scoped.floatingPanels.appearance.catalogue })).ok, false);
  passed.push('native always-on-top catalogue is interactive and receives only scoped data and permitted commands');

  await click('#catalogue-widget-choose-root'); await waitFor(() => pickerOwners.length === 1 && host.downloads.status().rootPath === null, 'cancelled native folder picker');
  assert.equal(pickerOwners[0], mini); assert.equal(runs.length, 0);
  pickerCancelled = false; await click('#catalogue-widget-choose-root'); await waitFor(() => host.downloads.status().rootPath === songs, 'synthetic folder selected');
  passed.push('explicit native picker cancellation preserves the queue and selection uses only the synthetic Songs folder');

  await search({ query: 'Notes' }, ['mini-complete']);
  await search({ artist: 'Fixture artist' }, ['mini-cancel']);
  await search({ charter: 'Fixture charter', instrument: 'Guitar', difficulty: 'Expert' }, charts.map(item => item.id));
  assert.equal(catalogueLoads, 1); assert.equal(runs.length, 0);
  assert.deepEqual(await evaluate("Object.fromEntries([...document.querySelectorAll('#catalogue-widget-results article')].map(n=>[n.dataset.chartId,n.querySelector('h3').textContent]))"), Object.fromEntries(charts.map(item => [item.id, item.title])));
  assert.equal(await evaluate("!!document.querySelector('#catalogue-widget-results img,#catalogue-widget-results script')||window.__unsafe===true"), false);
  await capture('search'); passed.push('title/artist/charter search renders hostile catalogue text inertly and never starts an automatic download');

  await click('[data-chart-id="mini-complete"] button'); await waitFor(() => runs.length === 1, 'first synthetic transfer'); const firstId = runs[0].id;
  assert.equal(runs[0].rootPath, songs); assert.match(runs[0].endpoint, /download-manifest$/);
  runs[0].onProgress({ receivedBytes: 40, totalBytes: 100, completedFiles: 0, totalFiles: 1, currentFile: 'C:/private-fixture-not-exposed' });
  await click('#catalogue-widget-tab-downloads'); await waitFor(() => evaluate("document.querySelector('#catalogue-widget-downloads progress')?.value===40"), 'visible download progress');
  scoped = await evaluate('window.ChartsHubCompanion.getSnapshot()');
  assert.doesNotMatch(JSON.stringify(scoped), /rootPath|destination|currentFile|download-manifest|private-fixture-not-exposed/);
  await click(`[data-download-id="${firstId}"] [data-action="pause"]`); await waitFor(() => state(firstId)?.state === 'Paused', 'paused synthetic download'); assert.equal(runs[0].aborted, true);
  await click(`[data-download-id="${firstId}"] [data-action="resume"]`); await waitFor(() => runs.length === 2 && state(firstId)?.state === 'Downloading', 'resumed synthetic download'); assert.equal(runs[1].id, firstId);
  passed.push('selected ID enters the real queue; progress, pause and resume retain the same item without exposing paths or private endpoints');

  mini.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); mini.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(() => !mini.isVisible(), 'Escape hides mini'); assert.equal(runs[1].signal.aborted, false); assert.equal(state(firstId).state, 'Downloading');
  await complete(runs[1]); await host.setCatalogueWidget(true); await click('#catalogue-widget-tab-recent');
  await waitFor(() => evaluate("document.querySelectorAll('#catalogue-widget-recent article').length===1"), 'completed transfer appears in recents');
  host.setLanguage('en'); await waitFor(() => evaluate("(()=>{const n=document.querySelector('#catalogue-widget-recent time');return document.documentElement.lang==='en'&&document.querySelector('#catalogue-widget-tab-recent').textContent.trim()==='Recent'&&!!n&&n.textContent===new Date(n.dateTime).toLocaleString('en-US')})()"), 'live English mini labels and date');
  assert.equal(await evaluate("document.querySelector('#catalogue-widget-recent h3').textContent"), 'Notes');
  assert.equal(await evaluate("(()=>{const n=document.querySelector('#catalogue-widget-recent time');return n.textContent===new Date(n.dateTime).toLocaleString('en-US')})()"), true);
  await capture('recent-english'); host.setLanguage('fr'); await waitFor(() => evaluate("document.documentElement.lang==='fr'"), 'French mini restored');
  passed.push('Escape hides without stopping the queue; completed recent chart and localized dates stay accurate across live French/English changes');

  await click('#catalogue-widget-tab-search'); await click('[data-chart-id="mini-cancel"] button'); await waitFor(() => runs.length === 3, 'second chart starts'); const secondId = runs[2].id;
  await click('#catalogue-widget-tab-downloads'); await click(`[data-download-id="${secondId}"] [data-action="cancel"]`);
  await waitFor(() => state(secondId)?.state === 'Cancelled', 'cancelled synthetic download'); assert.equal(runs[2].aborted, true); assert.ok(discarded.includes(secondId));
  assert.equal(await fs.readFile(path.join(songs, `Synthetic-${firstId}`, 'notes.chart'), 'utf8'), 'synthetic chart content');
  assert.deepEqual((await fs.readdir(songs)).sort(), [`Synthetic-${firstId}`], 'cancelled worker never publishes a destination');
  await click(`[data-download-id="${secondId}"] [data-action="retry"]`); await waitFor(() => runs.length === 4, 'explicit retry'); assert.equal(runs[3].id, secondId); await complete(runs[3]);
  passed.push('cancel and retry are explicit per-item actions and cancellation preserves the already completed chart');

  await click('.catalogue-widget-appearance > summary');
  await fillFields({ '#floating-panels-background': '#243447', '#floating-panels-text': '#ffeecc', '#floating-panels-opacity': '55', '#floating-panels-font': 'verdana', '#floating-panels-font-size': '18' });
  assert.notEqual(await evaluate("document.querySelector('#catalogue-widget-app').style.getPropertyValue('--floating-background')"), '#2434478c');
  await click('#floating-panels-save');
  await waitFor(() => host.snapshot().floatingPanels.appearance.catalogue.backgroundColor === '#2434478c' && evaluate("document.querySelector('#catalogue-widget-app').style.getPropertyValue('--floating-background')==='#2434478c'&&document.querySelector('.floating-panels-controls').getAttribute('aria-busy')==='false'&&!document.querySelector('#floating-panels-feedback').classList.contains('is-error')"), 'saved floating appearance applied');
  const expectedAppearance = { backgroundColor: '#2434478c', textColor: '#ffeecc', fontFamily: 'verdana', fontSize: 18 };
  assert.deepEqual(host.snapshot().floatingPanels.appearance.catalogue, expectedAppearance);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#catalogue-widget-app')).fontSize"), '18px');
  assert.match(await evaluate("getComputedStyle(document.querySelector('#catalogue-widget-app')).fontFamily"), /Verdana/i);
  await capture('saved-appearance'); await click('#catalogue-widget-close'); await waitFor(() => !mini.isVisible(), 'close button hides mini');
  assert.equal(state(firstId).state, 'Completed'); assert.equal(state(secondId).state, 'Completed');
  await host.setCatalogueWidget(true); assert.equal(await evaluate("document.querySelector('#catalogue-widget-app').style.getPropertyValue('--floating-background')"), '#2434478c');
  passed.push('appearance previews locally, saves explicit alpha/text/font/size and survives close/reopen independently of the completed queue');

  await host.dispose(); host = null; mini = null; panel = null;
  const savedAppearance = JSON.parse(await fs.readFile(path.join(dataDirectory, 'floating-panels.json'), 'utf8'));
  assert.deepEqual(savedAppearance.appearance.catalogue, expectedAppearance);
  const savedQueue = JSON.parse(await fs.readFile(path.join(dataDirectory, 'download-state.json'), 'utf8'));
  assert.equal(savedQueue.rootPath, songs); assert.equal(savedQueue.items.length, 2);
  assert.ok(savedQueue.items.every(item => item.state === 'Completed'));
  await openHost();
  assert.deepEqual(host.snapshot().floatingPanels.appearance.catalogue, expectedAppearance);
  await waitFor(() => evaluate("document.querySelector('#catalogue-widget-app').style.getPropertyValue('--floating-background')==='#2434478c'"), 'appearance restored after host restart');
  await click('#catalogue-widget-tab-recent'); await waitFor(() => evaluate("document.querySelectorAll('#catalogue-widget-recent article').length===2"), 'persistent recent downloads restored');
  assert.equal(runs.length, 4, 'restart must not start new transfers');
  for (const id of [firstId, secondId]) assert.equal(await fs.readFile(path.join(songs, `Synthetic-${id}`, 'notes.chart'), 'utf8'), 'synthetic chart content');
  await capture('restart'); passed.push('full host restart restores the appearance and recent downloads while synthetic chart contents remain intact');

  const report = { result: 'COMPANION_CATALOGUE_WIDGET_OK', count: passed.length, passed, catalogueLoads, transferRuns: runs.length, directory };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  await host.dispose(); dialog.showOpenDialog = originalPicker; app.exit(0);
}).catch(fail);
