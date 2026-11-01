param([Parameter(Mandatory=$true)][string]$GameRoot,[switch]$Apply)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Installation.Core.psm1') -Force
$gwPlan=New-GwUninstallPlan $GameRoot
if(!$Apply){$gwPlan|ConvertTo-Json -Depth 8;return}
Invoke-GwUninstall $gwPlan|ConvertTo-Json -Depth 8
