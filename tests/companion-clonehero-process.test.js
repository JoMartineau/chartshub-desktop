const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createCloneHeroProcessProbe } = require('../companion/clonehero-process.cjs');

const startedAtMs = Date.parse('2026-10-04T08:29:00.000Z');
const active = { running: true, sessions: [{ pid: 3252, startedAtMs }] };
function fixture(stdout = JSON.stringify(active), error = null) {
  const calls = [];
  const execFile = (file, args, options, done) => { calls.push({ file, args, options }); done(error, stdout, ''); };
  return { calls, probe: createCloneHeroProcessProbe({ platform: 'win32', execFile }) };
}

test('Clone Hero process probe uses only fixed Get-Process names and emits UTC millisecond session times', async () => {
  const f = fixture(); assert.deepEqual(await f.probe(), active);
  assert.equal(f.calls.length, 1); const call = f.calls[0];
  assert.equal(call.file, path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  assert.deepEqual(call.args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
  assert.match(call.args.at(-1), /Get-Process -Name 'Clone Hero','CloneHero'/);
  assert.match(call.args.at(-1), /ToUniversalTime\(\)/); assert.match(call.args.at(-1), /ToUnixTimeMilliseconds\(\)/);
  assert.doesNotMatch(call.args.at(-1), /tasklist|Get-CimInstance|Get-WmiObject|ReadProcessMemory/i);
  assert.deepEqual(call.options, { windowsHide: true, timeout: 2500, maxBuffer: 32768, encoding: 'utf8' });
  assert.equal(new Date((await f.probe()).sessions[0].startedAtMs).toISOString(), '2026-10-04T08:29:00.000Z');
});

test('Clone Hero process probe distinguishes an absent process from missing or unreadable start times', async () => {
  assert.deepEqual(await fixture('{"running":false,"sessions":[]}').probe(), { running: false, sessions: [] });
  for (const value of [{ running: null, sessions: [] }, { running: true, sessions: [] }, { running: true, sessions: [{ pid: 3252 }] },
    { running: true, sessions: [{ pid: 3252, startedAtMs: null }] }, { running: true, sessions: [{ pid: 3252, startedAtMs: '2026-10-04T08:29:00Z' }] }]) {
    assert.deepEqual(await fixture(JSON.stringify(value)).probe(), { running: null, sessions: [] });
  }
});

test('Clone Hero process probe rejects malformed, ambiguous and oversized responses without exposing command output', async () => {
  for (const value of ['private command error', '', 'null', '[]', JSON.stringify({ ...active, commandLine: 'private' }),
    JSON.stringify({ running: false, sessions: active.sessions }), JSON.stringify({ running: true, sessions: [active.sessions[0], active.sessions[0]] }),
    JSON.stringify({ running: true, sessions: [{ pid: -1, startedAtMs }] }), JSON.stringify({ running: true, sessions: [{ pid: 1, startedAtMs: NaN }] }),
    JSON.stringify({ running: true, sessions: [{ pid: 1, startedAtMs, executablePath: 'private' }] }), ' '.repeat(32769)]) {
    assert.deepEqual(await fixture(value).probe(), { running: null, sessions: [] });
  }
  assert.deepEqual(await fixture('\ufeff' + JSON.stringify(active) + '\r\n').probe(), active);
});

test('Clone Hero process probe handles timeout, denied access and spawn failures as unknown', async () => {
  for (const code of ['ETIMEDOUT', 'EACCES', 'ENOENT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']) {
    const error = Object.assign(Error('private error text'), { code });
    assert.deepEqual(await fixture(JSON.stringify(active), error).probe(), { running: null, sessions: [] });
  }
  const probe = createCloneHeroProcessProbe({ platform: 'win32', execFile() { throw Error('private spawn error'); } });
  assert.deepEqual(await probe(), { running: null, sessions: [] });
});

test('Clone Hero process probe coalesces concurrent requests and caches isolated results for two seconds', async () => {
  let now = 100, calls = 0, complete;
  const probe = createCloneHeroProcessProbe({ platform: 'win32', now: () => now, execFile(_file, _args, _options, callback) { calls++; complete = callback; } });
  const first = probe(), second = probe(); assert.equal(calls, 1);
  complete(null, JSON.stringify(active)); const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, active); assert.deepEqual(b, active);
  a.sessions[0].pid = 999; a.sessions.push({ pid: 1, startedAtMs: 1 }); assert.deepEqual(b, active);
  now = 2099; assert.deepEqual(await probe(), active); assert.equal(calls, 1);
  now = 2100; const refreshed = probe(); assert.equal(calls, 2);
  complete(null, '{"running":false,"sessions":[]}'); assert.deepEqual(await refreshed, { running: false, sessions: [] });
});

test('Clone Hero process probe never launches PowerShell on other platforms and retries cached unknown results after expiry', async () => {
  for (const platform of ['darwin', 'linux', 'freebsd']) {
    const probe = createCloneHeroProcessProbe({ platform, execFile() { throw Error('Must never be invoked'); } });
    assert.deepEqual(await probe(), { running: null, sessions: [] });
  }
  let now = 0, calls = 0;
  const probe = createCloneHeroProcessProbe({ platform: 'win32', now: () => now, execFile(_file, _args, _options, callback) {
    calls++; callback(calls === 1 ? Error('timeout') : null, JSON.stringify(active));
  } });
  assert.deepEqual(await probe(), { running: null, sessions: [] });
  now = 1500; assert.deepEqual(await probe(), { running: null, sessions: [] }); assert.equal(calls, 1);
  now = 2000; assert.deepEqual(await probe(), active); assert.equal(calls, 2);
});
