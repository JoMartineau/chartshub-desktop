using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using HarmonyLib;
using Il2CppInterop.Runtime.InteropTypes;
using MelonLoader;

[assembly: MelonInfo(typeof(ChartsHub.CloneHero.Telemetry.Provider), "ChartsHub Accuracy Connector", "0.2.2", "ChartsHub")]
[assembly: MelonGame(null, null)]
[assembly: SupportedOSPlatform("windows")]

namespace ChartsHub.CloneHero.Telemetry;

// Workspace prototype. Never installs a loader, modifies game settings or files,
// invokes input/scoring methods, or claims support for an unverified fingerprint.
public sealed partial class Provider : MelonMod
{
    internal const string GameHash = AdapterRegistry.Verified6142GameHash;
    internal const string MetadataHash = AdapterRegistry.Verified6142MetadataHash;
    internal static readonly object ProviderIdentity = new { id = "chartshub.clonehero.il2cpp", version = "0.2.2" };
    internal static readonly object GameIdentity = new { version = "1.1.0.6142", gameAssemblySha256 = GameHash, metadataSha256 = MetadataHash, runtimeBackend = "il2cpp" };
    internal static readonly object Capabilities = new { hitTiming = true, combo = true, clock = true, score = true, misses = true, overstrums = true, attemptResults = true, songIdentity = true, songMetadata = true, calibrationTiming = true, calibrationResults = true };
    private static readonly Dictionary<nint, Player> Players = new();
    private static AdapterRegistry.Adapter? adapter;
    private static AdapterRegistry.Layout Memory => adapter!.Memory;
    private static nint nativeBase;
    private static string initializationStage = "fingerprints";
    private static PipePublisher? pipe;
    private static HarmonyLib.Harmony? hooks;
    private static long lastState;
    private static bool enabled;
    private static string lastAttempt = "idle";
    private static nint calibrationOwner;
    private static int calibrationStage;
    private static string calibrationAttempt = Guid.NewGuid().ToString();
    private static nint calibrationResultGraph;
    private static readonly CalibrationResultTracker calibrationResults = new();
    [ThreadStatic] private static CalibrationScope? calibration;
    private sealed record CalibrationScope(nint Owner, nint Graph, int NativeStage, string Stage, string Attempt, ConnectionSnapshot Connection);
    private sealed class Player
    {
        public int Id;
        public string Attempt = Guid.NewGuid().ToString();
        public double LastClock = double.NaN;
        public nint Wrapper;
        public nint Manager;
        public nint Engine;
        public int Misses;
        public bool MissesKnown;
        public bool? Completed;
        public bool FinalReported;
        public SongSnapshot? StartSong;
        public SongSnapshot? LastSong;
        public bool SongConditionsChanged;
        public string? ChartHashPin;
    }

