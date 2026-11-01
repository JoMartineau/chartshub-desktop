#if CHARTSHUB_PRODUCTION
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MelonLoader;

[assembly: MelonInfo(typeof(ChartsHub.QuickImport.Provider), "ChartsHub Quick Import BETA", "0.1.0", "ChartsHub")]
[assembly: MelonGame(null, null)]

namespace ChartsHub.QuickImport;

// Separate production candidate. It never changes game program bytes, installs
// a loader, launches the game, scans Songs, or enables itself by default.
public sealed class Provider : MelonMod
{
    private const string GameDigest = "12bc21e5a88a2fc9abc259d5d67f24835145eabca6c3f863b075ba37ad75f197";
    private const string MetadataDigest = "5f14231810f2641639167eb72956e85cced2f36cb4a84682bdefb1e9da3e3d42";
    private LocalPipeHost? pipe;
    private ImportQueue? queue;
    private NativeImportExperiment? adapter;
    private string? root, directory, songsRoot, privateToken, descriptor, descriptorText;
    private bool attempted;
    public override void OnInitializeMelon()
    {
        try
        {
            if (!OperatingSystem.IsWindows()) throw new ImportRejection("WINDOWS_X64_REQUIRED");
            root = Path.GetDirectoryName(Environment.ProcessPath) ?? throw new ImportRejection("GAME_ROOT_UNKNOWN");
            if (Digest(Path.Combine(root, "GameAssembly.dll")) != GameDigest || Digest(Path.Combine(root, "Clone Hero_Data/il2cpp_data/Metadata/global-metadata.dat")) != MetadataDigest || Digest(Path.Combine(root, "Clone Hero.exe")) != "3ff57876872fdeac94cf88052a69b19e70c7fc58a70919353c9bfcf64dfd2c87") throw new ImportRejection("UNRECOGNIZED_CLONE_HERO_BUILD");
            if (Digest(Path.Combine(root, "MelonLoader/net6/MelonLoader.dll")) != "bdd43dc0f3893c208c95389b863ab61c967ae14204da0dd8051647e754c8709b") throw new ImportRejection("UNRECOGNIZED_LOADER_BUILD");
            directory = Path.Combine(root, "UserData/ChartsHubQuickImport");
            var configPath = Path.Combine(directory, "config.json");
            if (!File.Exists(configPath)) throw new ImportRejection("SETUP_REQUIRED_BETA_DISABLED");
            using var doc = ReadBounded(configPath);
            var config = doc.RootElement;
            if (config.GetProperty("schema").GetInt32() != 1 || !config.TryGetProperty("enabled", out var enabled) || enabled.ValueKind != JsonValueKind.True) throw new ImportRejection("BETA_DISABLED");
            songsRoot = config.GetProperty("songsRoot").GetString() ?? "";
            _ = new ChartValidator(songsRoot); // Explicit root; no recursive walk.
            privateToken = config.GetProperty("token").GetString() ?? "";
            if (!ChartValidator.Digest(privateToken)) throw new ImportRejection("PRIVATE_TOKEN_REQUIRED");
            queue = new(new ChartValidator(songsRoot), new ValidatedCopyAdapter(() => adapter));
            pipe = new("ChartsHub.QuickImport.v1." + Guid.NewGuid().ToString("N"), new(privateToken, queue));
            descriptor = Path.Combine(directory, "connection.json");
            RemoveOwnedStaleDescriptor(descriptor, privateToken);
            PublishDescriptor(false, true);
            LoggerInstance.Msg("Quick Import BETA is waiting for the exact native game contracts. No full scan fallback.");
        }
        catch (Exception error)
        {
            Stop(); LoggerInstance.Warning("Quick Import BETA inactive: " + (error is ImportRejection rejected ? rejected.Code : "INITIALIZATION_UNAVAILABLE"));
        }
    }
    public override void OnSceneWasInitialized(int buildIndex, string sceneName)
    {
        adapter?.SetScene(sceneName);
        if (attempted || queue is null || root is null || directory is null || songsRoot is null) return;
        attempted = true;
        try
        {
            adapter = new(root, directory, sceneName, scalableImport: true, songsRoot: songsRoot, production: true);
            PublishDescriptor(true, false);
            LoggerInstance.Msg("Quick Import BETA native adapter ready for Clone Hero 1.1.0.6142 Windows x64. Imports wait for the song menu.");
        }
        catch (Exception error)
        {
            Stop(); LoggerInstance.Warning("Quick Import BETA native contracts unavailable: " + (error is ImportRejection rejected ? rejected.Code : NativeImportExperiment.InitializationStage));
        }
    }
    public override void OnUpdate() { adapter?.AdvanceIndex(); queue?.Pump(adapter?.Phase ?? GamePhase.Unknown); }
    public override void OnApplicationQuit() => Stop();
    private void PublishDescriptor(bool ready, bool create)
    {
        if (descriptor is null || pipe is null || privateToken is null) throw new ImportRejection("NO_OWN_DESCRIPTOR");
        var next = JsonSerializer.Serialize(new { schema = 1, provider = "chartshub.quick-import", version = "0.1.0", pid = Environment.ProcessId, pipeName = pipe.PipeName, token = privateToken, importValidated = ready, fullScanFallback = false });
        if (!create)
        {
            ChartValidator.NoLinks(descriptor);
            if (new FileInfo(descriptor).Length > 8192 || File.ReadAllText(descriptor) != descriptorText) throw new ImportRejection("DESCRIPTOR_CHANGED");
        }
        var temporary = descriptor + "." + Guid.NewGuid().ToString("N") + ".tmp";
        if (create) temporary = descriptor;
        using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { var bytes = Encoding.UTF8.GetBytes(next); output.Write(bytes); output.Flush(true); }
        if (!create) File.Move(temporary, descriptor, true);
        descriptorText = next;
    }
    private static void RemoveOwnedStaleDescriptor(string file, string token)
    {
        if (!File.Exists(file)) return;
        using var previous = ReadBounded(file); var value = previous.RootElement;
        if (value.GetProperty("provider").GetString() != "chartshub.quick-import" || value.GetProperty("token").GetString() != token || !(value.GetProperty("pipeName").GetString() ?? "").StartsWith("ChartsHub.QuickImport.v1.", StringComparison.Ordinal)) throw new ImportRejection("FOREIGN_DESCRIPTOR");
        try { using var process = Process.GetProcessById(value.GetProperty("pid").GetInt32()); if (!process.HasExited) throw new ImportRejection("PROVIDER_ALREADY_RUNNING"); } catch (ArgumentException) { }
        ChartValidator.NoLinks(file); File.Delete(file);
    }
    private void Stop()
    {
        adapter?.Dispose(); adapter = null; queue?.Dispose(); queue = null; pipe?.Dispose(); pipe = null;
        try { if (descriptor is not null && descriptorText is not null && File.Exists(descriptor)) { ChartValidator.NoLinks(descriptor); if (new FileInfo(descriptor).Length <= 8192 && File.ReadAllText(descriptor) == descriptorText) File.Delete(descriptor); } } catch { }
        descriptor = descriptorText = privateToken = null;
    }
    private static JsonDocument ReadBounded(string file) { ChartValidator.NoLinks(file); if (new FileInfo(file).Length is <= 0 or > 8192) throw new ImportRejection("INVALID_LOCAL_CONFIGURATION"); return JsonDocument.Parse(File.ReadAllBytes(file), new JsonDocumentOptions { MaxDepth = 4 }); }
    private static string Digest(string file) { ChartValidator.NoLinks(file); using var input = File.OpenRead(file); using var sha = SHA256.Create(); return Convert.ToHexString(sha.ComputeHash(input)).ToLowerInvariant(); }
}
#endif
