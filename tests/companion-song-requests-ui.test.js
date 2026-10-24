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
const connections = changes => ({ receiving: false, persistent: true, storageError: null, lastResponse: null,
  twitch: { state: 'disconnected', displayName: null, error: null, canReply: true },
  tiktok: { state: 'disconnected', displayName: null, error: null, canReply: false }, ...changes });

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
  ui.get('#song-requests-items').children.find(card => card.dataset.requestId === 'two').querySelectorAll('button')[0].click(); assert.equal(ui.calls[1].name, 'songRequests.played'); assert.deepEqual(ui.calls[1].payload, { id: 'two' });
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

test('large-library sharing displays preparation and upload counts with actionable fixed bilingual errors', async t => {
  const ui = await fixture(t);
  ui.snapshot.songRequests.sharing = { supported: true, url: 'https://chartshub.ca/song-requests.html?library=' + 'a'.repeat(64), count: 83401, updatedAt: null, busy: true, error: null,
    progress: { phase: 'preparing', processed: 10000, total: 83401 } };
  ui.controls.update(ui.snapshot);
  assert.match(ui.get('#song-requests-sharing-status').textContent, /Vérification des morceaux/);
  assert.match(ui.get('#song-requests-sharing-status').textContent.replace(/\D/g, ''), /1000083401/);
  ui.snapshot.songRequests.sharing.progress = { phase: 'uploading', processed: 500, total: 83401 };
  ui.controls.update(ui.snapshot); assert.match(ui.get('#song-requests-sharing-status').textContent, /Envoi de la liste/);
  ui.snapshot.songRequests.sharing.busy = false; ui.snapshot.songRequests.sharing.error = 'SHARE_LIBRARY_LIMIT';
  ui.controls.update(ui.snapshot); assert.match(ui.get('#song-requests-sharing-status').textContent, /83401/);
  assert.match(ui.get('#song-requests-sharing-error').textContent, /200 000 morceaux/);
  assert.match(ui.get('#song-requests-sharing-error').textContent, /précédemment reste disponible/);
  ui.snapshot.songRequests.sharing.error = 'SHARE_SERVER_UPDATE_REQUIRED';
  ui.document.documentElement.lang = 'en'; ui.document.defaultView.dispatchEvent(new Event('chartshub:languagechange'));
  assert.match(ui.get('#song-requests-sharing-error').textContent, /site needs an update/);
  assert.doesNotMatch(ui.get('#song-requests-sharing-error').textContent, /Internet/);
  ui.snapshot.songRequests.sharing.error = 'SHARE_ACCESS_DENIED'; ui.controls.update(ui.snapshot);
  assert.match(ui.get('#song-requests-sharing-error').textContent, /denied permission/);
  assert.doesNotMatch(ui.get('#song-requests-sharing-error').textContent, /Verify.*email/);
  assert.equal(ui.calls.length, 0);
});

test('automatic public-list status distinguishes pending, retries and disabled detection without triggering commands',async t=>{
  const ui=await fixture(t),sharing={supported:true,url:'https://chartshub.ca/song-requests.html?library='+'a'.repeat(64),count:3,updatedAt:null,busy:false,error:null,
    autoSync:{enabled:true,pending:true,updating:false,retrying:false}};
  ui.snapshot.songRequests.sharing=sharing;ui.controls.update(ui.snapshot);
  assert.match(ui.get('#song-requests-sharing-status').textContent,/Mise à jour automatique en attente/);
  assert.match(ui.get('#song-requests-sharing-help').textContent,/même lien/);
  sharing.autoSync.retrying=true;ui.controls.update(ui.snapshot);assert.match(ui.get('#song-requests-sharing-status').textContent,/Nouvelle tentative/);
  sharing.autoSync.retrying=false;ui.controls.update({...ui.snapshot,library:{status:'scanning',count:3}});
  assert.match(ui.get('#song-requests-sharing-status').textContent,/prochaine analyse réussie/);
  sharing.autoSync.pending=false;ui.controls.update({...ui.snapshot,library:{status:'ready',count:3,settings:{watch:false}}});
  assert.match(ui.get('#song-requests-sharing-status').textContent,/Détection désactivée/);
  ui.document.documentElement.lang='en';ui.document.defaultView.dispatchEvent(new Event('chartshub:languagechange'));
  assert.match(ui.get('#song-requests-sharing-status').textContent,/Folder detection is off/);assert.equal(ui.calls.length,0);
});

