'use strict';
const { app, shell } = require('electron');
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

/** Manually released worker: real UI/service lifecycle, synthetic transfer and no network. */
function createDownloadFixture() {
  const state = { runs: [], active: new Map(), discarded: [] };
  const worker = {
    run: async ({ id, endpoint, rootPath, signal, onProgress }) => {
      state.runs.push({ id, endpoint, rootPath });
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = error => {
          if (settled) return;
          settled = true; signal.removeEventListener('abort', aborted); state.active.delete(id);
          if (error) reject(error); else resolve();
        };
        const aborted = () => finish(Object.assign(new Error('Synthetic transfer interrupted'), { name: 'AbortError' }));
        state.active.set(id, {
          complete: () => finish(),
          fail: () => finish(Object.assign(new Error('Synthetic transfer failure'), { code: 'DOWNLOAD_NETWORK' })),
          progress: receivedBytes => onProgress({ receivedBytes, totalBytes: 256, completedFiles: 1, totalFiles: 2, currentFile: 'song.ogg' }),
        });
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) { aborted(); return; }
        onProgress({ receivedBytes: 96, totalBytes: 256, completedFiles: 1, totalFiles: 2, currentFile: 'song.ogg' });
      });
      const folderName = 'Synthetic chart ' + id, destination = path.join(rootPath, folderName);
      await fs.mkdir(destination);
      await fs.writeFile(path.join(destination, 'notes.chart'), '[Song]\n{\n Name = "Synthetic download"\n}\n');
      await fs.writeFile(path.join(destination, 'song.ini'), '[song]\nname = Synthetic download\nartist = Native verification\n');
      return { destination, folderName, files: 2, totalBytes: 256 };
    },
    discard: async ({ id, rootPath }) => { state.discarded.push({ id, rootPath }); },
    resolveCompleted: async ({ rootPath, destination }) => {
      if (typeof destination !== 'string' || path.dirname(destination) !== rootPath) return null;
      try { return (await fs.stat(destination)).isDirectory() ? await fs.realpath(destination) : null; } catch { return null; }
    },
  };
  return { state, worker };
}

