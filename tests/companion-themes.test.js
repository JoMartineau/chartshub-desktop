const test = require('node:test');
const assert = require('node:assert/strict');

const modules = Promise.all([
  import('../companion/dist/themes/normalizeColor.js'),
  import('../companion/dist/themes/ThemePresets.js'),
  import('../companion/dist/themes/ThemeService.js'),
  import('../companion/dist/themes/ThemeResolver.js'),
  import('../companion/dist/themes/types.js'),
  import('../companion/dist/widgets/engine/WidgetRenderer.js'),
  import('../companion/dist/widgets/core/registerCoreWidgets.js'),
]).then(values => Object.assign({}, ...values));

function state(api, theme) {
  return {
    gameplay: { state: 'playing', isChartActive: true },
    nowPlaying: { title: 'Everlong', artist: 'Foo Fighters', charter: 'ExampleCharter', instrument: 'Guitar', difficulty: 'Expert' },
    serviceHealth: {}, widgets: { instances: api.createDefaultWidgets() }, ...(theme ? { theme } : {}),
  };
}
function dom() {
  const document = {
    createDocumentFragment() { return { children: [], appendChild(child) { this.children.push(child); } }; },
    createElement(tag) {
      assert.equal(tag, 'span');
      return {
        dataset: {}, style: {}, children: [], value: '',
        appendChild(child) { this.children.push(child); },
        set textContent(value) { this.value = value; this.children = []; },
        get textContent() { return this.value + this.children.map(child => child.textContent).join(''); },
        set innerHTML(_) { throw Error('HTML rendering is forbidden'); },
      };
    },
  };
  return { ownerDocument: document, style: {}, children: [], replaceChildren(fragment) { this.children = fragment.children; } };
}

test('theme color parser canonicalizes HEX, RGB, HSL and alpha formats', async () => {
  const { normalizeColor } = await modules;
  const examples = [
    [' #AbC ', '#aabbcc'], ['#abcd', '#aabbccdd'], ['#ABCDEF', '#abcdef'], ['#ABCDEFff', '#abcdef'],
    ['#01020304', '#01020304'], ['transparent', '#00000000'],
    ['rgb(255, 0, 128)', '#ff0080'], ['rgba(255,0,128,0.5)', '#ff008080'],
    ['rgb(100% 0% 50% / 25%)', '#ff008040'], ['rgba(0 128 255 / 1)', '#0080ff'],
    ['rgb(1e2 0 0)', '#640000'], ['hsl(120, 100%, 50%)', '#00ff00'],
    ['hsla(240,100%,50%,.5)', '#0000ff80'], ['hsl(.5turn 100% 50% / 75%)', '#00ffffbf'],
    ['hsl(200grad 100% 50%)', '#00ffff'], [`hsl(${Math.PI}rad 100% 50%)`, '#00ffff'],
    ['hsl(-120deg 100% 50%)', '#0000ff'], ['hsl(720 100% 50%)', '#ff0000'], ['hsl(0 0% 50%)', '#808080'],
  ];
  for (const [input, expected] of examples) assert.equal(normalizeColor(input), expected, input);
});

test('theme color parser rejects arbitrary CSS, malformed syntax and out-of-range components', async () => {
  const { normalizeColor } = await modules;
  for (const input of [
    '', 'red', '#12', '#12345', '#123456789', 'none', 'currentColor', 'inherit',
    'var(--secret)', 'url(https://example.invalid)', 'expression(alert(1))', '#fff; background:url(x)',
    'rgb(255, 0, 0); color:red', 'rgb(0 0 calc(100%))', 'rgb(0/*a*/ 0 0)',
    'rgb(256,0,0)', 'rgb(-1,0,0)', 'rgb(100.1%,0%,0%)', 'rgba(0,0,0,1.01)', 'rgba(0,0,0,-.1)',
    'rgb(0,0)', 'rgb(0 0 0 0)', 'rgb(0,0,0 / .5)', 'rgb(0 0 0 / .5 / .5)',
    'rgb(0 0 0 /)', 'rgb(NaN 0 0)', 'rgb(Infinity 0 0)', 'rgb(1e999 0 0)',
    'hsl(0 1 0.5)', 'hsl(0 101% 50%)', 'hsl(0 100% -1%)', 'hsl(3foo 100% 50%)',
    null, undefined, 123, {}, '#'.repeat(300),
  ]) assert.equal(normalizeColor(input), null, String(input));
});

