'use strict';
// Public builds retain ordinary widgets without loading the experimental
// provider, game installer or hardware probe. Only an explicit local Host
// option enables their factories; no saved preference can enable them.
function loadMeasurementFactories(enabled, load = require) {
  if (enabled !== true) return null;
  const { createTelemetrySource } = load('./clonehero-telemetry-source.cjs');
  const { createCalibrationHardware } = load('./calibration-hardware.cjs');
  const { createConnectorSetup } = load('./connector-setup.cjs');
  for (const factory of [createTelemetrySource, createCalibrationHardware, createConnectorSetup]) {
    if (typeof factory !== 'function') throw Error('Private measurement components unavailable');
  }
  return Object.freeze({ createTelemetrySource, createCalibrationHardware, createConnectorSetup });
}
// Electron Packager normalizes ignored paths to a leading forward slash.
// Source fixtures may still test these files; public distributions omit them.
const publicMeasurementBundleIgnore = Object.freeze([
  /^\/companion\/connector-assets(?:\/|$)/,
  /^\/companion\/connector-setup(?:-download|-payload)?\.cjs$/,
  /^\/companion\/calibration-hardware(?:-windows\.ps1|\.cjs)$/,
  /^\/companion\/clonehero-telemetry-(?:source|model)\.cjs$/
]);
module.exports = { loadMeasurementFactories, publicMeasurementBundleIgnore };
