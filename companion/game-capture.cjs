'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { assetPath } = require('./security.cjs');
const CHANNEL = 'companion:game-capture';
const ORIGIN = 'chartshub-companion://app';
const PAGES = { controller: `${ORIGIN}/ui/game-capture.html`, highway: `${ORIGIN}/ui/game-capture-output.html`, score: `${ORIGIN}/ui/game-capture-output.html`, lyrics: `${ORIGIN}/ui/game-capture-output.html` };
const TITLES = { highway: 'ChartsHub — Highway', score: 'ChartsHub — Score', lyrics: 'ChartsHub — Paroles' };
const emptyCrops = () => Object.fromEntries(Object.keys(TITLES).map(kind => [kind, null]));
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
function validCrop(v) {
  return exact(v, ['x','y','width','height']) && Object.values(v).every(n => Number.isFinite(n) && n >= 0 && n <= 1)
    && v.width >= .001 && v.height >= .001 && v.x + v.width <= 1.00000001 && v.y + v.height <= 1.00000001;
}
function validSignal(v) {
  if (!object(v)) return false;
  if (exact(v, ['description'])) return exact(v.description, ['type','sdp']) && ['offer','answer'].includes(v.description.type)
    && typeof v.description.sdp === 'string' && v.description.sdp.length <= 65536;
  return exact(v, ['candidate']) && exact(v.candidate, ['candidate','sdpMid','sdpMLineIndex','usernameFragment'])
    && typeof v.candidate.candidate === 'string' && v.candidate.candidate.length <= 2048
    && (v.candidate.sdpMid === null || typeof v.candidate.sdpMid === 'string' && v.candidate.sdpMid.length <= 80)
    && (v.candidate.sdpMLineIndex === null || Number.isInteger(v.candidate.sdpMLineIndex) && v.candidate.sdpMLineIndex >= 0 && v.candidate.sdpMLineIndex < 8)
    && (v.candidate.usernameFragment === null || typeof v.candidate.usernameFragment === 'string' && v.candidate.usernameFragment.length <= 256);
}
function candidates(sources) {
  return sources.filter(s => /^window:\d+:0$/.test(s.id) && /\bclone\s*hero\b/i.test(s.name));
}
function trusted(event, window, page) {
  return !!window && !window.isDestroyed() && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === page;
}
function captureRequestAllowed(request, contents, selected, enabled) {
  return enabled && /^window:\d+:0$/.test(selected?.id) && !!contents && !contents.isDestroyed() && request.frame === contents.mainFrame
    && request.frame?.url === PAGES.controller && request.securityOrigin === ORIGIN && request.userGesture === true
    && request.videoRequested === true && request.audioRequested === false;
}

/** Capture lives in its own in-memory session. Existing Companion permissions stay untouched.
 * Only one user-selected window is granted, only to the owned controller main frame.
 * No desktop source, microphone, recording, external server or automatic title rebinding. */
