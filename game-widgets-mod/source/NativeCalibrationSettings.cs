using System.Runtime.InteropServices;

namespace ChartsHub.CloneHero.Telemetry;

// Exact 6142 native flow: active Audio/Video completion loads the Settings193
// class pointer from GameAssembly RVA0x3C98320, then static_fields+0xB8 and its
// Audio+0x18/Video+0x20 config object. The native setter stores int milliseconds
// at config+0x10 before committing AudioFinished2/VideoFinished4.
// This reads populated native fields only; no generated initializer, game
// getter, setter, class initialization, formula or hardware estimate is called.
internal static class NativeCalibrationSettings
{
    internal const int SettingsClassPointerRva = 0x3C98320;
    internal static int? Read(nint nativeBase, int beforeStage)
    {
        if (nativeBase == 0 || beforeStage is not (1 or 3)) return null;
        nint klass = Marshal.ReadIntPtr(nativeBase + SettingsClassPointerRva);
        if (klass == 0) return null;
        nint statics = Marshal.ReadIntPtr(klass, 0xB8);
        if (statics == 0) return null;
        nint config = Marshal.ReadIntPtr(statics, beforeStage == 1 ? 0x18 : 0x20);
        if (config == 0) return null;
        int value = Marshal.ReadInt32(config, 0x10);
        return value is >= -2000 and <= 2000 ? value : null;
    }
}
