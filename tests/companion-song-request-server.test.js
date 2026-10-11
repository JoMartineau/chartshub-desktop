'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { createSongRequestServer, overlayState, replyFor } = require('../companion/song-request-server.cjs');
const { createSongRequests } = require('../companion/song-requests.cjs');

const INGEST = 'a'.repeat(64), READ = 'b'.repeat(64), UNKNOWN = 'c'.repeat(64);
const hash = value => createHash('sha256').update(value).digest('hex');
const ID = '11111111-1111-4111-8111-111111111111';
const source = (extra = {}) => ({ platform: 'twitch', eventId: 'event-1', viewerId: 'PRIVATE_VIEWER',
  viewerName: 'Viewer', message: '!sr Installed', ...extra });
const requestRow = { id: ID, songId: hash('Installed/notes.chart'), platform: 'twitch', viewerName: 'Viewer',
  title: 'Installed', artist: 'Band', status: 'pending', votes: 1, requestedAt: 123,
  viewerId: 'PRIVATE_VIEWER', eventId: 'PRIVATE_EVENT', rootKey: hash('PRIVATE_ROOT'),
  relativePath: 'PRIVATE/notes.chart', folderPath: 'C:\\PRIVATE\\Songs' };
function deferred() { let done; const promise = new Promise(resolve => { done = resolve; }); return { promise, done }; }
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-request-server-'));
  const ui = path.join(root, 'ui'); await fs.mkdir(ui);
  await Promise.all(['song-requests.html', 'song-requests-overlay.css', 'song-requests-overlay.js'].map(file => fs.writeFile(path.join(ui, file), `Fixture ${file}`)));
  const calls = [], states = [];
  const server = createSongRequestServer({ root, ingestToken: INGEST, readToken: READ,
    receive: async event => {
      calls.push(structuredClone(event));
      return options.receive ? options.receive(event) : { ok: true, action: 'request', request: { ...requestRow,
        viewerId: undefined, eventId: undefined, rootKey: undefined, relativePath: undefined, folderPath: undefined } };
    },
    getSnapshot: options.getSnapshot ?? (() => ({ enabled: true, requests: [requestRow], ingestToken: INGEST, readToken: READ, viewerId: 'PRIVATE' })),
    getLanguage: options.getLanguage ?? (() => 'fr'), onStatus: value => states.push(value) });
  t.after(async () => {
    await server.stop();
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())
        || !path.basename(root).startsWith('chartshub-request-server-')) throw Error('Unexpected request-server fixture directory');
    await fs.rm(root, { recursive: true, force: true });
  });
  const state = await server.start(0); assert.equal(state.enabled, true);
  return { root, ui, server, calls, states, port: Number(new URL(state.url).port) };
}
function request(f, { method = 'GET', url = `/state?token=${READ}`, headers = {}, body, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port: f.port, method, path: url, agent: false,
      headers: { Host: `127.0.0.1:${f.port}`, Connection: 'close', ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ code: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.on('error', reject); outgoing.setTimeout(2000, () => outgoing.destroy(Error('Request test timed out')));
    if (chunked && body !== undefined) { outgoing.write(body); outgoing.end(); }
    else outgoing.end(body);
  });
}
const post = (f, input = source(), options = {}) => request(f, { method: 'POST', url: '/song-requests',
  body: JSON.stringify(input), ...options, headers: { Authorization: `Bearer ${INGEST}`, 'Content-Type': 'application/json', ...options.headers } });
function raw(f, value) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(f.port, '127.0.0.1'), chunks = [];
    socket.on('data', chunk => chunks.push(chunk)); socket.on('error', reject);
    socket.setTimeout(2000, () => socket.destroy(Error('Raw request test timed out')));
    socket.on('connect', () => socket.end(value)); socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