async function createGameCapture({ root, onChange = () => {}, active = () => true, language = () => 'fr', electron = require('electron') }) {
  const { BrowserWindow, desktopCapturer, session, ipcMain, net } = electron;
  const ses = session.fromPartition('chartshub-game-capture');
  let controller = null, controllerTask = null, disposed = false, selected = null, sources = [];
  let phase = 'stopped', revision = 0, dimensions = null, error = null, monitor = null, startTimer = null;
  let crops = emptyCrops();
  const outputs = new Map(), outputTasks = new Map();
  const alive = () => !disposed && active();
  const state = () => ({ phase, selected: selected ? { name: selected.name } : null, dimensions, crops: structuredClone(crops), revision,
    error, language: language(), outputs: Object.fromEntries(Object.keys(TITLES).map(kind => [kind, { title: TITLES[kind], open: !!outputs.get(kind) && !outputs.get(kind).isDestroyed() }])) });
  function notify() {
    const value = state();
    if (controller && !controller.isDestroyed()) controller.webContents.send(`${CHANNEL}:state`, value);
    onChange();
  }
  function role(event) {
    if (trusted(event, controller, PAGES.controller)) return 'controller';
    for (const [kind, window] of outputs) if (trusted(event, window, PAGES[kind])) return kind;
    return null;
  }
  function stop(reason = null, closeController = false) {
    revision++; phase = 'stopped'; dimensions = null; error = reason; selected = null; sources = []; crops = emptyCrops();
    if (monitor) clearInterval(monitor); monitor = null;
    if (startTimer) clearTimeout(startTimer); startTimer = null;
    for (const window of outputs.values()) if (!window.isDestroyed()) window.destroy();
    outputs.clear(); outputTasks.clear();
    if (controller && !controller.isDestroyed()) {
      controller.webContents.send(`${CHANNEL}:stop`);
      if (closeController) controller.destroy();
    }
    notify();
  }
  const canCapture = (web, permission, origin, details) => permission === 'display-capture' && alive() && !!selected
    && controller && !controller.isDestroyed() && web === controller.webContents && web.mainFrame.url === PAGES.controller
    && details?.isMainFrame === true && (details.requestingUrl === undefined || details.requestingUrl === PAGES.controller)
    && (origin === undefined || origin === ORIGIN || origin === ORIGIN + '/');
  ses.setPermissionCheckHandler((web, permission, origin, details) => !!canCapture(web, permission, origin, details));
  ses.setPermissionRequestHandler((web, permission, callback, details) => callback(!!canCapture(web, permission, undefined, details)));
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const contents = controller?.webContents, ticket = revision;
    if (phase !== 'stopped' || !captureRequestAllowed(request, contents, selected, alive())) return callback(null);
    phase = 'starting'; error = null;
    startTimer = setTimeout(() => { if (ticket === revision && phase === 'starting') stop('capture-unavailable'); }, 15000); startTimer.unref?.();
    try {
      const current = candidates(await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }));
      const source = current.find(s => s.id === selected?.id && s.name === selected?.name);
      if (!source || ticket !== revision || !captureRequestAllowed(request, contents, selected, alive())) {
        if (ticket === revision) stop('window-unavailable');
        return callback(null);
      }
      callback({ video: source }); notify();
    } catch { if (ticket === revision) stop('capture-unavailable'); callback(null); }
  });
  ses.on('will-download', event => event.preventDefault());
  await ses.protocol.handle('chartshub-companion', request => {
    const filename = assetPath(root, request.url);
    return filename && request.method === 'GET' ? net.fetch(pathToFileURL(filename).href) : new Response('Not found', { status: 404 });
  });
  function createWindow(kind) {
    const output = kind !== 'controller';
    const window = new BrowserWindow({ width: output ? 420 : 1000, height: output ? 480 : 780,
      minWidth: output ? 120 : 650, minHeight: output ? 80 : 500, show: false,
      title: output ? TITLES[kind] : 'ChartsHub — Capture Clone Hero', backgroundColor: '#10121a',
      frame: true, autoHideMenuBar: true,
      webPreferences: { session: ses, preload: path.join(root, 'game-capture-preload.cjs'), contextIsolation: true, nodeIntegration: false,
        sandbox: true, webSecurity: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
        additionalArguments: [`--chartshub-capture-role=${kind}`] } });
    window.setMenuBarVisibility(false);
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => { if (url !== PAGES[kind]) event.preventDefault(); });
    contents.on('will-redirect', event => event.preventDefault());
    contents.on('will-attach-webview', event => event.preventDefault());
    if (kind === 'controller') contents.on('did-start-loading', () => { if (controller === window && phase !== 'stopped') stop(); });
    contents.on('render-process-gone', () => { if (kind === 'controller') stop('capture-unavailable', true); else if (!window.isDestroyed()) window.destroy(); });
    window.on('closed', () => {
      if (kind === 'controller' && controller === window) { controller = null; selected = null; sources = []; stop(); }
      else if (outputs.get(kind) === window) {
        outputs.delete(kind);
        controller?.webContents.send(`${CHANNEL}:output-closed`, kind); notify();
      }
    });
    return window;
  }
  async function open() {
    if (!alive()) throw Error('Capture unavailable');
    if (controllerTask) return controllerTask;
    if (controller && !controller.isDestroyed()) { controller.show(); controller.focus(); return; }
    const window = createWindow('controller'); controller = window;
    controllerTask = window.loadURL(PAGES.controller).then(() => { if (alive() && controller === window && !window.isDestroyed()) { window.show(); window.focus(); } })
      .catch(error => { if (!window.isDestroyed()) window.destroy(); throw error; }).finally(() => { controllerTask = null; });
    return controllerTask;
  }
  async function openOutput(kind) {
    if (!alive() || phase !== 'capturing' || !crops[kind]) throw Error('Select a region first');
    if (outputTasks.has(kind)) return outputTasks.get(kind);
    const existing = outputs.get(kind);
    if (existing && !existing.isDestroyed()) { existing.show(); return; }
    const ticket = revision, window = createWindow(kind); outputs.set(kind, window);
    sizeOutput(kind, window);
    const task = window.loadURL(PAGES[kind]).then(() => {
      if (ticket !== revision || !alive() || outputs.get(kind) !== window || window.isDestroyed()) return;
      window.show(); notify();
    }).catch(error => { if (!window.isDestroyed()) window.destroy(); throw error; }).finally(() => { if (outputTasks.get(kind) === task) outputTasks.delete(kind); });
    outputTasks.set(kind, task); return task;
  }
  function sizeOutput(kind, window = outputs.get(kind)) {
    if (!window || window.isDestroyed() || !dimensions || !crops[kind]) return;
    const width = crops[kind].width * dimensions.width, height = crops[kind].height * dimensions.height;
    const scale = Math.min(1, 720 / Math.max(width, height));
    window.setContentSize(Math.max(16, Math.round(width * scale)), Math.max(16, Math.round(height * scale)));
  }
  ipcMain.handle(CHANNEL, async (event, command, payload) => {
    const sender = role(event);
    if (disposed || !sender) return { ok: false };
    if (sender === 'controller' && command === 'stop') { stop(); return { ok: true }; }
    if (!alive()) return { ok: false };
    try {
      if (command === 'snapshot') return { ok: true, state: state(), role: sender };
      if (sender !== 'controller') {
        if (command === 'ready' && phase === 'capturing') controller.webContents.send(`${CHANNEL}:output-ready`, { kind: sender, revision });
        else if (command === 'signal' && exact(payload, ['revision','signal']) && payload.revision === revision && phase === 'capturing' && validSignal(payload.signal))
          controller.webContents.send(`${CHANNEL}:signal`, { kind: sender, revision, signal: payload.signal });
        else return { ok: false };
        return { ok: true };
      }
      if (command === 'list' && phase === 'stopped') {
        const ticket = revision;
        // Enumerate metadata only. Thumbnail generation would sample every open
        // window before Clone Hero filtering and before the user's Start action.
        const found = candidates(await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }));
        if (!alive() || ticket !== revision || !role(event)) return { ok: false };
        sources = found.map(s => ({ id: s.id, name: s.name }));
        if (selected && !sources.some(s => s.id === selected.id && s.name === selected.name)) {
          selected = null; crops = emptyCrops(); revision++; notify();
        }
        return { ok: true, sources: sources.map(s => ({ ...s })) };
      }
      if (command === 'select' && phase === 'stopped' && exact(payload, ['id']) && typeof payload.id === 'string') {
        if (payload.id === '') { revision++; selected = null; crops = emptyCrops(); error = null; notify(); return { ok: true }; }
        const source = sources.find(s => s.id === payload.id); if (!source) return { ok: false };
        revision++; selected = { ...source }; crops = emptyCrops(); error = null; notify();
      } else if (command === 'started' && phase === 'starting' && exact(payload, ['width','height'])
        && [payload.width, payload.height].every(n => Number.isInteger(n) && n > 0 && n <= 16384)) {
        dimensions = { ...payload }; phase = 'capturing'; if (startTimer) clearTimeout(startTimer); startTimer = null;
        monitor = setInterval(async () => {
          const ticket = revision;
          try {
            const found = candidates(await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }));
            if (ticket === revision && !found.some(s => s.id === selected?.id && s.name === selected?.name)) stop('window-unavailable');
          } catch { if (ticket === revision) stop('capture-unavailable'); }
        }, 2000); monitor.unref?.(); notify();
      } else if (command === 'crop' && phase === 'capturing' && exact(payload, ['kind','rect']) && Object.hasOwn(TITLES, payload.kind) && validCrop(payload.rect)) {
        crops[payload.kind] = { ...payload.rect }; sizeOutput(payload.kind); notify();
      } else if (command === 'output' && exact(payload, ['kind']) && Object.hasOwn(TITLES, payload.kind)) await openOutput(payload.kind);
      else if (command === 'stop') stop();
      else if (command === 'failed') stop('capture-unavailable');
      else if (command === 'signal' && exact(payload, ['kind','revision','signal']) && Object.hasOwn(TITLES, payload.kind)
        && payload.revision === revision && phase === 'capturing' && validSignal(payload.signal)) {
        const window = outputs.get(payload.kind);
        if (!window || window.isDestroyed()) return { ok: false };
        window.webContents.send(`${CHANNEL}:signal`, { revision, signal: payload.signal });
      } else return { ok: false };
      return { ok: true };
    } catch { return { ok: false }; }
  });
  async function dispose() {
    disposed = true; stop(null, true); ipcMain.removeHandler(CHANNEL);
    ses.setDisplayMediaRequestHandler(null); await ses.protocol.unhandle('chartshub-companion');
  }
  return { open, stop: () => stop(null, true), dispose, snapshot: () => ({ available: alive(), phase, title: 'ChartsHub — Capture Clone Hero' }) };
}
module.exports = { createGameCapture, validCrop, validSignal, candidates, trusted, captureRequestAllowed, PAGES, TITLES };
