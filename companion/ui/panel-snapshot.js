// Live measurements update the preview and calibration counters. Other controls
// need reconciliation only when their own state changes, not for each hit.
export function controlSnapshotSignature(snapshot) {
  const { telemetry, state, ...panels } = snapshot;
  const { performance, ...presentation } = state;
  const controls = telemetry ? {
    enabled: telemetry.enabled, canWrite: telemetry.canWrite,
    persistenceError: telemetry.persistenceError, settings: telemetry.settings,
    reason: telemetry.reason, status: telemetry.status, connected: telemetry.connected,
    gameVersion: telemetry.gameVersion, capabilities: telemetry.capabilities,
    hardware: telemetry.hardware, connectorSetup: telemetry.connectorSetup,
  } : null;
  return JSON.stringify([panels, presentation, controls]);
}
