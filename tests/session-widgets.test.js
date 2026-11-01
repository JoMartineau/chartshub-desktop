'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSessionActivity } = require('../companion/session-activity.cjs');
const { createSongRequests } = require('../companion/song-requests.cjs');
const { defaultSessionWidgetSettings, validateSessionWidgetSettings, validSessionWidgetCommand, projectSessionFeed } = require('../companion/session-widget-model.cjs');
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const request = (n, status = 'pending') => ({ id: id(n), status, viewerName: 'Viewer ' + n, platform: 'twitch', song: { title: 'Fictional ' + n } });
const download = (n, state = 'Downloading', rootPath = 'C:/Synthetic/Songs') => ({ id: id(n), rootPath, state, title: 'Download ' + n, destination: 'C:/Private/never-export' });
function fixture() { const scope = { active: true, root: 'C:/Synthetic/Songs', lifecycle: 1, account: 'account-A' }; const activity = createSessionActivity({ getContext: () => scope, now: () => 1000 }); return { scope, activity }; }
test('Session widgets default to no sharing and strict settings reject unknown keys and out-of-range presentation', () => { const settings = defaultSessionWidgetSettings(); assert.equal(settings.shareChat, false); assert.equal(settings.shareActivity, false); assert.equal(settings.showViewerNames, false); assert.deepEqual(validateSessionWidgetSettings(settings), settings); for (const patch of [{ path: 'C:/Private' }, { shareChat: 1 }, { fontSize: 11 }, { fontSize: 49 }, { maxItems: 0 }, { maxItems: 21 }, { accent: 'url(http://foreign)' }]) assert.throws(() => validateSessionWidgetSettings({ ...settings, ...patch })); });
test('Only revision-bound configuration and exact copy-kind commands pass the IPC validator', () => { assert(validSessionWidgetCommand('sessionWidgets.configure', { revision: 0, settings: defaultSessionWidgetSettings() })); assert(validSessionWidgetCommand('sessionWidgets.copyUrl', { kind: 'chat' })); for (const [name, value] of [['sessionWidgets.configure', {}], ['sessionWidgets.configure', { revision: -1, settings: defaultSessionWidgetSettings() }], ['sessionWidgets.copyUrl', { kind: 'activity', path: 'x' }], ['sessionWidgets.copyUrl', { kind: 'unknown' }], ['sessionWidgets.startChat', {}], ['sessionWidgets.copyUrl', null]]) assert.equal(validSessionWidgetCommand(name, value), false); });
test('OBS projection requires its own sharing consent even when local chat is enabled', () => { const value = { enabled: true, language: 'fr', settings: defaultSessionWidgetSettings(), items: [{ id: '1', name: 'Viewer', text: 'Hello', at: 1, platform: 'twitch', token: 'SECRET' }] }; assert.deepEqual(projectSessionFeed('chat', value).items, []); value.settings.shareChat = true; const projected = projectSessionFeed('chat', value); assert.equal(projected.items.length, 1); assert.doesNotMatch(JSON.stringify(projected), /SECRET|shareChat|shareActivity/); assert.deepEqual(projectSessionFeed('activity', value).items, []); });
test('Activity viewer names are private by default and opt-in is independent from chat sharing', () => { const value = { enabled: true, settings: { ...defaultSessionWidgetSettings(), shareActivity: true }, items: [{ id: '1', at: 1, kind: 'request', action: 'added', title: '<literal>', name: 'Private Viewer', platform: 'tiktok', path: 'C:/Private', token: 'SECRET' }] }; assert.doesNotMatch(JSON.stringify(projectSessionFeed('activity', value)), /Private Viewer|C:\/Private|SECRET/); value.settings.showViewerNames = true; assert.equal(projectSessionFeed('activity', value).items[0].name, 'Private Viewer'); });
test('OBS feed is limited by visible count and final UTF-8 bytes while malformed identities are discarded', () => { const value = { enabled: true, settings: { ...defaultSessionWidgetSettings(), shareChat: true, maxItems: 20 }, items: Array.from({ length: 100 }, (_, n) => ({ id: String(n), name: '😀'.repeat(40), text: '😀'.repeat(250), platform: 'twitch', at: n })) }; const projected = projectSessionFeed('chat', value); assert(projected.items.length <= 20); assert(Buffer.byteLength(JSON.stringify(projected)) <= 32768); value.items = [{ id: 'SECRET'.repeat(30), name: 'A', text: 'B', at: 0, platform: 'twitch' }]; assert.equal(projectSessionFeed('chat', value).items.length, 0); });
test('Historical request and completed download baselines never appear as new activity', () => { const { activity } = fixture(); activity.observeRequests({ requests: [request(1), request(2, 'played')] }); activity.observeDownloads({ items: [download(3, 'Completed')] }); assert.deepEqual(activity.snapshot().items, []); activity.observeRequests({ requests: [request(1), request(2, 'played'), request(4)] }); assert.deepEqual(activity.snapshot().items.map(value => [value.kind, value.action, value.title]), [['request', 'added', 'Fictional 4']]); });
test('Real SongRequests snapshots expose flat titles and produce live activity without private resolver data', async () => {
  const { activity } = fixture(), song = { id: 'ab'.repeat(32), title: 'Signal fictif', artist: 'Projet démo', folderPath: 'C:/Private' };
  const core = createSongRequests({ getLibrarySnapshot: () => ({ rootKey: 'cd'.repeat(32), revision: 1, items: [song] }), searchSongs: async () => ({ items: [song], total: 1, revision: 1 }), resolveSong: async () => song, now: () => 1000 });
  core.configure({ enabled: true }); activity.observeRequests(core.snapshot());
  assert.equal((await core.receive({ platform: 'twitch', eventId: 'synthetic-event', viewerId: 'synthetic-viewer', viewerName: 'Viewer', songId: song.id })).ok, true);
  const snapshot = core.snapshot(); assert.equal(snapshot.requests[0].title, song.title); assert.equal(snapshot.requests[0].song, undefined);
  activity.observeRequests(snapshot); assert.deepEqual(activity.snapshot().items.map(value => [value.action, value.title, value.name]), [['added', song.title, 'Viewer']]);
  assert.doesNotMatch(JSON.stringify(activity.snapshot()), /folderPath|Private|synthetic-viewer/);
});
test('Only newly observed request and download transitions produce one bounded plain-text event', () => { const { activity } = fixture(); activity.observeRequests({ requests: [] }); activity.observeDownloads({ items: [] }); activity.observeRequests({ requests: [request(1)] }); activity.observeRequests({ requests: [request(1, 'accepted')] }); activity.observeRequests({ requests: [request(1, 'played')] }); activity.observeRequests({ requests: [request(1, 'played')] }); activity.observeDownloads({ items: [download(2)] }); activity.observeDownloads({ items: [download(2, 'Completed')] }); activity.observeDownloads({ items: [download(2, 'Completed')] }); assert.deepEqual(activity.snapshot().items.map(value => value.action), ['added', 'accepted', 'played', 'completed']); assert.doesNotMatch(JSON.stringify(activity.snapshot()), /destination|never-export|rootPath/); });
test('New terminal-only historical rows and downloads outside the current Songs root are ignored', () => { const { activity } = fixture(); activity.observeRequests({ requests: [] }); activity.observeDownloads({ items: [] }); activity.observeRequests({ requests: [request(1, 'played'), request(2, 'accepted')] }); activity.observeDownloads({ items: [download(3, 'Completed'), download(4, 'Downloading', 'C:/Other')] }); activity.observeDownloads({ items: [download(4, 'Completed', 'C:/Other')] }); assert.equal(activity.snapshot().items.length, 0); });