test('all eight independent presets validate and keep the complete token and effect contracts', async () => {
  const { themePresets, validateTheme, ThemeService, THEME_COLOR_TOKENS } = await modules;
  assert.deepEqual(themePresets.map(preset => preset.id), ['chartshub', 'dark', 'light', 'neon', 'cyberpunk', 'retro', 'transparent', 'high-contrast']);
  assert.deepEqual(themePresets.map(preset => preset.name), ['ChartsHub', 'Dark', 'Light', 'Neon', 'Cyberpunk', 'Retro', 'Transparent', 'High Contrast']);
  const service = new ThemeService();
  for (const preset of themePresets) {
    assert.deepEqual(validateTheme(preset.theme), preset.theme);
    assert.deepEqual(Object.keys(preset.theme.colors), [...THEME_COLOR_TOKENS]);
    const copy = service.applyPreset(preset.id);
    assert.equal(copy.presetId, preset.id);
    copy.colors.text = '#010203';
    copy.effects.glow.enabled = !copy.effects.glow.enabled;
    assert.notDeepEqual(copy, preset.theme);
    assert.deepEqual(service.applyPreset(preset.id), preset.theme, 'caller changes cannot mutate the catalog');
  }
  assert.throws(() => service.applyPreset('unknown'), /preset/i);
});

test('theme service edits are pure, normalize colors and merge validated effect patches', async () => {
  const { createDefaultTheme, ThemeService } = await modules;
  const original = createDefaultTheme();
  const before = structuredClone(original);
  const service = new ThemeService();
  const colored = service.setColor(original, 'accent', 'rgba(255,0,128,.5)');
  assert.equal(colored.colors.accent, '#ff008080');
  const effected = service.setEffects(colored, { glow: { enabled: true, blur: 40 }, gradient: { from: 'hsl(120 100% 50%)', angle: 360 } });
  assert.deepEqual(effected.effects.glow, { enabled: true, blur: 40 });
  assert.equal(effected.effects.gradient.from, '#00ff00');
  assert.equal(effected.effects.gradient.angle, 360);
  assert.equal(effected.effects.gradient.to, original.effects.gradient.to);
  assert.equal(effected.effects.gradient.enabled, false);
  assert.deepEqual(original, before);
  assert.throws(() => service.setColor(original, '__proto__', '#fff'));
  assert.throws(() => service.setColor(original, 'text', 'url(x)'));
  for (const effects of [{ glow: { blur: 41 } }, { glow: { blur: -1 } }, { gradient: { angle: 361 } }, { gradient: { enabled: 'yes' } }, { css: 'x' }, { glow: { filter: 'blur(1px)' } }]) {
    assert.throws(() => service.setEffects(original, effects));
  }
});

test('theme validation rejects missing fields, unsupported keys and invalid values', async () => {
  const { createDefaultTheme, validateTheme } = await modules;
  for (const mutate of [
    theme => { theme.presetId = 'custom-unknown'; },
    theme => { delete theme.colors.text; },
    theme => { theme.colors.extra = '#fff'; },
    theme => { theme.colors.text = 'var(--text)'; },
    theme => { theme.css = 'color:red'; },
    theme => { theme.effects.extra = {}; },
    theme => { theme.effects.glow.blur = NaN; },
    theme => { theme.effects.gradient.angle = Infinity; },
    theme => { delete theme.effects.glow.enabled; },
  ]) {
    const theme = createDefaultTheme(); mutate(theme); assert.throws(() => validateTheme(theme));
  }
  for (const value of [null, [], false, {}]) assert.throws(() => validateTheme(value));
});

