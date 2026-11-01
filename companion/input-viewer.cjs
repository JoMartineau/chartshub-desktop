'use strict';
const path = require('node:path'), { pathToFileURL } = require('node:url');
const { assetPath } = require('./security.cjs');
const { createXInputSource } = require('./input-viewer-xinput.cjs');
const { createInputViewerOutputState } = require('./input-viewer-output-state.cjs');
const CHANNEL = 'companion:input-viewer', PAGE = 'chartshub-companion://app/ui/input-viewer.html', TITLE = 'ChartsHub — Input Viewer';
const OUTPUT_PAGE = 'chartshub-companion://app/ui/input-viewer-output.html', OUTPUT_CHANNEL = CHANNEL + ':output-snapshot';
const empty = value => value == null || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
function trusted(event, window) {
 return !!window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === PAGE;
}
function validSelection(value) {
 return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && Object.hasOwn(value, 'index') && (value.index === null || (Number.isInteger(value.index) && value.index >= 0 && value.index < 4));
}
/** Controller reading requires Start, then an explicit selection. Keyboard
 * reading stays in the focused renderer. No game integration or global hooks. */
async function createInputViewer({ root, active = () => true, language = () => 'fr', onChange = () => {}, electron = require('electron'), xinputFactory = createXInputSource }) {
 const { BrowserWindow, session, ipcMain, net } = electron, ses = session.fromPartition('persist:chartshub-input-viewer');
 const model = await import(pathToFileURL(path.join(root, 'ui/input-viewer-model.js')).href);
 const outputState = createInputViewerOutputState({ validateConfig: model.validateConfig, sampleControls: model.sampleControls });
 let window = null, opening = null, editorRevocation = null, outputWindow = null, outputOpening = null, outputEditing = true, outputAlwaysOnTop = true, outputIntent = 0, outputRevocation = null;
 let disposed = false, phase = 'stopped', revocation = null, windowsControllers = [], sourceError = null, windowsPending = false, run = 0, revision = 0;
 let inputMode = null, selectedSlot = null, browserSelection = 0, browserLease = null, configured = false, configReadyResolve;
 const configReady = new Promise(resolve => { configReadyResolve = resolve; });
 const alive = () => !disposed && active() === true;
 const status = () => ({ available: alive(), open: !!window && !window.isDestroyed(), phase, title: TITLE, language: language() === 'en' ? 'en' : 'fr', windowsControllers, sourceError, windowsPending, revision,
  outputOpen: !!outputWindow && !outputWindow.isDestroyed() && outputWindow.isVisible(), outputEditing, outputAlwaysOnTop });
 const snapshotOutput = () => { if (!alive()) { outputState.setRunning(false); hideOutput(); } return outputState.snapshot(); };
 const send = (suffix, value) => { if (window && !window.isDestroyed()) window.webContents.send(CHANNEL + suffix, value); };
 const sendState = () => { revision++; send(':state', status()); };
 const notify = () => { sendState(); onChange(); };
 const source = xinputFactory({
  onDevices(devices) { if (phase !== 'running' || !alive()) return; windowsPending = false; windowsControllers = devices; sendState(); },
  onSample(sample) { if (sample && phase === 'running' && alive()) { if (inputMode === 'native' && sample.index === selectedSlot && sample.selection === source.getSelection() && outputState.getSource() === 'gamepad') outputState.updateGamepad(sample); send(':input', { run, selection: sample.selection, sample }); } },
  onDisconnect(value) { if (phase === 'running' && alive()) { outputState.clear(); send(':disconnected', { run, ...value }); } },
  onError() { if (phase !== 'running' || !alive()) return; outputState.clear(); windowsPending = false; windowsControllers = []; sourceError = 'WINDOWS_CONTROLLER_UNAVAILABLE'; send(':input', null); sendState(); }
 });
 ses.setPermissionCheckHandler(() => false);
 ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
 await ses.protocol.handle('chartshub-companion', request => {
  const file = assetPath(root, request.url);
  return file && request.method === 'GET' ? net.fetch(pathToFileURL(file).href) : new Response('Not found', { status: 404 });
 });
 function stop(closeWindow = true) {
  phase = 'stopped'; source.stop(); inputMode = null; selectedSlot = null; browserLease = null; outputState.setRunning(false); windowsControllers = []; sourceError = null; windowsPending = false;
  if (revocation) clearInterval(revocation); revocation = null;
  send(':input', null); notify();
  if (closeWindow) hideOutput();
  if (closeWindow && window && !window.isDestroyed()) window.destroy();
 }
 ipcMain.handle(OUTPUT_CHANNEL, (event, payload) => {
  if (!alive() || !outputWindow || outputWindow.isDestroyed() || event.sender !== outputWindow.webContents || event.senderFrame !== outputWindow.webContents.mainFrame || event.senderFrame.url !== OUTPUT_PAGE || !empty(payload)) return { ok: false };
  return { ok: true, state: { ...snapshotOutput(), positioning: outputEditing } };
 });
 ipcMain.handle(CHANNEL, async (event, command, payload) => {
  if (!alive() || !trusted(event, window)) return { ok: false };
  if (command === 'configure') {
   if (!payload || Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'config')) return { ok: false };
   try { outputState.configure(payload.config); configured = true; configReadyResolve(); return { ok: true }; } catch { return { ok: false }; }
  }
  if (command === 'pressed') {
   if (phase !== 'running' || !payload || Object.keys(payload).length !== 3 || !['run','selection','pressed'].every(key => Object.hasOwn(payload,key)) || payload.run !== run || payload.selection !== browserLease || !['browser','keyboard'].includes(inputMode)) return { ok: false };
   return { ok: outputState.updatePressed(payload.pressed) };
  }
  if (command === 'showOutput') {
   if (!validOutputOptions(payload)) return { ok: false };
   await showOutput(payload); return { ok: true, state: status() };
  }
  if (command === 'hideOutput' && empty(payload)) { hideOutput(); return { ok: true, state: status() }; }
  if (command === 'close' && empty(payload)) { stop(true); return { ok: true }; }
  if (command === 'selectXInput') {
   if (phase !== 'running' || !validSelection(payload) || (payload.index !== null && !windowsControllers.some(device => device.index === payload.index))) return { ok: false };
   outputState.clear(); browserLease = null; selectedSlot = null; inputMode = null;
   const selected = source.select(payload.index);
   if (payload.index === null) { inputMode = outputState.getSource() === 'keyboard' ? 'keyboard' : 'browser'; browserLease = ++browserSelection; return { ok: true, run, selection: browserLease }; }
   if (selected !== false) { inputMode = 'native'; selectedSlot = payload.index; }
   return { ok: selected !== false, run, selection: source.getSelection() };
  }
  if (!['snapshot', 'start', 'stop'].includes(command) || !empty(payload)) return { ok: false };
  if (command === 'start' && phase !== 'running') {
   phase = 'running'; sourceError = null; windowsPending = true; run++; inputMode = null; selectedSlot = null; browserLease = null; outputState.setRunning(true);
   try { if (source.start() === false) windowsPending = false; } catch { windowsPending = false; sourceError = 'WINDOWS_CONTROLLER_UNAVAILABLE'; }
   revocation = setInterval(() => { if (!alive()) stop(true); }, 100); revocation.unref?.(); notify();
  } else if (command === 'stop') stop(false);
  return { ok: true, state: status() };
 });
 async function open({ show = true } = {}) {
  if (!alive()) return null; if (opening) { const pending = await opening; if (show && pending && !pending.isDestroyed()) { pending.show(); pending.focus(); } return pending; }
  if (window && !window.isDestroyed()) { if (show) { window.show(); window.focus(); } return window; }
  const task = (async () => {
   const next = new BrowserWindow({ width: 1120, height: 760, minWidth: 520, minHeight: 300, show: false, transparent: false, frame: true, resizable: true, alwaysOnTop: false, backgroundColor: '#0b1220', title: TITLE, autoHideMenuBar: true, webPreferences: { session: ses, preload: path.join(root, 'input-viewer-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false, additionalArguments: ['--chartshub-input-viewer-language=' + status().language] } });
   window = next; phase = 'stopped'; next.setMenuBarVisibility(false); next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
   next.webContents.on('will-navigate', (event, url) => { if (url !== PAGE) event.preventDefault(); });
   next.webContents.on('will-redirect', event => event.preventDefault()); next.webContents.on('will-attach-webview', event => event.preventDefault());
   next.webContents.on('render-process-gone', () => stop(true));
   next.webContents.on('did-start-loading', () => { phase = 'stopped'; source.stop(); inputMode = null; selectedSlot = null; browserLease = null; outputState.setRunning(false); windowsControllers = []; sourceError = null; if (revocation) clearInterval(revocation); revocation = null; onChange(); });
   next.once('closed', () => { if (window === next) { window = null; if (editorRevocation) clearInterval(editorRevocation); editorRevocation = null; phase = 'stopped'; source.stop(); inputMode = null; selectedSlot = null; browserLease = null; outputState.setRunning(false); windowsControllers = []; sourceError = null; if (revocation) clearInterval(revocation); revocation = null; hideOutput(); notify(); } });
   try { await next.loadURL(PAGE); if (!alive() || window !== next) { if (!next.isDestroyed()) next.destroy(); return null; } editorRevocation = setInterval(() => { if (!alive()) stop(true); },100); editorRevocation.unref?.(); if (show) { next.show(); next.focus(); } notify(); return next; }
   catch (error) { if (!next.isDestroyed()) next.destroy(); throw error; }
  })(); opening = task; try { return await task; } finally { if (opening === task) opening = null; }
 }
 function validOutputOptions(value) { return !!value && typeof value === 'object' && !Array.isArray(value) && [1,2].includes(Object.keys(value).length) && typeof value.editing === 'boolean' && Object.keys(value).every(key => ['editing','alwaysOnTop'].includes(key)) && (!Object.hasOwn(value,'alwaysOnTop') || typeof value.alwaysOnTop === 'boolean'); }
 const outputSession = session.fromPartition('chartshub-input-viewer-output');
 outputSession.setPermissionCheckHandler(() => false); outputSession.setPermissionRequestHandler((_web,_permission,callback) => callback(false));
 await outputSession.protocol.handle('chartshub-companion', request => { const file = assetPath(root, request.url); return file && request.method === 'GET' ? net.fetch(pathToFileURL(file).href) : new Response('Not found', { status: 404 }); });
 async function showOutput(options) {
  if (!alive() || !validOutputOptions(options)) return null;
  const ticket = ++outputIntent;
  outputEditing = options.editing; if (Object.hasOwn(options,'alwaysOnTop')) outputAlwaysOnTop = options.alwaysOnTop;
  if (!configured) { await open({ show: false }); await Promise.race([configReady, new Promise(resolve => setTimeout(resolve, 3000))]); }
  if (!alive() || !configured || ticket !== outputIntent) return null;
  if (outputOpening) await outputOpening;
  if (!alive() || ticket !== outputIntent) return null;
  if (!outputWindow || outputWindow.isDestroyed()) {
   const task = (async () => {
    const config = snapshotOutput().config;
    const area = electron.screen?.getDisplayMatching?.(window?.getBounds?.() ?? { x: 0, y: 0, width: 500, height: 300 })?.workAreaSize ?? { width: 1200, height: 800 };
    const width = Math.max(200, Math.min(500, config.width, area.width - 24)), height = Math.max(100, Math.min(Math.round(width / config.width * config.height) + 32, area.height - 24));
    const next = new BrowserWindow({ width, height, minWidth: 200, minHeight: 100, show: false, transparent: true, frame: false, resizable: true, backgroundColor: '#00000000', title: 'ChartsHub — Input Viewer · Jeu', skipTaskbar: true, webPreferences: { session: outputSession, preload: path.join(root,'input-viewer-output-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false, additionalArguments: ['--chartshub-input-viewer-language=' + status().language] } });
    outputWindow = next; next.setMenuBarVisibility(false); next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    next.webContents.on('will-navigate',(event,url) => { if (url !== OUTPUT_PAGE) event.preventDefault(); }); next.webContents.on('will-redirect',event => event.preventDefault()); next.webContents.on('will-attach-webview',event => event.preventDefault()); next.webContents.on('render-process-gone',() => { if (!next.isDestroyed()) next.destroy(); });
    next.once('closed',() => { if (outputWindow === next) { outputIntent++; outputWindow = null; if (outputRevocation) clearInterval(outputRevocation); outputRevocation = null; notify(); } });
    try { await next.loadURL(OUTPUT_PAGE); return next; } catch(error) { if (!next.isDestroyed()) next.destroy(); throw error; }
   })(); outputOpening = task; try { await task; } finally { if (outputOpening === task) outputOpening = null; }
  }
  if (!alive() || ticket !== outputIntent || !outputWindow || outputWindow.isDestroyed()) return null;
  outputWindow.setAlwaysOnTop(outputAlwaysOnTop, 'screen-saver'); outputWindow.setIgnoreMouseEvents(!outputEditing,{ forward: true }); outputWindow.setFocusable(outputEditing);
  if (!outputRevocation) { outputRevocation = setInterval(() => { if (!alive()) stop(true); }, 100); outputRevocation.unref?.(); }
  outputWindow.showInactive(); notify(); return outputWindow;
 }
 function hideOutput() { outputIntent++; if (outputRevocation) clearInterval(outputRevocation); outputRevocation = null; if (outputWindow && !outputWindow.isDestroyed()) outputWindow.hide(); notify(); }
 async function dispose() { if (disposed) return; disposed = true; stop(true); source.dispose(); await opening?.catch(() => {}); await outputOpening?.catch(() => {}); if (outputWindow && !outputWindow.isDestroyed()) outputWindow.destroy(); ipcMain.removeHandler(CHANNEL); ipcMain.removeHandler(OUTPUT_CHANNEL); await ses.protocol.unhandle('chartshub-companion'); await outputSession.protocol.unhandle('chartshub-companion'); }
 return { open, stop, dispose, status, snapshotOutput, showOutput, hideOutput, getWindow: () => window, getOutputWindow: () => outputWindow };
}
module.exports = { createInputViewer, trusted, validSelection, PAGE, TITLE, CHANNEL, OUTPUT_PAGE, OUTPUT_CHANNEL };
