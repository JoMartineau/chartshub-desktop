param([switch]$SkipCMake)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$nativeRoot=$PSScriptRoot
$pins=Get-Content -LiteralPath (Join-Path $nativeRoot 'dependencies.json') -Raw | ConvertFrom-Json
function Assert-Hash([string]$Path,[string]$Expected){
  $stream=[IO.File]::OpenRead($Path);$sha=[Security.Cryptography.SHA256]::Create()
  try{$actual=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose();$stream.Dispose()}
  if($actual -ne $Expected){throw "Reviewed dependency SHA256 mismatch: $Path"}
}
function Git-Checked([string[]]$Arguments){ & git @Arguments; if($LASTEXITCODE -ne 0){throw 'Official SDK source retrieval failed'} }
$vendor=Join-Path $nativeRoot 'vendor'
New-Item -ItemType Directory -Path $vendor -Force | Out-Null
$sdk=Join-Path $vendor 'vst3sdk'
if(-not(Test-Path -LiteralPath $sdk)){
  Git-Checked @('-c','core.longpaths=true','clone','--depth','1','--branch',$pins.vst3sdk.tag,'--no-recurse-submodules',$pins.vst3sdk.repository,$sdk)
}
$actual=& git -C $sdk rev-parse HEAD
if($LASTEXITCODE -ne 0 -or $actual -ne $pins.vst3sdk.commit){throw 'VST3 SDK commit differs from reviewed pin'}
& git -C $sdk diff --quiet --ignore-submodules=all
if($LASTEXITCODE -ne 0){throw 'VST3 SDK contains local modifications'}
Git-Checked @('-c','core.longpaths=true','-C',$sdk,'submodule','update','--init','--depth','1','base','cmake','pluginterfaces','public.sdk')
foreach($part in $pins.vst3sdk.submodules.PSObject.Properties){
  $partPath=Join-Path $sdk $part.Name
  $actual=& git -C $partPath rev-parse HEAD
  if($LASTEXITCODE -ne 0 -or $actual -ne $part.Value){throw "VST3 SDK submodule pin differs: $($part.Name)"}
  & git -c core.longpaths=true -C $partPath diff --quiet
  if($LASTEXITCODE -ne 0){throw "VST3 SDK submodule modified: $($part.Name)"}
}
Assert-Hash (Join-Path $sdk 'LICENSE.txt') $pins.vst3sdk.licenseSha256
$jsonDir=Join-Path $vendor 'json'
New-Item -ItemType Directory -Path $jsonDir -Force | Out-Null
foreach($file in @('json.hpp','LICENSE.MIT')){
  $destination=Join-Path $jsonDir $file
  $remoteFile=if($file -eq 'json.hpp'){'single_include/nlohmann/json.hpp'}else{'LICENSE.MIT'}
  if(-not(Test-Path -LiteralPath $destination)){Invoke-WebRequest -UseBasicParsing -Uri ('https://raw.githubusercontent.com/nlohmann/json/'+$pins.json.commit+'/'+$remoteFile) -OutFile $destination}
  $expected=if($file -eq 'json.hpp'){$pins.json.headerSha256}else{$pins.json.licenseSha256}
  Assert-Hash $destination $expected
}
if(-not $SkipCMake){
  $tools=Join-Path $nativeRoot 'tools';New-Item -ItemType Directory -Path $tools -Force | Out-Null
  $archive=Join-Path $tools 'cmake-4.1.2-windows-x86_64.zip'
  if(-not(Test-Path -LiteralPath $archive)){Invoke-WebRequest -UseBasicParsing -Uri $pins.cmake.url -OutFile $archive}
  Assert-Hash $archive $pins.cmake.sha256
  if(-not(Test-Path -LiteralPath (Join-Path $tools 'cmake-4.1.2-windows-x86_64/bin/cmake.exe'))){Expand-Archive -LiteralPath $archive -DestinationPath $tools}
  Assert-Hash (Join-Path $tools 'cmake-4.1.2-windows-x86_64/bin/cmake.exe') $pins.cmake.executableSha256
}
Write-Output 'Reviewed VST3 SDK, JSON source and local build tool are ready. No plugin or driver installed.'
