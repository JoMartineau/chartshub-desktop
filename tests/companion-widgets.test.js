const assert = require('node:assert/strict');
const { before, test } = require('node:test');

let api;
before(async () => {
  const modules = await Promise.all([
    import('../companion/dist/widgets/core/registerCoreWidgets.js'),
    import('../companion/dist/widgets/engine/WidgetRegistry.js'),
    import('../companion/dist/widgets/engine/WidgetRenderer.js'),
    import('../companion/dist/widgets/engine/CapabilityResolver.js'),
    import('../companion/dist/widgets/engine/VisibilityResolver.js'),
    import('../companion/dist/widgets/engine/WidgetSelectors.js')
  ]);
  api = Object.assign({}, ...modules);
});

function makeState() {
  return {
    gameplay: { state: 'playing', isChartActive: true },
    nowPlaying: { title: 'Everlong', artist: 'Foo Fighters', charter: 'ExampleCharter', instrument: 'Guitar', difficulty: 'Expert' },
    serviceHealth: {},
    widgets: { instances: api.createDefaultWidgets() }
  };
}

test('widget registry registers exactly five independent core widgets and rejects duplicate registration', () => {
  const registry = api.createDefaultRegistry();
  assert.deepEqual(registry.getAll().map(({ definition }) => definition.type), [
    'song.title', 'song.artist', 'song.charter', 'song.instrument', 'song.difficulty'
  ]);
  assert.equal(new Set(registry.getAll().map(entry => entry.component)).size, 5);
  const entry = registry.get('song.title');
  assert.equal(entry.definition.displayName, 'Song Title');
  assert.throws(() => registry.register(entry.definition, entry.component), /already registered/);
  assert.equal(registry.get('unregistered'), undefined);
  const copy = registry.getAll();
  copy.length = 0;
  assert.equal(registry.getAll().length, 5);
});

test('default widget instances have stable unique IDs and independent mutable settings', () => {
  const first = api.createDefaultWidgets();
  const second = api.createDefaultWidgets();
  assert.equal(new Set(first.map(widget => widget.id)).size, 5);
  assert.deepEqual(first.map(widget => widget.id), second.map(widget => widget.id));
  first[1].enabled = false;
  first[0].position.x = 999;
  first[0].gameplayVisibility.push('results');
  assert.equal(second[1].enabled, true);
  assert.equal(second[0].position.x, 48);
  assert.deepEqual(second[0].gameplayVisibility, ['playing', 'paused']);
});

test('all six gameplay states hide stale metadata outside playing and paused', () => {
  const state = makeState();
  const renderer = new api.WidgetRenderer(api.createDefaultRegistry());
  for (const gameplayState of ['idle', 'menu', 'loading', 'playing', 'paused', 'results']) {
    state.gameplay.state = gameplayState;
    // Deliberately retain both old metadata and active flag: state visibility is still required.
    state.gameplay.isChartActive = true;
    const expected = ['playing', 'paused'].includes(gameplayState) ? 5 : 0;
    assert.equal(renderer.renderWidgetModels(state).length, expected, gameplayState);
  }
  state.gameplay = { state: 'playing', isChartActive: false };
  assert.deepEqual(renderer.renderWidgetModels(state), []);
  state.gameplay = { state: 'paused', isChartActive: false };
  assert.deepEqual(renderer.renderWidgetModels(state), []);
});

test('visibility respects each instance, destination, and configured gameplay states', () => {
  const state = makeState();
  const registry = api.createDefaultRegistry();
  const renderer = new api.WidgetRenderer(registry);
  const artist = state.widgets.instances.find(widget => widget.type === 'song.artist');
  const definition = registry.get(artist.type).definition;
  assert.equal(api.isWidgetVisible(artist, definition, state), true);
  artist.enabled = false;
  assert.equal(renderer.renderWidgetModels(state).length, 4);
  artist.enabled = true;
  artist.visibility.game = false;
  artist.visibility.stream = true;
  assert.equal(renderer.renderWidgetModels(state, 'game').length, 4);
  assert.deepEqual(renderer.renderWidgetModels(state, 'stream').map(model => model.type), ['song.artist']);
  artist.gameplayVisibility = [];
  assert.equal(renderer.renderWidgetModels(state, 'stream').length, 0);
  delete artist.gameplayVisibility;
  state.gameplay.state = 'paused';
  assert.equal(renderer.renderWidgetModels(state, 'stream').length, 1);
  artist.gameplayVisibility = ['results'];
  state.gameplay.state = 'results';
  assert.equal(renderer.renderWidgetModels(state, 'stream').length, 1);
  state.gameplay.isChartActive = false;
  assert.equal(renderer.renderWidgetModels(state, 'stream').length, 0);
});

