const test = require('node:test');
const assert = require('node:assert/strict');

const modules = Promise.all([
  import('../companion/dist/layout/WidgetLayoutEngine.js'),
  import('../companion/dist/layout/WidgetHistory.js'),
]).then(values => Object.assign({}, ...values));

function widget(id = 'title', x = 80, y = 96, width = 160, height = 80) {
  return {
    id, type: 'song-title', enabled: true,
    position: { x, y }, size: { width, height },
    visibility: { game: true, stream: false }, gameplayVisibility: ['playing', 'paused'],
    style: { color: '#abcdef', fontSize: 24 }, config: { label: 'Title', nested: { keep: true } },
  };
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function rect(instance) { return { ...instance.position, ...instance.size }; }
function inBounds(instance) {
  assert.ok(instance.size.width >= 24 && instance.size.height >= 16);
  assert.ok(instance.position.x >= 0 && instance.position.y >= 0);
  assert.ok(instance.position.x + instance.size.width <= 1280);
  assert.ok(instance.position.y + instance.size.height <= 720);
}

test('Companion layout moves a frozen selection without changing fields or other widgets', async () => {
  const { moveWidgets } = await modules;
  const original = freeze([widget(), widget('artist', 400, 200, 96, 64), widget('other', 16, 16)]);
  const before = structuredClone(original);
  const result = moveWidgets(original, ['title', 'artist', 'title', 'missing'], 40, 24);
  assert.deepEqual(rect(result[0]), { x: 120, y: 120, width: 160, height: 80 });
  assert.deepEqual(rect(result[1]), { x: 440, y: 224, width: 96, height: 64 });
  assert.equal(result[2], original[2]);
  for (const key of ['id', 'type', 'enabled', 'visibility', 'gameplayVisibility', 'style', 'config']) {
    assert.deepEqual(result[0][key], original[0][key]);
  }
  assert.deepEqual(original, before);
});

test('Companion layout clamps the entire selection using one delta in both directions', async () => {
  const { moveWidgets } = await modules;
  const original = [widget(), widget('artist', 400, 200, 96, 64)];
  const positive = moveWidgets(original, ['title', 'artist'], 9999, 9999, { snap: 8 });
  assert.deepEqual(positive.map(item => item.position), [{ x: 864, y: 552 }, { x: 1184, y: 656 }]);
  const negative = moveWidgets(original, ['title', 'artist'], -9999, -9999, { snap: 8 });
  assert.deepEqual(negative.map(item => item.position), [{ x: 0, y: 0 }, { x: 320, y: 104 }]);
  for (const result of [positive, negative]) {
    assert.equal(result[1].position.x - result[0].position.x, 320);
    assert.equal(result[1].position.y - result[0].position.y, 104);
    result.forEach(inBounds);
  }
});

test('Companion snap aligns the selection anchor; omitted options and zero preserve free movement', async () => {
  const { moveWidgets } = await modules;
  const original = [widget('a', 83, 99), widget('b', 126, 220)];
  assert.deepEqual(moveWidgets(original, ['a', 'b'], 2, 3)[0].position, { x: 85, y: 102 });
  assert.deepEqual(moveWidgets(original, ['a', 'b'], 2, 3, { snap: 0 })[0].position, { x: 85, y: 102 });
  const defaultGrid = moveWidgets(original, ['a', 'b'], 2, 3, {});
  assert.deepEqual(defaultGrid[0].position, { x: 88, y: 104 });
  assert.deepEqual(defaultGrid[1].position, { x: 131, y: 225 }, 'relative positions are not individually snapped');
  assert.deepEqual(moveWidgets(original, ['a'], 2, 3, { snap: 16 })[0].position, { x: 80, y: 96 });
});

test('Companion scaled pointer deltas have the same canvas result at half, full and double scale', async () => {
  const { screenDeltaToCanvas, moveWidgets } = await modules;
  for (const scale of [0.5, 1, 2]) {
    const delta = screenDeltaToCanvas(40 * scale, 24 * scale, scale);
    assert.deepEqual(delta, { dx: 40, dy: 24 });
    assert.deepEqual(moveWidgets([widget()], ['title'], delta.dx, delta.dy, { snap: 8 })[0].position, { x: 120, y: 120 });
  }
  for (const scale of [0, -1, NaN, Infinity]) assert.deepEqual(screenDeltaToCanvas(10, 10, scale), { dx: 0, dy: 0 });
});

test('Companion eight resize handles move the requested edges and preserve opposite edges', async () => {
  const { resizeWidget } = await modules;
  const original = freeze(widget('title', 100, 120, 200, 160));
  const expected = {
    n: { x: 100, y: 150, width: 200, height: 130 },
    ne: { x: 100, y: 150, width: 240, height: 130 },
    e: { x: 100, y: 120, width: 240, height: 160 },
    se: { x: 100, y: 120, width: 240, height: 190 },
    s: { x: 100, y: 120, width: 200, height: 190 },
    sw: { x: 140, y: 120, width: 160, height: 190 },
    w: { x: 140, y: 120, width: 160, height: 160 },
    nw: { x: 140, y: 150, width: 160, height: 130 },
  };
  for (const [handle, box] of Object.entries(expected)) {
    const resized = resizeWidget(original, handle, 40, 30);
    assert.deepEqual(rect(resized), box, handle);
    assert.deepEqual(resized.config, original.config);
    assert.equal(resized.id, original.id);
    inBounds(resized);
  }
  assert.deepEqual(rect(original), { x: 100, y: 120, width: 200, height: 160 });
});

test('Companion resize clamps all eight handles at canvas and minimum size', async () => {
  const { resizeWidget } = await modules;
  const original = widget('title', 100, 120, 200, 160);
  for (const handle of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    for (const delta of [-9999, 9999]) {
      const resized = resizeWidget(original, handle, delta, delta, { snap: 8 });
      inBounds(resized);
      if (handle.includes('w')) assert.equal(resized.position.x + resized.size.width, 300, `${handle}: right stays fixed`);
      if (handle.includes('e')) assert.equal(resized.position.x, 100, `${handle}: left stays fixed`);
      if (handle.includes('n')) assert.equal(resized.position.y + resized.size.height, 280, `${handle}: bottom stays fixed`);
      if (handle.includes('s')) assert.equal(resized.position.y, 120, `${handle}: top stays fixed`);
    }
  }
  assert.deepEqual(rect(resizeWidget(original, 'nw', 9999, 9999)), { x: 276, y: 264, width: 24, height: 16 });
  assert.deepEqual(rect(resizeWidget(original, 'se', -9999, -9999)), { x: 100, y: 120, width: 24, height: 16 });
});

test('Companion resize snaps moved edges rather than shifting anchors or distorting sizes', async () => {
  const { resizeWidget } = await modules;
  const original = widget('title', 83, 99, 101, 63);
  assert.deepEqual(rect(resizeWidget(original, 'se', 3, 3, { snap: 8 })), { x: 83, y: 99, width: 101, height: 69 });
  assert.deepEqual(rect(resizeWidget(original, 'nw', 3, 3, { snap: 8 })), { x: 88, y: 104, width: 96, height: 58 });
  assert.deepEqual(rect(resizeWidget(original, 'se', 3, 3, { snap: 0 })), { x: 83, y: 99, width: 104, height: 66 });
});

test('Companion single-widget alignment uses the canvas for all six alignments', async () => {
  const { alignWidgets } = await modules;
  const original = freeze([widget(), widget('unselected', 32, 48)]);
  const positions = {
    left: { x: 0, y: 96 }, center: { x: 560, y: 96 }, right: { x: 1120, y: 96 },
    top: { x: 80, y: 0 }, middle: { x: 80, y: 320 }, bottom: { x: 80, y: 640 },
  };
  for (const [alignment, expected] of Object.entries(positions)) {
    const result = alignWidgets(original, ['title', 'missing'], alignment);
    assert.deepEqual(result[0].position, expected, alignment);
    assert.equal(result[1], original[1]);
    assert.deepEqual(result[0].size, original[0].size);
  }
});

test('Companion multiple-widget alignment uses the original selection bounding box', async () => {
  const { alignWidgets } = await modules;
  const original = [widget(), widget('artist', 400, 200, 96, 64), widget('other', 0, 0)];
  const expected = {
    left: [{ x: 80, y: 96 }, { x: 80, y: 200 }],
    center: [{ x: 208, y: 96 }, { x: 240, y: 200 }],
    right: [{ x: 336, y: 96 }, { x: 400, y: 200 }],
    top: [{ x: 80, y: 96 }, { x: 400, y: 96 }],
    middle: [{ x: 80, y: 140 }, { x: 400, y: 148 }],
    bottom: [{ x: 80, y: 184 }, { x: 400, y: 200 }],
  };
  for (const [alignment, positions] of Object.entries(expected)) {
    const result = alignWidgets(original, ['title', 'artist'], alignment);
    assert.deepEqual(result.slice(0, 2).map(item => item.position), positions, alignment);
    assert.equal(result[2], original[2]);
    result.forEach(inBounds);
  }
});

test('Companion geometry patches enforce bounds and tolerate invalid numbers', async () => {
  const { patchWidgetGeometry, moveWidgets, resizeWidget } = await modules;
  const original = freeze([widget(), widget('other')]);
  const enlarged = patchWidgetGeometry(original, 'title', { x: 9999, y: 9999, width: 9999, height: 9999 });
  assert.deepEqual(rect(enlarged[0]), { x: 0, y: 0, width: 1280, height: 720 });
  const minimum = patchWidgetGeometry(original, 'title', { x: -50, y: -50, width: -4, height: 0 });
  assert.deepEqual(rect(minimum[0]), { x: 0, y: 0, width: 24, height: 16 });
  assert.deepEqual(patchWidgetGeometry(original, 'title', { x: NaN, y: Infinity, width: NaN, height: -Infinity }), original);
  assert.deepEqual(moveWidgets(original, ['title'], NaN, Infinity), original);
  assert.deepEqual(resizeWidget(original[0], 'se', NaN, Infinity), original[0]);
  assert.equal(enlarged[1], original[1]);
  assert.deepEqual(patchWidgetGeometry(original, 'missing', { x: 40 }), original);
  assert.deepEqual(moveWidgets(original, [], 40, 24), original);
});

test('Companion locked widgets reject every geometry operation and keep original metadata', async () => {
  const { moveWidgets, resizeWidget, alignWidgets, patchWidgetGeometry } = await modules;
  const locked = freeze({ ...widget(), locked: true, style: { color: '#abcdef', useSourceColors: true, fontSize: 24 } });
  for (const [dx, dy] of [[1, 0], [0, -10], [9999, 9999], [-9999, -9999]]) {
    assert.equal(moveWidgets([locked], [locked.id], dx, dy, { snap: 8 })[0], locked);
    for (const handle of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
      assert.equal(resizeWidget(locked, handle, dx, dy, { snap: 8 }), locked);
    }
  }
  for (const alignment of ['left', 'center', 'right', 'top', 'middle', 'bottom']) {
    assert.equal(alignWidgets([locked], [locked.id], alignment)[0], locked);
  }
  assert.equal(patchWidgetGeometry([locked], locked.id, { x: 9999, y: -20, width: 1, height: 9999 })[0], locked);
  assert.equal(patchWidgetGeometry([locked], locked.id, {})[0], locked);
  const unlocked = { ...locked, locked: false };
  assert.deepEqual(moveWidgets([unlocked], [unlocked.id], 1, 0)[0].position, { x: 81, y: 96 });
  assert.deepEqual(unlocked.style, locked.style);
});

test('Companion mixed selections move only unlocked widgets without locked boxes affecting bounds or snap', async () => {
  const { moveWidgets } = await modules;
  const original = freeze([{ ...widget('locked', 0, 0, 1280, 720), locked: true }, widget('a', 83, 99), { ...widget('b', 126, 220), locked: false }]);
  const snapped = moveWidgets(original, ['locked', 'a', 'b'], 2, 3, { snap: 8 });
  assert.equal(snapped[0], original[0]);
  assert.deepEqual(snapped.slice(1).map(item => item.position), [{ x: 88, y: 104 }, { x: 131, y: 225 }]);
  const clamped = moveWidgets(original, ['locked', 'a', 'b'], 9999, 9999);
  assert.equal(clamped[0], original[0]);
  assert.deepEqual(clamped.slice(1).map(item => item.position), [{ x: 1077, y: 519 }, { x: 1120, y: 640 }]);
  clamped.forEach(inBounds);
});

test('Companion mixed alignment excludes locked widgets from alignment targets and preserves dimensions', async () => {
  const { alignWidgets } = await modules;
  const original = freeze([{ ...widget('locked', 0, 0, 1280, 720), locked: true }, widget('a', 80, 96), widget('b', 400, 200, 96, 64)]);
  const left = alignWidgets(original, ['locked', 'a', 'b'], 'left');
  assert.equal(left[0], original[0]);
  assert.deepEqual(left.slice(1).map(item => item.position), [{ x: 80, y: 96 }, { x: 80, y: 200 }]);
  assert.deepEqual(left.map(item => item.size), original.map(item => item.size));
  assert.deepEqual(alignWidgets(original, ['locked', 'b'], 'right')[2].position, { x: 1184, y: 200 }, 'the single unlocked widget aligns to the canvas');
});

test('Companion stream projection shares locks while history can explicitly restore locked layout and appearance', async () => {
  const { createDefaultStream, projectStreamState } = await import('../companion/dist/overlay/stream/StreamConfig.js');
  const { moveWidgets, WidgetHistory } = await modules;
  const initial = [{ ...widget(), locked: true }];
  const stream = createDefaultStream(initial); stream.layout[0].x = 480;
  const projected = projectStreamState({ widgets: { instances: initial }, stream }).widgets.instances;
  assert.equal(projected[0].locked, true);
  assert.equal(moveWidgets(projected, ['title'], 8, 0)[0].position.x, 480);
  assert.equal(initial[0].position.x, 80);
  const history = new WidgetHistory(initial);
  const explicit = structuredClone(initial);
  explicit[0].position.x = 320; explicit[0].style.color = '#123456'; explicit[0].visibility.game = false;
  assert.equal(history.commit(explicit), true);
  assert.deepEqual(history.undo(), initial);
  assert.deepEqual(history.redo(), explicit);
});

test('Companion history preserves widget identities and isolates all external snapshots', async () => {
  const { WidgetHistory, moveWidgets } = await modules;
  const original = [widget()];
  const history = new WidgetHistory(original);
  original[0].config.nested.keep = false;
  const next = moveWidgets([widget()], ['title'], 40, 24);
  assert.equal(history.commit(next), true);
  next[0].position.x = 999;
  next[0].config.nested.keep = false;
  const undone = history.undo();
  assert.equal(undone[0].id, 'title');
  assert.deepEqual(undone[0].position, { x: 80, y: 96 });
  assert.equal(undone[0].config.nested.keep, true);
  undone[0].position.x = 444;
  undone[0].config.nested.keep = false;
  const redone = history.redo();
  assert.equal(redone[0].id, 'title');
  assert.deepEqual(redone[0].position, { x: 120, y: 120 });
  assert.equal(redone[0].config.nested.keep, true);
  redone[0].config.nested.keep = false;
  assert.equal(history.undo()[0].config.nested.keep, true);
  assert.equal(history.redo()[0].config.nested.keep, true);
});

test('Companion history ignores equivalent edits and preserves redo until a new edit', async () => {
  const { WidgetHistory, moveWidgets } = await modules;
  const initial = [widget()];
  const history = new WidgetHistory(initial);
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  assert.equal(history.undo(), null);
  assert.equal(history.redo(), null);
  const equivalent = structuredClone(initial);
  equivalent[0].config = { nested: { keep: true }, label: 'Title' };
  assert.equal(history.commit(equivalent), false, 'object property order is not an edit');
  assert.equal(history.canUndo, false);
  assert.equal(history.commit(moveWidgets(initial, ['title'], 40, 24)), true);
  assert.equal(history.canUndo, true);
  const restored = history.undo();
  assert.equal(history.canRedo, true);
  assert.equal(history.commit(restored), false);
  assert.equal(history.canRedo, true);
  assert.equal(history.commit(moveWidgets(restored, ['title'], -8, 0)), true);
  assert.equal(history.canRedo, false);
  assert.equal(history.redo(), null);
});

test('Companion history bounds undo depth and tracks order, additions and removals', async () => {
  const { WidgetHistory } = await modules;
  const initial = [widget()];
  const history = new WidgetHistory(initial, 2);
  const one = [widget('title', 88), widget('artist')];
  const two = [one[1], one[0]];
  const three = [widget('title', 104)];
  assert.equal(history.commit(one), true);
  assert.equal(history.commit(two), true);
  assert.equal(history.commit(three), true);
  assert.deepEqual(history.undo().map(item => item.id), ['artist', 'title']);
  assert.deepEqual(history.undo().map(item => item.id), ['title', 'artist']);
  assert.equal(history.undo(), null, 'the initial snapshot is evicted after the configured number of edits');
  assert.equal(history.canUndo, false);
  assert.deepEqual(history.redo(), two);
  assert.deepEqual(history.redo(), three);
  assert.equal(history.redo(), null);
  const disabled = new WidgetHistory(initial, 0);
  assert.equal(disabled.commit(three), true);
  assert.equal(disabled.canUndo, false);
  assert.equal(disabled.undo(), null);
});

test('Companion history treats shared and independently cloned JSON values equally', async () => {
  const { WidgetHistory } = await modules;
  const initial = [widget(), widget('artist')];
  initial[1].config = initial[0].config;
  const history = new WidgetHistory(initial);
  assert.equal(history.commit(JSON.parse(JSON.stringify(initial))), false);
});
