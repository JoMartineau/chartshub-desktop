'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');

const MAX_SNAPSHOT = 256 * 1024, MAX_CLIENTS = 8, MAX_BUFFERED = 1024 * 1024;
const GAMEPLAY = ['idle', 'menu', 'loading', 'playing', 'paused', 'results'];
const TOKENS = ['primary', 'secondary', 'accent', 'text', 'mutedText', 'background', 'border', 'progress', 'glow', 'shadow'];
const PRESETS = ['chartshub', 'dark', 'light', 'neon', 'cyberpunk', 'retro', 'transparent', 'high-contrast'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const color = value => typeof value === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value) ? value.toLowerCase() : undefined;
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(value) ? value : null;
function text(value) {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 512);
  return clean && !/^(?:undefined|null|n\/?a|unknown)$/i.test(clean) ? clean : undefined;
}
function gradient(value) {
  return object(value) && typeof value.enabled === 'boolean' && color(value.from) && color(value.to)
    ? { enabled: value.enabled, from: color(value.from), to: color(value.to), angle: number(value.angle, 90, 0, 360) } : undefined;
}
// Keep the OBS projection independent of the game adapter. Only bounded text
// segments with literal hex colors and an exact plain-text match cross it.
function charterSegments(value, plain) {
  if (typeof plain !== 'string' || !Array.isArray(value) || !value.length || value.length > 128) return undefined;
  const result = []; let combined = '', colored = false;
  for (const segment of value) {
    if (!object(segment) || Object.keys(segment).some(key => key !== 'text' && key !== 'color') || typeof segment.text !== 'string' || !segment.text || /[\u0000-\u001f\u007f]/.test(segment.text)) return undefined;
    combined += segment.text;
    if (combined.length > 512 || (segment.color !== undefined && !color(segment.color))) return undefined;
    const tint = color(segment.color); colored ||= Boolean(tint);
    result.push({ text: segment.text, ...(tint ? { color: tint } : {}) });
  }
  return colored && combined === plain ? result : undefined;
}
function style(value) {
  if (!object(value)) return {};
  const result = {};
  if (typeof value.useSourceColors === 'boolean') result.useSourceColors = value.useSourceColors;
  if (['theme', 'custom'].includes(value.colorMode)) result.colorMode = value.colorMode;
  for (const key of ['color', 'backgroundColor', 'borderColor']) if (color(value[key])) result[key] = color(value[key]);
  if (typeof value.fontSize === 'number') result.fontSize = number(value.fontSize, 20, 8, 200);
  if (typeof value.fontWeight === 'number') result.fontWeight = number(value.fontWeight, 500, 100, 900);
  if (object(value.glow) && typeof value.glow.enabled === 'boolean' && color(value.glow.color)) {
    result.glow = { enabled: value.glow.enabled, color: color(value.glow.color), blur: number(value.glow.blur, 0, 0, 40) };
  }
  const effect = gradient(value.gradient); if (effect) result.gradient = effect;
  return result;
}
function theme(value) {
  if (!object(value) || !PRESETS.includes(value.presetId) || !object(value.colors) || !object(value.effects)) return undefined;
  const colors = {};
  for (const token of TOKENS) { const clean = color(value.colors[token]); if (!clean) return undefined; colors[token] = clean; }
  const effect = gradient(value.effects.gradient);
  if (!effect || !object(value.effects.glow) || typeof value.effects.glow.enabled !== 'boolean') return undefined;
  return { presetId: value.presetId, colors, effects: { glow: { enabled: value.effects.glow.enabled, blur: number(value.effects.glow.blur, 0, 0, 40) }, gradient: effect } };
}
function widget(value) {
  if (!object(value) || !identifier(value.id) || !identifier(value.type)) return null;
  return {
    id: value.id, type: value.type, enabled: value.enabled === true,
    position: { x: number(value.position?.x, 0, 0, 8192), y: number(value.position?.y, 0, 0, 8192) },
    size: { width: number(value.size?.width, 200, 1, 8192), height: number(value.size?.height, 40, 1, 8192) },
    visibility: { game: value.visibility?.game === true, stream: value.visibility?.stream === true },
    ...(Array.isArray(value.gameplayVisibility) ? { gameplayVisibility: [...new Set(value.gameplayVisibility.filter(item => GAMEPLAY.includes(item)))] } : {}),
    style: style(value.style), config: {}
  };
}
/** Explicit public projection: no logs, account data, file paths or widget config. */
function publicState(input) {
  const source = object(input) ? input : {};
  const state = GAMEPLAY.includes(source.gameplay?.state) ? source.gameplay.state : 'idle';
  const isChartActive = source.gameplay?.isChartActive === true && (state === 'playing' || state === 'paused');
  let nowPlaying = null;
  if (isChartActive && object(source.nowPlaying)) {
    nowPlaying = {};
    for (const key of ['title', 'artist', 'charter', 'instrument', 'difficulty']) {
      const clean = text(source.nowPlaying[key]); if (clean !== undefined) nowPlaying[key] = clean;
    }
    const segments = charterSegments(source.nowPlaying.charterSegments, nowPlaying.charter);
    if (segments) nowPlaying.charterSegments = segments;
  }
  const ids = new Set();
  const instances = Array.isArray(source.widgets?.instances) ? source.widgets.instances.slice(0, 100).map(widget).filter(item => {
    if (!item || ids.has(item.id)) return false;
    ids.add(item.id); return true;
  }) : [];
  const suppliedLayout = new Map();
  if (Array.isArray(source.stream?.layout)) for (const item of source.stream.layout.slice(0, 100)) {
    if (object(item) && ids.has(item.id) && !suppliedLayout.has(item.id)) suppliedLayout.set(item.id, item);
  }
  const layout = instances.map(instance => {
    const item = suppliedLayout.get(instance.id) ?? { ...instance.position, ...instance.size };
    const width = number(item.width, 200, 24, 1280), height = number(item.height, 40, 16, 720);
    return { id: instance.id, x: number(item.x, 0, 0, 1280 - width), y: number(item.y, 0, 0, 720 - height), width, height };
  });
  const resolvedTheme = theme(source.theme);
  return {
    gameplay: { state, isChartActive }, nowPlaying, serviceHealth: {}, widgets: { instances },
    ...(resolvedTheme ? { theme: resolvedTheme } : {}),
    stream: {
      port: Math.round(number(source.stream?.port, 38473, 1024, 65535)),
      canvas: {
        width: Math.round(number(source.stream?.canvas?.width, 1280, 320, 7680)),
        height: Math.round(number(source.stream?.canvas?.height, 720, 180, 4320)),
        fps: source.stream?.canvas?.fps === 30 ? 30 : 60
      }, layout
    }
  };
}

