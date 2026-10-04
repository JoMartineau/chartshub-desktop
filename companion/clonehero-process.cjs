'use strict';
const { execFile: nativeExecFile } = require('node:child_process');
const path = require('node:path');

const CACHE_MS = 2000, MAX_BUFFER = 32 * 1024;
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $probeErrors = @()
  $processes = @(Get-Process -Name 'Clone Hero','CloneHero' -ErrorAction SilentlyContinue -ErrorVariable probeErrors)
  if (@($probeErrors | Where-Object { $_.CategoryInfo.Category -ne 'ObjectNotFound' }).Count -gt 0) {
    throw 'Process lookup unavailable'
  }
  if ($processes.Count -eq 0) {
    '{"running":false,"sessions":[]}'
    return
  }
  $sessions = @(foreach ($entry in $processes) {
    $started = $entry.StartTime
    if ($started -isnot [DateTime]) { throw 'Start time unavailable' }
    [PSCustomObject]@{
      pid = $entry.Id
      startedAtMs = ([DateTimeOffset]($started.ToUniversalTime())).ToUnixTimeMilliseconds()
    }
  })
  ConvertTo-Json -Compress -Depth 3 -InputObject @{ running = $true; sessions = $sessions }
} catch {
  '{"running":null,"sessions":[]}'
}
`;
const unknown = () => ({ running: null, sessions: [] });
const copy = value => ({ running: value.running, sessions: value.sessions.map(session => ({ ...session })) });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function parse(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > MAX_BUFFER) return unknown();
  let value;
  try { value = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()); } catch { return unknown(); }
  if (!object(value) || Object.keys(value).some(key => !['running', 'sessions'].includes(key)) || !Array.isArray(value.sessions) || value.sessions.length > 128) return unknown();
  if (value.running === false && value.sessions.length === 0) return { running: false, sessions: [] };
  if (value.running !== true || value.sessions.length === 0) return unknown();
  const sessions = [], pids = new Set();
  for (const session of value.sessions) {
    if (!object(session) || Object.keys(session).some(key => !['pid', 'startedAtMs'].includes(key)) || !Number.isSafeInteger(session.pid) || session.pid <= 0 || session.pid > 4294967295 || pids.has(session.pid) || !Number.isSafeInteger(session.startedAtMs) || session.startedAtMs <= 0) return unknown();
    pids.add(session.pid); sessions.push({ pid: session.pid, startedAtMs: session.startedAtMs });
  }
  return { running: true, sessions };
}

/** Process presence only; no memory, window-state, tasklist or CIM access. */
function createCloneHeroProcessProbe({ platform = process.platform, execFile = nativeExecFile, now = Date.now } = {}) {
  const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let cached = null, cachedAt = 0, pending = null;
  async function run() {
    return new Promise(resolve => {
      try {
        execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
          windowsHide: true, timeout: 2500, maxBuffer: MAX_BUFFER, encoding: 'utf8'
        }, (error, stdout) => resolve(error ? unknown() : parse(stdout)));
      } catch { resolve(unknown()); }
    });
  }
  return async function probe() {
    if (platform !== 'win32') return unknown();
    const age = now() - cachedAt;
    if (cached && age >= 0 && age < CACHE_MS) return copy(cached);
    if (!pending) {
      pending = run().then(value => { cached = value; cachedAt = now(); return value; });
      const current = pending;
      void current.finally(() => { if (pending === current) pending = null; });
    }
    return copy(await pending);
  };
}

module.exports = { createCloneHeroProcessProbe };