function checkHeaders(response) {
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.match(response.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
}

test('server starts only on loopback, separates capabilities and publishes no ingest secret in owner status', async t => {
  const f = await fixture(t), status = f.server.status(), bridge = f.server.bridgeConfiguration();
  assert.equal(new URL(status.url).hostname, '127.0.0.1');
  assert.equal(new URL(status.overlayUrl).searchParams.get('token'), READ);
  assert.equal(bridge.token, INGEST); assert.equal(bridge.url, status.url);
  assert.ok(!JSON.stringify(status).includes(INGEST));
  assert.ok(!JSON.stringify(f.states).includes(INGEST));
  const valid = { root: f.root, ingestToken: INGEST, readToken: READ, receive: async () => ({}), getSnapshot: () => ({}) };
  for (const override of [{ ingestToken: UNKNOWN.slice(1) }, { readToken: INGEST }, { readToken: 'invalid' }, { receive: null }]) {
    assert.throws(() => createSongRequestServer({ ...valid, ...override }));
  }
});

test('read-only OBS capability can read overlay/state but cannot ingest; ingest capability cannot read private OBS state', async t => {
  const f = await fixture(t);
  assert.equal((await request(f)).code, 200);
  assert.equal((await request(f, { url: `/overlay?token=${READ}` })).code, 200);
  for (const token of [INGEST, UNKNOWN, 'bad', '']) {
    assert.equal((await request(f, { url: `/state?token=${token}` })).code, 403);
  }
  assert.equal((await request(f, { url: '/state' })).code, 403);
  assert.equal((await request(f, { url: `/state?token=${READ}&token=${READ}` })).code, 403);
  assert.equal((await request(f, { url: `/overlay?token=${READ}&extra=true` })).code, 403);
  for (const token of [READ, UNKNOWN, 'bad', '']) {
    assert.equal((await post(f, source(), { headers: { Authorization: `Bearer ${token}` } })).code, 403);
  }
  assert.equal(f.calls.length, 0);
  const result = await post(f); assert.equal(result.code, 200); checkHeaders(result);
  assert.deepEqual(f.calls[0], { platform: 'twitch', eventId: 'event-1', viewerId: 'PRIVATE_VIEWER', viewerName: 'Viewer', query: '!sr Installed' });
  const value = JSON.parse(result.body); assert.equal(value.action, 'request'); assert.match(value.reply, /Demande ajoutée/);
  assert.ok(!result.body.includes('PRIVATE'));
});

test('cross-origin requests, browser ingestion and forged Host headers cannot use even valid capabilities', async t => {
  const f = await fixture(t), origin = `http://127.0.0.1:${f.port}`;
  assert.equal((await request(f, { headers: { Origin: origin } })).code, 200);
  assert.equal((await request(f, { headers: { Origin: 'https://untrusted.example' } })).code, 403);
  assert.equal((await post(f, source(), { headers: { Origin: origin } })).code, 403);
  assert.equal((await post(f, source(), { headers: { 'Sec-Fetch-Site': 'same-origin' } })).code, 403);
  for (const host of [`localhost:${f.port}`, `127.0.0.1:${f.port + 1}`, `untrusted.example:${f.port}`, `[::1]:${f.port}`]) {
    assert.equal((await request(f, { headers: { Host: host } })).code, 403);
  }
  const duplicateHost = await raw(f, `GET /state?token=${READ} HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nHost: 127.0.0.1:${f.port}\r\nConnection: close\r\n\r\n`);
  assert.match(duplicateHost, /HTTP\/1\.1 403/);
  const body = JSON.stringify(source());
  const duplicateAuth = await raw(f, `POST /song-requests HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nAuthorization: Bearer ${INGEST}\r\nAuthorization: Bearer ${INGEST}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  assert.match(duplicateAuth, /HTTP\/1\.1 403/); assert.equal(f.calls.length, 0);
});

test('malformed, percent-encoded and ambiguous targets cannot bypass the exact routes or expose application files', async t => {
  const f = await fixture(t);
  for (const url of ['//evil.example/state', '/ui/../song-requests.cjs', '/ui/%2e%2e/song-requests.cjs', '/ui\\song-requests-overlay.js',
    `/state/../state?token=${READ}`, `http://127.0.0.1:${f.port}/state?token=${READ}`]) {
    assert.equal((await request(f, { url })).code, 403);
  }
  for (const url of ['/song-requests.cjs', '/package.json', '/ui/song-requests.html', '/ui/song-requests-overlay.js?extra=true']) {
    assert.equal((await request(f, { url })).code, 404);
  }
  assert.equal((await request(f, { method: 'OPTIONS' })).code, 405);
  assert.equal((await request(f, { method: 'HEAD' })).code, 405);
  assert.equal(f.calls.length, 0);
});

test('body schema, media type, UTF-8, declared length and chunked body limits reject input before the receiver', async t => {
  const f = await fixture(t);
  for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/x-www-form-urlencoded' },
    { 'Content-Encoding': 'gzip' }, { 'Content-Type': 'application/json; charset=latin1' }]) {
    assert.equal((await post(f, source(), { headers })).code, 415);
  }
  for (const input of [[], null, { ...source(), path: 'C:\\Songs' }, { ...source(), admin: 'accept' },
    { ...source(), message: 'x'.repeat(201) }, { ...source(), message: 1 }]) {
    assert.equal((await post(f, input)).code, 400);
  }
  assert.equal((await post(f, source(), { body: '{invalid' })).code, 400);
  assert.equal((await post(f, source(), { body: Buffer.from([255, 255]) })).code, 400);
  assert.equal((await post(f, source(), { body: 'x'.repeat(8193) })).code, 413);
  const chunked = await post(f, source(), { body: 'x'.repeat(8193), chunked: true, headers: { 'Transfer-Encoding': 'chunked' } });
  assert.equal(chunked.code, 413);
  assert.equal(f.calls.length, 0);
});