test('capabilities independently hide only the field that is missing or a placeholder', () => {
  const registry = api.createDefaultRegistry();
  const renderer = new api.WidgetRenderer(registry);
  for (const field of ['title', 'artist', 'charter', 'instrument', 'difficulty']) {
    for (const missingValue of [undefined, null, '', '  ', 'undefined', 'NULL', 'N/A', 'unknown']) {
      const state = makeState();
      const definition = registry.get(`song.${field}`).definition;
      assert.equal(api.hasCapabilities(definition, state), true);
      state.nowPlaying[field] = missingValue;
      assert.equal(api.hasCapabilities(definition, state), false, `${field}: ${missingValue}`);
      const models = renderer.renderWidgetModels(state);
      assert.equal(models.length, 4);
      assert.equal(models.some(model => model.type === `song.${field}`), false);
    }
  }
  const state = makeState();
  state.nowPlaying = null;
  assert.deepEqual(renderer.renderWidgetModels(state), []);
  assert.equal(api.hasCapabilities({ requiredCapabilities: [] }, state), true);
  assert.equal(api.hasCapabilities({ requiredCapabilities: ['song.future'] }, state), false);
  assert.equal(api.hasCapabilities({ requiredCapabilities: ['constructor'] }, state), false);
});

test('selectors return meaningful text and preserve untrusted markup as plain text', () => {
  const state = makeState();
  state.nowPlaying.title = '  <img src=x onerror=alert(1)>\nEverlong  ';
  assert.equal(api.selectSongTitle(state), '<img src=x onerror=alert(1)> Everlong');
  assert.equal(api.selectArtist(state), 'Foo Fighters');
  assert.equal(api.selectCharter(state), 'ExampleCharter');
  assert.equal(api.selectInstrument(state), 'Guitar');
  assert.equal(api.selectDifficulty(state), 'Expert');
  assert.equal(api.meaningfulText(42), null);
});

test('charter models preserve validated source colors for game and stream and respect the opt-out', () => {
  const state = makeState();
  state.nowPlaying.charter = 'Plain Red Blue';
  state.nowPlaying.charterSegments = [{ text: 'Plain ' }, { text: 'Red ', color: '#FF0000' }, { text: 'Blue', color: '#0000FF80' }];
  const charter = state.widgets.instances.find(widget => widget.type === 'song.charter');
  charter.visibility.stream = true;
  const renderer = new api.WidgetRenderer(api.createDefaultRegistry());
  for (const destination of ['game', 'stream']) {
    const model = renderer.renderWidgetModels(state, destination).find(widget => widget.type === 'song.charter');
    assert.equal(model.text, 'Plain Red Blue');
    assert.deepEqual(model.segments, [{ text: 'Plain ' }, { text: 'Red ', color: '#ff0000' }, { text: 'Blue', color: '#0000ff80' }]);
    model.segments[1].color = '#ffffff';
    assert.equal(state.nowPlaying.charterSegments[1].color, '#FF0000', 'models do not mutate the source');
  }
  charter.style.useSourceColors = false;
  const model = renderer.renderWidgetModels(state).find(widget => widget.type === 'song.charter');
  assert.equal(model.segments, undefined);
  assert.equal(model.text, 'Plain Red Blue');
});

test('invalid charter colors or mismatched text fall back to the plain charter', () => {
  const state = makeState();
  state.nowPlaying.charter = 'Charter';
  const renderer = new api.WidgetRenderer(api.createDefaultRegistry());
  for (const segments of [
    [{ text: 'Charter', color: 'red' }], [{ text: 'Charter', color: 'url(https://evil.invalid)' }],
    [{ text: 'Charter', color: '#ff0000;position:fixed' }], [{ text: 'Charter', color: '#fff' }],
    [{ text: 'Another', color: '#ff0000' }], [{ text: 'Charter', color: '#ff0000', html: '<script>' }],
    [{ text: 'Charter' }], [], null,
  ]) {
    state.nowPlaying.charterSegments = segments;
    const model = renderer.renderWidgetModels(state).find(widget => widget.type === 'song.charter');
    assert.equal(model.text, 'Charter');
    assert.equal(model.segments, undefined, JSON.stringify(segments));
  }
});

