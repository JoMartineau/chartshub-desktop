'use strict';
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { assetPath } = require('../companion/security.cjs');

function createPlayerFixtureRequestGuard(bundleDirectory) {
  const bundle = path.resolve(bundleDirectory);
  return value => {
    let url;
    try { url = new URL(value); } catch { return false; }
    if (url.protocol === 'file:') {
      if (url.hostname || url.search || url.hash || url.username || url.password || url.port) return false;
      try {
        const filename = fileURLToPath(url), relative = path.relative(bundle, filename);
        if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) return false;
        const route = 'chartshub-companion://app/' + relative.split(path.sep).map(encodeURIComponent).join('/');
        // The real protocol uses net.fetch(file://...) on defaultSession for bundled UI/dist assets.
        // Reuse its canonical containment check; neither Songs nor the fixture profile is permitted.
        return assetPath(bundle, route) === filename;
      } catch { return false; }
    }
    if (url.protocol === 'chartshub-companion:') return url.hostname === 'app' && !url.username && !url.password && !url.port;
    return ['data:', 'blob:', 'about:', 'devtools:'].includes(url.protocol);
  };
}
function playerFixtureConsoleError(event, ...legacy) {
  const level = event?.level ?? legacy[0];
  if (level !== 'error' && level !== 3) return null;
  return String(event?.message ?? legacy[1] ?? 'Renderer console error').slice(0, 300);
}
module.exports = { createPlayerFixtureRequestGuard, playerFixtureConsoleError };
