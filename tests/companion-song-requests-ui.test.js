'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createDocument, tick } = require('./floating-panel-dom.cjs');

async function fixture(t) {
  const { SongRequestControls } = await import('../companion/dist/settings/SongRequestControls.js');
  const document = createDocument(), root = document.createElement('main');
  const html = readFileSync(require.resolve('../companion/ui/index.html'), 'utf8');
  for (const [, tag, id] of html.matchAll(/<(\w+)\b[^>]*\bid="(song-requests-[^"]+)"/g)) {
    const element = document.createElement(tag); element.id = id; root.append(element);
    if (tag === 'select') {
      const body = html.match(new RegExp('<select id="' + id + '"[^>]*>([\\s\\S]*?)</select>'))[1];
      for (const [, value] of body.matchAll(/<option value="([^"]+)"/g)) { const option = document.createElement('option'); option.value = value; element.append(option); }
    }
  }
  const calls = [], controls = new SongRequestControls({ root, command: (name, payload) => new Promise(resolve => calls.push({ name, payload, resolve })) });
  const snapshot = { library: { status: 'ready', count: 3 }, songRequests: { enabled: false, revision: 0,
    rules: { maxDurationMinutes: null, instrument: 'all', difficulty: 'all' }, requests: [],
    bridge: { enabled: false, port: 38474, url: null, overlayUrl: null, error: null, platforms: ['twitch', 'tiktok', 'youtube'] } } };
  t.after(() => controls.dispose());
  const get = selector => root.querySelector(selector);
  const set = (name, value) => { const node = get('#song-requests-' + name); node.value = value; node.dispatchEvent(new Event('input')); };
  const submit = () => get('#song-requests-rules-form').dispatchEvent(new Event('submit', { cancelable: true }));
  const toggle = enabled => { const node = get('#song-requests-enabled'); node.checked = enabled; node.dispatchEvent(new Event('change')); };
  return { document, root, controls, calls, snapshot, get, set, submit, toggle };
}
const request = (id, status = 'pending') => ({ id, songId: 'a'.repeat(64), platform: 'twitch', viewerName: 'A viewer', title: 'Installed song', artist: 'Local artist', status, votes: 2 });

test('Song Request reception needs a ready Songs library and only changes on explicit input', async t => {
  const ui = await fixture(t);
  assert.equal(ui.get('#song-requests-enabled').disabled, true); ui.toggle(true); assert.equal(ui.calls.length, 0);
  for (const library of [undefined, { status: 'scanning', count: 3 }, { status: 'ready', count: 0 }, { status: 'error', count: 3 }]) {
    ui.controls.update({ ...ui.snapshot, library }); ui.toggle(true); assert.equal(ui.calls.length, 0);
  }
  ui.controls.update(ui.snapshot); assert.equal(ui.calls.length, 0); assert.equal(ui.get('#song-requests-enabled').checked, false);
  ui.toggle(true); assert.deepEqual(ui.calls[0].payload, { enabled: true, port: 38474, rules: ui.snapshot.songRequests.rules });
  assert.equal(ui.calls[0].name, 'songRequests.configure');
  ui.toggle(true); assert.equal(ui.calls.length, 1, 'pending request is not duplicated');
  ui.snapshot.songRequests.enabled = true; ui.controls.update({ ...ui.snapshot, library: { status: 'error', count: 0 } });
  ui.calls[0].resolve({ ok: true }); await tick(); assert.equal(ui.get('#song-requests-enabled').disabled, false, 'stop remains available if the library disappears');
  ui.toggle(false); assert.equal(ui.calls[1].payload.enabled, false);
});

test('Song Request rules are validated drafts, preserved across snapshots, and applied together', async t => {
  const ui = await fixture(t); ui.controls.update(ui.snapshot);
  ui.set('max-duration', '7'); ui.set('instrument', 'drums'); ui.set('difficulty', 'expert'); ui.set('port', '49151');
  ui.controls.update({ ...ui.snapshot, songRequests: { ...ui.snapshot.songRequests, revision: 8 } });
  assert.equal(ui.get('#song-requests-max-duration').value, '7'); assert.equal(ui.calls.length, 0);
  ui.submit(); assert.deepEqual(ui.calls[0].payload, { enabled: false, port: 49151, rules: { maxDurationMinutes: 7, instrument: 'drums', difficulty: 'expert' } });
  ui.calls[0].resolve({ ok: false }); await tick(); assert.equal(ui.get('#song-requests-max-duration').value, '7', 'failed apply retains user draft');
  for (const [name, value] of [['max-duration', '61'], ['max-duration', '0'], ['max-duration', '1.5'], ['max-duration', 'NaN']]) {
    ui.set(name, value); ui.submit(); assert.equal(ui.calls.length, 1);
  }
  ui.set('max-duration', ''); ui.set('port', '80'); ui.submit(); assert.equal(ui.calls.length, 1);
  ui.set('port', '65536'); ui.submit(); assert.equal(ui.calls.length, 1);
  ui.set('port', '38474'); ui.submit(); assert.equal(ui.calls[1].payload.rules.maxDurationMinutes, null);
  ui.snapshot.songRequests = { ...ui.snapshot.songRequests, ...ui.calls[1].payload };
  ui.controls.update(ui.snapshot); ui.calls[1].resolve({ ok: true }); await tick();
  assert.equal(ui.get('#song-requests-apply').disabled, true);
});

