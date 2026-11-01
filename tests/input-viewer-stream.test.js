'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createLocalOverlayServer } = require('../companion/stream-server.cjs');
const { createInputViewerOutputState } = require('../companion/input-viewer-output-state.cjs');
const root = path.resolve(__dirname, '../companion'), token = 'd9'.repeat(32);
const scope = {};
vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/input-viewer-model.js'), 'utf8').replaceAll('export const ', 'const ').replaceAll('export function ', 'function ') + '\nthis.model={preset,validateConfig,sampleControls};', scope);
const model = scope.model, plain = value => JSON.parse(JSON.stringify(value));
const empty = { version: 1, revision: 0, phase: 'stopped', config: null, pressed: {} };
function request(port, route, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { Host: `127.0.0.1:${port}`, ...headers }, agent: false }, reply => {
      const chunks = []; reply.on('data', chunk => chunks.push(chunk));
      reply.on('end', () => resolve({ status: reply.statusCode, headers: reply.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.setTimeout(3000, () => req.destroy(Error('Synthetic HTTP timeout'))); req.end();
  });
}
async function fixture(t, snapshot = () => empty) {
  let calls = 0;
  const server = createLocalOverlayServer({ root, token, inputViewer: { snapshot: () => { calls++; return snapshot(); } } });
  t.after(() => server.stop()); await server.start(0);
  return { server, port: new URL(server.status().url).port, calls: () => calls };
}
function broker() {
  const value = createInputViewerOutputState({ validateConfig: model.validateConfig, sampleControls: model.sampleControls, now: () => 1000 });
  value.configure(model.preset()); value.setRunning(true); value.updatePressed({ fret0: true }); return value;
}

test('Input Viewer URL uses the enabled loopback server and disappears on stop without altering legacy status', async t => {
  const legacy = createLocalOverlayServer({ root, token });
  assert.deepEqual(legacy.status(), { enabled: false, url: null, clients: 0, error: null });
  assert.throws(() => createLocalOverlayServer({ root, token, inputViewer: {} }), /provider/);
  const { server, port } = await fixture(t);
  assert.equal(server.status().inputViewerUrl, `http://127.0.0.1:${port}/input-viewer?token=${token}`);
  assert.equal(server.status().clients, 0);
  await server.stop(); assert.equal(server.status().inputViewerUrl, null);
});

test('token-protected GET and HEAD serve output HTML and read-only JSON with same-origin CSP and no CORS', async t => {
  const state = broker(), { port, calls } = await fixture(t, () => state.snapshot());
  for (const route of ['/input-viewer', '/input-viewer-state']) {
    const get = await request(port, `${route}?token=${token}`), head = await request(port, `${route}?token=${token}`, { method: 'HEAD' });
    assert.equal(get.status, 200); assert.equal(head.status, 200); assert.equal(head.text, '');
    assert.equal(Number(head.headers['content-length']), Buffer.byteLength(get.text));
    assert.equal(get.headers['cache-control'], 'no-store'); assert.equal(get.headers['x-content-type-options'], 'nosniff');
    assert.equal(get.headers['cross-origin-resource-policy'], 'same-origin'); assert.equal(get.headers['referrer-policy'], 'no-referrer');
    assert.equal(get.headers['access-control-allow-origin'], undefined);
    assert.match(get.headers['content-security-policy'], /connect-src 'self'/);
    assert.match(get.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.match(get.headers['content-security-policy'], /media-src 'none'/);
    if (route === '/input-viewer') { assert.match(get.headers['content-type'], /^text\/html/); assert.match(get.text, /id="output"/); }
    else { assert.match(get.headers['content-type'], /^application\/json/); assert.deepEqual(JSON.parse(get.text), plain(state.snapshot())); }
  }
  assert.equal(calls(), 2); // Only authorized state reads reach the provider.
});

test('HTTP state tracks held and released inputs while stripping private fields without mutating the provider', async t => {
  const state = broker(), raw = plain(state.snapshot());
  raw.deviceId = 'PRIVATE DEVICE'; raw.config.source = 'gamepad'; raw.config.deadzone = .3; raw.config.grid = { enabled: true };
  raw.config.controls[0].mapping = { key: 'KeyQ', index: 14 }; raw.pressed.unknown = true;
  const before = JSON.stringify(raw), { port } = await fixture(t, () => raw);
  const first = JSON.parse((await request(port, `/input-viewer-state?token=${token}`)).text);
  assert.equal(first.pressed.fret0, true); assert.equal(first.pressed.unknown, undefined);
  assert(!/PRIVATE DEVICE|deviceId|mapping|KeyQ|source|deadzone|grid/.test(JSON.stringify(first)));
  assert.equal(JSON.stringify(raw), before);
  raw.pressed.fret0 = false; raw.revision++;
  const next = JSON.parse((await request(port, `/input-viewer-state?token=${token}`)).text);
  assert.equal(next.pressed.fret0, false); assert.equal(next.revision, first.revision + 1);
  raw.phase = 'stopped'; raw.pressed.fret0 = true;
  assert.equal(JSON.parse((await request(port, `/input-viewer-state?token=${token}`)).text).pressed.fret0, false);
});

test('Input Viewer rejects bad tokens, duplicate/extra queries, foreign hosts, origins and referrers before reading state', async t => {
  const { port, calls } = await fixture(t, () => { throw Error('Must not read'); });
  for (const route of ['/input-viewer', '/input-viewer-state']) {
    for (const query of ['', '?token=wrong', `?token=${'ff'.repeat(32)}`, `?token=${token}&token=${token}`, `?token=${token}&source=gamepad`, `?token=${token}#fragment`]) {
      assert.equal((await request(port, route + query)).status, 403, route + query);
    }
    for (const headers of [{ Host: `localhost:${port}` }, { Host: 'foreign.invalid' }, { Origin: 'null' }, { Origin: 'https://foreign.invalid' }, { Referer: 'https://foreign.invalid/' }, { Referer: 'invalid' }]) {
      assert.equal((await request(port, `${route}?token=${token}`, { headers })).status, 403);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal((await request(port, `${route}?token=${token}`, { method })).status, 405);
  }
  assert.equal(calls(), 0);
  const ok = await request(port, `/input-viewer-state?token=${token}`, { headers: { Origin: `http://127.0.0.1:${port}`, Referer: `http://127.0.0.1:${port}/input-viewer?token=${token}` } });
  assert.equal(ok.status, 200); assert.deepEqual(JSON.parse(ok.text), empty); assert.equal(calls(), 1);
});

test('only exact display assets are exposed and their ESM dependency graph resolves without editor or native code', async t => {
  const { port } = await fixture(t), visited = new Set(), pending = ['/ui/input-viewer-output.js'];
  while (pending.length) {
    const route = pending.shift(); if (visited.has(route)) continue; visited.add(route);
    const response = await request(port, route); assert.equal(response.status, 200, route); assert.match(response.headers['content-type'], /^text\/javascript/);
    for (const match of response.text.matchAll(/\b(?:import|export)[^;]*?from\s*['"]([^'"]+)['"]/g)) pending.push(new URL(match[1], `http://127.0.0.1:${port}${route}`).pathname);
  }
  assert.deepEqual([...visited].sort(), ['/ui/input-viewer-output.js', '/ui/input-viewer-model.js', '/ui/input-viewer-paint.js', '/ui/input-viewer-extra-styles.js', '/ui/input-viewer-trail-paint.js'].sort());
  const css = await request(port, '/ui/input-viewer-output.css'); assert.equal(css.status, 200); assert.match(css.headers['content-type'], /^text\/css/);
  const head = await request(port, '/ui/input-viewer-output.js', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.text, '');
  for (const route of ['/ui/input-viewer-output.html', '/ui/input-viewer.js', '/ui/input-viewer.css', '/ui/input-viewer-controls.js', '/input-viewer-output-preload.cjs', '/input-viewer-output-state.cjs', '/input-viewer.cjs', '/input-viewer-xinput.cjs', '/native/input-viewer.node', '/ui/input-viewer-output.js.map', '/input-viewer-state/change']) {
    assert.equal((await request(port, route)).status, 404, route);
  }
  for (const route of ['/ui/../host.cjs', '/ui/%2e%2e/host.cjs', '/ui/input-viewer-output.js?extra=1', '//ui/input-viewer-output.js']) assert.equal((await request(port, route)).status, 403, route);
  assert.equal((await request(port, '/ui/input-viewer-output.js', { headers: { Referer: 'https://foreign.invalid/' } })).status, 403);
  assert.equal((await request(port, '/ui/input-viewer-output.js', { method: 'POST' })).status, 405);
});

test('unavailable, malformed, oversized or throwing providers safely display stopped state and keep the server usable', async t => {
  let value = null, fails = false;
  const { port, server } = await fixture(t, () => { if (fails) throw Error('Private C:/profile/device.json'); return value; });
  const raw = plain(broker().snapshot());
  for (const bad of [null, undefined, { ...empty, revision: -1 }, { ...empty, phase: 'device-secret' }, { ...raw, config: { ...raw.config, controls: null } }, { ...raw, config: { ...raw.config, controls: [{ ...raw.config.controls[0], label: 'x'.repeat(40000) }] } }]) {
    value = bad; const result = await request(port, `/input-viewer-state?token=${token}`);
    assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.text), empty); assert(Buffer.byteLength(result.text) <= 32 * 1024);
  }
  fails = true; assert.deepEqual(JSON.parse((await request(port, `/input-viewer-state?token=${token}`)).text), empty);
  assert.equal(server.status().enabled, true); assert.equal((await request(port, `/overlay?token=${token}`)).status, 200);
  const disabled = createLocalOverlayServer({ root, token }); t.after(() => disabled.stop()); await disabled.start(0);
  assert.equal((await request(new URL(disabled.status().url).port, `/input-viewer-state?token=${token}`)).status, 403);
});
