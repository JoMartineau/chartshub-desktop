param([Parameter(Mandatory=$true)][string]$GameRoot,[Parameter(Mandatory=$true)][string]$SongsRoot,[Parameter(Mandatory=$true)][string]$LoaderZip,[switch]$EnableBeta,[switch]$Apply)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Installation.Core.psm1') -Force
$qiPlan=New-QiInstallPlan $GameRoot $SongsRoot $PSScriptRoot $LoaderZip ([bool]$EnableBeta)
if(!$Apply){$qiPlan|ConvertTo-Json -Depth 12;return}
Invoke-QiInstall $qiPlan|ConvertTo-Json -Depth 8
