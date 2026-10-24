'use strict';
const {revealWorkspace,registerFixtureMaintenance}=require('./workspace-input.cjs');
registerFixtureMaintenance();
// Real renderer/IPC/worker; only synthetic fixture dialogs and trash are intercepted.
const { app, dialog, shell } = require('electron');
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { registerCompanionScheme, createCompanionHost } = require('../companion/host.cjs');
const directory = path.join(path.resolve(process.argv[2]), 'bulk-' + randomUUID());
const songs = path.join(directory, 'Songs'), dataDirectory = path.join(directory, 'profile');
app.setPath('userData', path.join(directory, 'electron-profile'));
app.disableHardwareAcceleration(); registerCompanionScheme();
const original = { dialog: dialog.showMessageBox, picker: dialog.showOpenDialog, trash: shell.trashItem };
const passed = [], recycled = [], errors = [];
let host, panel, accept = false, confirmations = 0, lastWait = '', failing = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => panel.webContents.executeJavaScript(code);
const command = (name, payload) => evaluate(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`);
async function waitFor(test, label, timeout = 20000) {
  lastWait = label; const until = Date.now() + timeout;
  while (Date.now() < until) { if (await test()) return; await delay(35); }
  throw Error('Timed out: ' + label);
}
async function click(selector) {
    await revealWorkspace(panel, selector);
  await waitFor(() => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return !!n&&!n.disabled&&!n.hidden})()`), selector);
  const point = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)},hit=document.elementFromPoint(p.x,p.y);if(!r.width||!r.height||!(hit===n||n.contains(hit)))throw Error('Covered bulk control');return p})()`);
  panel.focus(); panel.webContents.focus();
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) panel.webContents.sendInputEvent({type, ...point, ...(type === 'mouseMove' ? {} : {button: 'left', clickCount: 1})});
  await delay(45);
}
async function capture(name) { await fs.writeFile(path.join(directory, name + '.png'), (await panel.webContents.capturePage()).toPNG()); }
async function prepare() {
  await click('#library-bulk-cleanup-prepare');
  await waitFor(() => evaluate(`document.querySelector('#library-bulk-cleanup').getAttribute('aria-busy')==='false'&&!document.querySelector('#library-bulk-cleanup-plan').hidden&&document.querySelectorAll('.library-bulk-cleanup-check').length===4`), 'four different copies listed');
  assert.equal(await evaluate(`document.querySelectorAll('.library-bulk-cleanup-check:checked').length`), 0);
  assert.equal(await evaluate(`document.querySelector('#library-bulk-cleanup-recycle').disabled`), true);
}
async function fail(error) {
  if (failing) return; failing = true;
  try { if (panel && !panel.isDestroyed()) await capture('failure'); } catch {}
  await fs.mkdir(directory, {recursive: true});
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify({ok: false, error: String(error.stack || error), lastWait, passed, recycled, confirmations, errors}, null, 2));
  console.error(error);
  try { await host?.dispose(); } catch {}
  app.exit(1);
}
setTimeout(() => void fail(Error('Bulk cleanup verification timed out')), 150000).unref();
app.whenReady().then(async () => {
  const originalFiles = new Map();
  for (const group of ['alpha', 'beta']) for (const [kind, note] of [['keep', 0], ['copy', 1], ['unchecked', 2]]) {
    const folder = path.join(songs, group + '-' + kind); await fs.mkdir(folder, {recursive: true});
    const files = {'song.ini': `[song]\nname = ${group}\nartist = Band\ncharter = Creator\n`, 'notes.chart': `[Song]\n{}\n[ExpertSingle]\n{\n0 = N ${note} 0\n}`, 'song.ogg': 'synthetic audio bytes'};
    for (const [name, bytes] of Object.entries(files)) { const file = path.join(folder, name); await fs.writeFile(file, bytes); originalFiles.set(file, bytes); }
  }
  dialog.showOpenDialog = async () => ({canceled: false, filePaths: [songs]});
  dialog.showMessageBox = async (_owner, options) => {
    confirmations++;
    assert.match(options.title, /^(Supprimer les versions différentes sélectionnées \?|Delete the selected different versions\?)$/);
    assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0);
    for (const name of ['alpha-keep', 'beta-keep', 'alpha-copy', 'beta-copy']) assert.ok(options.detail.includes(name));
    assert.doesNotMatch(options.detail, /alpha-unchecked|beta-unchecked/); assert.match(options.detail, /notes/i);
    return {response: accept ? 1 : 0};
  };
  shell.trashItem = async target => {
    const relative = path.relative(songs, target);
    assert.ok(['alpha-copy', 'beta-copy'].includes(relative), 'only explicitly selected synthetic copies may reach trash');
    assert.equal(path.resolve(target), path.join(songs, relative)); assert.equal((await fs.lstat(target)).isSymbolicLink(), false);
    const bin = path.join(directory, 'fake-bin'); await fs.mkdir(bin, {recursive: true});
    await fs.rename(target, path.join(bin, relative)); recycled.push(relative);
  };
  host = await createCompanionHost({dataDirectory, cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({running: false, sessions: []}),
    catalogueClient: {async load() {return {items: [], revision: 'bulk-fixture', demo: false};}, async artwork() {throw Error('No fixture network');}},
    downloadWorker: {async run() {throw Error('No fixture downloads');}, async discard() {}, async resolveCompleted() {return null;}}});
  panel = await host.open(); panel.setSize(1250, 1000);
  panel.webContents.on('console-message', (_event, level, message) => {if (level >= 3) errors.push(message);});
  await waitFor(() => evaluate(`!!window.ChartsHubCompanion&&!!document.querySelector('#library-bulk-cleanup-prepare')`), 'bulk controls ready');
  assert.equal((await command('library.settings', {watch: false, refreshOnStart: false})).ok, true);
  await click('#library-choose-root');
  await waitFor(() => host.snapshot().library.status === 'ready' && host.snapshot().library.count === 6, 'six songs scanned');
  const revision = host.snapshot().library.revision, lastScanAt = host.snapshot().library.lastScanAt;
  const queried = await command('library.query', {query: '', sort: 'title', audio: 'all', duplicates: 'possible', offset: 0, limit: 50});
  assert.equal(queried.ok, true); const rows = queried.result.items;
  for (const group of ['alpha', 'beta']) {
    const keeper = rows.find(row => row.relativePath === group + '-keep/notes.chart');
    const comparison = await command('library.compareDuplicates', {id: keeper.id, revision}); assert.equal(comparison.ok, true);
    assert.equal((await command('library.chooseDuplicate', {contextId: comparison.result.contextId, revision, id: keeper.id})).ok, true);
  }
  await prepare();
  assert.equal(await evaluate(`document.querySelectorAll('#library-bulk-cleanup-candidates .library-file-differences[open]').length`), 4);
  await click('#library-bulk-cleanup-select-all');
  assert.equal(await evaluate(`document.querySelectorAll('.library-bulk-cleanup-check:checked').length`), 4);
  await click('#library-bulk-cleanup-clear');
  assert.equal(await evaluate(`document.querySelectorAll('.library-bulk-cleanup-check:checked').length`), 0);
  passed.push('different notes from two groups are listed with their protected keepers; individual checkboxes start empty and select-all/clear require native clicks');
  const ids = ['alpha', 'beta'].map(group => rows.find(row => row.relativePath === group + '-copy/notes.chart').id);
  for (const id of ids) await click(`.library-bulk-cleanup-check[data-cleanup-id="${id}"]`);
  await capture('bulk-selection');
  await click('#library-bulk-cleanup-recycle');
  await waitFor(() => confirmations === 1 && host.snapshot().library.bulkCleanup === null && evaluate(`document.querySelector('#library-bulk-cleanup').getAttribute('aria-busy')==='false'`), 'cancelled native confirmation settled');
  assert.deepEqual(recycled, []); assert.equal(host.snapshot().library.count, 6); assert.equal(host.snapshot().library.revision, revision);
  for (const [file, bytes] of originalFiles) assert.equal(await fs.readFile(file, 'utf8'), bytes);
  passed.push('the single native batch dialog defaults to Cancel, names only selected copies and their keepers, and cancellation preserves all six folders');
  await prepare(); for (const id of ids) await click(`.library-bulk-cleanup-check[data-cleanup-id="${id}"]`);
  accept = true; await click('#library-bulk-cleanup-recycle');
  await waitFor(() => confirmations === 2 && host.snapshot().library.count === 4 && evaluate(`document.querySelector('#library-bulk-cleanup').getAttribute('aria-busy')==='false'&&!document.querySelector('#library-bulk-cleanup-result').hidden`), 'batch success visible');
  assert.deepEqual(recycled.sort(), ['alpha-copy', 'beta-copy']);
  assert.equal(host.snapshot().library.revision, revision + 1); assert.equal(host.snapshot().library.lastScanAt, lastScanAt);
  assert.equal(host.snapshot().library.cleanupRefreshPending, true);
  for (const [file, bytes] of originalFiles) if (!['alpha-copy', 'beta-copy'].includes(path.basename(path.dirname(file)))) assert.equal(await fs.readFile(file, 'utf8'), bytes);
  assert.equal(await evaluate(`document.querySelector('#library-refresh').textContent`), 'Actualiser à la fin');
  await capture('bulk-success');
  passed.push('one accepted confirmation recycles exactly two selected copies across groups, preserves both keepers and both unchecked versions, commits one revision and defers the scan');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify({ok: true, passed, confirmations, recycled, errors}, null, 2));
  await host.dispose(); host = null;
  dialog.showMessageBox = original.dialog; dialog.showOpenDialog = original.picker; shell.trashItem = original.trash;
  console.log(JSON.stringify({ok: true, checks: passed.length, directory})); app.exit(0);
}).catch(fail);
