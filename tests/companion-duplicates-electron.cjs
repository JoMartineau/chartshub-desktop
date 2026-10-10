'use strict';
// Run with Electron after build:companion. Every file is synthetic and contained
// in this run's fixture. Native dialog/bin boundaries are intercepted; the real
// renderer, IPC, worker, scanner, verification and persistence all run normally.
const { app, dialog, shell } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { registerCompanionScheme, createCompanionHost } = require('../companion/host.cjs');

const output = path.resolve(process.argv[2] || path.join(__dirname, '../../companion-duplicates-verification'));
const directory = path.join(output, 'duplicates-' + randomUUID());
const dataDirectory = path.join(directory, 'profile');
app.setPath('userData', path.join(directory, 'electron-profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // Keep the process alive for the host restart assertion.
registerCompanionScheme();
const originalDialog = dialog.showMessageBox, originalPicker = dialog.showOpenDialog, originalTrash = shell.trashItem;
const passed = [], recycled = [], confirmations = [];
let host, panel, activeRoot, dialogAction = async () => 0, nativeError = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(35); }
  throw Error('Timed out: ' + label);
}
const evaluate = code => panel.webContents.executeJavaScript(code);
const command = (name, payload) => evaluate(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`);
async function click(selector) {
  await waitFor(() => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return !!n&&!n.disabled&&!n.hidden})()`), 'enabled control ' + selector);
  const point = await evaluate(`(()=>{
    const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'center',inline:'nearest'});
    const r=n.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)},hit=document.elementFromPoint(p.x,p.y);
    if(!r.width||!r.height||!hit||!(hit===n||n.contains(hit)))throw Error('Duplicate control hidden or covered: '+${JSON.stringify(selector)});
    return p;
  })()`);
  panel.focus(); panel.webContents.focus();
  panel.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  panel.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  panel.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  await delay(40);
}
async function openHost() {
  host = await createCompanionHost({
    dataDirectory, cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({ running: false, sessions: [] }),
    catalogueClient: { async load() { return { items: [], revision: 'duplicates-fixture', demo: false }; }, async artwork() { throw Error('No network in fixture'); } },
    downloadWorker: { async run() { throw Error('No downloads in fixture'); }, async discard() {}, async resolveCompleted() { return null; } }
  });
  panel = await host.open(); panel.setSize(1250, 1000);
  await waitFor(() => evaluate("!!window.ChartsHubCompanion&&!!document.querySelector('#library-choose-root')"), 'Companion ready');
  assert.equal((await command('library.settings', { watch: false, refreshOnStart: false })).ok, true);
}
const files = { 'notes.chart': '[Song]\n{\n Name = "Fixture duplicates"\n Artist = "Fixture artist"\n Charter = "Fixture charter"\n}\n[ExpertSingle]\n{\n 0 = N 0 0\n}\n', 'song.ini': '[song]\nname=Fixture duplicates\nartist=Fixture artist\ncharter=Fixture charter\n', 'song.ogg': 'synthetic audio bytes - original' };
async function fixture(name, afterScan) {
  activeRoot = path.join(directory, name, 'Songs');
  for (const folder of ['A-unchecked', 'B-kept', 'C-selected']) {
    const target = path.join(activeRoot, folder); await fs.mkdir(target, { recursive: true });
    for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(target, file), content);
  }
  await click('#library-choose-root');
  await waitFor(() => host.snapshot().library.settings.rootPath === activeRoot && host.snapshot().library.status === 'ready' && host.snapshot().library.count === 3, name + ' scan');
  await waitFor(() => evaluate("document.querySelector('#library-results').getAttribute('aria-busy')==='false'&&document.querySelectorAll('#library-rows tr').length===3"), 'fixture rows');
  await afterScan?.(activeRoot);
  await openComparison(3);
  assert.equal(await evaluate("document.querySelectorAll('.library-variant.is-preferred').length"), 0);
  assert.equal(await evaluate("document.querySelector('#library-cleanup-prepare').hidden"), true, 'cleanup requires an explicit keeper');
  const ids = await evaluate("Object.fromEntries([...document.querySelectorAll('.library-variant')].map(n=>[n.querySelector('.library-variant-path').textContent.split('/')[0],n.dataset.variantId]))");
  await click(`.library-variant[data-variant-id="${ids['B-kept']}"] .library-variant-choose`);
  await waitFor(() => evaluate(`document.querySelector('.library-variant.is-preferred')?.dataset.variantId===${JSON.stringify(ids['B-kept'])}`), 'explicit second version kept');
  return { root: activeRoot, ids, keepId: ids['B-kept'], selectedId: ids['C-selected'], uncheckedId: ids['A-unchecked'] };
}
async function openComparison(count) {
  if (!await evaluate("document.querySelector('#library-comparison').hidden")) await click('#library-comparison-close');
  await click('#library-rows .library-compare');
  await waitFor(() => evaluate(`!document.querySelector('#library-comparison').hidden&&document.querySelector('#library-comparison').getAttribute('aria-busy')==='false'&&document.querySelectorAll('.library-variant').length===${count}`), 'duplicate comparison');
}
async function prepare(f, select = true) {
  await click('#library-cleanup-prepare');
  await waitFor(() => evaluate("!document.querySelector('#library-cleanup-plan').hidden&&document.querySelector('#library-comparison').getAttribute('aria-busy')==='false'"), 'verified cleanup plan');
  assert.equal(await evaluate("document.querySelectorAll('.library-cleanup-check:checked').length"), 0, 'no copy is preselected');
  assert.equal(await evaluate("document.querySelector('#library-cleanup-recycle').disabled"), true);
  assert.equal(await evaluate(`!!document.querySelector('.library-cleanup-check[data-cleanup-id="${f.keepId}"]')`), false, 'keeper never has a deletion checkbox');
  if (select) {
    await click(`.library-cleanup-check[data-cleanup-id="${f.selectedId}"]`);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.library-cleanup-check:checked')].map(n=>n.dataset.cleanupId)"), [f.selectedId]);
    const summary = await evaluate("document.querySelector('#library-cleanup-summary').textContent");
    assert.match(summary, /C-selected/); assert.doesNotMatch(summary, /A-unchecked|B-kept/);
  }
}
async function intact(f, names = ['A-unchecked', 'B-kept', 'C-selected']) {
  for (const name of names) for (const [file, content] of Object.entries(files)) assert.equal(await fs.readFile(path.join(f.root, name, file), 'utf8'), content);
}
async function recycleAndSettle() {
  await click('#library-cleanup-recycle');
  await waitFor(() => evaluate("document.querySelector('#library-comparison').getAttribute('aria-busy')==='false'&&document.querySelector('#library-cleanup-plan').hidden"), 'recycle operation finished');
  await waitFor(() => host.snapshot().library.status !== 'scanning', 'post-recycle scan');
}
async function forgedPlan(f) {
  const comparison = await command('library.compareDuplicates', { id: f.keepId, revision: host.snapshot().library.revision });
  assert.equal(comparison.ok, true);
  const plan = await command('library.prepareCleanup', { contextId: comparison.result.contextId, revision: comparison.result.revision, keepId: f.keepId });
  assert.equal(plan.ok, true); return plan.result;
}
async function capture(name) { await fs.writeFile(path.join(directory, name + '.png'), (await panel.webContents.capturePage()).toPNG()); }
async function fail(error) {
  console.error(error);
  try { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'failure.txt'), String(error.stack || error)); if (panel && !panel.isDestroyed()) await capture('failure'); } catch {}
  try { await host?.dispose(); } catch {}
  dialog.showMessageBox = originalDialog; dialog.showOpenDialog = originalPicker; shell.trashItem = originalTrash;
  app.exit(1);
}
setTimeout(() => void fail(Error('Duplicate Electron verification timed out')), 150000).unref();