    public override void OnInitializeMelon()
    {
        try
        {
            string root = Path.GetDirectoryName(Environment.ProcessPath)!;
            initializationStage = "unsupported-adapter";
            adapter = AdapterRegistry.Select("il2cpp", ReadHash(Path.Combine(root, "GameAssembly.dll")), ReadHash(Path.Combine(root, "Clone Hero_Data", "il2cpp_data", "Metadata", "global-metadata.dat")));
            initializationStage = "native-module";
            nativeBase = Process.GetCurrentProcess().Modules.Cast<ProcessModule>().Single(m => string.Equals(m.ModuleName, "GameAssembly.dll", StringComparison.OrdinalIgnoreCase)).BaseAddress;
            initializationStage = "interop-assembly";
            var assembly = AppDomain.CurrentDomain.GetAssemblies().Single(a => a.GetName().Name == "Il2CppCloneHero");
            var type = assembly.GetTypes().Single(t => t.Name == "BasePlayer");
            var hit = VerifiedHook(type, "accepted-hit");
            var practiceReset = VerifiedHook(type, "practice-reset");
            hooks = new HarmonyLib.Harmony("ca.chartshub.clonehero.telemetry.verified6142");
            Patch(hit, nameof(AcceptedHit));
            Patch(practiceReset, nameof(PracticeReset));
            Patch(VerifiedHook(type, "player-start"), nameof(PlayerStarted));
            Patch(VerifiedHook(type, "player-update"), nameof(PlayerUpdated));
            Patch(VerifiedHook(type, "player-destroy"), nameof(PlayerDestroyed));
            InstallResultsHooks(assembly, type);
            var calibrator = assembly.GetTypes().Single(t => t.Name == "Calibrator");
            var graph = assembly.GetTypes().Single(t => t.Name == "LatencySpreadDisplay");
            Patch(VerifiedHook(calibrator, "calibrator-start"), nameof(CalibrationStarted));
            // All exact-build entry methods that assign Audio=1 or Video=3.
            // A repeated audio run must receive a fresh ID even if no Update
            // was observed between the state assignments.
            Patch(VerifiedHook(calibrator, "calibration-stage-a"), nameof(CalibrationStageEntered));
            Patch(VerifiedHook(calibrator, "calibration-stage-b"), nameof(CalibrationStageEntered));
            Patch(VerifiedHook(calibrator, "calibration-stage-c"), nameof(CalibrationStageEntered));
            hooks.Patch(VerifiedHook(calibrator, "calibrator-update"),
                prefix: new HarmonyMethod(typeof(Provider), nameof(BeginCalibrationFrame)),
                postfix: new HarmonyMethod(typeof(Provider), nameof(EndCalibrationFrame)),
                finalizer: new HarmonyMethod(typeof(Provider), nameof(ClearCalibrationException)));
            Patch(VerifiedHook(graph, "calibration-sample-a"), nameof(CalibrationSample));
            Patch(VerifiedHook(graph, "calibration-sample-b"), nameof(CalibrationSample));
            initializationStage = "private-transport";
            pipe = new PipePublisher();
            enabled = true;
            LoggerInstance.Msg("ChartsHub connector ready for this exact game build. Local telemetry only.");
        }
        catch
        {
            enabled = false;
            hooks?.UnpatchSelf();
            pipe?.Dispose();
            LoggerInstance.Warning("ChartsHub connector inactive at " + initializationStage + ": build or hook validation failed. No measurements exported.");
        }
    }

    public override void OnApplicationQuit()
    {
        enabled = false;
        hooks?.UnpatchSelf();
        pipe?.Dispose();
    }

    private static string ReadHash(string path)
    {
        using var input = File.OpenRead(path);
        using var hasher = SHA256.Create();
        return Convert.ToHexString(hasher.ComputeHash(input)).ToLowerInvariant();
    }

    private static void Patch(MethodInfo method, string callback)
    {
        if (method is null) throw new MissingMethodException();
        hooks!.Patch(method, postfix: new HarmonyMethod(typeof(Provider), callback));
    }

    private static MethodInfo VerifiedHook(Type type, string stage)
    {
        initializationStage = "resolve-" + stage;
        var contract = adapter!.Hook(stage);
        if (type.Assembly.GetName().Name != contract.Assembly || !HookResolver.HasOriginalType(type, contract.Image, contract.Namespace, contract.Type)) throw new InvalidOperationException("Wrong generated type for adapter");
        var binding = HookResolver.Resolve(type, contract.Token, contract.Arity);
        if (binding.Method.ReturnType != typeof(void)) throw new InvalidOperationException("Unexpected hook signature");
        HookResolver.ValidateNativePointer(binding, nativeBase, contract.Rva);
        initializationStage = "patch-" + stage;
        return binding.Method;
    }
    private static Type VerifiedType(string stage)
    {
        var contract = adapter!.Hook(stage);
        var assembly = AppDomain.CurrentDomain.GetAssemblies().Single(a => a.GetName().Name == contract.Assembly);
        return HookResolver.ResolveType(assembly, contract.Image, contract.Namespace, contract.Type);
    }

    private static nint Pointer(object instance) => (instance as Il2CppObjectBase)?.Pointer ?? IntPtr.Zero;
    private static float Float(nint pointer, int offset) => BitConverter.Int32BitsToSingle(Marshal.ReadInt32(pointer, offset));
    private static double Double(nint pointer, int offset) => BitConverter.Int64BitsToDouble(Marshal.ReadInt64(pointer, offset));

