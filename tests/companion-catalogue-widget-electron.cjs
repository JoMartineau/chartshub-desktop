'use strict';
// Real Electron renderer, IPC, host, catalogue, queue and appearance persistence.
// Catalogue/network, native folder picker and transfer worker are synthetic.
// This script never accesses a real chart folder or starts a network transfer.
const { app, dialog, nativeImage } = require('electron');
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
const artworkRequests = [], layouts = [], batchRequests = [];
let host, panel, mini, lastWait = null, failing = false, pickerCancelled = true, pickerTarget = songs, catalogueLoads = 0;
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
  await fillFields(Object.fromEntries(['query', 'artist', 'charter', 'instrument', 'difficulty', 'installed', 'favorites'].map(key => [`#catalogue-widget-${key}`, fields[key] ?? (['installed', 'favorites'].includes(key) ? 'all' : '')])));
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
  { id: 'mini-complete', title: 'Notes', artist: '<img src=x onerror="window.__unsafe=true">', charter: 'JoMartineau',
    charterSegments: [{ text: 'Jo', color: '#ff4040' }, { text: 'Mart', color: '#50e080' }, { text: 'ineau', color: '#609cff' }],
    artworkUrl: 'https://chartshub.ca/api/charts/22222222-2222-4222-8222-222222222222/FixtureArtwork00/cover',
    charterIconUrl: 'https://chartshub.ca/api/charts/22222222-2222-4222-8222-222222222222/FixtureArtwork00/charter-icon',
    verified: true, staffRole: 'moderator', album: 'Fixture Album', year: '2026', genre: 'Metalcore', duration: 249, game: ['Clone Hero'],
    instruments: ['Guitar', 'Drums'], difficulties: ['Easy', 'Medium', 'Hard', 'Expert'],
    instrumentDifficulties: { Guitar: ['Easy', 'Medium', 'Hard', 'Expert'], Drums: ['Easy', 'Expert'] }, instrumentIntensities: { Guitar: 2, Drums: 4 } },
  { id: 'mini-cancel', title: '<script>window.__unsafe=true</script>', artist: 'Fixture artist', charter: 'Fixture charter' },
  { id: 'mini-broken', title: 'Unavailable artwork', artist: 'Other synthetic artist', charter: 'Another charter',
    artworkUrl: 'https://chartshub.ca/api/charts/33333333-3333-4333-8333-333333333333/FixtureArtwork02/cover',
    charterIconUrl: 'https://chartshub.ca/api/charts/33333333-3333-4333-8333-333333333333/FixtureArtwork02/charter-icon' },
].map((item, index) => ({ verified: false, instruments: ['Guitar'], difficulties: ['Expert'], instrumentDifficulties: { Guitar: ['Expert'] },
  ...item, viewUrl: `https://chartshub.ca/index.html?chart=${item.id}&share=2`,
  downloadEndpoint: `/api/charts/11111111-1111-4111-8111-111111111111/FixtureDownload${index}/download-manifest`,
}));
let fixtureCharts = charts, fixtureDemo = false, fixtureRevision = 0;
const cardSelector = id => `article[data-chart-id="${id}"]`;
const favoriteSelector = id => cardSelector(id) + ' .catalogue-favorite';
const selectionSelector = id => cardSelector(id) + ' .catalogue-selection-check';
const panelCommand = (name, payload) => panel.webContents.executeJavaScript(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`);
async function selectedIds() {
  return evaluate("[...document.querySelectorAll('.catalogue-selection-check:checked')].map(n=>n.dataset.chartId).sort()");
}
async function selectionIs(ids) {
  await waitFor(async () => JSON.stringify(await selectedIds()) === JSON.stringify([...ids].sort()), 'individual selection ' + ids.join(', '));
}
async function replaceCatalogue(items, demo = false) {
  fixtureCharts = items; fixtureDemo = demo; fixtureRevision++;
  assert.equal((await command('catalogue.refresh')).ok, true);
  await search({}, items.map(item => item.id));
}
function additionalCharts(prefix) {
  return ['linked', 'candidate', 'absent'].map((label, index) => ({ id: `${prefix}-${label}`, title: `${prefix} ${label}`, artist: 'Synthetic catalogue artist', charter: 'Synthetic charter',
    verified: false, instruments: ['Guitar'], difficulties: ['Expert'], instrumentDifficulties: { Guitar: ['Expert'] },
    viewUrl: `https://chartshub.ca/index.html?chart=${prefix}-${label}&share=2`,
    downloadEndpoint: `/api/charts/11111111-1111-4111-8111-111111111111/Fixture${prefix}${index}/download-manifest` }));
}
async function verifyFavorites() {
  const count = runs.length, loads = catalogueLoads, id = charts[0].id;
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(favoriteSelector(id))}).getAttribute('aria-pressed')`), 'false');
  assert.equal(await evaluate("[...document.querySelectorAll('.catalogue-favorite')].every(n=>!!n.getAttribute('aria-label')&&n.type==='button')&&['installed','favorites'].every(id=>document.querySelector('#catalogue-widget-'+id).labels.length>0)"), true, 'favorite buttons and filters have accessible names');
  await click(favoriteSelector(id)); await search({ favorites: 'yes' }, [id]);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(favoriteSelector(id))}).getAttribute('aria-pressed')`), 'true');
  await click(favoriteSelector(id)); await search({ favorites: 'yes' }, []);
  await search({}, charts.map(item => item.id));
  await click(favoriteSelector(id)); await search({ favorites: 'yes' }, [id]);
  const persisted = JSON.parse(await fs.readFile(path.join(dataDirectory, 'favorites.json'), 'utf8'));
  assert.deepEqual(persisted, { version: 1, ids: [id] });
  await capture('favorites-french');
  host.setLanguage('en'); await waitFor(() => evaluate("document.documentElement.lang==='en'"), 'favorite labels English');
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(favoriteSelector(id))}).getAttribute('aria-label')`), /favorite/i);
  await capture('favorites-english'); host.setLanguage('fr'); await waitFor(() => evaluate("document.documentElement.lang==='fr'"), 'favorite labels French');
  await search({}, charts.map(item => item.id));
  assert.equal(runs.length, count); assert.equal(catalogueLoads, loads, 'favorite toggles and filtering need no remote refresh');
  passed.push('favorite add/remove updates the filtered list and accessible state, persists locally and never downloads automatically');
}
async function verifyInstalled() {
  const items = additionalCharts('relation'), root = path.join(directory, 'Synthetic Library Songs'), transfersBefore = runs.length;
  await fs.mkdir(root, { recursive: true });
  for (const [folder, record] of [['linked', items[0]], ['candidate-one', items[1]], ['candidate-two', items[1]]]) {
    const destination = path.join(root, folder); await fs.mkdir(destination);
    await fs.writeFile(path.join(destination, 'song.ini'), `[Song]\nname = ${record.title}\nartist = ${record.artist}\ncharter = ${record.charter}\n`);
    await fs.writeFile(path.join(destination, 'notes.chart'), '[Song]\n{\n  Resolution = 192\n}\n[ExpertSingle]\n{\n  0 = N 0 0\n}\n');
  }
  await replaceCatalogue(items);
  pickerTarget = root;
  try { assert.equal((await panelCommand('library.chooseRoot')).ok, true); }
  finally { pickerTarget = songs; }
  assert.equal(pickerOwners.at(-1), panel, 'only the main Companion can select the library root');
  await waitFor(() => host.library.status().status === 'ready' && host.library.matchingSnapshot().items.length === 3, 'three real synthetic library charts indexed');
  await host.library.configure({ watch: false, refreshOnStart: false });
  const local = host.library.matchingSnapshot().items.find(item => item.title === items[0].title);
  assert.ok(local, 'linked fixture is parsed by the actual library scanner');
  const candidates = await panelCommand('catalogue.candidates', { localId: local.id }); assert.equal(candidates.ok, true);
  const link = { localId: local.id, chartId: items[0].id, contextId: candidates.result.contextId };
  assert.equal((await command('catalogue.link', link)).ok, false, 'floating widget cannot create library associations');
  assert.equal((await panelCommand('catalogue.link', link)).ok, true);
  await search({}, items.map(item => item.id));
  const result = await command('catalogue.search', {}); assert.equal(result.ok, true);
  const states = Object.fromEntries(result.result.items.map(item => [item.id, item.installed]));
  assert.equal(states[items[0].id].status, 'linked');
  assert.equal(states[items[1].id].status, 'candidate'); assert.equal(states[items[1].id].localIds.length, 2);
  assert.equal(states[items[2].id].status, 'none');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(cardSelector(items[0].id) + ' .catalogue-installed-badge')}).dataset.status`), 'linked');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(cardSelector(items[1].id) + ' .catalogue-installed-badge')}).dataset.status`), 'candidate');
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(cardSelector(items[2].id) + ' .catalogue-installed-badge[data-status="linked"]')})`), false);
  await capture('installed-and-ambiguous');
  host.setLanguage('en');
  await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(cardSelector(items[0].id) + ' .catalogue-installed-badge')}).textContent==='Already installed'`), 'English installed label');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(cardSelector(items[1].id) + ' .catalogue-installed-badge')}).textContent`), 'Needs confirmation');
  await capture('installed-and-ambiguous-english'); host.setLanguage('fr');
  await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(cardSelector(items[0].id) + ' .catalogue-installed-badge')}).textContent==='Déjà installé'`), 'French installed label');
  await search({ installed: 'linked' }, [items[0].id]);
  await search({ installed: 'unlinked' }, [items[1].id, items[2].id]);
  await search({}, items.map(item => item.id));
  assert.equal(runs.length, transfersBefore, 'library scans, links and installation filters never enqueue downloads');
  passed.push('only an explicit main-Companion association is installed; two metadata candidates remain unlinked in the real scanner and floating filters');
  return items;
}
async function verifyBatch(items) {
  const [first, second, untouched] = items, originalEnqueue = host.downloads.enqueue, attempts = [];
  const queueBefore = host.downloads.status().items.map(item => item.id).sort(), runsBefore = runs.length;
  for (const item of [first, second]) await click(selectionSelector(item.id));
  await selectionIs([first.id, second.id]);
  assert.equal(runs.length, runsBefore, 'checking individual cards never starts transfers');
  assert.equal(await evaluate("document.querySelector('#catalogue-widget-selection-summary').getAttribute('aria-live')"), 'polite');
  assert.match(await evaluate("document.querySelector('#catalogue-widget-selection-summary').textContent"), /^2\b/);
  const summary = await evaluate("document.querySelector('#catalogue-widget-selection-items').textContent");
  assert.ok(summary.includes(first.title) && summary.includes(second.title) && !summary.includes(untouched.title), 'summary names only the two checked charts');
  await capture('batch-two-selected');
  host.setLanguage('en'); await waitFor(() => evaluate("document.querySelector('#catalogue-widget-selection-summary').textContent==='2 selected charts'"), 'English batch count');
  await selectionIs([first.id, second.id]); await capture('batch-two-selected-english');
  host.setLanguage('fr'); await waitFor(() => evaluate("document.querySelector('#catalogue-widget-selection-summary').textContent==='2 charts sélectionnées'"), 'French batch count');
  await click('#catalogue-widget-clear-selection'); await selectionIs([]);
  assert.deepEqual(host.downloads.status().items.map(item => item.id).sort(), queueBefore);
  for (const item of [first, second]) await click(selectionSelector(item.id));
  let failSecond = true;
  // Inject one safe service failure while keeping the actual renderer, scoped IPC,
  // download validation, persistence and worker for all successful requests.
  host.downloads.enqueue = async descriptor => {
    attempts.push(descriptor.chartId); batchRequests.push({ phase: 'partial', chartId: descriptor.chartId });
    if (descriptor.chartId === second.id && failSecond) { failSecond = false; throw Object.assign(Error('Synthetic queue refusal'), { code: 'DOWNLOAD_SAFE' }); }
    return originalEnqueue(descriptor);
  };
  try {
    await click('#catalogue-widget-download-selected');
    await waitFor(() => attempts.length === 2 && evaluate("!document.querySelector('#catalogue-widget-download-selected').disabled"), 'partial batch settles and retry is enabled');
    assert.deepEqual(attempts, [first.id, second.id]);
    await selectionIs([second.id]);
    const added = host.downloads.status().items.filter(item => !queueBefore.includes(item.id));
    assert.deepEqual(added.map(item => item.chartId), [first.id]);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selectionSelector(first.id))}).disabled`), true, 'queued chart cannot be selected again');
    assert.equal(host.downloads.status().items.some(item => item.chartId === untouched.id), false);
    assert.match(await evaluate("document.querySelector('#catalogue-widget-batch-status').textContent"), /1 ajout\(s\).*1 échec\(s\)/);
    await capture('batch-partial-failure');
    await click('#catalogue-widget-download-selected'); await selectionIs([]);
    await waitFor(() => host.downloads.status().items.some(item => item.chartId === second.id), 'explicit retry adds only failed selected chart');
    assert.deepEqual(attempts, [first.id, second.id, second.id]);
    await waitFor(() => runs.length > runsBefore, 'first selected chart transfer');
    const firstRun = runs.find(run => run.id === added[0].id); assert.ok(firstRun); await complete(firstRun);
    const secondId = host.downloads.status().items.find(item => item.chartId === second.id).id;
    await waitFor(() => runs.some(run => run.id === secondId), 'second selected chart transfer');
    await complete(runs.find(run => run.id === secondId));
    assert.equal(host.downloads.status().items.some(item => item.chartId === untouched.id), false);
    passed.push('two-of-three selection can be cleared without side effects; explicit serial batch preserves successes and retries only the failed checked chart');
  } finally { host.downloads.enqueue = originalEnqueue; }

  const cancelItems = additionalCharts('cancelbatch'); await replaceCatalogue(cancelItems);
  for (const item of cancelItems.slice(0, 2)) await click(selectionSelector(item.id));
  let release; const gate = new Promise(resolve => { release = resolve; }), cancelAttempts = [];
  host.downloads.enqueue = async descriptor => {
    cancelAttempts.push(descriptor.chartId); batchRequests.push({ phase: 'cancel', chartId: descriptor.chartId }); const result = await originalEnqueue(descriptor);
    await gate; return result;
  };
  try {
    await click('#catalogue-widget-download-selected');
    await waitFor(() => host.downloads.status().items.some(item => item.chartId === cancelItems[0].id), 'first batch item accepted before delayed acknowledgment');
    await click('#catalogue-widget-cancel-batch'); release();
    await waitFor(() => evaluate("document.querySelector('#catalogue-widget-cancel-batch').hidden"), 'batch cancellation settles');
    assert.deepEqual(cancelAttempts, [cancelItems[0].id], 'cancel stops every request not already submitted');
    const current = host.downloads.status().items.find(item => item.chartId === cancelItems[0].id);
    assert.ok(['Queued', 'Downloading'].includes(current.state), 'batch cancellation preserves the already accepted download');
    assert.equal(host.downloads.status().items.some(item => cancelItems.slice(1).some(record => record.id === item.chartId)), false);
    await capture('batch-cancelled'); await host.downloads.cancel(current.id);
  } finally { release(); host.downloads.enqueue = originalEnqueue; }
  const afterCancel = host.downloads.status().items.map(item => item.id).sort();
  await replaceCatalogue(additionalCharts('demo'), true);
  assert.equal(await evaluate("[...document.querySelectorAll('.catalogue-selection-check')].every(n=>n.disabled)&&document.querySelector('#catalogue-widget-download-selected').disabled"), true);
  assert.deepEqual(host.downloads.status().items.map(item => item.id).sort(), afterCancel);
  passed.push('cancel during a pending batch acknowledgement stops the remaining IDs without cancelling accepted transfers; demo cards stay unselectable');
}
let artworkPng;
function syntheticArtwork() {
  if (!artworkPng) {
    const width = 96, height = 96, pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4, stripe = x > 20 && x < 76 && y % 24 < 12;
      pixels[offset] = stripe ? 255 : 70; pixels[offset + 1] = stripe ? 160 : 25; pixels[offset + 2] = stripe ? 65 : 20; pixels[offset + 3] = 255;
    }
    artworkPng = nativeImage.createFromBitmap(pixels, { width, height }).toPNG();
    assert.ok(artworkPng.length > 32, 'synthetic artwork is a real encoded image');
  }
  return artworkPng;
}
async function verifyCardPresentation() {
  for (const id of charts.map(item => item.id)) {
    await evaluate(`document.querySelector('[data-chart-id="${id}"]').scrollIntoView({block:'center',behavior:'instant'})`);
    await waitFor(() => evaluate(`(()=>{const card=document.querySelector('[data-chart-id="${id}"]');return [...card.querySelectorAll('img')].every(image=>image.hidden&&!image.hasAttribute('src')||image.complete&&image.naturalWidth>0)})()`), 'artwork loaded or visible fallback for ' + id);
  }
  const presentation = await evaluate(`(()=>{
    const card=document.querySelector('[data-chart-id="mini-complete"]'), missing=document.querySelector('[data-chart-id="mini-cancel"]'), broken=document.querySelector('[data-chart-id="mini-broken"]');
    const imageState=box=>({images:box.querySelectorAll('img').length,visibleFallback:!box.firstElementChild.hidden,loaded:!![...box.querySelectorAll('img')].find(image=>!image.hidden&&image.complete&&image.naturalWidth>0),src:box.querySelector('img')?.getAttribute('src')||null});
    return {cover:imageState(card.querySelector('.catalogue-card-artwork')),icon:imageState(card.querySelector('.catalogue-charter-avatar')),missing:imageState(missing.querySelector('.catalogue-card-artwork')),broken:imageState(broken.querySelector('.catalogue-card-artwork')),brokenIcon:imageState(broken.querySelector('.catalogue-charter-avatar')),
      charter:card.querySelector('.catalogue-charter-name').textContent,segments:[...card.querySelectorAll('.catalogue-charter-name span')].map(part=>({text:part.textContent,color:getComputedStyle(part).color})),
      instruments:[...card.querySelectorAll('.catalogue-instrument')].map(n=>({instrument:n.dataset.instrument,intensity:n.querySelector('.catalogue-instrument-intensity').textContent,markers:[...n.querySelectorAll('.catalogue-instrument-levels span')].map(m=>({label:m.textContent,available:m.classList.contains('available')})),svg:!!n.querySelector('svg path')})),
      badges:[...card.querySelectorAll('.catalogue-staff-badge')].map(n=>n.textContent),otherBadges:missing.querySelectorAll('.catalogue-staff-badge').length+broken.querySelectorAll('.catalogue-staff-badge').length,
      game:card.querySelector('.catalogue-game-badge')?.textContent,unsafe:!!document.querySelector('#catalogue-widget-results script,#catalogue-widget-results [onerror],#catalogue-widget-results iframe')||window.__unsafe===true,
      imageSources:[...document.querySelectorAll('#catalogue-widget-results img[src]')].map(n=>n.getAttribute('src'))};
  })()`);
  for (const kind of ['cover', 'icon']) {
    assert.equal(presentation[kind].loaded, true, kind + ' decodes through the real local protocol');
    assert.equal(presentation[kind].visibleFallback, false);
    assert.match(presentation[kind].src, /^chartshub-companion:\/\/app\/catalogue-artwork\/[a-f0-9]{64}$/);
  }
  assert.equal(presentation.missing.images, 0); assert.equal(presentation.missing.visibleFallback, true);
  for (const kind of ['broken', 'brokenIcon']) { assert.equal(presentation[kind].loaded, false); assert.equal(presentation[kind].src, null); assert.equal(presentation[kind].visibleFallback, true); }
  assert.equal(presentation.charter, 'JoMartineau');
  assert.deepEqual(presentation.segments, [{ text: 'Jo', color: 'rgb(255, 64, 64)' }, { text: 'Mart', color: 'rgb(80, 224, 128)' }, { text: 'ineau', color: 'rgb(96, 156, 255)' }]);
  assert.deepEqual(presentation.instruments, [
    { instrument: 'Guitar', intensity: '2', markers: ['E', 'M', 'H', 'X'].map(label => ({ label, available: true })), svg: true },
    { instrument: 'Drums', intensity: '4', markers: ['E', 'M', 'H', 'X'].map(label => ({ label, available: ['E', 'X'].includes(label) })), svg: true }
  ]);
  assert.deepEqual(presentation.badges, ['Modérateur', 'Charter vérifié']); assert.equal(presentation.otherBadges, 0);
  assert.equal(presentation.game, 'Clone Hero'); assert.equal(presentation.unsafe, false);
  assert.ok(presentation.imageSources.every(src => /^chartshub-companion:\/\/app\/catalogue-artwork\/[a-f0-9]{64}$/.test(src)));
  assert.ok(artworkRequests.includes(charts[0].artworkUrl)); assert.ok(artworkRequests.includes(charts[0].charterIconUrl));
  await click('[data-chart-id="mini-complete"] details.catalogue-card-details > summary');
  await waitFor(() => evaluate("document.querySelector('[data-chart-id=\"mini-complete\"] details.catalogue-card-details').open"), 'French card details open');
  const details = () => evaluate(`(()=>{const n=document.querySelector('[data-chart-id="mini-complete"]');return {open:n.querySelector('details').open,summary:n.querySelector('summary').textContent,values:Object.fromEntries([...n.querySelectorAll('dl>div')].map(pair=>[pair.querySelector('dt').textContent,pair.querySelector('dd').textContent])),badges:[...n.querySelectorAll('.catalogue-staff-badge')].map(b=>b.textContent),instruments:[...n.querySelectorAll('.catalogue-instrument-name')].map(i=>i.textContent)}})()`);
  assert.deepEqual(await details(), { open: true, summary: 'Voir les détails', values: { Album: 'Fixture Album', Année: '2026', Genre: 'Metalcore', Durée: '4:09' }, badges: ['Modérateur', 'Charter vérifié'], instruments: ['Guitare', 'Batterie'] });
  await capture('catalogue-card-french');
  host.setLanguage('en');
  await waitFor(() => evaluate("document.documentElement.lang==='en'&&document.querySelector('[data-chart-id=\"mini-complete\"] summary')?.textContent==='View details'"), 'English card details and badges');
  assert.deepEqual(await details(), { open: true, summary: 'View details', values: { Album: 'Fixture Album', Year: '2026', Genre: 'Metalcore', Length: '4:09' }, badges: ['Moderator', 'Verified Charter'], instruments: ['Guitar', 'Drums'] });
  await capture('catalogue-card-english');
  host.setLanguage('fr'); await waitFor(() => evaluate("document.documentElement.lang==='fr'&&document.querySelector('[data-chart-id=\"mini-complete\"] summary')?.textContent==='Voir les détails'"), 'French card restored');
  passed.push('real local artwork decodes; absent/broken covers keep placeholders; colored charter identity, per-instrument ranks/levels and creator badges remain accurate across French/English');
}
async function verifyResponsiveCards() {
  for (const item of charts.slice(0, 2)) await click(selectionSelector(item.id));
  await selectionIs(charts.slice(0, 2).map(item => item.id));
  const snapshot = await evaluate('window.ChartsHubCompanion.getSnapshot()'), original = snapshot.floatingPanels.appearance.catalogue;
  const resized = await command('panels.appearance', { revision: snapshot.floatingPanels.revision, panel: 'catalogue', appearance: { ...original, fontSize: 24 } });
  assert.equal(resized.ok, true);
  await waitFor(() => evaluate("getComputedStyle(document.querySelector('#catalogue-widget-app')).fontSize==='24px'"), 'maximum supported font size applied');
  const originalMinimum = mini.getMinimumSize();
  try {
    // 390 is the actual native minimum; 320 additionally stresses the CSS only.
    mini.setMinimumSize(320, originalMinimum[1]);
    for (const width of [650, 390, 320]) {
      mini.setSize(width, 880);
      await waitFor(() => evaluate(`window.innerWidth===${width}`), 'widget content width ' + width);
      await evaluate("window.scrollTo({top:0,behavior:'instant'})"); await delay(100);
      const layout = await evaluate(`(()=>{const page=document.documentElement,selectors=['.catalogue-widget-tabs button','.catalogue-card-body','.catalogue-instrument','.catalogue-staff-badge','.catalogue-card-details summary','.floating-catalogue-item button','.catalogue-selection-label','.catalogue-widget-selection button'];return {width:innerWidth,font:getComputedStyle(document.querySelector('#catalogue-widget-app')).fontSize,pageWidth:page.scrollWidth,clientWidth:page.clientWidth,overflow:selectors.flatMap(selector=>[...document.querySelectorAll(selector)].filter(n=>n.getClientRects().length&&n.scrollWidth>n.clientWidth+2).map(n=>({selector,text:n.textContent,width:n.clientWidth,scrollWidth:n.scrollWidth}))),outside:[...document.querySelectorAll('#catalogue-widget-results article')].map(n=>n.getBoundingClientRect()).some(r=>r.left<0||r.right>innerWidth+1)}})()`);
      layouts.push(layout);
      assert.ok(layout.pageWidth <= layout.clientWidth + 2, 'page overflow at width ' + width + ': ' + JSON.stringify(layout));
      assert.deepEqual(layout.overflow, [], 'card/controls overflow at width ' + width); assert.equal(layout.outside, false);
      await capture('catalogue-font24-width' + width);
    }
  } finally {
    mini.setMinimumSize(...originalMinimum); mini.setSize(650, 880);
    const latest = await evaluate('window.ChartsHubCompanion.getSnapshot()');
    assert.equal((await command('panels.appearance', { revision: latest.floatingPanels.revision, panel: 'catalogue', appearance: original })).ok, true);
  }
  await waitFor(() => evaluate(`getComputedStyle(document.querySelector('#catalogue-widget-app')).fontSize===${JSON.stringify(original.fontSize + 'px')}`), 'original font restored');
  await click('#catalogue-widget-clear-selection'); await selectionIs([]);
  passed.push('portrait catalogue cards and controls fit 650/390px and additional 320px CSS stress at the maximum 24px font');
}
async function openHost() {
  host = await createCompanionHost({ dataDirectory, cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({ running: false, sessions: [] }),
    isCatalogueAvailable: () => true, authorizeCatalogue: async () => true,
    catalogueClient: { async load() { catalogueLoads++; return { items: fixtureCharts, revision: 'mini-electron-fixture-' + fixtureRevision, demo: fixtureDemo }; }, async artwork(url) { artworkRequests.push(url); assert.ok(charts.some(item => item.artworkUrl === url || item.charterIconUrl === url), 'only known synthetic catalogue artwork is requested'); return url.includes('/FixtureArtwork00/') ? { bytes: syntheticArtwork(), contentType: 'image/png' } : null; } },
    downloadWorker: worker() });
  panel = await host.open(); await host.setCatalogueWidget(true); mini = host.getCatalogueWidget(); mini.setSize(650, 880);
  await waitFor(() => evaluate("!!window.ChartsHubCompanion&&!document.querySelector('#catalogue-widget-search')?.disabled&&!!document.querySelector('#floating-panels-save')"), 'native mini ready');
}
async function fail(error) {
  if (failing) return; failing = true; console.error(error);
  const report = { result: 'COMPANION_CATALOGUE_WIDGET_FAILED', error: String(error.stack || error), lastWait, passed, layouts, artworkRequests, batchRequests, runs: runs.map(run => ({ id: run.id, settled: run.settled, aborted: run.aborted })) };
  if (mini && !mini.isDestroyed()) {
    try { report.renderer = await evaluate("({language:document.documentElement.lang,body:document.body.innerText.slice(0,14000),active:document.activeElement?.id})"); } catch (_) {}
    try { await capture('failure'); } catch (_) {}
  }
  await fs.mkdir(directory, { recursive: true }).catch(() => {}); await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2)).catch(() => {});
  console.error('Mini catalogue diagnostics: ' + path.join(directory, 'report.json'));
  try { await host?.dispose(); } catch (_) {} dialog.showOpenDialog = originalPicker; app.exit(1);
}
setTimeout(() => void fail(Error('Mini catalogue Electron verification timed out')), 240000).unref();

