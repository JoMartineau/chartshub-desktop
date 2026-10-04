const test = require('node:test');
const assert = require('node:assert/strict');

const modules = Promise.all([
  import('../companion/dist/overlay/stream/StreamConfig.js'),
  import('../companion/dist/widgets/engine/WidgetRenderer.js'),
  import('../companion/dist/widgets/core/registerCoreWidgets.js'),
  import('../companion/dist/themes/ThemeService.js'),
]).then(values => Object.assign({}, ...values));

function state(api) {
  const widgets = api.createDefaultWidgets();
  return {
    gameplay: { state: 'playing', isChartActive: true },
    nowPlaying: { title: 'Everlong', artist: 'Foo Fighters', charter: 'ExampleCharter', instrument: 'Guitar', difficulty: 'Expert' },
    serviceHealth: {}, widgets: { instances: widgets }, theme: api.createDefaultTheme(), stream: api.createDefaultStream(widgets),
  };
}

test('stream defaults clone all current widget positions with a complete 1280x720 logical layout', async () => {
  const api = await modules;
  const widgets = api.createDefaultWidgets();
  const stream = api.createDefaultStream(widgets);
  assert.equal(stream.port, 38473);
  assert.deepEqual(stream.canvas, { width: 1280, height: 720, fps: 60 });
  assert.deepEqual(stream.layout, widgets.map(widget => ({ id: widget.id, ...widget.position, ...widget.size })));
  stream.layout[0].x = 400;
  assert.equal(widgets[0].position.x, 48);
  widgets[1].position.x = 800;
  assert.equal(stream.layout[1].x, 48);
  assert.deepEqual(api.createDefaultStream([]).layout, []);
});

test('stream schema accepts supported resolution and frame-rate choices without rescaling layout', async () => {
  const api = await modules;
  const widgets = api.createDefaultWidgets();
  const original = api.createDefaultStream(widgets);
  for (const [width, height] of [[1280, 720], [1920, 1080], [2560, 1440], [3840, 2160], [1080, 1920], [320, 180], [7680, 4320]]) {
    for (const fps of [30, 60]) {
      const stream = api.validateStream({ ...original, canvas: { width, height, fps } }, widgets);
      assert.deepEqual(stream.canvas, { width, height, fps });
      assert.deepEqual(stream.layout, original.layout);
    }
  }
  for (const port of [1024, 65535]) assert.equal(api.validateStream({ ...original, port }, widgets).port, port);
});

test('stream schema rejects unknown fields, partial or duplicate layouts and unsupported values', async () => {
  const api = await modules;
  const widgets = api.createDefaultWidgets();
  const original = api.createDefaultStream(widgets);
  for (const mutate of [
    stream => { delete stream.port; },
    stream => { stream.port = 1023; }, stream => { stream.port = 65536; }, stream => { stream.port = 30000.5; }, stream => { stream.port = '38473'; },
    stream => { stream.host = '0.0.0.0'; }, stream => { stream.canvas.extra = true; },
    stream => { stream.canvas.width = 319; }, stream => { stream.canvas.width = 7681; }, stream => { stream.canvas.width = NaN; }, stream => { stream.canvas.width = 1280.5; },
    stream => { stream.canvas.height = 179; }, stream => { stream.canvas.height = 4321; }, stream => { stream.canvas.height = Infinity; },
    stream => { stream.canvas.fps = 0; }, stream => { stream.canvas.fps = 120; }, stream => { stream.canvas.fps = '60'; },
    stream => { delete stream.layout; }, stream => { stream.layout.pop(); }, stream => { stream.layout.push(stream.layout[0]); },
    stream => { stream.layout[1] = stream.layout[0]; }, stream => { stream.layout[0].id = 'unknown'; }, stream => { stream.layout[0].enabled = true; },
    stream => { stream.layout[0].x = -1; }, stream => { stream.layout[0].x = 1280; }, stream => { stream.layout[0].y = 720; },
    stream => { stream.layout[0].width = 23; }, stream => { stream.layout[0].width = 1281; }, stream => { stream.layout[0].height = 15; },
    stream => { stream.layout[0].x = NaN; }, stream => { stream.layout[0].height = Infinity; }, stream => { stream.layout[0].width = '200'; },
  ]) {
    const invalid = structuredClone(original); mutate(invalid);
    assert.throws(() => api.validateStream(invalid, widgets));
  }
  for (const value of [null, {}, [], false]) assert.throws(() => api.validateStream(value, widgets));
  assert.throws(() => api.validateStream(original, [...widgets, widgets[0]]));
});