app.whenReady().then(async () => {
  await fs.mkdir(directory, { recursive: true });
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [activeRoot] });
  dialog.showMessageBox = async (_owner, options) => {
    assert.match(options.title, /Corbeille|Recycle Bin/);
    assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0);
    confirmations.push(structuredClone(options)); return { response: await dialogAction(options) };
  };
  shell.trashItem = async target => {
    // The test can only move the one explicitly selected synthetic fixture.
    assert.equal(path.resolve(target), path.join(activeRoot, 'C-selected'));
    assert.equal(path.relative(directory, activeRoot).startsWith('..'), false);
    assert.equal((await fs.lstat(target)).isSymbolicLink(), false);
    if (nativeError) throw Error('Synthetic native Recycle Bin unavailable');
    const bin = path.join(directory, 'fake-bin', randomUUID()); await fs.mkdir(bin, { recursive: true });
    await fs.rename(target, path.join(bin, 'C-selected')); recycled.push(target);
  };
  await openHost();
  let f = await fixture('selection-cancel');
  await prepare(f);
  await click(`.library-variant[data-variant-id="${f.selectedId}"] .library-variant-choose`);
  await waitFor(() => evaluate(`document.querySelector('.library-variant.is-preferred')?.dataset.variantId===${JSON.stringify(f.selectedId)}&&document.querySelector('#library-cleanup-plan').hidden`), 'previously selected copy becomes protected keeper');
  await prepare({ ...f, keepId: f.selectedId }, false);
  await click(`.library-variant[data-variant-id="${f.keepId}"] .library-variant-choose`);
  await waitFor(() => evaluate(`document.querySelector('.library-variant.is-preferred')?.dataset.variantId===${JSON.stringify(f.keepId)}`), 'explicit keeper restored');
  await prepare(f); await capture('selected-copy-summary');
  passed.push('changing keeper clears the old deletion selection and protects the newly kept version');
  dialogAction = async options => {
    assert.match(options.detail, /B-kept/); assert.match(options.detail, /C-selected/);
    assert.doesNotMatch(options.detail, /A-unchecked/); return 0;
  };
  await recycleAndSettle(); assert.equal(recycled.length, 0); await intact(f);
  assert.match(await evaluate("document.querySelector('#library-cleanup-result').textContent"), /annul|cancel/i);
  passed.push('explicit keeper and individual partial selection; clear selected-path summary; final cancellation leaves all files intact');
  await openComparison(3);
  assert.equal(await evaluate("document.querySelector('.library-variant.is-preferred').dataset.variantId"), f.keepId);
  await prepare(f, false);
  passed.push('reopened comparison restores saved keeper and resets deletion selection');

  await click('#library-comparison-close');
  const beforeBulkDialogs = confirmations.length;
  await click('#library-verify-all-duplicates');
  await waitFor(() => evaluate("!document.querySelector('#library-verify-all-duplicates').disabled&&document.querySelector('#library-verify-all-status').textContent.includes('2 copie(s) vérifiée(s)')"), 'global duplicate verification completes through worker IPC');
  assert.equal(await evaluate("document.querySelector('#library-verify-all-status').classList.contains('is-error')"), false);
  assert.match(await evaluate("document.querySelector('#library-verify-all-status').textContent"), /1 groupe\(s\) prêt\(s\).*0 choix de version requis.*0 bloqué\(s\)/);
  assert.equal(confirmations.length, beforeBulkDialogs); assert.equal(recycled.length, 0); await intact(f);
  await openComparison(3); await prepare(f, false);
  assert.equal(await evaluate("document.querySelector('.library-variant.is-preferred').dataset.variantId"), f.keepId);
  passed.push('global verification button completes via the worker and retains keeper without dialogs, recycling or automatically selected copies');

  const plan = await forgedPlan(f), beforeDialogs = confirmations.length;
  for (const ids of [[f.keepId], [f.selectedId, f.keepId], ['../outside/notes.chart']]) {
    assert.equal((await command('library.recycleDuplicates', { planId: plan.planId, revision: plan.revision, ids })).ok, false);
  }
  assert.equal((await command('library.recycleDuplicates', { planId: plan.planId, revision: plan.revision, ids: [f.selectedId], target: path.join(directory, 'outside') })).ok, false);
  assert.equal(confirmations.length, beforeDialogs); assert.equal(recycled.length, 0); await intact(f);
  passed.push('forged IPC cannot select the keeper, mix it with a copy, or supply a path outside Songs');

  f = await fixture('changed-notes-after-scan');
  await fs.appendFile(path.join(f.root, 'C-selected', 'notes.chart'), '\n// changed since scan\n');
  await prepare(f, false);
  assert.equal(await evaluate(`document.querySelector('.library-cleanup-check[data-cleanup-id="${f.selectedId}"]').disabled`), true);
  assert.equal(recycled.length, 0); await intact(f, ['A-unchecked', 'B-kept']);
  passed.push('notes changed since scan are excluded from cleanup');

  f = await fixture('changed-audio-before-comparison', async root => {
    const file = path.join(root, 'C-selected', 'song.ogg'), stat = await fs.stat(file);
    await fs.writeFile(file, files['song.ogg'].replace('original', 'modified'));
    await fs.utimes(file, stat.atime, stat.mtime);
  });
  await prepare(f, false);
  assert.equal(await evaluate(`document.querySelector('.library-cleanup-check[data-cleanup-id="${f.selectedId}"]').disabled`), true);
  assert.equal(await evaluate(`!!document.querySelector('.library-cleanup-candidate[data-cleanup-id="${f.selectedId}"] .library-cleanup-force')`), false);
  assert.equal(recycled.length, 0); await intact(f, ['A-unchecked', 'B-kept']);
  passed.push('audio changed between the scan and comparison remains blocked, including the manual differing-copy action');

  f = await fixture('changed-audio-during-confirmation'); await prepare(f);
  dialogAction = async () => {
    const file = path.join(f.root, 'C-selected', 'song.ogg'), stat = await fs.stat(file);
    await fs.writeFile(file, files['song.ogg'].replace('original', 'modified'));
    await fs.utimes(file, stat.atime, stat.mtime); return 1;
  };
  await recycleAndSettle(); assert.equal(recycled.length, 0); await intact(f, ['A-unchecked', 'B-kept']);
  assert.equal(await fs.readFile(path.join(f.root, 'C-selected', 'song.ogg'), 'utf8'), files['song.ogg'].replace('original', 'modified'));
  passed.push('same-size audio changed while final confirmation is open is rechecked and never recycled');

  f = await fixture('changed-keeper-during-confirmation'); await prepare(f);
  dialogAction = async () => { await fs.appendFile(path.join(f.root, 'B-kept', 'notes.chart'), '\n// changed keeper\n'); return 1; };
  await recycleAndSettle(); assert.equal(recycled.length, 0); await intact(f, ['A-unchecked', 'C-selected']);
  passed.push('changing keeper notes during confirmation protects every selected copy');

  f = await fixture('junction-during-confirmation'); await prepare(f);
  const outside = path.join(directory, 'synthetic-outside-Songs');
  dialogAction = async () => {
    await fs.rename(path.join(f.root, 'C-selected'), outside);
    await fs.symlink(outside, path.join(f.root, 'C-selected'), process.platform === 'win32' ? 'junction' : 'dir'); return 1;
  };
  await recycleAndSettle(); assert.equal(recycled.length, 0); await intact(f, ['A-unchecked', 'B-kept']);
  assert.equal((await fs.lstat(path.join(f.root, 'C-selected'))).isSymbolicLink(), true);
  for (const [file, content] of Object.entries(files)) assert.equal(await fs.readFile(path.join(outside, file), 'utf8'), content);
  passed.push('a target replaced by a junction/symlink at confirmation is refused; external synthetic files stay untouched');

  f = await fixture('ambiguous-target');
  await fs.mkdir(path.join(f.root, 'C-selected', 'another-chart'));
  await fs.writeFile(path.join(f.root, 'C-selected', 'another-chart', 'notes.chart'), files['notes.chart']);
  await prepare(f, false);
  assert.equal(await evaluate(`document.querySelector('.library-cleanup-check[data-cleanup-id="${f.selectedId}"]').disabled`), true);
  assert.equal(recycled.length, 0);
  passed.push('ambiguous folder containing another chart is blocked');

  f = await fixture('native-bin-failure'); await prepare(f);
  dialogAction = async () => 1; nativeError = true;
  await recycleAndSettle(); nativeError = false; assert.equal(recycled.length, 0); await intact(f);
  passed.push('native Recycle Bin failure preserves all files with no permanent-deletion fallback');

  f = await fixture('partial-success'); await prepare(f);
  dialogAction = async () => 1;
  await recycleAndSettle();
  assert.deepEqual(recycled, [path.join(f.root, 'C-selected')]);
  await intact(f, ['A-unchecked', 'B-kept']);
  await assert.rejects(fs.stat(path.join(f.root, 'C-selected')), { code: 'ENOENT' });
  assert.equal(host.snapshot().library.count, 2);
  assert.match(await evaluate("document.querySelector('#library-cleanup-result').textContent"), /1 copie\(s\).*Corbeille Windows.*B-kept/);
  await waitFor(() => evaluate("(()=>{const n=document.querySelector('#library-cleanup-result'),r=n.getBoundingClientRect();return !n.hidden&&r.height>0&&r.top>=0&&r.bottom<=window.innerHeight})()"), 'cleanup outcome stays visible after comparison collapses');
  await capture('partial-success');
  passed.push('successful native-bin dispatch moves exactly the checked copy and refreshes index; keeper and unchecked copy remain byte-identical');

  await host.dispose(); host = null; panel = null;
  await openHost();
  await waitFor(() => host.snapshot().library.status === 'ready' && host.snapshot().library.count === 2, 'persisted library on new host');
  await openComparison(2);
  assert.equal(await evaluate("document.querySelector('.library-variant.is-preferred').dataset.variantId"), f.keepId);
  await prepare(f, false);
  passed.push('keeper preference persists through host/worker restart after partial cleanup; remaining copy stays unchecked');
  await host.dispose(); host = null;
  dialog.showMessageBox = originalDialog; dialog.showOpenDialog = originalPicker; shell.trashItem = originalTrash;
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify({ result: 'COMPANION_DUPLICATES_VERIFIED', passed, nativeBin: 'intercepted only for synthetic fixture', confirmations: confirmations.length, recycled }, null, 2));
  console.log(JSON.stringify({ result: 'COMPANION_DUPLICATES_VERIFIED', checks: passed.length, directory }));
  app.exit(0);
}).catch(fail);
