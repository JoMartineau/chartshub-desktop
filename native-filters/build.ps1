param([string]$Zig = "$PSScriptRoot\..\..\toolchain\zig-x86_64-windows-0.14.1\zig.exe")
$ErrorActionPreference = 'Stop'
$env:ZIG_GLOBAL_CACHE_DIR = "$PSScriptRoot\..\..\toolchain\zig-cache"
$env:ZIG_LOCAL_CACHE_DIR = "$PSScriptRoot\.zig-cache"
if (!(Test-Path -LiteralPath $Zig)) { throw "Zig 0.14.1 required: $Zig" }
Push-Location $PSScriptRoot
try {
    New-Item -ItemType Directory -Force -Path bin | Out-Null
    foreach ($source in @('buffer', 'hook', 'trampoline', 'hde/hde64')) {
        $object = [IO.Path]::GetFileName($source) + '.o'
        & $Zig cc -target x86_64-windows-gnu -O2 -c "vendor/minhook/src/$source.c" -Ivendor/minhook/include -o $object
        if ($LASTEXITCODE) { throw 'MinHook compilation failed' }
    }
    & $Zig c++ -target x86_64-windows-gnu -std=c++17 -O2 -shared -static -fno-exceptions -fno-rtti src/filters.cpp src/forwarders.S src/dxgi.def buffer.o hook.o trampoline.o hde64.o -Ivendor/minhook/include -Isrc -o bin/dxgi.dll -luser32 -luuid
    if ($LASTEXITCODE) { throw 'Filter DLL compilation failed' }
    & $Zig c++ -target x86_64-windows-gnu -std=c++17 -O2 -static -fno-exceptions -fno-rtti src/test.cpp -o bin/chartshub-filter-test.exe -ld3d11 -ldxgi -luser32 -luuid
    if ($LASTEXITCODE) { throw 'Filter tests compilation failed' }
    Copy-Item -LiteralPath 'vendor/minhook/LICENSE.txt' -Destination 'bin/MinHook-LICENSE.txt' -Force
    Get-FileHash -LiteralPath bin/dxgi.dll -Algorithm SHA256
} finally { Pop-Location }