test('an automatic upload keeps withdrawal available and failures preserve the previous public-list explanation',async t=>{
  const ui=await fixture(t),sharing={supported:true,url:'https://chartshub.ca/song-requests.html?library='+'a'.repeat(64),count:3,updatedAt:null,busy:true,error:null,
    autoSync:{enabled:true,pending:true,updating:true,retrying:false},progress:{phase:'uploading',processed:1,total:4}};
  ui.snapshot.songRequests.sharing=sharing;ui.controls.update(ui.snapshot);
  assert.equal(ui.get('#song-requests-publish-library').disabled,true);assert.equal(ui.get('#song-requests-remove-library').disabled,false);
  ui.get('#song-requests-remove-library').click();assert.equal(ui.calls[0].name,'songRequests.removeLibrary');
  ui.get('#song-requests-remove-library').dispatchEvent(new Event('click'));assert.equal(ui.calls.length,1);
  ui.calls[0].resolve({ok:false});await tick();sharing.busy=false;sharing.error='SHARE_NETWORK';sharing.autoSync.updating=false;ui.controls.update(ui.snapshot);
  assert.match(ui.get('#song-requests-sharing-error').textContent,/précédemment reste disponible/);
  assert.equal(sharing.url.includes('library='),true);
});

test('direct account connections are explicit and never enable reception or publish the library', async t => {
  const ui = await fixture(t); ui.controls.update(ui.snapshot);
  ui.get('#song-requests-twitch-connect').dispatchEvent(new Event('click')); assert.equal(ui.calls.length, 0);
  ui.snapshot.songRequests.connections = connections(); ui.controls.update(ui.snapshot);
  ui.document.documentElement.lang = 'en'; ui.document.defaultView.dispatchEvent(new Event('chartshub:languagechange'));
  assert.equal(ui.calls.length, 0); assert.equal(ui.get('#song-requests-twitch-connect').textContent, 'Connect Twitch');
  ui.get('#song-requests-twitch-connect').click();
  assert.deepEqual(ui.calls[0].payload, { platform: 'twitch' }); assert.equal(ui.calls[0].name, 'songRequests.connect');
  ui.get('#song-requests-twitch-connect').dispatchEvent(new Event('click')); assert.equal(ui.calls.length, 1);
  ui.calls[0].resolve({ ok: true }); await tick();
  assert.equal(ui.get('#song-requests-enabled').checked, false); assert.equal(ui.calls.length, 1);
});

test('Twitch device authorization displays a bounded user code and cancellation stays available during connect', async t => {
  const ui = await fixture(t); ui.snapshot.songRequests.connections = connections(); ui.controls.update(ui.snapshot);
  ui.get('#song-requests-twitch-connect').click();
  const value = ui.snapshot.songRequests.connections;
  value.twitch = { state: 'authorizing', displayName: null, error: null, canReply: true, userCode: 'ABCD-EFGH', accessToken: 'private-provider-token', verificationUrl: 'https://private.invalid/auth' };
  ui.controls.update(ui.snapshot);
  assert.equal(ui.get('#song-requests-twitch-cancel').hidden, false); assert.equal(ui.get('#song-requests-twitch-cancel').disabled, false);
  assert.match(ui.get('#song-requests-twitch-user-code').textContent, /ABCD-EFGH/);
  assert.equal(ui.get('#song-requests-twitch-connect').disabled, true);
  assert.doesNotMatch(ui.root.textContent, /private-provider-token|private\.invalid/);
  ui.get('#song-requests-twitch-cancel').click();
  assert.equal(ui.calls[1].name, 'songRequests.cancelAuth'); assert.deepEqual(ui.calls[1].payload, { platform: 'twitch' });
  ui.calls[0].resolve({ ok: false, error: 'old private failure' }); await tick();
  assert.equal(ui.get('#song-requests-twitch-cancel').disabled, true, 'late connect completion cannot clear the pending cancel');
  ui.calls[1].resolve({ ok: true }); value.twitch.state = 'disconnected'; ui.controls.update(ui.snapshot); await tick();
  assert.equal(ui.get('#song-requests-twitch-cancel').hidden, true); assert.equal(ui.get('#song-requests-twitch-user-code').hidden, true);
  assert.equal(ui.get('#song-requests-twitch-connect').disabled, false); assert.doesNotMatch(ui.root.textContent, /old private failure/);
});

