const test = require('node:test');
const assert = require('node:assert/strict');
const historyModule = import('../companion/dist/layout/WidgetHistory.js');

test('combined history undoes and redoes theme and placement edits in the original order', async () => {
  const { SnapshotHistory } = await historyModule;
  const initial = { widgets: [{ id: 'title', position: { x: 48, y: 440 } }], theme: { preset: 'chartshub', colors: { text: '#ffffff' } } };
  const history = new SnapshotHistory(initial);
  const themed = structuredClone(initial); themed.theme.preset = 'neon'; themed.theme.colors.text = '#00ffff';
  const moved = structuredClone(themed); moved.widgets[0].position.x = 160;
  assert.equal(history.commit(themed), true);
  assert.equal(history.commit(moved), true);
  assert.deepEqual(history.undo(), themed);
  assert.deepEqual(history.undo(), initial);
  assert.deepEqual(history.redo(), themed);
  assert.deepEqual(history.redo(), moved);
});

test('combined history isolates input and output objects and preserves redo for equivalent values', async () => {
  const { SnapshotHistory } = await historyModule;
  const initial = { widgets: [{ id: 'title', position: { x: 48, y: 440 } }], theme: { colors: { text: '#ffffff' }, effects: { glow: false } } };
  const history = new SnapshotHistory(initial);
  const next = structuredClone(initial); next.theme.effects.glow = true;
  history.commit(next);
  initial.theme.colors.text = '#badbad'; next.widgets[0].position.x = 999;
  const undone = history.undo();
  assert.equal(undone.theme.colors.text, '#ffffff');
  undone.theme = { effects: { glow: false }, colors: { text: '#ffffff' } };
  assert.equal(history.commit(undone), false, 'property ordering is not a theme change');
  assert.equal(history.canRedo, true);
  undone.widgets[0].position.x = 666;
  const redone = history.redo();
  assert.equal(redone.widgets[0].position.x, 48);
  assert.equal(redone.theme.effects.glow, true);
});

test('generic history handles falsy snapshots and bounds undo depth', async () => {
  const { SnapshotHistory } = await historyModule;
  const history = new SnapshotHistory(false, 2);
  assert.equal(history.commit(true), true);
  assert.equal(history.undo(), false);
  assert.equal(history.redo(), true);
  const numbers = new SnapshotHistory(0, 1);
  numbers.commit(1); numbers.commit(2);
  assert.equal(numbers.undo(), 1);
  assert.equal(numbers.undo(), null);
  assert.equal(numbers.redo(), 2);
});
