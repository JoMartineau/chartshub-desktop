namespace ChartsHub.CloneHero.Telemetry;

// Every backend/build needs its own reviewed native layout and hook evidence.
// A version label alone never authorizes reading memory. Future/unknown builds
// are intentionally inactive until their exact profile has been validated.
internal static class AdapterRegistry
{
    internal const string Verified6142GameHash = "12bc21e5a88a2fc9abc259d5d67f24835145eabca6c3f863b075ba37ad75f197";
    internal const string Verified6142MetadataHash = "5f14231810f2641639167eb72956e85cced2f36cb4a84682bdefb1e9da3e3d42";
    internal sealed record Hook(string Id, string Type, uint Token, int Arity, int Rva, string Assembly = "Il2CppCloneHero", string Image = "CloneHero.dll", string Namespace = "");
    internal sealed record Layout(int PlayerIndex, int AcceptedOffset, int Engine, int Combo, int Manager, int SongTime, int SongLength, int IsPaused, int IsSongOver, int IsPlaying, int CalibrationStage, int CalibrationGraph);
    internal sealed record Adapter(string Id, string Version, string Backend, string GameHash, string MetadataHash, Layout Memory, IReadOnlyList<Hook> Hooks)
    {
        internal Hook Hook(string id) => Hooks.Single(h => h.Id == id);
    }
    internal static readonly IReadOnlyList<Adapter> Profiles = Array.AsReadOnly(new[] {
        new Adapter("clonehero-windows-x64-il2cpp-1.1.0.6142", "1.1.0.6142", "il2cpp", Verified6142GameHash, Verified6142MetadataHash,
            new(0xA0, 0xC4, 0x120, 0x88, 0x20, 0x70, 0x50, 0x90, 0x91, 0xC0, 0x44, 0x30),
            Array.AsReadOnly(new[] {
                new Hook("accepted-hit", "BasePlayer", 0x060026F4, 1, 0x208780),
                new Hook("practice-reset", "BasePlayer", 0x060026E0, 0, 0x209130),
                new Hook("player-start", "BasePlayer", 0x060026F2, 0, 0x207520),
                new Hook("player-update", "BasePlayer", 0x060026FD, 0, 0x20A1B0),
                new Hook("player-destroy", "BasePlayer", 0x06002701, 0, 0x2074F0),
                new Hook("calibrator-start", "Calibrator", 0x060035D5, 0, 0x2F8F00),
                new Hook("calibration-stage-a", "Calibrator", 0x060035AE, 1, 0x2F9060),
                new Hook("calibration-stage-b", "Calibrator", 0x060035B8, 1, 0x2F94F0),
                new Hook("calibration-stage-c", "Calibrator", 0x060035C7, 1, 0x2FA910),
                new Hook("calibrator-update", "Calibrator", 0x060035B5, 0, 0x2FB0B0),
                new Hook("calibration-sample-a", "LatencySpreadDisplay", 0x060032B6, 1, 0x2D5250),
                new Hook("calibration-sample-b", "LatencySpreadDisplay", 0x060032C2, 1, 0x2D60F0),
                new Hook("native-miss", "ʿʶʴˀʴʾʵʵʶʳʲ", 0x06000293, 1, 0x20F3610, "Il2CppStrikeCore", "StrikeCore.dll"),
                new Hook("player-miss", "BasePlayer", 0x060026E4, 1, 0x208DA0),
                new Hook("player-health", "BasePlayer", 0x06002705, 1, 0x207E60),
                new Hook("manager-update", "GameManager", 0x060013B3, 0, 0xC05A0),
                new Hook("result-outcome", "GameManager", 0x060013E4, 0, 0xBD640),
                new Hook("results-start", "EndOfSong", 0x06001EC6, 0, 0x15DC20),
                new Hook("result-built", "ʹʵʽˁʼʺʷʿʷʲʻ", 0x06001817, 2, 0x112490)
            }))
    });
    internal static Adapter Select(string backend, string gameHash, string metadataHash) => Profiles.SingleOrDefault(p => p.Backend == backend && p.GameHash == gameHash && p.MetadataHash == metadataHash) ?? throw new NotSupportedException("No verified adapter for this game build");
}
