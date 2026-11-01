param([Parameter(Mandatory=$true)][string]$OutputRoot)
$ErrorActionPreference='Stop'
$gwRepo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$gwRun=Join-Path ([IO.Path]::GetFullPath($OutputRoot)) ('shared-install-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($gwRun)|Out-Null
$gwPackage=Join-Path $gwRun 'package';[IO.Directory]::CreateDirectory($gwPackage)|Out-Null
foreach($name in @('Installation.Core.psm1','MODULE.json','ChartsHub.CloneHero.Telemetry.dll')){[IO.File]::Copy((Join-Path ($gwRepo+'/game-widgets-mod') $name),(Join-Path $gwPackage $name),$false)}
$gwModule=Import-Module (Join-Path $gwPackage 'Installation.Core.psm1') -Force -PassThru
$gwQi=Import-Module (Join-Path ($gwRepo+'/quick-import-mod') 'Installation.Core.psm1') -Force -PassThru
$gwChecks=New-Object Collections.Generic.List[string]
$gwSkipped=New-Object Collections.Generic.List[string]
function Require([bool]$Value,[string]$Message){if(!$Value){throw $Message}}
function Check([string]$Name,[scriptblock]$Test){& $Test;$gwChecks.Add($Name);Write-Output ('PASS '+$Name)}
function Expect([string]$Code,[scriptblock]$Action){$ok=$false;try{& $Action|Out-Null}catch{$ok=$_.Exception.Message.StartsWith($Code+'|',[StringComparison]::Ordinal)};Require $ok ('Expected rejection '+$Code)}
function Snapshot([string]$Root){$values=@{};Get-ChildItem -LiteralPath $Root -Recurse -File|ForEach-Object {$values[$_.FullName.Substring($Root.Length+1)]=Get-GwDigest $_.FullName};$values}
function AssertSnapshot([string]$Root,[hashtable]$Before){foreach($key in $Before.Keys){Require ((Get-GwDigest (Join-Path $Root $key)) -ceq $Before[$key]) ('Existing fixture changed: '+$key)}}
function New-Game([string]$Name){
 $game=Join-Path $gwRun ($Name+'/Game');[IO.Directory]::CreateDirectory($game)|Out-Null
 $programs=@{}
 foreach($relative in @('Clone Hero.exe','GameAssembly.dll','Clone Hero_Data/il2cpp_data/Metadata/global-metadata.dat')){
  $path=Join-Path $game $relative;[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))|Out-Null
  [IO.File]::WriteAllText($path,('SYNTHETIC NOT EXECUTABLE '+$relative));$programs[$relative]=Get-GwDigest $path
 }
 $entries=@(for($i=0;$i -lt 164;$i++){
  $relative=if($i -eq 0){'version.dll'}else{'MelonLoader/Synthetic/reference-'+$i+'.bin'}
  $path=Join-Path $game $relative;[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))|Out-Null
  [IO.File]::WriteAllText($path,('SYNTHETIC LOADER REFERENCE '+$i));[ordered]@{relative=$relative;bytes=(Get-Item -LiteralPath $path).Length;sha256=(Get-GwDigest $path)}
 })
 [ordered]@{schema=1;version='0.7.3';files=$entries}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $gwPackage 'LOADER-FILES.json') -Encoding utf8
 & $gwModule {param($p,$h)$script:GwPrograms=$p;$script:GwLoaderManifestSha=$h} $programs (Get-GwDigest (Join-Path $gwPackage 'LOADER-FILES.json'))
 & $gwQi {param($p)$script:QiProgram=$p} $programs
 [IO.Directory]::CreateDirectory((Join-Path $game 'UserData/ChartsHubQuickImport'))|Out-Null
 [IO.Directory]::CreateDirectory((Join-Path $game 'Mods'))|Out-Null
 [IO.File]::WriteAllText((Join-Path $game 'Mods/ChartsHub.QuickImport.dll'),'SYNTHETIC QUICK IMPORT MODULE')
 [IO.File]::WriteAllText((Join-Path $game 'UserData/ChartsHubQuickImport/config.json'),'SYNTHETIC PRIVATE QUICK IMPORT CONFIGURATION')
 [IO.File]::WriteAllText((Join-Path $game 'UserData/Loader.cfg'),'SYNTHETIC PRESERVED LOADER CONFIGURATION')
 $owned=@($entries|ForEach-Object {[ordered]@{relative=$_.relative;sha256=$_.sha256}})
 foreach($relative in @('Mods/ChartsHub.QuickImport.dll','UserData/ChartsHubQuickImport/config.json','UserData/Loader.cfg')){$owned+=@([ordered]@{relative=$relative;sha256=(Get-GwDigest (Join-Path $game $relative))})}
 [ordered]@{schema=1;kind='chartshub-quick-import-owned-install';gameRoot=$game;files=$owned;createdDirectories=@();preservedFiles=@()}|ConvertTo-Json -Depth 10|Set-Content -LiteralPath (Join-Path $game 'UserData/ChartsHubQuickImport/install-receipt.json') -Encoding utf8
 [IO.File]::WriteAllText((Join-Path $game 'UserData/user-profile-keep.txt'),'SYNTHETIC USER PROFILE MUST STAY')
 [IO.Directory]::CreateDirectory((Join-Path $game 'Songs/Keep'))|Out-Null
 [IO.File]::WriteAllText((Join-Path $game 'Songs/Keep/notes.chart'),'SYNTHETIC SONG MUST STAY')
 $game
}
Check 'Read-only shared-loader preflight and game-widget removal preserve every Quick Import byte' {
 $game=New-Game 'widget-first';$before=Snapshot $game;$preflight=Get-GwPreflight $game $gwPackage
 Require $preflight.canInstall 'Shared-loader preflight failed.';Require ($preflight.plan.sharedLoader.verifiedFiles -eq 164 -and !$preflight.plan.sharedLoader.zipRequired) 'A second loader download was requested.'
 Require ((Snapshot $game).Count -eq $before.Count) 'Preflight created a file.'
 $installed=Invoke-GwInstall $preflight.plan;Require ($installed.newFiles -eq 2 -and !$installed.loaderBytesChanged -and !$installed.quickImportChanged) 'Unexpected installation scope.'
 AssertSnapshot $game $before
 $undo=New-GwUninstallPlan $game;Require ($undo.removeFiles -eq 2) 'Owned removal scope differs.'
 $removed=Invoke-GwUninstall $undo;Require ($removed.removed -eq 2 -and !$removed.loaderRemoved) 'Shared loader was removed.'
 AssertSnapshot $game $before;Require ((Snapshot $game).Count -eq $before.Count) 'Unexpected leftover owned files.'
}
Check 'Quick Import removal keeps the shared loader while the optional telemetry module exists' {
 $game=New-Game 'qi-first';$null=Invoke-GwInstall (New-GwInstallPlan $game $gwPackage)
 $telemetrySha=Get-GwDigest (Join-Path $game 'Mods/ChartsHub.CloneHero.Telemetry.dll')
 $qiPlan=New-QiUninstallPlan $game;Require $qiPlan.loaderKeptForOtherMods 'Quick Import did not recognize the other module.'
 $null=Invoke-QiUninstall $qiPlan
 Require ([IO.File]::Exists((Join-Path $game 'version.dll'))) 'Shared loader was deleted.'
 Require ((Get-GwDigest (Join-Path $game 'Mods/ChartsHub.CloneHero.Telemetry.dll')) -ceq $telemetrySha) 'Other module changed.'
 $null=Invoke-GwUninstall (New-GwUninstallPlan $game)
 Require ([IO.File]::Exists((Join-Path $game 'version.dll'))) 'Game-widget removal deleted the shared loader.'
 Require ([IO.File]::ReadAllText((Join-Path $game 'UserData/user-profile-keep.txt')) -eq 'SYNTHETIC USER PROFILE MUST STAY') 'Profile changed.'
}
Check 'Missing, partial and foreign loader or unsupported program bytes block installation' {
 $game=New-Game 'loader-missing';Remove-Item -LiteralPath (Join-Path $game 'version.dll')
 Expect 'SHARED_LOADER_MISSING' {New-GwInstallPlan $game $gwPackage}
 $game=New-Game 'loader-foreign';[IO.File]::WriteAllText((Join-Path $game 'version.dll'),'FOREIGN LOADER')
 Expect 'SHARED_LOADER_DIFFERENT' {New-GwInstallPlan $game $gwPackage}
 $game=New-Game 'wrong-build';[IO.File]::WriteAllText((Join-Path $game 'GameAssembly.dll'),'UNSUPPORTED BUILD')
 $diagnostic=Get-GwPreflight $game $gwPackage;Require (!$diagnostic.canInstall -and $diagnostic.issues[0].code -eq 'UNSUPPORTED_GAME_BUILD') 'Structured build refusal differs.'
}
Check 'Unknown pre-existing telemetry module and changed package bytes are never overwritten' {
 $game=New-Game 'unknown-module';$path=Join-Path $game 'Mods/ChartsHub.CloneHero.Telemetry.dll';[IO.File]::WriteAllText($path,'ANOTHER USER MODULE');$sha=Get-GwDigest $path
 Expect 'MODULE_ALREADY_EXISTS' {New-GwInstallPlan $game $gwPackage};Require ((Get-GwDigest $path) -ceq $sha) 'Unknown module was overwritten.'
 $game=New-Game 'package-tamper';$source=Join-Path $gwPackage 'ChartsHub.CloneHero.Telemetry.dll';$original=[IO.File]::ReadAllBytes($source)
 try{[IO.File]::WriteAllText($source,'TRUNCATED DOWNLOAD');Expect 'MODULE_HASH_MISMATCH' {New-GwInstallPlan $game $gwPackage}}finally{[IO.File]::WriteAllBytes($source,$original)}
}
Check 'Changed installed module and forged receipt do not permit removal of user files' {
 $game=New-Game 'owned-tamper';$null=Invoke-GwInstall (New-GwInstallPlan $game $gwPackage)
 $path=Join-Path $game 'Mods/ChartsHub.CloneHero.Telemetry.dll';[IO.File]::WriteAllText($path,'CHANGED USER MODULE')
 $plan=New-GwUninstallPlan $game;Require $plan.preserveModifiedModule 'Changed module was treated as owned bytes.'
 $result=Invoke-GwUninstall $plan;Require ($result.removed -eq 0) 'Changed module was removed.'
 $receipt=Join-Path $game 'UserData/ChartsHubGameWidgets/install-receipt.json';$body=Get-Content -LiteralPath $receipt -Raw|ConvertFrom-Json
 $body.moduleRelative='GameAssembly.dll';$body|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $receipt -Encoding utf8
 Expect 'RECEIPT_INVALID' {New-GwUninstallPlan $game}
}
Check 'A partial receipt write rolls back only newly created owned files' {
 $game=New-Game 'write-failure';$before=Snapshot $game
 if(!('ChartsHub.GameWidgets.Tests.FailingRead' -as [type])){Add-Type -TypeDefinition @'
using System;
using System.IO;
namespace ChartsHub.GameWidgets.Tests {
 public sealed class FailingRead : Stream {
  private int calls;
  public override bool CanRead {get{return true;}} public override bool CanSeek {get{return false;}} public override bool CanWrite {get{return false;}}
  public override long Length {get{return 64;}} public override long Position {get{return 0;}set{throw new NotSupportedException();}}
  public override int Read(byte[] buffer,int offset,int count) { if(++calls>1) throw new IOException("Synthetic disk failure"); int size=Math.Min(count,8); Array.Clear(buffer,offset,size);return size; }
  public override void Flush() {} public override long Seek(long offset,SeekOrigin origin) {throw new NotSupportedException();}
  public override void SetLength(long size) {throw new NotSupportedException();} public override void Write(byte[] buffer,int offset,int count) {throw new NotSupportedException();}
 }
}
'@}
 & $gwModule {
  $script:GwOriginalWriter=(Get-Item function:Write-GwNewFile).ScriptBlock
  function script:Write-GwNewFile($Root,$Relative,$InputStream,$Expected,$CreatedFiles,$CreatedDirectories){
   if($Relative.EndsWith('.tmp')){$broken=New-Object ChartsHub.GameWidgets.Tests.FailingRead;try{& $script:GwOriginalWriter $Root $Relative $broken $Expected $CreatedFiles $CreatedDirectories}finally{$broken.Dispose()}}
   else{& $script:GwOriginalWriter $Root $Relative $InputStream $Expected $CreatedFiles $CreatedDirectories}
  }
 }
 try{Expect 'INSTALL_ROLLED_BACK' {Invoke-GwInstall (New-GwInstallPlan $game $gwPackage)}}finally{& $gwModule {Set-Item function:script:Write-GwNewFile $script:GwOriginalWriter}}
 AssertSnapshot $game $before;Require ((Snapshot $game).Count -eq $before.Count) 'Rollback left a partial receipt or module.'
}
Check 'A game-running preflight is a structured refusal without invoking a game' {
 $game=New-Game 'running-check'
 & $gwModule {param($path)$script:GwFakeProcessPath=$path;function script:Get-Process {param($Name,$ErrorAction)[pscustomobject]@{Path=$script:GwFakeProcessPath}}} (Join-Path $game 'Clone Hero.exe')
 try{$result=Get-GwPreflight $game $gwPackage;Require (!$result.canInstall -and $result.issues[0].code -eq 'GAME_RUNNING') 'Running-game refusal differs.'}finally{& $gwModule {Remove-Item function:script:Get-Process}}
}
Check 'Hard-linked ownership files and reparse-point game folders are refused' {
 $game=New-Game 'link-check';$null=Invoke-GwInstall (New-GwInstallPlan $game $gwPackage)
 $receipt=Join-Path $game 'UserData/ChartsHubGameWidgets/install-receipt.json';$alias=Join-Path $gwRun 'receipt-alias.json'
 $linked=$false;try{New-Item -ItemType HardLink -Path $alias -Target $receipt -ErrorAction Stop|Out-Null;$linked=$true}catch{$gwSkipped.Add('OS denied hard-link fixture creation')}
 if($linked){Expect 'HARDLINK_FILE' {New-GwUninstallPlan $game}}
 $junction=Join-Path $gwRun 'linked-game';$linked=$false;try{New-Item -ItemType Junction -Path $junction -Target $game -ErrorAction Stop|Out-Null;$linked=$true}catch{$gwSkipped.Add('OS denied junction fixture creation')}
 if($linked){Expect 'LINKED_PATH' {New-GwInstallPlan $junction $gwPackage}}
}
$report=[ordered]@{result='PASS_SHARED_INSTALLATION_FIXTURES';checks=@($gwChecks.ToArray());skipped=@($gwSkipped.ToArray());onlySyntheticFiles=$true;gameBinaryExecuted=$false;loaderExecuted=$false;normalGameOrProfilesAccessed=$false;hardwareAccessed=$false}
$report|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $gwRun 'REPORT.json') -Encoding utf8
[ordered]@{result=$report.result;passed=$gwChecks.Count;skipped=$gwSkipped.Count;output=$gwRun}|ConvertTo-Json
