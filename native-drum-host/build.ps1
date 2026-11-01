param([switch]$NoTestPlugin)
$ErrorActionPreference='Stop'
$nativeRoot=$PSScriptRoot
$cmake=Join-Path $nativeRoot 'tools/cmake-4.1.2-windows-x86_64/bin/cmake.exe'
$vsCandidates=@('C:\Program Files\Microsoft Visual Studio\18\Community','C:\Program Files\Microsoft Visual Studio\18\Enterprise','C:\Program Files\Microsoft Visual Studio\2022\Enterprise','C:\Program Files\Microsoft Visual Studio\2022\Professional','C:\Program Files\Microsoft Visual Studio\2022\Community','C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools')
$vcvars=$vsCandidates | ForEach-Object {Join-Path $_ 'VC\Auxiliary\Build\vcvars64.bat'} | Where-Object {Test-Path -LiteralPath $_} | Select-Object -First 1
if(-not(Test-Path -LiteralPath $cmake)-or -not $vcvars){throw 'Fetch reviewed dependencies and provide Visual Studio C++ build tools first.'}
$pins=Get-Content -LiteralPath (Join-Path $nativeRoot 'dependencies.json') -Raw | ConvertFrom-Json
$stream=[IO.File]::OpenRead($cmake);$sha=[Security.Cryptography.SHA256]::Create()
try{$actualCMake=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose();$stream.Dispose()}
if($actualCMake -ne $pins.cmake.executableSha256){throw 'CMake executable differs from the reviewed portable archive'}
$buildRoot=Join-Path $nativeRoot 'build'
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
$testPlugin=if($NoTestPlugin){'OFF'}else{'ON'}
$lines=@('@echo off',('call "{0}"' -f $vcvars),'if errorlevel 1 exit /b %errorlevel%',('"{0}" -S "{1}" -B "{2}" -G "NMake Makefiles" -DCMAKE_BUILD_TYPE=Release -DCHARTSHUB_DRUM_TEST_PLUGIN={3}' -f $cmake,$nativeRoot,$buildRoot,$testPlugin),'if errorlevel 1 exit /b %errorlevel%',('"{0}" --build "{1}" --config Release' -f $cmake,$buildRoot),'exit /b %errorlevel%')
$batch=Join-Path $buildRoot 'build-local.cmd'
[IO.File]::WriteAllText($batch,($lines -join "`r`n"),[Text.Encoding]::ASCII)
& $env:ComSpec /d /c $batch
if($LASTEXITCODE -ne 0){throw "Native drum host build failed ($LASTEXITCODE)"}
