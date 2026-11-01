'use strict';
// Main-process bridge only. It never starts inputs or the telemetry transport.
function createInputViewerGameEvents({ getContext, getViewer }) {
  const context = () => {
    try {
      const value = getContext();
      return value?.ready === true && Number.isSafeInteger(value.lifecycle) && value.lifecycle >= 0 && Number.isSafeInteger(value.revision) && value.revision >= 0
        ? { lifecycle: value.lifecycle, revision: value.revision } : null;
    } catch { return null; }
  };
  async function handle(event) {
    if (!event || !['start', 'end'].includes(event.type) || typeof event.id !== 'string' || !/^chart-[a-f0-9]{64}$/.test(event.id)) return false;
    const owner = context();
    let viewer;
    try { viewer = getViewer(); } catch { return false; }
    if (!owner || !viewer) return false;
    const current = () => {
      const next = context();
      try { return !!next && next.lifecycle === owner.lifecycle && next.revision === owner.revision && getViewer() === viewer; } catch { return false; }
    };
    if (!current()) return false;
    try {
      const result = event.type === 'start' ? await viewer.confirmChartStart(event.id, current) : viewer.confirmChartEnd(event.id);
      return current() && result === true;
    } catch { return false; }
  }
  return { handle };
}
module.exports = { createInputViewerGameEvents };
