param([Parameter(Mandatory=$true)][string]$GameRoot,[switch]$Apply)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Installation.Core.psm1') -Force
$qiPlan=New-QiUninstallPlan $GameRoot
if(!$Apply){$qiPlan|ConvertTo-Json -Depth 12;return}
Invoke-QiUninstall $qiPlan|ConvertTo-Json -Depth 8
