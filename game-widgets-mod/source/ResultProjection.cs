using System.Runtime.InteropServices;

namespace ChartsHub.CloneHero.Telemetry;

// Exact-build primitive projection. No file I/O, strings, profiles, settings,
// serializers or game function calls. Values may be tested with owned memory.
internal static class ResultProjection
{
    internal sealed record Result(int Score, int NotesHit, int NotesTotal, int Combo, int MaxCombo, int Overstrums, bool NativeFc, bool IsBot, int FailedAtMs, byte Instrument, sbyte Difficulty, int Modifiers, bool Remote, bool Lefty, bool NoFail);
    internal sealed record Engine(int Score, int NotesHit, int Combo, int Overstrums);
    internal static bool Count(int value) => value is >= 0 and <= 10_000_000;
    internal static bool FreshMiss(ushort before, ushort after) => (before & 3) == 0 && (after & 3) == 2;
    internal static bool? Outcome(bool alreadyOver, bool fromSelectedHealthFailure, bool inNativeUpdate, double position, double duration)
    {
        if (alreadyOver) return null;
        if (fromSelectedHealthFailure) return false;
        if (inNativeUpdate && double.IsFinite(position) && double.IsFinite(duration) && duration > 0 && duration <= 86400 && position >= duration && position <= duration + 5) return true;
        return null; // A generic results phase never proves full completion.
    }
    internal static Engine ReadEngine(nint pointer)
    {
        if (pointer == 0) throw new InvalidOperationException("No engine");
        // This is also the native engine total-score getter at RVA0x20f3d30.
        int baseScore = Marshal.ReadInt32(pointer, 0x94), starPowerScore = Marshal.ReadInt32(pointer, 0xA0), bonusScore = Marshal.ReadInt32(pointer, 0xA4);
        long scoreSum = (long)baseScore + starPowerScore + bonusScore;
        if (baseScore < 0 || starPowerScore < 0 || bonusScore < 0 || scoreSum > int.MaxValue) throw new InvalidOperationException("Invalid native score components");
        int score = (int)scoreSum;
        int hit = Marshal.ReadInt32(pointer, 0x9C), combo = Marshal.ReadInt32(pointer, 0x88), overstrums = Marshal.ReadInt32(pointer, 0xB0);
        if (score < 0 || !Count(hit) || !Count(combo) || combo > hit || !Count(overstrums)) throw new InvalidOperationException("Invalid engine projection");
        return new(score, hit, combo, overstrums);
    }
    internal static Result ReadResult(nint pointer)
    {
        if (pointer == 0) throw new InvalidOperationException("No result");
        int score = Marshal.ReadInt32(pointer, 0x34), hit = Marshal.ReadInt32(pointer, 0x58), total = Marshal.ReadInt32(pointer, 0x5C), maxCombo = Marshal.ReadInt32(pointer, 0x60), combo = Marshal.ReadInt32(pointer, 0x64), overstrums = Marshal.ReadInt32(pointer, 0x68), failedAt = Marshal.ReadInt32(pointer, 0xB8);
        byte fc = Marshal.ReadByte(pointer, 0xB4), bot = Marshal.ReadByte(pointer, 0xB6), instrument = Marshal.ReadByte(pointer, 0x10), remote = Marshal.ReadByte(pointer, 0x24), lefty = Marshal.ReadByte(pointer, 0x25), noFail = Marshal.ReadByte(pointer, 0x26);
        int modifiers = Marshal.ReadInt32(pointer, 0x20);
        sbyte difficulty = unchecked((sbyte)Marshal.ReadByte(pointer, 0x11));
        if (score < 0 || !Count(hit) || !Count(total) || hit > total || !Count(combo) || !Count(maxCombo) || combo > maxCombo || maxCombo > hit || !Count(overstrums) || fc > 1 || bot > 1 || remote > 1 || lefty > 1 || noFail > 1 || modifiers < 0 || failedAt < -1 || failedAt > 86_400_000 || difficulty is < -1 or > 3)
            throw new InvalidOperationException("Invalid result projection");
        return new(score, hit, total, combo, maxCombo, overstrums, fc == 1, bot == 1, failedAt, instrument, difficulty, modifiers, remote == 1, lefty == 1, noFail == 1);
    }
}
