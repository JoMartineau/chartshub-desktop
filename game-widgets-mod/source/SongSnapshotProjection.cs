using System.Runtime.InteropServices;

namespace ChartsHub.CloneHero.Telemetry;

internal sealed record SongSnapshot(nint Entry, string? NativeChartHash, string? Title, string? Artist,
    string? Album, string? Charter, int? OriginalSongSpeed, int? GameMode, bool? PracticeEnabled,
    bool? ReplayAnalysis, bool? NoteBomber, int? ScoreDisabled);

// Exact 6142 layout only, behind the provider's GameAssembly + metadata guards.
// Reads already populated native fields; never calls getters, hashes, or song I/O.
// The selected player's live manager must be observed before its destruction.
internal static class SongSnapshotProjection
{
    internal static SongSnapshot? Read(nint manager)
    {
        if (manager == 0) return null;
        try
        {
            nint globals = Marshal.ReadIntPtr(manager, 0x28);
            if (globals == 0) return null;
            nint entry = Marshal.ReadIntPtr(globals, 0x28);
            if (entry == 0) return null;
            string? nativeHash = ReadText(Marshal.ReadIntPtr(entry, 0x48));
            if (nativeHash is not { Length: 32 } || nativeHash.Any(c => !Uri.IsHexDigit(c)) || nativeHash.All(c => c == '0')) nativeHash = null;
            else nativeHash = nativeHash.ToLowerInvariant();
            string? title = null, artist = null, album = null, charter = null;
            if (ReadBool(entry, 0xB0) == true)
            {
                nint metadata = Marshal.ReadIntPtr(entry, 0x88);
                if (metadata != 0)
                {
                    long length = Marshal.ReadInt64(metadata, 0x18);
                    if (length is >= 6 and <= 64)
                    {
                        title = MetadataText(metadata, 0);
                        artist = MetadataText(metadata, 1);
                        album = MetadataText(metadata, 2);
                        charter = MetadataText(metadata, 5);
                    }
                }
            }
            int speed = Marshal.ReadInt32(globals, 0x5C), mode = Marshal.ReadInt32(globals, 0x50), disabled = Marshal.ReadInt32(globals, 0x7C);
            return new(entry, nativeHash, title, artist, album, charter, speed is >= 10 and <= 5000 ? speed : null,
                mode >= 0 ? mode : null, ReadBool(globals, 0x72), ReadBool(globals, 0x73), ReadBool(globals, 0x79), disabled >= 0 ? disabled : null);
        }
        catch { return null; }
    }

    private static bool? ReadBool(nint pointer, int offset) => Marshal.ReadByte(pointer, offset) switch { 0 => false, 1 => true, _ => null };
    private static string? MetadataText(nint array, int index)
    {
        nint value = Marshal.ReadIntPtr(array, 0x20 + index * 8);
        return value == 0 ? null : ReadText(Marshal.ReadIntPtr(value, 0x10));
    }

    private static string? ReadText(nint text)
    {
        if (text == 0) return null;
        int length = Marshal.ReadInt32(text, 0x10);
        if (length is < 1 or > 512) return null;
        string? value = Marshal.PtrToStringUni(text + 0x14, length);
        if (value is null || value.Any(char.IsControl) || string.IsNullOrWhiteSpace(value)) return null;
        for (int i = 0; i < value.Length; i++)
        {
            if (char.IsHighSurrogate(value[i])) { if (++i >= value.Length || !char.IsLowSurrogate(value[i])) return null; }
            else if (char.IsLowSurrogate(value[i])) return null;
        }
        return value;
    }
}
