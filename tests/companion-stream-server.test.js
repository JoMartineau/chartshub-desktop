const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createLocalOverlayServer } = require('../companion/stream-server.cjs');

const root = path.resolve(__dirname, '../companion');
const token = 'a7'.repeat(32);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await pause(10); }
  assert.fail('Expected stream condition did not arrive');
}
async function fixture(t, overrides = {}) {
  const changes = [];
  const server = createLocalOverlayServer({ root, token, onStatus: status => changes.push(status), ...overrides });
  t.after(() => server.stop());
  await server.start(0);
  return { server, changes, port: new URL(server.status().url).port };
}
function request(port, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: options.method ?? 'GET', headers: { Host: `127.0.0.1:${port}`, ...options.headers }, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.setTimeout(2000, () => req.destroy(Error('HTTP test timeout'))); req.end();
  });
}
async function client(port, options = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/events?token=${token}`, { origin: `http://127.0.0.1:${port}`, ...options });
  const messages = [], waiters = [];
  socket.on('error', () => {});
  socket.on('message', bytes => {
    const message = JSON.parse(bytes.toString()); messages.push(message);
    for (const notify of [...waiters]) notify();
  });
  function next(predicate = message => message.type === 'snapshot', timeout = 2000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { remove(); reject(Error('WebSocket test timeout')); }, timeout);
      const remove = () => { clearTimeout(timer); const index = waiters.indexOf(check); if (index >= 0) waiters.splice(index, 1); };
      const check = () => { const index = messages.findIndex(predicate); if (index >= 0) { const [message] = messages.splice(index, 1); remove(); resolve(message); } };
      waiters.push(check); check();
    });
  }
  await once(socket, 'open');
  return { socket, messages, next };
}
function rejectedClient(port, { query = `token=${token}`, pathname = '/events', ...options } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${pathname}?${query}`, { origin: `http://127.0.0.1:${port}`, ...options });
    const timer = setTimeout(() => { socket.terminate(); reject(Error('Upgrade rejection timeout')); }, 2000);
    socket.on('error', () => {});
    socket.on('open', () => { clearTimeout(timer); socket.terminate(); reject(Error('Unexpected authorized WebSocket')); });
    socket.on('unexpected-response', (_request, response) => { clearTimeout(timer); response.resume(); socket.terminate(); resolve(response.statusCode); });
  });
}
async function playingState() {
  const { createDefaultWidgets } = await import('../companion/dist/widgets/core/index.js');
  const { createDefaultTheme } = await import('../companion/dist/themes/ThemeService.js');
  const { createDefaultStream } = await import('../companion/dist/overlay/stream/StreamConfig.js');
  const instances = createDefaultWidgets();
  return {
    gameplay: { state: 'playing', isChartActive: true },
    nowPlaying: { title: 'Stream title', artist: 'Stream artist', charter: 'Stream charter', instrument: 'Guitar', difficulty: 'Expert' },
    widgets: { instances }, theme: createDefaultTheme(), stream: createDefaultStream(instances), serviceHealth: {}
  };
}

test('stream HTTP serves a token-protected overlay with a complete, public-only ESM dependency graph', { timeout: 10000 }, async t => {
  const { port } = await fixture(t);
  const overlay = await request(port, `/overlay?token=${token}`);
  assert.equal(overlay.status, 200); assert.match(overlay.text, /id="stream-overlay"/);
  assert.equal(overlay.headers['access-control-allow-origin'], undefined);
  assert.equal(overlay.headers['referrer-policy'], 'no-referrer');
  assert.match(overlay.headers['content-security-policy'], new RegExp(`connect-src ws://127\\.0\\.0\\.1:${port}`));
  assert.equal((await request(port, '/ui/stream.css')).status, 200);
  const pending = ['/ui/stream.js'], visited = new Set();
  while (pending.length) {
    const modulePath = pending.shift(); if (visited.has(modulePath)) continue; visited.add(modulePath);
    const response = await request(port, modulePath);
    assert.equal(response.status, 200, modulePath); assert.match(response.headers['content-type'], /javascript/);
    for (const match of response.text.matchAll(/^(?:import|export)\s.+?\sfrom\s*['"]([^'"]+)['"]/gm)) {
      pending.push(new URL(match[1], `http://127.0.0.1:${port}${modulePath}`).pathname);
    }
  }
  assert.ok(visited.has('/dist/layout/WidgetLayoutEngine.js'));
  assert.ok(visited.has('/dist/themes/ThemeResolver.js'));
  assert.ok(visited.has('/dist/widgets/core/SongTitle/SongTitleWidget.js'));
});

