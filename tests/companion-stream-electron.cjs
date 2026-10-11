'use strict';
const { BrowserWindow, desktopCapturer } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, label, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return;
    await delay(40);
  }
  throw Error('Timed out: ' + label);
}

/** Reserve an OS-selected loopback port briefly rather than assuming the default is free. */
async function freePort() {
  const server = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(Error('Cannot allocate a verification port.')));
        return;
      }
      server.close(error => error ? reject(Error('Cannot release the verification port.')) : resolve(address.port));
    });
  });
}

const geometry = widgets => widgets.map(widget => ({ id: widget.id, position: { ...widget.position }, size: { ...widget.size } }));

function renderedWidgets(root) {
  return `(()=>[...document.querySelectorAll(${JSON.stringify(root + ' .companion-widget')})].map(node=>{
    const outer=getComputedStyle(node),inner=getComputedStyle(node.querySelector('.companion-widget-text'));
    return {id:node.dataset.widgetId,text:node.textContent,left:outer.left,top:outer.top,width:outer.width,height:outer.height,
      color:outer.color,background:outer.backgroundColor,border:outer.boxShadow,fontSize:outer.fontSize,fontWeight:outer.fontWeight,
      textColor:inner.color,gradient:inner.backgroundImage,textShadow:inner.textShadow,filter:inner.filter,textFill:inner.webkitTextFillColor};
  }))()`;
}

