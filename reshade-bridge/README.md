# ChartsHub ReShade bridge 0.11.0

This x64 add-on exposes the real techniques and editable uniforms from an
existing **ReShade 6.8.0 installation with full add-on support** to ChartsHub.
It contains no graphics injector, replacement effects, or ReShade runtime DLL.
ReShade compiles and renders the user's existing `.fx` files. ChartsHub controls
them through the official ReShade API 20.

The native filter implementation in `native-filters/` remains separate. The
application's reversible installer must restore the user's original ReShade
runtime before installing this add-on. Do not install it over a running game.

## Build

Run `build.ps1 -Zig <path-to-zig-0.14.1.exe>` on Windows x64. Output:

- `bin/ChartsHubReShade.addon64`
- `bin/ReShade-SDK-LICENSE.md`
- `bin/nlohmann-LICENSE.MIT`

All three files should accompany redistribution. Pinned official SDK headers
and the JSON library are vendored. `vendor/PROVENANCE.json` records their source
URLs and SHA-256 hashes. `fetch-vendor.mjs` can fetch those exact versions again.

## Connection and lifecycle

See [PROTOCOL.md](PROTOCOL.md) for the complete local named-pipe protocol. The
server's DACL allows the current Windows user and rejects remote clients. It
accepts only status/catalog reads, parameter/technique/global state changes,
and saving the already-selected preset. There is no HTTP server, filesystem
browser, preset path input, arbitrary code execution, or shader installation.

Only `Clone Hero.exe` and the isolated `chartshub-reshade-test.exe` may load this
add-on. Initialization uses ReShade's `AddonInit` lifecycle outside loader lock.
The module is pinned for process lifetime so the worker cannot execute unloaded
code. Installation, removal and replacing the binary require a game restart.
Runtime destruction/uninitialization disconnects status, invalidates identifiers
and cancels queued commands. Reinitialization reuses the single existing worker.

All ReShade calls execute on its render event. Pipe I/O and JSON serialization
execute on the worker. Commands are bounded and expire if no game frame is
available. The render event never waits for pipe I/O or a client response.
Enumeration and explicit preset-save work still have a processing cost; this
is not a claim of zero latency.

Identifiers retain only effect/parameter names, never raw runtime pointers or
effect handles. Each mutation resolves its handle again through enumeration in
the same render callback. This also avoids aggregate-return ABI differences
between this GNU-target build and MSVC-built ReShade `find_*` methods. Reloaded
effects invalidate all identifiers. The UI must refresh them after compilation,
including compilation triggered by enabling a previously disabled technique.

Parameters expose scalar/vector bool, signed/unsigned integer, and float values.
System `source` values, `hidden`, `noedit`, unsupported arrays/matrices, and
nonfinite values are read-only. Invalid floating-point values are represented
as read-only zero placeholders so one malformed uniform cannot poison the whole
effect's response. Bounds and step values follow ReShade's own scalar annotation
semantics and are broadcast over vector components. Preprocessor definitions,
technique reordering, textures and shader source editing are outside this API.

Saving calls `save_current_preset()` directly. The API returns no result code;
the reply acknowledges dispatch, while ReShade controls the actual file write.
Only the current preset's basename is returned to ChartsHub.
ReShade 6.8 saves uniform values only for effects with an enabled technique or
an assigned technique hotkey. Editing a disabled effect and saving does not
persist that effect's new parameter values.

## Validation

`test/integration.mjs` copies the user's backed-up ReShade DLL and selected
installed shaders into ignored `test/runtime/`. It starts an independent hidden
D3D11 process, never the game. Local game/backup paths near the top of the script
can be adjusted for another machine. The copied third-party runtime and effects
are test inputs and are not part of the distributed add-on.

The real-runtime checks cover status/identity, actual qUINT Bloom, SweetFX
FilmGrain and ChromaticAberration technique discovery, annotated controls,
float/vector/integer/boolean writes, read-only and bounds rejection, stale IDs
after actual compilation, GPU pixel changes and passthrough, and preset values
persisted through ReShade's API. A stress loop uses the application's actual
`pipeRequest` implementation with one new connection per request.

`test/starter-integration.mjs` downloads the small, pinned starter pack through
the application's real download module and extracts the official add-on runtime
into ignored `test/runtime-starter/`. Put the official
`ReShade_Setup_6.8.0_Addon.exe` alongside this repository, or set
`CHARTSHUB_RESHADE_SETUP` to its path, then run the script with Node. No game
directory is read or changed. It verifies actual compilation, live ArcaneBloom
halo output outside a bright source, intensity changes, disabled passthrough,
control metadata and preset persistence. A separate nested effect confirms
that the starter pack's prefixed headers preserve existing packages' own
`ReShade.fxh` and `ReShadeUI.fxh` resolution.

This validates API integration with the copied ReShade 6.8.0 runtime on the local
GPU. Individual shader quality, compatibility and performance remain properties
of the installed shaders and the game/driver combination. No third-party effect
is enabled automatically.
