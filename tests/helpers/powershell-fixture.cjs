'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Cold Windows PowerShell startup and Add-Type contend with the parallel CI
// suite. This is a test-only bound, below npm test's 60-second file budget;
// production discovery deadlines are unchanged. Do not retry or suppress errors.
const POWERSHELL_FIXTURE_TIMEOUT_MS = 45000;
function runPowerShellFixture(script, { maxBuffer = 64 * 1024, execute = execFileSync } = {}) {
    assert.equal(typeof script, 'string');
    const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const preamble = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);\n";
    return execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(preamble + script, 'utf16le').toString('base64')], {
        windowsHide: true, timeout: POWERSHELL_FIXTURE_TIMEOUT_MS, maxBuffer, encoding: 'utf8'
    });
}

module.exports = { runPowerShellFixture, POWERSHELL_FIXTURE_TIMEOUT_MS };
