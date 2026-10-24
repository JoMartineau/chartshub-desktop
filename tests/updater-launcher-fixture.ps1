param([Parameter(Mandatory=$true)][string]$Plan,[Parameter(Mandatory=$true)][string]$PlanSha256)
try {
$ErrorActionPreference = 'Stop'
$bytes = [IO.File]::ReadAllBytes($Plan)
$sha = [Security.Cryptography.SHA256]::Create()
try { $actual = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
if ($actual -cne $PlanSha256) { throw 'Fixture plan digest mismatch' }
$data = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
$root = [IO.Path]::GetFullPath((Split-Path -Parent $Plan)) + [IO.Path]::DirectorySeparatorChar
foreach ($name in @('readyPath','releasedAfterControllerExitPath','completedPath')) {
    $resolved = [IO.Path]::GetFullPath([string]$data.$name)
    if (!$resolved.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture path escaped its job' }
}
$ready = @{planSha256=$PlanSha256; helperPid=$PID; marker='ACTUAL_POWERSHELL_SCRIPT_STARTED'} | ConvertTo-Json -Compress
[IO.File]::WriteAllText([string]$data.readyPath,$ready)
$controller = Get-Process -Id ([int]$data.controllerPid) -ErrorAction SilentlyContinue
if ($null -ne $controller -and !$controller.WaitForExit(15000)) { throw 'Fixture controller did not exit normally' }
$deadline = [DateTime]::UtcNow.AddSeconds(10)
while (!(Test-Path -LiteralPath ([string]$data.releasedAfterControllerExitPath) -PathType Leaf)) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Post-exit barrier missing' }
    Start-Sleep -Milliseconds 50
}
if ((Get-Process -Id ([int]$data.controllerPid) -ErrorAction SilentlyContinue)) { throw 'Controller still running' }
$completed = @{planSha256=$PlanSha256; helperPid=$PID; controllerPid=[int]$data.controllerPid; controllerExited=$true; releasedAfterControllerExit=$true; marker='HELPER_EXECUTED_AFTER_CONTROLLER_EXIT'} | ConvertTo-Json -Compress
[IO.File]::WriteAllText([string]$data.completedPath,$completed)

} catch {
    $failure = @{message=$_.Exception.Message; helperPid=$PID; scriptLine=$_.InvocationInfo.ScriptLineNumber} | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path (Split-Path -Parent $Plan) 'helper-error.json'),$failure)
    exit 1
}