test('TikTok accepts only an explicit bounded username and does not connect from typing or rendering', async t => {
  const ui = await fixture(t); ui.snapshot.songRequests.connections = connections(); ui.controls.update(ui.snapshot);
  const input = ui.get('#song-requests-tiktok-username'), form = ui.get('#song-requests-tiktok-form');
  for (const invalid of ['', 'https://tiktok.com/@fixture', 'bad name', 'bad\nname', '.fixture', 'fixture.', 'fixture..name', 'a'.repeat(25), '@@fixture']) {
    input.value = invalid; form.dispatchEvent(new Event('submit', { cancelable: true }));
    assert.equal(ui.calls.length, 0); assert.equal(input.getAttribute('aria-invalid'), 'true');
  }
  input.value = ' @fixture.name_1 '; input.dispatchEvent(new Event('input'));
  ui.controls.update(ui.snapshot); assert.equal(ui.calls.length, 0);
  assert.equal(input.value, ' @fixture.name_1 ', 'snapshots do not replace the username draft');
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  assert.equal(ui.calls[0].name, 'songRequests.connect'); assert.deepEqual(ui.calls[0].payload, { platform: 'tiktok', username: 'fixture.name_1' });
  form.dispatchEvent(new Event('submit', { cancelable: true })); assert.equal(ui.calls.length, 1);
  ui.calls[0].resolve({ ok: true }); await tick(); assert.equal(ui.get('#song-requests-enabled').checked, false);
});

test('connected platforms disconnect independently and connection buttons cannot duplicate an active connection', async t => {
  const ui = await fixture(t); const value = connections({
    twitch: { state: 'connected', displayName: 'Twitch fixture', error: null, canReply: true },
    tiktok: { state: 'connected', displayName: 'TikTok fixture', error: null, canReply: false }
  });
  ui.snapshot.songRequests.connections = value; ui.controls.update(ui.snapshot);
  assert.match(ui.get('#song-requests-twitch-status').textContent, /Connecté · Twitch fixture/);
  assert.equal(ui.get('#song-requests-tiktok-username').disabled, true);
  for (const platform of ['twitch', 'tiktok']) ui.get('#song-requests-' + platform + '-connect').dispatchEvent(new Event('click'));
  assert.equal(ui.calls.length, 0);
  ui.get('#song-requests-twitch-disconnect').click(); ui.get('#song-requests-tiktok-disconnect').click();
  assert.deepEqual(ui.calls.map(call => [call.name, call.payload]), [
    ['songRequests.disconnect', { platform: 'twitch' }], ['songRequests.disconnect', { platform: 'tiktok' }]
  ]);
  ui.calls.forEach(call => call.resolve({ ok: true })); await tick();
  assert.equal(ui.snapshot.songRequests.enabled, false);
});

