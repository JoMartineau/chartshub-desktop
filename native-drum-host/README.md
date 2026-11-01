# Native drum instrument host — Windows x64

This helper runs a user-selected **64-bit VST3 instrument** in a separate process. The Electron interface sends control messages only: PCM audio and MIDI rendering remain native. It does not modify Clone Hero, use MelonLoader, install a plugin, install a driver or alter the default Windows audio device.

`devices` enumerates metadata/capabilities only. `load` initializes a VST3 module without opening audio or MIDI. Only an explicit `start` opens the selected output and the selected MIDI/controller source. Incoming MIDI note velocity is preserved. Manual/controller hits use each pad's configured velocity and a 100 ms note-off. XInput buttons use browser-standard indices; axes use a directional threshold with hysteresis. No keyboard hooks or input injection are used.

The output uses **WASAPI shared mode**, preferring IAudioClient3's supported engine period and falling back to the existing shared mix format when necessary. The response reports the actual rate/period and driver/plugin-reported latency; this is not a physical latency measurement. Exclusive audio, ASIO, VST2, 32-bit bridging, MIDI CC hi-hat remapping and plugin preset persistence are outside this first implementation.

## Build

Run `fetch-dependencies.ps1`, then `build.ps1` from a Windows host with Visual Studio C++ x64 tools installed. Sources and tools are pinned in `dependencies.json`; their downloaded directories are ignored. CMake 4.1.2 is portable and stays inside this directory. The host uses a static C runtime, Windows system audio/MIDI libraries and the MIT VST3 SDK. No global installation step is performed. The shipping helper is `bin/ChartsHubDrumHost.exe`.

The optional synthetic instrument under `build/VST3/ChartsHubDrumTest.vst3` is **test-only and must not ship**. It is never linked or copied to a system VST folder.

## Offline verification

Run `bin/ChartsHubDrumHost.exe --self-test "<absolute build/VST3/ChartsHubDrumTest.vst3>"`, followed by `node tests/protocol-test.cjs`. These tests load the actual VST3 test module and render into memory. They do not call device discovery, open audio/MIDI, poll XInput, launch the game or read user profiles. Tests verify velocity, note-off, panic, repeated processing/lifecycle, bounded protocol, stopped note rejection and EOF shutdown.

## JSON-lines protocol

Launch the fixed helper with `--json`, hidden and without a shell. Requests are `{schema:1,id,command,payload}`; successful replies are `{schema:1,id,ok:true,result}`, failures are `{schema:1,id,ok:false,error}`. Input lines are capped at 32768 bytes, nesting at16 levels, and the pending command queue at64. Stop/disconnect/EOF release held notes. Status and 10 Hz peak events carry no PCM or device paths.

Commands: `devices {}`, `load {path,classId?}`, `start {version:1,audioDeviceId,midiDeviceId,source,xinputIndex,sampleRate,blockSize,volume,pads}`, `note {padId,velocity}`, `panic {}`, `stop {}`, `editor {open}`, `quit {}`. Supported rates are44100/48000/96000, requested periods64/128/256/512; the shared Windows device may negotiate different effective values. Pads have `{id,note,channel,velocity,binding:{kind,index,direction}}`. MIDI channels are zero-based0–15. Device IDs are opaque local hashes.

The optional plugin editor is a native HWND window. UI parameter changes are queued to the processor; output parameter feedback returns to the controller on the UI thread. Dynamic bus/reload requests stop processing and require a user restart.

For OBS, capture the audio of the **ChartsHubDrumHost** process/window, or the selected output device. Capturing only the Electron process may omit this separate helper. No virtual cable is installed automatically.

## Third-party notices and limits

Steinberg VST3 SDK3.8.1 and nlohmann JSON3.12.0 are MIT licensed; their full licenses are in `licenses/`. VST is a trademark of Steinberg Media Technologies GmbH. The SDK's stock JACK AudioHost is not used; WASAPI and WinMM integration here is ChartsHub code.

MT Power Drum Kit is a separate instrument from MANDA AUDIO. This host does not bundle or modify it. Official Windows downloads include a `.vst3` instrument and companion `.pdk` content file that must stay together. Its own EULA applies: https://www.powerdrumkit.com/EULA.php?lang=en and official download: https://www.powerdrumkit.com/download76187.php . Free distribution of the software is expressly permitted by that EULA, while resale is not; this is not permission to repackage its isolated samples or claim authorship.

Real device audio, plugin GUI and OBS capture still require an explicit user listening test. The offline tests do not establish an end-to-end latency claim or compatibility with every VST3 instrument.