test('Song Request moderation acts only on eligible explicit cards and never on another request', async t => {
  const ui = await fixture(t); ui.snapshot.songRequests.requests = [request('one'), request('two', 'accepted'), request('three', 'played'), request('four', 'rejected')]; ui.controls.update(ui.snapshot);
  const cards = ui.get('#song-requests-items').children;
  const buttons = index => cards[index].querySelectorAll('button');
  assert.deepEqual(buttons(0).map(node => node.dataset.action), ['accept', 'reject', 'move-up', 'move-down']);
  assert.deepEqual(buttons(1).map(node => node.dataset.action), ['played', 'reject', 'move-up', 'move-down']); assert.equal(buttons(2).length, 0); assert.equal(buttons(3).length, 0);
  assert.equal(ui.get('#song-requests-active-count').textContent, '2'); assert.equal(ui.get('#song-requests-history-count').textContent, '2'); assert.equal(ui.get('#song-requests-accepted-count').textContent, '1');
  const oldAccept = buttons(0)[0]; oldAccept.click(); assert.deepEqual(ui.calls[0].payload, { id: 'one' }); assert.equal(ui.calls[0].name, 'songRequests.accept');
  buttons(1)[0].dispatchEvent(new Event('click')); assert.equal(ui.calls.length, 1, 'only one moderation command in flight');
  ui.snapshot.songRequests.requests[0].status = 'rejected'; ui.controls.update(ui.snapshot); ui.calls[0].resolve({ ok: false }); await tick();
  oldAccept.dispatchEvent(new Event('click')); assert.equal(ui.calls.length, 1, 'removed card listeners cannot act on stale status');
  ui.get('#song-requests-items').children[1].querySelectorAll('button')[0].click(); assert.equal(ui.calls[1].name, 'songRequests.played'); assert.deepEqual(ui.calls[1].payload, { id: 'two' });
});

test('Song Request order buttons preserve boundary protection and target only the selected active song', async t => {
  const ui = await fixture(t); ui.snapshot.songRequests.requests = [request('one'), request('two')]; ui.controls.update(ui.snapshot);
  const buttons = index => ui.get('#song-requests-items').children[index].querySelectorAll('button');
  assert.equal(buttons(0)[2].disabled, true); assert.equal(buttons(1)[3].disabled, true);
  buttons(0)[2].dispatchEvent(new Event('click')); buttons(1)[3].dispatchEvent(new Event('click')); assert.equal(ui.calls.length, 0);
  buttons(1)[2].click(); assert.equal(ui.calls[0].name, 'songRequests.move'); assert.deepEqual(ui.calls[0].payload, { id: 'two', direction: 'up' });
});

test('Song Request dashboard distinguishes native exports and demo data and restores vote ordering explicitly', async t => {
  const ui = await fixture(t); ui.snapshot.songRequests.requests = [request('one')];
  ui.snapshot.state = { gameplay: { state: 'playing' }, nowPlaying: { title: 'Current fixture', artist: 'Demo artist' } }; ui.snapshot.cloneHero = { mode: 'mock' };
  ui.controls.update(ui.snapshot); assert.equal(ui.get('#song-requests-current-label').textContent, 'Démonstration'); assert.equal(ui.get('#song-requests-current-title').textContent, 'Current fixture');
  assert.equal(ui.get('#song-requests-reset-order').hidden, true); ui.get('#song-requests-reset-order').dispatchEvent(new Event('click')); assert.equal(ui.calls.length, 0);
  ui.snapshot.cloneHero.mode = 'live'; ui.snapshot.songRequests.order = 'manual'; ui.controls.update(ui.snapshot);
  assert.equal(ui.get('#song-requests-current-label').textContent, 'Dernier morceau exporté'); assert.match(ui.get('#song-requests-next-title').textContent, /Installed song/);
  ui.get('#song-requests-reset-order').click(); assert.equal(ui.calls[0].name, 'songRequests.resetOrder'); assert.deepEqual(ui.calls[0].payload, {});
  ui.document.documentElement.lang = 'en'; ui.document.defaultView.dispatchEvent(new Event('chartshub:languagechange')); assert.equal(ui.get('#song-requests-current-label').textContent, 'Last exported song');
});

