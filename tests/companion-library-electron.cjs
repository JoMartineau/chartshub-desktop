'use strict';
const { dialog, shell } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await delay(40);
  }
  throw Error('Timed out: ' + label);
}

/** Uses real UI IPC and a tiny, isolated Songs tree; native OS dialogs alone are intercepted. */
async function verifyLibrary(panel, host, data, passed) {
  const root = path.join(data, 'library-fixture-' + randomUUID());
  const originalDialog = dialog.showOpenDialog;
  const originalOpenPath = shell.openPath;
  const originalGame = structuredClone(host.snapshot().state);
  const originalEditorRevision = host.snapshot().editor.revision;
  const evaluate = code => panel.webContents.executeJavaScript(code);
  const control = process.platform === 'darwin' ? 'meta' : 'control';
  let selected = 0;
  let opened = null;
  const number = index => String(index).padStart(3, '0');
  const folder = index => path.join(root, 'Song ' + number(index));
  const createChart = async (index, title = 'Library Chart ' + number(index), artist = 'Artist ' + number(index), charter = 'Creator ' + number(index)) => {
    const directory = folder(index);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'notes.chart'), '[Song]\n{\n  Name = "' + title + '"\n}\n');
    await fs.writeFile(path.join(directory, 'song.ini'), '[song]\nname = ' + title + '\nartist = ' + artist + '\ncharter = ' + charter + '\n');
  };
  const click = async selector => {
    await waitFor(() => evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});return !!node&&!node.disabled&&!node.hidden})()`), 'library control enabled: ' + selector);
    const point = await evaluate(`(()=>{
      const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'center',inline:'nearest'});
      const rect=node.getBoundingClientRect(),point={x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};
      const hit=document.elementFromPoint(point.x,point.y);
      if(!rect.width||!rect.height||!hit||!(hit===node||node.contains(hit)))throw Error('Library target is hidden or covered.');
      return point;
    })()`);
    panel.focus(); panel.webContents.focus();
    panel.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    panel.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    panel.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await delay(40);
  };
  const key = async (keyCode, modifiers = []) => {
    panel.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    panel.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await delay(40);
  };
  const search = async value => {
    await click('#library-search'); await key('A', [control]);
    await panel.webContents.insertText(value); await key('Enter');
  };
  const rowsReady = async (expected, contains = '') => {
    await waitFor(() => evaluate(`document.querySelector('#library-results').getAttribute('aria-busy')==='false'&&document.querySelectorAll('#library-rows tr').length===${expected}&&document.querySelector('#library-rows').textContent.includes(${JSON.stringify(contains)})`), 'library rows: ' + expected + ' / ' + contains);
  };
  const checkbox = async (selector, expected) => {
    if (await evaluate(`document.querySelector(${JSON.stringify(selector)}).checked`) !== expected) await click(selector);
    await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(selector)}).checked===${expected}&&!document.querySelector(${JSON.stringify(selector)}).disabled`), 'library option: ' + selector);
  };
  const select = async (selector, value) => {
    await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(node.disabled)throw Error('Library filter is disabled.');node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  };
  const scrollToEnd = async (expected, contains) => {
    const point = await evaluate(`(()=>{
      const node=document.querySelector('#library-table-container');node.scrollIntoView({block:'center'});
      const rect=node.getBoundingClientRect();
      if(!rect.width||!rect.height||node.scrollHeight<=node.clientHeight)throw Error('Library scroll container unavailable.');
      window.__libraryFirstRow=document.querySelector('#library-rows tr');
      window.__libraryScrollBeforeAppend=null;
      node.addEventListener('scroll',()=>{window.__libraryScrollBeforeAppend=node.scrollTop;},{once:true});
      return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};
    })()`);
    panel.focus(); panel.webContents.focus();
    panel.webContents.sendInputEvent({type:'mouseMove',...point});
    // Electron forwards native wheel deltas; Chromium negates them for DOM scrolling.
    panel.webContents.sendInputEvent({type:'mouseWheel',...point,deltaX:0,deltaY:-100000,hasPreciseScrollingDeltas:true,canScroll:true});
    await rowsReady(expected, contains);
    assert.equal(await evaluate("document.querySelector('#library-rows tr')===window.__libraryFirstRow"),true);
    assert.equal(await evaluate("new Set([...document.querySelectorAll('#library-rows tr')].map(n=>n.dataset.librarySongId)).size"),expected);
    assert.equal(await evaluate("document.querySelector('#library-load-more').hidden"),expected===116);
    assert.ok(await evaluate("document.querySelector('#library-table-container').scrollTop")>0);
    assert.equal(await evaluate("window.__libraryScrollBeforeAppend>0&&document.querySelector('#library-table-container').scrollTop>=window.__libraryScrollBeforeAppend-1"),true);
  };

  try {
    for (let index = 0; index < 116; index++) await createChart(index);
    await createChart(54, 'Library Chart 000', 'Artist 000', 'Creator 000');
    await fs.writeFile(path.join(folder(0), 'song.ogg'), Buffer.from('fixture-audio-presence'));
    dialog.showOpenDialog = async () => { selected++; return { canceled: false, filePaths: [root] }; };
    shell.openPath = async value => { opened = value; return ''; };
    panel.setSize(1250, 900);

    await click('#library-choose-root');
    await waitFor(() => host.snapshot().library?.settings.rootPath === root && host.snapshot().library.status === 'ready' && host.snapshot().library.count === 116, 'choosing Songs automatically completes a full scan');
    await rowsReady(50, 'Library Chart 000');
    assert.equal(selected, 1);
    assert.equal(host.snapshot().library.mode, 'full');
    assert.equal(await evaluate("document.querySelector('#library-root').textContent"), root);
    assert.equal(await evaluate("document.querySelector('#library-rows tr td:nth-child(5)').textContent"), 'Présent');
    passed.push('library folder choice automatically scans 116 local charts; first batch has 50 rows and detected audio');

    assert.equal(await evaluate("!!document.querySelector('#library-prev')||!!document.querySelector('#library-next')"),false);
    await scrollToEnd(100, 'Library Chart 050');
    await scrollToEnd(116, 'Library Chart 115');
    passed.push('native wheel scrolling automatically appends the next 50-row batch without duplicate IDs or replacing earlier rows');
    await select('#library-audio', 'present'); await rowsReady(1, 'Library Chart 000');
    assert.match(await evaluate("document.querySelector('#library-page-status').textContent"), /1 sur 1 résultat affiché/);
    assert.equal(await evaluate("document.querySelector('#library-table-container').scrollTop"),0);
    await select('#library-audio', 'missing'); await rowsReady(50);
    assert.match(await evaluate("document.querySelector('#library-page-status').textContent"), /sur 115/);
    await select('#library-duplicates', 'possible'); await rowsReady(1, 'Library Chart 000');
    assert.equal(await evaluate("document.querySelector('#library-rows td[data-audio]').dataset.audio"), 'missing');
    assert.equal(await evaluate("document.querySelector('#library-rows .library-duplicate-badge').textContent"), 'Doublon possible (2)');
    await select('#library-audio', 'all'); await rowsReady(2, 'Library Chart 000');
    const duplicateNotes = await Promise.all([0, 54].map(index => fs.readFile(path.join(folder(index), 'notes.chart'), 'utf8')));
    await click('#library-rows .library-compare');
    const comparisonReady = () => evaluate("!document.querySelector('#library-comparison').hidden&&document.querySelector('#library-comparison').getAttribute('aria-busy')==='false'&&document.querySelectorAll('.library-variant').length===2");
    await waitFor(comparisonReady, 'duplicate versions compared through UI IPC');
    assert.match(await evaluate("document.querySelector('.library-note-group').textContent"), /Notes identiques/);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.library-variant-path')).whiteSpace"), 'pre-wrap');
    await click('.library-variant-choose');
    const preferredVisible = () => evaluate("document.querySelectorAll('.library-preferred-badge:not([hidden])').length===1");
    await waitFor(preferredVisible, 'preferred duplicate saved');
    const preferredPath = await evaluate("document.querySelector('.library-variant.is-preferred .library-variant-path').textContent");
    await click('#library-comparison-close');
    await click('#library-rows .library-compare');
    await waitFor(comparisonReady, 'duplicate comparison reopened');
    await waitFor(preferredVisible, 'saved duplicate preference restored');
    assert.equal(await evaluate("document.querySelector('.library-variant.is-preferred .library-variant-path').textContent"), preferredPath);
    await click('.library-variant.is-preferred .library-variant-open');
    await waitFor(() => opened !== null, 'open the compared duplicate folder');
    assert.equal(opened, path.join(root, preferredPath)); opened = null;
    await fs.writeFile(path.join(data, 'companion-library-comparison.png'), (await panel.webContents.capturePage()).toPNG());
    await click('#library-comparison-clear');
    await waitFor(() => evaluate("document.querySelectorAll('.library-preferred-badge:not([hidden])').length===0&&document.querySelector('#library-comparison-clear').hidden"), 'duplicate preference cleared');
    assert.deepEqual(await Promise.all([0, 54].map(index => fs.readFile(path.join(folder(index), 'notes.chart'), 'utf8'))), duplicateNotes);
    await click('#library-comparison-close');
    passed.push('duplicate versions compare identical notes, preserve wrapped paths, save/reload/clear preferences and open scoped folders without changing files');
    await search('Creator 042'); await rowsReady(0);
    assert.match(await evaluate("document.querySelector('#library-empty-title').textContent"), /ces filtres/);
    await click('#library-clear-filters'); await rowsReady(1, 'Library Chart 042');
    assert.equal(await evaluate("document.querySelector('#library-search').value"), 'Creator 042');
    await click('#library-clear-search'); await rowsReady(50);
    await select('#library-audio', 'unknown'); await rowsReady(0);
    assert.match(await evaluate("document.querySelector('#library-empty-title').textContent"), /ces filtres/);
    await click('#library-clear-filters'); await rowsReady(50);
    passed.push('audio and possible-duplicate filters combine, reset pagination, preserve search when cleared and show recoverable empty results');
    await scrollToEnd(100, 'Library Chart 050');
    await scrollToEnd(116, 'Library Chart 115');
    for (const query of ['Library Chart 042', 'Artist 042', 'Creator 042']) {
      await search(query); await rowsReady(1, 'Library Chart 042');
    }
    await evaluate("(()=>{const select=document.querySelector('#library-sort');select.value='artist';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await rowsReady(1, 'Library Chart 042');
    await click('#library-rows button[data-library-open-id]');
    await waitFor(() => opened !== null, 'open a chart folder through UI');
    assert.equal(opened, folder(42));
    passed.push('library scroll loading, title/artist/charter search, sort and scoped folder opening work through UI IPC');

    // A global builder shortcut must leave text editing in the search field alone.
    await click('#builder-toggle');
    await click('#library-search');
    await key('Z', [control]);
    assert.equal(host.snapshot().editor.revision, originalEditorRevision);
    await click('#builder-toggle');
    await click('#library-clear-search'); await rowsReady(50);
    await checkbox('#library-watch', true);
    assert.equal(host.snapshot().library.settings.watch, true);
    await checkbox('#library-watch', false);
    await checkbox('#library-refresh-on-start', false);
    assert.equal(host.snapshot().library.settings.refreshOnStart, false);

    await createChart(116, 'Library Added Chart', 'New Artist');
    await fs.unlink(path.join(folder(1), 'notes.chart'));
    await fs.writeFile(path.join(folder(2), 'song.ini'), '[song]\nname = Library Modified Chart\nartist = Changed Artist\ncharter = Changed Creator\n');
    const previousScan = host.snapshot().library.lastScanAt;
    await click('#library-refresh');
    await waitFor(() => host.snapshot().library.status === 'ready' && host.snapshot().library.lastScanAt !== previousScan, 'quick scan finishes');
    assert.equal(host.snapshot().library.count, 116);
    assert.equal(host.snapshot().library.mode, 'quick');
    assert.equal(host.snapshot().library.changes.added, 1);
    assert.equal(host.snapshot().library.changes.removed, 1);
    assert.ok(host.snapshot().library.changes.modified >= 1);
    await search('Library Modified Chart'); await rowsReady(1, 'Changed Artist');
    passed.push('quick refresh detects one addition, one removal and modified metadata; library options are stored');

    await new Promise((resolve, reject) => {
      const completed = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { panel.webContents.removeListener('did-finish-load', completed); reject(Error('Library panel reload timed out.')); }, 15000);
      panel.webContents.once('did-finish-load', completed);
      panel.webContents.reloadIgnoringCache();
    });
    await rowsReady(50);
    assert.equal(await evaluate("document.querySelector('#library-root').textContent"), root);
    assert.equal(await evaluate("document.querySelector('#library-watch').checked"), false);
    assert.equal(await evaluate("document.querySelector('#library-refresh-on-start').checked"), false);
    assert.deepEqual(host.snapshot().state, originalGame, 'local library actions must not replace simulated gameplay or overlay data');
    assert.equal(host.snapshot().editor.revision, originalEditorRevision);
    await evaluate("document.querySelector('#library-panel').scrollIntoView({block:'start',inline:'nearest'})");
    await delay(120);
    await fs.writeFile(path.join(data, 'companion-library.png'), (await panel.webContents.capturePage()).toPNG());
    passed.push('library panel reload retains the selected index and options; real local charts remain separate from demo gameplay');
  } finally {
    dialog.showOpenDialog = originalDialog;
    shell.openPath = originalOpenPath;
  }
}

module.exports = { verifyLibrary };
