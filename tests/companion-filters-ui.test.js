const test = require('node:test');
const assert = require('node:assert/strict');

test('filter status never treats installation or requested activation as proof of rendering', async () => {
  const { filterPresentation, DEFAULT_FILTER_SETTINGS } = await import('../companion/ui/filters-controls.js');
  const status = { installed: true, state: 'restart-required', settings: { ...DEFAULT_FILTER_SETTINGS, enabled: true } };
  assert.equal(filterPresentation(status).active, false);
  assert.match(filterPresentation(status).label, /non confirmé/);
  assert.equal(filterPresentation({ ...status, native: { ready: true, frames: 0, enabled: true } }).active, false);
  assert.equal(filterPresentation({ ...status, native: { ready: false, frames: 100, enabled: true } }).active, false);
  assert.equal(filterPresentation({ ...status, native: { ready: true, frames: 100, enabled: false } }).active, false);
  assert.match(filterPresentation({ ...status, native: { ready: true, frames: 100, enabled: false } }).label, /Transmission/);
  assert.equal(filterPresentation({ ...status, native: { ready: true, frames: 100, enabled: true } }).active, true);
  assert.equal(filterPresentation({ ...status, state: 'error', native: { ready: true, frames: 100, enabled: true } }).active, false);
});

test('filter preset matching preserves activation and distinguishes custom changes', async () => {
  const { matchingFilterPreset, DEFAULT_FILTER_SETTINGS, FILTER_PRESETS } = await import('../companion/ui/filters-controls.js');
  assert.equal(matchingFilterPreset(DEFAULT_FILTER_SETTINGS), 'neutral');
  for (const [name, preset] of Object.entries(FILTER_PRESETS)) {
    assert.equal(matchingFilterPreset({ ...preset, enabled: true }), name);
    assert.equal(matchingFilterPreset({ ...preset, enabled: false }), name);
  }
  assert.equal(matchingFilterPreset({ ...DEFAULT_FILTER_SETTINGS, exposure: .35 }), 'custom');
});