test('stream HTTP rejects foreign hosts/origins, unauthorized tokens, writes and private paths', async t => {
  const { port } = await fixture(t);
  for (const query of ['', '?token=wrong', `?token=${token}&token=${token}`]) assert.equal((await request(port, `/overlay${query}`)).status, 403);
  for (const headers of [{ Host: `localhost:${port}` }, { Host: 'attacker.invalid' }, { Origin: 'null' }, { Origin: 'https://attacker.invalid' }]) {
    assert.equal((await request(port, `/overlay?token=${token}`, { headers })).status, 403);
  }
  assert.equal((await request(port, `/overlay?token=${token}`, { method: 'POST' })).status, 405);
  for (const privatePath of ['/host.cjs', '/preload.cjs', '/ui/panel.js', '/ui/index.html', '/dist/storage/SettingsRepository.js', '/dist/core/state/AppState.js', '/dist/widgets/core/index.js.map', '/src/core/types/Widget.ts', '/Companion-Data/settings.json']) {
    const response = await request(port, privatePath); assert.equal(response.status, 404, privatePath); assert.equal(response.text, 'Not found');
  }
  for (const traversal of ['/ui/../host.cjs', '/ui/%2e%2e/host.cjs', '/ui/%252e%252e/host.cjs', '/ui\\..\\host.cjs']) assert.equal((await request(port, traversal)).status, 403);
});

test('stream static serving rejects a directory junction escaping the companion root', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-stream-assets-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('chartshub-stream-assets-'));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const app = path.join(temporary, 'app'), outside = path.join(temporary, 'outside');
  await fs.mkdir(app); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'stream.js'), 'private data');
  await fs.symlink(outside, path.join(app, 'ui'), process.platform === 'win32' ? 'junction' : 'dir');
  const { port } = await fixture(t, { root: app });
  assert.equal((await request(port, '/ui/stream.js')).status, 404);
});

test('stream WebSocket authenticates token, path, Host and same-origin handshake', async t => {
  const { port } = await fixture(t);
  assert.equal(await rejectedClient(port, { query: 'token=bad' }), 403);
  assert.equal(await rejectedClient(port, { query: `token=${token}&token=${token}` }), 403);
  assert.equal(await rejectedClient(port, { pathname: '/commands' }), 403);
  assert.equal(await rejectedClient(port, { origin: 'https://attacker.invalid' }), 403);
  assert.equal(await rejectedClient(port, { origin: 'null' }), 403);
  assert.equal(await rejectedClient(port, { headers: { Host: 'attacker.invalid' } }), 403);
  const native = await client(port, { origin: undefined });
  assert.equal((await native.next()).type, 'snapshot');
});

test('stream charter colors preserve bounded spans and reject mismatched or unsafe metadata', async t => {
  const { server, port } = await fixture(t);
  const state = await playingState();
  const connection = await client(port); t.after(() => connection.socket.terminate());
  await connection.next();
  state.nowPlaying.charter = 'Name';
  state.nowPlaying.charterSegments = [{ text: 'Na', color: '#FF0000' }, { text: 'me', color: '#00ff88cc' }];
  state.widgets.instances.find(widget => widget.type === 'song.charter').style.useSourceColors = false;
  server.publish(state);
  const message = await connection.next();
  assert.deepEqual(message.state.nowPlaying.charterSegments, [{ text: 'Na', color: '#ff0000' }, { text: 'me', color: '#00ff88cc' }]);
  assert.equal(message.state.widgets.instances.find(widget => widget.type === 'song.charter').style.useSourceColors, false);
  for (const invalid of [
    [{ text: 'Wrong', color: '#ff0000' }],
    [{ text: 'Name', color: 'url(https://invalid/)' }],
    [{ text: 'Name', color: '#ff0000', path: 'C:/private' }],
    [{ text: 'Na\u0000me', color: '#ff0000' }],
    Array.from({ length: 129 }, () => ({ text: 'x', color: '#ffffff' }))
  ]) {
    state.nowPlaying.charterSegments = invalid; server.publish(state);
    assert.equal((await connection.next()).state.nowPlaying.charterSegments, undefined);
  }
});

