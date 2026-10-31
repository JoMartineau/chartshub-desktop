/** Public UI projection only. Stored widget documents and profiles remain untouched. */
export const MEASUREMENT_WIDGET_TYPES = Object.freeze([
  'gameplay.accuracy', 'gameplay.combo', 'gameplay.fc', 'gameplay.progress',
  'gameplay.comparison', 'session.goal', 'session.history',
]);
// Text lyrics also require the removed game clock; public lyrics use the
// explicitly selected game capture instead of an unsynchronized text widget.
const measurementTypes = new Set([...MEASUREMENT_WIDGET_TYPES, 'song.lyrics']);
export function gameplayFeatureFlags(features) {
  const gameplayMeasurements = features?.gameplayMeasurements === true;
  return { gameplayMeasurements, calibrationBeta: gameplayMeasurements && features?.calibrationBeta === true };
}
export function visibleWidgetSnapshot(snapshot, gameplayMeasurements = false) {
  const widgets = snapshot?.state?.widgets;
  if (gameplayMeasurements === true || !Array.isArray(widgets?.instances)) return snapshot;
  const instances = widgets.instances.filter(widget => !measurementTypes.has(widget.type));
  if (instances.length === widgets.instances.length) return snapshot;
  return { ...snapshot, state: { ...snapshot.state, widgets: { ...widgets, instances } } };
}
