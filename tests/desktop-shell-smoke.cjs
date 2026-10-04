'use strict';
// Run with Electron, not Node. Uses only isolated local test views/profile.
const electron = require('electron');
const { app, WebContentsView } = electron;
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Module, createRequire } = require('node:module');
const profile = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'chartshub-shell-smoke-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
if (process.env.CHARTSHUB_TEST_NO_SANDBOX === '1') app.commandLine.appendSwitch('no-sandbox');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let shell, companion, failure;
app.whenReady().then(async () => {
  const filename = require.resolve('../desktop/controller.cjs'), loaded = new Module(filename, module), normal = createRequire(filename);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => name === 'electron' ? { ...electron, BrowserWindow: function (options) { return new electron.BrowserWindow({ ...options, show: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false } }); } } : normal(name);
  loaded._compile(await fs.readFile(filename, 'utf8'), filename);
  const selections = [];
  shell = loaded.exports.createDesktopShell({ cataloguePreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }, onSelectTab: name => selections.push(name) });
  await shell.ready;
  const page = (title, background) => 'data:text/html,' + encodeURIComponent(`<html><body style="margin:0;padding:42px;background:${background};color:#dce8e2;font:16px Segoe UI"><h1>${title}</h1><p>Vue locale de validation des onglets persistants.</p><input value="État conservé" style="padding:12px"></body></html>`);
  await shell.catalogueView.webContents.loadURL(page('Catalogue', '#17202b'));
  companion = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await companion.webContents.loadURL(page('Companion', '#1b2420'));
  shell.attachCompanion(companion);
  const read = expression => shell.window.webContents.executeJavaScript(expression);
  assert.equal(await read('document.getElementById("companion-tab").hidden'), true);
  assert.deepEqual(await read('Object.keys(window.chartsHubShell).sort()'), ['getState', 'onState', 'selectTab']);
  shell.setCompanionAvailable(true);
  await read('document.getElementById("companion-tab").click()'); await delay(120);
  assert.deepEqual(selections, ['companion']);
  assert.equal(await read('document.getElementById("companion-tab").getAttribute("aria-selected")'), 'true');
  assert.equal(await read('document.getElementById("companion-tab").hidden'), false);
  assert.equal(companion.getVisible(), true); assert.equal(shell.catalogueView.getVisible(), false);
  assert.equal(await read('document.querySelector(".appnav").getBoundingClientRect().bottom'), 108);
  assert.equal(companion.getBounds().y, 108);
  await companion.webContents.executeJavaScript('document.querySelector("input").value = "Modifié"');
  shell.showTab('catalogue'); shell.showTab('companion');
  assert.equal(await companion.webContents.executeJavaScript('document.querySelector("input").value'), 'Modifié');
  const screenshot = process.argv.find(value => value.startsWith('--screenshot='))?.slice('--screenshot='.length);
  if (screenshot) { await delay(150); await fs.writeFile(path.resolve(screenshot), (await shell.window.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); }
  shell.setCompanionAvailable(false); await delay(100);
  assert.equal(await read('document.getElementById("companion-tab").hidden'), true);
  assert.equal(companion.getVisible(), false); assert.equal(shell.catalogueView.getVisible(), true);
  console.log('Desktop shell Electron smoke: local preload, login gate, native view bounds, persistent state and logout passed.');
}).catch(error => { failure = error; console.error(error); }).finally(async () => {
  shell?.dispose();
  if (companion && !companion.webContents.isDestroyed()) companion.webContents.close({ waitForBeforeUnload: false });
  if (shell && !shell.window.isDestroyed()) shell.window.destroy();
  // Chromium can hold profile files until process exit; leave this isolated
  // temporary profile to the OS rather than touching the user's real profile.
  app.exit(failure ? 1 : 0);
});