app.whenReady().then(async () => {
  await fs.mkdir(songs, { recursive: true });
  dialog.showOpenDialog = async owner => { pickerOwners.push(owner); return pickerCancelled ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [pickerTarget] }; };
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
  await search({ charter: 'JoMartineau' }, ['mini-complete']);
  await search({ charter: 'Fixture charter' }, ['mini-cancel']);
  await search({ instrument: 'Guitar', difficulty: 'Expert' }, charts.map(item => item.id));
  assert.equal(catalogueLoads, 1); assert.equal(runs.length, 0);
  assert.deepEqual(await evaluate("Object.fromEntries([...document.querySelectorAll('#catalogue-widget-results article')].map(n=>[n.dataset.chartId,n.querySelector('h3').textContent]))"), Object.fromEntries(charts.map(item => [item.id, item.title])));
  assert.equal(await evaluate("!!document.querySelector('#catalogue-widget-results script,#catalogue-widget-results [onerror]')||window.__unsafe===true"), false);
  await capture('search'); passed.push('title/artist/charter search renders hostile catalogue text inertly and never starts an automatic download');
  await verifyCardPresentation(); await verifyResponsiveCards(); await verifyFavorites(); assert.equal(runs.length, 0);

  await click('[data-chart-id="mini-complete"] .catalogue-download-single'); await waitFor(() => runs.length === 1, 'first synthetic transfer'); const firstId = runs[0].id;
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

  await click('#catalogue-widget-tab-search'); await click('[data-chart-id="mini-cancel"] .catalogue-download-single'); await waitFor(() => runs.length === 3, 'second chart starts'); const secondId = runs[2].id;
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
  await click('#catalogue-widget-tab-search'); await search({ favorites: 'yes' }, ['mini-complete']);
  assert.equal(await evaluate("document.querySelector('.catalogue-favorite').getAttribute('aria-pressed')"), 'true');
  assert.equal(runs.length, 4, 'favorite restoration must not enqueue a chart');
  await capture('favorite-after-restart'); passed.push('favorite filter and pressed state survive the full host restart independently of the queue');
  const related = await verifyInstalled(); await verifyBatch(related);
  for (const id of [firstId, secondId]) assert.equal(await fs.readFile(path.join(songs, `Synthetic-${id}`, 'notes.chart'), 'utf8'), 'synthetic chart content', 'new catalogue actions preserve the already downloaded charts');

  const report = { result: 'COMPANION_CATALOGUE_WIDGET_OK', count: passed.length, passed, layouts, artworkRequests, batchRequests, catalogueLoads, transferRuns: runs.length, directory };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  await host.dispose(); dialog.showOpenDialog = originalPicker; app.exit(0);
}).catch(fail);
