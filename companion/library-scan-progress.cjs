'use strict';
// Observational progress only; estimates never control indexing or file access.
function emptyScanProgress() { return { visited: 0, processed: 0, discovered: 0, added: 0, skipped: 0, warningCount: 0, elapsedMs: 0, estimatedRemainingMs: null }; }
function estimateScanRemaining({ mode, baselineCount, knownCompleted, elapsedMs }) {
  // A first/full scan cannot know how many folders are still undiscovered.
  // Quick scans use the last committed index only after a useful sample.
  if (mode !== 'quick' || !Number.isSafeInteger(baselineCount) || baselineCount < 20
      || !Number.isSafeInteger(knownCompleted) || knownCompleted < 10 || knownCompleted >= baselineCount
      || knownCompleted < baselineCount * 0.05 || !Number.isFinite(elapsedMs) || elapsedMs < 1000) return null;
  const remaining = elapsedMs / knownCompleted * (baselineCount - knownCompleted);
  return Number.isFinite(remaining) && remaining <= 86400000 ? Math.ceil(remaining / 1000) * 1000 : null;
}
module.exports = { emptyScanProgress, estimateScanRemaining };
