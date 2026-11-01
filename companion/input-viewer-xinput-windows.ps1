$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Only documented Windows XInput APIs are imported. Capabilities do not read
# played inputs. GetState is called only after an explicit select command.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
public static class ChartsHubInputViewerXInput {
    [StructLayout(LayoutKind.Sequential)] public struct Gamepad {
        public ushort Buttons;
        public byte LeftTrigger, RightTrigger;
        public short LeftX, LeftY, RightX, RightY;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Vibration { public ushort Left, Right; }
    [StructLayout(LayoutKind.Sequential)] public struct Capabilities {
        public byte Type, SubType;
        public ushort Flags;
        public Gamepad Gamepad;
        public Vibration Vibration;
    }
    [StructLayout(LayoutKind.Sequential)] public struct State { public uint Packet; public Gamepad Gamepad; }
    [DllImport("XInput1_4.dll", EntryPoint="XInputGetCapabilities")]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    public static extern uint GetCapabilities(uint slot, uint flags, out Capabilities capabilities);
    [DllImport("XInput1_4.dll", EntryPoint="XInputGetState")]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    public static extern uint GetState(uint slot, out State state);
    // Console.In.ReadLineAsync is synchronous in some .NET Framework readers.
    // A single background read task avoids blocking the bounded polling loop.
    public static Task<string> ReadCommand() { return Task.Run(() => Console.In.ReadLine()); }
}
'@

function Write-Message($Message) {
    [Console]::Out.WriteLine(($Message | ConvertTo-Json -Compress -Depth 5))
    [Console]::Out.Flush()
}

function Get-Devices {
    $found = @()
    foreach ($slot in 0..3) {
        $capabilities = New-Object ChartsHubInputViewerXInput+Capabilities
        if ([ChartsHubInputViewerXInput]::GetCapabilities([uint32]$slot, 0, [ref]$capabilities) -eq 0) {
            $found += @{ slot = $slot; type = [int]$capabilities.Type; subtype = [int]$capabilities.SubType; flags = [int]$capabilities.Flags }
        }
    }
    return ,$found
}

$clock = [Diagnostics.Stopwatch]::StartNew()
$lastHeartbeat = $clock.ElapsedMilliseconds
$lastEnumeration = -1000
$selectedSlot = $null
$selection = 0
$knownSlots = @()
$devicesSignature = $null
$readTask = [ChartsHubInputViewerXInput]::ReadCommand()

try {
    while ($true) {
        $elapsed = $clock.ElapsedMilliseconds
        if ($elapsed - $lastHeartbeat -gt 5000) { break }
        if ($readTask.IsCompleted) {
            $commandLine = $readTask.GetAwaiter().GetResult()
            if ($null -eq $commandLine -or $commandLine.Length -gt 256) { break }
            try { $command = $commandLine | ConvertFrom-Json -ErrorAction Stop } catch { break }
            if ($null -eq $command -or $command -is [Array]) { break }
            $keys = @($command.PSObject.Properties.Name)
            if ($command.command -eq 'stop' -and $keys.Count -eq 1) { break }
            if ($command.command -eq 'ping' -and $keys.Count -eq 1) {
                $lastHeartbeat = $elapsed
                Write-Message @{ event = 'heartbeat' }
            } elseif ($command.command -eq 'select' -and $keys.Count -eq 3 -and $keys -contains 'slot' -and $keys -contains 'selection') {
                if ($command.selection -isnot [int] -and $command.selection -isnot [long]) { break }
                if ($command.selection -le $selection -or $command.selection -gt 2147483647) { break }
                if ($null -ne $command.slot -and (($command.slot -isnot [int] -and $command.slot -isnot [long]) -or $command.slot -lt 0 -or $command.slot -gt 3 -or $knownSlots -notcontains $command.slot)) { break }
                $selection = [int]$command.selection
                $selectedSlot = $command.slot
            } else { break }
            $readTask = [ChartsHubInputViewerXInput]::ReadCommand()
        }

        if ($elapsed - $lastEnumeration -ge 1000) {
            $lastEnumeration = $elapsed
            $devices = Get-Devices
            $knownSlots = @($devices | ForEach-Object { $_.slot })
            $signature = ConvertTo-Json -InputObject @($devices) -Compress -Depth 3
            if ($signature -ne $devicesSignature) {
                $devicesSignature = $signature
                Write-Message @{ event = 'devices'; devices = @($devices) }
            }
            if ($null -ne $selectedSlot -and $knownSlots -notcontains $selectedSlot) {
                Write-Message @{ event = 'disconnected'; slot = $selectedSlot; selection = $selection }
                $selectedSlot = $null
            }
        }

        if ($null -ne $selectedSlot) {
            $state = New-Object ChartsHubInputViewerXInput+State
            if ([ChartsHubInputViewerXInput]::GetState([uint32]$selectedSlot, [ref]$state) -eq 0) {
                Write-Message @{ event = 'sample'; selection = $selection; slot = $selectedSlot; packet = [long]$state.Packet;
                    buttons = [int]$state.Gamepad.Buttons; leftTrigger = [int]$state.Gamepad.LeftTrigger; rightTrigger = [int]$state.Gamepad.RightTrigger;
                    leftX = [int]$state.Gamepad.LeftX; leftY = [int]$state.Gamepad.LeftY; rightX = [int]$state.Gamepad.RightX; rightY = [int]$state.Gamepad.RightY }
            } else {
                Write-Message @{ event = 'disconnected'; slot = $selectedSlot; selection = $selection }
                $selectedSlot = $null
            }
        }
        Start-Sleep -Milliseconds 16
    }
} finally {
    $selectedSlot = $null
    $clock.Stop()
}