/** Run from the native verification app; no OBS installation or Electron bridge is used by the browser page. */
async function verifyStream(panel, host, data, passed) {
  const initial = structuredClone(host.snapshot());
  const originalGameGeometry = geometry(initial.state.widgets.instances);
  const evaluate = code => panel.webContents.executeJavaScript(code);
  const revision = () => host.snapshot().editor.revision;
  const settings = () => structuredClone(host.snapshot().state.stream);
  const streamTitle = () => structuredClone(host.snapshot().state.stream.layout.find(item => item.id === 'song-title'));
  const count = root => evaluate(`document.querySelectorAll(${JSON.stringify(root + ' .companion-widget')}).length`);
  const command = async (name, payload) => {
    const result = await evaluate(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`);
    assert.ok(result?.ok, 'Stream verification command failed: ' + name);
  };
  const click = async selector => {
    await waitFor(() => evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});return !!node&&!node.disabled})()`), 'stream control enabled: ' + selector);
    const point = await evaluate(`(()=>{
      const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'center',inline:'nearest'});
      const rect=node.getBoundingClientRect(),point={x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};
      const hit=document.elementFromPoint(point.x,point.y);
      if(!rect.width||!rect.height||!hit||!(hit===node||node.contains(hit)))throw Error('Stream interaction target is hidden or covered.');
      return point;
    })()`);
    panel.focus(); panel.webContents.focus();
    panel.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    panel.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    panel.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await delay(40);
  };
  const key = async (keyCode, modifiers = []) => {
    panel.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    panel.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await delay(40);
  };
  const number = async (selector, value) => {
    await click(selector);
    await key('A', [process.platform === 'darwin' ? 'meta' : 'control']);
    await panel.webContents.insertText(String(value));
    await key('Tab');
  };
  let browser = null;
  let primaryFailure = null;
  let pageLoads = 0;
  const browserEvaluate = code => browser.webContents.executeJavaScript(code);
  const browserCount = () => browserEvaluate("document.querySelectorAll('#stream-overlay .companion-widget').length");
  const sameRender = async label => {
    await waitFor(async () => {
      const preview = await evaluate(renderedWidgets('#stream-preview'));
      const source = await browserEvaluate(renderedWidgets('#stream-overlay'));
      return preview.length === 5 && source.length === 5 && JSON.stringify(preview) === JSON.stringify(source);
    }, label);
  };

  try {
    assert.equal(initial.stream.enabled, false, 'the server starts only after an explicit action');
    assert.equal(initial.stream.clients, 0);
    assert.equal(initial.stream.url, null);
    panel.setSize(1250, 900);
    const captureWindows = [];
    const windowsCaptureCI = process.platform === 'win32' && process.env.CI === 'true';
    if (windowsCaptureCI) {
      for (const name of ['catalogue', 'filters']) assert.equal(initial.captureWindows?.[name]?.canOpen, true, 'Windows CI must exercise the actual ' + name + ' window');
    }
    for (const name of ['catalogue', 'filters']) {
      const info = initial.captureWindows?.[name];
      assert.equal(await evaluate(`document.querySelector('#stream-open-${name}').disabled`), info?.canOpen !== true, 'OBS button follows host readiness: ' + name);
      if (!info?.canOpen) continue;
      await click('#stream-open-' + name);
      const native = () => name === 'catalogue' ? host.getCatalogueWidget() : host.getFiltersWidget();
      await waitFor(() => native()?.isVisible(), 'OBS action opens native ' + name);
      const window = native(); assert.equal(window.getTitle(), info.title);
      assert.equal(await evaluate(`document.querySelector('#stream-${name}-window-title').textContent`), info.title);
      captureWindows.push({ name, window, title: info.title });
      await fs.writeFile(path.join(data, 'obs-window-' + name + '.png'), (await window.webContents.capturePage()).toPNG());
    }
    if (windowsCaptureCI) {
      assert.deepEqual(captureWindows.map(item => item.name).sort(), ['catalogue', 'filters'], 'both native fixture windows were opened and captured');
      assert.equal(new Set(captureWindows.map(item => item.window.getMediaSourceId())).size, 2, 'the captures belong to two distinct native windows');
      // Enumerate eligible windows with zero-size thumbnails. Only our fixture
      // window IDs/titles are inspected; no other titles or pixels are recorded.
      await waitFor(async () => {
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
        return captureWindows.every(({ window, title }) => sources.some(source => source.id === window.getMediaSourceId() && source.name === title));
      }, 'Windows capture enumeration contains only the expected matches for fixture catalogue/filters', 15000);
      passed.push('Windows native capture enumeration recognizes the exact fixture Catalogue/Filters titles; actual OBS capture remains a manual integration check');
    }
    await host.setCatalogueWidget(Boolean(initial.catalogueWidgetEnabled));
    await host.setFiltersWidget(Boolean(initial.filtersWidgetEnabled));
    for (const language of ['fr', 'en']) {
      host.setLanguage(language);
      const expected = language === 'fr' ? 'Ouvrir le Catalogue' : 'Open Catalogue';
      await waitFor(() => evaluate(`document.querySelector('#stream-open-catalogue').textContent===${JSON.stringify(expected)}`), 'OBS capture instructions ' + language);
      if (captureWindows.length) {
        const feedback = language === 'fr' ? 'Fenêtre ouverte. Sélectionnez son titre dans OBS.' : 'Window opened. Select its title in OBS.';
        await waitFor(() => evaluate(`document.querySelector('#stream-feedback').textContent===${JSON.stringify(feedback)}`), 'existing OBS opening confirmation follows language ' + language);
      }
      await evaluate("document.querySelector('.stream-native-windows').scrollIntoView({block:'center',inline:'nearest'})");
      await fs.writeFile(path.join(data, 'obs-window-instructions-' + language + '.png'), (await panel.webContents.capturePage()).toPNG());
    }
    host.setLanguage(initial.language);
    assert.equal(host.snapshot().stream.enabled, false); assert.equal(host.snapshot().stream.url, null);
    for (const key of ['widgets', 'theme', 'stream']) assert.deepEqual(host.snapshot().state[key], initial.state[key], 'opening capture windows does not change ' + key);
    passed.push('OBS buttons open only existing permitted native windows with exact titles and bilingual guidance, without starting the browser server');
    await command('mock.state', { state: 'menu' });
    if (await evaluate("document.querySelector('#builder-toggle').getAttribute('aria-pressed')==='true'")) await click('#builder-toggle');
    await click('#preview-stream-tab');
    await waitFor(() => evaluate("document.querySelector('#preview-stream-tab').getAttribute('aria-selected')==='true'"), 'stream preview tab');
    await waitFor(async () => (await count('#stream-preview')) === 0, 'initial stream preview is empty in menu');
    assert.equal(host.snapshot().state.nowPlaying, null);
    assert.equal(await evaluate("document.querySelector('#stream-enabled').checked"), false);
    passed.push('stream starts off with no URL or clients; menu preview has no song or sample metadata');

    const port = await freePort();
    assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
    await command('stream.settings', { revision: revision(), settings: { ...settings(), port } });
    for (const widget of host.snapshot().state.widgets.instances) {
      if (!widget.enabled) await command('widget.enabled', { id: widget.id, enabled: true });
      await command('widget.visibility', { revision: revision(), id: widget.id, game: false, stream: true, gameplayVisibility: ['playing', 'paused'] });
    }
    await host.setOverlay(true);
    await click('#stream-enabled');
    await waitFor(() => host.snapshot().stream.enabled, 'stream server starts from its checkbox');
    const url = host.snapshot().stream.url;
    const address = new URL(url);
    assert.ok(address.protocol === 'http:' && address.hostname === '127.0.0.1' && Number(address.port) === port, 'the source uses the selected loopback port');
    // The token is intentionally never included in assertions or diagnostic messages.
    browser = new BrowserWindow({
      width: 960, height: 540, useContentSize: true, show: false,
      transparent: true, backgroundColor: '#00000000', title: 'ChartsHub — Stream verification',
      webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, backgroundThrottling: false,
        partition: 'companion-stream-verification-' + randomUUID(),
      },
    });
    browser.setMenuBarVisibility(false);
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    browser.webContents.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    browser.webContents.session.setPermissionCheckHandler(() => false);
    browser.webContents.on('will-attach-webview', event => event.preventDefault());
    browser.webContents.on('will-navigate', (event, next) => { if (next !== url) event.preventDefault(); });
    browser.webContents.on('did-finish-load', () => { ++pageLoads; });
    try { await browser.loadURL(url); } catch { throw Error('The local stream browser page could not load.'); }
    browser.showInactive();
    await waitFor(() => host.snapshot().stream.clients === 1, 'one real WebSocket browser client');
    await waitFor(async () => (await browserCount()) === 0, 'HTTP browser is empty while gameplay is menu');
    assert.deepEqual(await browserEvaluate(`({require:typeof window.require,process:typeof window.process,companion:typeof window.ChartsHubCompanion,catalogue:typeof window.ChartsHubDesktop})`), {
      require: 'undefined', process: 'undefined', companion: 'undefined', catalogue: 'undefined',
    });
    const backgrounds = await browserEvaluate("[document.documentElement,document.body,document.querySelector('#stream-overlay')].map(node=>getComputedStyle(node).backgroundColor)");
    assert.deepEqual(backgrounds, ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
    assert.equal(pageLoads, 1);
    passed.push('HTTP browser source connects through real WebSocket, stays transparent and has no Node or Electron bridge');

    await command('mock.state', { state: 'playing' });
    await sameRender('five stream widgets match the panel preview and browser source');
    const texts = await browserEvaluate("[...document.querySelectorAll('#stream-overlay .companion-widget')].map(node=>node.textContent)");
    assert.deepEqual(texts, ['Everlong', 'Foo Fighters', 'ExampleCharter', 'Guitar', 'Expert']);
    await waitFor(() => !host.getOverlay().isVisible(), 'game overlay remains hidden for stream-only widgets');
    assert.equal(await host.getOverlay().webContents.executeJavaScript("document.querySelectorAll('.companion-widget').length"), 0);
    assert.deepEqual(geometry(host.snapshot().state.widgets.instances), originalGameGeometry);
    passed.push('all five stream-only widgets render identically in preview and browser while the native game overlay remains hidden');

    await click('#builder-toggle');
    await waitFor(() => evaluate("document.querySelector('#builder-toggle').getAttribute('aria-pressed')==='true'"), 'stream builder enabled');
    await click('#builder-list [data-select-widget-id="song-title"]');
    const before = streamTitle();
    const newX = before.x === 0 ? Math.min(32, 1280 - before.width) : 0;
    assert.notEqual(newX, before.x, 'title has room for a meaningful stream position edit');
    const beforeRevision = revision();
    await number('#builder-x', newX);
    await waitFor(() => streamTitle().x === newX && revision() === beforeRevision + 1, 'native stream inspector commits one layout edit');
    const edited = streamTitle();
    assert.deepEqual(geometry(host.snapshot().state.widgets.instances), originalGameGeometry);
    await click('#builder-undo');
    await waitFor(() => JSON.stringify(streamTitle()) === JSON.stringify(before), 'stream layout undo');
    await click('#builder-redo');
    await waitFor(() => JSON.stringify(streamTitle()) === JSON.stringify(edited), 'stream layout redo');
    await click('#builder-toggle');
    await sameRender('stream layout edits propagate to the browser without changing game geometry');
    assert.deepEqual(geometry(host.snapshot().state.widgets.instances), originalGameGeometry);
    passed.push('native stream inspector edits only stream geometry; undo and redo restore exact positions through shared history');

    const configured = { ...settings(), canvas: { width: 1920, height: 1080, fps: 30 } };
    await command('stream.settings', { revision: revision(), settings: configured });
    await waitFor(() => evaluate("document.querySelector('#stream-resolution').value==='1080p'&&document.querySelector('#stream-fps').value==='30'"), 'stream resolution and FPS controls reflect current settings');
    await host.saveSettings();
    const saved = JSON.parse(await fs.readFile(path.join(data, 'settings/settings.json'), 'utf8'));
    assert.equal(saved.version, 3);
    assert.deepEqual(saved.stream, configured);
    assert.deepEqual(geometry(saved.widgets), originalGameGeometry);
    await sameRender('resolution settings retain the same logical composition');
    await evaluate("document.querySelector('#stream-preview').scrollIntoView({block:'center',inline:'nearest'})");
    await delay(150);
    await fs.writeFile(path.join(data, 'stream-panel.png'), (await panel.webContents.capturePage()).toPNG());
    await fs.writeFile(path.join(data, 'stream-browser.png'), (await browser.webContents.capturePage()).toPNG());
    passed.push('1920x1080 at 30 FPS and independent stream layout persist in v3 settings without changing game placements');

    await command('mock.state', { state: 'menu' });
    await waitFor(async () => (await browserCount()) === 0 && (await count('#stream-preview')) === 0, 'menu clears both stream surfaces');
    assert.equal(host.snapshot().state.nowPlaying, null);
    passed.push('returning to menu clears browser and stream-preview DOM with no retained song');

    await command('mock.state', { state: 'playing' });
    await waitFor(async () => (await browserCount()) === 5, 'browser repopulates before stop');
    const marker = randomUUID();
    await browserEvaluate(`window.__streamVerificationMarker=${JSON.stringify(marker)}`);
    await click('#stream-enabled');
    await waitFor(() => !host.snapshot().stream.enabled && host.snapshot().stream.clients === 0, 'stream stops and disconnects all clients');
    await waitFor(async () => (await browserCount()) === 0, 'socket close clears browser DOM');
    passed.push('stopping the stream server disconnects clients and clears a previously populated browser source');

    await click('#stream-enabled');
    await waitFor(() => host.snapshot().stream.enabled, 'stream server restarts');
    assert.ok(host.snapshot().stream.url === url, 'restart retains the same source URL');
    await waitFor(async () => host.snapshot().stream.clients === 1 && (await browserCount()) === 5, 'existing browser reconnects through a new real WebSocket', 20000);
    assert.ok(browser.webContents.getURL() === url, 'source navigation remains unchanged');
    assert.equal(pageLoads, 1, 'reconnection does not reload the page');
    assert.equal(await browserEvaluate('window.__streamVerificationMarker'), marker);
    await sameRender('reconnected browser still matches stream preview');
    passed.push('restart preserves the source URL and the existing page reconnects automatically without navigation or an Electron bridge');
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const failures = [];
    try { await host.setStream(false); } catch { failures.push('stop stream'); }
    try {
      await host.setCatalogueWidget(Boolean(initial.catalogueWidgetEnabled));
      await host.setFiltersWidget(Boolean(initial.filtersWidgetEnabled));
      host.setLanguage(initial.language);
    } catch { failures.push('restore native capture windows'); }
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (!panel.isDestroyed()) {
      try {
        await command('mock.state', { state: 'menu' });
        for (const original of initial.state.widgets.instances) {
          const current = host.snapshot().state.widgets.instances.find(widget => widget.id === original.id);
          if (!current) continue;
          if (current.enabled !== original.enabled) await command('widget.enabled', { id: original.id, enabled: original.enabled });
          await command('widget.visibility', { revision: revision(), id: original.id, game: original.visibility.game, stream: original.visibility.stream, gameplayVisibility: original.gameplayVisibility ?? ['playing', 'paused'] });
        }
        await command('stream.settings', { revision: revision(), settings: initial.state.stream });
        await command('mock.state', { state: initial.state.gameplay.state });
        await host.setOverlay(initial.overlayEnabled);
        await evaluate("(()=>{const toggle=document.querySelector('#builder-toggle');if(toggle?.getAttribute('aria-pressed')==='true')toggle.click();document.querySelector('#preview-game-tab')?.click();})()");
        await host.saveSettings();
      } catch { failures.push('restore original settings'); }
    }
    // Clipboard contents are never read or overwritten by this verification.
    if (failures.length && !primaryFailure) throw Error('Stream verification cleanup failed: ' + failures.join(', '));
  }
}

module.exports = { verifyStream };
