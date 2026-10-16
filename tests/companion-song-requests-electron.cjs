'use strict';
const { clipboard } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label) {
  const start = Date.now();
  while (Date.now() - start < 15000) { if (await check()) return; await delay(40); }
  throw Error('Timed out: Song Request ' + label);
}
async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function post(url, token, body, extra = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': bytes.length, ...extra } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: response.statusCode, json }); });
    });
    request.on('error', reject); request.setTimeout(5000, () => request.destroy(Error('Fixture POST timeout'))); request.end(bytes);
  });
}

function createSongRequestSharingFixture() {
  let current = { url: null, count: 0, updatedAt: null }, removed = 0;
  const publications = [], publicUrl = 'https://chartshub.ca/song-requests.html?library=' + 'a'.repeat(64);
  const context = Object.freeze({ generation: 0, userId: 'song-request-fixture' });
  const connections = { providers: {}, connects: [], stops: [], replies: [] };
  const provider = platform => options => {
    let value = { state: 'disconnected', displayName: null, error: null, canReply: platform === 'twitch' };
    let receiving = false, authorize = null;
    const publish = () => options.onStatus?.(structuredClone(value));
    const adapter = {
      status: () => structuredClone(value),
      connect: async input => {
        connections.connects.push({ platform, ...(platform === 'tiktok' ? { username: input.username } : {}) });
        if (platform === 'twitch') {
          value = { ...value, state: 'authorizing', userCode: 'FIXT-1234' }; publish();
          await new Promise(resolve => { authorize = resolve; }); return adapter.status();
        }
        value = { ...value, state: receiving ? 'connected' : 'disconnected', displayName: '@' + input.username }; publish(); return adapter.status();
      },
      setReceiving: async enabled => {
        receiving = enabled === true;
        if (platform === 'tiktok' && value.displayName) value.state = receiving ? 'connected' : 'disconnected';
        publish(); return adapter.status();
      },
      stop: async () => {
        connections.stops.push(platform); receiving = false; value = { ...value, state: 'disconnected', userCode: undefined };
        authorize?.(); authorize = null; publish(); return adapter.status();
      },
      disconnect: async () => { await adapter.stop(); value.displayName = null; publish(); return adapter.status(); },
      sendReply: async message => { connections.replies.push({ platform, message }); return { ok: true }; },
      message: (query, eventId = randomUUID()) => options.onMessage({ platform, query, eventId, viewerId: '742', viewerName: 'Native fixture viewer' })
    };
    connections.providers[platform] = adapter; return adapter;
  };
  return {
    publicUrl, publications, removals: () => removed, connections,
    connectionOptions: { createTwitch: provider('twitch'), createTikTok: provider('tiktok') },
    client: {
      capture: async () => context,
      status: async () => ({ ...current }),
      publish: async (payload, captured) => {
        assert.equal(captured, context); assert.deepEqual(Object.keys(payload).sort(), ['rules', 'songs']);
        assert.ok(Array.isArray(payload.songs) && payload.songs.length > 0);
        assert.deepEqual(Object.keys(payload.rules).sort(), ['difficulty', 'instrument', 'maxDurationMinutes']);
        for (const song of payload.songs) {
          assert.deepEqual(Object.keys(song).sort(), ['artist', 'charter', 'durationMs', 'id', 'title', 'tracks']);
          assert.match(song.id, /^[a-f0-9]{64}$/); assert.equal(song.artist, 'Fixture Artist'); assert.equal(song.charter, 'Fixture Creator');
          assert.equal(song.durationMs, 180000); assert.deepEqual(song.tracks, [{ instrument: 'guitar', difficulty: 'expert' }]);
        }
        publications.push(structuredClone(payload));
        current = { url: publicUrl, count: payload.songs.length, updatedAt: '2026-10-10T20:00:00.000Z' }; return { ...current };
      },
      remove: async captured => { assert.equal(captured, context); removed++; current = { url: null, count: 0, updatedAt: null }; return { ...current }; },
    },
  };
}