async function verifyDownloads(initialPanel, host, data, passed, fixture) {
  let panel = initialPanel;
  const evaluate = code => panel.webContents.executeJavaScript(code);
  const root = path.join(data, 'download-fixture-' + randomUUID());
  const originalOpenPath = shell.openPath;
  const originalGame = structuredClone(host.snapshot().state);
  let opened = null;
  const keepAlive = () => {};
  const item = chartId => host.snapshot().downloads.items.find(entry => entry.chartId === chartId);
  const firstChart = 'native-catalogue-000', secondChart = 'native-catalogue-001';
  const selector = (id, action) => `[data-download-id="${id}"] [data-download-action="${action}"]`;
  const click = async target => {
    await waitFor(() => evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(target)});return !!node&&!node.disabled&&!node.hidden})()`), 'download control: ' + target);
    const point = await evaluate(`(()=>{
      const node=document.querySelector(${JSON.stringify(target)});node.scrollIntoView({block:'center',inline:'nearest'});
      const rect=node.getBoundingClientRect(),point={x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};
      const hit=document.elementFromPoint(point.x,point.y);
      if(!rect.width||!rect.height||!hit||!(hit===node||node.contains(hit)))throw Error('Download target is hidden or covered.');
      return point;
    })()`);
    panel.focus(); panel.webContents.focus();
    panel.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    panel.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    panel.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await delay(40);
  };
  const state = async (id, expected) => waitFor(() => evaluate(`document.querySelector(${JSON.stringify('[data-download-id="' + id + '"]')})?.dataset.downloadState===${JSON.stringify(expected)}`), 'download state: ' + expected);
  const enqueue = async chartId => click(`[data-catalogue-id="${chartId}"] [data-catalogue-action="download"]`);

  try {
    await fs.mkdir(root, { recursive: true });
    await host.downloads.selectRoot(root);
    shell.openPath = async folder => { opened = folder; return ''; };
    assert.equal(host.snapshot().downloads.items.length, 0);
    assert.equal(fixture.state.runs.length, 0);
    await waitFor(() => evaluate(`document.querySelector('#downloads-root').textContent===${JSON.stringify(root)}`), 'download folder shown in UI');
    assert.equal(await evaluate(`document.querySelector('[data-catalogue-id="${firstChart}"] [data-catalogue-action="download"]').disabled`), false);
    await enqueue(firstChart);
    await waitFor(() => item(firstChart)?.state === 'Downloading' && fixture.state.active.has(item(firstChart).id), 'first synthetic download starts');
    const firstId = item(firstChart).id;
    await state(firstId, 'Downloading');
    await evaluate(`window.__nativeDownloadRow=document.querySelector('[data-download-id="${firstId}"]')`);
    await delay(120);
    fixture.state.active.get(firstId).progress(160);
    await waitFor(() => evaluate(`document.querySelector('[data-download-id="${firstId}"] [data-download-bytes]').textContent.includes('160')`), 'byte progress renders');
    assert.equal(await evaluate(`window.__nativeDownloadRow===document.querySelector('[data-download-id="${firstId}"]')`), true);
    await enqueue(firstChart);
    assert.equal(host.snapshot().downloads.items.length, 1, 'same chart/destination reuses the existing queue item');
    await click(selector(firstId, 'pause')); await state(firstId, 'Paused');
    assert.equal(item(firstChart).completedFiles, 1);
    await click(selector(firstId, 'resume')); await state(firstId, 'Downloading');
    await waitFor(() => fixture.state.active.has(firstId), 'resumed worker runs');
    passed.push('download enqueue deduplicates; progress keeps its DOM row; pause/resume preserve completed-file progress');

    await enqueue(secondChart);
    await waitFor(() => !!item(secondChart), 'second queue item recorded');
    const secondId = item(secondChart).id;
    await state(secondId, 'Queued');
    await click(selector(secondId, 'pause')); await state(secondId, 'Paused');
    await click(selector(secondId, 'cancel')); await state(secondId, 'Cancelled');
    await click(selector(secondId, 'retry')); await state(secondId, 'Queued');
    fixture.state.active.get(firstId).complete();
    await state(firstId, 'Completed');
    await state(secondId, 'Downloading');
    await waitFor(() => fixture.state.active.has(secondId), 'next queued worker runs');
    await click(selector(firstId, 'openFolder'));
    await waitFor(() => opened !== null, 'completed destination opened through scoped shell');
    const completedDestination = item(firstChart).destination;
    assert.equal(opened, completedDestination);
    assert.equal((await fs.stat(completedDestination)).isDirectory(), true);
    fixture.state.active.get(secondId).fail();
    await state(secondId, 'Failed');
    assert.ok(await evaluate(`document.querySelector('[data-download-id="${secondId}"] [data-download-error]').textContent`));
    await click(selector(secondId, 'retry')); await state(secondId, 'Downloading');
    await waitFor(() => fixture.state.active.has(secondId), 'retry starts worker');
    await click(selector(secondId, 'cancel')); await state(secondId, 'Cancelled');
    await click(selector(secondId, 'remove'));
    await waitFor(() => !host.snapshot().downloads.items.some(entry => entry.id === secondId), 'cancelled history removed');
    assert.ok(fixture.state.discarded.some(entry => entry.id === secondId));
    await evaluate("document.querySelector('#downloads-panel').scrollIntoView({block:'start'})");
    await fs.writeFile(path.join(data, 'companion-downloads.png'), (await panel.webContents.capturePage()).toPNG());
    await click(selector(firstId, 'remove'));
    await waitFor(() => host.snapshot().downloads.items.length === 0, 'completed history removed');
    assert.equal((await fs.stat(completedDestination)).isDirectory(), true, 'removing completed history retains downloaded files');
    assert.deepEqual(host.snapshot().state, originalGame, 'downloads do not replace demo gameplay or overlay data');
    passed.push('queued pause/cancel/retry, transfer failure/retry, folder opening and history removal follow state-specific controls; completed files remain');

    await enqueue(firstChart);
    await waitFor(() => item(firstChart)?.state === 'Downloading' && fixture.state.active.has(item(firstChart).id), 'transfer before panel closure');
    const restoredId = item(firstChart).id;
    app.on('window-all-closed', keepAlive);
    await new Promise(resolve => { panel.once('closed', resolve); panel.close(); });
    await host.stop();
    assert.equal(item(firstChart).state, 'Paused');
    const saved = JSON.parse(await fs.readFile(path.join(data, 'settings', 'download-state.json'), 'utf8'));
    assert.equal(saved.items.find(entry => entry.id === restoredId).state, 'Paused');
    const runsBeforeOpen = fixture.state.runs.length;
    panel = await host.open();
    assert.ok(panel && !panel.isDestroyed());
    await state(restoredId, 'Paused');
    await delay(160);
    assert.equal(fixture.state.runs.length, runsBeforeOpen, 'reopening the panel never resumes a paused transfer automatically');
    await evaluate("document.querySelector('#downloads-panel').scrollIntoView({block:'start'})");
    await fs.writeFile(path.join(data, 'companion-downloads-restored.png'), (await panel.webContents.capturePage()).toPNG());
    await click(selector(restoredId, 'resume')); await state(restoredId, 'Downloading');
    await waitFor(() => fixture.state.active.has(restoredId), 'explicit resume after reopen');
    await click(selector(restoredId, 'cancel')); await state(restoredId, 'Cancelled');
    await click(selector(restoredId, 'remove'));
    await waitFor(() => host.snapshot().downloads.items.length === 0, 'restored item removed');
    panel.setSize(900, 660);
    await delay(120);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    passed.push('closing saves active downloads as Paused; reopening stays paused until explicit resume and the narrow layout fits');
  } finally {
    app.removeListener('window-all-closed', keepAlive);
    shell.openPath = originalOpenPath;
  }
}

module.exports = { createDownloadFixture, verifyDownloads };
