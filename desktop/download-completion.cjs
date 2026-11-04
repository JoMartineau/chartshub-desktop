'use strict';
const { ORIGIN, endpointValid } = require('../download');

function createDownloadCompletion(fetcher) {
  return async function reportDownloadCompletion(endpoint) {
    if (!endpointValid(endpoint) || !endpoint.startsWith('/api/charts/')) return;
    const url = ORIGIN + endpoint.replace(/download-manifest$/, 'download-complete');
    try {
      const response = await fetcher(url, {
        method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { Origin: ORIGIN }, signal: AbortSignal.timeout(5000)
      });
      await response.body?.cancel();
    } catch {
      // Download statistics are best effort. A saved chart is already complete.
    }
  };
}

module.exports = { createDownloadCompletion };
