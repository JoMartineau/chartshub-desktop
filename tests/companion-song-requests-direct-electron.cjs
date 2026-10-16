'use strict';
const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { registerCompanionScheme, createCompanionHost } = require('../companion/host.cjs');
const { createSongRequestSharingFixture, verifySongRequests } = require('./companion-song-requests-electron.cjs');
const { createCatalogueFixture } = require('./companion-catalogue-electron.cjs');
const data = path.resolve(process.argv[2] || path.join(__dirname, '../../song-request-direct-validation'));
app.setPath('userData', path.join(data, 'isolated-profile'));
app.disableHardwareAcceleration();
registerCompanionScheme();
let host;
app.whenReady().then(async () => {
  try {
    await fs.mkdir(data, { recursive: true });
    const fixture = createSongRequestSharingFixture(), passed = [];
    host = await createCompanionHost({ dataDirectory: path.join(data, 'settings'),
      catalogueClient: createCatalogueFixture().client,
      cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({ running: null, sessions: [] }),
      sharingClient: fixture.client, songRequestConnectionOptions: fixture.connectionOptions });
    host.setLanguage('fr');
    const panel = await host.open();
    const start = Date.now();
    while (Date.now() - start < 10000) {
      if (await panel.webContents.executeJavaScript("document.body.dataset.gameplayState==='menu' && !document.querySelector('#song-requests-twitch-connect').disabled")) break;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    await verifySongRequests(panel, host, data, passed, fixture);
    await host.dispose(); host = null;
    await fs.writeFile(path.join(data, 'song-request-direct-electron-check.json'), JSON.stringify({ ok: true, checkedAt: new Date().toISOString(), passed }, null, 2) + '\n');
    console.log('PASS Song Request Electron: ' + passed.length + ' integration checks');
    app.exit(0);
  } catch (error) {
    console.error(error);
    const panel = host?.getPanel();
    if (panel && !panel.isDestroyed()) {
      try { await fs.writeFile(path.join(data, 'failure.png'), (await panel.webContents.capturePage()).toPNG()); } catch {}
    }
    await host?.dispose().catch(() => {}); app.exit(1);
  }
});
