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

test('Public stream projection keeps a complete five-widget layout without changing thirteen persisted records', async () => {
  const { visibleWidgetSnapshot } = await load();
  const [{createDefaultWidgets,ensureGameplayDocument},{createDefaultTheme},{createDefaultStream,projectStreamState,validateStream}] = await Promise.all([
    import('../companion/dist/widgets/core/index.js'), import('../companion/dist/themes/ThemeService.js'), import('../companion/dist/overlay/stream/StreamConfig.js'),
  ]);
  const widgets = createDefaultWidgets();
  const document = ensureGameplayDocument({version:3,widgets,theme:createDefaultTheme(),stream:createDefaultStream(widgets)});
  const snapshot = {state:{widgets:{instances:document.widgets},stream:document.stream},profiles:[{document}]};
  assert.equal(snapshot.state.widgets.instances.length,13);
  assert.equal(snapshot.state.stream.layout.length,13);
  const before = JSON.stringify(snapshot), result = visibleWidgetSnapshot(snapshot);
  assert.equal(result.state.widgets.instances.length,5);
  assert.deepEqual(result.state.stream.layout.map(item=>item.id),result.state.widgets.instances.map(widget=>widget.id));
  assert.doesNotThrow(()=>projectStreamState(result.state));
  assert.equal(projectStreamState(result.state).widgets.instances.length,5);
  assert.doesNotThrow(()=>validateStream(snapshot.state.stream,snapshot.state.widgets.instances));
  assert.equal(JSON.stringify(snapshot),before);
  assert.equal(result.profiles,snapshot.profiles);
  assert.equal(visibleWidgetSnapshot(snapshot,true),snapshot);
});