test('widget appearance validator accepts only known safe color and numeric settings', async () => {
  const { validateWidgetStyle } = await modules;
  assert.deepEqual(validateWidgetStyle({ colorMode: 'custom', color: '#ABC', backgroundColor: 'rgb(0 0 0 / 25%)', borderColor: 'hsl(120 100% 50%)', fontSize: 8, fontWeight: 900, glow: { enabled: true, color: '#fff', blur: 40 }, gradient: { enabled: true, from: '#f00', to: '#00f8', angle: 360 } }), {
    colorMode: 'custom', color: '#aabbcc', backgroundColor: '#00000040', borderColor: '#00ff00', fontSize: 8, fontWeight: 900,
    glow: { enabled: true, color: '#ffffff', blur: 40 }, gradient: { enabled: true, from: '#ff0000', to: '#0000ff88', angle: 360 },
  });
  assert.deepEqual(validateWidgetStyle({}), {});
  for (const style of [
    { colorMode: 'inherit' }, { fontSize: 201 }, { fontSize: Infinity }, { fontWeight: 99 },
    { backgroundImage: 'url(x)' }, { color: 'red;position:fixed' }, { borderColor: 'var(--x)' },
    { glow: { enabled: true, color: '#fff', blur: 41 } }, { glow: { enabled: true, color: '#fff', blur: 2, filter: 'x' } },
    { gradient: { enabled: true, from: '#fff', to: '#000', angle: -1 } }, { gradient: { enabled: false } },
  ]) assert.throws(() => validateWidgetStyle(style));
});

test('source color preference is strictly boolean and enabled for existing widget profiles', async () => {
  const api = await modules;
  const charter = api.createDefaultWidgets().find(widget => widget.type === 'song.charter');
  assert.equal(api.resolveWidgetStyle(charter).useSourceColors, true);
  for (const enabled of [true, false]) {
    const style = api.validateWidgetStyle({ useSourceColors: enabled });
    assert.deepEqual(style, { useSourceColors: enabled });
    charter.style = style;
    assert.equal(api.resolveWidgetStyle(charter, api.createDefaultTheme()).useSourceColors, enabled);
  }
  for (const value of ['false', 0, 1, null, {}]) assert.throws(() => api.validateWidgetStyle({ useSourceColors: value }));
});

test('theme resolver maps all five widget roles without changing font or geometry across presets', async () => {
  const api = await modules;
  const widgets = api.createDefaultWidgets();
  const before = structuredClone(widgets);
  const expectedTokens = ['text', 'primary', 'mutedText', 'secondary', 'accent'];
  for (const { theme } of api.themePresets) {
    for (const [index, widget] of widgets.entries()) {
      assert.equal(widget.style.colorMode, 'theme');
      const result = api.resolveWidgetStyle(widget, theme);
      assert.equal(result.color, theme.colors[expectedTokens[index]]);
      assert.equal(result.fontSize, widget.style.fontSize);
      assert.equal(result.fontWeight, widget.style.fontWeight);
      assert.equal(result.backgroundColor, theme.colors.background);
      assert.equal(result.borderColor, theme.colors.border);
      assert.equal(result.shadowColor, theme.colors.shadow);
    }
  }
  assert.deepEqual(widgets, before);
});

test('custom foreground overrides global gradient while explicit local effects override global settings', async () => {
  const api = await modules;
  const theme = new api.ThemeService().applyPreset('neon');
  const widget = api.createDefaultWidgets()[0];
  assert.equal(api.resolveWidgetStyle(widget, theme).gradient.enabled, true);
  widget.style = { ...widget.style, colorMode: 'custom', color: 'hsl(120 100% 50%)' };
  let result = api.resolveWidgetStyle(widget, theme);
  assert.equal(result.color, '#00ff00');
  assert.equal(result.gradient.enabled, false);
  widget.style.backgroundColor = '#1238';
  widget.style.borderColor = '#456';
  widget.style.glow = { enabled: false, color: '#f008', blur: 3 };
  widget.style.gradient = { enabled: true, from: '#fff', to: '#000', angle: 180 };
  result = api.resolveWidgetStyle(widget, theme);
  assert.equal(result.backgroundColor, '#11223388');
  assert.equal(result.borderColor, '#445566');
  assert.deepEqual(result.glow, { enabled: false, color: '#ff000088', blur: 3 });
  assert.deepEqual(result.gradient, { enabled: true, from: '#ffffff', to: '#000000', angle: 180 });
  widget.style.colorMode = 'theme';
  assert.equal(api.resolveWidgetStyle(widget, theme).color, theme.colors.text);
  delete widget.style.gradient;
  assert.equal(api.resolveWidgetStyle(widget, theme).gradient.enabled, true);
});

