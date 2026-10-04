'use strict';
const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { registerCompanionScheme, createCompanionHost } = require('../companion/host.cjs');
const { verifyStream } = require('./companion-stream-electron.cjs');
const { verifyLibrary } = require('./companion-library-electron.cjs');
const { createCatalogueFixture, verifyCatalogue } = require('./companion-catalogue-electron.cjs');
const catalogueFixture = createCatalogueFixture();
const { createDownloadFixture, verifyDownloads } = require('./companion-downloads-electron.cjs');
const { verifyCloneHero } = require('./companion-clonehero-electron.cjs');
const { verifyProfiles } = require('./companion-profiles-electron.cjs');
const downloadFixture = createDownloadFixture();
const data = path.resolve(process.argv[2] || path.join(__dirname, '../../companion-smoke'));
app.setPath('userData', path.join(data, 'profile'));
app.disableHardwareAcceleration();
registerCompanionScheme();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const passed = [];
let host;
async function waitFor(check, label) {
  const start = Date.now();
  while (Date.now() - start < 6000) { if (await check()) return; await delay(40); }
  throw Error('Timed out: ' + label);
}

async function reloadPanel(panel, expectedGameplay) {
  await new Promise((resolve, reject) => {
    const completed = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      panel.webContents.removeListener('did-finish-load', completed);
      reject(Error('Timed out: panel reload navigation'));
    }, 6000);
    panel.webContents.once('did-finish-load', completed);
    panel.webContents.reload();
  });
  await waitFor(() => panel.webContents.executeJavaScript(`
    document.body.dataset.gameplayState===${JSON.stringify(expectedGameplay)} &&
    document.querySelectorAll('#widget-settings input[data-widget-id]').length===5 &&
    document.querySelector('#connection-status')?.textContent.includes('Mock Clone Hero')
  `), 'reloaded panel initial state synchronization');
}

