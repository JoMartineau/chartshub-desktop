param([Parameter(Mandatory=$true)][string]$LoaderZip)
$ErrorActionPreference='Stop'
function Get-QiBuildSha([string]$File){$s=[IO.File]::OpenRead($File);$a=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($a.ComputeHash($s))).Replace('-','').ToLowerInvariant()}finally{$a.Dispose();$s.Dispose()}}
if((Get-QiBuildSha $LoaderZip) -ne '5b2b2f3d1cd42b59ec886c5bdc2663edae87a0097a4f4a8f58c0965a99dda416'){throw 'Use the exact official MelonLoader 0.7.3 Windows x64 archive.'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$qiVendor=Join-Path $PSScriptRoot 'source/vendor';[IO.Directory]::CreateDirectory($qiVendor)|Out-Null
$qiZip=[IO.Compression.ZipFile]::OpenRead($LoaderZip)
try{
 foreach($qiName in @('MelonLoader.dll','0Harmony.dll','Il2CppInterop.Runtime.dll')){
  $qiEntry=$qiZip.GetEntry('MelonLoader/net6/'+$qiName);if(!$qiEntry){throw 'Development reference is absent from the pinned official archive.'}
  $qiInput=$qiEntry.Open();$qiOutput=[IO.File]::Open((Join-Path $qiVendor $qiName),[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$qiInput.CopyTo($qiOutput)}finally{$qiOutput.Dispose();$qiInput.Dispose()}
 }
}finally{$qiZip.Dispose()}
Push-Location (Join-Path $PSScriptRoot 'source')
try{& dotnet build 'ChartsHub.QuickImport.csproj' -c Release --nologo --ignore-failed-sources -p:ProductionCandidate=true;if($LASTEXITCODE -ne 0){throw 'Production module build failed.'}}finally{Pop-Location}
$qiBuilt=Join-Path $PSScriptRoot 'source/bin/ProductionCandidate/net6.0/ChartsHub.QuickImport.dll'
$qiManifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'MODULE.json') -Raw|ConvertFrom-Json
$qiActual=Get-QiBuildSha $qiBuilt
if($qiActual -ne $qiManifest.moduleSha256){throw ('Build differs from the reviewed module; nothing was installed or overwritten. SHA256: '+$qiActual)}
[pscustomobject]@{result='PRODUCTION_MODULE_REPRODUCED';sha256=$qiActual;output=$qiBuilt;gameAccessed=$false;loaderExecuted=$false}|ConvertTo-Json