test('renderer validates custom component segments and restricts their use to charter widgets', () => {
  const registry = new api.WidgetRegistry();
  for (const { definition, component } of api.createDefaultRegistry().getAll()) {
    registry.register(definition, (state, instance) => {
      const content = component(state, instance);
      return content && { ...content, segments: [{ text: content.text, color: definition.type === 'song.charter' ? 'url(secret)' : '#ff0000' }] };
    });
  }
  const models = new api.WidgetRenderer(registry).renderWidgetModels(makeState());
  assert.equal(models.length, 5);
  assert.equal(models.every(model => model.segments === undefined), true);
});

test('one throwing Charter widget leaves the other four visible and retries after config changes', () => {
  const registry = new api.WidgetRegistry();
  for (const { definition, component } of api.createDefaultRegistry().getAll()) {
    registry.register(definition, definition.type === 'song.charter' ? (state, instance) => {
      if (instance.config.fail) throw new Error('secret-token private-path raw-error');
      return component(state, instance);
    } : component);
  }
  const errors = [];
  const renderer = new api.WidgetRenderer(registry, error => errors.push(error));
  const state = makeState();
  const charter = state.widgets.instances.find(widget => widget.type === 'song.charter');
  charter.config.fail = true;
  assert.deepEqual(renderer.renderWidgetModels(state).map(model => model.text), ['Everlong', 'Foo Fighters', 'Guitar', 'Expert']);
  assert.deepEqual(errors, [{ widgetId: charter.id, widgetType: charter.type, code: 'WIDGET_RENDER_FAILED', message: 'Widget could not be rendered.' }]);
  assert.doesNotMatch(JSON.stringify(errors), /secret-token|private-path|raw-error/);
  charter.config.fail = false;
  assert.equal(renderer.renderWidgetModels(state).length, 5);
  charter.config.fail = true;
  const failingReporter = new api.WidgetRenderer(registry, () => { throw new Error('reporter failed'); });
  assert.equal(failingReporter.renderWidgetModels(state).length, 4);
});

test('unknown widget instances are skipped without affecting known widgets', () => {
  const state = makeState();
  state.widgets.instances.push({ ...state.widgets.instances[0], id: 'future-widget', type: 'future.widget' });
  assert.equal(new api.WidgetRenderer(api.createDefaultRegistry()).renderWidgetModels(state).length, 5);
});

test('renderer bounds invalid numeric layout settings to usable values', () => {
  const state = makeState();
  const title = state.widgets.instances[0];
  title.position = { x: NaN, y: Infinity };
  title.size = { width: -1, height: NaN };
  title.style = { fontSize: Infinity, fontWeight: 90000 };
  const model = new api.WidgetRenderer(api.createDefaultRegistry()).renderWidgetModels(state)[0];
  assert.deepEqual(model.position, { x: 0, y: 0 });
  assert.deepEqual(model.size, { width: 1, height: 50 });
  assert.equal(model.style.fontSize, 20);
  assert.equal(model.style.fontWeight, 900);
});

test('DOM renderer uses textContent and removes every old node immediately on menu transition', () => {
  const document = {
    createDocumentFragment() { return { children: [], appendChild(element) { this.children.push(element); } }; },
    createElement(tag) {
      assert.equal(tag, 'span');
      return {
        dataset: {}, style: {}, children: [], value: '',
        appendChild(element) { this.children.push(element); },
        set textContent(value) { this.value = value; this.children = []; },
        get textContent() { return this.value + this.children.map(child => child.textContent).join(''); },
        set innerHTML(_) { throw new Error('HTML rendering is forbidden'); }
      };
    }
  };
  const container = { ownerDocument: document, children: [], replaceChildren(fragment) { this.children = fragment.children; } };
  const renderer = new api.WidgetRenderer(api.createDefaultRegistry());
  const state = makeState();
  state.nowPlaying.title = '<script>never execute</script>';
  renderer.render(container, state);
  assert.equal(container.children.length, 5);
  assert.equal(container.children[0].textContent, '<script>never execute</script>');
  assert.equal(container.children[0].style.position, 'absolute');
  assert.equal(container.children[0].dataset.widgetId, 'song-title');
  assert.equal(container.children[0].children[0].className, 'companion-widget-text');
  assert.equal(container.children[0].children[0].style.textOverflow, 'ellipsis');
  state.gameplay = { state: 'menu', isChartActive: false };
  renderer.render(container, state);
  assert.deepEqual(container.children, []);
});