/** Real native input exercises pointer capture, transforms and keyboard focus. */
async function verifyBuilder(panel, host) {
  const evaluate = code => panel.webContents.executeJavaScript(code);
  const widgetSelector = id => `#builder-canvas [data-builder-widget-id="${id}"]`;
  const widget = id => structuredClone(host.snapshot().state.widgets.instances.find(item => item.id === id));
  const revision = () => host.snapshot().editor.revision;
  const selected = () => evaluate("[...document.querySelectorAll('#builder-canvas [data-builder-widget-id][aria-selected=\"true\"]')].map(node=>node.dataset.builderWidgetId)");
  const screenshot = async name => {
    await delay(100);
    await fs.writeFile(path.join(data, name), (await panel.webContents.capturePage()).toPNG());
  };
  const point = async selector => evaluate(`(()=>{
    const node=document.querySelector(${JSON.stringify(selector)});
    if(!node)throw Error('Missing interaction target: '+${JSON.stringify(selector)});
    node.scrollIntoView({block:'center',inline:'nearest'});
    const rect=node.getBoundingClientRect();
    if(!rect.width||!rect.height)throw Error('Hidden interaction target: '+${JSON.stringify(selector)});
    const target={x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};
    const hit=document.elementFromPoint(target.x,target.y);
    if(!hit||!(hit===node||node.contains(hit)))throw Error('Covered interaction target: '+${JSON.stringify(selector)}+'; hit '+(hit?.id||hit?.className||hit?.tagName||'outside viewport'));
    return target;
  })()`);
  const mouse = (type, coordinate, modifiers = []) => panel.webContents.sendInputEvent({
    type, ...coordinate, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }), modifiers
  });
  const click = async (selector, modifiers = []) => {
    await waitFor(() => evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});return !!node&&!node.disabled})()`), 'interaction control enabled: ' + selector);
    const target = await point(selector);
    panel.focus(); panel.webContents.focus();
    mouse('mouseMove', target, modifiers);
    mouse('mouseDown', target, modifiers);
    mouse('mouseUp', target, modifiers);
    await delay(40);
  };
  const key = async (keyCode, modifiers = []) => {
    panel.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    panel.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await delay(40);
  };
  const drag = async (selector, dx, dy, cancel = false) => {
    const start = await point(selector);
    const scale = await evaluate("document.querySelector('#builder-canvas').getBoundingClientRect().width/1280");
    assert.ok(scale > 0, 'builder logical canvas has a positive screen scale');
    panel.focus(); panel.webContents.focus();
    mouse('mouseMove', start);
    mouse('mouseDown', start);
    for (let step = 1; step <= 4; step++) {
      mouse('mouseMove', { x: Math.round(start.x + dx * scale * step / 4), y: Math.round(start.y + dy * scale * step / 4) }, ['leftButtonDown']);
      await delay(25);
    }
    if (cancel) await key('Escape');
    mouse('mouseUp', { x: Math.round(start.x + dx * scale), y: Math.round(start.y + dy * scale) });
    await delay(40);
  };
  const setNumber = async (selector, value) => {
    await click(selector);
    await key('A', [process.platform === 'darwin' ? 'meta' : 'control']);
    await panel.webContents.insertText(String(value));
    await key('Tab');
  };
  const command = async (name, payload) => {
    const result = await evaluate(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`);
    assert.equal(result.ok, true);
  };
  const overlayHas = async id => {
    const overlay = host.getOverlay();
    return !!overlay && !overlay.isDestroyed() && overlay.webContents.executeJavaScript(`!!document.querySelector('.companion-widget[data-widget-id="${id}"]')`);
  };

  panel.setSize(1250, 900);
  await delay(120);
  assert.equal(await evaluate("document.querySelector('#builder-toggle').getAttribute('aria-pressed')"), 'false');
  await command('mock.state', { state: 'menu' });
  await host.setOverlay(true);
  await waitFor(() => !host.getOverlay().isVisible(), 'menu overlay hidden before editing');
  assert.equal(host.snapshot().state.nowPlaying, null);
  await click('#builder-toggle');
  await waitFor(() => evaluate("document.querySelector('#builder-toggle').getAttribute('aria-pressed')==='true'"), 'builder enabled');
  await waitFor(() => evaluate("document.querySelectorAll('#builder-canvas [data-builder-widget-id]').length===5"), 'five independent layout targets');
  assert.equal(host.snapshot().state.gameplay.state, 'menu');
  assert.equal(host.snapshot().state.nowPlaying, null, 'editor sample metadata never enters shared store');
  assert.equal(host.getOverlay().isVisible(), false);
  await waitFor(async () => (await host.getOverlay().webContents.executeJavaScript("document.querySelectorAll('.companion-widget').length")) === 0, 'editor sample never renders in the real overlay');
  await screenshot('companion-builder-menu.png');
  passed.push('builder is off by default; menu editing keeps sample metadata local and native overlay empty');

  if (!(await evaluate("document.querySelector('#builder-snap').checked"))) await click('#builder-snap');
  await click(widgetSelector('song-title'));
  await waitFor(async () => JSON.stringify(await selected()) === '["song-title"]', 'native widget selection');
  assert.equal(await evaluate("document.querySelectorAll('#builder-canvas [data-resize-handle]').length"), 8);
  const originalTitle = widget('song-title'), beforeCancelledDrag = revision();
  await drag(widgetSelector('song-title'), 24, 16, true);
  assert.deepEqual(widget('song-title'), originalTitle, 'Escape cancels in-progress geometry');
  assert.equal(revision(), beforeCancelledDrag, 'cancel creates no history entry');
  await drag(widgetSelector('song-title'), 40, 24);
  await waitFor(() => revision() === beforeCancelledDrag + 1, 'one history entry for one drag');
  const movedTitle = widget('song-title');
  assert.deepEqual(movedTitle.position, { x: originalTitle.position.x + 40, y: originalTitle.position.y + 24 });
  assert.deepEqual(movedTitle.size, originalTitle.size);
  const beforeResizeRevision = revision();
  await drag('#builder-canvas [data-resize-handle="se"]', 32, 16);
  await waitFor(() => revision() === beforeResizeRevision + 1, 'one history entry for one resize');
  const resizedTitle = widget('song-title');
  assert.ok(resizedTitle.size.width > movedTitle.size.width);
  assert.ok(resizedTitle.size.height > movedTitle.size.height);
  assert.ok(resizedTitle.position.x + resizedTitle.size.width <= 1280);
  assert.ok(resizedTitle.position.y + resizedTitle.size.height <= 720);
  await screenshot('companion-builder-drag-resize.png');
  passed.push('native pointer selection exposes eight handles; Escape cancels; snapped drag and resize each commit once');

  await key('Z', [process.platform === 'darwin' ? 'meta' : 'control']);
  await waitFor(() => JSON.stringify(widget('song-title')) === JSON.stringify(movedTitle), 'keyboard undo resize');
  assert.equal(host.snapshot().editor.canRedo, true);
  await key('Z', [process.platform === 'darwin' ? 'meta' : 'control', 'shift']);
  await waitFor(() => JSON.stringify(widget('song-title')) === JSON.stringify(resizedTitle), 'keyboard redo resize');
  await screenshot('companion-builder-undo-redo.png');
  passed.push('Ctrl+Z and Ctrl+Shift+Z restore exact widget geometry through shared editor history');

  await click(widgetSelector('song-instrument'), ['shift']);
  await waitFor(async () => JSON.stringify((await selected()).sort()) === '["song-instrument","song-title"]', 'native Shift multi-selection');
  const beforeAlign = revision();
  await click('[data-align="left"]');
  await waitFor(() => revision() === beforeAlign + 1, 'multi-selection alignment');
  assert.equal(widget('song-title').position.x, widget('song-instrument').position.x);
  await click('#builder-list [data-select-widget-id="song-title"]');
  await waitFor(async () => JSON.stringify(await selected()) === '["song-title"]', 'single inspector selection');
  await setNumber('#builder-x', 160);
  await waitFor(() => widget('song-title').position.x === 160, 'inspector geometry change');
  passed.push('Shift-click selects multiple widgets, alignment commits together, and the numeric inspector changes logical geometry');

  await command('mock.state', { state: 'playing' });
  await waitFor(() => overlayHas('song-title'), 'title visible before visibility changes');
  await click('#builder-visible-game');
  await waitFor(() => !widget('song-title').visibility.game, 'game destination disabled');
  await waitFor(async () => !(await overlayHas('song-title')), 'game destination hides native title');
  await click('#builder-visible-game');
  await waitFor(() => widget('song-title').visibility.game, 'game destination restored');
  await click('#builder-visible-paused');
  await waitFor(() => !widget('song-title').gameplayVisibility.includes('paused'), 'pause visibility disabled');
  await command('mock.state', { state: 'paused' });
  await waitFor(async () => !(await overlayHas('song-title')), 'pause-specific native visibility');
  await command('mock.state', { state: 'playing' });
  await waitFor(() => overlayHas('song-title'), 'playing remains enabled independently');
  await click('#builder-visible-playing');
  await waitFor(() => widget('song-title').gameplayVisibility.length === 0, 'empty gameplay visibility supported');
  await waitFor(async () => !(await overlayHas('song-title')), 'no states means native title hidden');
  await click('#builder-visible-playing');
  await waitFor(() => widget('song-title').gameplayVisibility.includes('playing'), 'playing restored');
  await click('#builder-visible-game');
  await waitFor(() => !widget('song-title').visibility.game, 'persist a disabled destination');
  const savedTitle = widget('song-title');
  await screenshot('companion-builder-visibility.png');
  passed.push('game destination and playing/paused checkboxes independently control the real overlay, including an empty state list');

  await host.saveSettings();
  const savedDocument = JSON.parse(await fs.readFile(path.join(data, 'settings/settings.json'), 'utf8'));
  assert.deepEqual(savedDocument.widgets.find(item => item.id === 'song-title'), savedTitle);
  await reloadPanel(panel, 'playing');
  await waitFor(() => evaluate("document.querySelector('#builder-toggle')?.getAttribute('aria-pressed')==='false'"), 'reload exits editing');
  await waitFor(() => evaluate("document.querySelector('#widget-settings input[data-widget-id=\"song-title\"]')?.checked===true"), 'reload restores controls');
  assert.deepEqual(widget('song-title'), savedTitle);
  await click('#builder-toggle');
  await click('#builder-list [data-select-widget-id="song-title"]');
  await waitFor(() => evaluate("Number(document.querySelector('#builder-x').value)===160"), 'reloaded inspector geometry');
  assert.equal(await evaluate("document.querySelector('#builder-visible-game').checked"), false);
  assert.equal(await evaluate("document.querySelector('#builder-visible-playing').checked"), true);
  assert.equal(await evaluate("document.querySelector('#builder-visible-paused').checked"), false);
  await click('#builder-toggle');
  await command('mock.state', { state: 'menu' });
  await waitFor(() => !host.getOverlay().isVisible(), 'builder leaves native overlay hidden in menu');
  assert.equal(host.snapshot().state.nowPlaying, null);
  passed.push('geometry and visibility save to disk, restore after reload, and editing mode stays off by default');
}