test('a TikTok username prepared before the LIVE can be forgotten without enabling reception', async t => {
  const ui = await fixture(t);
  ui.snapshot.songRequests.connections = connections({ tiktok: { state: 'disconnected', displayName: '@fixture', error: null, canReply: false } });
  ui.controls.update(ui.snapshot);
  assert.match(ui.get('#song-requests-tiktok-status').textContent, /Compte prêt · @fixture/);
  assert.match(ui.get('#song-requests-tiktok-help').textContent, /quand votre LIVE démarre/);
  assert.equal(ui.get('#song-requests-tiktok-connect').disabled, true);
  assert.equal(ui.get('#song-requests-tiktok-disconnect').hidden, false);
  assert.equal(ui.get('#song-requests-tiktok-disconnect').disabled, false);
  ui.get('#song-requests-tiktok-connect').dispatchEvent(new Event('click'));
  assert.equal(ui.calls.length, 0);
  ui.get('#song-requests-tiktok-disconnect').click();
  assert.equal(ui.calls[0].name, 'songRequests.disconnect'); assert.deepEqual(ui.calls[0].payload, { platform: 'tiktok' });
  ui.calls[0].resolve({ ok: true }); await tick();
  assert.equal(ui.get('#song-requests-enabled').checked, false);
});

test('TikTok limitations, offline status and locally displayed replies are honest, plain text and bilingual', async t => {
  const ui = await fixture(t); const value = connections({
    tiktok: { state: 'offline', displayName: '<img src=x onerror=unsafe()>', error: 'not_live', canReply: false },
    lastResponse: { platform: 'tiktok', message: '<script>local response</script>' }
  });
  ui.snapshot.songRequests.connections = value; ui.controls.update(ui.snapshot);
  assert.match(ui.get('#song-requests-tiktok-help').textContent, /prochain direct/);
  assert.equal(ui.get('#song-requests-last-response').hidden, false);
  assert.equal(ui.get('#song-requests-last-response-message').textContent, '<script>local response</script>');
  assert.equal(ui.root.querySelectorAll('img').length, 0); assert.equal(ui.root.querySelectorAll('script').length, 0);
  value.tiktok.error = null; ui.controls.update(ui.snapshot);
  assert.match(ui.get('#song-requests-tiktok-provider-help').textContent, /non officiel/);
  assert.match(ui.get('#song-requests-tiktok-provider-help').textContent, /Euler Stream/);
  assert.match(ui.get('#song-requests-tiktok-provider-help').textContent, /chat LIVE public/);
  assert.match(ui.get('#song-requests-tiktok-provider-help').textContent, /aucun message n’est envoyé/);
  ui.document.documentElement.lang = 'en'; ui.document.defaultView.dispatchEvent(new Event('chartshub:languagechange'));
  assert.match(ui.get('#song-requests-tiktok-provider-help').textContent, /unofficial connector/);
  assert.match(ui.get('#song-requests-tiktok-provider-help').textContent, /Euler Stream/);
  assert.match(ui.get('#song-requests-tiktok-provider-help').textContent, /no messages are sent to TikTok chat/);
  assert.equal(ui.get('#song-requests-last-response-label').textContent, 'Last TikTok response — shown here');
  assert.equal(ui.calls.length, 0);
  value.lastResponse = { platform: 'twitch', message: 'not a TikTok response' }; ui.controls.update(ui.snapshot);
  assert.equal(ui.get('#song-requests-last-response').hidden, true); assert.equal(ui.get('#song-requests-last-response-message').textContent, '');
});

test('connection errors never display raw provider details or ask users for application developer credentials', async t => {
  const ui = await fixture(t); const value = connections({ persistent: false, storageError: 'encryption_unavailable',
    twitch: { state: 'error', displayName: null, error: 'setup_required', canReply: true, userCode: 'PRIVATE TOKEN NOT A CODE' } });
  ui.snapshot.songRequests.connections = value; ui.controls.update(ui.snapshot);
  assert.match(ui.get('#song-requests-twitch-help').textContent, /prochaine mise à jour/);
  assert.match(ui.get('#song-requests-connection-storage').textContent, /uniquement pour cette session/);
  assert.equal(ui.get('#song-requests-twitch-user-code').hidden, true);
  value.twitch.error = 'C:\\Private\\access-token'; value.storageError = 'private path'; ui.controls.update(ui.snapshot);
  assert.match(ui.get('#song-requests-twitch-help').textContent, /Réessayez plus tard/);
  assert.match(ui.get('#song-requests-connection-storage').textContent, /données existantes sont conservées/);
  assert.doesNotMatch(ui.root.textContent, /Private|access-token|private path|PRIVATE TOKEN/);
  assert.equal(ui.calls.length, 0);
});