test('public state whitelists active safe fields, bounds rows and excludes all private identities/settings/history', async t => {
  const owner = { enabled: true, requests: [requestRow, { ...requestRow, id: 'closed', status: 'played' },
    { ...requestRow, id: 'rejected', status: 'rejected' }], settings: { ingestToken: INGEST }, rootPath: 'PRIVATE_ROOT' };
  const projected = overlayState(owner);
  assert.deepEqual(Object.keys(projected), ['enabled', 'requests']);
  assert.equal(projected.requests.length, 1);
  assert.deepEqual(Object.keys(projected.requests[0]), ['id', 'title', 'artist', 'viewerName', 'platform', 'status', 'votes']);
  assert.ok(!JSON.stringify(projected).includes('PRIVATE'));
  projected.requests[0].title = 'Mutated'; assert.equal(owner.requests[0].title, 'Installed');
  const bounds = overlayState({ enabled: 'yes', requests: Array.from({ length: 60 }, (_, i) => ({ ...requestRow,
    id: `id-${i}`, viewerName: '<img src=x>\u202e\u0000', platform: 'discord', votes: 999999 })) });
  assert.equal(bounds.enabled, false); assert.equal(bounds.requests.length, 50);
  assert.equal(bounds.requests[0].viewerName, '<img src=x>'); assert.equal(bounds.requests[0].platform, ''); assert.equal(bounds.requests[0].votes, 1000);
  const f = await fixture(t, { getSnapshot: () => owner });
  const response = await request(f); checkHeaders(response);
  assert.ok(!response.body.includes('PRIVATE')); assert.ok(!response.body.includes(INGEST)); assert.ok(!response.body.includes(READ));
});

test('remote routes and chat commands cannot configure, accept, reject, reorder or download', async t => {
  const song = { id: hash('Installed/notes.chart'), title: 'Installed', artist: 'Band' };
  const core = createSongRequests({ getLibrarySnapshot: () => ({ rootKey: hash('Songs'), revision: 1, items: [song] }),
    searchSongs: async () => ({ items: [song], total: 1, revision: 1 }), resolveSong: async () => song });
  core.configure({ enabled: true });
  const f = await fixture(t, { receive: event => core.receive(event), getSnapshot: core.snapshot });
  for (const url of ['/admin', '/configure', '/accept', '/reject', '/move', '/download']) {
    assert.equal((await post(f, source(), { url })).code, 405);
  }
  for (const [i, message] of ['!accept id:any', '!reject id:any', '!move up', '!enable', '!download Installed'].entries()) {
    const response = await post(f, source({ message, eventId: `admin-${i}` }));
    assert.equal(response.code, 200); assert.equal(JSON.parse(response.body).code, 'invalid_command');
  }
  assert.equal(core.snapshot().requests.length, 0);
  const normal = await post(f, source({ eventId: 'real' })); assert.equal(JSON.parse(normal.body).ok, true);
  assert.equal(core.snapshot().requests[0].status, 'pending');
  assert.ok(!normal.body.includes('PRIVATE_VIEWER'));
});

test('only exact bundled assets are served with restrictive headers; oversized or outside symlink targets are refused', async t => {
  const f = await fixture(t);
  for (const [url, mime] of [[`/overlay?token=${READ}`, 'text/html'], ['/ui/song-requests-overlay.js', 'text/javascript'], ['/ui/song-requests-overlay.css', 'text/css']]) {
    const response = await request(f, { url }); assert.equal(response.code, 200); assert.match(response.headers['content-type'], new RegExp(mime)); checkHeaders(response);
  }
  const asset = path.join(f.ui, 'song-requests-overlay.css'); await fs.writeFile(asset, 'x'.repeat(256 * 1024 + 1));
  assert.equal((await request(f, { url: '/ui/song-requests-overlay.css' })).code, 404);
  const external = path.join(f.root, 'outside.js'); await fs.writeFile(external, 'PRIVATE_ASSET');
  const script = path.join(f.ui, 'song-requests-overlay.js'); await fs.unlink(script);
  try { await fs.symlink(external, script, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('File-link privilege unavailable; filesystem junction guards tested separately.'); return; }
    throw error;
  }
  const response = await request(f, { url: '/ui/song-requests-overlay.js' });
  assert.equal(response.code, 404); assert.ok(!response.body.includes('PRIVATE_ASSET'));
});

