'use strict';
// Hidden renderer fixture: synthetic statuses only, no library or network access.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const directory = path.resolve(process.argv[2] || path.join(__dirname, '../../catalogue-sync-ui-verification'));
app.setPath('userData', path.join(directory, 'isolated-profile')); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const errors = [], externalRequests = [], captures = [], passed = []; let window;
const fileURL = file => pathToFileURL(path.resolve(__dirname, '../companion/ui', file)).href;
const evaluate = source => window.webContents.executeJavaScript(source);
const timer = setTimeout(() => { console.error('Catalogue sync UI fixture timed out'); app.exit(1); }, 60000);
async function record(label, action) { await action(); passed.push(label); }
app.whenReady().then(async () => {
  await fs.mkdir(directory, { recursive: true });
  const fixture = path.join(directory, 'fixture.html');
  await fs.writeFile(fixture, '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic catalogue sync</title>' +
    '<link rel="stylesheet" href="' + fileURL('companion.css') + '"><link rel="stylesheet" href="' + fileURL('catalogue-sync-controls.css') + '">' +
    '<style>body{padding:16px;box-sizing:border-box;min-width:0}main{max-width:1280px;margin:0 auto}</style></head><body><main><section id="sync" class="catalogue-sync-controls"></section></main></body></html>');
  window = new BrowserWindow({ show: false, width: 1400, height: 920, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => { const allowed = /^(file:|data:|about:)/.test(details.url); if (!allowed) externalRequests.push(details.url); callback({ cancel: !allowed }); });
  await window.loadFile(fixture);
  await evaluate(`(async()=>{const {CatalogueSyncControls}=await import(${JSON.stringify(fileURL('catalogue-sync-controls.js'))});window.calls=[];window.controls=new CatalogueSyncControls({root:document.querySelector('#sync'),command:async(name,payload)=>{window.calls.push([name,payload]);return{ok:true}}});window.synthetic={language:'fr',downloads:{rootPath:'C:/Synthetic/Songs'},catalogueSync:{phase:'ready',mode:'all',total:100000,processed:100000,concurrency:3,includeVideo:false,counts:{new:25,update:8,unchanged:99965,conflict:2,failed:0,completed:0},items:Array.from({length:50},(_,i)=>({title:'Signal de démonstration '+i,state:i%2?'unchanged':'new'}))}};window.controls.update(window.synthetic);})()`);
  await record('No automatic command on initial render', async () => assert.deepEqual(await evaluate('window.calls'), []));
  for (const [width, language] of [[1400, 'fr'], [680, 'en']]) {
    window.setContentSize(width, 920);
    await evaluate(`window.synthetic.language=${JSON.stringify(language)};window.controls.update(window.synthetic)`);
    await record('No horizontal overflow at ' + width + 'px in ' + language, async () => assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true));
    await record('Visible action stays inside panel at ' + width + 'px', async () => assert.equal(await evaluate(`(()=>{const root=document.querySelector('#sync').getBoundingClientRect(),button=document.querySelector('#catalogue-sync-start').getBoundingClientRect();return button.width>0&&button.left>=root.left&&button.right<=root.right})()`), true));
    const filename = 'catalogue-sync-' + language + '-' + width + '.png';
    await new Promise(resolve => setTimeout(resolve, 100));
    await fs.writeFile(path.join(directory, filename), (await window.webContents.capturePage({ x: 0, y: 0, width, height: 920 }, { stayHidden: true, stayAwake: true })).toPNG()); captures.push(filename);
  }
  await record('Explicit download action uses the fixed start command', async () => { await evaluate("document.querySelector('#catalogue-sync-start').click()"); assert.deepEqual(await evaluate('window.calls'), [['catalogueSync.start', {}]]); });
  await record('Progress does not rebuild unrelated global controls', async () => {
    assert.equal(await evaluate(`(async()=>{const{controlSnapshotSignature}=await import(${JSON.stringify(fileURL('panel-snapshot.js'))});const a={state:{performance:null},catalogueSync:{phase:'running',receivedBytes:1}};const before=controlSnapshotSignature(a);a.catalogueSync.receivedBytes=100000000;return before===controlSnapshotSignature(a)})()`), true);
  });
  await record('Details remain bounded and keyboard controls retain their labels', async () => {
    assert.equal(await evaluate('document.querySelectorAll(".catalogue-sync-items li").length'), 50);
    assert.equal(await evaluate("document.querySelector('label[for=catalogue-sync-mode]')?.textContent.includes('Charts to synchronize')"), true);
  });
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []); assert.equal(window.isVisible(), false);
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify({ result: 'CATALOGUE_SYNC_UI_OK', passed, captures, errors, externalRequests, hidden: true }, null, 2));
  console.log(JSON.stringify({ result: 'CATALOGUE_SYNC_UI_OK', checks: passed.length, directory }));
  clearTimeout(timer); window.destroy(); app.exit(0);
}).catch(async error => {
  console.error(error); await fs.mkdir(directory, { recursive: true }).catch(() => {});
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify({ result: 'CATALOGUE_SYNC_UI_FAILED', error: String(error.stack || error), passed, errors, externalRequests }, null, 2)).catch(() => {});
  clearTimeout(timer); app.exit(1);
});