async function verifyThemes(panel, host) {
  const evaluate = code => panel.webContents.executeJavaScript(code);
  const title = () => structuredClone(host.snapshot().state.widgets.instances.find(item => item.id === 'song-title'));
  const settings = () => structuredClone({ widgets: host.snapshot().state.widgets.instances, theme: host.snapshot().state.theme });
  const revision = () => host.snapshot().editor.revision;
  const click = async selector => {
    await waitFor(() => evaluate(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`), 'theme control enabled: ' + selector);
    const target = await evaluate(`(()=>{
      const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'center',inline:'nearest'});
      const rect=node.getBoundingClientRect();const point={x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};
      const hit=document.elementFromPoint(point.x,point.y);
      if(!rect.width||!rect.height||!hit||!(hit===node||node.contains(hit)))throw Error('Theme interaction target is hidden or covered: '+${JSON.stringify(selector)});
      return point;
    })()`);
    panel.focus(); panel.webContents.focus();
    panel.webContents.sendInputEvent({ type: 'mouseMove', ...target });
    panel.webContents.sendInputEvent({ type: 'mouseDown', ...target, button: 'left', clickCount: 1 });
    panel.webContents.sendInputEvent({ type: 'mouseUp', ...target, button: 'left', clickCount: 1 });
    await delay(40);
  };
  const key = async (keyCode, modifiers = []) => {
    panel.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    panel.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await delay(40);
  };
  const input = async (selector, value) => {
    await click(selector);
    await key('A', [process.platform === 'darwin' ? 'meta' : 'control']);
    await panel.webContents.insertText(String(value));
    await key('Tab');
  };
  const select = async (selector, value) => {
    await waitFor(() => evaluate(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`), 'theme select enabled');
    // Select popups are owned by the operating system. Exercise their DOM change
    // handler while text entry, Apply, Reset, and history use native input.
    await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  };
  const checked = async (selector, value) => {
    if ((await evaluate(`document.querySelector(${JSON.stringify(selector)}).checked`)) !== value) await click(selector);
  };
  const command = async (name, payload) => {
    const result = await evaluate(`window.ChartsHubCompanion.command(${JSON.stringify(name)},${JSON.stringify(payload)})`);
    assert.equal(result.ok, true);
  };
  const chooseColor = async (id, color) => {
    await waitFor(() => evaluate(`!!document.getElementById(${JSON.stringify(id + '-picker')})&&!document.getElementById(${JSON.stringify(id + '-picker')}).disabled`), 'color picker enabled: ' + id);
    // The OS color dialog is outside Chromium automation. Exercise its actual
    // input/change integration while opacity changes use native mouse/keyboard.
    await evaluate(`(()=>{
      const picker=document.getElementById(${JSON.stringify(id + '-picker')});
      picker.value=${JSON.stringify(color)};
      picker.dispatchEvent(new Event('input',{bubbles:true}));
      picker.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
  };
  const colorField = id => evaluate(`(()=>({
    text:document.getElementById(${JSON.stringify(id)}).value,
    rgb:document.getElementById(${JSON.stringify(id + '-picker')}).value,
    opacity:Number(document.getElementById(${JSON.stringify(id + '-opacity')}).value)
  }))()`);
  const styleExpression = container => `(()=>{
    const node=document.querySelector(${JSON.stringify(container + ' .companion-widget[data-widget-id="song-title"]')});
    const text=node?.querySelector('.companion-widget-text');if(!node||!text)return null;
    const outer=getComputedStyle(node),inner=getComputedStyle(text);
    return {color:outer.color,backgroundColor:outer.backgroundColor,boxShadow:outer.boxShadow,fontSize:outer.fontSize,fontWeight:outer.fontWeight,
      textColor:inner.color,textShadow:inner.textShadow,filter:inner.filter,gradient:inner.backgroundImage,textFill:inner.webkitTextFillColor};
  })()`;
  const sameStyles = async label => {
    await waitFor(async () => {
      const preview = await evaluate(styleExpression('#game-preview'));
      const themePreview = await evaluate(styleExpression('#theme-preview'));
      const actual = await host.getOverlay().webContents.executeJavaScript(styleExpression('#game-overlay'));
      return !!preview && !!themePreview && !!actual && JSON.stringify(preview) === JSON.stringify(actual) && JSON.stringify(themePreview) === JSON.stringify(actual);
    }, label);
    return evaluate(styleExpression('#game-preview'));
  };

  await command('widget.visibility', { revision: revision(), id: 'song-title', game: true, gameplayVisibility: ['playing', 'paused'] });
  await command('mock.state', { state: 'playing' });
  await host.setOverlay(true);
  await waitFor(() => host.getOverlay().isVisible(), 'theme test native overlay visible');
  await waitFor(() => evaluate("document.querySelector('#theme-preset')?.options.length===8"), 'eight theme presets populated');
  if (!(await evaluate("document.querySelector('#theme-panel').open"))) await click('#theme-panel summary');
  const originalGeometry = { position: title().position, size: title().size };
  for (const id of ['neon', 'dark', 'light', 'cyberpunk', 'retro', 'transparent', 'high-contrast', 'chartshub']) {
    await select('#theme-preset', id);
    await waitFor(() => host.snapshot().state.theme.presetId === id, 'preset applied: ' + id);
    await sameStyles('preview and native overlay agree for preset ' + id);
    assert.deepEqual({ position: title().position, size: title().size }, originalGeometry);
  }
  passed.push('all eight presets apply through UI controls, preserve geometry, and render identical computed styles in preview and native overlay');

  const colorFieldIds = [
    ...['primary', 'secondary', 'accent', 'text', 'mutedText', 'background', 'border', 'progress', 'glow', 'shadow'].map(token => 'theme-color-' + token),
    'theme-gradient-from', 'theme-gradient-to',
    'appearance-color', 'appearance-background', 'appearance-border', 'appearance-glow-color', 'appearance-gradient-from', 'appearance-gradient-to'
  ];
  await waitFor(() => evaluate("document.querySelectorAll('input[type=color][data-color-for]').length===18&&document.querySelectorAll('input[type=range][data-opacity-for]').length===18"), 'eighteen color picker and opacity pairs');
  const disabledMirrorsText = () => evaluate(`(${JSON.stringify(colorFieldIds)}).every(id=>{
    const text=document.getElementById(id),picker=document.getElementById(id+'-picker'),opacity=document.getElementById(id+'-opacity');
    return !!text&&!!picker&&!!opacity&&picker.type==='color'&&opacity.type==='range'&&
      picker.dataset.colorFor===id&&opacity.dataset.opacityFor===id&&opacity.min==='0'&&opacity.max==='100'&&
      picker.disabled===text.disabled&&opacity.disabled===text.disabled;
  })`);
  await waitFor(disabledMirrorsText, 'all color helper enabled states mirror their text input');
  assert.equal(await evaluate("document.querySelector('#appearance-color-picker').disabled"), true, 'theme-following widget cannot edit a custom color');
  passed.push('all 18 palette, gradient and widget colors have an RGB picker plus opacity slider with matching disabled states');

  const beforePicker = settings();
  await chooseColor('theme-color-text', '#123456');
  await waitFor(() => host.snapshot().state.theme.colors.text === '#123456', 'palette RGB picker commits');
  const afterFirstPicker = settings();
  await waitFor(async () => JSON.stringify(await colorField('theme-color-text')) === JSON.stringify({ text: '#123456', rgb: '#123456', opacity: 100 }), 'opaque picker synchronizes text and opacity');
  await click('#theme-color-text-opacity');
  const opacity = (await colorField('theme-color-text')).opacity;
  assert.ok(opacity >= 45 && opacity <= 55, `Center click should set approximately half opacity, got ${opacity}`);
  const alpha = Math.round(opacity * 255 / 100).toString(16).padStart(2, '0');
  await waitFor(() => host.snapshot().state.theme.colors.text === '#123456' + alpha, 'native opacity slider commits palette alpha');
  const afterOpacity = settings();
  await chooseColor('theme-color-text', '#abcdef');
  await waitFor(() => host.snapshot().state.theme.colors.text === '#abcdef' + alpha, 'RGB change preserves existing alpha');
  assert.deepEqual(await colorField('theme-color-text'), { text: '#abcdef' + alpha, rgb: '#abcdef', opacity });
  await host.saveSettings();
  assert.equal(JSON.parse(await fs.readFile(path.join(data, 'settings/settings.json'), 'utf8')).theme.colors.text, '#abcdef' + alpha);
  await click('#theme-undo');
  await waitFor(() => JSON.stringify(settings()) === JSON.stringify(afterOpacity), 'undo RGB picker retains previous alpha');
  await click('#theme-undo');
  await waitFor(() => JSON.stringify(settings()) === JSON.stringify(afterFirstPicker), 'undo opacity restores opaque RGB');
  await waitFor(async () => (await colorField('theme-color-text')).opacity === 100, 'opacity slider follows undo');
  await click('#theme-undo');
  await waitFor(() => JSON.stringify(settings()) === JSON.stringify(beforePicker), 'restore initial palette after picker checks');
  passed.push('palette picker and native opacity slider synchronize RGB/alpha, save canonically, and undo to the exact previous palette');

  const beforeColor = settings();
  await input('[data-theme-token="text"]', 'rgba(255, 128, 32, 0.75)');
  await waitFor(() => host.snapshot().state.theme.colors.text === '#ff8020bf', 'global RGBA token canonicalized');
  const afterColor = settings();
  await click('#builder-toggle');
  await click('#builder-list [data-select-widget-id="song-title"]');
  await input('#builder-x', 192);
  await waitFor(() => title().position.x === 192, 'placement after theme edit');
  await click('#builder-toggle');
  const afterPlacement = settings();
  await click('#theme-undo');
  await waitFor(() => JSON.stringify(settings()) === JSON.stringify(afterColor), 'shared undo restores placement without undoing prior theme');
  await click('#theme-undo');
  await waitFor(() => JSON.stringify(settings()) === JSON.stringify(beforeColor), 'shared undo restores preceding theme');
  await click('#theme-redo');
  await waitFor(() => JSON.stringify(settings()) === JSON.stringify(afterColor), 'shared redo restores theme');
  await click('#theme-redo');
  await waitFor(() => JSON.stringify(settings()) === JSON.stringify(afterPlacement), 'shared redo restores placement');
  await click('#theme-preset-reset');
  await waitFor(() => JSON.stringify(host.snapshot().state.theme) === JSON.stringify(beforeColor.theme), 'restore current preset without switching away');
  assert.equal(title().position.x, 192);
  await click('#theme-undo');
  await waitFor(() => JSON.stringify(settings()) === JSON.stringify(afterPlacement), 'undo restoring the current preset');
  passed.push('theme and placement share chronological undo/redo, including history controls outside edit mode');

  await checked('#theme-glow-enabled', true);
  await input('#theme-glow-blur', 12);
  await checked('#theme-gradient-enabled', true);
  await input('#theme-gradient-from', 'hsl(0 100% 50%)');
  await input('#theme-gradient-to', 'rgba(0, 0, 255, 0.5)');
  await input('#theme-gradient-angle', 135);
  await click('#theme-effects-apply');
  await waitFor(() => host.snapshot().state.theme.effects.glow.blur === 12 && host.snapshot().state.theme.effects.gradient.enabled, 'global glow and gradient applied');
  const globalStyle = await sameStyles('global effects agree on both surfaces');
  assert.match(globalStyle.gradient, /linear-gradient/);
  assert.equal(globalStyle.textShadow, 'none');
  assert.match(globalStyle.filter, /drop-shadow/);
  assert.match(globalStyle.filter, /\b6px\b/);
  await fs.writeFile(path.join(data, 'companion-theme-presets.png'), (await panel.webContents.capturePage()).toPNG());
  passed.push('global text glow and gradient apply consistently to preview and native overlay');

  await select('#appearance-widget', 'song-title');
  await select('#appearance-color-mode', 'custom');
  await waitFor(disabledMirrorsText, 'custom mode enables matching color helper controls');
  assert.equal(await evaluate("document.querySelector('#appearance-color-picker').disabled"), false);
  await input('#appearance-color', 'rgb(12, 34, 56)');
  await click('#appearance-apply');
  await waitFor(() => title().style.color === '#0c2238' && title().style.colorMode === 'custom', 'RGB custom text color applied');
  await input('#appearance-color', 'hsl(120 100% 50% / 50%)');
  await input('#appearance-background', 'rgba(16, 32, 48, 0.25)');
  await input('#appearance-border', 'hsl(240, 100%, 50%)');
  await checked('#appearance-glow-enabled', true);
  await input('#appearance-glow-color', '#ff00ff');
  await input('#appearance-glow-blur', 18);
  await checked('#appearance-gradient-enabled', true);
  await input('#appearance-gradient-from', '#FF0');
  await input('#appearance-gradient-to', 'rgba(0, 255, 255, 0.5)');
  await input('#appearance-gradient-angle', 90);
  await click('#appearance-apply');
  await waitFor(() => title().style.color === '#00ff0080' && title().style.glow?.blur === 18 && title().style.gradient?.enabled, 'HSL alpha and widget effects applied');
  assert.equal(title().style.backgroundColor, '#10203040');
  assert.equal(title().style.borderColor, '#0000ff');
  const customStyle = await sameStyles('custom alpha colors and effects agree on both surfaces');
  assert.match(customStyle.gradient, /linear-gradient/);
  assert.equal(customStyle.textShadow, 'none');
  assert.match(customStyle.filter, /drop-shadow/);
  assert.match(customStyle.filter, /\b9px\b/);
  const customized = title();
  await click('#appearance-reset');
  await waitFor(() => title().style.colorMode === 'theme' && !title().style.glow && !title().style.gradient, 'return widget to theme');
  assert.deepEqual(title().position, customized.position);
  assert.deepEqual(title().size, customized.size);
  assert.equal(title().style.fontSize, customized.style.fontSize);
  assert.equal(title().style.fontWeight, customized.style.fontWeight);
  await click('#theme-undo');
  await waitFor(() => JSON.stringify(title()) === JSON.stringify(customized), 'undo appearance reset');
  await sameStyles('restored custom style agrees on both surfaces');
  await fs.writeFile(path.join(data, 'companion-theme-custom.png'), (await panel.webContents.capturePage()).toPNG());
  await fs.writeFile(path.join(data, 'companion-theme-overlay.png'), (await host.getOverlay().webContents.capturePage()).toPNG());
  passed.push('RGB/HSL/alpha widget colors, glow and text gradients persist as canonical values; reset and undo preserve geometry and typography');

  await waitFor(async () => JSON.stringify(await colorField('appearance-color')) === JSON.stringify({ text: '#00ff0080', rgb: '#00ff00', opacity: 50 }), 'HSL alpha text synchronizes widget helper controls');
  assert.deepEqual(await colorField('appearance-background'), { text: '#10203040', rgb: '#102030', opacity: 25 });
  const beforeEffectPicker = settings(), effectPickerRevision = revision();
  await chooseColor('theme-gradient-from', '#ff00aa');
  await chooseColor('theme-gradient-to', '#22cc44');
  assert.equal(revision(), effectPickerRevision, 'gradient helper edits remain a draft before Apply');
  assert.deepEqual(settings(), beforeEffectPicker);
  await click('#theme-effects-apply');
  await waitFor(() => host.snapshot().state.theme.effects.gradient.from === '#ff00aa' && host.snapshot().state.theme.effects.gradient.to === '#22cc4480', 'global gradient picker endpoints apply with alpha');
  await click('#theme-undo');
  await waitFor(() => JSON.stringify(settings()) === JSON.stringify(beforeEffectPicker), 'undo global gradient helper edit');
  const beforeWidgetPicker = settings(), widgetPickerRevision = revision();
  await chooseColor('appearance-color', '#224466');
  assert.equal((await colorField('appearance-color')).text, '#22446680');
  await click('#appearance-color-opacity');
  await key('End');
  await waitFor(async () => JSON.stringify(await colorField('appearance-color')) === JSON.stringify({ text: '#224466', rgb: '#224466', opacity: 100 }), 'native widget opacity keyboard adjustment updates draft');
  await chooseColor('appearance-gradient-from', '#ff8800');
  await chooseColor('appearance-gradient-to', '#8800ff');
  assert.equal(revision(), widgetPickerRevision, 'widget picker and slider changes must wait for Apply');
  assert.deepEqual(settings(), beforeWidgetPicker);
  await click('#appearance-apply');
  await waitFor(() => title().style.color === '#224466' && title().style.gradient.from === '#ff8800' && title().style.gradient.to === '#8800ff80', 'widget picker, opacity and gradient drafts commit together');
  await click('#theme-undo');
  await waitFor(() => JSON.stringify(settings()) === JSON.stringify(beforeWidgetPicker), 'undo widget helper edit restores exact custom appearance');
  await waitFor(async () => (await colorField('appearance-color')).opacity === 50, 'widget alpha helper follows undo');
  await waitFor(disabledMirrorsText, 'color helper disabled states remain synchronized after undo');
  passed.push('global and widget gradient pickers preserve alpha; widget RGB/opacity edits wait for Apply and undo restores the saved appearance');

  // A shared CSS bug can pass all three style comparisons. Check actual opaque
  // glyph pixels too: yellow→cyan always has green=255, even behind a dark shadow.
  const savedTitleStyle = structuredClone(title().style);
  const savedShadow = host.snapshot().state.theme.colors.shadow;
  const pixelStyle = {
    ...savedTitleStyle,
    glow: { enabled: false, color: '#00000000', blur: 0 },
    gradient: { enabled: true, from: '#ffff00', to: '#00ffff', angle: 90 }
  };
  const nativeOverlay = host.getOverlay();
  const glyphBounds = () => nativeOverlay.webContents.executeJavaScript(`(()=>{
    const text=document.querySelector('.companion-widget[data-widget-id="song-title"] .companion-widget-text');
    if(!text?.firstChild)throw Error('Missing title glyphs for pixel regression');
    const range=document.createRange();range.selectNodeContents(text);
    const rect=range.getBoundingClientRect();
    const x=Math.floor(rect.left),y=Math.floor(rect.top);
    if(rect.width<=0||rect.height<=0)throw Error('Empty title glyph bounds for pixel regression');
    return {x,y,width:Math.ceil(rect.right)-x,height:Math.ceil(rect.bottom)-y};
  })()`);
  const waitForPaint = async () => {
    await nativeOverlay.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
    await delay(180);
  };
  try {
    await command('widget.appearance', { revision: revision(), id: 'song-title', style: pixelStyle });
    await command('theme.color', { revision: revision(), token: 'shadow', color: '#00000000' });
    await sameStyles('opaque pixel-test gradient reaches all surfaces');
    await waitForPaint();
    const rectangle = await glyphBounds();
    const before = await nativeOverlay.webContents.capturePage(rectangle);
    await fs.writeFile(path.join(data, 'companion-gradient-shadow-before.png'), before.toPNG());

    await command('theme.color', { revision: revision(), token: 'shadow', color: '#000000' });
    await sameStyles('opaque shadow reaches all surfaces');
    await waitForPaint();
    assert.deepEqual(await glyphBounds(), rectangle, 'shadow must not change glyph layout');
    const after = await nativeOverlay.webContents.capturePage(rectangle);
    await fs.writeFile(path.join(data, 'companion-gradient-shadow-after.png'), after.toPNG());
    assert.deepEqual(after.getSize(), before.getSize(), 'pixel captures must have matching dimensions');
    const beforeBitmap = before.toBitmap(), afterBitmap = after.toBitmap();
    assert.equal(afterBitmap.length, beforeBitmap.length, 'pixel bitmap byte lengths must match');
    assert.equal(beforeBitmap.length % 4, 0);
    let opaqueGlyphPixels = 0, brightAfterShadow = 0;
    // NativeImage bitmap bytes are BGRA here. Green at +1 and alpha at +3 also
    // have the same offsets in RGBA, so no red/blue channel convention is assumed.
    for (let offset = 0; offset < beforeBitmap.length; offset += 4) {
      if (beforeBitmap[offset + 3] > 245 && beforeBitmap[offset + 1] > 230) {
        opaqueGlyphPixels++;
        if (afterBitmap[offset + 1] > 200) brightAfterShadow++;
      }
    }
    assert.ok(opaqueGlyphPixels >= 100, `Expected at least 100 opaque bright glyph pixels, found ${opaqueGlyphPixels}`);
    assert.ok(brightAfterShadow / opaqueGlyphPixels >= 0.9,
      `Opaque shadow darkened the gradient glyphs: ${brightAfterShadow}/${opaqueGlyphPixels} stayed bright`);
    passed.push(`gradient pixel regression: ${brightAfterShadow}/${opaqueGlyphPixels} opaque glyph pixels stay bright with a black shadow`);
  } finally {
    await command('widget.appearance', { revision: revision(), id: 'song-title', style: savedTitleStyle });
    await command('theme.color', { revision: revision(), token: 'shadow', color: savedShadow });
  }
  await sameStyles('custom appearance restored after pixel regression');

  const expected = settings();
  await host.saveSettings();
  const document = JSON.parse(await fs.readFile(path.join(data, 'settings/settings.json'), 'utf8'));
  assert.equal(document.version, 3);
  assert.deepEqual({ widgets: document.widgets, theme: document.theme }, expected);
  await reloadPanel(panel, 'playing');
  await waitFor(() => evaluate("!document.querySelector('#theme-preset').disabled"), 'theme controls restored after reload');
  await sameStyles('reloaded theme renders identically on both surfaces');
  assert.deepEqual(settings(), expected);
  assert.equal(await evaluate("document.querySelector('[data-theme-token=\"text\"]').value"), '#ff8020bf');
  await select('#appearance-widget', 'song-title');
  await waitFor(() => evaluate("document.querySelector('#appearance-color').value==='#00ff0080'"), 'reloaded custom appearance controls');
  await command('mock.state', { state: 'menu' });
  await waitFor(() => !host.getOverlay().isVisible(), 'themed native overlay hidden in menu');
  await waitFor(async () => (await host.getOverlay().webContents.executeJavaScript("document.querySelectorAll('.companion-widget').length")) === 0, 'themed native overlay clears all widget DOM');
  assert.equal(host.snapshot().state.nowPlaying, null);
  await waitFor(() => evaluate("!!document.querySelector('#theme-preview .companion-widget[data-widget-id=\"song-title\"]')"), 'local theme preview remains usable in menu');
  assert.equal(await evaluate("document.querySelectorAll('#game-preview .companion-widget').length"), 0);
  passed.push('v3 settings retain themes and widget styles after save/reload; menu clears the themed overlay and stale metadata');
}
app.whenReady().then(async () => {
  try {
    await fs.mkdir(data, { recursive: true });
    host = await createCompanionHost({ dataDirectory: path.join(data, 'settings'), catalogueClient: catalogueFixture.client, downloadWorker: downloadFixture.worker, cloneHeroCandidates: [], cloneHeroProcessProbe: async () => ({ running: null, sessions: [] }) });
    const panel = await host.open();
    const evaluate = code => panel.webContents.executeJavaScript(code);
    const count = () => evaluate("document.querySelectorAll('#game-preview .companion-widget').length");
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const state = async (value, visible) => {
      assert.equal((await evaluate(`window.ChartsHubCompanion.command('mock.state',{state:${JSON.stringify(value)}})`)).ok, true);
      await waitFor(async () => (await count()) === visible, value + ' widget count');
      assert.equal(host.snapshot().state.gameplay.state, value);
      passed.push(value + ': ' + visible + ' widgets');
    };
    await waitFor(() => evaluate("document.body.dataset.gameplayState === 'menu'"), 'initial menu');
    assert.equal(await count(), 0);
    assert.equal(await evaluate('typeof window.require'), 'undefined');
    assert.equal(await evaluate('typeof window.ChartsHubDesktop'), 'undefined');
    passed.push('isolated local renderer, no Node or catalogue bridge');
    await click('#step-mock'); await waitFor(() => evaluate("document.body.dataset.gameplayState === 'loading'"), 'mock loading'); assert.equal(await count(), 0);
    await click('#step-mock'); await waitFor(async () => (await count()) === 5, 'mock playing');
    for (const value of ['Everlong', 'Foo Fighters', 'ExampleCharter', 'Guitar', 'Expert']) assert.ok(await evaluate(`document.querySelector('#game-preview').textContent.includes(${JSON.stringify(value)})`));
    passed.push('deterministic next buttons and all five values rendered');
    await delay(180);
    await fs.writeFile(path.join(data, 'companion-playing.png'), (await panel.webContents.capturePage()).toPNG());
    await click('#widget-settings input[data-widget-id="song-artist"]');
    await waitFor(async () => (await count()) === 4, 'Artist disabled');
    await delay(650);
    const settings = JSON.parse(await fs.readFile(path.join(data, 'settings/settings.json'), 'utf8'));
    assert.equal(settings.widgets.find(w => w.id === 'song-artist').enabled, false);
    await state('paused', 4);
    await click('#overlay-enabled');
    await waitFor(() => host.getOverlay()?.isVisible(), 'native overlay visible');
    const overlay = host.getOverlay();
    await waitFor(() => overlay.webContents.executeJavaScript("document.querySelectorAll('.companion-widget').length === 4"), 'native overlay content');
    assert.equal(overlay.isAlwaysOnTop(), true); assert.equal(overlay.isFocusable(), false);
    assert.equal((await overlay.webContents.executeJavaScript("window.ChartsHubCompanion.command('mock.state',{state:'menu'})")).ok, false);
    await delay(180);
    await fs.writeFile(path.join(data, 'companion-overlay.png'), (await overlay.webContents.capturePage()).toPNG());
    passed.push('native transparent overlay: four widgets, above windows, no focus, read-only IPC');
    await state('results', 0); await waitFor(() => !overlay.isVisible(), 'results hide'); assert.equal(host.snapshot().state.nowPlaying, null);
    await state('menu', 0); assert.equal(host.snapshot().state.nowPlaying, null);
    await state('idle', 0); await state('loading', 0); await state('playing', 4);
    passed.push('returning to menu clears stale metadata and the native overlay');
    await reloadPanel(panel, 'playing');
    await waitFor(() => evaluate("document.querySelector('#widget-settings input[data-widget-id=\"song-artist\"]')?.checked === false"), 'reload settings');
    await waitFor(async () => (await count()) === 4, 'reloaded render');
    passed.push('renderer reload restores saved checkbox and current state');
    await host.setOverlay(false);
    panel.setSize(900, 660);
    await delay(120);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    passed.push('minimum window width without horizontal overflow');
    await fs.writeFile(path.join(data, 'companion-small.png'), (await panel.webContents.capturePage()).toPNG());
    // Inject a failing widget only in this test renderer; no production crash switch exists.
    const fault = await evaluate(`(async()=>{
      const {createDefaultRegistry}=await import('../dist/widgets/core/index.js');
      const {WidgetRenderer}=await import('../dist/widgets/engine/WidgetRenderer.js');
      const r=createDefaultRegistry();const bad=r.get('Charter');
      const snapshot=await window.ChartsHubCompanion.getSnapshot();
      const {WidgetRegistry}=await import('../dist/widgets/engine/WidgetRegistry.js');
      const broken=new WidgetRegistry();
      for(const item of r.getAll())broken.register(item.definition,/charter/i.test(item.definition.type)?()=>{throw Error('test');}:item.component);
      const el=document.createElement('div');new WidgetRenderer(broken).render(el,snapshot.state);
      return [...el.querySelectorAll('.companion-widget')].map(node=>node.textContent);
    })()`);
    assert.equal(fault.length, 3); assert.ok(fault.includes('Everlong')); assert.ok(!fault.includes('ExampleCharter'));
    passed.push('injected Charter failure leaves every other enabled DOM widget working');
    await verifyBuilder(panel, host);
    await verifyThemes(panel, host);
    await verifyStream(panel, host, data, passed);
    await verifyLibrary(panel, host, data, passed);
    await verifyCatalogue(panel, host, data, passed, catalogueFixture);
    await verifyDownloads(panel, host, data, passed, downloadFixture);
    await verifyCloneHero({ host, panel, data, passed, waitFor });
    await verifyProfiles({ host, panel, data, passed, waitFor });
    await host.dispose(); host = null;
    await fs.writeFile(path.join(data, 'electron-check.txt'), 'PASS\n' + passed.join('\n') + '\n');
    console.log('PASS companion Electron: ' + passed.length + ' integration checks');
    app.exit(0);
  } catch (error) {
    console.error(error);
    await fs.mkdir(data, { recursive: true });
    const overlay = host?.getOverlay();
    const diagnostics = { state: host?.snapshot(), overlay: overlay && !overlay.isDestroyed() ? { visible: overlay.isVisible(), loading: overlay.webContents.isLoading(), url: overlay.webContents.getURL() } : null };
    const panel = host?.getPanel();
    if (panel && !panel.isDestroyed()) {
      try {
        diagnostics.panel = await Promise.race([
          panel.webContents.executeJavaScript(`(()=>({
            readyState:document.readyState,
            gameplay:document.body.dataset.gameplayState,
            connection:document.querySelector('#connection-status')?.textContent,
            builderEnabled:document.querySelector('#builder-toggle')?.getAttribute('aria-pressed'),
            selected:[...document.querySelectorAll('#builder-canvas [data-builder-widget-id][aria-selected="true"]')].map(node=>node.dataset.builderWidgetId),
            targets:document.querySelectorAll('#builder-canvas [data-builder-widget-id]').length,
            handles:document.querySelectorAll('#builder-canvas [data-resize-handle]').length,
            feedback:document.querySelector('#action-feedback')?.textContent?.slice(0,500),
            geometry:Object.fromEntries(['x','y','width','height'].map(key=>[key,document.querySelector('#builder-'+key)?.value])),
            lock:{checked:document.querySelector('#builder-locked')?.checked,disabled:document.querySelector('#builder-locked')?.disabled},
            profiles:{status:document.querySelector('#profiles-current-status')?.textContent,feedback:document.querySelector('#profiles-feedback')?.textContent,count:document.querySelectorAll('[data-profile-apply]').length},
            theme:{preset:document.querySelector('#theme-preset')?.value,feedback:document.querySelector('#theme-feedback')?.textContent,widget:document.querySelector('#appearance-widget')?.value,colorMode:document.querySelector('#appearance-color-mode')?.value,color:document.querySelector('#appearance-color')?.value,previewWidgets:document.querySelectorAll('#theme-preview .companion-widget').length},
            activeElement:{tag:document.activeElement?.tagName,id:document.activeElement?.id,type:document.activeElement?.getAttribute('type')}
          }))()`),
          delay(1500).then(() => ({ unavailable: 'Renderer diagnostic timed out' }))
        ]);
      } catch { diagnostics.panel = { unavailable: 'Renderer diagnostic failed' }; }
      try {
        const screenshot = await Promise.race([panel.webContents.capturePage(), delay(1500).then(() => null)]);
        if (screenshot) {
          await fs.writeFile(path.join(data, 'companion-failure.png'), screenshot.toPNG());
          diagnostics.panelScreenshot = 'companion-failure.png';
        }
      } catch { diagnostics.panelScreenshot = 'Capture unavailable'; }
    }
    await fs.writeFile(path.join(data, 'electron-check.txt'), 'FAIL\n' + String(error.stack) + '\n' + passed.join('\n') + '\n' + JSON.stringify(diagnostics, null, 2));
    try { if (host) await host.dispose(); } catch {}
    app.exit(1);
  }
});