test('receiver exceptions do not leak paths, identities or credentials to the bridge', async t => {
  const f = await fixture(t, { receive: async () => { throw Error(`PRIVATE C:\\Songs token=${INGEST}`); } });
  const response = await post(f); assert.equal(response.code, 500); checkHeaders(response);
  assert.equal(response.body, 'Request unavailable'); assert.ok(!response.body.includes('PRIVATE')); assert.ok(!response.body.includes(INGEST));
});

test('stopping during a pending receiver closes sockets and prevents a stale reply after restart', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, { receive: async () => { started.done(); await gate.promise; return { ok: true, action: 'request', request: requestRow }; } });
  const pending = post(f).then(value => ({ value }), error => ({ error })); await started.promise;
  const oldPort = f.port; await f.server.stop();
  assert.equal(f.server.status().enabled, false); assert.equal(f.server.status().url, null); assert.equal(f.server.bridgeConfiguration(), null);
  const stopped = await pending; assert.ok(stopped.error || stopped.value?.code === 503);
  const next = await f.server.start(0); f.port = Number(new URL(next.url).port);
  gate.done(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await request(f)).code, 200); assert.equal(f.calls.length, 1);
  if (f.port !== oldPort) await assert.rejects(request({ port: oldPort }));
});

test('stop during a partial body prevents ingestion, and racing start/stop cannot leave an orphan listener', async t => {
  const f = await fixture(t);
  const socket = net.createConnection(f.port, '127.0.0.1'); socket.on('error', () => {});
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.write(`POST /song-requests HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nAuthorization: Bearer ${INGEST}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  await new Promise(resolve => setImmediate(resolve)); await f.server.stop(); await closed;
  assert.equal(f.calls.length, 0);
  await Promise.all([f.server.start(0), f.server.stop()]); assert.equal(f.server.status().enabled, false);
  const [first, second] = await Promise.all([f.server.start(0), f.server.start(0)]);
  assert.equal(second.enabled, true); assert.equal(f.server.status().url, second.url);
  f.port = Number(new URL(second.url).port); assert.equal((await request(f)).code, 200);
  if (first.enabled) assert.equal(first.url, second.url);
});

test('port collisions leave service stopped, disclose no system error/path, and recover on an available port', async t => {
  const f = await fixture(t), occupied = net.createServer();
  await new Promise((resolve, reject) => { occupied.once('error', reject); occupied.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const state = await f.server.start(occupied.address().port);
  assert.equal(state.enabled, false); assert.equal(state.url, null); assert.match(state.error, /port/i);
  assert.ok(!JSON.stringify(state).includes('EADDRINUSE')); assert.equal(f.server.bridgeConfiguration(), null);
  const recovered = await f.server.start(0); assert.equal(recovered.enabled, true); assert.equal(recovered.error, null);
  f.port = Number(new URL(recovered.url).port); assert.equal((await request(f)).code, 200);
});

test('FR/EN replies match actual core codes, bound queue/choices, and identify native export instead of playback', () => {
  assert.match(replyFor({ ok: false, code: 'duplicate_vote' }), /vote.*déjà/i);
  assert.match(replyFor({ ok: false, code: 'duplicate_vote' }, 'en'), /vote.*already/i);
  for (const [code, pattern] of [['not_queued', /file/i], ['vote_limit', /votes/i], ['duration_limit', /durée/i],
    ['instrument_unavailable', /instrument/i], ['difficulty_unavailable', /difficulté/i],
    ['metadata_unknown', /informations/i], ['library_changed', /bibliothèque/i], ['song_unavailable', /installée/i]]) {
    assert.match(replyFor({ ok: false, code }), pattern);
  }
  const items = Array.from({ length: 7 }, (_, i) => ({ ...requestRow, title: `QueueTrack${i}` }));
  const queue = replyFor({ ok: true, command: 'queue', items, position: 5 }, 'en');
  assert.match(queue, /Your request: #5/); assert.ok(!queue.includes('QueueTrack5'));
  const ambiguity = replyFor({ ok: false, code: 'ambiguous', matches: items.map((row, i) => ({ ...row, id: hash(String(i)) })) });
  assert.match(ambiguity, /!sr id:/); assert.ok(!ambiguity.includes('QueueTrack3')); assert.ok(!ambiguity.includes('PRIVATE'));
  const exported = replyFor({ ok: true, command: 'song', song: { title: 'Last title', artist: 'Band', charter: 'Mapper', exported: true } }, 'en');
  assert.match(exported, /Last exported song/); assert.ok(!exported.includes('Current song'));
  assert.match(replyFor({ ok: true, command: 'queue', items: [] }), /file est vide/);
});