    private static Player? GetPlayer(nint pointer)
    {
        if (!enabled || pointer == 0) return null;
        int id = Marshal.ReadInt32(pointer, Memory.PlayerIndex); // BasePlayer.visualIndex, metadata field
        // First validated integration intentionally exports player0 only. A
        // different player's clock/reset must never replace the chosen player.
        if (id != 0) return null;
        if (Players.TryGetValue(pointer, out var player))
        {
            nint nextEngine = Marshal.ReadIntPtr(pointer, Memory.Engine);
            if (player.Engine != 0 && nextEngine != player.Engine) Reset(player, "player");
            player.Engine = nextEngine;
            player.Wrapper = Marshal.ReadIntPtr(pointer, 0x88);
            player.Manager = Marshal.ReadIntPtr(pointer, Memory.Manager);
            return player;
        }
        if (Players.Count >= 8) return null;
        player = new Player { Id = id, Wrapper = Marshal.ReadIntPtr(pointer, 0x88), Manager = Marshal.ReadIntPtr(pointer, Memory.Manager), Engine = Marshal.ReadIntPtr(pointer, Memory.Engine) };
        Players.Add(pointer, player);
        return player;
    }

    private static void Emit(Player player, string type, object data) => pipe?.Enqueue(player.Attempt, player.Id, type, data);
    private static void Reset(Player player, string reason)
    {
        player.Attempt = Guid.NewGuid().ToString();
        lastAttempt = player.Attempt;
        player.LastClock = double.NaN;
        player.Misses = 0;
        player.MissesKnown = reason == "song" || reason == "restart";
        player.Completed = null;
        player.FinalReported = false;
        player.StartSong = null;
        player.LastSong = null;
        player.SongConditionsChanged = false;
        player.ChartHashPin = null;
        Emit(player, "reset", new { reason });
    }

    private static void PlayerStarted(object __instance)
    {
        try { var p = GetPlayer(Pointer(__instance)); if (p != null) { Reset(p, "song"); CaptureSong(p, initial: true); } }
        catch { FailClosed(); }
    }

    private static void PracticeReset(object __instance)
    {
        try { var p = GetPlayer(Pointer(__instance)); if (p != null) Reset(p, "seek"); }
        catch { FailClosed(); }
    }

    private static void AcceptedHit(object __instance)
    {
        if (!enabled) return;
        try
        {
            nint pointer = Pointer(__instance);
            var p = GetPlayer(pointer);
            if (p == null || p.FinalReported) return;
            // Match the native HUD exactly: one sample per accepted judgment
            // callback, with a unique monotone transport event sequence. A
            // native address is not assumed to be a stable note identity.
            double offset = -(double)Float(pointer, Memory.AcceptedOffset) * 1000d;
            if (!double.IsFinite(offset) || Math.Abs(offset) > 10_000) { FailClosed(); return; }
            nint engine = Marshal.ReadIntPtr(pointer, Memory.Engine);
            if (engine == 0) return;
            int combo = Marshal.ReadInt32(engine, Memory.Combo);
            if (combo < 0 || combo > 10_000_000) { FailClosed(); return; }
            Emit(p, "hit", new { offsetMs = offset, stats = ReadEngineStats(p, engine) });
        }
        catch { FailClosed(); }
    }

    private static void PlayerUpdated(object __instance)
    {
        if (!enabled) return;
        try
        {
            var pointer = Pointer(__instance);
            var p = GetPlayer(pointer);
            if (p == null || p.FinalReported) return;
            nint manager = Marshal.ReadIntPtr(pointer, Memory.Manager), engine = Marshal.ReadIntPtr(pointer, Memory.Engine);
            if (manager == 0 || engine == 0) return;
            // Named GameManager fields: songLength, songTime, isPaused,
            // isSongOver, isSongPlaying. These are independent of BASS guesses.
            double time = Double(manager, Memory.SongTime), duration = Double(manager, Memory.SongLength);
            if (!double.IsFinite(time) || !double.IsFinite(duration) || duration < 0 || duration > 86400) return;
            if (double.IsFinite(p.LastClock) && time < p.LastClock - .25) Reset(p, "seek");
            p.LastClock = time;
            long now = Stopwatch.GetTimestamp();
            if (now - lastState < Stopwatch.Frequency / 10) return;
            lastState = now;
            CaptureSong(p);
            if (time < -60 || time > duration + 5) return;
            int combo = Marshal.ReadInt32(engine, Memory.Combo);
            if (combo < 0 || combo > 10_000_000) { FailClosed(); return; }
            string phase = Marshal.ReadByte(manager, Memory.IsSongOver) != 0 ? "results" :
                Marshal.ReadByte(manager, Memory.IsPaused) != 0 ? "paused" :
                Marshal.ReadByte(manager, Memory.IsPlaying) != 0 ? "playing" : "loading";
            Emit(p, "state", new { phase, metadata = SongMetadata(p), stats = ReadEngineStats(p, engine), clock = NativePlaybackClock.Read(manager, time, duration) });
        }
        catch { FailClosed(); }
    }

