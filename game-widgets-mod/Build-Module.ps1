param([Parameter(Mandatory=$true)][string]$LoaderZip)
$ErrorActionPreference='Stop'
function Get-GwBuildSha([string]$File){$s=[IO.File]::OpenRead($File);$a=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($a.ComputeHash($s))).Replace('-','').ToLowerInvariant()}finally{$a.Dispose();$s.Dispose()}}
if((Get-GwBuildSha $LoaderZip) -ne '5b2b2f3d1cd42b59ec886c5bdc2663edae87a0097a4f4a8f58c0965a99dda416'){throw 'Use the exact official MelonLoader 0.7.3 Windows x64 archive.'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$gwVendor=Join-Path $PSScriptRoot 'source/vendor';[IO.Directory]::CreateDirectory($gwVendor)|Out-Null
$gwZip=[IO.Compression.ZipFile]::OpenRead($LoaderZip)
try{
 foreach($gwName in @('MelonLoader.dll','0Harmony.dll','Il2CppInterop.Runtime.dll','Il2CppInterop.Common.dll')){
  $gwEntry=$gwZip.GetEntry('MelonLoader/net6/'+$gwName);if(!$gwEntry){throw 'Development reference is absent from the pinned official archive.'}
  $gwInput=$gwEntry.Open();$gwOutput=[IO.File]::Open((Join-Path $gwVendor $gwName),[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$gwInput.CopyTo($gwOutput)}finally{$gwOutput.Dispose();$gwInput.Dispose()}
 }
}finally{$gwZip.Dispose()}
Push-Location (Join-Path $PSScriptRoot 'source')
try{& dotnet build 'ChartsHub.CloneHero.Telemetry.csproj' -c Release --nologo --ignore-failed-sources;if($LASTEXITCODE -ne 0){throw 'Game widgets module build failed.'}}finally{Pop-Location}
$gwBuilt=Join-Path $PSScriptRoot 'source/bin/Release/net6.0/ChartsHub.CloneHero.Telemetry.dll'
$gwActual=Get-GwBuildSha $gwBuilt
$gwManifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'MODULE.json') -Raw|ConvertFrom-Json
if($gwActual -cne $gwManifest.moduleSha256){throw ('Build differs from the reviewed module; nothing was installed. SHA256: '+$gwActual)}
[pscustomobject]@{result='GAME_WIDGETS_MODULE_REPRODUCED';sha256=$gwActual;output=$gwBuilt;gameAccessed=$false;loaderExecuted=$false}|ConvertTo-Json
