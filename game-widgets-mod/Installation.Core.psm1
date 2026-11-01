Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:GwModuleSha = '33ce0743897df7dfba88aa6642e16dd7d8509214c0e4975d9a81f590b81ab1a3'
$script:GwLoaderManifestSha = 'e7cf37f2cf7163c989c28d8f00f7fbd42ed187645a7409a1fd2a4f94431810c6'
$script:GwBuild = 'CH-1.1.0.6142-win-x64-12bc21e5a88a2fc9'
$script:GwModuleRelative = 'Mods/ChartsHub.CloneHero.Telemetry.dll'
$script:GwReceiptRelative = 'UserData/ChartsHubGameWidgets/install-receipt.json'
$script:GwPrograms = @{
 'Clone Hero.exe'='3ff57876872fdeac94cf88052a69b19e70c7fc58a70919353c9bfcf64dfd2c87'
 'GameAssembly.dll'='12bc21e5a88a2fc9abc259d5d67f24835145eabca6c3f863b075ba37ad75f197'
 'Clone Hero_Data/il2cpp_data/Metadata/global-metadata.dat'='5f14231810f2641639167eb72956e85cced2f36cb4a84682bdefb1e9da3e3d42'
}
function Stop-Gw([string]$Code,[string]$Message){throw ($Code+'|'+$Message)}
function Get-GwDigest([string]$File){
 $stream=[IO.File]::OpenRead($File);$sha=[Security.Cryptography.SHA256]::Create()
 try{([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose();$stream.Dispose()}
}
function Assert-GwNoLinks([string]$Path){
 for($at=[IO.Path]::GetFullPath($Path);$at;$at=[IO.Path]::GetDirectoryName($at)){
  try{$attributes=[IO.File]::GetAttributes($at)}catch{
   $cause=$_.Exception.GetBaseException()
   if($cause -is [IO.FileNotFoundException] -or $cause -is [IO.DirectoryNotFoundException]){continue}
   throw
  }
  if($attributes -band [IO.FileAttributes]::ReparsePoint){Stop-Gw 'LINKED_PATH' 'Linked installation paths are refused.'}
 }
}
function Assert-GwSingleFile([string]$Path){
 Assert-GwNoLinks $Path
 if(![IO.File]::Exists($Path)){Stop-Gw 'MISSING_FILE' 'A required regular file is missing.'}
 if($env:OS -ne 'Windows_NT'){Stop-Gw 'WINDOWS_ONLY' 'The optional game module supports Windows x64 only.'}
 if(!('ChartsHub.GameWidgets.Installation.NativeLinks' -as [type])){
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace ChartsHub.GameWidgets.Installation {
 public static class NativeLinks {
  [StructLayout(LayoutKind.Sequential)] public struct FileInfo {
   public uint Attributes, CreatedLow, CreatedHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
   public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetFileInformationByHandle(IntPtr handle, out FileInfo info);
 }
}
'@
 }
 $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
 try{
  $info=New-Object ChartsHub.GameWidgets.Installation.NativeLinks+FileInfo
  if(![ChartsHub.GameWidgets.Installation.NativeLinks]::GetFileInformationByHandle($stream.SafeFileHandle.DangerousGetHandle(),[ref]$info)){Stop-Gw 'LINK_CHECK_FAILED' 'File ownership could not be verified.'}
  if($info.Links -ne 1){Stop-Gw 'HARDLINK_FILE' 'A file with more than one hard link is refused.'}
 }finally{$stream.Dispose()}
}
function Get-GwChild([string]$Root,[string]$Relative){
 if([string]::IsNullOrWhiteSpace($Relative) -or [IO.Path]::IsPathRooted($Relative) -or $Relative.Contains(':')){Stop-Gw 'INVALID_PATH' 'A relative installation path is invalid.'}
 $parts=$Relative.Replace('\','/').Split('/')
 if(@($parts|Where-Object {$_ -in @('','.','..') -or $_.EndsWith('.') -or $_.EndsWith(' ')}).Count){Stop-Gw 'INVALID_PATH' 'An installation path segment is invalid.'}
 $base=[IO.Path]::GetFullPath($Root).TrimEnd('\','/');$path=[IO.Path]::GetFullPath((Join-Path $base $Relative))
 if(!$path.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase)){Stop-Gw 'PATH_ESCAPED' 'An installation path escaped the selected game folder.'}
 Assert-GwNoLinks $path
 for($parent=[IO.Path]::GetDirectoryName($path);$parent -and $parent.Length -ge $base.Length;$parent=[IO.Path]::GetDirectoryName($parent)){
  if([IO.File]::Exists($parent)){Stop-Gw 'DIRECTORY_BLOCKED' 'A file blocks a required installation directory.'}
 }
 $path
}
function Assert-GwProgram([string]$GameRoot){
 if(![IO.Directory]::Exists($GameRoot)){Stop-Gw 'GAME_FOLDER_MISSING' 'Choose the folder containing Clone Hero.exe.'}
 Assert-GwNoLinks $GameRoot
 foreach($entry in $script:GwPrograms.GetEnumerator()){
  $path=Get-GwChild $GameRoot $entry.Key
  Assert-GwSingleFile $path
  if((Get-GwDigest $path) -cne $entry.Value){Stop-Gw 'UNSUPPORTED_GAME_BUILD' 'Only the reviewed Clone Hero 1.1.0.6142-final Windows x64 build is supported; version labels alone are insufficient.'}
 }
}
function Assert-GwClosed([string]$GameRoot){
 $game=[IO.Path]::GetFullPath($GameRoot).TrimEnd('\','/');$launcher=[IO.Path]::GetDirectoryName($game)
 foreach($process in @(Get-Process -Name 'Clone Hero','Clone Hero Launcher' -ErrorAction SilentlyContinue)){
  try{$path=$process.Path}catch{Stop-Gw 'PROCESS_CHECK_FAILED' 'Cannot verify whether Clone Hero or its launcher is closed.'}
  if(!$path){Stop-Gw 'PROCESS_CHECK_FAILED' 'Cannot verify whether Clone Hero or its launcher is closed.'}
  if($path.StartsWith($game+'\',[StringComparison]::OrdinalIgnoreCase) -or $path -ieq (Join-Path $launcher 'Clone Hero Launcher.exe')){Stop-Gw 'GAME_RUNNING' 'Close Clone Hero and its launcher before installing or removing the optional module.'}
 }
}
function Get-GwSharedLoader([string]$GameRoot,[string]$PackageRoot){
 $manifestFile=Join-Path $PackageRoot 'LOADER-FILES.json';Assert-GwSingleFile $manifestFile
 if((Get-GwDigest $manifestFile) -cne $script:GwLoaderManifestSha){Stop-Gw 'LOADER_MANIFEST_CHANGED' 'The reviewed shared-loader file manifest changed.'}
 $manifest=Get-Content -LiteralPath $manifestFile -Raw|ConvertFrom-Json
 if($manifest.schema -ne 1 -or $manifest.version -ne '0.7.3' -or $manifest.files.Count -ne 164){Stop-Gw 'LOADER_MANIFEST_INVALID' 'The reviewed shared-loader manifest is invalid.'}
 foreach($entry in $manifest.files){
  if($entry.relative -ne 'version.dll' -and !$entry.relative.StartsWith('MelonLoader/',[StringComparison]::Ordinal)){Stop-Gw 'LOADER_MANIFEST_INVALID' 'A loader manifest path is invalid.'}
  $path=Get-GwChild $GameRoot $entry.relative
  if(![IO.File]::Exists($path)){Stop-Gw 'SHARED_LOADER_MISSING' 'The verified MelonLoader 0.7.3 x64 installation is missing or incomplete. Install or repair it explicitly first; existing files will not be replaced.'}
  Assert-GwSingleFile $path
  if((New-Object IO.FileInfo($path)).Length -ne $entry.bytes -or (Get-GwDigest $path) -cne $entry.sha256){Stop-Gw 'SHARED_LOADER_DIFFERENT' 'The existing loader differs from the reviewed 0.7.3 x64 files. No repair, replacement or mod deletion is automatic.'}
 }
 [pscustomobject]@{version='0.7.3';verifiedFiles=164;reused=$true;zipRequired=$false;bytesChanged=$false}
}
function New-GwInstallPlan([string]$GameRoot,[string]$PackageRoot){
 $game=[IO.Path]::GetFullPath($GameRoot).TrimEnd('\','/');$package=[IO.Path]::GetFullPath($PackageRoot)
 Assert-GwProgram $game;Assert-GwClosed $game
 $loader=Get-GwSharedLoader $game $package
 $manifestPath=Join-Path $package 'MODULE.json';Assert-GwSingleFile $manifestPath
 $manifest=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
 if($manifest.kind -ne 'optional-game-widgets' -or $manifest.build -cne $script:GwBuild -or $manifest.moduleSha256 -cne $script:GwModuleSha){Stop-Gw 'MODULE_MANIFEST_CHANGED' 'The module manifest differs from the reviewed exact-build package.'}
 $source=Join-Path $package 'ChartsHub.CloneHero.Telemetry.dll';Assert-GwSingleFile $source
 if((Get-GwDigest $source) -cne $script:GwModuleSha){Stop-Gw 'MODULE_HASH_MISMATCH' 'The module file is incomplete or differs from the reviewed package.'}
 $target=Get-GwChild $game $script:GwModuleRelative;$receipt=Get-GwChild $game $script:GwReceiptRelative
 if(Test-Path -LiteralPath $target){Stop-Gw 'MODULE_ALREADY_EXISTS' 'An existing telemetry module is preserved. Review or remove its owned installation explicitly before a replacement.'}
 if(Test-Path -LiteralPath $receipt){Stop-Gw 'RECEIPT_ALREADY_EXISTS' 'An existing game-widgets receipt is preserved; review that installation first.'}
 [pscustomobject]@{schema=1;kind='chartshub-game-widgets-install-plan';gameRoot=$game;packageRoot=$package;build=$script:GwBuild;moduleSource=$source;moduleRelative=$script:GwModuleRelative;moduleSha256=$script:GwModuleSha;receiptRelative=$script:GwReceiptRelative;sharedLoader=$loader;newFiles=2;overwrites=0;quickImportChanged=$false;loaderChanged=$false;gameSettingsChanged=$false;gameLaunched=$false}
}
function Get-GwPreflight([string]$GameRoot,[string]$PackageRoot){
 $warnings=@('Write permissions and available disk space may change after this read-only check. No test file is created.', 'First launch may need the .NET 6 Desktop Runtime and network access for MelonLoader Cpp2IL/Unity dependencies.', 'Other mods are preserved; their compatibility cannot be guaranteed by a file check.')
 try{$plan=New-GwInstallPlan $GameRoot $PackageRoot;[pscustomobject]@{schema=1;result='READY_FOR_EXPLICIT_INSTALL';canInstall=$true;readOnly=$true;plan=$plan;issues=@();warnings=$warnings}}
 catch{
  $detail=$_.Exception.Message;$pieces=$detail.Split('|',2);$code=if($pieces.Count -eq 2){$pieces[0]}elseif($_.Exception -is [UnauthorizedAccessException]){'READ_PERMISSION_DENIED'}else{'PREFLIGHT_FAILED'}
  [pscustomobject]@{schema=1;result='INSTALL_BLOCKED';canInstall=$false;readOnly=$true;issues=@([pscustomobject]@{code=$code;message=if($pieces.Count -eq 2){$pieces[1]}else{'The selected files could not be verified. Check the game folder and access permissions.'}});warnings=$warnings}
 }
}
function New-GwDirectory([string]$Root,[string]$Path,[Collections.Generic.List[string]]$Created){
 if([IO.Directory]::Exists($Path)){return}
 $pending=New-Object Collections.Generic.List[string]
 for($at=$Path;$at -and ![IO.Directory]::Exists($at);$at=[IO.Path]::GetDirectoryName($at)){
  if(!$at.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)){Stop-Gw 'PATH_ESCAPED' 'An installation directory escaped the game root.'};$pending.Add($at)
 }
 for($i=$pending.Count-1;$i -ge 0;$i--){Assert-GwNoLinks $pending[$i];[IO.Directory]::CreateDirectory($pending[$i])|Out-Null;$Created.Add($pending[$i])}
}
function Write-GwNewFile([string]$Root,[string]$Relative,[IO.Stream]$InputStream,[string]$Expected,[Collections.Generic.List[object]]$CreatedFiles,[Collections.Generic.List[string]]$CreatedDirectories){
 $path=Get-GwChild $Root $Relative;New-GwDirectory $Root ([IO.Path]::GetDirectoryName($path)) $CreatedDirectories
 $output=New-Object IO.FileStream($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 $owned=[pscustomobject]@{relative=$Relative;sha256=$Expected};$CreatedFiles.Add($owned)
 try{try{$InputStream.CopyTo($output);$output.Flush($true)}finally{$output.Dispose()}}
 catch{try{$owned.sha256=Get-GwDigest $path}catch{};throw}
 Assert-GwSingleFile $path;$actual=Get-GwDigest $path;$owned.sha256=$actual
 if($Expected -and $actual -cne $Expected){Stop-Gw 'WRITTEN_HASH_MISMATCH' 'The newly created module did not retain its reviewed bytes.'}
}
function Invoke-GwInstall([object]$Plan){
 Assert-GwClosed $Plan.gameRoot
 $fresh=New-GwInstallPlan $Plan.gameRoot $Plan.packageRoot
 if($fresh.moduleSha256 -cne $Plan.moduleSha256 -or $fresh.moduleRelative -cne $Plan.moduleRelative -or $fresh.receiptRelative -cne $Plan.receiptRelative){Stop-Gw 'PLAN_CHANGED' 'The installation plan changed since review.'}
 $created=New-Object Collections.Generic.List[object];$directories=New-Object Collections.Generic.List[string]
 try{
  $source=[IO.File]::OpenRead($fresh.moduleSource)
  try{Write-GwNewFile $fresh.gameRoot $fresh.moduleRelative $source $fresh.moduleSha256 $created $directories}finally{$source.Dispose()}
  Assert-GwProgram $fresh.gameRoot
  $null=Get-GwSharedLoader $fresh.gameRoot $fresh.packageRoot
  $receipt=[ordered]@{schema=1;kind='chartshub-game-widgets-owned-install';installedUtc=[DateTime]::UtcNow.ToString('o');gameRoot=$fresh.gameRoot;build=$script:GwBuild;moduleRelative=$fresh.moduleRelative;moduleSha256=$fresh.moduleSha256;sharedLoaderVersion='0.7.3';sharedLoaderOwned=$false;createdDirectories=@($directories.ToArray());quickImportChanged=$false;profilesAccessed=$false;gameLaunched=$false}
  $temporary=$fresh.receiptRelative+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
  $bytes=(New-Object Text.UTF8Encoding($false)).GetBytes(($receipt|ConvertTo-Json -Depth 10));$inputStream=New-Object IO.MemoryStream(,$bytes)
  try{Write-GwNewFile $fresh.gameRoot $temporary $inputStream '' $created $directories}finally{$inputStream.Dispose()}
  # Final publication is same-directory and refuses any pre-existing receipt.
  [IO.File]::Move((Get-GwChild $fresh.gameRoot $temporary),(Get-GwChild $fresh.gameRoot $fresh.receiptRelative))
  $created[$created.Count-1].relative=$fresh.receiptRelative
  [pscustomobject]@{result='OPTIONAL_GAME_WIDGETS_INSTALLED';newFiles=2;receipt=(Get-GwChild $fresh.gameRoot $fresh.receiptRelative);moduleSha256=$fresh.moduleSha256;sharedLoaderReused=$true;loaderBytesChanged=$false;quickImportChanged=$false;programBytesUnchanged=$true;gameSettingsChanged=$false;profilesAccessed=$false;gameLaunched=$false}
 }catch{
  $kept=New-Object Collections.Generic.List[string]
  foreach($file in @($created.ToArray())|Sort-Object relative -Descending){
   $path=Get-GwChild $Plan.gameRoot $file.relative
   try{if([IO.File]::Exists($path)){Assert-GwSingleFile $path;if((Get-GwDigest $path) -ceq $file.sha256){Remove-Item -LiteralPath $path -Force}else{$kept.Add($file.relative)}}}catch{$kept.Add($file.relative)}
  }
  foreach($dir in @($directories.ToArray())|Sort-Object Length -Descending){Assert-GwNoLinks $dir;if([IO.Directory]::Exists($dir) -and @([IO.Directory]::EnumerateFileSystemEntries($dir)).Count -eq 0){Remove-Item -LiteralPath $dir -Force}}
  Stop-Gw 'INSTALL_ROLLED_BACK' ('Installation failed; unchanged files created by this operation were rolled back. Modified files preserved: '+$kept.Count+'. No loader or Quick Import file was removed.')
 }
}
function New-GwUninstallPlan([string]$GameRoot){
 $game=[IO.Path]::GetFullPath($GameRoot).TrimEnd('\','/');Assert-GwProgram $game;Assert-GwClosed $game
 $receiptPath=Get-GwChild $game $script:GwReceiptRelative;Assert-GwSingleFile $receiptPath
 if((Get-Item -LiteralPath $receiptPath).Length -gt 16384){Stop-Gw 'RECEIPT_INVALID' 'An oversized ownership receipt is refused.'}
 $receipt=Get-Content -LiteralPath $receiptPath -Raw|ConvertFrom-Json
 if($receipt.schema -ne 1 -or $receipt.kind -cne 'chartshub-game-widgets-owned-install' -or $receipt.gameRoot -ine $game -or $receipt.build -cne $script:GwBuild -or $receipt.moduleRelative -cne $script:GwModuleRelative -or $receipt.moduleSha256 -cne $script:GwModuleSha -or $receipt.sharedLoaderOwned -ne $false){Stop-Gw 'RECEIPT_INVALID' 'The receipt does not own this optional module.'}
 $target=Get-GwChild $game $script:GwModuleRelative;$preserve=$false
 if(Test-Path -LiteralPath $target){Assert-GwSingleFile $target;$preserve=(Get-GwDigest $target) -cne $receipt.moduleSha256}
 # Only these two fixed files can ever be removed. The shared loader and every
 # Quick Import/user file remain outside the removal list, even with a bad receipt.
 [pscustomobject]@{schema=1;kind='chartshub-game-widgets-uninstall-plan';gameRoot=$game;moduleRelative=$script:GwModuleRelative;moduleSha256=$receipt.moduleSha256;moduleExists=[IO.File]::Exists($target);preserveModifiedModule=$preserve;receiptRelative=$script:GwReceiptRelative;receiptSha256=(Get-GwDigest $receiptPath);removeFiles=if($preserve){0}elseif([IO.File]::Exists($target)){2}else{1};loaderRemoved=$false;quickImportRemoved=$false;profilesAccessed=$false;gameLaunched=$false}
}
function Invoke-GwUninstall([object]$Plan){
 $fresh=New-GwUninstallPlan $Plan.gameRoot
 if($fresh.receiptSha256 -cne $Plan.receiptSha256 -or $fresh.moduleSha256 -cne $Plan.moduleSha256 -or $fresh.preserveModifiedModule -ne $Plan.preserveModifiedModule){Stop-Gw 'PLAN_CHANGED' 'The owned module or receipt changed since review.'}
 if($fresh.preserveModifiedModule){return [pscustomobject]@{result='MODIFIED_MODULE_PRESERVED';removed=0;loaderRemoved=$false;quickImportRemoved=$false;gameLaunched=$false}}
 $removed=0
 if($fresh.moduleExists){$target=Get-GwChild $fresh.gameRoot $fresh.moduleRelative;Assert-GwSingleFile $target;if((Get-GwDigest $target) -cne $fresh.moduleSha256){Stop-Gw 'MODULE_CHANGED' 'The module changed; removal stopped.'};Remove-Item -LiteralPath $target -Force;$removed++}
 $receipt=Get-GwChild $fresh.gameRoot $fresh.receiptRelative;Assert-GwSingleFile $receipt
 if((Get-GwDigest $receipt) -cne $fresh.receiptSha256){Stop-Gw 'RECEIPT_CHANGED' 'The receipt changed; removal stopped.'}
 Remove-Item -LiteralPath $receipt -Force;$removed++
 [pscustomobject]@{result='OWNED_GAME_WIDGETS_FILES_REMOVED';removed=$removed;loaderRemoved=$false;quickImportRemoved=$false;programBytesUnchanged=$true;gameSettingsChanged=$false;profilesAccessed=$false;gameLaunched=$false}
}
Export-ModuleMember -Function Get-GwDigest,Assert-GwProgram,Get-GwPreflight,New-GwInstallPlan,Invoke-GwInstall,New-GwUninstallPlan,Invoke-GwUninstall