test('stream schema normalizes layout order, preserves fractional geometry and isolates returned objects', async () => {
  const api = await modules;
  const widgets = api.createDefaultWidgets();
  const original = api.createDefaultStream(widgets);
  original.layout[0] = { id: widgets[0].id, x: 1255.5, y: 703.5, width: 24.5, height: 16.5 };
  original.layout.reverse();
  const validated = api.validateStream(original, widgets);
  assert.deepEqual(validated.layout.map(item => item.id), widgets.map(widget => widget.id));
  assert.deepEqual(validated.layout[0], { id: widgets[0].id, x: 1255.5, y: 703.5, width: 24.5, height: 16.5 });
  validated.layout[0].x = 100;
  validated.canvas.width = 1920;
  assert.equal(original.layout[4].x, 1255.5);
  assert.equal(original.canvas.width, 1280);
});

test('stream state projection replaces geometry only and cannot mutate game rectangles', async () => {
  const api = await modules;
  const original = state(api);
  original.widgets.instances[0].visibility = { game: false, stream: true };
  original.stream.layout[0] = { id: 'song-title', x: 400, y: 200, width: 500, height: 90 };
  const before = structuredClone(original);
  const projected = api.projectStreamState(original);
  assert.notEqual(projected, original);
  assert.deepEqual(projected.widgets.instances[0].position, { x: 400, y: 200 });
  assert.deepEqual(projected.widgets.instances[0].size, { width: 500, height: 90 });
  for (const key of ['id', 'type', 'enabled', 'visibility', 'gameplayVisibility', 'style', 'config']) {
    assert.deepEqual(projected.widgets.instances[0][key], original.widgets.instances[0][key]);
  }
  assert.equal(projected.theme, original.theme);
  assert.equal(projected.gameplay, original.gameplay);
  assert.equal(projected.nowPlaying, original.nowPlaying);
  assert.deepEqual(original, before);
  projected.widgets.instances[0].position.x = 0;
  projected.widgets.instances[0].size.width = 24;
  assert.deepEqual(original.widgets.instances[0].position, before.widgets.instances[0].position);
  assert.deepEqual(original.stream.layout[0], before.stream.layout[0]);
});

test('missing stream settings fall back to cloned game geometry for older in-memory snapshots', async () => {
  const api = await modules;
  const original = state(api);
  delete original.stream;
  const projected = api.projectStreamState(original);
  assert.deepEqual(projected.widgets.instances, original.widgets.instances);
  assert.notEqual(projected.widgets.instances[0], original.widgets.instances[0]);
  assert.notEqual(projected.widgets.instances[0].position, original.widgets.instances[0].position);
  assert.equal(original.stream, undefined);
});

test('projected stream preview uses stream visibility and independent layout while retaining gameplay rules', async () => {
  const api = await modules;
  const original = state(api);
  const renderer = new api.WidgetRenderer(api.createDefaultRegistry());
  original.widgets.instances[0].visibility = { game: false, stream: true };
  original.widgets.instances[1].visibility = { game: true, stream: false };
  original.widgets.instances[2].visibility = { game: true, stream: true };
  original.widgets.instances[3].visibility = { game: false, stream: true };
  original.widgets.instances[3].enabled = false;
  original.widgets.instances[4].visibility = { game: false, stream: false };
  original.stream.layout[0].x = 320;
  const game = renderer.renderWidgetModels(original, 'game');
  const stream = renderer.renderWidgetModels(api.projectStreamState(original), 'stream');
  assert.deepEqual(game.map(item => item.type), ['song.artist', 'song.charter']);
  assert.deepEqual(stream.map(item => item.type), ['song.title', 'song.charter']);
  assert.equal(stream[0].position.x, 320);
  assert.equal(original.widgets.instances[0].position.x, 48);
  for (const gameplay of ['idle', 'menu', 'loading', 'playing', 'paused', 'results']) {
    original.gameplay = { state: gameplay, isChartActive: gameplay === 'playing' || gameplay === 'paused' };
    assert.equal(renderer.renderWidgetModels(api.projectStreamState(original), 'stream').length, ['playing', 'paused'].includes(gameplay) ? 2 : 0, gameplay);
  }
  original.gameplay = { state: 'playing', isChartActive: true };
  original.nowPlaying.title = undefined;
  assert.deepEqual(renderer.renderWidgetModels(api.projectStreamState(original), 'stream').map(item => item.type), ['song.charter']);
});
