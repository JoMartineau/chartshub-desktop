# Fixed, read-only metadata probe. No parameters, streams, recordings or settings writes.
# The caller must bound runtime/output and treat unavailable metadata as normal.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$audio = [ordered]@{
    outputName = $null
    sampleRateHz = $null
    channels = $null
    defaultPeriodMs = $null
    minimumPeriodMs = $null
    status = 'unavailable'
}
$inputs = @()

function Get-SafeFriendlyName([string]$value) {
    if ([string]::IsNullOrWhiteSpace($value)) { return $null }
    # Friendly labels only: never expose device paths, PnP IDs or serial-like tokens.
    $safe = $value -replace '[\x00-\x1f\x7f]', ' '
    $safe = $safe -replace '(?i)(USB|HID|BTHENUM|BTHLEDEVICE|SWD|PCI|ROOT)\\[^\s]+', ''
    $safe = $safe -replace '(?i)\b(?:VID|PID|REV|MI)_[0-9a-f]+\b', ''
    $safe = $safe -replace '(?i)\b(?:serial|s/n|sn)\s*[:=#]?\s*[a-z0-9-]+\b', ''
    $safe = $safe -replace '(?i)\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?', ''
    $safe = $safe -replace '(?i)\b[0-9a-f]{12,}\b', ''
    $safe = ($safe -replace '\s+', ' ').Trim()
    if ($safe.Length -gt 120) { $safe = $safe.Substring(0, 120).Trim() }
    if ($safe.Length -eq 0) { return $null }
    return $safe
}

try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace ChartsHub.ReadOnlyCalibration {
    public sealed class AudioMetadata {
        public string outputName = null;
        public int? sampleRateHz = null;
        public int? channels = null;
        public double? defaultPeriodMs = null;
        public double? minimumPeriodMs = null;
        public string status = "unavailable";
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PropertyKey {
        public Guid formatId;
        public uint propertyId;
        public PropertyKey(Guid id, uint value) { formatId = id; propertyId = value; }
    }

    // PROPVARIANT is 24 bytes on x64; only VT_LPWSTR is read here.
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    internal struct PropertyValue {
        [FieldOffset(0)] public ushort type;
        [FieldOffset(8)] public IntPtr pointer;
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class DeviceEnumeratorObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IDeviceEnumerator {
        [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr callback);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr callback);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IDevice {
        [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        [PreserveSig] int OpenPropertyStore(uint access, out IPropertyStore store);
        [PreserveSig] int GetId(out IntPtr id);
        [PreserveSig] int GetState(out uint state);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropertyValue value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropertyValue value);
        [PreserveSig] int Commit();
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioClient {
        // Unused vtable slots are required to reach the two metadata methods below.
        [PreserveSig] int Initialize(int mode, uint flags, long duration, long periodicity, IntPtr format, IntPtr session);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int mode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    }

    public static class OutputProbe {
        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref PropertyValue value);

        private static void Release(object value) {
            if (value != null && Marshal.IsComObject(value)) {
                try { Marshal.ReleaseComObject(value); } catch { }
            }
        }

        public static AudioMetadata Read() {
            AudioMetadata result = new AudioMetadata();
            IDeviceEnumerator enumerator = null;
            IDevice device = null;
            IPropertyStore store = null;
            object clientObject = null;
            IntPtr format = IntPtr.Zero;
            try {
                enumerator = (IDeviceEnumerator)new DeviceEnumeratorObject();
                // eRender = 0; eConsole = 0. This is a Windows default, not the game's route.
                if (enumerator.GetDefaultAudioEndpoint(0, 0, out device) < 0 || device == null) return result;
                result.status = "available";
                if (device.OpenPropertyStore(0, out store) >= 0 && store != null) {
                    PropertyKey nameKey = new PropertyKey(new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), 14);
                    PropertyValue nameValue = new PropertyValue();
                    try {
                        if (store.GetValue(ref nameKey, out nameValue) >= 0 && nameValue.type == 31 && nameValue.pointer != IntPtr.Zero) {
                            result.outputName = Marshal.PtrToStringUni(nameValue.pointer);
                        }
                    } finally { PropVariantClear(ref nameValue); }
                }
                Guid clientId = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
                if (device.Activate(ref clientId, 1, IntPtr.Zero, out clientObject) >= 0 && clientObject != null) {
                    IAudioClient client = (IAudioClient)clientObject;
                    // These calls are valid before Initialize. No audio session is created.
                    if (client.GetMixFormat(out format) >= 0 && format != IntPtr.Zero) {
                        int channels = (ushort)Marshal.ReadInt16(format, 2);
                        int rate = Marshal.ReadInt32(format, 4);
                        if (channels >= 1 && channels <= 64) result.channels = channels;
                        if (rate >= 8000 && rate <= 768000) result.sampleRateHz = rate;
                    }
                    long defaultPeriod, minimumPeriod;
                    if (client.GetDevicePeriod(out defaultPeriod, out minimumPeriod) >= 0) {
                        // REFERENCE_TIME is 100 ns. These are engine periods, not physical latency.
                        if (defaultPeriod > 0 && defaultPeriod <= 10000000) result.defaultPeriodMs = defaultPeriod / 10000.0;
                        if (minimumPeriod > 0 && minimumPeriod <= 10000000) result.minimumPeriodMs = minimumPeriod / 10000.0;
                    }
                }
            } catch { /* Leave individual metadata fields unavailable. */ }
            finally {
                if (format != IntPtr.Zero) Marshal.FreeCoTaskMem(format);
                Release(clientObject);
                Release(store);
                Release(device);
                Release(enumerator);
            }
            return result;
        }
    }
}
'@ -ErrorAction Stop | Out-Null
    $result = [ChartsHub.ReadOnlyCalibration.OutputProbe]::Read()
    $audio.outputName = Get-SafeFriendlyName $result.outputName
    $audio.sampleRateHz = $result.sampleRateHz
    $audio.channels = $result.channels
    $audio.defaultPeriodMs = $result.defaultPeriodMs
    $audio.minimumPeriodMs = $result.minimumPeriodMs
    $audio.status = $result.status
} catch { }

try {
    # Read only current friendly names. A candidate is not evidence of what Clone Hero uses.
    $devices = Get-CimInstance -ClassName Win32_PnPEntity -Filter "Status = 'OK' AND (PNPClass = 'Keyboard' OR PNPClass = 'HIDClass' OR PNPClass = 'USB' OR PNPClass = 'XboxComposite')" -Property Name, PNPClass -OperationTimeoutSec 3 -ErrorAction Stop
    $seen = @{}
    foreach ($device in $devices) {
        if ($device.PNPClass -ne 'Keyboard' -and $device.Name -notmatch '(?i)guitar|guitare|rock band|game.?controller|gamepad|xinput|xbox|playstation|dualsense|dualshock|raphnet|riffmaster|clavier|keyboard') { continue }
        $name = Get-SafeFriendlyName ([string]$device.Name)
        if ($null -eq $name -or $seen.ContainsKey($name)) { continue }
        $seen[$name] = $true
        $inputs += [ordered]@{ name = $name; kind = 'candidate' }
        if ($inputs.Count -ge 16) { break }
    }
} catch { }

[ordered]@{ audio = $audio; inputs = @($inputs) } | ConvertTo-Json -Depth 4 -Compress
