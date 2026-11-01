using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace ChartsHub.CloneHero.Telemetry;

// A comparable ID describes native chart contents plus verified play conditions.
// It never hashes chart files or reads profiles. Plain native checksum values
// alone cannot mix different speeds, modifiers, practice, replay or bot runs.
internal static class NativeSongContext
{
    private static readonly string[] Instruments = { "Guitar", "Bass", "Rhythm", "GuitarCoop", "SixFretGuitar", "SixFretBass", "Drums", "Keys", "Band", "ProDrums", "SixFretRhythm", "SixFretGuitarCoop", "Crowd", "Vocals", "SixFretKeys" };
    private static readonly string[] Difficulties = { "Easy", "Medium", "Hard", "Expert" };
    internal static string? Instrument(byte value) => value < Instruments.Length ? Instruments[value] : null;
    internal static string? Difficulty(sbyte value) => value >= 0 && value < Difficulties.Length ? Difficulties[value] : null;
    internal static bool SameConditions(SongSnapshot a, SongSnapshot b) => a.Entry == b.Entry && a.OriginalSongSpeed == b.OriginalSongSpeed && a.GameMode == b.GameMode && a.PracticeEnabled == b.PracticeEnabled && a.ReplayAnalysis == b.ReplayAnalysis && a.NoteBomber == b.NoteBomber && a.ScoreDisabled == b.ScoreDisabled && (a.NativeChartHash is null || b.NativeChartHash is null || a.NativeChartHash == b.NativeChartHash);
    internal static int? ReadFinalSpeed(nint naturalResultsOwner)
    {
        if (naturalResultsOwner == 0) return null;
        nint collector = Marshal.ReadIntPtr(naturalResultsOwner, 0xE8);
        if (collector == 0) return null;
        int speed = Marshal.ReadInt32(collector, 0x38);
        return speed is >= 10 and <= 5000 ? speed : null;
    }
    internal static string? ComparableId(string adapterId, SongSnapshot? start, SongSnapshot? last, ResultProjection.Result result, int? finalSpeed, bool completeJudgedCoverage, bool conditionsChanged)
    {
        if (!completeJudgedCoverage || conditionsChanged || start is null || last is null || !SameConditions(start, last) || last.NativeChartHash is not { Length: 32 } hash || hash.Any(c => !Uri.IsHexDigit(c)) || hash.All(c => c == '0') || finalSpeed is null || start.OriginalSongSpeed != finalSpeed || last.OriginalSongSpeed != finalSpeed ||
            start.GameMode != 0 || start.PracticeEnabled != false || start.ReplayAnalysis != false || start.NoteBomber != false || start.ScoreDisabled != 0 ||
            result.IsBot || result.Remote || result.NoFail || result.FailedAtMs >= 0 || result.Modifiers != 1 || Instrument(result.Instrument) is null || Difficulty(result.Difficulty) is null) return null;
        // Metadata31 enum constants: Quickplay=0; ScoreDisabled.None=0;
        // Modifiers.None=1 and Unknown=0. No unknown value is treated as None.
        string canonical = string.Join("\n", "chartshub.comparable-chart.v1", adapterId, hash.ToLowerInvariant(),
            finalSpeed.Value.ToString(CultureInfo.InvariantCulture), result.Instrument.ToString(CultureInfo.InvariantCulture), result.Difficulty.ToString(CultureInfo.InvariantCulture),
            "quickplay:0", "practice:0", "replay-analysis:0", "note-bomber:0", "score-disabled:0", "modifiers:1", "no-fail:0", "remote:0", "bot:0", "lefty:" + (result.Lefty ? "1" : "0"));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }
}
