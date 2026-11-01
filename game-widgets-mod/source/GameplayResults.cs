using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using HarmonyLib;

namespace ChartsHub.CloneHero.Telemetry;

public sealed partial class Provider
{
    private sealed record RecentResultPlayer(Player Player, long DestroyedAt);
    private sealed record MissScope(nint Engine, nint Note, ushort Before)
    {
        public bool Consumed;
    }
    private static readonly List<RecentResultPlayer> RecentPlayers = new();
    [ThreadStatic] private static nint updateManager;
    [ThreadStatic] private static nint failedPlayer;
    [ThreadStatic] private static int resultsDepth;
    [ThreadStatic] private static nint resultsOwner;
    [ThreadStatic] private static MissScope? missScope;
    private sealed record ResultsScope(int Depth, nint Owner);

    private static void CaptureSong(Player p, bool initial = false)
    {
        var next = SongSnapshotProjection.Read(p.Manager);
        if (initial) p.StartSong = next;
        else if (p.StartSong is not { } start || next is null || !NativeSongContext.SameConditions(start, next)) p.SongConditionsChanged = true;
        if (next?.NativeChartHash is { } hash)
        {
            if (p.ChartHashPin is { } previous && previous != hash) p.SongConditionsChanged = true;
            p.ChartHashPin ??= hash;
        }
        p.LastSong = next;
    }
    private static Dictionary<string, object> SongMetadata(Player p, ResultProjection.Result? result = null, int? finalSpeed = null, bool completed = false)
    {
        var metadata = new Dictionary<string, object>();
        if (p.LastSong is { } song)
        {
            if (song.Title is { } title) metadata["title"] = title;
            if (song.Artist is { } artist) metadata["artist"] = artist;
            if (song.Charter is { } charter) metadata["charter"] = charter;
        }
        if (result is not null)
        {
            if (NativeSongContext.Instrument(result.Instrument) is { } instrument) metadata["instrument"] = instrument;
            if (NativeSongContext.Difficulty(result.Difficulty) is { } difficulty) metadata["difficulty"] = difficulty;
            string? id = NativeSongContext.ComparableId(adapter!.Id, p.StartSong, p.LastSong, result, finalSpeed, completed && p.MissesKnown, p.SongConditionsChanged);
            if (id is not null) metadata["chartId"] = id;
        }
        return metadata;
    }

    private static void InstallResultsHooks(Assembly assembly, Type basePlayer)
    {
        var engine = VerifiedType("native-miss");
        hooks!.Patch(VerifiedHook(engine, "native-miss"),
            prefix: new HarmonyMethod(typeof(Provider), nameof(BeginMiss)),
            postfix: new HarmonyMethod(typeof(Provider), nameof(EndMiss)),
            finalizer: new HarmonyMethod(typeof(Provider), nameof(FinishMiss)));
        Patch(VerifiedHook(basePlayer, "player-miss"), nameof(MissedNote));
        hooks.Patch(VerifiedHook(basePlayer, "player-health"),
            prefix: new HarmonyMethod(typeof(Provider), nameof(BeginHealth)),
            postfix: new HarmonyMethod(typeof(Provider), nameof(EndHealth)),
            finalizer: new HarmonyMethod(typeof(Provider), nameof(FinishHealth)));
        var manager = assembly.GetTypes().Single(t => t.Name == "GameManager");
        hooks.Patch(VerifiedHook(manager, "manager-update"),
            prefix: new HarmonyMethod(typeof(Provider), nameof(BeginUpdate)),
            postfix: new HarmonyMethod(typeof(Provider), nameof(EndUpdate)),
            finalizer: new HarmonyMethod(typeof(Provider), nameof(FinishUpdate)));
        hooks.Patch(VerifiedHook(manager, "result-outcome"),
            prefix: new HarmonyMethod(typeof(Provider), nameof(BeginResultOutcome)));
        var end = assembly.GetTypes().Single(t => t.Name == "EndOfSong");
        hooks.Patch(VerifiedHook(end, "results-start"),
            prefix: new HarmonyMethod(typeof(Provider), nameof(BeginResults)),
            postfix: new HarmonyMethod(typeof(Provider), nameof(EndResults)),
            finalizer: new HarmonyMethod(typeof(Provider), nameof(FinishResults)));
        var result = VerifiedType("result-built");
        Patch(VerifiedHook(result, "result-built"), nameof(ResultBuilt));
    }

    private static Dictionary<string, object> ReadEngineStats(Player p, nint engine)
    {
        var raw = ResultProjection.ReadEngine(engine);
        var value = new Dictionary<string, object> { ["score"] = raw.Score, ["combo"] = raw.Combo, ["notesHit"] = raw.NotesHit, ["overstrums"] = raw.Overstrums };
        if (p.MissesKnown) value["misses"] = p.Misses;
        return value;
    }