/** Real main-panel IPC, authenticated loopback transport and isolated Songs only. No live accounts. */
async function verifySongRequests(panel, host, data, passed, sharingFixture) {
  const evaluate = code => panel.webContents.executeJavaScript(code);
  const initialLanguage = host.snapshot().language, originalWriteText = clipboard.writeText;
  let copiedText = '';
  clipboard.writeText = text => { copiedText = String(text); };
  const initialSize = panel.getSize(), fixtureRoot = path.join(data, 'song-requests-Songs-' + randomUUID());
  const click = async selector => {
    await waitFor(() => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return n&&!n.disabled&&!n.hidden})()`), 'enabled ' + selector);
    panel.focus(); panel.webContents.focus();
    const point = await evaluate(`(async()=>{
      const selector=${JSON.stringify(selector)};
      const initial=document.querySelector(selector);
      if(!initial)throw Error('Missing Song Request control: '+selector);
      initial.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const n=document.querySelector(selector);
      if(!n||n.disabled||n.hidden)throw Error('Unavailable Song Request control: '+selector);
      const r=n.getBoundingClientRect();
      if(r.width<=0||r.height<=0)throw Error('Hidden Song Request control: '+selector);
      const p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
      const h=document.elementFromPoint(p.x,p.y);
      if(!h||!(h===n||n.contains(h)))throw Error('Covered Song Request control: '+selector);
      return p;
    })()`);
    panel.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    panel.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    panel.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 }); await delay(50);
  };
  const type = async (selector, value) => {
    await click(selector); const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'];
    panel.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers }); panel.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers });
    await panel.webContents.insertText(String(value)); panel.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' }); panel.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  };
  const command = (name, payload) => evaluate(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`);
  const state = () => host.snapshot().songRequests;
  const byTitle = title => state().requests.find(item => item.title === title);
  const selector = (request, action) => `#song-requests-items [data-request-id="${request.id}"] [data-action="${action}"]`;
  const shot = async name => { await delay(80); await fs.writeFile(path.join(data, name), (await panel.webContents.capturePage()).toPNG()); };
  let configuration;
  try {
    assert.ok(sharingFixture?.connections.providers.twitch && sharingFixture.connections.providers.tiktok, 'native provider fixtures must be injected before testing connection controls');
    const connectionFixture = sharingFixture.connections;
    assert.equal(connectionFixture.connects.length, 0, 'opening the panel never connects a chat account');
    for (const id of ['advanced', 'rules-details', 'sharing']) assert.equal(await evaluate(`document.querySelector('#song-requests-${id}').open`), false, id + ' starts collapsed');
    await evaluate("document.querySelector('#song-requests-panel').scrollIntoView({block:'start'})");
    assert.equal(await evaluate("document.querySelector('#song-requests-twitch-connect').getBoundingClientRect().width>0 && document.querySelector('#song-requests-tiktok-username').getBoundingClientRect().width>0"), true);
    await click('#song-requests-twitch-connect');
    await waitFor(() => state().connections.twitch.state === 'authorizing', 'mock Twitch authorization');
    await waitFor(() => evaluate("!document.querySelector('#song-requests-twitch-cancel').disabled && !document.querySelector('#song-requests-twitch-cancel').hidden"), 'authorization cancellation remains usable');
    assert.equal(await evaluate("document.querySelector('#song-requests-twitch-user-code').textContent.includes('FIXT-1234')"), true);
    assert.equal(state().enabled, false);
    await shot('song-requests-direct-twitch-authorization.png');
    await click('#song-requests-twitch-cancel');
    await waitFor(() => state().connections.twitch.state === 'disconnected', 'mock Twitch consent cancelled');
    await waitFor(() => evaluate("!document.querySelector('#song-requests-twitch-connect').disabled"), 'Twitch reconnect available after cancellation');
    assert.equal(connectionFixture.connects.filter(item => item.platform === 'twitch').length, 1);
    await type('#song-requests-tiktok-username', '@fixture_streamer');
    assert.equal(connectionFixture.connects.filter(item => item.platform === 'tiktok').length, 0, 'typing is not a connection');
    assert.match(await evaluate("document.querySelector('#song-requests-tiktok-provider-help').textContent"), /Euler Stream/);
    await click('#song-requests-tiktok-connect');
    await waitFor(() => state().connections.tiktok.displayName === '@fixture_streamer', 'mock TikTok username prepared');
    await waitFor(() => evaluate("document.querySelector('#song-requests-tiktok-status').textContent.includes('prêt') && !document.querySelector('#song-requests-tiktok-disconnect').hidden"), 'TikTok prepared account can be disconnected');
    assert.equal(state().enabled, false, 'preparing TikTok does not require a live stream or enable reception');
    assert.equal(sharingFixture.publications.length, 0, 'connecting accounts never publishes the Songs library');
    await shot('song-requests-direct-tiktok-prepared.png');
    await click('#song-requests-tiktok-disconnect');
    await waitFor(() => !state().connections.tiktok.displayName, 'prepared TikTok username forgotten');
    await waitFor(() => evaluate("!document.querySelector('#song-requests-tiktok-username').disabled"), 'TikTok username editable after disconnect');
    passed.push('Song Requests direct: account buttons visible before advanced setup, cancellable Twitch consent and TikTok preparation without LIVE or automatic reception');

    for (const [index, title] of ['SR Fixture Alpha', 'SR Fixture Beta', 'SR Fixture Changed'].entries()) {
      const folder = path.join(fixtureRoot, String(index)); await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'song.ini'), `[song]\nname = ${title}\nartist = Fixture Artist\ncharter = Fixture Creator\nsong_length = 180000\ndiff_guitar = 4\n`);
      await fs.writeFile(path.join(folder, 'notes.chart'), `[Song]\n{\n Name = "${title}"\n Resolution = 192\n}\n[SyncTrack]\n{\n 0 = B 120000\n}\n[ExpertSingle]\n{\n 0 = N 0 0\n 192 = N 1 0\n}\n`);
      await fs.writeFile(path.join(folder, 'song.ogg'), 'Fixture audio presence only; no playback');
    }
    await host.library.selectRoot(fixtureRoot); await waitFor(() => host.library.status().status === 'ready' && host.library.status().count === 3, 'isolated library scan');
    await waitFor(() => evaluate("!document.querySelector('#song-requests-enabled').disabled"), 'initial controls');
    assert.equal(state().enabled, false, 'reception starts stopped');
    assert.ok(sharingFixture, 'the real host must use the isolated sharing fixture');
    assert.equal(sharingFixture.publications.length, 0, 'opening the panel and scanning never publish');
    assert.equal(state().sharing.supported, true); assert.equal(state().sharing.url, null);
    await click('#song-requests-sharing-title');
    await click('#song-requests-publish-library'); await waitFor(() => state().sharing.count === 3 && !state().sharing.busy, 'explicit public snapshot');
    assert.equal(sharingFixture.publications.length, 1); assert.equal(state().enabled, false, 'publishing leaves reception stopped');
    await click('#song-requests-copy-library'); await waitFor(() => copiedText === sharingFixture.publicUrl, 'public link copied locally');
    await click('#song-requests-advanced-summary'); await click('#song-requests-rules-summary');
    const port = await unusedPort(); await type('#song-requests-port', port); await click('#song-requests-apply');
    await waitFor(() => state().bridge.port === port, 'saved port'); assert.equal(state().enabled, false, 'applying settings never starts reception');
    await click('#song-requests-enabled'); await waitFor(() => state().bridge.enabled, 'loopback reception');
    await type('#song-requests-tiktok-username', '@fixture_streamer'); await click('#song-requests-tiktok-connect');
    await waitFor(() => state().connections.tiktok.state === 'connected', 'mock native TikTok reception');
    connectionFixture.providers.tiktok.message('!queue');
    await waitFor(() => evaluate("!document.querySelector('#song-requests-last-response').hidden && document.querySelector('#song-requests-last-response-message').textContent.length>0"), 'native TikTok response shown locally');
    assert.equal(connectionFixture.replies.length, 0, 'receive-only TikTok never sends a chat response');
    assert.equal(state().requests.length, 0, 'queue query does not create a request');
    await evaluate("document.querySelector('#song-requests-last-response').scrollIntoView({block:'center'})"); await shot('song-requests-direct-tiktok-local-response.png');
    await click('#song-requests-tiktok-disconnect'); await waitFor(() => !state().connections.tiktok.displayName, 'native TikTok disconnected before bridge tests');
    passed.push('Song Requests direct: native TikTok command enters the same queue, gives visible local feedback and never posts to TikTok chat');
    await click('#song-requests-copy-bridge'); await waitFor(() => copiedText.startsWith('{'), 'private configuration copied to fixture'); configuration = JSON.parse(copiedText);
    assert.equal(configuration.url, `http://127.0.0.1:${port}/song-requests`); assert.match(configuration.token, /^[a-f0-9]{64}$/i);
    const send = (message, platform, viewerId, viewerName = 'Fixture viewer') => post(configuration.url, configuration.token, { platform, eventId: randomUUID(), viewerId, viewerName, message });
    const forged = await post(configuration.url, '0'.repeat(64), { platform: 'twitch', eventId: randomUUID(), viewerId: 'unauthorized', viewerName: 'Nobody', message: '!sr SR Fixture Alpha' });
    assert.ok([401, 403].includes(forged.status)); assert.equal(state().requests.length, 0);
    const browser = await post(configuration.url, configuration.token, { platform: 'twitch', eventId: randomUUID(), viewerId: 'browser', viewerName: 'Nobody', message: '!sr SR Fixture Alpha' }, { origin: 'https://untrusted.invalid' });
    assert.equal(browser.status, 403); assert.equal(state().requests.length, 0);
    assert.equal((await send('!sr SR Fixture Alpha', 'twitch', '123', '<img src=x onerror=unsafe()>')).json.ok, true);
    assert.equal((await send('!vote SR Fixture Alpha', 'youtube', 'UCfixture')).json.ok, true);
    assert.equal((await send('!vote SR Fixture Alpha', 'tiktok', '123')).json.ok, true, 'platform identity scopes prevent unrelated same-number viewers colliding');
    assert.equal((await send('!vote SR Fixture Alpha', 'tiktok', '123')).json.code, 'duplicate_vote');
    assert.equal((await send('!sr SR Fixture Beta', 'youtube', 'UCsecond')).json.ok, true);
    assert.equal((await send('!sr SR Fixture Changed', 'tiktok', '456')).json.ok, true);
    await waitFor(() => evaluate("document.querySelectorAll('.song-request-card').length===3"), 'three rendered requests');
    assert.equal(byTitle('SR Fixture Alpha').votes, 3);
    assert.equal(await evaluate("document.querySelectorAll('#song-requests-panel img,#song-requests-panel script').length"), 0);
    const queue = await send('!queue', 'twitch', 'queueviewer'); assert.equal(queue.json.command, 'queue'); assert.equal(queue.json.items[0].votes, 3);
    const missing = await send('!sr No such installed song', 'twitch', 'missingviewer'); assert.equal(missing.json.code, 'not_found'); assert.equal(state().requests.length, 3);
    const privateData = await evaluate("document.querySelector('#song-requests-panel').textContent");
    assert.equal(privateData.includes(configuration.token), false); assert.equal(privateData.includes(fixtureRoot), false);
    passed.push('Song Requests: three platforms via authenticated local POST, votes, queue, plain text and no remote downloads');

    await click(selector(byTitle('SR Fixture Beta'), 'move-up')); await waitFor(() => state().requests.filter(item => ['pending', 'accepted'].includes(item.status))[0].title === 'SR Fixture Beta', 'manual queue order');
    await click(selector(byTitle('SR Fixture Alpha'), 'accept')); await waitFor(() => byTitle('SR Fixture Alpha').status === 'accepted', 'explicit acceptance');
    await fs.rename(path.join(fixtureRoot, '2', 'notes.chart'), path.join(fixtureRoot, '2', 'notes.saved-for-test'));
    await click(selector(byTitle('SR Fixture Changed'), 'accept')); await waitFor(() => evaluate("document.querySelector('#song-requests-feedback').classList.contains('is-error')"), 'changed notes refusal');
    assert.equal(byTitle('SR Fixture Changed').status, 'pending');
    await click(selector(byTitle('SR Fixture Changed'), 'reject')); await waitFor(() => byTitle('SR Fixture Changed').status === 'rejected', 'rejection');
    await click(selector(byTitle('SR Fixture Alpha'), 'played')); await waitFor(() => byTitle('SR Fixture Alpha').status === 'played', 'mark played');
    assert.equal(byTitle('SR Fixture Beta').status, 'pending', 'unselected request remains intact');
    passed.push('Song Requests: explicit accept/reject/played/order; deleted notes refused between scan and acceptance');

    assert.equal(sharingFixture.publications.length, 1, 'queue updates and votes never republish');
    await click('#song-requests-publish-library'); await waitFor(() => state().sharing.count === 2 && !state().sharing.busy, 'manual snapshot update excludes changed files');
    assert.equal(state().sharing.unavailableCount, 1); assert.equal(sharingFixture.publications.length, 2);
    assert.deepEqual(sharingFixture.publications[1].songs.map(song => song.title).sort(), ['SR Fixture Alpha', 'SR Fixture Beta']);
    assert.doesNotMatch(JSON.stringify(sharingFixture.publications), /viewerName|requestedAt|relativePath|rootPath|fingerprint|cleanupSnapshot/);
    assert.equal(JSON.stringify(sharingFixture.publications).includes(fixtureRoot), false);
    passed.push('Song Requests: explicit public metadata snapshot, public copy, no automatic upload, changed song excluded without exposing paths or viewers');

    await click('#song-requests-copy-overlay'); await waitFor(() => copiedText.startsWith('http:'), 'overlay URL copied to fixture'); const overlay = new URL(copiedText);
    assert.equal(overlay.hostname, '127.0.0.1'); assert.notEqual(overlay.searchParams.get('token'), configuration.token, 'read-only overlay has separate capability');
    const overlayContents = await new Promise((resolve, reject) => http.get(overlay, response => { let text = ''; response.setEncoding('utf8'); response.on('data', part => { text += part; }); response.on('end', () => resolve({ code: response.statusCode, text })); }).on('error', reject));
    assert.equal(overlayContents.code, 200); assert.equal(overlayContents.text.includes(configuration.token), false);
    const denied = await post(configuration.url, overlay.searchParams.get('token'), { platform: 'twitch', eventId: randomUUID(), viewerId: 'overlay', viewerName: 'Readonly', message: '!sr SR Fixture Beta' }); assert.ok([401, 403].includes(denied.status));
    for (const language of ['fr', 'en']) {
      host.setLanguage(language); await waitFor(() => evaluate(`document.documentElement.lang===${JSON.stringify(language)} && document.querySelector('#song-requests-copy-bridge').textContent===${JSON.stringify(language === 'fr' ? 'Copier la configuration du pont' : 'Copy bridge configuration')}`), 'language ' + language);
      panel.setSize(960, 920); await evaluate("document.querySelector('#song-requests-panel').scrollIntoView({block:'start'})");
      const layout = await evaluate("(()=>{const p=document.querySelector('#song-requests-panel');return {width:p.clientWidth,scroll:p.scrollWidth,buttons:[...p.querySelectorAll('button')].filter(n=>n.getClientRects().length>0).map(n=>({label:n.getAttribute('aria-label')||n.textContent,width:n.getBoundingClientRect().width}))}})()");
      assert.ok(layout.scroll <= layout.width + 1, language + ' Song Request section overflow'); assert.ok(layout.buttons.every(button => !!button.label.trim() && button.width > 0));
      await shot('song-requests-' + language + '.png');
      assert.equal(await evaluate("document.querySelector('#song-requests-publish-library').textContent"), language === 'fr' ? 'Actualiser la liste' : 'Update song list');
      await evaluate("document.querySelector('#song-requests-sharing').scrollIntoView({block:'center'})"); await shot('song-requests-sharing-' + language + '.png');
      await evaluate("document.querySelector('#song-requests-items').scrollIntoView({block:'center'})"); await shot('song-requests-queue-' + language + '.png');
    }
    passed.push('Song Requests: OBS read capability cannot enqueue, bilingual real panel and queue captures');
    await click('#song-requests-remove-library'); await waitFor(() => state().sharing.url === null && !state().sharing.busy, 'explicit public removal');
    assert.equal(sharingFixture.removals(), 1); assert.equal(sharingFixture.publications.length, 2);
    assert.equal(await evaluate("document.querySelector('#song-requests-copy-library').disabled"), true);
    assert.equal(byTitle('SR Fixture Beta').status, 'pending', 'removing a share preserves the session queue');
    await click('#song-requests-enabled'); await waitFor(() => !state().enabled && !state().bridge.enabled, 'explicit stop');
  } finally {
    try {
      if (host.snapshot().songRequests?.enabled) await command('songRequests.configure', { enabled: false, port: state().bridge.port, rules: state().rules });
    } finally {
      clipboard.writeText = originalWriteText; host.setLanguage(initialLanguage); if (!panel.isDestroyed()) panel.setSize(...initialSize);
    }
  }
}
module.exports = { createSongRequestSharingFixture, verifySongRequests };