function createLocalOverlayServer({ root, token, onStatus } = {}) {
  if (typeof root !== 'string' || typeof token !== 'string' || !/^[0-9a-f]{64}$/i.test(token)) throw Error('Invalid local overlay configuration.');
  const directory = path.resolve(root), secret = Buffer.from(token, 'hex'), accessToken = token.toLowerCase();
  let current = null, desired = false, generation = 0, chain = Promise.resolve(), startTask = null, stopTask = null;
  let lastError = '', lastNotified = '', latest = JSON.stringify({ type: 'snapshot', state: publicState(null) }), fps = 60;
  const status = () => ({ enabled: !!current && !current.closing, url: current && !current.closing ? `${origin(current)}/overlay?token=${accessToken}` : null, clients: current && !current.closing ? current.ws.clients.size : 0, error: lastError || null });
  function notify() {
    const snapshot = status(), signature = JSON.stringify(snapshot);
    if (signature === lastNotified) return;
    lastNotified = signature;
    try { onStatus?.(snapshot); } catch { /* Optional status reporting never owns server lifetime. */ }
  }
  function origin(context) { return `http://127.0.0.1:${context.server.address()?.port ?? context.port}`; }
  function validToken(url) {
    const values = url.searchParams.getAll('token');
    return values.length === 1 && /^[0-9a-f]{64}$/i.test(values[0]) && timingSafeEqual(secret, Buffer.from(values[0], 'hex'));
  }
  function requestUrl(context, request) {
    const expectedHost = `127.0.0.1:${context.server.address()?.port ?? context.port}`;
    if (request.headers.host !== expectedHost || request.rawHeaders.filter((_, index) => index % 2 === 0).filter(name => name.toLowerCase() === 'host').length !== 1) return null;
    if (request.headers.origin !== undefined && request.headers.origin !== `http://${expectedHost}`) return null;
    const raw = request.url ?? '';
    if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || raw.split('?')[0].includes('%')) return null;
    if (raw.split('?')[0].split('/').some(part => part === '.' || part === '..')) return null;
    try { const url = new URL(raw, `http://${expectedHost}`); return url.origin === `http://${expectedHost}` ? url : null; } catch { return null; }
  }
  function headers(context) {
    return {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src ws://127.0.0.1:${context.server.address()?.port ?? context.port}; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`
    };
  }
  async function asset(urlPath) {
    let relative;
    if (urlPath === '/overlay') relative = 'ui/stream.html';
    else if (urlPath === '/ui/stream.js' || urlPath === '/ui/stream.css') relative = urlPath.slice(1);
    else if (/^\/dist\/(?:widgets\/(?:engine|core)\/[a-zA-Z0-9_/-]+|themes\/[a-zA-Z0-9_-]+|overlay\/stream\/[a-zA-Z0-9_-]+|core\/types\/[a-zA-Z0-9_-]+|layout\/WidgetLayoutEngine|overlay\/game\/GameOverlay)\.js$/.test(urlPath)) relative = urlPath.slice(1);
    else return null;
    try {
      const base = await fs.realpath(directory), allowed = await fs.realpath(path.join(directory, relative.startsWith('ui/') ? 'ui' : 'dist'));
      const resolved = await fs.realpath(path.join(directory, relative));
      if (!allowed.startsWith(base + path.sep) || !resolved.startsWith(allowed + path.sep)) return null;
      const info = await fs.stat(resolved);
      if (!info.isFile() || info.size > 1024 * 1024) return null;
      return { bytes: await fs.readFile(resolved), type: relative.endsWith('.html') ? 'text/html; charset=utf-8' : relative.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' };
    } catch { return null; }
  }
  async function handleRequest(context, request, response) {
    const securityHeaders = headers(context), url = requestUrl(context, request);
    const finish = (code, message) => { if (!response.destroyed) { response.writeHead(code, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' }); response.end(message); } };
    if (!url || context.closing) return finish(403, 'Forbidden');
    if (request.method !== 'GET') return finish(405, 'Method not allowed');
    if (url.pathname === '/overlay' && !validToken(url)) return finish(403, 'Forbidden');
    const content = await asset(url.pathname);
    if (!content || context.closing) return finish(404, 'Not found');
    if (!response.destroyed) { response.writeHead(200, { ...securityHeaders, 'Content-Type': content.type }); response.end(content.bytes); }
  }
  function send(context, client, message) {
    if (context.closing || client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > MAX_BUFFERED) { client.terminate(); return; }
    client.send(message, { binary: false, compress: false }, error => { if (error) client.terminate(); });
  }
  function broadcast(context, message) { for (const client of context.ws.clients) send(context, client, message); }
  function createContext(port) {
    const context = { port, requestedPort: port, server: null, ws: new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false, closeTimeout: 1000 }), sockets: new Set(), closing: false, heartbeat: null, flush: null, pending: null, lastFlush: 0, closeTask: null };
    context.server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 }, (request, response) => {
      void handleRequest(context, request, response).catch(() => { if (!response.destroyed) { response.writeHead(500); response.end('Request failed'); } });
    });
    context.server.on('connection', socket => { context.sockets.add(socket); socket.on('close', () => context.sockets.delete(socket)); });
    context.server.on('clientError', (_error, socket) => socket.destroy());
    context.server.on('upgrade', (request, socket, head) => {
      socket.on('error', () => {});
      const url = requestUrl(context, request);
      const code = context.ws.clients.size >= MAX_CLIENTS ? 503 : 403;
      if (context.closing || request.method !== 'GET' || !url || url.pathname !== '/events' || !validToken(url) || context.ws.clients.size >= MAX_CLIENTS) {
        socket.end(`HTTP/1.1 ${code} ${code === 503 ? 'Service Unavailable' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return;
      }
      try { context.ws.handleUpgrade(request, socket, head, client => context.ws.emit('connection', client)); } catch { socket.destroy(); }
    });
    context.ws.on('error', () => { /* Socket errors are isolated from the host and other clients. */ });
    context.ws.on('connection', client => {
      client.alive = true;
      client.on('pong', () => { client.alive = true; });
      client.on('error', () => client.terminate());
      client.on('message', () => client.close(1008, 'Read-only overlay'));
      client.on('close', () => { if (!context.closing && current === context) notify(); });
      send(context, client, latest); notify();
    });
    return context;
  }
  function closeContext(context) {
    if (context.closeTask) return context.closeTask;
    context.closing = true;
    clearInterval(context.heartbeat); clearTimeout(context.flush);
    context.heartbeat = null; context.flush = null; context.pending = null;
    context.closeTask = new Promise(resolve => {
      for (const client of context.ws.clients) client.terminate();
      context.ws.close(() => {});
      context.server.close(() => resolve());
      // Includes HTTP keep-alive and upgraded sockets; stop cannot hang on clients.
      for (const socket of context.sockets) socket.destroy();
    });
    return context.closeTask;
  }
  function start(port) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) return Promise.reject(Error('Invalid stream port.'));
    if (desired && startTask?.port === port && startTask.generation === generation) return startTask.promise;
    if (desired && current && !current.closing && (current.port === port || current.requestedPort === port) && !stopTask) return Promise.resolve(status());
    desired = true; const ticket = ++generation;
    const promise = chain.then(async () => {
      if (!desired || ticket !== generation) return status();
      if (current) { const previous = current; current = null; await closeContext(previous); }
      if (!desired || ticket !== generation) return status();
      const context = createContext(port);
      try {
        await new Promise((resolve, reject) => {
          const failed = error => { context.server.removeListener('listening', ready); reject(error); };
          const ready = () => { context.server.removeListener('error', failed); resolve(); };
          context.server.once('error', failed); context.server.once('listening', ready);
          context.server.listen(port, '127.0.0.1');
        });
        if (!desired || ticket !== generation) { await closeContext(context); return status(); }
        context.port = context.server.address().port;
        context.server.on('error', () => { if (current === context) { lastError = 'Le serveur Stream est indisponible.'; notify(); void stop(); } });
        current = context; lastError = '';
        context.heartbeat = setInterval(() => {
          for (const client of context.ws.clients) {
            if (!client.alive) { client.terminate(); continue; }
            client.alive = false; client.ping(); send(context, client, '{"type":"heartbeat"}');
          }
        }, 10000);
        context.heartbeat.unref(); notify(); return status();
      } catch {
        await closeContext(context);
        if (ticket === generation) { desired = false; lastError = 'Le serveur Stream ne peut pas démarrer. Vérifiez le port.'; notify(); }
        throw Error('Le serveur Stream ne peut pas démarrer. Vérifiez le port.');
      }
    });
    startTask = { port, generation: ticket, promise };
    chain = promise.then(() => {}, () => {});
    void promise.then(() => { if (startTask?.promise === promise) startTask = null; }, () => { if (startTask?.promise === promise) startTask = null; });
    return promise;
  }
  function stop() {
    if (!desired && stopTask) return stopTask;
    desired = false; ++generation;
    const promise = chain.then(async () => {
      const context = current; current = null;
      if (context) await closeContext(context);
      notify();
    });
    stopTask = promise; chain = promise.then(() => {}, () => {});
    void promise.then(() => { if (stopTask === promise) stopTask = null; }, () => { if (stopTask === promise) stopTask = null; });
    return promise;
  }
  function publish(state) {
    try {
      const projected = publicState(state), message = JSON.stringify({ type: 'snapshot', state: projected });
      latest = Buffer.byteLength(message) <= MAX_SNAPSHOT ? message : JSON.stringify({ type: 'snapshot', state: publicState(null) });
      fps = projected.stream.canvas.fps;
    } catch { latest = JSON.stringify({ type: 'snapshot', state: publicState(null) }); fps = 60; }
    const context = current;
    if (!context || context.closing) return;
    context.pending = latest;
    if (context.flush) return;
    context.flush = setTimeout(() => {
      context.flush = null;
      if (context.closing || current !== context) return;
      const message = context.pending; context.pending = null;
      if (message) { context.lastFlush = Date.now(); broadcast(context, message); }
    }, Math.max(0, 1000 / fps - (Date.now() - context.lastFlush)));
    context.flush.unref();
  }
  return { start, status, publish, stop };
}

module.exports = { createLocalOverlayServer };
