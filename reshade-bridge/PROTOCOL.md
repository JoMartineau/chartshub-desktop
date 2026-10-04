# ChartsHub ReShade bridge 0.11.0 — protocol 1

Local Windows named pipe `\\.\pipe\ChartsHub-ReShade-<PID>`. Current Windows
user only; remote pipe clients rejected. UTF-8 JSON lines. One request in flight
per connection; maximum request 64 KiB and response 4 MiB. Client timeout should
be at least 4 seconds. The server expires queued operations after 2 seconds if
the game does not present a frame. All ReShade API operations run on its render
event; the pipe worker never touches effect handles.

Every request has integer `id` and string `action`. Replies are
`{id,ok:true,data:{...}}` or `{id,ok:false,error:{code,message}}`.

| Action | Additional request fields | Data |
| --- | --- | --- |
| `status` | none | Common status |
| `catalog` | none | Common status plus `techniques` |
| `uniforms` | `effect` string from catalog | Common status plus `effect`, `uniforms` |
| `setTechnique` | `techniqueId` string, `enabled` boolean | Common status |
| `setUniform` | `uniformId` string, `value` number/boolean array | Common status |
| `setEnabled` | `enabled` boolean | Common status |
| `savePreset` | none | Common status |

Common status: `{protocol:1,addonVersion:"0.11.0",pid,generation,runtimeReady,
effectsEnabled,presetName,executablePath}`. Only the basename of the active preset
is returned. No request can provide a file path or choose a different preset.

Technique: `{id,name,label,effect,enabled}`. The effect identifies the ReShade
effect file. Names alone need not be unique. Technique IDs are opaque.

Uniform: `{id,name,label,effect,type,components,rows,columns,arrayLength,value,
uiType,min,max,step,items,tooltip,readOnly}`. Type is `float`, `int`, `uint` or
`bool`; current values are arrays. `min`, `max`, `step` are numeric arrays or null.
`items` holds labels from ReShade `ui_items`. `readOnly` is true for system-driven
values and unsupported shapes. Labels and annotations are untrusted display
text, not HTML. The server validates finite values, shapes, types and annotated
bounds before changing values. Current values outside bounds remain readable.

IDs are invalidated when effects reload or their runtime is destroyed. On
`stale_id`, refresh catalog and selected uniforms before trying again. State
changed externally by ReShade is reflected by subsequent catalog/uniform reads.

`savePreset` invokes the official `save_current_preset` method for the already
selected runtime preset. It never changes its path. ReShade controls the write;
the API does not report an HRESULT, so successful dispatch does not guarantee
that the filesystem accepted the save.