test('Song Request bridge copy is explicit, does not display secrets, and translates feedback live', async t => {
  const ui = await fixture(t); ui.controls.update(ui.snapshot);
  ui.get('#song-requests-copy-bridge').dispatchEvent(new Event('click')); assert.equal(ui.calls.length, 0);
  ui.snapshot.songRequests.bridge = { ...ui.snapshot.songRequests.bridge, enabled: true, url: 'http://127.0.0.1:38474/song-requests', overlayUrl: 'http://127.0.0.1:38474/queue?token=privatefixture', token: 'never-render-me', error: 'C:\\private\\profile\\secret' };
  ui.controls.update(ui.snapshot); assert.equal(ui.calls.length, 0); assert.doesNotMatch(ui.root.textContent, /privatefixture|never-render-me|private\\profile|127\.0\.0\.1/);
  ui.get('#song-requests-copy-bridge').click(); assert.equal(ui.calls[0].name, 'songRequests.copyBridgeConfiguration'); assert.deepEqual(ui.calls[0].payload, {});
  ui.calls[0].resolve({ ok: true }); await tick(); assert.match(ui.get('#song-requests-feedback').textContent, /presse-papiers/);
  ui.document.documentElement.lang = 'en'; ui.document.defaultView.dispatchEvent(new Event('chartshub:languagechange'));
  assert.equal(ui.get('#song-requests-copy-bridge').textContent, 'Copy bridge configuration'); assert.equal(ui.get('#song-requests-feedback').textContent, 'Copied to clipboard.');
  ui.get('#song-requests-copy-overlay').click(); assert.equal(ui.calls[1].name, 'songRequests.copyOverlayUrl');
});

test('Song Request metadata stays plain text, votes update, and accept is disabled after library loss', async t => {
  const ui = await fixture(t); ui.snapshot.songRequests.requests = [{ ...request('safe'), viewerName: '<img src=x onerror=unsafe()>', title: '<script>unsafe()</script>' }]; ui.controls.update(ui.snapshot);
  assert.match(ui.get('#song-requests-items').textContent, /<img src=x/); assert.equal(ui.root.querySelectorAll('img').length, 0);
  ui.snapshot.songRequests.requests[0].votes = 3; ui.controls.update(ui.snapshot); assert.match(ui.get('#song-requests-items').textContent, /3 votes/);
  ui.controls.update({ ...ui.snapshot, library: { status: 'error', count: 1 } });
  const accept = ui.get('#song-requests-items').querySelectorAll('button')[0]; assert.equal(accept.disabled, true); accept.dispatchEvent(new Event('click')); assert.equal(ui.calls.length, 0);
  ui.document.documentElement.lang = 'en'; ui.document.defaultView.dispatchEvent(new Event('chartshub:languagechange')); assert.match(ui.get('#song-requests-items').textContent, /Pending approval/);
});

test('Song Request disposal stops listeners and late async updates', async t => {
  const ui = await fixture(t); ui.controls.update(ui.snapshot); ui.toggle(true); ui.controls.dispose();
  const writes = ui.document.writes; ui.calls[0].resolve({ ok: true }); await tick();
  ui.controls.update(ui.snapshot); ui.toggle(false); ui.document.defaultView.dispatchEvent(new Event('chartshub:languagechange'));
  assert.equal(ui.document.writes, writes); assert.equal(ui.calls.length, 1);
});

test('sharing never publishes on snapshots or language changes and requires an explicit eligible click', async t => {
  const ui = await fixture(t); const publish = ui.get('#song-requests-publish-library');
  ui.controls.update(ui.snapshot); assert.equal(publish.disabled, true);
  publish.dispatchEvent(new Event('click')); assert.equal(ui.calls.length, 0);
  ui.snapshot.songRequests.sharing = { supported: true, url: null, count: 0, updatedAt: null, busy: false, error: null };
  for (const library of [{ status: 'scanning', count: 3 }, { status: 'error', count: 3 }, { status: 'ready', count: 0 }]) {
    ui.controls.update({ ...ui.snapshot, library }); assert.equal(publish.disabled, true); publish.dispatchEvent(new Event('click')); assert.equal(ui.calls.length, 0);
  }
  ui.controls.update(ui.snapshot); assert.equal(publish.disabled, false); assert.equal(ui.get('#song-requests-copy-library').disabled, true);
  ui.document.documentElement.lang = 'en'; ui.document.defaultView.dispatchEvent(new Event('chartshub:languagechange'));
  assert.equal(ui.calls.length, 0); assert.equal(publish.textContent, 'Publish song list'); assert.match(ui.get('#song-requests-sharing-help').textContent, /no audio, notes or local paths/);
  publish.click(); assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0].name, 'songRequests.publishLibrary'); assert.deepEqual(ui.calls[0].payload, {});
  publish.dispatchEvent(new Event('click')); assert.equal(ui.calls.length, 1, 'a pending publication cannot be duplicated');
  ui.calls[0].resolve({ ok: true }); await tick(); assert.equal(ui.get('#song-requests-feedback').textContent, 'List published. Copy the link for your viewers.');
  assert.equal(ui.get('#song-requests-enabled').checked, false, 'publishing never starts reception');
});

