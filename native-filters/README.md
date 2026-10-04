# ChartsHub native filters (protocol 1)

An independent Windows x64 Direct3D 11 postprocessing engine for Clone Hero. It
uses its own HLSL and DXGI proxy; **ReShade is neither required nor loaded**.
The manager must back up an existing `dxgi.dll` before installing this DLL and
restore it on uninstall. Install/uninstall only while Clone Hero is closed.

## Build and validation

Run `build.ps1 -Zig <path-to-zig-0.14.1.exe>`, then run
`bin/chartshub-filter-test.exe` from its own directory. All dependencies other
than Zig are committed, including MinHook v1.3.4 source and its license.
`fetch-vendor.mjs` is an optional reproducibility helper for the exact upstream
tag. `generate-forwarders.mjs` regenerates forwarding names and stubs from the
installed Windows System32 DXGI export table. It copies no Microsoft machine
code. Generated forwarders are committed and do not need regeneration to build.

The test program uses its own hidden window and ordinary Direct3D imports. It
checks actual GPU readback, each filter control, passthrough, live atomic config
replacement without INI cache flush, Present/Present1, TEST flags, resize,
HDR bypass and recovery, full viewport/topology restoration and OM UAV binding.
It never opens, injects into, or modifies the running game.

## On-disk protocol

The manager writes `ChartsHubFilters.ini` next to `dxgi.dll`, using atomic file
replacement. The engine checks this file every 200 ms on a separate thread;
there is no file access on the render thread. Missing/invalid values use defaults
and finite out-of-range values clamp to the ranges below.

```ini
[Filters]
enabled=0
saturation=1
contrast=1
gamma=1
exposure=0
sharpness=0
vignette=0
```

| Key | Range | Default |
| --- | --- | --- |
| enabled | 0, 1 | 0 |
| saturation | 0–2 | 1 |
| contrast | 0.5–2 | 1 |
| gamma | 0.5–2.5 | 1 |
| exposure | -2–2 stops | 0 |
| sharpness | 0–1 | 0 |
| vignette | 0–1 | 0 |

Every approximately one second the worker writes `ChartsHubFilters.status.ini`:

```ini
[Status]
protocol=1
pid=1234
ready=1
enabled=1
frames=42
error=
```

`enabled` describes the currently read setting. `ready` becomes 1 only after
a draw completes without device removal, and is cleared on a rendering failure.
`frames` counts successful filter passes, not game frames. Startup with disabled
filters is normal and reports `ready=0`, `frames=0`, `error=`. `error` contains
only fixed diagnostic identifiers, never shader/compiler text or arbitrary data.
The consumer should check protocol, current process ID and recent modification
time; a status file remains on disk when the process exits.

## Deliberate limits

- Only `Clone Hero.exe` and `chartshub-filter-test.exe` start filtering; other
  programs receive ordinary System32 DXGI forwarding.
- Requires Windows Direct3D 11.1 context state support and `d3dcompiler_47.dll`.
- Supports single-sample `R8G8B8A8_UNORM` / `B8G8R8A8_UNORM` SDR swapchains.
  HDR, sRGB-tagged buffers, MSAA and other APIs/formats are bypassed.
- Effects apply to the full rendered frame, including the game interface.
  This is not a ReShade `.fx` or preset interpreter.
- TEST and DO_NOT_WAIT presents are bypassed. No depth access, bloom, overlay
  UI, screenshot capture, shader packs, or HDR conversion is included.
- GPU state is isolated with `SwapDeviceContextState`. Active asynchronous
  performance/occlusion queries may include the additional draw, as documented
  by Microsoft for context state swapping.
- No original backbuffer reference survives a filter pass. Resources are owned
  by each swapchain using DXGI private data and released when it is destroyed.
- Hooking happens on a worker after loader initialization. The module is pinned
  for the process lifetime; restart the game after installation or removal.
- GPU tests do not prove compatibility with every game/driver/overlay. This
  prototype still needs an in-game visual/performance check on Clone Hero 1.1.
  Fullscreen transitions and device removal have conservative handling but are
  not simulated by the current hardware test.

## Sources and license

MinHook v1.3.4: <https://github.com/TsudaKageyu/minhook/tree/v1.3.4>.
Its BSD license (including HDE notices) is in `vendor/minhook/LICENSE.txt` and
must accompany redistributed native binaries.

State isolation follows Microsoft's
[CreateDeviceContextState](https://learn.microsoft.com/en-us/windows/win32/api/d3d11_1/nf-d3d11_1-id3d11device1-createdevicecontextstate)
and
[SwapDeviceContextState](https://learn.microsoft.com/en-us/windows/win32/api/d3d11_1/nf-d3d11_1-id3d11devicecontext1-swapdevicecontextstate)
contracts.