test('absent theme preserves legacy widget colors and malformed styles stay safe and renderable', async () => {
  const api = await modules;
  const instances = api.createDefaultWidgets();
  for (const widget of instances) assert.equal(api.resolveWidgetStyle(widget).color, widget.style.color);
  const widget = instances[0];
  widget.style = { color: '#f80', fontSize: Infinity, fontWeight: 90000 };
  assert.equal(api.resolveWidgetStyle(widget).color, '#ff8800');
  assert.equal(api.resolveWidgetStyle(widget, api.createDefaultTheme()).color, '#ff8800', 'legacy custom color remains explicit without colorMode');
  widget.style = { colorMode: 'custom', color: 'url(secret)', backgroundColor: 'var(--evil)', borderColor: 'expression(x)', fontSize: Infinity, fontWeight: 90000, glow: { enabled: true, color: 'invalid', blur: 999 }, gradient: { enabled: true, from: 'url(x)', to: '#fff', angle: Infinity } };
  const resolved = api.resolveWidgetStyle(widget, api.createDefaultTheme());
  assert.equal(resolved.fontSize, 20);
  assert.equal(resolved.fontWeight, 900);
  assert.equal(resolved.glow.blur, 40);
  assert.equal(resolved.gradient.angle, 90);
  assert.doesNotMatch(JSON.stringify(resolved), /url\(|var\(|expression\(|secret|NaN|Infinity/);
  assert.equal(api.resolveWidgetStyle(widget, { bad: true }).color, '#f1f5f9');
  widget.style = null;
  assert.equal(api.resolveWidgetStyle(widget).color, '#f1f5f9');
});

test('renderer separates widget background and border from safe gradient text and keeps ellipsis', async () => {
  const api = await modules;
  const theme = new api.ThemeService().applyPreset('neon');
  theme.colors.background = '#01020380';
  theme.colors.border = '#aabbcc';
  theme.colors.shadow = '#10203080';
  const current = state(api, theme);
  current.nowPlaying.title = '<img onerror=neverExecute()>';
  const preview = dom();
  const native = dom();
  const renderer = new api.WidgetRenderer(api.createDefaultRegistry());
  renderer.render(preview, current);
  renderer.render(native, current);
  const outer = preview.children[0];
  const inner = outer.children[0];
  assert.equal(outer.dataset.widgetId, 'song-title');
  assert.equal(outer.textContent, '<img onerror=neverExecute()>');
  assert.equal(outer.style.backgroundColor, '#01020380');
  assert.equal(outer.style.boxShadow, 'inset 0 0 0 1px #aabbcc');
  assert.equal(outer.style.width, `${current.widgets.instances[0].size.width}px`);
  assert.equal(outer.style.overflow, 'visible', 'glow may extend beyond the layout rectangle');
  assert.equal(inner.style.textOverflow, 'ellipsis');
  assert.equal(inner.style.overflow, 'hidden');
  assert.equal(inner.style.backgroundClip, 'text');
  assert.equal(inner.style.color, 'transparent');
  assert.equal(inner.style.backgroundImage, 'linear-gradient(90deg, #00f5ff, #ff4fd8)');
  assert.equal(inner.style.textShadow, 'none', 'text shadows must not paint over the clipped gradient');
  assert.equal(inner.style.filter, 'drop-shadow(0 2px 3px #10203080) drop-shadow(0 0 1px #10203080) drop-shadow(0 0 9px #00f5ff)');
  assert.equal(outer.style.filter, undefined, 'shadows follow the glyphs, not the widget background rectangle');
  assert.deepEqual(preview.style, {}, 'theme does not paint a fullscreen overlay background');
  assert.deepEqual(preview.children.map(item => [item.style, item.children[0].style]), native.children.map(item => [item.style, item.children[0].style]));
});

test('large fonts keep a full line and glow space without resizing the widget frame in either destination', async () => {
  const api = await modules;
  const current = state(api, new api.ThemeService().applyPreset('neon'));
  const widget = current.widgets.instances[0];
  widget.visibility.stream = true;
  widget.position = { x: 64, y: 96 };
  widget.size = { width: 320, height: 28 };
  current.widgets.instances = [widget];
  const originalGeometry = JSON.stringify({ position: widget.position, size: widget.size });
  const renderer = new api.WidgetRenderer(api.createDefaultRegistry());
  for (const destination of ['game', 'stream']) {
    for (const fontSize of [200, 8]) {
      widget.style.fontSize = fontSize;
      const container = dom();
      renderer.render(container, current, destination);
      const outer = container.children[0];
      const inner = outer.children[0];
      const padding = Number.parseFloat(inner.style.padding);
      const contentHeight = Number.parseFloat(inner.style.height) - padding * 2;
      assert.ok(contentHeight >= fontSize * 1.25, 'the complete line fits inside the text clipping box');
      assert.ok(contentHeight >= 28, 'small text retains the original content area');
      assert.deepEqual([outer.style.left, outer.style.top, outer.style.width, outer.style.height], ['64px', '96px', '320px', '28px']);
      assert.equal(inner.style.width, `calc(100% + ${padding * 2}px)`);
      assert.equal(inner.style.textOverflow, 'ellipsis');
      assert.equal(outer.style.overflow, 'visible');
      assert.equal(inner.style.backgroundClip, 'text');
      assert.match(inner.style.filter, /drop-shadow\(0 0 9px #00f5ff\)/);
    }
  }
  assert.equal(JSON.stringify({ position: widget.position, size: widget.size }), originalGeometry);
});

test('renderer leaves custom solid foreground visible under gradient presets and still clears menus', async () => {
  const api = await modules;
  const current = state(api, new api.ThemeService().applyPreset('cyberpunk'));
  current.widgets.instances[0].style = { ...current.widgets.instances[0].style, colorMode: 'custom', color: '#abc' };
  const preview = dom();
  const renderer = new api.WidgetRenderer(api.createDefaultRegistry());
  renderer.render(preview, current);
  assert.equal(preview.children[0].style.color, '#aabbcc');
  assert.equal(preview.children[0].children[0].style.backgroundImage, undefined);
  assert.equal(preview.children[0].children[0].style.textShadow, '0 2px 6px #090014e6, 0 0 2px #090014e6, 0 0 10px #ff2ea6');
  assert.equal(preview.children[0].children[0].style.filter, undefined, 'solid text retains its existing shadow rendering');
  assert.equal(preview.children[1].children[0].style.backgroundClip, 'text');
  current.gameplay = { state: 'menu', isChartActive: false };
  renderer.render(preview, current);
  assert.deepEqual(preview.children, []);
});

test('gradient drop shadows only contain validated colors and bounded blur; disabled glow adds no filter', async () => {
  const api = await modules;
  const current = state(api, api.createDefaultTheme());
  const widget = current.widgets.instances[0];
  widget.style.glow = { enabled: true, color: 'url(secret)', blur: 90000 };
  widget.style.gradient = { enabled: true, from: '#fff', to: '#00f', angle: 90 };
  const preview = dom();
  const renderer = new api.WidgetRenderer(api.createDefaultRegistry());
  renderer.render(preview, current);
  const style = preview.children[0].children[0].style;
  assert.equal(style.textShadow, 'none');
  assert.equal(style.filter, 'drop-shadow(0 2px 3px #000000e6) drop-shadow(0 0 1px #000000e6) drop-shadow(0 0 20px #a78bfa)');
  assert.doesNotMatch(style.filter, /url\(|secret|90000|NaN|Infinity/);
  widget.style.glow.enabled = false;
  renderer.render(preview, current);
  assert.equal(preview.children[0].children[0].style.filter, 'drop-shadow(0 2px 3px #000000e6) drop-shadow(0 0 1px #000000e6)');
});

test('charter source colors use text-only spans, override gradients and retain background, glow and layout', async () => {
  const api = await modules;
  const current = state(api, new api.ThemeService().applyPreset('neon'));
  current.nowPlaying.charter = '<img onerror=neverExecute()> / Blue';
  current.nowPlaying.charterSegments = [
    { text: '<img onerror=neverExecute()>', color: '#FF0000' },
    { text: ' / ' }, { text: 'Blue', color: '#0000FF80' },
  ];
  const charter = current.widgets.instances.find(widget => widget.type === 'song.charter');
  charter.visibility.stream = true;
  charter.style = { ...charter.style, colorMode: 'custom', color: '#abcdef', backgroundColor: '#01020380', borderColor: '#aabbcc', gradient: { enabled: true, from: '#ffff00', to: '#00ffff', angle: 45 } };
  const renderer = new api.WidgetRenderer(api.createDefaultRegistry());
  for (const destination of ['game', 'stream']) {
    const container = dom();
    renderer.render(container, current, destination);
    const outer = container.children.find(widget => widget.dataset.widgetType === 'song.charter');
    const inner = outer.children[0];
    assert.equal(outer.textContent, current.nowPlaying.charter);
    assert.deepEqual(inner.children.map(segment => [segment.className, segment.textContent, segment.style.color]), [
      ['companion-widget-segment', '<img onerror=neverExecute()>', '#ff0000'],
      ['companion-widget-segment', ' / ', undefined], ['companion-widget-segment', 'Blue', '#0000ff80'],
    ]);
    assert.equal(outer.style.color, '#abcdef', 'uncolored segments inherit the chosen text color');
    assert.equal(outer.style.backgroundColor, '#01020380');
    assert.equal(outer.style.boxShadow, 'inset 0 0 0 1px #aabbcc');
    assert.equal(outer.style.width, `${charter.size.width}px`);
    assert.equal(inner.style.backgroundImage, undefined);
    assert.equal(inner.style.webkitTextFillColor, undefined);
    assert.equal(inner.style.textOverflow, 'ellipsis');
    assert.match(inner.style.textShadow, /0 0 18px #00f5ff/);
  }
  charter.style.useSourceColors = false;
  const container = dom();
  renderer.render(container, current);
  let inner = container.children.find(widget => widget.dataset.widgetType === 'song.charter').children[0];
  assert.equal(inner.children.length, 0);
  assert.equal(inner.textContent, current.nowPlaying.charter);
  assert.equal(inner.style.backgroundImage, 'linear-gradient(45deg, #ffff00, #00ffff)');
  delete charter.style.gradient;
  renderer.render(container, current);
  const outer = container.children.find(widget => widget.dataset.widgetType === 'song.charter');
  inner = outer.children[0];
  assert.equal(outer.style.color, '#abcdef');
  assert.equal(inner.style.backgroundImage, undefined, 'opting out restores a custom solid color as well');
});

test('missing, uncolored or invalid source segments leave normal charter gradients unchanged', async () => {
  const api = await modules;
  const current = state(api, new api.ThemeService().applyPreset('neon'));
  const renderer = new api.WidgetRenderer(api.createDefaultRegistry());
  const container = dom();
  for (const segments of [undefined, [{ text: 'ExampleCharter' }], [{ text: 'ExampleCharter', color: 'url(secret)' }]]) {
    current.nowPlaying.charterSegments = segments;
    renderer.render(container, current);
    const inner = container.children.find(widget => widget.dataset.widgetType === 'song.charter').children[0];
    assert.equal(inner.textContent, 'ExampleCharter');
    assert.equal(inner.children.length, 0);
    assert.equal(inner.style.backgroundImage, 'linear-gradient(90deg, #00f5ff, #ff4fd8)');
  }
});
