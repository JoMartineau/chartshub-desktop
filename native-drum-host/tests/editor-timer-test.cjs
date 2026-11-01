'use strict';
// Real native message loop + owned synthetic VST3 GUI; no audio/input commands.
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), { createHash, randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..'), executable = path.join(root, 'bin/ChartsHubDrumHost.exe');
const plugin = path.join(root, 'build/VST3/ChartsHubDrumTest.vst3');
const expectBlocked = process.argv.includes('--expect-blocked');
const outputArg = process.argv.find(value => value.startsWith('--output='));
const output = outputArg ? path.resolve(outputArg.slice('--output='.length)) : path.join(root, 'out');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  assert.notEqual(output, path.parse(output).root); await fs.mkdir(output, { recursive: true });
  const guiStateFile = path.join(output, 'timer-state-' + randomUUID() + '.json');
  const child = spawn(executable, ['--json'], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CHARTSHUB_SYNTHETIC_EDITOR_REPORT: guiStateFile } });
  const calls = [], pending = new Map(); let nextId = 0, buffer = '', stderr = '';
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => {
    for (const waiter of pending.values()) waiter.reject(Error('The owned native fixture closed before replying'));
    pending.clear(); resolve(code);
  }); });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
    buffer += chunk; assert(buffer.length < 65536);
    for (;;) { const at = buffer.indexOf('\n'); if (at < 0) break;
      const value = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      if (value.id && pending.has(value.id)) { const waiter = pending.get(value.id); pending.delete(value.id); waiter.resolve(value); }
    }
  });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value; assert(stderr.length < 65536); });
  const deadline = setTimeout(() => child.kill(), 10000);
  function send(command, payload = {}) {
    assert(['load', 'editor', 'stop', 'quit'].includes(command), 'Audio, MIDI and hardware commands are forbidden');
    calls.push(command); const id = ++nextId;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ schema: 1, id, command, payload }) + '\n'); });
  }
  let report;
  try {
    const discovery = await send('load', { path: plugin }); assert.equal(discovery.ok, true);
    const selected = discovery.result.classes.find(item => item.name === 'ChartsHub Editor Timers'); assert(selected);
    const loaded = await send('load', { path: plugin, classId: selected.id }); assert.equal(loaded.ok, true); assert.equal(loaded.result.hasEditor, true);
    assert.equal((await send('editor', { open: true })).ok, true);
    let state;
    const until = Date.now() + 1500;
    do {
      await wait(40); try { state = JSON.parse(await fs.readFile(guiStateFile, 'utf8')); } catch {}
      if (state?.windowTicks >= 3 && state?.threadTicks >= 3 && state?.padClicks === 1 && !state.padPressed) break;
    } while (Date.now() < until);
    assert(state && state.padClicks === 1, 'The synthetic editor did not handle its posted pad click');
    const checks = ['timer_editor_attaches_without_audio_or_device_commands'];
    if (expectBlocked) {
      assert.equal(state.windowTicks, 0); assert.equal(state.threadTicks, 0); assert.equal(state.settingsRefreshes, 0); assert.equal(state.padPressed, true);
    } else {
      assert(state.windowTicks >= 3, 'Plugin HWND timers were swallowed'); checks.push('window_timer_reaches_plugin_when_requested_id_matches_host');
      assert(state.threadTicks >= 3, 'Unrelated thread TimerProc callback was swallowed'); checks.push('unrelated_thread_timer_callback_is_dispatched');
      assert(state.settingsRefreshes >= 3 && !state.padPressed); checks.push('mouse_pad_releases_and_settings_refresh_without_audio');
    }
    assert.equal((await send('editor', { open: false })).ok, true);
    assert.equal((await send('stop')).ok, true); assert.equal((await send('quit')).ok, true);
    child.stdin.end(); assert.equal(await exited, 0); assert.equal(stderr, '');
    report = { schema: 1, ok: !expectBlocked, result: expectBlocked ? 'REPRODUCED_SWALLOWED_PLUGIN_TIMERS' : 'PASS_NATIVE_EDITOR_TIMER_DISPATCH',
      checks, state, calls, helperSha256: createHash('sha256').update(await fs.readFile(executable)).digest('hex'),
      actualNativeMessageLoop: true, syntheticEditorOnly: true, audioDeviceOpened: false, midiDeviceOpened: false,
      xinputStateRead: false, gameRead: false, profileRead: false, realInstrumentLoaded: false };
    await fs.writeFile(path.join(output, expectBlocked ? 'editor-timer-before.json' : 'editor-timer-test.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } finally {
    clearTimeout(deadline); child.stdin.end(); child.kill();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
