'use strict';
const path = require('node:path'), { pathToFileURL } = require('node:url');
const { assetPath } = require('./security.cjs');
const { createXInputSource } = require('./input-viewer-xinput.cjs');
const CHANNEL = 'companion:input-viewer', PAGE = 'chartshub-companion://app/ui/input-viewer.html', TITLE = 'ChartsHub — Input Viewer';
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
 let window = null, opening = null, disposed = false, phase = 'stopped', revocation = null, windowsControllers = [], sourceError = null, windowsPending = false, run = 0, revision = 0;
 const alive = () => !disposed && active() === true;
 const status = () => ({ available: alive(), open: !!window && !window.isDestroyed(), phase, title: TITLE, language: language() === 'en' ? 'en' : 'fr', windowsControllers, sourceError, windowsPending, revision });
 const send = (suffix, value) => { if (window && !window.isDestroyed()) window.webContents.send(CHANNEL + suffix, value); };
 const sendState = () => { revision++; send(':state', status()); };
 const notify = () => { sendState(); onChange(); };
 const source = xinputFactory({
  onDevices(devices) { if (phase !== 'running' || !alive()) return; windowsPending = false; windowsControllers = devices; sendState(); },
  onSample(sample) { if (sample && phase === 'running' && alive()) send(':input', { run, selection: sample.selection, sample }); },
  onDisconnect(value) { if (phase === 'running' && alive()) send(':disconnected', { run, ...value }); },
  onError() { if (phase !== 'running' || !alive()) return; windowsPending = false; windowsControllers = []; sourceError = 'WINDOWS_CONTROLLER_UNAVAILABLE'; send(':input', null); sendState(); }
 });
 ses.setPermissionCheckHandler(() => false);
 ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
 await ses.protocol.handle('chartshub-companion', request => {
  const file = assetPath(root, request.url);
  return file && request.method === 'GET' ? net.fetch(pathToFileURL(file).href) : new Response('Not found', { status: 404 });
 });
 function stop(closeWindow = true) {
  phase = 'stopped'; source.stop(); windowsControllers = []; sourceError = null; windowsPending = false;
  if (revocation) clearInterval(revocation); revocation = null;
  send(':input', null); notify();
  if (closeWindow && window && !window.isDestroyed()) window.destroy();
 }
 ipcMain.handle(CHANNEL, (event, command, payload) => {
  if (!alive() || !trusted(event, window)) return { ok: false };
  if (command === 'selectXInput') {
   if (phase !== 'running' || !validSelection(payload) || (payload.index !== null && !windowsControllers.some(device => device.index === payload.index))) return { ok: false };
   const selected = source.select(payload.index); return { ok: payload.index === null || selected !== false, run, selection: source.getSelection() };
  }
  if (!['snapshot', 'start', 'stop'].includes(command) || !empty(payload)) return { ok: false };
  if (command === 'start' && phase !== 'running') {
   phase = 'running'; sourceError = null; windowsPending = true; run++;
   try { if (source.start() === false) windowsPending = false; } catch { windowsPending = false; sourceError = 'WINDOWS_CONTROLLER_UNAVAILABLE'; }
   revocation = setInterval(() => { if (!alive()) stop(true); }, 100); revocation.unref?.(); notify();
  } else if (command === 'stop') stop(false);
  return { ok: true, state: status() };
 });
 async function open() {
  if (!alive()) return null; if (opening) return opening;
  if (window && !window.isDestroyed()) { window.setAlwaysOnTop(true, 'screen-saver'); window.show(); window.focus(); return window; }
  const task = (async () => {
   const next = new BrowserWindow({ width: 1120, height: 760, minWidth: 520, minHeight: 300, show: false, transparent: true, alwaysOnTop: true, backgroundColor: '#00000000', title: TITLE, autoHideMenuBar: true, webPreferences: { session: ses, preload: path.join(root, 'input-viewer-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false, additionalArguments: ['--chartshub-input-viewer-language=' + status().language] } });
   window = next; phase = 'stopped'; next.setMenuBarVisibility(false); next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
   next.webContents.on('will-navigate', (event, url) => { if (url !== PAGE) event.preventDefault(); });
   next.webContents.on('will-redirect', event => event.preventDefault()); next.webContents.on('will-attach-webview', event => event.preventDefault());
   next.webContents.on('render-process-gone', () => stop(true));
   next.webContents.on('did-start-loading', () => { phase = 'stopped'; source.stop(); windowsControllers = []; sourceError = null; if (revocation) clearInterval(revocation); revocation = null; onChange(); });
   next.once('closed', () => { if (window === next) { window = null; phase = 'stopped'; source.stop(); windowsControllers = []; sourceError = null; if (revocation) clearInterval(revocation); revocation = null; onChange(); } });
   try { await next.loadURL(PAGE); if (!alive() || window !== next) { if (!next.isDestroyed()) next.destroy(); return null; } next.setAlwaysOnTop(true, 'screen-saver'); next.show(); next.focus(); notify(); return next; }
   catch (error) { if (!next.isDestroyed()) next.destroy(); throw error; }
  })(); opening = task; try { return await task; } finally { if (opening === task) opening = null; }
 }
 async function dispose() { if (disposed) return; disposed = true; stop(true); source.dispose(); ipcMain.removeHandler(CHANNEL); await opening?.catch(() => {}); await ses.protocol.unhandle('chartshub-companion'); }
 return { open, stop, dispose, status, getWindow: () => window };
}
module.exports = { createInputViewer, trusted, validSelection, PAGE, TITLE, CHANNEL };