test('stream snapshots preserve five widget fields and effects while stripping private state', async t => {
  const { server, port } = await fixture(t), state = await playingState();
  state.logs = ['secret-log']; state.profile = { path: 'C:/private/profile' };
  state.gameplay.private = 'secret-gameplay'; state.nowPlaying.chartPath = 'C:/private/chart';
  state.widgets.instances[0].config = { accessToken: 'secret-config' }; state.widgets.instances[0].private = 'secret-widget';
  state.serviceHealth = { adapter: { error: 'secret-health' } };
  state.stream.private = 'secret-stream'; state.theme.colors.private = 'secret-theme';
  state.widgets.instances[0].style.gradient = { enabled: true, from: '#ffff00', to: '#00ffff', angle: 90 };
  state.widgets.instances[0].style.glow = { enabled: true, color: '#ff008080', blur: 20 };
  server.publish(state);
  const connection = await client(port), message = await connection.next();
  assert.deepEqual(message.state.nowPlaying, { title: 'Stream title', artist: 'Stream artist', charter: 'Stream charter', instrument: 'Guitar', difficulty: 'Expert' });
  assert.deepEqual(message.state.widgets.instances[0].style, state.widgets.instances[0].style);
  assert.deepEqual(message.state.widgets.instances[0].config, {}); assert.deepEqual(message.state.serviceHealth, {});
  assert.doesNotMatch(JSON.stringify(message), /secret-|private|accessToken|chartPath/);
  const { validateStream, projectStreamState } = await import('../companion/dist/overlay/stream/StreamConfig.js');
  assert.deepEqual(validateStream(message.state.stream, message.state.widgets.instances), { port: state.stream.port, canvas: state.stream.canvas, layout: state.stream.layout });
  assert.equal(projectStreamState(message.state).widgets.instances.length, 5);
});

test('stream publication coalesces bursts and clears stale metadata outside playing/paused', async t => {
  const { server, port, changes } = await fixture(t), connection = await client(port), state = await playingState();
  assert.equal((await connection.next()).state.nowPlaying, null);
  const notifications = changes.length;
  for (let index = 0; index < 100; index++) { state.nowPlaying.title = `Update ${index}`; server.publish(state); }
  const newest = await connection.next(); assert.equal(newest.state.nowPlaying.title, 'Update 99');
  await pause(80); assert.equal(connection.messages.length, 0); assert.equal(changes.length, notifications);
  state.gameplay = { state: 'menu', isChartActive: true }; server.publish(state);
  const menu = await connection.next(); assert.equal(menu.state.nowPlaying, null); assert.equal(menu.state.gameplay.isChartActive, false);
  state.gameplay = { state: 'playing', isChartActive: false }; server.publish(state);
  assert.equal((await connection.next()).state.nowPlaying, null);
});

test('stream has eight client slots and read-only message failures are isolated', async t => {
  const { server, port } = await fixture(t), clients = [];
  for (let index = 0; index < 8; index++) { const entry = await client(port); await entry.next(); clients.push(entry); }
  assert.equal(server.status().clients, 8); assert.equal(await rejectedClient(port), 503);
  const closed = once(clients[0].socket, 'close'); clients[0].socket.send(JSON.stringify({ type: 'widget.layout', items: [] }));
  assert.equal((await closed)[0], 1008); await until(() => server.status().clients === 7);
  const replacement = await client(port); await replacement.next(); assert.equal(server.status().clients, 8);
  server.publish(await playingState()); assert.equal((await clients[1].next()).state.nowPlaying.title, 'Stream title');
  const oversized = once(replacement.socket, 'close'); replacement.socket.send('x'.repeat(2048));
  assert.equal((await oversized)[0], 1009); await until(() => server.status().clients === 7);
});

test('stream stop closes real clients, releases the port and restarts with the same URL and latest state', async t => {
  const { server, port } = await fixture(t), initialUrl = server.status().url, state = await playingState();
  server.publish(state); const connection = await client(port); await connection.next();
  const closed = once(connection.socket, 'close'); await server.stop(); await closed;
  assert.deepEqual(server.status(), { enabled: false, url: null, clients: 0, error: null });
  await assert.rejects(request(port, `/overlay?token=${token}`));
  state.nowPlaying.title = 'Updated while offline'; server.publish(state);
  await server.start(Number(port)); assert.equal(server.status().url, initialUrl);
  assert.equal((await (await client(port)).next()).state.nowPlaying.title, 'Updated while offline');
});

test('stream lifecycle serializes overlapping starts, stops and restarts without orphan listeners', async t => {
  const server = createLocalOverlayServer({ root, token }); t.after(() => server.stop());
  const first = server.start(0); assert.equal(server.start(0), first);
  const stopping = server.stop(); assert.equal(server.stop(), stopping); await Promise.all([first, stopping]);
  assert.equal(server.status().enabled, false);
  await server.start(0); const url = server.status().url;
  await server.start(0); assert.equal(server.status().url, url);
  const port = Number(new URL(url).port);
  const stopped = server.stop(), restarted = server.start(port); await Promise.all([stopped, restarted]);
  assert.equal(server.status().url, url); assert.equal((await request(port, `/overlay?token=${token}`)).status, 200);
});