test('direct receiving status is independent of bridge availability and control disposal blocks late connection callbacks', async t => {
  const ui = await fixture(t); ui.snapshot.songRequests.enabled = true; ui.snapshot.songRequests.connections = connections({ receiving: true });
  ui.controls.update(ui.snapshot); assert.equal(ui.get('#song-requests-status').textContent, 'Réception active');
  assert.equal(ui.snapshot.songRequests.bridge.enabled, false);
  ui.get('#song-requests-twitch-connect').click(); ui.controls.dispose();
  const writes = ui.document.writes; ui.calls[0].resolve({ ok: false, error: 'late secret' }); await tick();
  ui.get('#song-requests-twitch-connect').dispatchEvent(new Event('click'));
  assert.equal(ui.calls.length, 1); assert.equal(ui.document.writes, writes);
});


test('request readiness overview distinguishes chat, library and public sharing and opens existing resolution controls', async t => {
  const ui = await fixture(t); ui.snapshot.songRequests.connections = connections({ twitch: { state: 'connected', displayName: 'Fixture channel', error: null, canReply: true } });
  ui.snapshot.songRequests.sharing = { supported: true, url: 'https://example.invalid/list', count: 3, updatedAt: null, busy: false, error: null };
  ui.controls.update(ui.snapshot); assert.match(ui.get('#song-requests-health-chat').textContent, /Chat connecté/); assert.match(ui.get('#song-requests-health-chat-help').textContent, /quand vous êtes prêt/); assert.match(ui.get('#song-requests-health-library').textContent, /3 morceaux prêts/); assert.equal(ui.get('#song-requests-health-sharing').textContent, 'Liste publiée');
  assert.equal(ui.calls.length, 0); ui.get('#song-requests-resolve-chat').click(); assert.equal(ui.get('#song-requests-connections-details').open, true); ui.get('#song-requests-resolve-sharing').click(); assert.equal(ui.get('#song-requests-sharing').open, true); assert.equal(ui.calls.length, 0);
  let openedLibrary = false; ui.document.defaultView.addEventListener('companion:library-focus', () => { openedLibrary = true; }); ui.get('#song-requests-resolve-library').click(); assert.equal(openedLibrary, true);
  ui.controls.update({ ...ui.snapshot, library: { status: 'scanning', count: 3 }, songRequests: { ...ui.snapshot.songRequests, publicRequests: { supported: true, active: true, connected: true, error: null, pendingAcknowledgements: 0 }, sharing: { ...ui.snapshot.songRequests.sharing, error: 'PRIVATE TOKEN C:\\secret' } } });
  assert.match(ui.get('#song-requests-health-library').textContent, /Analyse/); assert.equal(ui.get('#song-requests-health-sharing').textContent, 'Partage à vérifier'); assert.equal(ui.get('#song-requests-health-web').textContent, 'Site web : réception active'); assert.doesNotMatch(ui.root.textContent, /PRIVATE TOKEN|secret/);
  ui.document.documentElement.lang = 'en'; ui.document.defaultView.dispatchEvent(new Event('chartshub:languagechange')); assert.equal(ui.get('#song-requests-health-library').textContent, 'Scan in progress…'); assert.equal(ui.get('#song-requests-health-web').textContent, 'Website: receiving requests');
});

