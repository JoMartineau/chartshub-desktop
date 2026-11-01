$ErrorActionPreference='Stop'
$nativeRoot=$PSScriptRoot
$outputRoot=Join-Path $nativeRoot 'out'
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$executable=Join-Path $nativeRoot 'bin/ChartsHubDrumHost.exe'
$plugin=Join-Path $nativeRoot 'build/VST3/ChartsHubDrumTest.vst3'
if(-not(Test-Path -LiteralPath $executable)-or -not(Test-Path -LiteralPath $plugin)){throw 'Build the helper and synthetic test instrument first.'}
$report=Join-Path $outputRoot 'offline-self-test.json'
$stderr=Join-Path $outputRoot 'offline-self-test.stderr'
# Only the offline mode is allowed here. Never enumerate/open audio or input.
$child=Start-Process -FilePath $executable -ArgumentList @('--self-test',('"'+$plugin+'"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput $report -RedirectStandardError $stderr
if(-not $child.WaitForExit(15000)){$child.Kill();throw 'Offline VST3 test timed out'}
$child.WaitForExit()
if($child.ExitCode -ne 0){throw 'Offline VST3 test failed'}
$offline=Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
if($offline.ok -ne $true -or $offline.checks.Count -ne 14 -or (Get-Item -LiteralPath $stderr).Length -ne 0){throw 'Invalid offline verification report'}
foreach($field in @('audioDeviceOpened','midiDeviceOpened','xinputStateRead','gameRead','profileRead')){if($offline.$field -ne $false){throw 'Offline test accessed a forbidden source'}}
$nodeExe=@(Get-Command node.exe -ErrorAction Stop)[0].Source
& $nodeExe (Join-Path $nativeRoot 'tests/protocol-test.cjs')
if($LASTEXITCODE -ne 0){throw 'Native JSON protocol verification failed'}
$protocol=Get-Content -LiteralPath (Join-Path $outputRoot 'protocol-test.json') -Raw | ConvertFrom-Json
if($protocol.ok -ne $true -or $protocol.checks.Count -ne 11){throw 'Invalid native protocol report'}
$proof=[ordered]@{schema=1;ok=$true;offlineChecks=$offline.checks.Count;protocolChecks=$protocol.checks.Count;totalChecks=25;helperSha256=$protocol.helperSha256;audioDeviceOpened=$false;midiDeviceOpened=$false;xinputStateRead=$false;gameRead=$false;profileRead=$false;realAudioAndObsValidated=$false}
$json=$proof | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $outputRoot 'native-verification.json'),$json,[Text.UTF8Encoding]::new($false))
Write-Output $json
