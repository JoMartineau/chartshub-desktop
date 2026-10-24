'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { DEFAULT_WIDGET, validateWidget, widgetNowPlaying } = require('../companion/song-request-widget.cjs');
const { overlayState } = require('../companion/song-request-server.cjs');
const { validCommand } = require('../companion/security.cjs');
const songId = 'a'.repeat(64), requests = [{ id: 'local-request', songId, title: 'Synthetic song', artist: 'Synthetic band',
  viewerName: 'Synthetic viewer', platform: 'website', status: 'accepted', votes: 1 }];
test('widget defaults show three upcoming requests and only bounded plain settings cross IPC', () => {
  assert.equal(DEFAULT_WIDGET.upcomingCount, 3);
  for (const fontSize of [16, 48]) for (const upcomingCount of [1, 10]) {
    const settings = { ...DEFAULT_WIDGET, accentColor: '#ABCDEF', fontSize, upcomingCount };
    assert.equal(validateWidget(settings).accentColor, '#abcdef');
    assert.equal(validCommand('songRequests.widget', { settings }), true);
  }
  for (const settings of [null, {}, { ...DEFAULT_WIDGET, accentColor: '#abc' },
    { ...DEFAULT_WIDGET, accentColor: 'red;position:fixed' }, { ...DEFAULT_WIDGET, fontSize: 24.5 },
    { ...DEFAULT_WIDGET, fontSize: 49 }, { ...DEFAULT_WIDGET, upcomingCount: 11 },
    { ...DEFAULT_WIDGET, showNowPlaying: 1 }, { ...DEFAULT_WIDGET, url: 'https://example.invalid' }]) {
    assert.throws(() => validateWidget(settings)); assert.equal(validCommand('songRequests.widget', { settings }), false);
  }
});
test('now-playing viewer attribution requires the exact native identity of one accepted request', () => {
  const song = { songId, title: 'Synthetic song', artist: 'Synthetic band', state: 'playing', privatePath: 'PRIVATE' };
  assert.deepEqual(widgetNowPlaying(song, requests), { title: song.title, artist: song.artist, state: 'playing', viewerName: 'Synthetic viewer' });
  for (const changed of [{ ...song, songId: undefined }, { ...song, songId: 'b'.repeat(64) }]) {
    assert.equal(Object.hasOwn(widgetNowPlaying(changed, requests), 'viewerName'), false);
  }
  assert.equal(Object.hasOwn(widgetNowPlaying(song, [{ ...requests[0], status: 'pending' }]), 'viewerName'), false);
  assert.equal(Object.hasOwn(widgetNowPlaying(song, [...requests, { ...requests[0], id: 'other' }]), 'viewerName'), false);
  assert.equal(widgetNowPlaying({ ...song, state: 'idle' }, requests), null);
  assert.equal(widgetNowPlaying(song, requests, { ...DEFAULT_WIDGET, showNowPlaying: false }), null);
});
test('OBS read state honors privacy settings and excludes private identities and native metadata', () => {
  const state = overlayState({ enabled: true, requests: [{ ...requests[0], eventId: 'PRIVATE_EVENT', viewerId: 'PRIVATE_VIEWER' }] },
    { ...DEFAULT_WIDGET, showViewerNames: false }, { songId, title: 'Synthetic song', artist: 'Synthetic band', state: 'exported', privatePath: 'PRIVATE_PATH' });
  assert.equal(state.requests[0].viewerName, ''); assert.equal(state.requests[0].platform, 'website');
  assert.equal(Object.hasOwn(state.nowPlaying, 'viewerName'), false); assert.equal(state.nowPlaying.state, 'exported');
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE|songId|eventId|viewerId/);
});
