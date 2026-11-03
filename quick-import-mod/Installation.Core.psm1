Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$script:QiLoaderSha='5b2b2f3d1cd42b59ec886c5bdc2663edae87a0097a4f4a8f58c0965a99dda416'
$script:QiLoaderUri='https://github.com/LavaGang/MelonLoader/releases/download/v0.7.3/MelonLoader.x64.zip'
$script:QiLoaderBytes=20155622
$script:QiProgram=@{'Clone Hero.exe'='3ff57876872fdeac94cf88052a69b19e70c7fc58a70919353c9bfcf64dfd2c87';'GameAssembly.dll'='12bc21e5a88a2fc9abc259d5d67f24835145eabca6c3f863b075ba37ad75f197';'Clone Hero_Data/il2cpp_data/Metadata/global-metadata.dat'='5f14231810f2641639167eb72956e85cced2f36cb4a84682bdefb1e9da3e3d42'}
function Get-QiDigest([string]$File){$s=[IO.File]::OpenRead($File);$a=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($a.ComputeHash($s))).Replace('-','').ToLowerInvariant()}finally{$a.Dispose();$s.Dispose()}}
function Assert-QiNoLinks([string]$Path){for($at=[IO.Path]::GetFullPath($Path);$at;$at=[IO.Path]::GetDirectoryName($at)){if((Test-Path -LiteralPath $at) -and ((Get-Item -LiteralPath $at -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Linked paths are refused.'}}}
function Get-QiChild([string]$Root,[string]$Relative){
 if([string]::IsNullOrWhiteSpace($Relative) -or [IO.Path]::IsPathRooted($Relative) -or $Relative.Contains(':')){throw 'Invalid relative installation path.'}
 $parts=$Relative.Replace('\','/').Split('/');if(@($parts|Where-Object {$_ -in @('','..','.') -or $_.EndsWith('.') -or $_.EndsWith(' ')}).Count){throw 'Invalid relative installation segment.'}
 $base=[IO.Path]::GetFullPath($Root).TrimEnd('\','/');$path=[IO.Path]::GetFullPath((Join-Path $base $Relative))
 if(!$path.StartsWith($base+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Installation escaped the selected folder.'}
 Assert-QiNoLinks $path
 for($parent=[IO.Path]::GetDirectoryName($path);$parent -and $parent.Length -ge $base.Length;$parent=[IO.Path]::GetDirectoryName($parent)){if([IO.File]::Exists($parent)){throw 'A file blocks an installation directory.'}}
 $path
}
function Assert-QiProgram([string]$GameRoot){Assert-QiNoLinks $GameRoot;foreach($item in $script:QiProgram.GetEnumerator()){if((Get-QiDigest (Get-QiChild $GameRoot $item.Key)) -ne $item.Value){throw 'Only Clone Hero 1.1.0.6142 Windows x64 final is supported.'}}}
function Assert-QiClosed([string]$GameRoot){
 $base=[IO.Path]::GetFullPath($GameRoot).TrimEnd('\','/');$launcher=[IO.Path]::GetDirectoryName($base)
 foreach($process in @(Get-Process -Name 'Clone Hero','Clone Hero Launcher' -ErrorAction SilentlyContinue)){
  try{$path=$process.Path}catch{throw 'Cannot verify whether the game is closed.'}
  if(!$path){throw 'Cannot verify whether the game is closed.'}
  if($path.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase) -or $path -ieq (Join-Path $launcher 'Clone Hero Launcher.exe')){throw 'Close Clone Hero and its launcher before applying changes.'}
 }
}
function Get-QiLoaderEntries([string]$LoaderZip){
 Assert-QiNoLinks $LoaderZip;if((Get-QiDigest $LoaderZip) -ne $script:QiLoaderSha){throw 'The official MelonLoader 0.7.3 x64 archive identity differs.'}
 Add-Type -AssemblyName System.IO.Compression.FileSystem;$zip=[IO.Compression.ZipFile]::OpenRead($LoaderZip)
 try{foreach($entry in $zip.Entries){if($entry.FullName.EndsWith('/')){continue};$name=$entry.FullName.Replace('\','/');if($name -ne 'version.dll' -and !$name.StartsWith('MelonLoader/',[StringComparison]::Ordinal)){throw 'Unexpected loader archive entry.'};$stream=$entry.Open();$a=[Security.Cryptography.SHA256]::Create();try{[pscustomobject]@{relative=$name;sha256=([BitConverter]::ToString($a.ComputeHash($stream))).Replace('-','').ToLowerInvariant();kind='loader';source=$name}}finally{$a.Dispose();$stream.Dispose()}}}finally{$zip.Dispose()}
}
function Find-QiSongsRoot([string]$GameRoot,[string]$DocumentsDirectory,[string]$SongsHint){
 $portable=Join-Path $GameRoot 'PlayerData'
 $data=if([IO.Directory]::Exists($portable)){$portable}elseif($DocumentsDirectory){Join-Path $DocumentsDirectory 'Clone Hero'}else{return}
 $settings=Join-Path $data 'settings.ini'
 if(![IO.File]::Exists($settings)){return}
 Assert-QiNoLinks $settings
 $stream=[IO.File]::Open($settings,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 try{
  if($stream.Length -gt 65536){return}
  $reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false,$true),$true)
  try{$lines=$reader.ReadToEnd() -split '\r?\n'}finally{$reader.Dispose()}
 }finally{$stream.Dispose()}
 $section=''
 $roots=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 foreach($line in $lines){
  if($line -match '^\s*\[([^\]]+)\]\s*$'){$section=$Matches[1];continue}
  if($section -ne 'directories' -or $line -notmatch '^\s*path[0-9]+\s*=\s*(.*)$'){continue}
  $value=$Matches[1].Trim()
  if(!$value){continue}
  if($value -notmatch '^[A-Za-z]:[\\/][^<>:"|?*\x00-\x1f]*$'){return}
  $root=[IO.Path]::GetFullPath($value)
  if($root -eq [IO.Path]::GetPathRoot($root) -or ![IO.Directory]::Exists($root)){return}
  Assert-QiNoLinks $root
  [void]$roots.Add($root.TrimEnd('\','/'))
 }
 if($roots.Count -gt 1){
  if($SongsHint -match '^[A-Za-z]:[\\/][^<>:"|?*\x00-\x1f]*$'){
   $hint=[IO.Path]::GetFullPath($SongsHint).TrimEnd('\','/')
   if($roots.Contains($hint)){return $hint}
  }
  return
 }
 if($roots.Count -eq 1){return $roots | Select-Object -First 1}
 $songs=Join-Path $data 'Songs'
 if([IO.Directory]::Exists($songs)){Assert-QiNoLinks $songs;return $songs}
}

# Keep the official archive in the caller's temporary stream. Redirects are
# restricted to GitHub's asset hosts and the body is bounded before writing.
function Receive-QiLoaderArchive([IO.Stream]$OutputStream){
 $uri=[Uri]$script:QiLoaderUri
 $clock=[Diagnostics.Stopwatch]::StartNew()
 for($hop=0;$hop -lt 4;$hop++){
  if($uri.Scheme -ne 'https' -or !$uri.IsDefaultPort -or $uri.UserInfo -or
     $uri.Host -notin @('github.com','release-assets.githubusercontent.com','objects.githubusercontent.com')){
   throw 'Unexpected MelonLoader archive redirect.'
  }
  $request=[Net.HttpWebRequest][Net.WebRequest]::Create($uri)
  $request.AllowAutoRedirect=$false
  $request.Timeout=20000
  $request.ReadWriteTimeout=20000
  $response=$request.GetResponse()
  try{
   $status=[int]$response.StatusCode
   if($status -in @(301,302,303,307,308)){
    $location=$response.Headers['Location']
    if(!$location){throw 'Missing MelonLoader archive redirect.'}
    $uri=[Uri]::new($uri,$location)
    continue
   }
   if($status -ne 200 -or ($response.ContentLength -ge 0 -and $response.ContentLength -ne $script:QiLoaderBytes)){
    throw 'Unexpected MelonLoader archive response.'
   }
   $stream=$response.GetResponseStream()
   try{
    $buffer=[byte[]]::new(65536)
    $count=0
    while(($read=$stream.Read($buffer,0,$buffer.Length)) -gt 0){
     $count+=$read
     if($count -gt $script:QiLoaderBytes -or $clock.Elapsed.TotalSeconds -gt 120){throw 'MelonLoader download exceeded its limits.'}
     $OutputStream.Write($buffer,0,$read)
    }
    if($count -ne $script:QiLoaderBytes){throw 'Incomplete MelonLoader archive.'}
   }finally{$stream.Dispose()}
   return
  }finally{$response.Dispose()}
 }
 throw 'Too many MelonLoader archive redirects.'
}
function New-QiInstallPlan([string]$GameRoot,[string]$SongsRoot,[string]$PackageRoot,[string]$LoaderZip,[bool]$EnableBeta=$false){
 $game=[IO.Path]::GetFullPath($GameRoot).TrimEnd('\','/');$songs=[IO.Path]::GetFullPath($SongsRoot).TrimEnd('\','/');$package=[IO.Path]::GetFullPath($PackageRoot)
 Assert-QiProgram $game;Assert-QiNoLinks $songs;if(![IO.Directory]::Exists($songs)){throw 'Select an existing Songs folder; no library is created or scanned.'}
 $manifest=Get-Content -LiteralPath (Join-Path $package 'MODULE.json') -Raw|ConvertFrom-Json
 if($manifest.build -ne 'CH-1.1.0.6142-win-x64-12bc21e5a88a2fc9' -or $manifest.kind -ne 'production-candidate'){throw 'Production module manifest required.'}
 $module=Join-Path $package 'ChartsHub.QuickImport.dll';if((Get-QiDigest $module) -ne $manifest.moduleSha256){throw 'Module identity differs from its reviewed manifest.'}
 $files=New-Object Collections.Generic.List[object]
 foreach($entry in @(Get-QiLoaderEntries $LoaderZip)){$files.Add($entry)}
 $files.Add([pscustomobject]@{relative='Mods/ChartsHub.QuickImport.dll';sha256=$manifest.moduleSha256;kind='module';source=$module})
 $loaderConfig=Join-Path $package 'Loader.defaults.cfg'
 if(!(Test-Path -LiteralPath (Get-QiChild $game 'UserData/Loader.cfg'))){$files.Add([pscustomobject]@{relative='UserData/Loader.cfg';sha256=(Get-QiDigest $loaderConfig);kind='settings';source=$loaderConfig})}
 $configRelative='UserData/ChartsHubQuickImport/config.json';$receiptRelative='UserData/ChartsHubQuickImport/install-receipt.json'
 if(Test-Path -LiteralPath (Get-QiChild $game $receiptRelative)){throw 'A receipt already exists. Review or uninstall that installation first.'}
 if(Test-Path -LiteralPath (Get-QiChild $game $configRelative)){throw 'An existing Quick Import configuration is preserved. Review it before installation.'}
 $new=New-Object Collections.Generic.List[object];$preserved=New-Object Collections.Generic.List[string]
 foreach($entry in $files){$target=Get-QiChild $game $entry.relative;if(Test-Path -LiteralPath $target){if(![IO.File]::Exists($target) -or (Get-QiDigest $target) -ne $entry.sha256){throw ('Existing file differs and will not be overwritten: '+$entry.relative)};$preserved.Add($entry.relative)}else{$new.Add($entry)}}
 [pscustomobject]@{schema=1;kind='chartshub-quick-import-install-plan';gameRoot=$game;songsRoot=$songs;packageRoot=$package;loaderZip=[IO.Path]::GetFullPath($LoaderZip);enableBeta=$EnableBeta;newFiles=@($new.ToArray());preservedFiles=@($preserved.ToArray());configRelative=$configRelative;receiptRelative=$receiptRelative;gameProgramBytesChanged=$false;gameProfilesRead=$false;songsScanned=$false;gameLaunched=$false}
}
function New-QiDirectory([string]$Root,[string]$Directory,[Collections.Generic.List[string]]$Created){
 if([IO.Directory]::Exists($Directory)){return};$pending=New-Object Collections.Generic.List[string]
 for($at=$Directory;$at -and ![IO.Directory]::Exists($at);$at=[IO.Path]::GetDirectoryName($at)){if(!$at.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Directory escaped the game folder.'};$pending.Add($at)}
 for($i=$pending.Count-1;$i -ge 0;$i--){Assert-QiNoLinks $pending[$i];[IO.Directory]::CreateDirectory($pending[$i])|Out-Null;$Created.Add($pending[$i])}
}
function Write-QiNewFile([string]$Root,[string]$Relative,[IO.Stream]$SourceStream,[string]$Expected,[Collections.Generic.List[object]]$CreatedFiles,[Collections.Generic.List[string]]$CreatedDirectories){
 $target=Get-QiChild $Root $Relative;New-QiDirectory $Root ([IO.Path]::GetDirectoryName($target)) $CreatedDirectories
 $output=New-Object IO.FileStream($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 $record=[pscustomobject]@{relative=$Relative;sha256=$Expected};$CreatedFiles.Add($record)
 try{try{$SourceStream.CopyTo($output);$output.Flush($true)}finally{$output.Dispose()}}catch{try{$record.sha256=Get-QiDigest $target}catch{};throw}
 $actual=Get-QiDigest $target;$record.sha256=$actual
 if($Expected -and $actual -ne $Expected){throw ('Written file identity differs: '+$Relative)}
}
function Invoke-QiInstall([object]$Plan){
 Assert-QiClosed $Plan.gameRoot
 $fresh=New-QiInstallPlan $Plan.gameRoot $Plan.songsRoot $Plan.packageRoot $Plan.loaderZip $Plan.enableBeta
 if(($fresh.newFiles.relative -join '|') -ne ($Plan.newFiles.relative -join '|')){throw 'Installation files changed since review.'}
 $created=New-Object Collections.Generic.List[object];$directories=New-Object Collections.Generic.List[string]
 Add-Type -AssemblyName System.IO.Compression.FileSystem;$zip=[IO.Compression.ZipFile]::OpenRead($Plan.loaderZip)
 try{
  foreach($file in $Plan.newFiles){if($file.kind -eq 'loader'){$sourceStream=$zip.GetEntry($file.source).Open()}else{$sourceStream=[IO.File]::OpenRead($file.source)};try{Write-QiNewFile $Plan.gameRoot $file.relative $sourceStream $file.sha256 $created $directories}finally{$sourceStream.Dispose()}}
  $bytes=New-Object byte[] 32;$rng=[Security.Cryptography.RandomNumberGenerator]::Create();try{$rng.GetBytes($bytes)}finally{$rng.Dispose()};$token=([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant()
  $config=[ordered]@{schema=1;enabled=[bool]$Plan.enableBeta;songsRoot=$Plan.songsRoot;token=$token};$text=$config|ConvertTo-Json
  $sourceStream=New-Object IO.MemoryStream(,[Text.Encoding]::UTF8.GetBytes($text));try{Write-QiNewFile $Plan.gameRoot $Plan.configRelative $sourceStream '' $created $directories}finally{$sourceStream.Dispose()}
  Assert-QiProgram $Plan.gameRoot
  $receipt=[ordered]@{schema=1;kind='chartshub-quick-import-owned-install';installedUtc=[DateTime]::UtcNow.ToString('o');gameRoot=$Plan.gameRoot;build='CH-1.1.0.6142-win-x64-12bc21e5a88a2fc9';files=@($created.ToArray());createdDirectories=@($directories.ToArray());preservedFiles=$Plan.preservedFiles;programBytesUnchanged=$true;profilesAccessed=$false;songsAccessed=$false;gameLaunched=$false}
  $receiptPath=Get-QiChild $Plan.gameRoot $Plan.receiptRelative;$receiptText=$receipt|ConvertTo-Json -Depth 12
  $receiptTemporary=$Plan.receiptRelative+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
  $sourceStream=New-Object IO.MemoryStream(,(New-Object Text.UTF8Encoding($false)).GetBytes($receiptText))
  try{Write-QiNewFile $Plan.gameRoot $receiptTemporary $sourceStream '' $created $directories}finally{$sourceStream.Dispose()}
  # Same-directory publication never overwrites an existing receipt; the temporary
  # belongs to this operation and is covered by failure cleanup before publication.
  [IO.File]::Move((Get-QiChild $Plan.gameRoot $receiptTemporary),$receiptPath)
  $created[$created.Count-1].relative=$Plan.receiptRelative
  [pscustomobject]@{result='INSTALLED_BETA_OPTIONAL';receipt=$receiptPath;enabled=[bool]$Plan.enableBeta;newFiles=$created.Count;preservedFiles=$Plan.preservedFiles.Count;gameLaunched=$false;programBytesUnchanged=$true;profilesAccessed=$false;songsScanned=$false}
 }catch{
  $failure=$_.Exception.Message;$kept=New-Object Collections.Generic.List[string]
  foreach($file in @($created.ToArray())|Sort-Object relative -Descending){$path=Get-QiChild $Plan.gameRoot $file.relative;if([IO.File]::Exists($path) -and (Get-QiDigest $path) -eq $file.sha256){Remove-Item -LiteralPath $path -Force}else{$kept.Add($file.relative)}}
  foreach($dir in @($directories.ToArray())|Sort-Object Length -Descending){if([IO.Directory]::Exists($dir) -and @([IO.Directory]::EnumerateFileSystemEntries($dir)).Count -eq 0){Remove-Item -LiteralPath $dir -Force}}
  throw ('Installation stopped; newly created unchanged files rolled back. Preserved modified files: '+$kept.Count+'. Reason: '+$failure)
 }finally{$zip.Dispose()}
}
function New-QiUninstallPlan([string]$GameRoot){
 $game=[IO.Path]::GetFullPath($GameRoot).TrimEnd('\','/');Assert-QiProgram $game;$relative='UserData/ChartsHubQuickImport/install-receipt.json';$receiptFile=Get-QiChild $game $relative
 if((Get-Item -LiteralPath $receiptFile).Length -gt 262144){throw 'Oversized receipt refused.'};$receipt=Get-Content -LiteralPath $receiptFile -Raw|ConvertFrom-Json
 if($receipt.schema -ne 1 -or $receipt.kind -ne 'chartshub-quick-import-owned-install' -or $receipt.gameRoot -ine $game){throw 'Receipt does not belong to this game folder.'}
 # A nested or linked extension directory is conservatively a loader dependency.
 # Do not descend into it: another mod may load from any subdirectory.
 $shared=$false
 foreach($folder in @('Mods','Plugins')){
  $dir=Get-QiChild $game $folder
  if([IO.Directory]::Exists($dir)){
   Assert-QiNoLinks $dir
   foreach($other in @(Get-ChildItem -LiteralPath $dir -Force)){
    if($other.PSIsContainer -or ($other.Attributes -band [IO.FileAttributes]::ReparsePoint)){$shared=$true;continue}
    if($other.Extension -ieq '.dll'){
     $own=@($receipt.files|Where-Object {$_.relative.Replace('\','/') -ieq ($folder+'/'+$other.Name)})
     if($own.Count -ne 1 -or (Get-QiDigest $other.FullName) -ne $own[0].sha256){$shared=$true}
    }
   }
  }
 }
 $remove=New-Object Collections.Generic.List[object];$keep=New-Object Collections.Generic.List[string]
 foreach($file in $receipt.files){$rel=$file.relative.Replace('\','/');$isLoader=$rel -eq 'version.dll' -or $rel.StartsWith('MelonLoader/',[StringComparison]::Ordinal)
  if(!$isLoader -and $rel -notin @('Mods/ChartsHub.QuickImport.dll','UserData/ChartsHubQuickImport/config.json','UserData/Loader.cfg')){throw 'Unexpected owned-file receipt path.'}
  $path=Get-QiChild $game $rel
  if(($shared -and ($isLoader -or $rel -eq 'UserData/Loader.cfg')) -or ![IO.File]::Exists($path) -or (Get-QiDigest $path) -ne $file.sha256){$keep.Add($rel)}else{$remove.Add([pscustomobject]@{relative=$rel;sha256=$file.sha256})}
 }
 [pscustomobject]@{schema=1;kind='chartshub-quick-import-uninstall-plan';gameRoot=$game;receipt=$receiptFile;receiptSha256=(Get-QiDigest $receiptFile);remove=@($remove.ToArray());preserve=@($keep.ToArray());loaderKeptForOtherMods=$shared;createdDirectories=@($receipt.createdDirectories);gameProfilesAccessed=$false;songsAndCacheRemoved=$false}
}
function Invoke-QiUninstall([object]$Plan){
 Assert-QiClosed $Plan.gameRoot;$fresh=New-QiUninstallPlan $Plan.gameRoot
 if($fresh.receiptSha256 -ne $Plan.receiptSha256 -or ($fresh.remove.relative -join '|') -ne ($Plan.remove.relative -join '|')){throw 'Files changed since uninstall review.'}
 foreach($file in $Plan.remove){$path=Get-QiChild $Plan.gameRoot $file.relative;if((Get-QiDigest $path) -ne $file.sha256){throw 'Owned file changed; uninstall stopped.'};Remove-Item -LiteralPath $path -Force}
 # Keep a receipt if any modified or shared file was deliberately preserved.
 if($Plan.preserve.Count -eq 0 -and (Get-QiDigest $Plan.receipt) -eq $Plan.receiptSha256){Remove-Item -LiteralPath $Plan.receipt -Force}
 foreach($dir in @($Plan.createdDirectories)|Sort-Object Length -Descending){$absolute=[IO.Path]::GetFullPath($dir);if(!$absolute.StartsWith($Plan.gameRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Receipt directory escaped root.'};Assert-QiNoLinks $absolute;if([IO.Directory]::Exists($absolute) -and @([IO.Directory]::EnumerateFileSystemEntries($absolute)).Count -eq 0){Remove-Item -LiteralPath $absolute -Force}}
 [pscustomobject]@{result='OWNED_UNMODIFIED_FILES_REMOVED';removed=$Plan.remove.Count;preserved=$Plan.preserve.Count;loaderKeptForOtherMods=$Plan.loaderKeptForOtherMods;programBytesUnchanged=$true;profilesAccessed=$false;songsAndNativeCacheRemoved=$false;gameLaunched=$false}
}
Export-ModuleMember -Function New-QiInstallPlan,Invoke-QiInstall,New-QiUninstallPlan,Invoke-QiUninstall,Assert-QiProgram,Assert-QiClosed,Assert-QiNoLinks,Find-QiSongsRoot,Receive-QiLoaderArchive,Get-QiDigest
