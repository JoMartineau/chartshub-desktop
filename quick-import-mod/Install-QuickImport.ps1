[CmdletBinding(DefaultParameterSetName='Manual')]
param(
    [Parameter(Mandatory, ParameterSetName='Manual')][string]$GameRoot,
    [Parameter(Mandatory, ParameterSetName='Manual')][string]$SongsRoot,
    [Parameter(Mandatory, ParameterSetName='Manual')][string]$LoaderZip,
    [Parameter(ParameterSetName='Manual')][switch]$EnableBeta,
    [Parameter(ParameterSetName='Manual')][switch]$Apply,
    [Parameter(Mandatory, ParameterSetName='Guided')][switch]$Guided,
    [Parameter(ParameterSetName='Guided')][ValidateSet('fr','en')][string]$Language='en',
    [Parameter(ParameterSetName='Guided')][string]$InitialGameRoot,
    [Parameter(ParameterSetName='Guided')][string]$SongsHint
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Installation.Core.psm1') -Force

if ($PSCmdlet.ParameterSetName -eq 'Manual') {
    $plan = New-QiInstallPlan $GameRoot $SongsRoot $PSScriptRoot $LoaderZip ([bool]$EnableBeta)
    if ($Apply) { Invoke-QiInstall $plan | ConvertTo-Json -Depth 8 }
    else { $plan | ConvertTo-Json -Depth 12 }
    return
}

if (!$Guided -or [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
    [Threading.Thread]::CurrentThread.GetApartmentState() -ne [Threading.ApartmentState]::STA) {
    throw 'Launch guided setup from Windows PowerShell with -STA.'
}

Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$labels = if ($Language -eq 'fr') {
    @{
        game = 'Choisissez Clone Hero.exe dans le dossier du jeu'
        songs = 'Choisissez le dossier Songs déjà configuré dans Clone Hero'
        confirm = "Jeu : {0}`nSongs : {1}`n`nOui : télécharger MelonLoader, installer et activer Quick Import BÊTA.`nNon : choisir un autre dossier Songs.`nAnnuler : quitter."
        success = 'Quick Import est installé. Ouvrez Clone Hero, puis connectez le jeu dans ChartsHub.'
        failure = "L’installation Quick Import s’est arrêtée."
        alreadyInstalled = "Une installation Quick Import existe déjà dans ce jeu. Ouvrez Clone Hero et connectez cette installation dans ChartsHub. Pour la réinstaller, utilisez d’abord le script de désinstallation."
    }
} else {
    @{
        game = 'Select Clone Hero.exe in the game folder'
        songs = 'Select the Songs folder already configured in Clone Hero'
        confirm = "Game: {0}`nSongs: {1}`n`nYes: download MelonLoader, install and enable Quick Import BETA.`nNo: choose a different Songs folder.`nCancel: exit."
        success = 'Quick Import is installed. Open Clone Hero, then connect the game in ChartsHub.'
        failure = 'Quick Import setup stopped.'
        alreadyInstalled = 'Quick Import already exists in this game. Open Clone Hero and connect this installation in ChartsHub. To reinstall, run the removal script first.'
    }
}

function Select-QiSetupFile([string]$Title, [string]$Filter, [string]$SuggestedDirectory) {
    $dialog = New-Object Windows.Forms.OpenFileDialog
    try {
        $dialog.Title = $Title
        $dialog.Filter = $Filter
        $dialog.CheckFileExists = $true
        $dialog.RestoreDirectory = $true
        if ($SuggestedDirectory -and [IO.Directory]::Exists($SuggestedDirectory)) {
            $dialog.InitialDirectory = $SuggestedDirectory
        }
        if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { $dialog.FileName }
    } finally { $dialog.Dispose() }
}

function Select-QiSongsFolder([string]$Title, [string]$Suggested) {
    $dialog = New-Object Windows.Forms.FolderBrowserDialog
    try {
        $dialog.Description = $Title
        $dialog.ShowNewFolderButton = $false
        if ($Suggested) { $dialog.SelectedPath = $Suggested }
        if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }
    } finally { $dialog.Dispose() }
}

$archiveOwned = $false
try {
    $gameExe = Select-QiSetupFile $labels.game 'Clone Hero.exe|Clone Hero.exe' $InitialGameRoot
    if (!$gameExe) { return }
    if ([IO.Path]::GetFileName($gameExe) -ine 'Clone Hero.exe') { throw $labels.game }
    $gameDirectory = [IO.Path]::GetDirectoryName($gameExe)
    Assert-QiProgram $gameDirectory
    Assert-QiClosed $gameDirectory
    if ([IO.File]::Exists((Join-Path $gameDirectory 'UserData/ChartsHubQuickImport/install-receipt.json'))) {
        [void][Windows.Forms.MessageBox]::Show($labels.alreadyInstalled, 'ChartsHub Quick Import', 'OK', 'Information')
        return
    }

    $documents = [Environment]::GetFolderPath('MyDocuments')
    try { $songsDirectory = Find-QiSongsRoot $gameDirectory $documents $SongsHint }
    catch { $songsDirectory = $null }
    while ($true) {
        if (!$songsDirectory) {
            $songsDirectory = Select-QiSongsFolder $labels.songs
            if (!$songsDirectory) { return }
        }
        Assert-QiNoLinks $songsDirectory
        $review = $labels.confirm -f $gameDirectory, $songsDirectory
        $response = [Windows.Forms.MessageBox]::Show($review, 'ChartsHub Quick Import', 'YesNoCancel', 'Question', 'Button3')
        if ($response -eq [Windows.Forms.DialogResult]::Yes) { break }
        if ($response -ne [Windows.Forms.DialogResult]::No) { return }
        $songsDirectory = Select-QiSongsFolder $labels.songs $songsDirectory
        if (!$songsDirectory) { return }
    }

    $archivePath = Join-Path ([IO.Path]::GetTempPath()) ('ChartsHub-QuickImport-' + [Guid]::NewGuid().ToString('N') + '.zip')
    Assert-QiNoLinks $archivePath
    $destination = [IO.File]::Open($archivePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $archiveOwned = $true
    try { Receive-QiLoaderArchive $destination }
    finally { $destination.Dispose() }

    $archiveLock = [IO.File]::Open($archivePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $plan = New-QiInstallPlan $gameDirectory $songsDirectory $PSScriptRoot $archivePath $true
        $installed = Invoke-QiInstall $plan
        $installed | Add-Member -NotePropertyName gameRoot -NotePropertyValue $plan.gameRoot
        $installed | Add-Member -NotePropertyName songsRoot -NotePropertyValue $plan.songsRoot
        $installed | ConvertTo-Json -Depth 8 -Compress
    } finally { $archiveLock.Dispose() }
    [void][Windows.Forms.MessageBox]::Show($labels.success, 'ChartsHub Quick Import', 'OK', 'Information')
} catch {
    [void][Windows.Forms.MessageBox]::Show($labels.failure + "`n`n" + $_.Exception.Message, 'ChartsHub Quick Import', 'OK', 'Error')
    throw
} finally {
    if ($archiveOwned) {
        Assert-QiNoLinks $archivePath
        [IO.File]::Delete($archivePath)
    }
}
