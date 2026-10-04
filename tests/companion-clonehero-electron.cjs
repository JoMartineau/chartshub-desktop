'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { WebSocket } = require('ws');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function defaultWaitFor(check, label) {
  const started = Date.now();
  while (Date.now() - started < 15000) { if (await check()) return; await delay(50); }
  throw Error('Timed out: ' + label);
}
async function freePort() {
  const server = http.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(Error('Verification port unavailable')); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}
const rendered = root => `(()=>[...document.querySelectorAll(${JSON.stringify(root + ' .companion-widget')})].map(node=>({id:node.dataset.widgetId,text:node.textContent})).sort((a,b)=>a.id.localeCompare(b.id)))()`;

/** Run only inside the isolated native harness, constructed with cloneHeroCandidates: []. */
async function verifyCloneHero({ host, panel, data, passed, waitFor = defaultWaitFor }) {
  const initial = structuredClone(host.snapshot());
  assert.equal(initial.cloneHero.mode, 'mock', 'native verification must start with mock and no real Clone Hero candidates');
  const directory = path.join(data, 'clonehero-source-fixture-' + randomUUID());
  const filePath = path.join(directory, 'currentsong.txt');
  const settingsPath = path.join(directory, 'settings.ini');
  const settings = '[streamer]\nsong_export = 1\ncustom_song_export = %s%n%a%n%c\n';
  const evaluate = code => panel.webContents.executeJavaScript(code);
  const revision = () => host.snapshot().editor.revision;
  const command = async (name, payload) => {
    const result = await evaluate(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`);
    assert.ok(result?.ok, 'Clone Hero verification command failed: ' + name);
  };
  const nativeWidgets = () => host.getOverlay().webContents.executeJavaScript(rendered('#game-overlay'));
  const empty = async () => host.snapshot().state.nowPlaying === null &&
    (await evaluate(rendered('#game-preview'))).length === 0 && (await nativeWidgets()).length === 0;
  let socket = null, latest = null, primaryFailure = null;
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(settingsPath, settings);
    await fs.writeFile(filePath, 'Stale exported song\nPrevious artist\nPrevious charter\n');
    await waitFor(() => evaluate("!!document.querySelector('#clonehero-mode')"), 'Clone Hero source controls loaded');
    await evaluate("(()=>{const toggle=document.querySelector('#builder-toggle');if(toggle?.getAttribute('aria-pressed')==='true')toggle.click();document.querySelector('#preview-game-tab')?.click();})()");
    for (const widget of initial.state.widgets.instances) {
      if (!widget.enabled) await command('widget.enabled', { id: widget.id, enabled: true });
      await command('widget.visibility', { revision: revision(), id: widget.id, game: true, stream: true, gameplayVisibility: ['playing', 'paused'] });
    }
    await host.setOverlay(true);
    await host.integration.selectFile(filePath);
    await host.integration.setMode('live');
    await waitFor(() => host.snapshot().cloneHero.mode === 'live' && host.snapshot().cloneHero.status === 'waiting', 'live source waits for a fresh export');
    // Longer than two 500 ms polls: a pre-existing export must never become live by itself.
    await delay(1250);
    assert.equal(await empty(), true, 'an old nonempty export must remain hidden');
    assert.equal(host.getOverlay().isVisible(), false);
    await waitFor(() => evaluate("document.querySelector('#clonehero-mode').value==='live'&&document.querySelector('#simulation-panel').hidden"), 'live controls replace mock simulation controls');
    assert.deepEqual(host.snapshot().cloneHero.capabilities, { title: true, artist: true, charter: true, instrument: false, difficulty: false, exactGameplay: false });
    passed.push('Clone Hero live mode ignores a stale export until fresh stable contents arrive; mock controls are hidden and unsupported capabilities are explicit');

    const song = { title: 'Native live fixture title', artist: 'Native live fixture artist', charter: 'Native live fixture charter' };
    await fs.writeFile(path.join(directory, 'songs.json'), JSON.stringify([{ Name: song.title, Artist: song.artist, Charter: '<color=#ff0000>Native live </color><color=#0088ff>fixture charter</color>' }]));
    await fs.writeFile(filePath, '\ufeff' + song.title + '\r\n' + song.artist + '\r\n' + song.charter + '\r\n');
    await waitFor(() => host.snapshot().cloneHero.status === 'active' && host.snapshot().state.nowPlaying?.title === song.title, 'two stable polls accept the fresh Clone Hero export');
    const expected = [
      { id: 'song-artist', text: song.artist }, { id: 'song-charter', text: song.charter }, { id: 'song-title', text: song.title }
    ];
    await waitFor(async () => JSON.stringify(await nativeWidgets()) === JSON.stringify(expected) && JSON.stringify(await evaluate(rendered('#game-preview'))) === JSON.stringify(expected), 'three live widgets match in preview and native overlay');
    assert.equal(host.getOverlay().isVisible(), true);
    assert.equal(host.snapshot().state.nowPlaying.instrument, undefined);
    assert.equal(host.snapshot().state.nowPlaying.difficulty, undefined);
    const colored = `(()=>[...document.querySelectorAll('.companion-widget[data-widget-type="song.charter"] .companion-widget-segment')].map(node=>({text:node.textContent,color:getComputedStyle(node).color})))()`;
    const expectedColors = [{ text: 'Native live ', color: 'rgb(255, 0, 0)' }, { text: 'fixture charter', color: 'rgb(0, 136, 255)' }];
    await waitFor(async () => JSON.stringify(await host.getOverlay().webContents.executeJavaScript(colored)) === JSON.stringify(expectedColors), 'original charter colors render as safe text spans in the native overlay');
    const oldFontSize = host.snapshot().state.widgets.instances.find(widget => widget.id === 'song-charter').style.fontSize ?? 20;
    await evaluate(`(()=>{const input=document.querySelector('[data-widget-font-size="song-charter"]');input.value='80';input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(() => host.snapshot().state.widgets.instances.find(widget => widget.id === 'song-charter').style.fontSize === 80, 'charter font size can be changed from the widget list');
    await waitFor(async () => await host.getOverlay().webContents.executeJavaScript(`getComputedStyle(document.querySelector('.companion-widget[data-widget-type="song.charter"]')).fontSize`) === '80px', 'native charter text grows without losing source colors');
    assert.deepEqual(await host.getOverlay().webContents.executeJavaScript(colored), expectedColors);
    await waitFor(() => evaluate(`!document.querySelector('[data-widget-font-decrease="song-charter"]').disabled`), 'font controls are ready after save');
    await evaluate(`document.querySelector('[data-widget-font-decrease="song-charter"]').click()`);
    await waitFor(() => host.snapshot().state.widgets.instances.find(widget => widget.id === 'song-charter').style.fontSize === 78, 'minus button shrinks charter text');
    await command('widget.fontSize', { revision: revision(), id: 'song-charter', fontSize: oldFontSize });
    passed.push('widget font controls enlarge and shrink native charter text while preserving the original colored segments');
    await waitFor(() => evaluate(`document.querySelector('#clonehero-file-path').textContent.includes(${JSON.stringify('currentsong.txt')})&&document.querySelector('#clonehero-status').textContent.length>0`), 'selected file and live status are visible in source controls');
    await evaluate("document.querySelector('#clonehero-mode').scrollIntoView({block:'center',inline:'nearest'})");
    await delay(180);
    await fs.writeFile(path.join(data, 'companion-clonehero-live.png'), (await panel.webContents.capturePage()).toPNG());
    await fs.writeFile(path.join(data, 'companion-clonehero-overlay.png'), (await host.getOverlay().webContents.capturePage()).toPNG());
    passed.push('a real file update with UTF-8 BOM and CRLF renders title, artist and charter; instrument and difficulty stay absent from both live surfaces');
    passed.push('plain Clone Hero export recovers generic per-segment charter colors from the matching local songs.json entry');

    await host.setStream(false);
    await command('stream.settings', { revision: revision(), settings: { ...host.snapshot().state.stream, port: await freePort() } });
    await host.setStream(true);
    await waitFor(() => host.snapshot().stream.enabled, 'isolated OBS server enabled');
    const address = new URL(host.snapshot().stream.url), events = new URL(address.href);
    events.protocol = 'ws:'; events.pathname = '/events';
    socket = new WebSocket(events.href, { origin: address.origin });
    socket.on('error', () => {});
    socket.on('message', bytes => {
      try { const value = JSON.parse(bytes.toString()); if (value.type === 'snapshot') latest = value; } catch {}
    });
    await waitFor(() => latest?.state.nowPlaying?.title === song.title, 'OBS socket receives live song metadata');
    assert.deepEqual(latest.state.nowPlaying, { ...song, charterSegments: [{ text: 'Native live ', color: '#ff0000' }, { text: 'fixture charter', color: '#0088ff' }] });
    assert.equal(Object.hasOwn(latest.state, 'cloneHero'), false);
    assert.equal(JSON.stringify(latest).includes(path.basename(directory)), false, 'OBS must never receive the local integration path');
    assert.equal(JSON.stringify(latest).includes('currentsong.txt'), false);
    assert.equal(JSON.stringify(latest).includes('settings.ini'), false);
    passed.push('the actual OBS WebSocket receives only public live metadata and never receives the selected file or integration settings path');

    await fs.writeFile(filePath, '');
    await waitFor(async () => await empty() && !host.getOverlay().isVisible() && latest?.state.nowPlaying === null, 'clearing the export clears every live surface');
    assert.equal(host.snapshot().state.gameplay.isChartActive, false);
    assert.equal(await fs.readFile(settingsPath, 'utf8'), settings, 'the adapter must never change game settings');
    assert.equal(await fs.readFile(filePath, 'utf8'), '', 'the adapter must never write the exported song');
    passed.push('an empty export atomically clears preview, native overlay and OBS without retained song metadata or game-file writes');

    await host.integration.setMode('mock');
    host.integration.transition('playing');
    await waitFor(() => host.snapshot().cloneHero.mode === 'mock' && host.snapshot().state.nowPlaying?.instrument && host.snapshot().state.nowPlaying?.difficulty, 'return to the separate simulation source');
    await waitFor(async () => (await nativeWidgets()).length === 5 && (await evaluate(rendered('#game-preview'))).length === 5, 'five mock widgets restored');
    await waitFor(() => evaluate("document.querySelector('#clonehero-mode').value==='mock'&&!document.querySelector('#simulation-panel').hidden"), 'simulation controls restored');
    passed.push('switching back to mock restores all five simulated widgets and controls without reusing the live export');
  } catch (error) { primaryFailure = error; throw error; }
  finally {
    const failures = [];
    if (socket) socket.terminate();
    try { await host.setStream(false); } catch { failures.push('stop verification stream'); }
    try { await host.integration.setMode('mock'); } catch { failures.push('restore mock source'); }
    if (!panel.isDestroyed()) {
      try {
        for (const original of initial.state.widgets.instances) {
          const current = host.snapshot().state.widgets.instances.find(widget => widget.id === original.id);
          if (current?.enabled !== original.enabled) await command('widget.enabled', { id: original.id, enabled: original.enabled });
          await command('widget.visibility', { revision: revision(), id: original.id, game: original.visibility.game, stream: original.visibility.stream, gameplayVisibility: original.gameplayVisibility ?? ['playing', 'paused'] });
        }
        await command('stream.settings', { revision: revision(), settings: initial.state.stream });
        host.integration.transition(initial.state.gameplay.state);
        await host.setOverlay(initial.overlayEnabled);
        if (initial.stream.enabled) await host.setStream(true);
        await host.saveSettings();
      } catch { failures.push('restore original widget and stream settings'); }
    }
    if (failures.length && !primaryFailure) throw Error('Clone Hero verification cleanup failed: ' + failures.join(', '));
  }
}

module.exports = { verifyCloneHero };
