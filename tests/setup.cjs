'use strict';
const fs = require('node:fs');
const os = require('node:os');

// macOS /var aliases and Windows short paths can name the same temporary
// directory differently. Fixtures must use real paths, just like the native
// pickers, so the application's anti-symlink checks remain fully exercised.
// Preloading this before the test runner also passes the canonical environment
// to its subprocesses and library workers; application startup never loads it.
// The native implementation also expands Windows 8.3 names such as RUNNER~1.
const directory = fs.realpathSync.native(os.tmpdir());
process.env.TMPDIR = directory;
process.env.TEMP = directory;
process.env.TMP = directory;