test('A fresh Host-owned download scope can track a destination outside Songs, but an old scope cannot', () => {
  const { activity, scope } = fixture(), current = activity.captureScope();
  activity.observeDownloads({ items: [] }, current);
  activity.observeDownloads({ items: [download(4, 'Downloading', 'C:/Other')] }, current);
  activity.observeDownloads({ items: [download(4, 'Completed', 'C:/Other')] }, current);
  assert.deepEqual(activity.snapshot().items.map(value => value.title), ['Download 4']);
  scope.lifecycle++;
  assert.equal(activity.observeDownloads({ items: [download(5, 'Completed', 'C:/Other')] }, current), false);
  assert.deepEqual(activity.snapshot().items, []);
});
test('Root lifecycle and account changes clear data and fence old asynchronous observations', () => { for (const key of ['root', 'lifecycle', 'account']) { const { activity, scope } = fixture(); activity.observeRequests({ requests: [] }); const before = activity.captureScope(); activity.observeRequests({ requests: [request(1)] }); scope[key] = key === 'lifecycle' ? 2 : 'different'; activity.update(); assert.equal(activity.snapshot().items.length, 0); assert.equal(activity.observeRequests({ requests: [request(2)] }, before), false); activity.observeRequests({ requests: [request(3)] }); assert.equal(activity.snapshot().items.length, 0); } });