test('compact request queue keeps active songs first, hides history until requested and skips with one explicit command', async t => {
  const ui = await fixture(t); ui.snapshot.songRequests.requests = [request('history', 'played'), request('first'), request('next', 'accepted')]; ui.controls.update(ui.snapshot);
  const cards = ui.get('#song-requests-items').children; assert.deepEqual(cards.map(card => card.dataset.requestId), ['first', 'next', 'history']); assert.equal(cards[2].hidden, true); assert.equal(cards[0].querySelector('.song-request-position').textContent, '1'); assert.equal(cards[1].querySelector('.song-request-position').textContent, '2');
  ui.get('#song-requests-toggle-history').click(); assert.equal(ui.get('#song-requests-toggle-history').getAttribute('aria-expanded'), 'true'); assert.equal(ui.get('#song-requests-items').children[2].hidden, false);
  const skip = ui.get('#song-requests-items').children[1].querySelectorAll('button').find(button => button.dataset.action === 'reject'); assert.equal(skip.textContent, 'Passer'); skip.click(); assert.deepEqual(ui.calls[0].payload, { id: 'next' }); assert.equal(ui.calls[0].name, 'songRequests.reject'); skip.click(); assert.equal(ui.calls.length, 1);
});

test('OBS widget settings preserve independent drafts and validate bounds before one explicit settings command', async t => {
  const ui = await fixture(t), settings = { accentColor: '#38bdf8', fontSize: 24, upcomingCount: 3, showNowPlaying: true, showViewerNames: true };
  ui.snapshot.songRequests.widget = settings; ui.controls.update(ui.snapshot); assert.equal(ui.get('#song-requests-widget-count').value, '3'); assert.equal(ui.get('#song-requests-widget-apply').disabled, true); assert.equal(ui.calls.length, 0);
  ui.set('max-duration', '8'); ui.set('widget-size', '30'); ui.set('widget-count', '4'); ui.set('widget-color', '#AABBCC'); ui.get('#song-requests-widget-viewers').checked = false;
  ui.controls.update({ ...ui.snapshot, songRequests: { ...ui.snapshot.songRequests, revision: 17 } }); assert.equal(ui.get('#song-requests-widget-size').value, '30'); assert.equal(ui.get('#song-requests-max-duration').value, '8'); assert.equal(ui.calls.length, 0);
  for (const [name, value] of [['widget-size', '15'], ['widget-size', '49'], ['widget-size', '18.5'], ['widget-count', '0'], ['widget-count', '11'], ['widget-color', 'invalid']]) {
    ui.set('widget-size', '30'); ui.set('widget-count', '4'); ui.set('widget-color', '#AABBCC'); ui.set(name, value); ui.get('#song-requests-widget-form').dispatchEvent(new Event('submit', { cancelable: true })); assert.equal(ui.calls.length, 0);
  }
  ui.set('widget-size', '30'); ui.set('widget-count', '4'); ui.set('widget-color', '#AABBCC'); ui.get('#song-requests-widget-form').dispatchEvent(new Event('submit', { cancelable: true }));
  assert.equal(ui.calls[0].name, 'songRequests.widget'); assert.deepEqual(ui.calls[0].payload, { settings: { accentColor: '#aabbcc', fontSize: 30, upcomingCount: 4, showNowPlaying: true, showViewerNames: false } });
  ui.calls[0].resolve({ ok: false }); await tick(); assert.equal(ui.get('#song-requests-widget-size').value, '30'); assert.equal(ui.get('#song-requests-max-duration').value, '8'); assert.equal(ui.get('#song-requests-widget-apply').disabled, false);
  ui.get('#song-requests-widget-form').dispatchEvent(new Event('submit', { cancelable: true })); ui.snapshot.songRequests.widget = ui.calls[1].payload.settings; ui.controls.update(ui.snapshot); ui.calls[1].resolve({ ok: true }); await tick(); assert.equal(ui.get('#song-requests-widget-apply').disabled, true); assert.equal(ui.get('#song-requests-apply').disabled, false, 'saving widget keeps the rules draft');
});


test('anonymous website requests use clear bilingual platform and viewer labels', async t => {
  const ui = await fixture(t); ui.snapshot.songRequests.requests = [{ ...request('website'), platform: 'website', viewerName: 'Spectateur web' }]; ui.controls.update(ui.snapshot);
  assert.match(ui.get('#song-requests-items').textContent, /Spectateur web · Site web/);
  ui.document.documentElement.lang = 'en'; ui.document.defaultView.dispatchEvent(new Event('chartshub:languagechange')); assert.match(ui.get('#song-requests-items').textContent, /Website visitor · Website/);
});