test('stream bind failure reports a sanitized error and recovers without touching another server', async t => {
  const occupied = http.createServer((_request, response) => response.end('owner'));
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => occupied.close(resolve)));
  const port = occupied.address().port, statuses = [];
  const server = createLocalOverlayServer({ root, token, onStatus: value => statuses.push(value) }); t.after(() => server.stop());
  await assert.rejects(server.start(port), /ne peut pas démarrer/);
  assert.equal(server.status().enabled, false); assert.match(server.status().error, /Vérifiez le port/);
  assert.doesNotMatch(server.status().error, /EADDRINUSE|stack|stream-server|C:\\/);
  assert.equal((await request(port, '/')).text, 'owner');
  await server.start(0); assert.equal(server.status().error, null); assert.equal(statuses.at(-1).enabled, true);
});

test('stream malformed or oversized input stays bounded and yields a renderer-compatible public snapshot', async t => {
  const { server, port } = await fixture(t), connection = await client(port); await connection.next();
  const state = await playingState(); state.nowPlaying.title = 'x'.repeat(500000);
  state.nowPlaying.artist = 'N/A'; state.nowPlaying.charter = '\u0000';
  state.widgets.instances.push(state.widgets.instances[0]); state.stream.layout = [{ id: state.widgets.instances[0].id, x: Infinity, y: -100, width: 10000, height: 0 }];
  server.publish(state); const message = await connection.next();
  assert.ok(Buffer.byteLength(JSON.stringify(message)) <= 256 * 1024); assert.equal(message.state.nowPlaying.title.length, 512);
  assert.equal(message.state.nowPlaying.artist, undefined); assert.equal(message.state.nowPlaying.charter, undefined);
  const { projectStreamState } = await import('../companion/dist/overlay/stream/StreamConfig.js');
  assert.equal(projectStreamState(message.state).widgets.instances.length, 5);
  server.publish(Object.defineProperty({}, 'gameplay', { get() { throw Error('secret getter'); } }));
  assert.equal((await connection.next()).state.nowPlaying, null);
});

test('stream heartbeat reaches a real connected browser transport without new gameplay snapshots', { timeout: 14000 }, async t => {
  const { port } = await fixture(t), connection = await client(port); await connection.next();
  const ping = once(connection.socket, 'ping');
  assert.deepEqual(await connection.next(message => message.type === 'heartbeat', 12000), { type: 'heartbeat' });
  await ping; assert.equal(connection.socket.readyState, WebSocket.OPEN);
});

test('stream browser client clears immediately on disconnect, retries, and times out a silent connection', async () => {
  const code = (await fs.readFile(path.join(root, 'ui/stream.js'), 'utf8')).replace(/^import .*;\r?$/gm, '');
  const connections = [], timers = new Map(), intervals = [], renders = []; let clears = 0, now = 1000, timerId = 0;
  class FakeSocket {
    constructor(url) { this.url = url; this.handlers = new Map(); connections.push(this); }
    addEventListener(name, callback) { this.handlers.set(name, callback); }
    emit(name, value) { this.handlers.get(name)?.(value); }
    close() { this.closed = true; this.emit('close'); }
  }
  class FakeRenderer { render(state) { renders.push(state); } clear() { clears++; } dispose() {} }
  vm.runInNewContext(code, {
    document: { querySelector: () => ({}) }, StreamRenderer: FakeRenderer, WidgetRenderer: class {}, createDefaultRegistry: () => ({}),
    location: { href: `http://127.0.0.1:38473/overlay?token=${token}`, host: '127.0.0.1:38473' }, URL, WebSocket: FakeSocket,
    Date: { now: () => now }, setInterval: callback => { intervals.push(callback); return intervals.length; }, clearInterval: () => {},
    setTimeout: (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; }, clearTimeout: id => timers.delete(id), window: { addEventListener: () => {} }
  });
  const first = connections[0]; first.emit('open');
  first.emit('message', { data: JSON.stringify({ type: 'snapshot', state: { widgets: { instances: [] } } }) }); assert.equal(renders.length, 1);
  const prior = clears; first.close(); assert.ok(clears > prior); assert.equal([...timers.values()][0].ms, 1000);
  const retry = [...timers.values()][0]; timers.clear(); retry.callback();
  const second = connections[1]; second.emit('open'); now += 26000; intervals[0]();
  assert.equal(second.closed, true); assert.equal([...timers.values()][0].ms, 2000);
  first.emit('message', { data: JSON.stringify({ type: 'snapshot', state: { widgets: { instances: ['stale'] } } }) });
  assert.equal(renders.length, 1);
});
