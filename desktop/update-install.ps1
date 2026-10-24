#requires -Version 5.1
[CmdletBinding()]
param([string]$Plan, [string]$PlanSha256, [switch]$FunctionsOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression

# Runs outside the application directory. Never stops processes, requests
# elevation, changes Windows security, follows links or deletes app folders.
function Full-Path([string]$Value) {
    if (!$Value -or ![IO.Path]::IsPathRooted($Value) -or $Value.StartsWith('\\') -or $Value -match '[\x00-\x1f]') { throw 'Unsafe absolute path' }
    # Reject ambiguity before Windows GetFullPath can normalize it away.
    foreach ($part in ($Value.Substring([IO.Path]::GetPathRoot($Value).Length) -split '[\\/]')) { if (!$part -or $part -in @('.','..') -or $part -match '[<>:"|?*]' -or $part -match '[. ]$' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'Ambiguous path segment' } }
    $full = [IO.Path]::GetFullPath($Value).TrimEnd('\', '/')
    if ($full.Length -lt 4 -or $full.Length -gt 240) { throw 'Unsafe path length/root' }
    foreach ($part in $full.Substring([IO.Path]::GetPathRoot($full).Length).Split('\')) { if (!$part -or $part -match '[<>:"|?*]' -or $part -match '[. ]$' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'Ambiguous path segment' } }
    return $full
}
function Same-Path([string]$A, [string]$B) { return [string]::Equals((Full-Path $A), (Full-Path $B), [StringComparison]::OrdinalIgnoreCase) }
function Assert-Child([string]$File, [string]$Root) { if (!(Full-Path $File).StartsWith((Full-Path $Root) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escaped permitted directory' } }
function Assert-Plain([string]$Value) {
    $current = Full-Path $Value
    while ($current) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Linked path refused' }
        $parent = [IO.Path]::GetDirectoryName($current)
        if (!$parent -or $parent -eq $current) { break }
        $current = $parent
    }
}
function Initialize-FileIdentity {
    if ($null -ne ('ChartsHubUpdateIdentity' -as [type])) { return }
    Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class ChartsHubUpdateIdentity {
 [StructLayout(LayoutKind.Sequential)] public struct Info { public uint attributes,creationLow,creationHigh,accessLow,accessHigh,writeLow,writeHigh,volume,sizeHigh,sizeLow,links,indexHigh,indexLow; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 public static uint Links(SafeFileHandle h) { Info i; if(!GetFileInformationByHandle(h,out i))throw new System.ComponentModel.Win32Exception(); return i.links; }
}
'@
}
function Open-Regular([string]$File) {
    Assert-Plain $File
    $item = Get-Item -LiteralPath $File -Force
    if ($item.PSIsContainer) { throw 'Regular file required' }
    $stream = [IO.File]::Open($File, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try { Initialize-FileIdentity; if ([ChartsHubUpdateIdentity]::Links($stream.SafeFileHandle) -ne 1) { throw 'Hard-linked file refused' }; return $stream }
    catch { $stream.Dispose(); throw }
}
function Stream-Hash([IO.Stream]$Stream) {
    $Stream.Position = 0; $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $Stream.Position = 0 }
}
function File-Hash([string]$File) { $stream = Open-Regular $File; try { return Stream-Hash $stream } finally { $stream.Dispose() } }
function Assert-Hash([string]$File, [string]$Hash) { if ($Hash -cnotmatch '^[a-f0-9]{64}$' -or (File-Hash $File) -cne $Hash) { throw 'File SHA256 changed' } }
function Read-Json([string]$File, [long]$Limit = 16777216) {
    $stream = Open-Regular $File
    try { if ($stream.Length -gt $Limit) { throw 'Oversized JSON file' }; $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false, $true)); return ($reader.ReadToEnd() | ConvertFrom-Json) }
    finally { $stream.Dispose() }
}
function Read-VerifiedJson([string]$File,[string]$ExpectedHash,[long]$Limit=16777216){
    $stream=Open-Regular $File
    try{
        if($stream.Length -gt $Limit -or $ExpectedHash -cnotmatch '^[a-f0-9]{64}$' -or (Stream-Hash $stream) -cne $ExpectedHash){throw 'Verified JSON SHA256 or size mismatch'}
        # FileShare.Read denies replacement/write until the verified bytes have
        # been parsed. Never consume a second, independently opened version.
        $reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false,$true));return ($reader.ReadToEnd()|ConvertFrom-Json)
    }finally{$stream.Dispose()}
}
function Write-NewJson([string]$File, $Value) {
    Assert-Plain $File
    $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Value -Depth 12 -Compress) + [Environment]::NewLine)
    $stream = [IO.File]::Open($File, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Assert-NoChartsHub {
    if (@(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -match '^ChartsHub(?:[ _-].*)?$' }).Count) { throw 'ChartsHub is still running' }
}
function Tree-Manifest([string]$Root) {
    Assert-Plain $Root
    if (!(Test-Path -LiteralPath $Root -PathType Container)) { throw 'Missing application directory' }
    $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push((Full-Path $Root))
    $directories = [Collections.Generic.List[string]]::new(); $entries = [Collections.Generic.List[object]]::new(); $total = [long]0
    # Complete the name-only guard first; never read Songs/media contents.
    while ($pending.Count) {
        $folder = $pending.Pop(); Assert-Plain $folder
        foreach ($item in Get-ChildItem -LiteralPath $folder -Force) {
            Assert-Child $item.FullName $Root; Assert-Plain $item.FullName
            if ($item.Name -ieq 'Songs' -or $item.Name -imatch '^(song\.ini|notes\.(chart|mid)|.*\.sng)$') { throw 'Songs data inside application; update refused' }
            $relative = $item.FullName.Substring((Full-Path $Root).Length + 1).Replace('\', '/')
            if ($item.PSIsContainer) { $directories.Add($relative); $pending.Push($item.FullName) }
            else { $entries.Add([pscustomobject]@{ path=$relative; length=[long]$item.Length; sha256='' }); $total += $item.Length }
            if ($entries.Count + $directories.Count -gt 50000 -or $total -gt 4GB) { throw 'Application exceeds update limits' }
        }
    }
    foreach ($entry in $entries) { $entry.sha256 = File-Hash (Join-Path $Root $entry.path) }
    return [pscustomobject]@{ directories=@($directories | Sort-Object); files=@($entries | Sort-Object path); fileCount=$entries.Count }
}
function Assert-Manifest($Actual, $Expected) {
    if ($Actual.fileCount -ne $Expected.fileCount -or @($Actual.directories).Count -ne @($Expected.directories).Count -or @($Actual.files).Count -ne @($Expected.files).Count) { throw 'Application tree changed' }
    $seen = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    foreach ($entry in $Actual.files) { $seen.Add($entry.path, $entry) }
    foreach ($entry in $Expected.files) { if (!$seen.ContainsKey($entry.path) -or $seen[$entry.path].length -ne $entry.length -or $seen[$entry.path].sha256 -cne $entry.sha256) { throw 'Application tree changed' } }
    $dirs = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($directory in $Actual.directories) { [void]$dirs.Add($directory) }
    foreach ($directory in $Expected.directories) { if (!$dirs.Contains($directory)) { throw 'Application directories changed' } }
}
function Read-AsarPackage([string]$File) {
    $stream = Open-Regular $File; $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($stream.Length -lt 16) { throw 'Truncated ASAR header' }
        if ($reader.ReadUInt32() -ne 4) { throw 'Invalid ASAR size header' }
        $headerSize = [long]$reader.ReadUInt32(); $payload = [long]$reader.ReadUInt32(); $jsonSize = [long]$reader.ReadUInt32()
        if ($headerSize -lt 8 -or $headerSize -gt 32MB -or 8 + $headerSize -gt $stream.Length -or $payload -ne $headerSize - 4 -or $jsonSize -lt 2 -or $jsonSize -gt $headerSize - 8) { throw 'Invalid ASAR header length' }
        $bytes = $reader.ReadBytes([int]$jsonSize); if ($bytes.Length -ne $jsonSize) { throw 'Truncated ASAR header' }
        $header = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
        $entry = $header.files.PSObject.Properties['package.json'].Value
        if (!$entry -or $entry.PSObject.Properties['link'] -or ($entry.PSObject.Properties['unpacked'] -and ($entry.unpacked -isnot [bool] -or $entry.unpacked)) -or $entry.PSObject.Properties['files'] -or $entry.offset -cnotmatch '^\d+$' -or $entry.size -lt 2 -or $entry.size -gt 2MB) { throw 'Invalid ASAR package entry' }
        $offset = [long]$entry.offset; $size = [long]$entry.size; $start = 8 + $headerSize
        if ($offset -gt $stream.Length - $start - $size) { throw 'ASAR package bounds invalid' }
        $stream.Position = $start + $offset; $package = $reader.ReadBytes([int]$size)
        if ($package.Length -ne $size) { throw 'Truncated ASAR package' }
        return ([Text.Encoding]::UTF8.GetString($package) | ConvertFrom-Json)
    } finally { $reader.Dispose(); $stream.Dispose() }
}
function Expand-ApplicationZip([IO.Stream]$Stream, [string]$Destination) {
    Assert-Plain $Destination
    if (Test-Path -LiteralPath $Destination) { throw 'Extraction destination exists' }
    $Stream.Position = 0; $zip = [IO.Compression.ZipArchive]::new($Stream, [IO.Compression.ZipArchiveMode]::Read, $true)
    try {
        $paths = [Collections.Generic.Dictionary[string,bool]]::new([StringComparer]::OrdinalIgnoreCase); $entries = [Collections.Generic.List[object]]::new(); $total = [long]0
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName; $directory = $name.EndsWith('/'); $relative = $name.TrimEnd('/'); $parts = $relative.Split('/')
            if (!$relative -or $name.Contains('\') -or $parts[0] -cne 'ChartsHub-win32-x64') { throw 'Unexpected ZIP root/path' }
            foreach ($part in $parts) { if (!$part -or $part -in @('.', '..') -or $part -match '[<>:"\\|?*\x00-\x1f]' -or $part -match '[. ]$' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'Ambiguous ZIP path' } }
            if ($parts -icontains 'Songs' -or $parts[-1] -imatch '^(song\.ini|notes\.(chart|mid)|.*\.sng)$') { throw 'Song data in application ZIP' }
            $type = ($entry.ExternalAttributes -shr 16) -band 0xF000
            if (($entry.ExternalAttributes -band 0x400) -or $type -notin @(0, 0x4000, 0x8000) -or ($type -eq 0x4000 -and !$directory) -or ($directory -and $entry.Length -ne 0)) { throw 'Linked/special ZIP entry' }
            if ($paths.ContainsKey($relative)) { throw 'Duplicate ZIP path' }; $paths.Add($relative, $directory)
            $target = Join-Path $Destination $relative; Assert-Child $target $Destination
            $total += $entry.Length; if ($entry.Length -gt 2GB -or $total -gt 4GB -or $entries.Count -ge 50000) { throw 'ZIP expansion exceeds limits' }
            $entries.Add([pscustomobject]@{ entry=$entry; relative=$relative; target=$target; directory=$directory })
        }
        foreach ($item in $entries) { $parts = $item.relative.Split('/'); for ($n=1; $n -lt $parts.Count; $n++) { $ancestor = $parts[0..($n-1)] -join '/'; if ($paths.ContainsKey($ancestor) -and !$paths[$ancestor]) { throw 'ZIP file/directory collision' } } }
        [IO.Directory]::CreateDirectory($Destination) | Out-Null
        foreach ($item in $entries) {
            $parent = if ($item.directory) { $item.target } else { [IO.Path]::GetDirectoryName($item.target) }; Assert-Child $parent $Destination; Assert-Plain $parent; [IO.Directory]::CreateDirectory($parent) | Out-Null
            if (!$item.directory) {
                Assert-Plain $item.target; $inputStream = $item.entry.Open(); $outputStream = $null
                try { $outputStream = [IO.File]::Open($item.target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None); $buffer = New-Object byte[] 65536; $written = [long]0
                    while (($count=$inputStream.Read($buffer,0,$buffer.Length)) -gt 0) { $written += $count; if ($written -gt $item.entry.Length) { throw 'ZIP member exceeds size' }; $outputStream.Write($buffer,0,$count) }
                    if ($written -ne $item.entry.Length) { throw 'Truncated ZIP member' }; $outputStream.Flush($true)
                } finally { if ($outputStream) { $outputStream.Dispose() }; $inputStream.Dispose() }
            }
        }
    } finally { $zip.Dispose(); $Stream.Position = 0 }
}
function Move-Sibling([string]$From, [string]$To, [string]$Parent) {
    if (!(Same-Path ([IO.Path]::GetDirectoryName((Full-Path $From))) $Parent) -or !(Same-Path ([IO.Path]::GetDirectoryName((Full-Path $To))) $Parent)) { throw 'Move is not a sibling rename' }
    Assert-Plain $From; Assert-Plain $To; Assert-NoChartsHub
    if (!(Test-Path -LiteralPath $From -PathType Container) -or (Test-Path -LiteralPath $To)) { throw 'Rename source/destination changed' }
    [IO.Directory]::Move($From,$To)
}
function Copy-ApplicationStage([string]$Source,[string]$Destination,$Manifest){
    Assert-Plain $Source;Assert-Plain $Destination;if(Test-Path -LiteralPath $Destination){throw 'Stage exists'}
    [IO.Directory]::CreateDirectory($Destination)|Out-Null
    foreach($directory in $Manifest.directories){$target=Join-Path $Destination $directory;Assert-Child $target $Destination;Assert-Plain $target;[IO.Directory]::CreateDirectory($target)|Out-Null}
    foreach($entry in $Manifest.files){$target=Join-Path $Destination $entry.path;Assert-Child $target $Destination;Assert-Plain $target;$sourceStream=Open-Regular (Join-Path $Source $entry.path);$output=$null
        try{$output=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$sourceStream.CopyTo($output);$output.Flush($true)}finally{if($output){$output.Dispose()};$sourceStream.Dispose()}
    }
    Assert-Manifest (Tree-Manifest $Destination) $Manifest
}
function Invoke-UpdateTransaction($Config, [scriptblock]$AfterStep = $null) {
    $application=Full-Path $Config.applicationDirectory; $parent=[IO.Path]::GetDirectoryName($application); $job=Full-Path $Config.jobDirectory
    Assert-Plain $application; Assert-Plain $parent; Assert-Plain $job; Assert-NoChartsHub
    Assert-Child $Config.archivePath $Config.cacheDirectory; Assert-Child $job $Config.cacheDirectory
    if ((Same-Path $application $Config.dataDirectory) -or (Full-Path $Config.dataDirectory).StartsWith($application+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'User data is inside application' }
    $backup=$application+'.backup-'+$Config.id; $stage=$application+'.new-'+$Config.id; $incomplete=$application+'.incomplete-'+$Config.id; $extract=Join-Path $job 'extracted'
    foreach ($target in @($backup,$stage,$incomplete,$extract)) { Assert-Plain $target; if (Test-Path -LiteralPath $target) { throw 'Update staging destination exists' } }
    $lockPath=Join-Path $parent '.chartshub-update.lock'; Assert-Plain $lockPath; $lock=$null; $archive=$null; $oldMoved=$false; $newMoved=$false; $newTree=$null
    try {
        $lock=[IO.FileStream]::new($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::DeleteOnClose)
        $archive=Open-Regular $Config.archivePath
        if ($archive.Length -ne $Config.archiveBytes -or (Stream-Hash $archive) -cne $Config.archiveSha256) { throw 'Published archive SHA256 or size mismatch' }
        Assert-Manifest (Tree-Manifest $application) $Config.prior
        $current=Read-AsarPackage (Join-Path $application 'resources/app.asar'); if ($current.name -cne 'chartshub-desktop' -or $current.version -cne $Config.currentVersion) { throw 'Existing application identity/version mismatch' }
        Expand-ApplicationZip $archive $extract
        $build=Join-Path $extract 'ChartsHub-win32-x64'; $package=Read-AsarPackage (Join-Path $build 'resources/app.asar')
        if ($package.name -cne 'chartshub-desktop' -or $package.version -cne $Config.version -or !(Test-Path -LiteralPath (Join-Path $build 'ChartsHub.exe') -PathType Leaf)) { throw 'Release application identity/version mismatch' }
        $newTree=Tree-Manifest $build
        # Copy only to an owned new sibling; verify before touching the current app.
        Copy-ApplicationStage $build $stage $newTree
        Assert-Manifest (Tree-Manifest $stage) $newTree; Assert-Manifest (Tree-Manifest $application) $Config.prior
        if($AfterStep){& $AfterStep 'prepared'}
        Assert-Manifest (Tree-Manifest $stage) $newTree; Assert-Manifest (Tree-Manifest $application) $Config.prior
        Move-Sibling $application $backup $parent; $oldMoved=$true
        if($AfterStep){& $AfterStep 'backed-up'}
        Assert-Manifest (Tree-Manifest $backup) $Config.prior; Assert-Manifest (Tree-Manifest $stage) $newTree
        Move-Sibling $stage $application $parent; $newMoved=$true
        if($AfterStep){& $AfterStep 'installed'}
        Assert-Manifest (Tree-Manifest $application) $newTree; Assert-Manifest (Tree-Manifest $backup) $Config.prior
        if ((Read-AsarPackage (Join-Path $application 'resources/app.asar')).version -cne $Config.version) { throw 'Installed version verification failed' }
        return @{status='complete';version=$Config.version;previousVersion=$Config.currentVersion;backup=$backup;application=$application;previousManifest=$Config.prior;installedManifest=$newTree}
    } catch {
        $failure=$_.Exception.Message; $recovery=$false
        if($oldMoved){
            try {
                Assert-Manifest (Tree-Manifest $backup) $Config.prior
                if($newMoved){Assert-Manifest (Tree-Manifest $application) $newTree;Move-Sibling $application $incomplete $parent}
                elseif(Test-Path -LiteralPath $application){throw 'Concurrent application exists'}
                Move-Sibling $backup $application $parent; Assert-Manifest (Tree-Manifest $application) $Config.prior
            }catch{$recovery=$true}
        }
        if($recovery){throw ('recovery-required: '+$failure)}
        if($oldMoved){throw ('rolled-back: '+$failure)}
        throw $failure
    } finally {
        if($archive){$archive.Dispose()}
        if($lock){$lock.Dispose()}
    }
}
function Invoke-RollbackTransaction($Config,[scriptblock]$AfterStep=$null){
    $application=Full-Path $Config.applicationDirectory;$parent=[IO.Path]::GetDirectoryName($application);$job=Full-Path $Config.jobDirectory
    Assert-Plain $application;Assert-Plain $parent;Assert-Plain $job;Assert-NoChartsHub;Assert-Child $job $Config.cacheDirectory
    if((Same-Path $application $Config.dataDirectory) -or (Full-Path $Config.dataDirectory).StartsWith($application+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'User data is inside application'}
    Assert-Child $Config.sourceJobDirectory $Config.cacheDirectory
    $sourceId=[IO.Path]::GetFileName($Config.sourceJobDirectory)
    if($sourceId -cnotmatch '^install-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$'){throw 'Unrecognized updater backup'}
    $sourcePlanPath=Join-Path $Config.sourceJobDirectory 'plan.json';$sourceReceiptPath=Join-Path $Config.sourceJobDirectory 'result.json'
    $sourcePlan=Read-VerifiedJson $sourcePlanPath $Config.sourcePlanSha256;$sourceReceipt=Read-VerifiedJson $sourceReceiptPath $Config.sourceReceiptSha256
    if((Read-Json (Join-Path $Config.sourceJobDirectory 'ready.json') 1024).planSha256 -cne $Config.sourcePlanSha256 -or (Read-Json (Join-Path $Config.sourceJobDirectory 'authorized.json') 1024).planSha256 -cne $Config.sourcePlanSha256){throw 'Unrecognized updater shutdown proof'}
    if($sourcePlan.schema -ne 2 -or $sourceReceipt.format -cne 'chartshub-update-result' -or $sourceReceipt.schema -ne 2 -or $sourceReceipt.status -cne 'complete' -or $sourceReceipt.kind -cne $sourcePlan.kind -or $sourceReceipt.planSha256 -cne $Config.sourcePlanSha256 -or $sourceReceipt.jobId -cne $sourcePlan.id -or $sourceId -cne ('install-'+$sourcePlan.id) -or !(Same-Path ([IO.Path]::GetDirectoryName((Full-Path $Config.sourceJobDirectory))) $Config.cacheDirectory) -or !(Same-Path $sourcePlan.jobDirectory $Config.sourceJobDirectory) -or !(Same-Path $sourcePlan.cacheDirectory $Config.cacheDirectory) -or !(Same-Path $sourcePlan.dataDirectory $Config.dataDirectory) -or !(Same-Path $sourcePlan.applicationDirectory $application) -or !(Same-Path $sourceReceipt.application $application) -or !(Same-Path $sourceReceipt.backup ($application+'.backup-'+$sourcePlan.id)) -or !(Same-Path $Config.sourceBackup $sourceReceipt.backup) -or $sourceReceipt.version -cne $Config.currentVersion -or $sourceReceipt.previousVersion -cne $Config.version){throw 'Unrecognized updater backup proof'}
    Assert-Hash (Join-Path $Config.sourceJobDirectory 'update-install.ps1') $sourcePlan.helperSha256
    Assert-Manifest $sourceReceipt.previousManifest $sourcePlan.prior;Assert-Manifest $Config.sourceManifest $sourceReceipt.previousManifest;Assert-Manifest $Config.prior $sourceReceipt.installedManifest
    $source=Full-Path $Config.sourceBackup;Assert-Plain $source
    $backup=$application+'.backup-'+$Config.id;$stage=$application+'.new-'+$Config.id;$incomplete=$application+'.incomplete-'+$Config.id
    foreach($target in @($backup,$stage,$incomplete)){Assert-Plain $target;if(Test-Path -LiteralPath $target){throw 'Update staging destination exists'}}
    $lockPath=Join-Path $parent '.chartshub-update.lock';Assert-Plain $lockPath;$lock=$null;$oldMoved=$false;$newMoved=$false
    try{
        $lock=[IO.FileStream]::new($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::DeleteOnClose)
        Assert-Manifest (Tree-Manifest $source) $Config.sourceManifest;Assert-Manifest (Tree-Manifest $application) $Config.prior
        $package=Read-AsarPackage (Join-Path $source 'resources/app.asar');$current=Read-AsarPackage (Join-Path $application 'resources/app.asar')
        if($package.name -cne 'chartshub-desktop' -or $package.version -cne $Config.version -or $current.name -cne 'chartshub-desktop' -or $current.version -cne $Config.currentVersion){throw 'Rollback application identity/version mismatch'}
        Copy-ApplicationStage $source $stage $Config.sourceManifest
        if($AfterStep){& $AfterStep 'prepared'}
        Assert-Hash $sourcePlanPath $Config.sourcePlanSha256;Assert-Hash $sourceReceiptPath $Config.sourceReceiptSha256
        Assert-Manifest (Tree-Manifest $source) $Config.sourceManifest;Assert-Manifest (Tree-Manifest $application) $Config.prior
        Move-Sibling $application $backup $parent;$oldMoved=$true
        if($AfterStep){& $AfterStep 'backed-up'}
        Assert-Manifest (Tree-Manifest $backup) $Config.prior;Assert-Manifest (Tree-Manifest $stage) $Config.sourceManifest
        Move-Sibling $stage $application $parent;$newMoved=$true
        if($AfterStep){& $AfterStep 'installed'}
        Assert-Manifest (Tree-Manifest $application) $Config.sourceManifest;Assert-Manifest (Tree-Manifest $backup) $Config.prior;Assert-Manifest (Tree-Manifest $source) $Config.sourceManifest
        return @{status='complete';version=$Config.version;previousVersion=$Config.currentVersion;backup=$backup;application=$application;previousManifest=$Config.prior;installedManifest=$Config.sourceManifest}
    }catch{
        $failure=$_.Exception.Message;$recovery=$false
        if($oldMoved){try{Assert-Manifest (Tree-Manifest $backup) $Config.prior;if($newMoved){Assert-Manifest (Tree-Manifest $application) $Config.sourceManifest;Move-Sibling $application $incomplete $parent}elseif(Test-Path -LiteralPath $application){throw 'Concurrent application exists'};Move-Sibling $backup $application $parent;Assert-Manifest (Tree-Manifest $application) $Config.prior}catch{$recovery=$true}}
        if($recovery){throw ('recovery-required: '+$failure)};if($oldMoved){throw ('rolled-back: '+$failure)};throw $failure
    }finally{if($lock){$lock.Dispose()}}
}
if ($FunctionsOnly) { return }
if ($PlanSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Exact plan SHA256 required' }
$config=Read-VerifiedJson $Plan $PlanSha256
$required=@('schema','kind','id','applicationDirectory','dataDirectory','cacheDirectory','jobDirectory','currentVersion','version','pid','prior','helperSha256','createdAt')
if($config.kind -ceq 'update'){$required+=@('archivePath','archiveSha256','archiveBytes','commit','tree','releaseId')}elseif($config.kind -ceq 'rollback'){$required+=@('sourceBackup','sourceManifest','sourceJobDirectory','sourcePlanSha256','sourceReceiptSha256')}else{throw 'Invalid update plan kind'}
if (@($config.PSObject.Properties).Count -ne $required.Count -or @($config.PSObject.Properties.Name | Where-Object { $_ -notin $required }).Count -or $config.schema -ne 2 -or $config.id -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or $config.version -cnotmatch '^\d+\.\d+\.\d+$' -or $config.currentVersion -cnotmatch '^\d+\.\d+\.\d+$' -or $config.pid -lt 1) { throw 'Invalid update plan' }
if($config.kind -ceq 'update' -and ($config.archiveSha256 -cnotmatch '^[a-f0-9]{64}$' -or $config.archiveBytes -lt 1 -or $config.archiveBytes -gt 512MB -or $config.commit -cnotmatch '^[a-f0-9]{40}$' -or $config.tree -cnotmatch '^[a-f0-9]{40}$')){throw 'Invalid release archive plan'}
if (($config.kind -ceq 'update' -and [version]$config.version -le [version]$config.currentVersion) -or $config.version -ceq $config.currentVersion -or ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($config.createdAt)).TotalHours -gt 24 -or ([DateTimeOffset]::Parse($config.createdAt) - [DateTimeOffset]::UtcNow).TotalMinutes -gt 5) { throw 'Stale or non-upgrade update plan' }
if (!(Same-Path $config.jobDirectory ([IO.Path]::GetDirectoryName((Full-Path $Plan)))) -or !(Same-Path (Join-Path $config.jobDirectory 'update-install.ps1') $PSCommandPath)) { throw 'Helper/plan directory mismatch' }
if (!(Same-Path $config.cacheDirectory (Join-Path $config.dataDirectory 'updates')) -or !(Same-Path $config.jobDirectory (Join-Path $config.cacheDirectory ('install-'+$config.id))) -or !(Same-Path $Plan (Join-Path $config.jobDirectory 'plan.json')) -or ($config.kind -ceq 'update' -and [IO.Path]::GetFileName($config.archivePath) -cne 'ChartsHub-win32-x64.zip')) { throw 'Unexpected updater-owned path' }
Assert-Child $config.jobDirectory $config.cacheDirectory; Assert-Plain $config.jobDirectory
Assert-Hash $PSCommandPath $config.helperSha256
$ready=Join-Path $config.jobDirectory 'ready.json';$authorize=Join-Path $config.jobDirectory 'authorized.json';$cancel=Join-Path $config.jobDirectory 'cancelled.json';$receipt=Join-Path $config.jobDirectory 'result.json'
Write-NewJson $ready @{planSha256=$PlanSha256}
$authorized=$false
try {
    $deadline=[DateTime]::UtcNow.AddMinutes(2)
    while(Get-Process -Id $config.pid -ErrorAction SilentlyContinue){if(Test-Path -LiteralPath $cancel){throw 'cancelled'};if([DateTime]::UtcNow -gt $deadline){throw 'Normal application shutdown timed out'};Start-Sleep -Milliseconds 250}
    if(Test-Path -LiteralPath $cancel){throw 'cancelled'}
    Assert-Hash $Plan $PlanSha256
    if (!(Test-Path -LiteralPath $authorize) -or (Read-Json $authorize 1024).planSha256 -cne $PlanSha256) { throw 'Normal shutdown was not authorized' }
    $authorized=$true
    $result=if($config.kind -ceq 'rollback'){Invoke-RollbackTransaction $config}else{Invoke-UpdateTransaction $config}
    $result.format='chartshub-update-result';$result.schema=2;$result.jobId=$config.id;$result.kind=$config.kind;$result.planSha256=$PlanSha256
    Write-NewJson $receipt $result
    # The user requested install/restart. The application itself is interactive.
    Start-Process -FilePath (Join-Path $config.applicationDirectory 'ChartsHub.exe') -WorkingDirectory $config.applicationDirectory | Out-Null
} catch {
    $message=$_.Exception.Message
    $outcome=if($message.StartsWith('rolled-back:')){'rolled-back'}elseif($message.StartsWith('recovery-required:')){'recovery-required'}else{'failed'}
    if (!(Test-Path -LiteralPath $receipt)) { Write-NewJson $receipt @{status=$outcome;version=$config.version;error=$message} }
    # Reopen the previous application only when the user authorized this attempt
    # and its complete original tree is still verifiable. Preserve changed trees.
    if($authorized -and $outcome -ne 'recovery-required'){
        try{
            Assert-Manifest (Tree-Manifest $config.applicationDirectory) $config.prior
            $previous=Read-AsarPackage (Join-Path $config.applicationDirectory 'resources/app.asar')
            if($previous.name -cne 'chartshub-desktop' -or $previous.version -cne $config.currentVersion){throw 'Previous version changed'}
            Assert-NoChartsHub
            Start-Process -FilePath (Join-Path $config.applicationDirectory 'ChartsHub.exe') -WorkingDirectory $config.applicationDirectory | Out-Null
        }catch{}
    }
}
