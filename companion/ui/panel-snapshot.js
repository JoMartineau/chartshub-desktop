// Live measurements update the preview and calibration counters. Other controls
// need reconciliation only when their own state changes, not for each hit.
export function controlSnapshotSignature(snapshot) {
  const { telemetry, state, drums, quickImport, catalogueSync, requestDiscovery, chat, sessionActivity, sessionWidgets, ...panels } = snapshot;
  // The removal panel consumes its own progress before the global fast path.
  // Root, revision and all other library changes still reconcile normally.
  if (panels.library) { const { selectedRemoval, ...libraryControls } = panels.library; panels.library = libraryControls; }
  if (drums) { const { meters, mt, ...drumControls } = drums; if (mt) { const { progress, ...installation } = mt; drumControls.mt = installation; } panels.drums = drumControls; }
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
