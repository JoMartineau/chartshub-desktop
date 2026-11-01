param([Parameter(Mandatory=$true)][string]$GameRoot,[switch]$Apply)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Installation.Core.psm1') -Force
$gwPreflight=Get-GwPreflight $GameRoot $PSScriptRoot
if(!$Apply -or !$gwPreflight.canInstall){$gwPreflight|ConvertTo-Json -Depth 12;if($Apply -and !$gwPreflight.canInstall){throw 'Optional module installation is blocked; see the read-only preflight issues.'};return}
Invoke-GwInstall $gwPreflight.plan|ConvertTo-Json -Depth 8