    private static void BeginMiss(object __instance, object __0, out MissScope? __state)
    {
        __state = missScope;
        missScope = null;
        if (!enabled) return;
        try
        {
            nint engine = Pointer(__instance), note = Pointer(__0);
            if (engine != 0 && note != 0) missScope = new(engine, note, unchecked((ushort)Marshal.ReadInt16(note, 0x84)));
        }
        catch { FailClosed(); }
    }
    private static void MissedNote(object __instance)
    {
        if (!enabled || missScope is not { } scope) return;
        try
        {
            var p = GetPlayer(Pointer(__instance));
            if (p == null || p.Engine != scope.Engine || !p.MissesKnown || scope.Consumed || !ResultProjection.FreshMiss(scope.Before, unchecked((ushort)Marshal.ReadInt16(scope.Note, 0x84)))) return;
            scope.Consumed = true;
            if (++p.Misses > 10_000_000) { FailClosed(); return; }
            Emit(p, "state", new { phase = "playing", stats = ReadEngineStats(p, p.Engine) });
        }
        catch { FailClosed(); }
    }
    private static void EndMiss(MissScope? __state) => missScope = __state;
    private static Exception? FinishMiss(MissScope? __state, Exception? __exception) { missScope = __state; return __exception; }

    private static void BeginHealth(object __instance, float __0, out nint __state)
    {
        __state = failedPlayer;
        failedPlayer = 0;
        if (!enabled) return;
        try { if (float.IsFinite(__0) && __0 <= 0) failedPlayer = Pointer(__instance); }
        catch { FailClosed(); }
    }
    private static void EndHealth(nint __state) => failedPlayer = __state;
    private static Exception? FinishHealth(nint __state, Exception? __exception) { failedPlayer = __state; return __exception; }
    private static void BeginUpdate(object __instance, out nint __state)
    {
        __state = updateManager;
        updateManager = enabled ? Pointer(__instance) : 0;
    }
    private static void EndUpdate(nint __state) => updateManager = __state;
    private static Exception? FinishUpdate(nint __state, Exception? __exception) { updateManager = __state; return __exception; }
    private static void BeginResultOutcome(object __instance)
    {
        if (!enabled) return;
        try
        {
            nint manager = Pointer(__instance);
            if (manager == 0 || Marshal.ReadByte(manager, Memory.IsSongOver) != 0) return;
            foreach (var pair in Players)
            {
                var p = pair.Value;
                if (p.Manager != manager || p.Completed != null) continue;
                p.Completed = ResultProjection.Outcome(false, failedPlayer == pair.Key && failedPlayer != 0,
                    updateManager == manager, Double(manager, Memory.SongTime), Double(manager, Memory.SongLength));
            }
        }
        catch { FailClosed(); }
    }
    private static void BeginResults(object __instance, out ResultsScope __state) { __state = new(resultsDepth, resultsOwner); resultsDepth++; resultsOwner = Pointer(__instance); }
    private static void EndResults(ResultsScope __state) { resultsDepth = __state.Depth; resultsOwner = __state.Owner; }
    private static Exception? FinishResults(ResultsScope __state, Exception? __exception) { EndResults(__state); return __exception; }

    private static void RememberResultPlayer(Player p)
    {
        long now = Stopwatch.GetTimestamp();
        RecentPlayers.RemoveAll(x => now - x.DestroyedAt > Stopwatch.Frequency * 10 || x.Player.Wrapper == p.Wrapper);
        RecentPlayers.Add(new(p, now));
        if (RecentPlayers.Count > 8) RecentPlayers.RemoveAt(0);
    }
    private static void ResultBuilt(object __instance, object __0)
    {
        if (!enabled || resultsDepth <= 0) return;
        try
        {
            long now = Stopwatch.GetTimestamp();
            RecentPlayers.RemoveAll(x => now - x.DestroyedAt > Stopwatch.Frequency * 10);
            nint wrapper = Pointer(__0), pointer = Pointer(__instance);
            if (wrapper == 0 || pointer == 0) return;
            var matches = Players.Values.Concat(RecentPlayers.Select(x => x.Player)).Where(p => p.Wrapper == wrapper && p.Id == 0).Distinct().ToArray();
            if (matches.Length != 1) return;
            var p = matches[0];
            if (p.Completed is not bool nativeCompleted || p.FinalReported) return;
            var result = ResultProjection.ReadResult(pointer);
            if (result.IsBot) return;
            bool completed = nativeCompleted && p.StartSong is { PracticeEnabled: false, ReplayAnalysis: false } && p.LastSong is { PracticeEnabled: false, ReplayAnalysis: false };
            var stats = new Dictionary<string, object> { ["score"] = result.Score, ["combo"] = result.Combo, ["notesHit"] = result.NotesHit, ["notesTotal"] = result.NotesTotal, ["overstrums"] = result.Overstrums };
            if (p.MissesKnown) stats["misses"] = p.Misses; // Actual judged callbacks, never total-minus-hit.
            p.FinalReported = true;
            Emit(p, "attemptEnd", new { completed, state = new { phase = "results", metadata = SongMetadata(p, result, NativeSongContext.ReadFinalSpeed(resultsOwner), completed), stats } });
        }
        catch { FailClosed(); }
    }
}
