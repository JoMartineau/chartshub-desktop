'use strict';
// Real service and native helper, synthetic VST3 instrument. No devices or Start.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { spawn } = require('node:child_process'), { createHash } = require('node:crypto');
const { createDrumVstService } = require('../companion/drum-vst-service.cjs');
async function main() {
  assert.equal(process.platform, 'win32');
  const root = path.resolve(__dirname, '..'), helper = path.join(root, 'native-drum-host/bin/ChartsHubDrumHost.exe');
  const plugin = path.join(root, 'native-drum-host/build/VST3/ChartsHubDrumTest.vst3');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-real-vst-bridge-'));
  const commands = []; let launches = 0, service;
  try {
    service = await createDrumVstService({ dataDirectory: directory, helperPath: helper, choosePlugin: async () => plugin,
      spawnImpl(file, args, options) {
        launches++; assert.equal(file, helper); assert.deepEqual(args, ['--json']); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
        const child = spawn(file, args, options), write = child.stdin.write.bind(child.stdin);
        child.stdin.write = (line, callback) => { const value = JSON.parse(line); assert(['load', 'stop', 'quit'].includes(value.command), 'Hardware/audio commands forbidden'); commands.push(value.command); return write(line, callback); };
        return child;
      }
    });
    for (let i = 0; i < 20; i++) service.status();
    assert.equal(launches, 0); assert.deepEqual(await fs.readdir(directory), []);
    await service.command('drums.choosePlugin', {});
    assert.equal(service.status().plugin.name, 'ChartsHub Offline Test'); assert.equal(service.status().plugin.loaded, true); assert.equal(service.status().phase, 'loaded'); assert.equal(service.status().audio, null);
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'drum-vst-settings.json'))); assert.equal(saved.pluginPath, plugin);
    await service.command('drums.stop', {}); await service.dispose(); service = null;
    assert.deepEqual(commands, ['load', 'stop', 'quit']);
    const report = { schema: 1, ok: true, actualServiceAndNativeHelper: true, helperSha256: createHash('sha256').update(await fs.readFile(helper)).digest('hex'), checks: ['no_automatic_helper_or_device_access', 'real_vst3_load_metadata_and_durable_selection', 'stop_and_quit_without_audio_or_input'], commands,
      audioDeviceOpened: false, midiDeviceOpened: false, xinputStateRead: false, gameRead: false, profileRead: false, realInstrumentLoaded: false };
    const output = path.join(root, 'native-drum-host/out'); await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'service-bridge.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
  } finally { await service?.dispose(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert(path.basename(directory).startsWith('chartshub-real-vst-bridge-')); await fs.rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
