'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createRhythmVerseCatalogue } = require('../desktop/rhythmverse-catalogue.cjs');

const downloadUrl = 'https://drive.google.com/file/d/Test_Chart-123/view';
const item = { id: 'chart-1', title: 'Fixture Chart', artist: 'Fixture Artist', downloadUrl };

function catalogue(t, nativeArchiveSupport) {
  const contents = new EventEmitter();
  const handlers = new Map();
  const event = { senderFrame: { url: 'https://chartshub.ca/' } };
  const opened = [];
  const service = createRhythmVerseCatalogue({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: channel => handlers.delete(channel),
    },
    contents,
    allowedSender: candidate => candidate === event,
    nativeArchiveSupport,
    download: async () => assert.fail('Unexpected native download'),
    openExternal: async url => { opened.push(url); },
    search: async query => ({ items: query === 'Empty' ? [] : [item], total: 1, hasMore: false }),
    artwork: { clear() {} },
  });
  t.after(() => service.dispose());
  return {
    service, event, contents, opened,
    search: (query = '') => handlers.get('chartshub-rhythmverse:search')(event, { query, page: 1 }),
    open: (kind, id = item.id) => handlers.get('chartshub-rhythmverse:open')(event, { kind, id }),
  };
}

test('RhythmVerse still searches and opens the host when native archive support is unavailable', async t => {
  const fixture = catalogue(t, false);
  const result = await fixture.search();
  assert.equal(result.nativeArchiveSupport, false);
  assert.equal(result.items[0].canDownload, false);
  assert.equal(result.items[0].canDownloadInBrowser, true);
  assert.equal(fixture.service.authorizeDownloads(fixture.event, [item.id]), null);
  assert.equal((await fixture.open('download')).ok, false);
  assert.deepEqual(await fixture.open('browser-download'), { ok: true });
  assert.deepEqual(fixture.opened, [downloadUrl]);
});

test('download authorization keeps a selected chart across searches until main-frame navigation', async t => {
  const fixture = catalogue(t, true);
  assert.equal((await fixture.search()).items[0].canDownload, true);
  assert.deepEqual((await fixture.search('Empty')).items, []);
  const authorized = fixture.service.authorizeDownloads(fixture.event, [item.id]);
  assert.equal(authorized.get(item.id).downloadUrl, downloadUrl);
  assert.equal(authorized.current(), true);
  assert.equal(fixture.service.authorizeDownloads({}, [item.id]), null);
  fixture.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(authorized.current(), false);
  assert.equal(fixture.service.authorizeDownloads(fixture.event, [item.id]), null);
});
