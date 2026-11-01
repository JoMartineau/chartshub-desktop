'use strict';
// A version label alone never enables native import. Fill expectedBuild only
// after a reviewed provider has passed live-menu, playback and cache-restart
// verification for its exact game identity. There is no full-scan fallback.
module.exports = Object.freeze({ schema: 1, expectedBuild: null, gameVersion: '1.1.0.6142-final', validated: false });
