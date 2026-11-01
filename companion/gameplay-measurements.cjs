'use strict';
// The legacy private experiment remains separate from the optional public
// Accuracy/lyrics reader. Public availability never loads calibration or setup.
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
function loadGameWidgetFactories(load = require) {
  const { createTelemetrySource } = load('./clonehero-telemetry-source.cjs');
  if (typeof createTelemetrySource !== 'function') throw Error('Optional game widget reader unavailable');
  return Object.freeze({ createTelemetrySource });
}
// Electron Packager normalizes ignored paths to a leading forward slash.
// Source fixtures may still test the retired files; public distributions omit
// all calibration/hardware/old setup assets. Only the read-only consumer ships.
const publicMeasurementBundleIgnore = Object.freeze([
  /^\/companion\/connector-assets(?:\/|$)/,
  /^\/companion\/connector-setup(?:-download|-payload)?\.cjs$/,
  /^\/companion\/calibration-hardware(?:-windows\.ps1|\.cjs)$/
]);
module.exports = { loadMeasurementFactories, loadGameWidgetFactories, publicMeasurementBundleIgnore };
