'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../companion/ui/gameplay-features.js');

test('Only explicit private measurement flags enable either experimental interface', async () => {
  const { gameplayFeatureFlags } = await load();
  for (const features of [undefined, {}, { calibrationBeta: true }, { gameplayMeasurements: 'true', calibrationBeta: true }]) {
    assert.deepEqual(gameplayFeatureFlags(features), { gameplayMeasurements: false, calibrationBeta: false });
  }
  assert.deepEqual(gameplayFeatureFlags({ gameplayMeasurements: true }), { gameplayMeasurements: true, calibrationBeta: false });
  assert.deepEqual(gameplayFeatureFlags({ gameplayMeasurements: true, calibrationBeta: true }), { gameplayMeasurements: true, calibrationBeta: true });
});

test('Public settings preserve ordinary song widgets without changing persisted documents or profiles', async () => {
  const { MEASUREMENT_WIDGET_TYPES, visibleWidgetSnapshot } = await load();
  const traditional = ['song.title', 'song.artist', 'song.charter', 'song.instrument', 'song.difficulty'];
  const widgets = { version: 1, instances: [...traditional, ...MEASUREMENT_WIDGET_TYPES, 'song.lyrics'].map((type, index) => ({ id: 'widget-' + index, type, enabled: true })) };
  const snapshot = { state: { widgets, gameplay: { state: 'idle' } }, profiles: [{ id: 'existing-profile', document: { widgets } }] };
  const before = structuredClone(snapshot);
  const result = visibleWidgetSnapshot(snapshot);
  assert.deepEqual(result.state.widgets.instances.map(item => item.type), traditional);
  assert.deepEqual(snapshot, before);
  assert.equal(result.profiles, snapshot.profiles);
  assert.equal(result.state.gameplay, snapshot.state.gameplay);
  assert.equal(visibleWidgetSnapshot(snapshot, true), snapshot);
  assert.equal(visibleWidgetSnapshot(result), result);
  assert.equal(visibleWidgetSnapshot(null), null);
});
