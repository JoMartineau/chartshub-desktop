'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http'), path = require('node:path');
const { createLocalOverlayServer } = require('../companion/stream-server.cjs');
const { defaultSessionWidgetSettings } = require('../companion/session-widget-model.cjs');
const root = path.resolve(__dirname, '../companion'), token = 'eb'.repeat(32);
function request(port, route, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { Host: `127.0.0.1:${port}`, ...headers }, agent: false }, reply => {
      const chunks = []; reply.on('data', chunk => chunks.push(chunk)); reply.on('end', () => resolve({ status: reply.statusCode, headers: reply.headers, text: Buffer.concat(chunks).toString('utf8') }));
    }); req.on('error', reject); req.setTimeout(3000, () => req.destroy(Error('Synthetic HTTP timeout'))); req.end();
  });
}
const feed = kind => ({ enabled: true, language: 'fr', settings: { ...defaultSessionWidgetSettings(), shareChat: true, shareActivity: true }, items: kind === 'chat' ? [{ id: '1', at: 1000, platform: 'twitch', name: 'Viewer', text: '<script>literal</script>', token: 'SECRET' }] : [{ id: '1', at: 1000, kind: 'request', action: 'added', title: 'Signal fictif', name: 'Private viewer', path: 'C:/Private' }] });
async function fixture(t, get = feed) {
  const calls = []; const server = createLocalOverlayServer({ root, token, sessionFeeds: { snapshot: kind => { calls.push(kind); return get(kind); } } });
  t.after(() => server.stop()); await server.start(0); return { server, port: new URL(server.status().url).port, calls };
}
test('Chat and activity URLs use the same enabled tokenized loopback listener and disappear on stop', async t => {
  assert.throws(() => createLocalOverlayServer({ root, token, sessionFeeds: {} }), /provider/);
  const { server, port } = await fixture(t);
  assert.equal(server.status().chatUrl, `http://127.0.0.1:${port}/chat?token=${token}`);
  assert.equal(server.status().activityUrl, `http://127.0.0.1:${port}/activity?token=${token}`);
  assert.equal(server.status().clients, 0); await server.stop(); assert.equal(server.status().chatUrl, null); assert.equal(server.status().activityUrl, null);
});
test('GET and HEAD serve shared display HTML and bounded read-only feeds with restrictive same-origin headers', async t => {
  const { port, calls } = await fixture(t);
  for (const kind of ['chat', 'activity']) {
    for (const route of [`/${kind}?token=${token}`, `/session-state?kind=${kind}&token=${token}`]) {
      const get = await request(port, route), head = await request(port, route, { method: 'HEAD' });
      assert.equal(get.status, 200); assert.equal(head.status, 200); assert.equal(head.text, ''); assert.equal(Number(head.headers['content-length']), Buffer.byteLength(get.text));
      assert.equal(get.headers['cache-control'], 'no-store'); assert.equal(get.headers['x-content-type-options'], 'nosniff'); assert.equal(get.headers['cross-origin-resource-policy'], 'same-origin'); assert.equal(get.headers['access-control-allow-origin'], undefined);
      assert.match(get.headers['content-security-policy'], /connect-src 'self'/); assert.match(get.headers['content-security-policy'], /frame-ancestors 'none'/); assert.match(get.headers['content-security-policy'], /media-src 'none'/);
      if (route.startsWith('/session-state')) { const value = JSON.parse(get.text); assert.equal(value.enabled, true); assert.equal(value.items.length, 1); assert.doesNotMatch(get.text, /SECRET|Private|shareChat|shareActivity/); }
      else { assert.match(get.text, /id="feed"/); assert.match(get.headers['content-type'], /^text\/html/); }
    }
  }
  assert.deepEqual(calls, ['chat', 'chat', 'activity', 'activity']);
});
test('Token query host origin and referrer guards reject requests before any private feed is read', async t => {
  const { port, calls } = await fixture(t);
  for (const route of [`/chat`, `/activity`, `/session-state`]) {
    const kind = route === '/session-state' ? '&kind=chat' : '';
    for (const query of ['', '?token=wrong' + kind, `?token=${'ef'.repeat(32)}${kind}`, `?token=${token}&token=${token}${kind}`, `?token=${token}&source=private${kind}`, `?token=${token}${kind}#fragment`]) assert.equal((await request(port, route + query)).status, 403, route + query);
    for (const headers of [{ Host: `localhost:${port}` }, { Host: 'foreign.invalid' }, { Origin: 'null' }, { Origin: 'https://foreign.invalid' }, { Referer: 'https://foreign.invalid/' }, { Referer: 'invalid' }]) assert.equal((await request(port, `${route}?token=${token}${kind}`, { headers })).status, 403);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal((await request(port, `${route}?token=${token}${kind}`, { method })).status, 405);
  }
  for (const query of ['', '&kind=unknown', '&kind=chat&kind=activity']) assert.equal((await request(port, `/session-state?token=${token}${query}`)).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await request(port, `/session-state?token=${token}&kind=chat`, { headers: { Origin: `http://127.0.0.1:${port}`, Referer: `http://127.0.0.1:${port}/chat?token=${token}` } })).status, 200);
});
test('Display assets are a fixed JS/CSS allowlist with no editor preload module or arbitrary file access', async t => {
  const { port } = await fixture(t);
  for (const [route, mime] of [['/ui/session-feed.js', /^text\/javascript/], ['/ui/session-feed.css', /^text\/css/]]) {
    const get = await request(port, route); assert.equal(get.status, 200); assert.match(get.headers['content-type'], mime);
    assert.equal((await request(port, route, { method: 'HEAD' })).text, '');
    assert.equal((await request(port, route + '?extra=1')).status, 403);
    assert.equal((await request(port, route, { method: 'POST' })).status, 405);
    assert.equal((await request(port, route, { headers: { Referer: 'https://foreign.invalid/' } })).status, 403);
  }
  for (const route of ['/ui/session-feed.html', '/ui/session-widget-controls.js', '/session-widget-model.cjs', '/session-activity.cjs', '/preload.js', '/host.cjs', '/session-state/change']) assert.equal((await request(port, route)).status, 404, route);
  for (const route of ['/ui/../host.cjs', '/ui/%2e%2e/host.cjs', '//ui/session-feed.js']) assert.equal((await request(port, route)).status, 403);
});
test('Local feeds remain private until their own matching consent; malformed and failing providers expose empty data', async t => {
  let value = feed('chat'), fail = false; const { port, server } = await fixture(t, () => { if (fail) throw Error('SECRET C:/Private'); return value; });
  const read = async () => JSON.parse((await request(port, `/session-state?token=${token}&kind=chat`)).text);
  value.settings.shareChat = false; assert.equal((await read()).enabled, false); assert.deepEqual((await read()).items, []);
  value.settings.shareChat = true; assert.equal((await read()).items.length, 1);
  for (const invalid of [null, {}, { ...value, settings: { ...value.settings, path: 'C:/Private' } }]) { value = invalid; assert.deepEqual((await read()).items, []); }
  fail = true; assert.deepEqual((await read()).items, []); assert.equal(server.status().enabled, true);
  const legacy = createLocalOverlayServer({ root, token }); t.after(() => legacy.stop()); await legacy.start(0);
  for (const route of [`/chat?token=${token}`, `/session-state?kind=chat&token=${token}`, '/ui/session-feed.js']) assert.equal((await request(new URL(legacy.status().url).port, route)).status, 403);
});
test('HTTP applies final UTF-8 limits and excludes private fields even from an oversized trusted callback', async t => {
  const value = { ...feed('chat'), settings: { ...feed('chat').settings, maxItems: 20 }, items: Array.from({ length: 100 }, (_, n) => ({ id: String(n), at: n, platform: 'tiktok', name: '😀'.repeat(40), text: '😀'.repeat(250), viewerId: 'SECRET' })) };
  const { port } = await fixture(t, () => value); const result = await request(port, `/session-state?kind=chat&token=${token}`);
  assert.equal(result.status, 200); assert(Buffer.byteLength(result.text) <= 32768); assert.doesNotMatch(result.text, /SECRET|viewerId/); assert(JSON.parse(result.text).items.length <= 20);
});