test('published snapshots can be copied or withdrawn despite library loss and never reveal private data', async t => {
  const ui = await fixture(t); ui.snapshot.songRequests.requests = [{ ...request('one'), viewerName: 'YouTube Reader', title: 'My personal song' }];
  ui.snapshot.songRequests.sharing = { supported: true, url: 'https://chartshub.ca/song-requests.html?library=' + 'a'.repeat(64), count: 2, unavailableCount: 1, updatedAt: '2026-10-10T20:00:00Z', busy: false,
    error: 'Private C:\\Songs\\authoring-token', root: 'C:\\Songs', token: 'never-render-authoring-key', privateIds: ['private-id-123'] };
  ui.controls.update({ ...ui.snapshot, library: { status: 'error', count: 3 } });
  assert.equal(ui.get('#song-requests-publish-library').disabled, true); assert.equal(ui.get('#song-requests-copy-library').disabled, false); assert.equal(ui.get('#song-requests-remove-library').disabled, false);
  assert.equal(ui.get('#song-requests-publish-library').textContent, 'Actualiser la liste'); assert.match(ui.get('#song-requests-sharing-status').textContent, /2 morceaux/); assert.match(ui.get('#song-requests-sharing-status').textContent, /1 morceau indisponible exclu/);
  assert.match(ui.get('#song-requests-items').textContent, /YouTube Reader/); assert.match(ui.get('#song-requests-items').textContent, /My personal song/);
  assert.doesNotMatch(ui.root.textContent, /authoring-token|never-render-authoring-key|C:\\Songs|private-id-123/);
  ui.get('#song-requests-copy-library').click(); assert.equal(ui.calls[0].name, 'songRequests.copyLibraryUrl'); assert.deepEqual(ui.calls[0].payload, {});
  ui.calls[0].resolve({ ok: true }); await tick();
  ui.get('#song-requests-remove-library').click(); assert.equal(ui.calls[1].name, 'songRequests.removeLibrary'); assert.deepEqual(ui.calls[1].payload, {});
  ui.calls[1].resolve({ ok: true }); await tick(); assert.match(ui.get('#song-requests-feedback').textContent, /Partage retiré/);
  ui.document.documentElement.lang = 'en'; ui.document.defaultView.dispatchEvent(new Event('chartshub:languagechange'));
  assert.equal(ui.get('#song-requests-copy-library').textContent, 'Copy public link'); assert.match(ui.get('#song-requests-sharing-status').textContent, /1 unavailable song excluded/);
  assert.match(ui.get('#song-requests-feedback').textContent, /Sharing removed/); assert.match(ui.get('#song-requests-items').textContent, /YouTube Reader/);
});

test('sharing support and busy gates also block dispatched actions and failure feedback stays generic', async t => {
  const ui = await fixture(t), sharing = { supported: true, url: 'https://chartshub.ca/song-requests.html?library=' + 'a'.repeat(64), count: 3, updatedAt: null, busy: false, error: null };
  for (const variant of [{ ...sharing, supported: false }, { ...sharing, busy: true }]) {
    ui.snapshot.songRequests.sharing = variant; ui.controls.update(ui.snapshot);
    for (const id of ['publish-library', 'copy-library', 'remove-library']) { const button = ui.get('#song-requests-' + id); assert.equal(button.disabled, true); button.dispatchEvent(new Event('click')); }
    assert.equal(ui.calls.length, 0);
  }
  ui.snapshot.songRequests.sharing = sharing; ui.controls.update(ui.snapshot); ui.get('#song-requests-publish-library').click();
  ui.calls[0].resolve({ ok: false, error: 'C:\\Private\\secret-token' }); await tick();
  assert.match(ui.get('#song-requests-feedback').textContent, /Partage indisponible/); assert.doesNotMatch(ui.root.textContent, /Private|secret-token/);
  assert.equal(ui.get('#song-requests-publish-library').disabled, false);
});
