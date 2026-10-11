'use strict';
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');
const { registerCompanionScheme, createCompanionHost } = require('../companion/host.cjs');
const { createPlayerFixtureRequestGuard, playerFixtureConsoleError } = require('./music-player-network-fixture.cjs');
const data = path.resolve(process.argv[2] || path.join(__dirname, '../../companion-music-player-smoke'));
app.setPath('userData', path.join(data, 'profile')); app.disableHardwareAcceleration(); registerCompanionScheme();
app.on('window-all-closed', () => {}); // The synthetic video window closes before the fixture host opens.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const passed = [], errors = [], blocked = []; let host;
app.on('web-contents-created', (_event, contents) => {
  contents.setAudioMuted(true);
  contents.on('console-message', (event, ...legacy) => { const message = playerFixtureConsoleError(event, ...legacy); if (message !== null) errors.push(message); });
});
async function waitFor(check, label) { const start = Date.now(); while (Date.now() - start < 15000) { if (await check()) return; await delay(50); } throw Error('Timed out: music player ' + label); }
function wav(frequency, seconds = 60) {
  const rate = 22050, frames = rate * seconds, buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) buffer.writeInt16LE(Math.round(Math.sin(i / rate * Math.PI * 2 * frequency) * 4000), 44 + i * 2);
  return buffer;
}
function png() {
  const crc = buffer => { let value = 0xffffffff; for (const byte of buffer) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (name, bytes) => { const type = Buffer.from(name), head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(bytes.length); tail.writeUInt32BE(crc(Buffer.concat([type, bytes]))); return Buffer.concat([head, type, bytes, tail]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 34, 211, 238, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
async function videoFixture() {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await window.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27"><title>Synthetic media fixture</title>');
    const bytes = await window.webContents.executeJavaScript(`(async()=>{
      if(!MediaRecorder.isTypeSupported('video/webm;codecs=vp8'))throw Error('Synthetic VP8 recording unavailable');
      const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;const context=canvas.getContext('2d');
      const stream=canvas.captureStream(20),recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks=[];
      recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data)};
      const finished=new Promise((resolve,reject)=>{recorder.onstop=resolve;recorder.onerror=reject});recorder.start(100);
      for(let i=0;i<30;i++){context.fillStyle='#0b1322';context.fillRect(0,0,160,90);context.fillStyle=i%2?'#22d3ee':'#a855f7';context.fillRect(i*4,20,35,50);await new Promise(resolve=>setTimeout(resolve,40))}
      recorder.stop();await finished;stream.getTracks().forEach(track=>track.stop());return [...new Uint8Array(await new Blob(chunks,{type:'video/webm'}).arrayBuffer())];
    })()`);
    assert.ok(bytes.length > 100 && bytes.length < 1024 * 1024); return Buffer.from(bytes);
  } finally { window.destroy(); }
}
const evaluate = (window, code) => window.webContents.executeJavaScript(code);
async function click(window, selector) {
  await waitFor(() => evaluate(window, `(()=>{const node=document.querySelector(${JSON.stringify(selector)});return !!node&&!node.disabled&&!node.hidden})()`), 'enabled control ' + selector);
  window.focus(); window.webContents.focus();
  const point = await evaluate(window, `(async()=>{const selector=${JSON.stringify(selector)},node=document.querySelector(selector);if(!node||node.disabled)throw Error('Unavailable control '+selector);node.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const current=document.querySelector(selector),r=current.getBoundingClientRect(),point={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)},hit=document.elementFromPoint(point.x,point.y);if(!r.width||!r.height||!hit||!(hit===current||current.contains(hit)))throw Error('Covered control '+selector);return point})()`);
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point }); window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 }); window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 }); await delay(70);
}
async function range(window, selector, value) {
  await click(window, selector); // Real native focus; keyboard operates the control.
  const key = keyCode => { window.webContents.sendInputEvent({ type: 'keyDown', keyCode }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode }); };
  key('Home'); await delay(80);
  for (let i = 0; i < value; i++) { await waitFor(() => evaluate(window, `!document.querySelector(${JSON.stringify(selector)}).disabled`), 'range available'); key('Right'); await delay(60); }
  key('Tab'); await delay(80);
}
async function type(window, selector, value) {
  await click(window, selector); const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'];
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers });
  if (value) await window.webContents.insertText(value);
  else { window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' }); }
}
async function select(window, selector, value) {
  const index = await evaluate(window, `[...document.querySelector(${JSON.stringify(selector)}).options].findIndex(option=>option.value===${JSON.stringify(value)})`); assert.ok(index >= 0);
  await click(window, selector);
  const key = keyCode => { window.webContents.sendInputEvent({ type: 'keyDown', keyCode }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode }); };
  key('Home'); for (let step = 0; step < index; step++) key('Down'); key('Return'); await delay(60);
  assert.equal(await evaluate(window, `document.querySelector(${JSON.stringify(selector)}).value`), value);
}
async function shot(window, name) { await delay(120); await fs.writeFile(path.join(data, name + '.png'), (await window.webContents.capturePage()).toPNG()); }
const command = (window, name, payload) => evaluate(window, `window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`);

