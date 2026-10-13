'use strict';
// Focused main catalogue renderer/IPC check with a private synthetic library.
// The catalogue client and browser launcher are mocked by the shared fixture.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { registerCompanionScheme, createCompanionHost } = require('../companion/host.cjs');
const { createCatalogueFixture, verifyCatalogue } = require('./companion-catalogue-electron.cjs');

const output = path.resolve(process.argv[2] || path.join(__dirname, '../../companion-catalogue-source-verification'));
const directory = path.join(output, 'catalogue-source-' + randomUUID()), songs = path.join(directory, 'Synthetic Library Songs');
app.setPath('userData', path.join(directory, 'electron-profile')); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); registerCompanionScheme();
const fixture = createCatalogueFixture(), passed = [];
let host, panel, failing = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await check()) return; await delay(30); }
  throw Error('Timed out: ' + label);
}
async function fail(error) {
  if (failing) return; failing = true;
  const report = { result: 'COMPANION_CATALOGUE_SOURCE_FAILED', error: String(error.stack || error), passed, externalRequests: fixture.state.externalRequests };
  if (panel && !panel.isDestroyed()) {
    try { report.renderer = await panel.webContents.executeJavaScript('document.body.innerText.slice(0,14000)'); } catch (_) {}
    try { await fs.writeFile(path.join(directory, 'failure.png'), (await panel.webContents.capturePage()).toPNG()); } catch (_) {}
  }
  await fs.mkdir(directory, { recursive: true }).catch(() => {});
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2)).catch(() => {});
  console.error(error); console.error('Catalogue diagnostics: ' + path.join(directory, 'report.json'));
  try { await host?.dispose(); } catch (_) {} app.exit(1);
}
setTimeout(() => void fail(Error('Focused catalogue Electron verification timed out')), 120000).unref();

app.whenReady().then(async () => {
  for (const folderName of ['Song 000', 'Song 054']) {
    const folder = path.join(songs, folderName); await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'song.ini'), '[song]\nname = Library Chart 000\nartist = Artist 000\ncharter = Creator 000\n');
    await fs.writeFile(path.join(folder, 'notes.chart'), '[Song]\n{\n  Name = "Library Chart 000"\n  Resolution = 192\n}\n[ExpertSingle]\n{\n  0 = N 0 0\n}\n');
  }
  host = await createCompanionHost({ dataDirectory: path.join(directory, 'settings'), catalogueClient: fixture.client,
    isCatalogueAvailable: () => true, authorizeCatalogue: async () => true, cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({ running: false, sessions: [] }) });
  panel = await host.open();
  await waitFor(() => panel.webContents.executeJavaScript("!!window.ChartsHubCompanion&&!document.querySelector('#catalogue-search')?.disabled"), 'main catalogue ready');
  await host.library.selectRoot(songs); await host.library.configure({ watch: false, refreshOnStart: false });
  await waitFor(() => host.library.status().status === 'ready' && host.library.matchingSnapshot().items.length === 2, 'synthetic duplicate library ready');
  assert.equal(fixture.state.loads, 0); assert.equal(fixture.state.externalRequests.length, 0);
  await verifyCatalogue(panel, host, directory, passed, fixture);
  const report = { result: 'COMPANION_CATALOGUE_SOURCE_OK', count: passed.length, passed, externalRequests: fixture.state.externalRequests, directory };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  await host.dispose(); app.exit(0);
}).catch(fail);
