'use strict';
// Real renderer/protocol/preload, synthetic controller transport only. Never
// enumerates or samples the user's actual gamepads, keyboard, game or profile.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const outputArgument = process.argv.find(value => value.startsWith('--fixture-output='));
if (!outputArgument) throw Error('An explicit disposable output directory is required');
const directory = path.join(path.resolve(outputArgument.slice('--fixture-output='.length)), 'detection-' + randomUUID());
app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const archiveArgument = process.argv.find(value => value.startsWith('--fixture-asar='));
const archive = archiveArgument ? path.resolve(archiveArgument.slice('--fixture-asar='.length)) : null;
const root = archive ? path.join(archive, 'companion') : path.resolve(__dirname, '../companion');
require(path.join(root, 'host.cjs')).registerCompanionScheme();
const { createInputViewer, PAGE } = require(path.join(root, 'input-viewer.cjs'));
const checks = [], errors = [], sources = [], selectionAcks = [], externalRequests = [];
app.on('session-created', session => session.webRequest.onBeforeRequest((details, callback) => {
  const external = /^(?:https?|wss?):/i.test(details.url);
  if (external) externalRequests.push(details.url);
  callback({ cancel: external });
}));
let deferStartAck = null, deferSelectionAck = null;
const fixtureIpcMain = {
  handle(channel, handler) {
    ipcMain.handle(channel, async (...arguments_) => {
      const result = await handler(...arguments_);
      if (arguments_[1] === 'selectXInput' && result?.ok) selectionAcks.push(result);
      if (arguments_[1] === 'selectXInput' && deferSelectionAck) { const gate = deferSelectionAck; deferSelectionAck = null; await gate; }
      if (arguments_[1] === 'start' && deferStartAck) { const gate = deferStartAck; deferStartAck = null; await gate; }
      return result;
    });
  },
  removeHandler(channel) { ipcMain.removeHandler(channel); }
};
let service, window, rogue, contactSheetWindow, finished = false, authorized = true, cymbalRendering = null;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const evaluate = source => window.webContents.executeJavaScript(source);
async function until(action, description) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await action()) return; await delay(20); }
  throw Error('Timed out: ' + description);
}
async function check(name, action) { await action(); checks.push(name); console.log('PASS ' + name); }
const change = (id, value) => evaluate(`(() => { const node = document.getElementById(${JSON.stringify(id)}); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const device = { index: 0, id: 'xinput:0', name: 'Guitar · XInput 1', type: 1, subtype: 7, mapping: 'standard', buttonCount: 17, axisCount: 4 };
function xinputFactory(callbacks) {
  const transport = {
    callbacks, running: false, selected: null, starts: 0, stops: 0, selections: [], disposed: false, selection: 0,
    start() { this.running = true; this.starts++; queueMicrotask(() => { if (this.running) callbacks.onDevices([{ ...device }]); }); return true; },
    select(index) { if (!this.running || (index !== null && index !== 0)) return false; this.selection++; this.selected = index; this.selections.push(index); callbacks.onSample(null); return true; },
    getSelection() { return this.selection; },
    stop() { this.stops++; this.running = false; this.selected = null; callbacks.onSample(null); callbacks.onDevices([]); },
    dispose() { this.disposed = true; this.stop(); }
  };
  sources.push(transport);
  return transport;
}
const currentSource = () => sources[sources.length - 1];
const sample = pressed => ({ index: 0, id: 'xinput:0', selection: currentSource().getSelection(), connected: true, mapping: 'standard', timestamp: 1,
  buttons: Array.from({ length: 17 }, (_, index) => ({ pressed: pressed && index === 0, touched: pressed && index === 0, value: pressed && index === 0 ? 1 : 0 })), axes: [0, 0, 0, 0] });
async function injectBrowserGamepads() {
  await evaluate(`(() => { window.fixtureGamepadReads = 0; Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => { window.fixtureGamepadReads++; return []; } }); return true; })()`);
}
async function start() { await evaluate("document.getElementById('start').click()"); await until(() => service.status().phase === 'running', 'explicit start'); }
async function stop() { await evaluate("document.getElementById('stop').click()"); await until(() => service.status().phase === 'stopped', 'explicit stop'); }
async function selectWindowsController() {
  await until(() => evaluate("Array.from(document.getElementById('device').options).some(option => /XInput/i.test(option.textContent))"), 'Windows guitar option');
  const value = await evaluate("Array.from(document.getElementById('device').options).find(option => /XInput/i.test(option.textContent)).value");
  await change('device', value);
  await until(() => currentSource().selected === 0, 'explicit Windows guitar selection');
  await delay(30);
}
async function captureStyleContactSheet() {
  const styles = ['cyberpunk', 'metal', 'minimal', 'hologram', 'arcade', 'glass', 'wireframe', 'energy', 'plasma', 'crystal', 'synthwave', 'industrial'];
  const previews = [];
  for (const style of styles) {
    await change('render-style', style);
    for (const down of [false, true]) {
      currentSource().callbacks.onSample(sample(down));
      await until(() => evaluate(`document.getElementById('viewer').dataset.active === ${JSON.stringify(down ? 'cymbal0 cymbal1 cymbal2' : '')}`), 'style preview ' + style);
      if (down) await delay(160);
      const clip = await evaluate("(() => {const box=document.getElementById('viewer').getBoundingClientRect();return {x:Math.round(box.x),y:Math.round(box.y),width:Math.round(box.width),height:Math.round(box.height)};})()");
      const png = (await window.webContents.capturePage(clip)).toPNG();
      const filename = 'style-' + style + (down ? '-pressed.png' : '-idle.png');
      await fs.writeFile(path.join(directory, filename), png);
      previews.push({ style, down, filename, image: png.toString('base64') });
    }
  }
  await change('render-style', 'glass');
  const html = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'"><style>*{box-sizing:border-box}body{margin:0;padding:20px;background:#080d19;color:#e8f4ff;font:14px system-ui}h1{font-size:22px;margin:0 0 6px}p{margin:0 0 14px;color:#adc3dd}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.tile{margin:0;border:1px solid #34465f;border-radius:8px;overflow:hidden;background:#0e1728}.tile div{padding:6px 10px;font-weight:600}.tile img{display:block;width:100%;height:auto}</style><h1>ChartsHub — Input Viewer · 12 styles</h1><p>Au repos / à l’appui · Entrées simulées, aucun périphérique réel lu.</p><main class="grid">' +
    previews.map(preview => '<section class="tile"><div>' + preview.style + (preview.down ? ' · À l’appui' : ' · Au repos') + '</div><img src="data:image/png;base64,' + preview.image + '"></section>').join('') + '</main>';
  const htmlPath = path.join(directory, 'styles-contact-sheet.html'); await fs.writeFile(htmlPath, html);
  contactSheetWindow = new BrowserWindow({ show: false, width: 1600, height: 900, useContentSize: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  await contactSheetWindow.loadFile(htmlPath);
  await contactSheetWindow.webContents.executeJavaScript('Promise.all(Array.from(document.images,image=>image.decode()))');
  const height = await contactSheetWindow.webContents.executeJavaScript('Math.ceil(document.documentElement.scrollHeight)');
  contactSheetWindow.setContentSize(1600, height); await delay(50);
  await fs.writeFile(path.join(directory, 'styles-contact-sheet.png'), (await contactSheetWindow.webContents.capturePage()).toPNG());
  contactSheetWindow.destroy(); contactSheetWindow = null;
  return previews.length;
}
const deadline = setTimeout(() => void finish(Error('Detection fixture timed out')), 80000);
async function finish(error) {
  if (finished) return; finished = true; clearTimeout(deadline);
  if (error) console.error(error.stack || error);
  try { if (error && window && !window.isDestroyed()) await fs.writeFile(path.join(directory, 'failure.png'), (await window.webContents.capturePage()).toPNG()); rogue?.destroy(); contactSheetWindow?.destroy(); await service?.dispose(); assert.equal(BrowserWindow.getAllWindows().length, 0); }
  catch (cleanupError) { error ||= cleanupError; }
  await fs.mkdir(directory, { recursive: true });
  const report = { result: error ? 'failed' : 'passed', checks, errors, error: error ? String(error.stack || error) : null,
    archive, loadedFromAsar: !!archive, productRoot: archive || path.dirname(root), externalRequests,
    electron: process.versions.electron, chrome: process.versions.chrome, cymbalRendering,
    defaultRendererSecurity: true, syntheticGamepads: true, syntheticWindowsTransport: true,
    realInputRead: false, realDevicesRead: false, realGameRead: false, realProfileRead: false };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, result: report.result, checks: checks.length })); app.exit(error ? 1 : 0);
}
process.on('uncaughtException', error => void finish(error));
process.on('unhandledRejection', error => void finish(error));
app.whenReady().then(async () => {
  await fs.mkdir(directory, { recursive: true });
  class PassiveWindow extends BrowserWindow {
    constructor(options) {
      super(options);
      this.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
    }
    show() { this.showInactive(); }
    focus() {}
  }
  service = await createInputViewer({ root, electron: { ...require('electron'), BrowserWindow: PassiveWindow, ipcMain: fixtureIpcMain }, xinputFactory, active: () => authorized });
  window = await service.open();
  await until(() => evaluate("document.getElementById('element').options.length > 0"), 'viewer initialization');
  await check('Production custom origin is secure and permits the real Gamepad interface without sampling any device', async () => {
    const context = await evaluate("({secure:isSecureContext,origin:location.origin,gamepad:typeof Gamepad,getGamepads:typeof navigator.getGamepads,allowed:(document.permissionsPolicy||document.featurePolicy).allowsFeature('gamepad')})");
    assert.deepEqual(context, { secure: true, origin: 'chartshub-companion://app', gamepad: 'function', getGamepads: 'function', allowed: true });
    assert.equal(service.status().phase, 'stopped');
    assert(sources.every(source => source.starts === 0));
    await injectBrowserGamepads();
  });
  await check('Visual demo animates controls and trails locally without starting or reading any controller, and Stop clears it', async () => {
    await evaluate("document.getElementById('demo').click()");
    await until(() => evaluate("document.getElementById('viewer').dataset.active!==''&&Number(document.getElementById('viewer').dataset.trailCount)>0"), 'local visual demo');
    assert.equal(service.status().phase, 'stopped');
    assert(sources.every(source => source.starts === 0));
    assert.equal(await evaluate('window.fixtureGamepadReads'), 0);
    await fs.writeFile(path.join(directory, 'visual-demo-fr.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate("document.getElementById('stop').click()"); await delay(70);
    assert.equal(await evaluate("document.getElementById('viewer').dataset.active"), '');
    assert.equal(await evaluate("document.getElementById('viewer').dataset.trailCount"), '0');
    await evaluate("document.getElementById('demo').click()");
    await until(() => evaluate("document.getElementById('viewer').dataset.active!==''"), 'demo restarted locally');
    await evaluate("document.getElementById('demo').click()"); await delay(70);
    assert.equal(await evaluate("document.getElementById('viewer').dataset.active"), '');
    assert.equal(await evaluate('window.fixtureGamepadReads'), 0);
  });
  await check('An empty browser list still offers the Windows guitar after Start, without sampling it before selection', async () => {
    const early = await evaluate('window.ChartsHubInputViewer.selectController(0)'); assert.equal(early.ok, false);
    await evaluate("document.getElementById('demo').click()");
    await start();
    await until(() => currentSource()?.starts === 1, 'Windows source started');
    await until(() => evaluate("Array.from(document.getElementById('device').options).some(option => /XInput/i.test(option.textContent))"), 'fallback enumeration');
    assert.equal(currentSource().selected, null);
    await delay(70);
    assert.equal(await evaluate("document.getElementById('viewer').dataset.active"), '');
    await change('kind', 'button'); await change('index', '0');
    await selectWindowsController();
  });
  await check('Only explicitly mapped Windows input animates, and no device identity or input history is persisted', async () => {
    currentSource().callbacks.onSample(sample(true));
    await until(() => evaluate("document.getElementById('viewer').dataset.active==='fret0'"), 'Windows mapped fret');
    await delay(360);
    assert(Number(await evaluate("document.getElementById('viewer').dataset.trailCount")) > 0);
    const saved = await evaluate("JSON.parse(localStorage.getItem('chartshub:input-viewer-config-v2'))");
    assert(!/xinput:|Guitar · XInput|pressed|timestamp|packet/i.test(JSON.stringify(saved)));
    await fs.writeFile(path.join(directory, 'windows-guitar.png'), (await window.webContents.capturePage()).toPNG());
  });
  await check('A second unowned window cannot start or select the owned viewer controller', async () => {
    rogue = new BrowserWindow({ show: false, webPreferences: { session: window.webContents.session, preload: path.join(root, 'input-viewer-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    await rogue.loadURL(PAGE);
    const result = await rogue.webContents.executeJavaScript("Promise.all([window.ChartsHubInputViewer.command('start'),window.ChartsHubInputViewer.selectController(0)])");
    assert(result.every(value => value.ok === false));
    assert.equal(currentSource().starts, 1); assert.equal(currentSource().selected, 0);
    rogue.destroy(); rogue = null;
  });
  await check('Disconnection before the first sample clears selection and stale queued samples cannot animate a new selection', async () => {
    const oldAck = selectionAcks[selectionAcks.length - 1], oldSample = sample(true);
    await change('device', ''); await selectWindowsController();
    const source = currentSource(), disconnectedLease = source.getSelection();
    source.selected = null; source.callbacks.onDisconnect({ index: 0, selection: disconnectedLease });
    await until(() => evaluate("document.getElementById('device').value === ''"), 'disconnect before first sample');
    assert.equal(await evaluate("document.getElementById('viewer').dataset.active"), '');
    await selectWindowsController();
    window.webContents.send('companion:input-viewer:input', { run: oldAck.run, selection: oldAck.selection, sample: oldSample });
    await delay(80);
    assert.equal(await evaluate("document.getElementById('viewer').dataset.active"), '');
    source.callbacks.onSample(sample(true));
    await until(() => evaluate("document.getElementById('viewer').dataset.active === 'fret0'"), 'new selection current sample');
  });
  await check('A disconnect received before a delayed selection acknowledgement cannot restore that disconnected guitar', async () => {
    await change('device', ''); await delay(30);
    let release; deferSelectionAck = new Promise(resolve => { release = resolve; });
    await change('device', 'windows:0');
    await until(() => currentSource().selected === 0, 'selection acknowledged in main but delayed to renderer');
    const source = currentSource(), selection = source.getSelection();
    source.selected = null; source.callbacks.onDisconnect({ index: 0, selection });
    await delay(25); release(); await delay(80);
    assert.equal(await evaluate("document.getElementById('device').value"), '');
    assert.equal(await evaluate("document.getElementById('viewer').dataset.active"), '');
    await selectWindowsController();
  });
  await check('Disconnect clears highlights and trails, and a reconnected guitar is never selected automatically', async () => {
    const source = currentSource();
    source.callbacks.onSample(sample(true));
    await until(() => evaluate("document.getElementById('viewer').dataset.active === 'fret0'"), 'pressed before disconnect');
    source.callbacks.onDisconnect({ index: 0, selection: source.getSelection() }); source.selected = null; source.callbacks.onDevices([]);
    await until(() => evaluate("document.getElementById('device').value===''&&document.getElementById('viewer').dataset.active===''&&document.getElementById('viewer').dataset.trailCount==='0'"), 'disconnect clears');
    source.callbacks.onDevices([{ ...device }]);
    await delay(90); assert.equal(await evaluate("document.getElementById('device').value"), '');
    assert.equal(await evaluate("document.getElementById('viewer').dataset.active"), '');
    await selectWindowsController();
  });
  await check('Stop rejects late samples, clears trails, and disables controller selection until another Start', async () => {
    const source = currentSource(); await stop(); const selections = source.selections.length;
    source.callbacks.onSample(sample(true)); source.callbacks.onDevices([{ ...device }]); await delay(100);
    assert.equal(await evaluate("document.getElementById('viewer').dataset.active"), '');
    assert.equal(await evaluate("document.getElementById('viewer').dataset.trailCount"), '0');
    assert.equal((await evaluate('window.ChartsHubInputViewer.selectController(0)')).ok, false);
    assert.equal(source.selections.length, selections);
  });
  await check('Reload stops the native transport and restores configuration without resuming any input reads', async () => {
    await start(); await selectWindowsController();
    const before = currentSource();
    await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload(); });
    await until(() => evaluate("document.getElementById('element').options.length > 0"), 'reloaded viewer');
    assert.equal(service.status().phase, 'stopped'); assert.equal(before.running, false);
    assert.equal(await evaluate("document.getElementById('viewer').dataset.active"), '');
    await injectBrowserGamepads(); assert.equal(await evaluate('window.fixtureGamepadReads'), 0);
    assert.equal(await evaluate("document.getElementById('kind').value"), 'button');
  });
  await check('A delayed Start acknowledgement cannot restart polling after the player cancels the start', async () => {
    let release; deferStartAck = new Promise(resolve => { release = resolve; });
    const source = currentSource(), startsBefore = source.starts;
    await evaluate("document.getElementById('start').click(); document.getElementById('start').click()");
    await until(() => source.starts === startsBefore + 1, 'one start while acknowledgement delayed');
    await evaluate("document.getElementById('stop').dispatchEvent(new MouseEvent('click', {bubbles:true}))");
    await until(() => service.status().phase === 'stopped', 'stop while acknowledgement delayed');
    release(); await delay(100);
    assert.equal(source.starts, startsBefore + 1); assert.equal(source.running, false);
    assert.equal(await evaluate("document.getElementById('start').disabled"), false);
    assert.equal(await evaluate("document.getElementById('stop').disabled"), true);
    const reads = await evaluate('window.fixtureGamepadReads'); await delay(70);
    assert.equal(await evaluate('window.fixtureGamepadReads'), reads);
  });
  await check('The editable five-pad drum layout also animates from the selected Windows controller', async () => {
    await change('preset', 'drums5'); await change('kind', 'button'); await change('index', '0');
    await start(); await selectWindowsController(); currentSource().callbacks.onSample(sample(true));
    await until(() => evaluate("document.getElementById('viewer').dataset.active==='pad0'"), 'Windows drum pad');
    await delay(360);
    await fs.writeFile(path.join(directory, 'windows-drums-fr.png'), (await window.webContents.capturePage()).toPNG());
    await stop(); await change('preset', 'guitar');
  });
  await check('Cymbal rendering, display style, independent colors and multiple visibility choices survive a complete configuration reload', async () => {
    await change('preset', 'drums5');
    const defaults = await evaluate("JSON.parse(localStorage.getItem('chartshub:input-viewer-config-v2')).controls.filter(control => control.id.startsWith('cymbal'))");
    assert.equal(defaults.length, 3);
    assert(defaults.every(control => control.shape === 'cymbal'));
    assert.equal(await evaluate("Array.from(document.getElementById('shape').options).some(option => option.value === 'cymbal')"), true);
    assert.equal(await evaluate("Array.from(document.getElementById('shape').options).some(option => option.value === 'star')"), true);
    assert.equal(await evaluate("JSON.parse(localStorage.getItem('chartshub:input-viewer-config-v2')).controls.find(control=>control.id==='power').shape"), 'star');
    await change('element', 'power'); await change('label', 'Puissance Démo'); await change('color', '#20c8f0');
    const powerBefore = await evaluate("JSON.parse(localStorage.getItem('chartshub:input-viewer-config-v2')).controls.find(control=>control.id==='power')");
    await change('element', 'cymbal0');
    const originalBloom = await evaluate("document.getElementById('bloom').value");
    await change('bloom', '0');
    const opaquePixels = () => evaluate(`(() => {
      const config = JSON.parse(localStorage.getItem('chartshub:input-viewer-config-v2'));
      const control = config.controls.find(value => value.id === 'cymbal0');
      const canvas = document.getElementById('viewer'), context = canvas.getContext('2d');
      const scaleX = canvas.width / config.width, scaleY = canvas.height / config.height;
      const pixels = context.getImageData(Math.round(control.x * scaleX), Math.round(control.y * scaleY), Math.round(control.width * scaleX), Math.round(control.height * scaleY)).data;
      let opaque = 0; for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 220) opaque++;
      return opaque;
    })()`);
    await change('shape', 'rect'); const rectangle = await opaquePixels();
    await change('shape', 'cymbal'); const cymbal = await opaquePixels();
    assert(rectangle > 0 && cymbal > 0, 'Both selectable styles must actually render');
    assert(cymbal < rectangle * .8, 'The disc must leave substantially more transparent space than a full rectangular button');
    await change('bloom', originalBloom);
    assert.equal(await evaluate("document.getElementById('grid-snap').checked"), true);
    assert.equal(await evaluate("document.getElementById('grid-visible').checked"), true);
    await change('grid-size', '16');
    await evaluate("document.getElementById('grid-snap').click()");
    await change('x', '201');
    const freePlacement = await evaluate("JSON.parse(localStorage.getItem('chartshub:input-viewer-config-v2'))");
    assert.deepEqual(freePlacement.grid, { enabled: false, visible: true, size: 16 }, 'Showing the grid must not force snapping');
    assert.equal(freePlacement.controls.find(control => control.id === 'cymbal0').x, 201, 'Free placement must preserve the requested position while the grid remains visible');
    assert.equal(await evaluate("document.getElementById('grid-visible').checked"), true);
    await evaluate("document.getElementById('grid-snap').click()");
    await change('x', '201'); await change('y', '57'); await change('color', '#e040b0');
    assert.equal(await evaluate("document.getElementById('x').value"), '208');
    assert.equal(await evaluate("document.getElementById('y').value"), '64');
    await change('label', 'Cymbale Démo'); await change('pad-width', '140'); await change('pad-height', '68');
    const styles = await evaluate("Array.from(document.getElementById('render-style').options).map(option => option.value)");
    for (const style of ['cyberpunk', 'metal', 'minimal', 'hologram', 'arcade', 'glass', 'wireframe', 'energy', 'plasma', 'crystal', 'synthwave', 'industrial']) assert(styles.includes(style), 'Display style missing: ' + style);
    await change('render-style', 'glass');
    await change('idle-color', '#7a5c29'); await change('label-color', '#e9d4ff');
    await evaluate("document.getElementById('trail-follow').checked=false; document.getElementById('trail-follow').dispatchEvent(new Event('change',{bubbles:true}))");
    await change('trail-color', '#a56cff');
    await change('control-trail-direction', 'right');
    await change('element', 'cymbal1'); await change('control-trail-direction', 'left'); await change('element', 'cymbal0');
    const visibility = (id, visible) => evaluate(`(() => {
      const selector = '#controls-list input[type="checkbox"][data-control="' + ${JSON.stringify(id)} + '"]';
      const checkbox = document.querySelector(selector); if (!checkbox) throw Error('Visibility control missing');
      if (checkbox.checked !== ${JSON.stringify(visible)}) checkbox.click();
      return document.querySelector(selector).checked;
    })()`);
    assert.equal(await visibility('pad1', false), false); assert.equal(await visibility('pad3', false), false);
    const custom = await evaluate("JSON.parse(localStorage.getItem('chartshub:input-viewer-config-v2'))");
    assert.equal(custom.renderStyle, 'glass');
    assert.deepEqual(custom.grid, { enabled: true, visible: true, size: 16 });
    assert.deepEqual(custom.controls.find(control => control.id === 'power'), powerBefore, 'Editing another control must preserve the customized power star');
    assert.deepEqual(custom.controls.find(control => control.id === 'cymbal0').palette, { idle: '#7a5c29', trail: '#a56cff', label: '#e9d4ff' });
    assert.deepEqual(custom.controls.filter(control => control.id.startsWith('cymbal')).map(control => control.trailDirection), ['right', 'left', null]);
    assert(custom.controls.filter(control => ['pad1', 'pad3'].includes(control.id)).every(control => control.visible === false));
    assert.deepEqual(Object.fromEntries(['shape', 'x', 'y', 'color', 'label', 'width', 'height'].map(key => [key, custom.controls.find(control => control.id === 'cymbal0')[key]])),
      { shape: 'cymbal', x: 208, y: 64, color: '#e040b0', label: 'Cymbale Démo', width: 140, height: 68 });
    await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload(); });
    await until(() => evaluate("document.getElementById('element').options.length === 10"), 'custom cymbal layout restored');
    await injectBrowserGamepads();
    const restored = await evaluate("JSON.parse(localStorage.getItem('chartshub:input-viewer-config-v2'))");
    assert.deepEqual(restored, custom, 'Reload must preserve the complete customized configuration');
    await change('element', 'cymbal0');
    assert.equal(await evaluate("document.getElementById('shape').value"), 'cymbal');
    assert.equal(await evaluate("document.getElementById('color').value"), '#e040b0');
    assert.equal(await evaluate("document.getElementById('render-style').value"), 'glass');
    assert.equal(await evaluate("document.getElementById('idle-color').value"), '#7a5c29');
    assert.equal(await evaluate("document.getElementById('trail-color').value"), '#a56cff');
    assert.equal(await evaluate("document.getElementById('label-color').value"), '#e9d4ff');
    assert.equal(await evaluate("document.getElementById('control-trail-direction').value"), 'right');
    assert.equal(await evaluate("document.getElementById('grid-snap').checked"), true);
    assert.equal(await evaluate("document.getElementById('grid-visible').checked"), true);
    assert.equal(await evaluate("document.getElementById('grid-size').value"), '16');
    assert.equal(await visibility('pad1', false), false); assert.equal(await visibility('pad3', false), false);
    assert.equal(await visibility('pad3', true), true);
    assert.equal((await evaluate("JSON.parse(localStorage.getItem('chartshub:input-viewer-config-v2'))")).controls.find(control => control.id === 'pad3').visible, true);
    for (const id of ['cymbal0', 'cymbal1', 'cymbal2']) { await change('element', id); await change('kind', 'button'); await change('index', '0'); }
    await start(); await selectWindowsController(); currentSource().callbacks.onSample(sample(true));
    await until(() => evaluate("document.getElementById('viewer').dataset.active === 'cymbal0 cymbal1 cymbal2'"), 'three simulated cymbals respond');
    const stylePreviewCount = await captureStyleContactSheet();
    currentSource().callbacks.onSample(sample(true));
    await until(() => evaluate("document.getElementById('viewer').dataset.active === 'cymbal0 cymbal1 cymbal2'"), 'restored glass preview');
    await delay(340);
    assert(Number(await evaluate("document.getElementById('viewer').dataset.trailCount")) > 0);
    cymbalRendering = { rectangleOpaquePixels: rectangle, cymbalOpaquePixels: cymbal, customizedConfigurationPreserved: true, renderStyle: 'glass', independentColorsPreserved: true, multipleVisibilityChoicesPreserved: true, perControlTrailDirectionsPreserved: true, customizedPowerStarPreserved: true, visibleGridWithoutSnappingVerified: true, numericGridSnappingVerified: true, stylePreviewCount };
    await fs.writeFile(path.join(directory, 'windows-cymbals-soft-glow-fr.png'), (await window.webContents.capturePage()).toPNG());
    await stop(); await change('preset', 'guitar');
  });
  await check('Losing host authorization stops the selected controller and closes the viewer', async () => {
    await start(); await selectWindowsController(); const source = currentSource(); authorized = false;
    await until(() => window.isDestroyed(), 'host revocation');
    assert.equal(source.running, false); assert.equal(service.status().phase, 'stopped');
    assert.deepEqual(errors, []);
  });
  await check('English detection controls and the redesigned preview stay available with local settings preserved', async () => {
    await service.dispose(); authorized = true;
    service = await createInputViewer({ root, electron: { ...require('electron'), BrowserWindow: PassiveWindow, ipcMain: fixtureIpcMain }, xinputFactory, language: () => 'en', active: () => authorized });
    window = await service.open();
    await until(() => evaluate("document.getElementById('element').options.length > 0"), 'English viewer');
    await injectBrowserGamepads();
    assert.equal(await evaluate('document.documentElement.lang'), 'en');
    assert.equal(await evaluate("document.getElementById('start').textContent"), 'Start');
    assert.equal(await evaluate('window.fixtureGamepadReads'), 0);
    await change('preset', 'guitar'); await change('kind', 'button'); await change('index', '0');
    await start(); await selectWindowsController(); currentSource().callbacks.onSample(sample(true));
    await until(() => evaluate("document.getElementById('viewer').dataset.active==='fret0'"), 'English Windows guitar');
    await delay(360);
    await fs.writeFile(path.join(directory, 'windows-guitar-en.png'), (await window.webContents.capturePage()).toPNG());
    await stop();
  });
  await finish();
}).catch(error => void finish(error));
