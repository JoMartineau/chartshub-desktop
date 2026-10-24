'use strict';
const {revealWorkspace,registerFixtureMaintenance}=require('./workspace-input.cjs');
registerFixtureMaintenance();
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
let host, panel, activeRoot, dialogAction = async () => 0, nativeError = false, lastWait = null, failing = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 15000) {
  lastWait = label;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(35); }
  throw Error('Timed out: ' + label);
}
const evaluate = code => panel.webContents.executeJavaScript(code);
const command = (name, payload) => evaluate(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`);
async function click(selector) {
    await revealWorkspace(panel, selector);
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
async function fixture(name, afterScan, beforeScan) {
  activeRoot = path.join(directory, name, 'Songs');
  for (const folder of ['A-unchecked', 'B-kept', 'C-selected']) {
    const target = path.join(activeRoot, folder); await fs.mkdir(target, { recursive: true });
    for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(target, file), content);
  }
  await beforeScan?.(activeRoot);
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
  await assertUnselectedPlan(f.keepId);
  if (select) {
    await click(`.library-cleanup-check[data-cleanup-id="${f.selectedId}"]`);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.library-cleanup-check:checked')].map(n=>n.dataset.cleanupId)"), [f.selectedId]);
    const summary = await evaluate("document.querySelector('#library-cleanup-summary').textContent");
    assert.match(summary, /C-selected/); assert.doesNotMatch(summary, /A-unchecked|B-kept/);
  }
}
async function assertUnselectedPlan(keepId) {
  assert.equal(await evaluate("document.querySelectorAll('.library-cleanup-check:checked').length"), 0, 'no copy is preselected');
  assert.equal(await evaluate("document.querySelector('#library-cleanup-recycle').disabled"), true);
  assert.equal(await evaluate(`!!document.querySelector('.library-cleanup-check[data-cleanup-id="${keepId}"]')`), false, 'keeper never has a deletion checkbox');
}
async function intact(f, names = ['A-unchecked', 'B-kept', 'C-selected']) {
  for (const name of names) for (const [file, content] of Object.entries(files)) assert.equal(await fs.readFile(path.join(f.root, name, file), 'utf8'), content);
}
async function recycleAndSettle(selector = '#library-cleanup-recycle') {
  const beforeConfirmations = confirmations.length;
  await click(selector);
  await waitFor(() => confirmations.length === beforeConfirmations + 1, 'recycle confirmation opened');
  await waitFor(() => evaluate("document.querySelector('#library-comparison').getAttribute('aria-busy')==='false'&&!document.querySelector('#library-comparison-close').disabled&&!document.querySelector('#library-cleanup-result').hidden&&document.querySelector('#library-results').getAttribute('aria-busy')==='false'"), 'recycle operation and refreshed comparison finished');
  await waitFor(() => host.snapshot().library.status !== 'scanning', 'post-recycle index update');
}
async function forgedPlan(f) {
  const comparison = await command('library.compareDuplicates', { id: f.keepId, revision: host.snapshot().library.revision });
  assert.equal(comparison.ok, true);
  const plan = await command('library.prepareCleanup', { contextId: comparison.result.contextId, revision: comparison.result.revision, keepId: f.keepId });
  assert.equal(plan.ok, true); return plan.result;
}
async function capture(name) { await fs.writeFile(path.join(directory, name + '.png'), (await panel.webContents.capturePage()).toPNG()); }
async function cleanupHistory() {
  const response = await command('library.cleanupHistory', { offset: 0, limit: 10 });
  assert.equal(response.ok, true); return response.result;
}
async function showHistory(expectedStatus) {
  if (await evaluate("document.querySelector('#library-cleanup-history-body').hidden")) await click('#library-cleanup-history-toggle');
  else await click('#library-cleanup-history-refresh');
  await waitFor(() => evaluate(`document.querySelectorAll('.library-cleanup-history-entry').length===1&&!!document.querySelector('[data-history-status="${expectedStatus}"]')`), 'history shows ' + expectedStatus);
  const text = await evaluate("document.querySelector('.library-cleanup-history-entry').textContent");
  assert.match(text, /B-kept/); assert.match(text, /C-selected/); assert.doesNotMatch(text, /A-unchecked/);
}
async function fail(error) {
  if (failing) return;
  failing = true;
  console.error(error);
  const report = { result: 'COMPANION_DUPLICATES_FAILED', error: String(error.stack || error), lastWait, activeRoot, passed, recycled, confirmations, library: host?.snapshot().library ?? null };
  if (panel && !panel.isDestroyed()) {
    try {
      report.renderer = await Promise.race([evaluate(`(()=>{
        const selectors=['#library-comparison','#library-comparison-feedback','#library-comparison-summary','#library-cleanup-prepare','#library-cleanup-plan','#library-cleanup-recycle','#library-cleanup-result','#library-verify-all-status','#library-feedback','#library-error'];
        return {url:location.href,readyState:document.readyState,activeElement:document.activeElement?.id,scrollY,scrollHeight:document.documentElement.scrollHeight,workspace:document.querySelector('#companion-app')?.dataset.workspace,viewport:{width:innerWidth,height:innerHeight},
          controls:Object.fromEntries(selectors.map(selector=>{const n=document.querySelector(selector),r=n?.getBoundingClientRect();return [selector,n?{hidden:n.hidden,disabled:n.disabled,busy:n.getAttribute('aria-busy'),rect:{top:r.top,bottom:r.bottom,height:r.height},text:n.textContent.trim().slice(0,2000)}:null]})),
          variants:[...document.querySelectorAll('.library-variant')].map(n=>({id:n.dataset.variantId,preferred:n.classList.contains('is-preferred'),path:n.querySelector('.library-variant-path')?.textContent})),
          candidates:[...document.querySelectorAll('.library-cleanup-check')].map(n=>({id:n.dataset.cleanupId,checked:n.checked,disabled:n.disabled}))};
      })()`), delay(2000).then(() => ({ unavailable: 'renderer diagnostics timed out' }))]);
    } catch (failure) { report.renderer = { unavailable: String(failure) }; }
    try { await Promise.race([capture('failure'), delay(2000)]); } catch {}
  }
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'failure.txt'), report.error);
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(directory, 'failure.json'), JSON.stringify(report, null, 2));
    console.error('Duplicate verification diagnostics: ' + path.join(directory, 'failure.json'));
  } catch (failure) { console.error('Could not write diagnostics: ' + failure); }
  try { await host?.dispose(); } catch {}
  dialog.showMessageBox = originalDialog; dialog.showOpenDialog = originalPicker; shell.trashItem = originalTrash;
  app.exit(1);
}
setTimeout(() => void fail(Error('Duplicate Electron verification timed out')), 150000).unref();

app.whenReady().then(async () => {
  await fs.mkdir(directory, { recursive: true });
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [activeRoot] });
  dialog.showMessageBox = async (_owner, options) => {
    assert.match(options.title, /^(?:Envoyer les copies à la Corbeille Windows|Send copies to Windows Recycle Bin|Supprimer quand même cette copie \?|Delete this copy anyway\?)$/);
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
  // Choosing a keeper automatically prepares its new plan. The old plan's
  // hidden state is transient and may already have passed on a fast runner.
  await waitFor(() => evaluate(`document.querySelector('.library-variant.is-preferred')?.dataset.variantId===${JSON.stringify(f.selectedId)}&&document.querySelector('#library-comparison').getAttribute('aria-busy')==='false'&&!document.querySelector('#library-cleanup-plan').hidden`), 'previously selected copy becomes protected keeper with a ready plan');
  await assertUnselectedPlan(f.selectedId);
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
  assert.equal((await cleanupHistory()).total, 0, 'cancelling confirmation records no cleanup attempt');
  passed.push('explicit keeper and individual partial selection; clear selected-path summary; final cancellation leaves all files intact');
  await openComparison(3);
  assert.equal(await evaluate("document.querySelector('.library-variant.is-preferred').dataset.variantId"), f.keepId);
  await prepare(f, false);
  passed.push('reopened comparison restores saved keeper and resets deletion selection');

  // Exercise the real no-cleanup action with an existing deletion selection.
  // A visible label alone cannot prove that the preference and plan were cleared.
  await click(`.library-cleanup-check[data-cleanup-id="${f.selectedId}"]`);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.library-cleanup-check:checked')].map(n=>n.dataset.cleanupId)"), [f.selectedId]);
  const beforeKeepAllDialogs = confirmations.length, beforeKeepAllRecycled = recycled.length;
  const preferenceFile = path.join(dataDirectory, 'library-duplicate-choices.json');
  const keptPreferences = JSON.parse(await fs.readFile(preferenceFile, 'utf8'));
  assert.deepEqual(Object.values(keptPreferences.choices).map(choice => choice.id), [f.keepId]);
  assert.equal(await evaluate("document.querySelector('#library-comparison-clear').textContent.trim()"), 'Conserver toutes les versions');
  await click('#library-comparison-clear');
  await waitFor(() => evaluate("document.querySelector('#library-comparison').getAttribute('aria-busy')==='false'&&document.querySelectorAll('.library-variant.is-preferred').length===0&&document.querySelector('#library-comparison-clear').hidden&&document.querySelector('#library-cleanup-plan').hidden"), 'keep-all action clears the keeper and its cleanup plan');
  assert.equal(await evaluate("document.querySelectorAll('.library-cleanup-check').length"), 0);
  assert.equal(await evaluate("document.querySelectorAll('.library-cleanup-check:checked').length"), 0);
  assert.equal(await evaluate("document.querySelector('#library-cleanup-recycle').disabled"), true);
  assert.match(await evaluate("document.querySelector('#library-comparison-feedback').textContent"), /Toutes les versions sont conservées/);
  assert.deepEqual(JSON.parse(await fs.readFile(preferenceFile, 'utf8')).choices, {}, 'keep-all removes the persisted keeper preference');
  assert.equal(Object.keys(JSON.parse(await fs.readFile(preferenceFile, 'utf8')).keptGroups).length, 1, 'keep-all persists the exact retained group');
  const possibleKept = await command('library.query', { query: '', sort: 'title', audio: 'all', duplicates: 'possible', offset: 0, limit: 50 });
  assert.equal(possibleKept.ok, true); assert.equal(possibleKept.result.total, 0, 'the retained group is no longer a possible duplicate to clean');
  const ordinaryKept = await command('library.query', { query: '', sort: 'title', audio: 'all', duplicates: 'all', offset: 0, limit: 50 });
  assert.equal(ordinaryKept.ok, true); assert.equal(ordinaryKept.result.total, 3, 'every retained version remains in the ordinary library');
  const verifyKept = await command('library.verifyAllDuplicates', {});
  assert.equal(verifyKept.ok, true); assert.equal(verifyKept.result.totalGroups, 0, 'global verification skips the retained group');
  await host.dispose(); host = null; panel = null; await openHost();
  await waitFor(() => host.snapshot().library.status === 'ready' && host.snapshot().library.count === 3, 'retained group on new host');
  const restoredKept = await command('library.query', { query: '', sort: 'title', audio: 'all', duplicates: 'possible', offset: 0, limit: 50 });
  assert.equal(restoredKept.ok, true); assert.equal(restoredKept.result.total, 0, 'the retained group stays out of duplicates after host and worker restart');
  await openComparison(3);
  assert.equal(await evaluate("document.querySelectorAll('.library-variant.is-preferred').length"), 0, 'a fresh comparison does not restore the cleared keeper');
  assert.equal(await evaluate("document.querySelector('#library-cleanup-plan').hidden"), true);
  assert.equal(await evaluate("document.querySelector('#library-cleanup-prepare').hidden"), true);
  assert.equal(await evaluate("document.querySelectorAll('.library-cleanup-check').length"), 0, 'keeping all versions never creates a deletion selection');
  assert.equal(confirmations.length, beforeKeepAllDialogs); assert.equal(recycled.length, beforeKeepAllRecycled);
  assert.equal((await cleanupHistory()).total, 0); await intact(f);
  await click(`.library-variant[data-variant-id="${f.keepId}"] .library-variant-choose`);
  await waitFor(() => evaluate(`document.querySelector('.library-variant.is-preferred')?.dataset.variantId===${JSON.stringify(f.keepId)}&&document.querySelector('#library-comparison').getAttribute('aria-busy')==='false'&&!document.querySelector('#library-cleanup-plan').hidden`), 'explicit keeper restored after keeping all versions');
  await assertUnselectedPlan(f.keepId);
  assert.deepEqual(Object.values(JSON.parse(await fs.readFile(preferenceFile, 'utf8')).choices).map(choice => choice.id), [f.keepId]);
  assert.equal(confirmations.length, beforeKeepAllDialogs); assert.equal(recycled.length, beforeKeepAllRecycled); await intact(f);
  passed.push('keep-all preserves every version and persists across host and worker restart; possible duplicates and global verification skip the group, while a new explicit keeper can reactivate cleanup safely');

  await click('#library-comparison-close');
  const beforeBulkDialogs = confirmations.length;
  await click('#library-verify-all-duplicates');
  let verifiedPage;
  await waitFor(async () => {
    const summary = host.snapshot().library;
    if (summary.status !== 'ready' || summary.duplicateVerification !== null) return false;
    if (!await evaluate("!document.querySelector('#library-verify-all-duplicates').disabled&&document.querySelector('#library-cancel-duplicate-verification').hidden&&document.querySelector('#library-results').getAttribute('aria-busy')==='false'&&!document.querySelector('#library-verify-all-status').hidden&&!!document.querySelector('#library-verify-all-status').textContent.trim()")) return false;
    const response = await command('library.query', { query: '', sort: 'title', audio: 'all', duplicates: 'possible', offset: 0, limit: 50 });
    if (!response.ok || response.result.revision !== summary.revision || response.result.total !== 3 || response.result.items.length !== 3
      || !response.result.items.every(item => item.duplicateVerification === 'ready' && item.verifiedEligibleCopies === 2)) return false;
    verifiedPage = response.result; return true;
  }, 'global duplicate verification completes through worker IPC with two eligible copies');
  assert.deepEqual(verifiedPage.items.map(item => item.id).sort(), Object.values(f.ids).sort());
  assert.equal(await evaluate("document.querySelector('#library-verify-all-status').classList.contains('is-error')"), false);
  const displayedCounts = (await evaluate("document.querySelector('#library-verify-all-status').textContent")).match(/\d+/g)?.map(Number);
  assert.deepEqual(displayedCounts, [1, 0, 0, verifiedPage.items[0].verifiedEligibleCopies], 'the finished UI displays the actual ready-group and eligible-copy counts');
  assert.equal(confirmations.length, beforeBulkDialogs); assert.equal(recycled.length, 0); await intact(f);
  assert.equal((await cleanupHistory()).total, 0, 'verification alone never creates cleanup history');
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
  assert.equal(await evaluate(`!!document.querySelector('.library-cleanup-candidate[data-cleanup-id="${f.selectedId}"] .library-cleanup-force')`), false, 'notes changed after the scan cannot be deleted anyway');
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

  f = await fixture('visible-file-differences', null, async root => {
    await fs.writeFile(path.join(root, 'C-selected', 'song.ogg'), 'synthetic audio bytes - modified');
    await fs.writeFile(path.join(root, 'C-selected', 'extra.txt'), 'copy-only fixture file');
    await fs.writeFile(path.join(root, 'B-kept', 'cover.jpg'), 'keeper-only fixture artwork');
  });
  await prepare(f, false);
  const selectedCard = `.library-cleanup-candidate[data-cleanup-id="${f.selectedId}"]`;
  const rows = await evaluate(`(()=>{const card=document.querySelector(${JSON.stringify(selectedCard)});return {open:card.querySelector('.library-file-differences').open,rows:[...card.querySelectorAll('.library-file-differences-table tbody tr')].map(row=>({status:row.dataset.fileStatus,text:row.textContent}))}})()`);
  assert.equal(rows.open, true, 'different files are expanded before any delete-anyway decision');
  assert.ok(rows.rows.some(row => row.status === 'changed' && /song\.ogg.*Audio.*Modifié/.test(row.text)));
  assert.ok(rows.rows.some(row => row.status === 'only-copy' && /extra\.txt.*Autre.*Uniquement dans cette copie/.test(row.text)));
  assert.ok(rows.rows.some(row => row.status === 'only-keeper' && /cover\.jpg.*Illustration.*Uniquement dans la version conservée/.test(row.text)));
  assert.ok(rows.rows.some(row => row.status === 'identical' && /notes\.chart.*Notes.*Identique/.test(row.text)));
  assert.equal(await evaluate("document.querySelector('.library-variant.is-preferred').dataset.variantId"), f.keepId);
  assert.equal((await cleanupHistory()).total, 0); assert.equal(recycled.length, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'C-selected', 'extra.txt'), 'utf8'), 'copy-only fixture file');
  await capture('file-differences');
  passed.push('file differences show changed audio, identical notes, extra copy files and keeper-only artwork without selecting or deleting anything');

  f = await fixture('native-bin-failure'); await prepare(f);
  dialogAction = async () => 1; nativeError = true;
  await recycleAndSettle(); nativeError = false; assert.equal(recycled.length, 0); await intact(f);
  const failedHistory = await cleanupHistory();
  assert.equal(failedHistory.total, 1); assert.equal(failedHistory.entries[0].keep.id, f.keepId);
  assert.deepEqual(failedHistory.entries[0].candidates.map(candidate => ({ id: candidate.id, status: candidate.status })), [{ id: f.selectedId, status: 'failed' }]);
  await showHistory('failed');
  passed.push('native Recycle Bin failure preserves all files with no permanent-deletion fallback');
  passed.push('history records the failed selected copy and protected keeper without claiming a successful recycle');

  f = await fixture('partial-success'); await prepare(f);
  const beforeCleanupScan = host.snapshot().library.lastScanAt;
  assert.equal(typeof beforeCleanupScan, 'string');
  assert.equal((await cleanupHistory()).total, 0, 'another Songs root does not expose previous cleanup history');
  dialogAction = async () => 1;
  await recycleAndSettle();
  assert.deepEqual(recycled, [path.join(f.root, 'C-selected')]);
  await intact(f, ['A-unchecked', 'B-kept']);
  await assert.rejects(fs.stat(path.join(f.root, 'C-selected')), { code: 'ENOENT' });
  assert.equal(host.snapshot().library.count, 2);
  assert.equal(host.snapshot().library.cleanupRefreshPending, true);
  assert.equal(host.snapshot().library.lastScanAt, beforeCleanupScan, 'recycling updates the index without starting a scan');
  assert.equal(await evaluate("document.querySelector('#library-refresh').textContent"), 'Actualiser à la fin');
  assert.equal(await evaluate("document.querySelector('#library-cleanup-refresh-note').hidden"), false);
  assert.match(await evaluate("document.querySelector('#library-cleanup-result').textContent"), /1 copie\(s\).*Corbeille Windows.*B-kept/);
  await waitFor(() => evaluate("(()=>{const n=document.querySelector('#library-cleanup-result'),r=n.getBoundingClientRect();return !n.hidden&&r.height>0&&r.top>=0&&r.bottom<=window.innerHeight})()"), 'cleanup outcome stays visible after comparison collapses');
  await capture('partial-success');
  const successHistory = await cleanupHistory();
  assert.equal(successHistory.total, 1); assert.equal(successHistory.entries[0].keep.id, f.keepId);
  assert.deepEqual(successHistory.entries[0].candidates.map(candidate => ({ id: candidate.id, status: candidate.status })), [{ id: f.selectedId, status: 'recycled' }]);
  await showHistory('recycled');
  passed.push('successful native-bin dispatch removes exactly the checked copy from the index without a scan; keeper and unchecked copy remain byte-identical');
  passed.push('history lists only the selected recycled copy with its protected keeper and isolates entries by Songs root');

  await host.dispose(); host = null; panel = null;
  await openHost();
  await waitFor(() => host.snapshot().library.status === 'ready' && host.snapshot().library.count === 2, 'persisted library on new host');
  assert.equal(host.snapshot().library.cleanupRefreshPending, true, 'the deferred final refresh survives host and worker restart');
  await openComparison(2);
  assert.equal(await evaluate("document.querySelector('.library-variant.is-preferred').dataset.variantId"), f.keepId);
  await prepare(f, false);
  passed.push('keeper preference persists through host/worker restart after partial cleanup; remaining copy stays unchecked');
  assert.deepEqual(await cleanupHistory(), successHistory);
  await showHistory('recycled');
  passed.push('cleanup history persists through host/worker restart and remains visible in the history panel');

  await click('#library-comparison-close');
  await click('#library-refresh');
  await waitFor(() => host.snapshot().library.status === 'ready' && !host.snapshot().library.cleanupRefreshPending, 'one explicit final refresh completes');
  assert.equal(host.snapshot().library.count, 2);
  assert.equal(await evaluate("document.querySelector('#library-cleanup-refresh-note').hidden"), true);
  passed.push('one final refresh clears the deferred cleanup status and retains the remaining songs');
  activeRoot = path.join(directory, 'interrupt-global-verification', 'Songs');
  const groupCount = 80, syntheticAudio = Buffer.alloc(128 * 1024, 42);
  for (let index = 0; index < groupCount; index++) for (const copy of ['A', 'B']) {
    const title = 'Bulk ' + String(index).padStart(3, '0'), folder = path.join(activeRoot, title + '-' + copy);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'notes.chart'), files['notes.chart'].replace('Fixture duplicates', title));
    await fs.writeFile(path.join(folder, 'song.ini'), files['song.ini'].replace('Fixture duplicates', title));
    await fs.writeFile(path.join(folder, 'song.ogg'), syntheticAudio);
  }
  await click('#library-choose-root');
  await waitFor(() => host.snapshot().library.settings.rootPath === activeRoot && host.snapshot().library.status === 'ready' && host.snapshot().library.count === groupCount * 2, 'bulk interruption fixture scan');
  const bulkPage = await command('library.query', { query: '', sort: 'title', audio: 'all', duplicates: 'possible', offset: 0, limit: 50 });
  const bulkKeep = bulkPage.result.items[0].id, bulkRevision = host.snapshot().library.revision;
  const bulkComparison = await command('library.compareDuplicates', { id: bulkKeep, revision: bulkRevision });
  assert.equal((await command('library.chooseDuplicate', { contextId: bulkComparison.result.contextId, revision: bulkRevision, id: bulkKeep })).ok, true);
  const choicesFile = path.join(dataDirectory, 'library-duplicate-choices.json'), choicesBefore = await fs.readFile(choicesFile);
  const indexFile = path.join(dataDirectory, 'library.json'), indexBefore = await fs.readFile(indexFile);
  const beforeStopDialogs = confirmations.length, beforeStopRecycled = recycled.length;
  await click('#library-verify-all-duplicates');
  await waitFor(() => (host.snapshot().library.duplicateVerification?.processed ?? 0) >= 1, 'one group completed before interruption');
  await click('#library-cancel-duplicate-verification');
  await waitFor(() => evaluate("document.querySelector('#library-verify-all-status').textContent.includes('Vérification interrompue')&&!document.querySelector('#library-verify-all-duplicates').disabled"), 'interruption reports partial completion');
  assert.equal(host.snapshot().library.duplicateVerification, null);
  const interrupted = await evaluate("document.querySelector('#library-verify-all-status').textContent");
  assert.match(interrupted, /Vérification interrompue : \d+ \/ 80/); assert.match(interrupted, /Aucun fichier n’a été supprimé/);
  const finishedGroups = Number(interrupted.match(/interrompue : (\d+)/)[1]);
  assert.ok(finishedGroups >= 1 && finishedGroups < groupCount);
  assert.equal(await evaluate("document.querySelector('#library-cancel-duplicate-verification').hidden"), true);
  assert.equal(await evaluate("document.querySelector('#library-verify-all-status').classList.contains('is-error')"), false);
  assert.deepEqual(await fs.readFile(choicesFile), choicesBefore); assert.deepEqual(await fs.readFile(indexFile), indexBefore);
  assert.equal(confirmations.length, beforeStopDialogs); assert.equal(recycled.length, beforeStopRecycled);
  assert.equal((await cleanupHistory()).total, 0);
  await capture('global-verification-interrupted');
  await click('#library-verify-all-duplicates');
  await waitFor(() => evaluate("!document.querySelector('#library-verify-all-duplicates').disabled&&document.querySelector('#library-verify-all-status').textContent.includes('79 choix de version requis')"), 'verification restarts and finishes');
  assert.deepEqual(await fs.readFile(choicesFile), choicesBefore); assert.deepEqual(await fs.readFile(indexFile), indexBefore);
  for (let index = 0; index < groupCount; index++) for (const copy of ['A', 'B']) {
    const folder = path.join(activeRoot, 'Bulk ' + String(index).padStart(3, '0') + '-' + copy);
    assert.deepEqual(await fs.readFile(path.join(folder, 'song.ogg')), syntheticAudio);
  }
  const restored = await command('library.compareDuplicates', { id: bulkKeep, revision: bulkRevision });
  assert.equal(restored.result.preferredId, bulkKeep);
  passed.push('global verification stops during work with partial counts, then restarts; every synthetic song, saved index and keeper preference stays unchanged');

  // Different note content that was already indexed is an explicit manual
  // decision. Unlike the changed-after-scan case above, this complete bundle
  // must remain available for inspection and a separate native confirmation.
  const differentNotes = files['notes.chart'].replace('0 = N 0 0', '0 = N 4 192');
  f = await fixture('different-indexed-notes', null, async root => {
    await fs.writeFile(path.join(root, 'C-selected', 'notes.chart'), differentNotes);
  });
  await prepare(f, false);
  const notesCard = `.library-cleanup-candidate[data-cleanup-id="${f.selectedId}"]`;
  const forceSelector = notesCard + ' .library-cleanup-force';
  const noteDifference = await evaluate(`(()=>{
    const card=document.querySelector(${JSON.stringify(notesCard)}),details=card.querySelector('.library-file-differences');
    return {expanded:details.open,disabled:card.querySelector('.library-cleanup-check').disabled,checked:card.querySelector('.library-cleanup-check').checked,
      forceEnabled:!!card.querySelector('.library-cleanup-force')&&!card.querySelector('.library-cleanup-force').disabled,
      rows:[...details.querySelectorAll('tbody tr')].map(row=>({status:row.dataset.fileStatus,values:[...row.cells].map(cell=>cell.textContent)}))};
  })()`);
  assert.equal(noteDifference.expanded, true, 'different notes are visible before the manual decision');
  assert.equal(noteDifference.disabled, true, 'different notes cannot enter identical-copy cleanup');
  assert.equal(noteDifference.checked, false); assert.equal(noteDifference.forceEnabled, true);
  assert.ok(noteDifference.rows.some(row => row.status === 'changed' && row.values[0] === 'notes.chart' && row.values[1] === 'Notes' && row.values[2] === 'Modifié'));
  assert.ok(noteDifference.rows.some(row => row.status === 'identical' && row.values[0] === 'song.ogg' && row.values[1] === 'Audio'));
  assert.equal(await evaluate(`!!document.querySelector('.library-cleanup-candidate[data-cleanup-id="${f.keepId}"] .library-cleanup-force')`), false, 'the keeper has no delete-anyway action');
  assert.equal(await evaluate(`document.querySelector('.library-variant.is-preferred').dataset.variantId`), f.keepId);
  await capture('notes-differences');
  const beforeForceScan = host.snapshot().library.lastScanAt, beforeForceRevision = host.snapshot().library.revision, beforeForceRecycled = recycled.length;
  const confirmDifferentNotes = options => {
    assert.equal(options.title, 'Supprimer quand même cette copie ?');
    assert.deepEqual(options.buttons, ['Annuler', 'Supprimer quand même']);
    assert.match(options.detail, /Version conservée : B-kept/); assert.match(options.detail, /Copie à supprimer : C-selected/);
    assert.match(options.detail, /notes/i); assert.match(options.detail, /Corbeille Windows/);
    assert.doesNotMatch(options.detail, /A-unchecked/);
  };
  dialogAction = async options => { confirmDifferentNotes(options); return 0; };
  await recycleAndSettle(forceSelector);
  assert.equal(recycled.length, beforeForceRecycled); await intact(f, ['A-unchecked', 'B-kept']);
  assert.equal(await fs.readFile(path.join(f.root, 'C-selected', 'notes.chart'), 'utf8'), differentNotes);
  assert.equal(host.snapshot().library.count, 3); assert.equal(host.snapshot().library.revision, beforeForceRevision);
  assert.equal(host.snapshot().library.lastScanAt, beforeForceScan); assert.equal((await cleanupHistory()).total, 0);
  assert.match(await evaluate("document.querySelector('#library-cleanup-result').textContent"), /annul|cancel/i);
  passed.push('different indexed notes require a separate cancel-safe native confirmation; no file, index revision or scan changes on cancellation');
  await openComparison(3); await prepare(f, false);
  dialogAction = async options => { confirmDifferentNotes(options); return 1; };
  await recycleAndSettle(forceSelector);
  assert.deepEqual(recycled.slice(beforeForceRecycled), [path.join(f.root, 'C-selected')]);
  await intact(f, ['A-unchecked', 'B-kept']); await assert.rejects(fs.stat(path.join(f.root, 'C-selected')), { code: 'ENOENT' });
  assert.equal(host.snapshot().library.count, 2); assert.equal(host.snapshot().library.revision, beforeForceRevision + 1);
  assert.equal(host.snapshot().library.cleanupRefreshPending, true); assert.equal(host.snapshot().library.lastScanAt, beforeForceScan, 'delete-anyway updates the index without a scan');
  await waitFor(() => evaluate(`!document.querySelector('#library-comparison').hidden&&document.querySelector('#library-comparison').getAttribute('aria-busy')==='false'&&document.querySelectorAll('.library-variant').length===2&&document.querySelector('.library-variant.is-preferred')?.dataset.variantId===${JSON.stringify(f.keepId)}`), 'remaining versions retain the protected keeper');
  await assertUnselectedPlan(f.keepId);
  assert.equal(await evaluate(`!!document.querySelector('.library-cleanup-check[data-cleanup-id="${f.selectedId}"]')`), false);
  const forceHistory = await cleanupHistory();
  assert.equal(forceHistory.total, 1); assert.equal(forceHistory.entries[0].mode, 'force'); assert.equal(forceHistory.entries[0].keep.id, f.keepId);
  assert.deepEqual(forceHistory.entries[0].candidates.map(candidate => ({ id: candidate.id, status: candidate.status })), [{ id: f.selectedId, status: 'recycled' }]);
  assert.match(await evaluate("document.querySelector('#library-cleanup-result').textContent"), /Corbeille Windows.*B-kept/s);
  assert.equal(await evaluate("document.querySelector('#library-refresh').textContent"), 'Actualiser à la fin');
  await capture('notes-differences-recycled');
  passed.push('manual deletion of different indexed notes recycles only the explicitly confirmed copy; keeper and unchecked copy stay intact, remaining plan stays unselected and no scan starts');
  await host.dispose(); host = null;
  dialog.showMessageBox = originalDialog; dialog.showOpenDialog = originalPicker; shell.trashItem = originalTrash;
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify({ result: 'COMPANION_DUPLICATES_VERIFIED', passed, nativeBin: 'intercepted only for synthetic fixture', confirmations: confirmations.length, recycled }, null, 2));
  console.log(JSON.stringify({ result: 'COMPANION_DUPLICATES_VERIFIED', checks: passed.length, directory }));
  app.exit(0);
}).catch(fail);
