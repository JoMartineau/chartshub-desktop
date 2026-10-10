'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createDownloadNotifications } = require('../desktop/download-notifications.cjs');
const endpoint = '/api/charts/11111111-1111-4111-8111-111111111111/abcdefghijkl/download-manifest';
const reply = (extra = {}) => ({ ok: true, redirected: false, headers: { get: () => null }, async text() { return JSON.stringify({ ok: true, duplicate: false, notification: { id: 'server-id', category: 'downloads' }, preferences: { categories: { downloads: true }, quietWhilePlaying: true }, ...extra }); } });
function fixture(options = {}) {
  const requests = [], alerts = [], centres = [];
  const broker = createDownloadNotifications({ fetcher: async (url, request) => { requests.push({ url, request, body: JSON.parse(request.body) }); return reply(); },
    showNative: (options, click) => alerts.push({ options, click }), probeGame: async () => ({ running: false }), openCentre: async current => { if (current()) centres.push(true); }, ...options });
  broker.setAccount({ id: 'account-A' });
  return { broker, requests, alerts, centres };
}

test('new completion creates one account-bound server event and no local metadata is sent', async () => {
  const f = fixture(), scope = f.broker.capture(), id = randomUUID();
  const queued = { id, chartId: 'public-chart', state: 'Queued', rootPath: 'C:/private/Songs', title: 'Private local title', error: 'C:/secret-error' };
  f.broker.trackCompanion(scope, id, { items: [queued] });
  f.broker.observeCompanion({ items: [{ ...queued, state: 'Downloading' }] });
  f.broker.observeCompanion({ items: [{ ...queued, state: 'Completed', destination: 'C:/private/Songs/local' }] });
  f.broker.observeCompanion({ items: [{ ...queued, state: 'Completed' }] });
  await f.broker.flush();
  assert.equal(f.requests.length, 1); assert.equal(f.alerts.length, 1);
  const { url, request, body } = f.requests[0];
  assert.equal(url, 'https://chartshub.ca/api/account/notifications/downloads');
  assert.equal(request.credentials, 'include'); assert.equal(request.redirect, 'error');
  assert.equal(request.headers.Origin, 'https://chartshub.ca'); assert.equal(request.headers['X-Chartshub-Account-Id'], 'account-A');
  assert.deepEqual(body, { eventId: scope.eventId, outcome: 'complete', completed: 1, total: 1 });
  assert.doesNotMatch(request.body, /Songs|private|rootPath|destination|title|error|account-A/);
  await f.broker.dispose();
});

test('startup snapshots and already existing queue entries never replay old notifications', async () => {
  const f = fixture(), id = randomUUID();
  f.broker.observeCompanion({ items: [{ id, state: 'Completed' }, { id: randomUUID(), state: 'Failed' }] });
  await f.broker.flush(); assert.equal(f.requests.length, 0);
  const scope = f.broker.capture(); f.broker.trackCompanion(scope, id, { items: [{ id, state: 'Queued' }] });
  f.broker.observeCompanion({ items: [{ id, state: 'Failed' }] }); await f.broker.flush();
  f.broker.trackCompanion(f.broker.capture(), id, { items: [{ id, state: 'Failed' }] }); await f.broker.flush();
  assert.equal(f.requests.length, 1);
  await f.broker.dispose();
});

test('queued notifications and transfers owned before logout cannot be adopted by a new account', async () => {
  const f = fixture(), old = f.broker.capture(), id = randomUUID();
  f.broker.trackCompanion(old, id, { items: [{ id, state: 'Downloading' }] });
  f.broker.finishNative(old, [endpoint], { ok: true });
  f.broker.invalidate(); f.broker.setAccount({ id: 'account-B' });
  f.broker.trackCompanion(f.broker.capture(), id, { items: [{ id, state: 'Completed' }] });
  f.broker.observeCompanion({ items: [{ id, state: 'Completed' }] });
  await f.broker.flush(); assert.equal(f.requests.length, 0); assert.equal(f.alerts.length, 0);
  await f.broker.dispose();
});

test('an in-flight request aborts on logout, and a same-account new session cannot revive it', async () => {
  let entered, release, signal;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture({ fetcher: async (_url, request) => { signal = request.signal; entered(); await new Promise(resolve => { release = resolve; }); return reply(); } });
  const scope = f.broker.capture(); f.broker.finishNative(scope, [endpoint], { ok: true }); await started;
  f.broker.invalidate(); f.broker.setAccount({ id: 'account-A' });
  assert.equal(signal.aborted, true); release(); await f.broker.flush(); assert.equal(f.alerts.length, 0);
  f.broker.finishNative(scope, [endpoint], { ok: true }); await f.broker.flush(); assert.equal(f.alerts.length, 0);
  await f.broker.dispose();
});

test('the server-side expected-account guard rejects a cookie switch at dispatch', async () => {
  const persisted = [], f = fixture({ fetcher: async (_url, request) => {
    const authenticatedAccount = 'account-B';
    if (request.headers['X-Chartshub-Account-Id'] !== authenticatedAccount) return { ok: false, status: 409 };
    persisted.push(authenticatedAccount); return reply();
  } });
  f.broker.finishNative(f.broker.capture(), [endpoint], { ok: true }); await f.broker.flush();
  assert.deepEqual(persisted, []); assert.deepEqual(f.alerts, []); await f.broker.dispose();
});