test('Fresh authorised web folder completions appear once without exposing their filesystem data', () => {
  const { activity } = fixture(), scope = activity.captureScope();
  const value = { id: id(20), title: 'Signal de test', destination: 'C:/Private/Songs', token: 'SECRET' };
  assert.equal(activity.observeCompletedDownload(value, scope), true);
  assert.equal(activity.observeCompletedDownload(value, scope), false);
  assert.deepEqual(activity.snapshot().items.map(({ kind, action, title }) => [kind, action, title]), [['download', 'completed', 'Signal de test']]);
  assert.doesNotMatch(JSON.stringify(activity.snapshot()), /Private|destination|SECRET|token/);
});

test('Seeding the current request snapshot on a new root keeps the very first new request visible', () => {
  const { activity, scope } = fixture();
  activity.observeRequests({ requests: [request(1)] });
  scope.root = 'C:/Other/Songs'; activity.update();
  activity.observeRequests({ requests: [request(1)] });
  assert.deepEqual(activity.snapshot().items, []);
  activity.observeRequests({ requests: [request(2)] });
  assert.deepEqual(activity.snapshot().items.map(value => value.title), ['Fictional 2']);
});

test('Web completion callbacks from old roots, inactive sessions or disposal cannot become new activity', () => {
  for (const change of ['root', 'lifecycle', 'account', 'inactive', 'dispose']) {
    const { activity, scope } = fixture(), previous = activity.captureScope();
    if (change === 'dispose') activity.dispose();
    else if (change === 'inactive') scope.active = false;
    else scope[change] = change === 'lifecycle' ? 2 : 'different';
    assert.equal(activity.observeCompletedDownload({ id: id(1), title: 'Old completion' }, previous), false);
    assert.deepEqual(activity.snapshot().items, []);
  }
});
test('Inactive and disposed sessions never read event data and returned snapshots cannot mutate RAM state', () => { const { activity, scope } = fixture(); scope.active = false; assert.equal(activity.observeRequests(new Proxy({}, { get() { throw Error('Forbidden access'); } })), false); scope.active = true; activity.observeRequests({ requests: [] }); activity.observeRequests({ requests: [request(1)] }); const result = activity.snapshot(); result.items[0].title = 'mutated'; assert.equal(activity.snapshot().items[0].title, 'Fictional 1'); activity.dispose(); assert.equal(activity.observeRequests({ requests: [request(2)] }), false); assert.deepEqual(activity.snapshot().items, []); });
test('Activity retains at most100 events in RAM and clearing establishes a fresh baseline', () => { const { activity } = fixture(); activity.observeRequests({ requests: [] }); for (let n = 1; n <= 140; n++) activity.observeRequests({ requests: [request(n)] }); const items = activity.snapshot().items; assert.equal(items.length, 100); assert.equal(items[0].title, 'Fictional 41'); activity.clear(); activity.observeRequests({ requests: [request(141)] }); assert.equal(activity.snapshot().items.length, 0); });
