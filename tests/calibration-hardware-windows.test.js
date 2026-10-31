'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const filename = path.join(__dirname, '../companion/calibration-hardware-windows.ps1');
const source = fs.readFileSync(filename, 'utf8');
const embedded = /Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/.exec(source)?.[1];

test('Windows metadata helper contains no stream, recording or settings-write calls', () => {
    assert.ok(embedded, 'the fixed helper includes its COM interface definitions');
    const calls = [...embedded.matchAll(/\b(?:client|device|store|enumerator)\.([A-Za-z]+)\s*\(/g)].map(match => match[1]);
    assert.deepEqual(calls, ['GetDefaultAudioEndpoint', 'OpenPropertyStore', 'GetValue', 'Activate', 'GetMixFormat', 'GetDevicePeriod']);
    assert.doesNotMatch(embedded, /\.\s*(?:Initialize|Start|Stop|GetStreamLatency|SetValue|Commit)\s*\(/);
    assert.doesNotMatch(source, /(?:Get-Credential|Get-Content|Set-Content|Out-File|Invoke-Expression|Invoke-WebRequest|Start-Process|Add-Content)\b/i);
    assert.doesNotMatch(source, /\$(?:args|input)\b/);
    assert.match(source, /GetDefaultAudioEndpoint\(0, 0, out device\)/);
    assert.match(source, /PNPClass = 'Keyboard'/);
    assert.match(source, /-Property Name, PNPClass -OperationTimeoutSec 3/);
    assert.match(source, /\$inputs\.Count -ge 16/);
    assert.match(source, /\$safe\.Substring\(0, 120\)/);
    assert.match(source, /name = \$name; kind = 'candidate'/);
    assert.match(source, /defaultPeriod \/ 10000\.0/);
    assert.match(source, /minimumPeriod \/ 10000\.0/);
});

test('PowerShell parses and C# compiles without invoking hardware discovery, and labels are bounded', { skip: process.platform !== 'win32' }, () => {
    const encodedPath = Buffer.from(filename, 'utf8').toString('base64');
    const script = `
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')))
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'Helper PowerShell parsing failed' }
$match = [regex]::Match($source, "(?s)Add-Type -TypeDefinition @'\\r?\\n(.*?)\\r?\\n'@")
if (-not $match.Success) { throw 'Embedded C# not found' }
Add-Type -TypeDefinition $match.Groups[1].Value -ErrorAction Stop
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-SafeFriendlyName' }, $true)
if ($null -eq $function) { throw 'Label sanitizer not found' }
. ([scriptblock]::Create($function.Extent.Text))
# Only compile the class and run the pure label sanitizer. Never execute the helper or OutputProbe.Read.
$labels = @(
    (Get-SafeFriendlyName 'Haut-parleurs (Realtek(R) Audio)'),
    (Get-SafeFriendlyName ([string]::Concat('Speaker', [char]0, [char]10, 'name'))),
    (Get-SafeFriendlyName ('x' * 200)),
    (Get-SafeFriendlyName 'Controller USB\\VID_1234&PID_5678\\SECRET123456'),
    (Get-SafeFriendlyName 'Controller serial: ABC123'),
    (Get-SafeFriendlyName 'Controller {00000000-0000-0000-0000-000000000000}'),
    (Get-SafeFriendlyName 'Controller AABBCCDDEEFF0011'),
    (Get-SafeFriendlyName '   ')
)
$empty = New-Object ChartsHub.ReadOnlyCalibration.AudioMetadata
[ordered]@{ labels = $labels; empty = $empty } | ConvertTo-Json -Depth 4 -Compress
`;
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024, encoding: 'utf8'
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
    assert.deepEqual(parsed.labels, ['Haut-parleurs (Realtek(R) Audio)', 'Speaker name', 'x'.repeat(120), 'Controller', 'Controller', 'Controller', 'Controller', null]);
    assert.deepEqual(parsed.empty, {
        outputName: null, sampleRateHz: null, channels: null,
        defaultPeriodMs: null, minimumPeriodMs: null, status: 'unavailable'
    });
});
