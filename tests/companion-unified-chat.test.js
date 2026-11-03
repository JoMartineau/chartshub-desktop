'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUnifiedChat, LIMITS } = require('../companion/unified-chat.cjs');
function fixture() {
  let active = true, lifecycle = 1, time = 10000, changes = 0, reads = 0;
  const service = createUnifiedChat({ getContext: () => { reads++; return { active, lifecycle }; }, now: () => time, onChange: () => { changes++; } });
  let id = 0;
  const emit = (patch = {}) => service.capture({ platform: 'twitch', eventId: 'private-event-' + ++id, viewerName: 'Viewer', query: 'Hello', ...patch });
  const connected = platform => service.connection(platform, { state: 'connected', displayName: 'PublicChannel', accessToken: 'PRIVATE_TOKEN', viewerId: 'PRIVATE_USER_ID' });
  return { service, emit, connected, active: value => { active = value; }, lifecycle: value => { lifecycle = value; },
    advance: value => { time += value; }, reads: () => reads, changes: () => changes };
}
test('chat is initially off and its construction does not call trusted context or providers', () => {
  const f = fixture(); assert.equal(f.reads(), 0); assert.equal(f.changes(), 0);
  f.connected('twitch'); assert.equal(f.emit(), false); assert.deepEqual(f.service.status().messages, []);
  assert.deepEqual(Object.keys(f.service.status().connections), ['twitch', 'tiktok']);
});
test('ordinary messages require explicit enable and a connected matching native provider', () => {
  const f = fixture(); assert.deepEqual(f.service.configure({ enabled: true }), { ok: true });
  assert.equal(f.emit(), false); f.connected('twitch'); assert.equal(f.emit(), true);
  assert.equal(f.emit({ platform: 'tiktok' }), false); assert.equal(f.emit({ platform: 'kick' }), false);
  assert.equal(f.service.status().messages[0].text, 'Hello');
});
test('only plain bounded text and local display IDs leave the broker', () => {
  const f = fixture(); f.connected('twitch'); f.service.configure({ enabled: true });
  assert.equal(f.emit({ viewerName: '  A\u0000B\u202e  ', query: '  <b>Hello</b>\u0000\r\nworld  ',
    token: 'PRIVATE_TOKEN', viewerId: 'PRIVATE_USER_ID', destination: 'C:/PRIVATE_PATH' }), true);
  const value = f.service.status(), message = value.messages[0];
  assert.deepEqual(Object.keys(message), ['id', 'platform', 'name', 'text', 'at']);
  assert.equal(message.name, 'AB'); assert.equal(message.text, '<b>Hello</b>world'); assert.equal(message.id, '1');
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|private-event|accessToken|viewerId|destination/);
  message.text = 'MODIFIED'; value.connections.twitch.state = 'disconnected';
  assert.equal(f.service.status().messages[0].text, '<b>Hello</b>world'); assert.equal(f.service.status().connections.twitch.state, 'connected');
});
test('malformed events and invalid settings cannot publish or enable a feed', () => {
  const f = fixture(); f.connected('twitch');
  for (const value of [null, [], {}, { enabled: 1 }, { enabled: true, token: 'private' }]) assert.equal(f.service.configure(value).ok, false);
  f.service.configure({ enabled: true });
  for (const patch of [{ platform: 'other' }, { eventId: '' }, { eventId: 'a'.repeat(257) }, { eventId: '\n' },
    { query: '' }, { query: 'a'.repeat(501) }, { viewerName: '' }, { viewerName: 'a'.repeat(257) }, { query: null }]) assert.equal(f.emit(patch), false);
  assert.deepEqual(f.service.status().messages, []);
});
test('provider revocation clears only that platform while global opt-out clears everything immediately', () => {
  const f = fixture(); f.connected('twitch'); f.connected('tiktok'); f.service.configure({ enabled: true });
  f.emit(); f.emit({ platform: 'tiktok' });
  f.service.connection('twitch', { state: 'error', displayName: 'Public', error: 'auth_revoked', private: 'SECRET' });
  assert.deepEqual(f.service.status().messages.map(message => message.platform), ['tiktok']); assert.equal(f.emit(), false);
  assert.equal(f.service.status().connections.twitch.error, 'auth_revoked');
  f.service.configure({ enabled: false }); assert.equal(f.service.status().messages.length, 0); assert.equal(f.emit({ platform: 'tiktok' }), false);
});
test('changing the authorized lifecycle or losing access clears and disables the feed without replay', () => {
  for (const revoke of [f => f.lifecycle(2), f => f.active(false)]) {
    const f = fixture(); f.connected('twitch'); f.service.configure({ enabled: true }); f.emit(); revoke(f);
    assert.equal(f.emit(), false); assert.deepEqual(f.service.status().messages, []); assert.equal(f.service.status().enabled, false);
    f.active(true); assert.equal(f.emit(), false);
  }
  const f = fixture(); f.active(false); assert.deepEqual(f.service.configure({ enabled: true }), { ok: false, code: 'CHAT_UNAVAILABLE' });
});
test('connection identities belong to the active lifecycle and cannot revive a revoked feed', () => {
  const f = fixture(); f.connected('twitch'); f.service.configure({ enabled: true }); f.emit();
  f.lifecycle(2); assert.equal(f.service.status().connections.twitch.state, 'disconnected');
  assert.equal(f.service.status().connections.twitch.displayName, null); f.service.configure({ enabled: true });
  assert.equal(f.emit(), false); f.connected('twitch'); assert.equal(f.emit(), true);
  f.active(false); assert.equal(f.connected('twitch'), false); assert.equal(f.service.status().connections.twitch.state, 'disconnected');
  f.active(true); f.service.configure({ enabled: true }); assert.equal(f.emit(), false);
});
test('redelivery deduplicates within a source while independent platforms can share provider message IDs', () => {
  const f = fixture(); f.connected('twitch'); f.connected('tiktok'); f.service.configure({ enabled: true });
  assert.equal(f.emit({ eventId: 'same' }), true); assert.equal(f.emit({ eventId: 'same' }), false);
  assert.equal(f.emit({ eventId: 'same', platform: 'tiktok' }), true); assert.equal(f.service.status().messages.length, 2);
});
test('feed size, duplicate memory, rate and age are bounded with no disk history', () => {
  const f = fixture(); f.connected('twitch'); f.service.configure({ enabled: true });
  for (let index = 0; index < 1200; index++) { assert.equal(f.emit(), true); f.advance(20); }
  assert.equal(f.service.status().messages.length, LIMITS.messages);
  for (let index = 0; index < 100; index++) f.emit();
  assert.equal(f.service.status().messages.length, LIMITS.messages);
  f.advance(LIMITS.ttlMs + 1); assert.deepEqual(f.service.status().messages, []);
  f.service.stop(); assert.equal(f.service.status().enabled, false); assert.equal(f.service.status().connections.twitch.state, 'disconnected');
});
test('a burst cannot flood host updates and unsafe provider errors never become public text', () => {
  const f = fixture(); f.connected('twitch'); f.service.configure({ enabled: true });
  let accepted = 0; for (let index = 0; index < 5000; index++) accepted += f.emit() ? 1 : 0;
  assert.equal(accepted, LIMITS.perSecond);
  f.service.connection('twitch', { state: 'error', displayName: 'Name', error: 'https://SECRET_TOKEN.invalid' });
  assert.equal(f.service.status().connections.twitch.error, null); assert.doesNotMatch(JSON.stringify(f.service.status()), /SECRET_TOKEN/);
});
test('clearing a single provider keeps the other and the setting, and throwing observers cannot break reception', () => {
  const f = fixture(); f.connected('twitch'); f.connected('tiktok'); f.service.configure({ enabled: true }); f.emit(); f.emit({ platform: 'tiktok' });
  assert.equal(f.service.clear('kick').ok, false); f.service.clear('twitch');
  assert.equal(f.service.status().enabled, true); assert.deepEqual(f.service.status().messages.map(message => message.platform), ['tiktok']);
  const service = createUnifiedChat({ getContext: () => ({ active: true, lifecycle: 1 }), onChange: () => { throw Error('private'); } });
  service.configure({ enabled: true }); service.connection('twitch', { state: 'connected' });
  assert.equal(service.capture({ platform: 'twitch', eventId: 'a', viewerName: 'Viewer', query: 'hello' }), true);
});
test('context exceptions fail closed and future timestamps are not retained after a clock rollback', () => {
  const service = createUnifiedChat({ getContext: () => { throw Error('private'); } });
  assert.equal(service.configure({ enabled: true }).code, 'CHAT_UNAVAILABLE'); assert.equal(service.status().enabled, false);
  const f = fixture(); f.connected('twitch'); f.service.configure({ enabled: true }); f.emit(); f.advance(-1000);
  assert.deepEqual(f.service.status().messages, []);
});
