param([string]$Zig = "$PSScriptRoot\..\..\toolchain\zig-x86_64-windows-0.14.1\zig.exe")
$ErrorActionPreference='Stop'
$env:ZIG_GLOBAL_CACHE_DIR="$PSScriptRoot\..\..\toolchain\zig-cache"
$env:ZIG_LOCAL_CACHE_DIR="$PSScriptRoot\.zig-cache"
Push-Location $PSScriptRoot
try {
  New-Item -ItemType Directory -Force -Path bin | Out-Null
  & $Zig c++ -target x86_64-windows-gnu -std=c++17 -O2 -shared -static -fno-rtti -Wno-unknown-attributes -Ivendor/reshade -Ivendor src/addon.cpp -o bin/ChartsHubReShade.addon64 -ladvapi32 -luser32
  if($LASTEXITCODE){throw 'ReShade addon compilation failed'}
  & $Zig c++ -target x86_64-windows-gnu -std=c++17 -O2 -static -fno-rtti test/harness.cpp -o bin/chartshub-reshade-test.exe -ld3d11 -ldxgi -luser32 -luuid
  if($LASTEXITCODE){throw 'ReShade harness compilation failed'}
  Copy-Item -LiteralPath vendor/reshade/LICENSE.md -Destination bin/ReShade-SDK-LICENSE.md -Force
  Copy-Item -LiteralPath vendor/nlohmann/LICENSE.MIT -Destination bin/nlohmann-LICENSE.MIT -Force
  Get-FileHash -LiteralPath bin/ChartsHubReShade.addon64 -Algorithm SHA256
} finally {Pop-Location}