    private static void PlayerDestroyed(object __instance)
    {
        try
        {
            nint pointer = Pointer(__instance);
            if (!Players.Remove(pointer, out var p)) return;
            RememberResultPlayer(p);
            Emit(p, "state", new { phase = "idle" });
        }
        catch { FailClosed(); }
    }

    private static void BeginCalibrationFrame(object __instance)
    {
        calibration = null;
        if (!enabled) return;
        try
        {
            nint pointer = Pointer(__instance);
            if (pointer == 0) return;
            int stage = Marshal.ReadInt32(pointer, Memory.CalibrationStage);
            nint graph = Marshal.ReadIntPtr(pointer, Memory.CalibrationGraph);
            if (pointer != calibrationOwner || stage != calibrationStage)
            {
                calibrationResults.Invalidate();
                calibrationResultGraph = 0;
                calibrationOwner = pointer;
                calibrationStage = stage;
                if (stage == 1 || stage == 3) calibrationAttempt = Guid.NewGuid().ToString();
            }
            if (graph != 0 && (stage == 1 || stage == 3))
            {
                if (calibrationResultGraph != 0 && graph != calibrationResultGraph) calibrationResults.Invalidate();
                calibrationResultGraph = graph;
                var connection = pipe?.Connection ?? default;
                calibration = new(pointer, graph, stage, stage == 1 ? "audio" : "video", calibrationAttempt, connection);
                calibrationResults.ObserveFrame(pointer, stage, calibrationAttempt, connection);
            }
        }
        catch { FailClosed(); }
    }

    private static void CalibrationSample(object __instance, float __0)
    {
        if (!enabled || calibration is not { } scope || Pointer(__instance) != scope.Graph) return;
        try
        {
            // This argument is emitted only after the built-in calibration
            // accepts a real strum. Unlike the gameplay raw field, it already
            // equals current time minus scheduled beep, so no sign reversal.
            double offset = (double)__0 * 1000d;
            if (!double.IsFinite(offset) || Math.Abs(offset) > 10_000) { FailClosed(); return; }
            calibrationResults.Sample(scope.Owner, scope.NativeStage, scope.Attempt, scope.Connection, pipe?.Connection ?? default);
            pipe?.Enqueue(lastAttempt, 0, "calibration", new { stage = scope.Stage, offsetMs = offset, calibrationAttemptId = scope.Attempt });
        }
        catch { FailClosed(); }
    }

    private static void EndCalibrationFrame(object __instance)
    {
        try
        {
            if (!enabled || calibration is not { } scope || Pointer(__instance) != scope.Owner) return;
            int after = Marshal.ReadInt32(scope.Owner, Memory.CalibrationStage);
            var result = calibrationResults.Complete(scope.Owner, scope.NativeStage, after, scope.Attempt, pipe?.Connection ?? default,
                () => NativeCalibrationSettings.Read(nativeBase, scope.NativeStage));
            if (result is not null)
                pipe?.Enqueue(lastAttempt, 0, "calibrationResult", new { stage = result.Stage, settingMs = result.SettingMs, calibrationAttemptId = result.CalibrationAttemptId });
        }
        catch { FailClosed(); }
        finally { calibration = null; }
    }
    private static void CalibrationStarted(object __instance)
    {
        try
        {
            calibrationOwner = Pointer(__instance);
            calibrationStage = 0;
            calibrationAttempt = Guid.NewGuid().ToString();
            calibrationResults.Invalidate();
            calibrationResultGraph = 0;
        }
        catch { FailClosed(); }
    }
    private static void CalibrationStageEntered(object __instance)
    {
        try
        {
            nint pointer = Pointer(__instance);
            if (pointer == 0) return;
            int stage = Marshal.ReadInt32(pointer, Memory.CalibrationStage);
            if (stage != 1 && stage != 3) return;
            calibrationOwner = pointer;
            calibrationStage = stage;
            calibrationAttempt = calibrationResults.Enter(pointer, stage, pipe?.Connection ?? default);
            calibrationResultGraph = 0;
        }
        catch { FailClosed(); }
    }
    private static Exception? ClearCalibrationException(Exception? __exception)
    {
        calibration = null;
        if (__exception is not null) calibrationResults.Invalidate();
        return __exception;
    }

    private static void FailClosed()
    {
        enabled = false;
        pipe?.Dispose();
        // Never propagate telemetry failures into a scoring or input callback.
    }
}