app.whenReady().then(async () => {
  const deadline = setTimeout(() => { process.stderr.write('Music player fixture deadline\n'); app.exit(1); }, 150000);
  try {
    await fs.mkdir(data, { recursive: true });
    const allowRequest = createPlayerFixtureRequestGuard(path.resolve(__dirname, '../companion'));
    for (const fixtureSession of [session.defaultSession, session.fromPartition('companion-local')]) fixtureSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = allowRequest(details.url);
      if (!allowed) { const url = new URL(details.url); blocked.push(url.origin === 'null' ? url.protocol : url.origin); }
      callback({ cancel: !allowed });
    });
    const root = path.join(data, 'Songs'), webm = await videoFixture();
    for (const [index, title] of ['Alpha Fixture', 'Beta Fixture', 'Gamma Fixture'].entries()) {
      const folder = path.join(root, String(index)); await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'song.ini'), `[song]\nname = ${title}\nartist = Synthetic Artist\ncharter = Test Charter\nalbum = Synthetic Album\nyear = 2026\ngenre = ${['Post-Rock', 'Electronic', 'Jazz'][index]}\nsong_length = 60000\n`);
      await fs.writeFile(path.join(folder, 'notes.chart'), '[Song]\n{\n Resolution = 192\n}\n[SyncTrack]\n{\n 0 = B 120000\n}\n' + (index === 0 ? '[EasySingle]\n{\n 0 = N 0 0\n 192 = N 1 0\n}\n[ExpertDrums]\n{\n 0 = N 1 0\n 192 = N 2 0\n}\n' : '[ExpertSingle]\n{\n 0 = N 0 0\n 192 = N 1 0\n}\n'));
      await fs.writeFile(path.join(folder, 'song.wav'), wav(440 + index * 110));
      if (index === 0) {
        await fs.writeFile(path.join(folder, 'guitar.wav'), wav(880)); await fs.writeFile(path.join(folder, 'video.webm'), webm);
        await fs.writeFile(path.join(folder, 'album.png'), png());
      }
    }
    host = await createCompanionHost({ dataDirectory: path.join(data, 'settings'), cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({ running: false, sessions: [] }) });
    const panel = await host.open(); panel.setSize(1000, 900);
    await host.library.selectRoot(root); await waitFor(() => host.library.status().status === 'ready' && host.library.status().count === 3, 'scan');
    await waitFor(() => evaluate(panel, "document.querySelectorAll('.local-player-listen').length===3"), 'installed list');
    assert.equal(host.snapshot().player.playing, false); assert.equal(host.snapshot().player.selection, null);
    assert.equal(await evaluate(panel, "document.querySelectorAll('#local-music-player-panel audio').length"), 0);
    passed.push('Installed synthetic Songs listed without automatic playback; main panel owns no audio');

    const resultCount = count => waitFor(() => evaluate(panel, `!document.querySelector('#local-player-search').disabled&&document.querySelectorAll('.local-player-listen').length===${count}`), count + ' filtered songs');
    await click(panel, '#local-player-filters-label');
    await type(panel, '#local-player-filter-genre', 'post-rock'); await select(panel, '#local-player-filter-instrument', 'drums'); await select(panel, '#local-player-filter-difficulty', 'easy');
    await click(panel, '#local-player-search'); await resultCount(0);
    assert.equal(host.snapshot().player.selection, null, 'searching never selects a song');
    await select(panel, '#local-player-filter-difficulty', 'expert'); await click(panel, '#local-player-search'); await resultCount(1);
    assert.ok(await evaluate(panel, "document.querySelector('.local-player-song').textContent.includes('Alpha Fixture')&&document.querySelector('.local-player-song').textContent.includes('Post-Rock')"));
    await shot(panel, 'player-genre-instrument-filters');
    await type(panel, '#local-player-filter-genre', 'Jazz'); await click(panel, '#local-player-search'); await resultCount(0);
    await type(panel, '#local-player-filter-genre', ''); await select(panel, '#local-player-filter-instrument', 'all'); await select(panel, '#local-player-filter-difficulty', 'all'); await click(panel, '#local-player-search'); await resultCount(3);
    await click(panel, '#local-player-filters-label');
    passed.push('Native genre/instrument/difficulty filters match the same parsed track; changing genre excludes incompatible songs without playback');

    await click(panel, '#local-player-playlists-label'); await type(panel, '#local-player-playlist-name', 'Fixture playlist'); await click(panel, '#local-player-playlist-create');
    await waitFor(() => host.snapshot().player.playlists?.some(item => item.name === 'Fixture playlist'), 'playlist created');
    const playlist = host.snapshot().player.playlists.find(item => item.name === 'Fixture playlist');
    await waitFor(() => evaluate(panel, `document.querySelector('#local-player-playlist-select').value===${JSON.stringify(playlist.id)}`), 'created playlist selected');
    await click(panel, '.local-player-song:nth-of-type(1) .local-player-add-playlist'); await waitFor(() => host.snapshot().player.playlists.find(item => item.id === playlist.id).songIds.length === 1, 'first playlist song');
    await click(panel, '.local-player-song:nth-of-type(2) .local-player-add-playlist'); await waitFor(() => host.snapshot().player.playlists.find(item => item.id === playlist.id).songIds.length === 2, 'second playlist song');
    assert.equal(host.snapshot().player.selection, null, 'creating and filling a playlist never starts playback');
    await waitFor(() => evaluate(panel, "document.querySelector('#local-player-playlist-items').children.length===2"), 'playlist members displayed');
    await evaluate(panel, "document.querySelector('#local-player-playlists').scrollIntoView({block:'center',behavior:'instant'})");
    await shot(panel, 'player-playlists');
    passed.push('Native playlist creation and two individual additions persist opaque local IDs without autoplay');

    await evaluate(panel, "window.__musicFrames=[];window.ChartsHubCompanion.player.subscribeSpectrum(frame=>{window.__musicFrames.push(frame);if(window.__musicFrames.length>30)window.__musicFrames.shift()});void 0");
    await click(panel, '#local-player-playlist-play');
    await waitFor(() => host.snapshot().player.playing && host.snapshot().player.duration >= 59, 'actual WAV playback');
    await waitFor(() => evaluate(panel, "window.__musicFrames.some(frame=>frame.bands.some(value=>value>0))"), 'real nonzero FFT');
    const engine = host.getPlayerWidget(), contentsId = engine.webContents.id;
    assert.equal(engine.webContents.isAudioMuted(), true);
    assert.equal(host.snapshot().player.selection.title, 'Alpha Fixture'); assert.equal('mediaUrls' in host.snapshot().player.selection, false);
    await waitFor(() => evaluate(engine, "document.querySelector('#local-player-video').videoWidth===160"), 'local WebM decoded');
    assert.equal(await evaluate(engine, "document.querySelector('#local-player-video').muted"), true);
    assert.equal(host.snapshot().player.activePlaylistId, playlist.id); assert.equal(host.snapshot().player.queueLength, 2);
    await click(panel, '#local-player-shuffle'); await waitFor(() => host.snapshot().player.shuffle === true, 'shuffle enabled');
    await click(panel, '#local-player-playlists-label');
    passed.push('One isolated audio owner mixes real PCM, emits measured FFT, decodes local muted WebM; no audible CI output');

    await click(panel, '#local-player-pause'); await waitFor(() => !host.snapshot().player.playing, 'pause');
    await waitFor(() => evaluate(panel, "window.__musicFrames.at(-1).bands.every(value=>value===0)"), 'paused FFT cleared');
    await range(panel, '#local-player-seek', 40); await waitFor(() => host.snapshot().player.currentTime >= 3.5 && host.snapshot().player.currentTime <= 4.5, 'native seek');
    await range(panel, '#local-player-volume', 25); await waitFor(() => Math.abs(host.snapshot().player.volume - .25) < .02, 'native volume');
    await click(panel, '#local-player-play'); await waitFor(() => host.snapshot().player.playing, 'resume');
    await click(panel, '#local-player-widget'); await waitFor(() => engine.isVisible(), 'floating window'); assert.equal(host.getPlayerWidget().webContents.id, contentsId);
    assert.equal(await evaluate(engine, "document.querySelector('#local-player-title').textContent"), 'Alpha Fixture');
    await click(engine, '#local-player-video-enabled'); await waitFor(() => !host.snapshot().player.videoEnabled, 'video off shared');
    for (const window of [engine, panel]) assert.equal(await evaluate(window, "document.querySelector('#local-player-video').hasAttribute('src')"), false);
    await waitFor(() => evaluate(engine, "!document.querySelector('#local-player-artwork').hidden && document.querySelector('#local-player-artwork').naturalWidth>0"), 'album fallback');
    await shot(engine, 'player-widget-album');
    await click(engine, '#local-player-next'); await waitFor(() => host.snapshot().player.selection?.title === 'Beta Fixture' && host.snapshot().player.playing, 'next song');
    await click(panel, '#local-player-previous'); await waitFor(() => host.snapshot().player.selection?.title === 'Alpha Fixture' && host.snapshot().player.playing, 'previous song');
    passed.push('Native pause, seek, volume, next/previous and shared video switch work across both surfaces; artwork replaces video');

    for (const model of ['bars', 'curve', 'circle', 'mirror']) {
      const appearance = { backgroundColor: '#111827', textColor: '#f9fafb', accentColor: '#22d3ee', secondaryColor: '#a855f7', spectrumModel: model };
      assert.equal((await command(panel, 'player.appearance', { appearance })).ok, true);
      await waitFor(() => evaluate(engine, `document.querySelector('#local-player-spectrum-model').value===${JSON.stringify(model)}`), model + ' synced');
      await waitFor(() => evaluate(engine, "[...document.querySelector('#local-player-spectrum').getContext('2d').getImageData(0,0,640,80).data].some((v,i)=>i%4===3&&v>0)"), model + ' visible real spectrum');
      await shot(engine, 'player-spectrum-' + model);
    }
    for (const language of ['fr', 'en']) {
      host.setLanguage(language); engine.setSize(280, 200);
      await waitFor(() => evaluate(engine, `document.documentElement.lang===${JSON.stringify(language)}`), language + ' widget');
      assert.deepEqual(engine.getMinimumSize(), [280, 200]);
      const dimensions = await evaluate(engine, "({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,root:document.querySelector('#local-music-player-panel').scrollWidth})");
      assert.ok(dimensions.scroll <= dimensions.width + 1 && dimensions.root <= dimensions.width + 1, language + ' narrow widget overflow');
      await shot(engine, 'player-widget-small-' + language);
    }
    engine.setSize(400, 620);
    const before = host.snapshot().player.currentTime; await click(engine, '#local-player-widget'); await waitFor(() => !engine.isVisible(), 'close hides');
    await waitFor(() => host.snapshot().player.currentTime > before + .5, 'hidden owner keeps playback');
    assert.equal(host.getPlayerWidget().webContents.id, contentsId, 'hide/reopen preserves the unique engine');
    passed.push('All four FFT styles share preferences; 280×200 FR/EN has no horizontal overflow; hiding widget preserves playback');

    assert.equal((await command(panel, 'player.control', { action: 'seek', value: 59.5 })).ok, true);
    await waitFor(() => host.snapshot().player.selection?.title === 'Beta Fixture' && host.snapshot().player.playing, 'real master end advances playlist');
    assert.equal(host.snapshot().player.queuePosition, 2);
    assert.equal((await command(panel, 'player.control', { action: 'seek', value: 59.5 })).ok, true);
    await waitFor(() => !host.snapshot().player.playing && host.snapshot().player.selection?.title === 'Beta Fixture', 'playlist exhaustion stops without repeating');
    passed.push('Real PCM master completion advances to the remaining playlist song once; exhausted queue stops');

    await evaluate(panel, "document.querySelector('#local-music-player-panel').scrollIntoView({block:'start',behavior:'instant'})"); await shot(panel, 'player-main');
    const other = path.join(data, 'OtherSongs'); await fs.mkdir(other, { recursive: true }); await host.library.selectRoot(other);
    await waitFor(() => !host.snapshot().player.selection && !host.snapshot().player.playing, 'library replacement stops old audio');
    await waitFor(() => evaluate(engine, "document.querySelector('#local-player-title').textContent==='Choose a song'"), 'old metadata cleared');
    assert.equal(await evaluate(panel, "document.querySelector('#local-music-player-panel').textContent.includes(" + JSON.stringify(root) + ")"), false);
    assert.equal(blocked.length, 0, 'no external requests'); assert.deepEqual(errors, [], 'no renderer or CSP errors');
    passed.push('Replacing Songs revokes playback and metadata; no paths exposed, no external network or renderer errors');
    await host.library.selectRoot(root); await waitFor(() => host.library.status().status === 'ready', 'original Songs restored for restart check');
    await host.dispose();
    host = await createCompanionHost({ dataDirectory: path.join(data, 'settings'), cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({ running: false, sessions: [] }) });
    await host.open(); await waitFor(() => host.snapshot().player.playlists?.some(item => item.id === playlist.id && item.songIds.length === 2), 'playlist preferences reloaded');
    assert.equal(host.snapshot().player.shuffle, true); assert.equal(host.snapshot().player.playing, false); assert.equal(host.snapshot().player.selection, null);
    passed.push('Playlist membership and shuffle survive host restart while playback stays stopped');
    await fs.writeFile(path.join(data, 'report.json'), JSON.stringify({ ok: true, passed, rendererErrors: errors, blockedOrigins: blocked }, null, 2));
    await host.dispose(); clearTimeout(deadline); app.quit();
  } catch (error) {
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(path.join(data, 'report.json'), JSON.stringify({ ok: false, passed, error: String(error.stack || error), rendererErrors: errors, blockedOrigins: blocked }, null, 2));
    try { const window = host?.getPlayerWidget() || host?.getPanel(); if (window && !window.isDestroyed()) await shot(window, 'failure'); } catch {}
    try { await host?.dispose(); } catch {} clearTimeout(deadline); console.error(error); app.exit(1);
  }
});