test('explicit retry creates new intent for the current account but only one terminal event', async () => {
  const f = fixture(), id = randomUUID();
  f.broker.trackCompanion(f.broker.capture(), id, { items: [{ id, state: 'Queued' }] });
  f.broker.invalidate(); f.broker.setAccount({ id: 'account-B' });
  f.broker.observeCompanion({ items: [{ id, state: 'Failed' }] });
  const next = f.broker.capture(); f.broker.trackCompanion(next, id, { items: [{ id, state: 'Queued' }] }, { restart: true });
  f.broker.observeCompanion({ items: [{ id, state: 'Cancelled' }] }); f.broker.observeCompanion({ items: [{ id, state: 'Cancelled' }] });
  await f.broker.flush(); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].request.headers['X-Chartshub-Account-Id'], 'account-B'); assert.equal(f.requests[0].body.outcome, 'cancelled');
  await f.broker.dispose();
});

test('server preferences, duplicate receipts and game presence suppress native alerts', async () => {
  for (const options of [
    { fetcher: async () => reply({ notification: null }) },
    { fetcher: async () => reply({ duplicate: true }) },
    { fetcher: async () => reply({ preferences: { categories: { downloads: false }, quietWhilePlaying: false } }) },
    { probeGame: async () => ({ running: true }) },
    { probeGame: async () => ({ running: null }) },
    { probeGame: async () => { throw Error('Probe unavailable'); } },
  ]) {
    const f = fixture(options); f.broker.finishNative(f.broker.capture(), [endpoint], { ok: true }); await f.broker.flush(); assert.equal(f.alerts.length, 0); await f.broker.dispose();
  }
  const f = fixture({ fetcher: async () => reply({ preferences: { categories: { downloads: true }, quietWhilePlaying: false } }), probeGame: async () => { throw Error('Quiet mode is disabled'); } });
  f.broker.finishNative(f.broker.capture(), [endpoint], { ok: true }); await f.broker.flush(); assert.equal(f.alerts.length, 1); await f.broker.dispose();
});

test('notification transport and OS errors never mutate successful download outcomes', async () => {
  for (const options of [
    { fetcher: async () => { throw Error('Network unavailable'); } },
    { fetcher: async () => ({ ok: false, status: 401 }) },
    { fetcher: async () => ({ ...reply(), async text() { return '{broken'; } }) },
    { showNative() { throw Error('Windows notifications unavailable'); } },
  ]) {
    const f = fixture(options), result = { ok: true, folderName: 'local-preserved', files: 3 }, original = structuredClone(result);
    f.broker.finishNative(f.broker.capture(), [endpoint], result); await f.broker.flush(); assert.deepEqual(result, original); await f.broker.dispose();
  }
});

test('clicks only open the fixed centre while the owning session is current', async () => {
  const f = fixture(); f.broker.finishNative(f.broker.capture(), [endpoint], { ok: true }); await f.broker.flush();
  f.alerts[0].click(); await Promise.resolve(); assert.equal(f.centres.length, 1);
  f.broker.invalidate(); f.broker.setAccount({ id: 'account-B' }); f.alerts[0].click(); await Promise.resolve(); assert.equal(f.centres.length, 1);
  assert.deepEqual(Object.keys(f.alerts[0].options).sort(), ['body', 'silent', 'title']); await f.broker.dispose();
});

test('native batches report exact partial counts, bounded groups, and skip review exports', async () => {
  const f = fixture(), endpoints = Array.from({ length: 205 }, (_, index) => endpoint.replace('abcdefghijkl', `abcdefghijkl${index}`));
  const results = endpoints.slice(0, 202).map(value => ({ endpoint: value, ok: true, folderName: 'Private path is ignored' }));
  const scope = f.broker.capture(); f.broker.finishNative(scope, endpoints, { ok: false, cancelled: true, results });
  f.broker.finishNative(scope, endpoints, { ok: false, cancelled: true, results });
  f.broker.finishNative(f.broker.capture(), ['/api/admin/review/export'], { ok: true });
  await f.broker.flush(); assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests.map(value => ({ outcome: value.body.outcome, completed: value.body.completed, total: value.body.total })), [{ outcome: 'complete', completed: 200, total: 200 }, { outcome: 'cancelled', completed: 2, total: 5 }]);
  assert.notEqual(f.requests[0].body.eventId, f.requests[1].body.eventId); await f.broker.dispose();
});

test('anonymous sessions and forged ownership tokens cannot send notifications', async () => {
  const f = fixture(); f.broker.setAccount(null); assert.equal(f.broker.capture(), null);
  f.broker.finishNative({ accountId: 'account-A', generation: 0, eventId: randomUUID() }, [endpoint], { ok: true });
  f.broker.setAccount({ id: 'account-A' }); f.broker.trackCompanion({ accountId: 'account-A' }, randomUUID(), { items: [] });
  await f.broker.flush(); assert.deepEqual(f.requests, []); await f.broker.dispose();
});
